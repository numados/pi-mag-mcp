import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toolDefs } from '../dist/tools.js';
import { git, setGitRunner } from '../dist/exec.js';
import { result } from '../dist/types.js';

const root = mkdtempSync(join(tmpdir(), 'repo-safety-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));
const home = join(root, 'home'); mkdirSync(home);
Object.assign(process.env, { HOME: home, GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@localhost' });
writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
const tools = new Map(toolDefs().map(t => [t.name, t]));
const call = (n, p, s) => tools.get(n).handler(p, s);
const data = r => r.structuredContent;
const sh = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
let seq = 0;
function repo() { const p = join(root, String(++seq)); mkdirSync(p); sh(p, 'init', '-b', 'master'); writeFileSync(join(p, 'base'), 'base'); sh(p, 'add', 'base'); sh(p, 'commit', '-m', 'Base'); return p; }
async function execute(n, p) { const preview = await call(n, p); assert.equal(preview.isError, undefined, preview.content[0].text); return call(n, { ...p, confirm: true, token: data(preview).token }); }

test('restore and clean treat wildcard filenames literally', async () => {
  const p = repo();
  for (const f of ['*.txt', 'neighbour.txt']) writeFileSync(join(p, f), 'original');
  sh(p, 'add', '--', '*.txt', 'neighbour.txt'); sh(p, 'commit', '-m', 'Files');
  for (const f of ['*.txt', 'neighbour.txt']) writeFileSync(join(p, f), 'dirty');
  const r = await execute('restore', { repo: p, paths: ['*.txt'] });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.equal(readFileSync(join(p, '*.txt'), 'utf8'), 'original');
  assert.equal(readFileSync(join(p, 'neighbour.txt'), 'utf8'), 'dirty');
  for (const f of ['*.log', 'neighbour.log']) writeFileSync(join(p, f), 'untracked');
  const c = await execute('destructive_local', { repo: p, action: 'clean', paths: ['*.log'] });
  assert.equal(c.isError, undefined, c.content[0].text);
  assert.equal(existsSync(join(p, '*.log')), false);
  assert.equal(existsSync(join(p, 'neighbour.log')), true);
});

test('switch and branch_create refuse overwriting occupied ignored files', async () => {
  const p = repo();
  sh(p, 'switch', '-c', 'target');
  mkdirSync(join(p, 'cache')); writeFileSync(join(p, 'cache', 'state'), 'tracked target');
  sh(p, 'add', 'cache/state'); sh(p, 'commit', '-m', 'Tracked cache');
  sh(p, 'switch', 'master'); writeFileSync(join(p, '.gitignore'), 'cache/\n');
  sh(p, 'add', '.gitignore'); sh(p, 'commit', '-m', 'Ignore cache');
  mkdirSync(join(p, 'cache')); writeFileSync(join(p, 'cache', 'state'), 'private ignored');
  for (const [n, args] of [['switch', { branch: 'target' }], ['branch_create', { name: 'newbranch', base: 'target' }]]) {
    const r = await execute(n, { repo: p, ...args });
    assert.equal(r.isError, true, r.content[0].text);
    assert.equal(readFileSync(join(p, 'cache', 'state'), 'utf8'), 'private ignored');
  }
  for (const [n, args] of [['reset', { mode: 'hard', ref: 'target' }], ['restore', { paths: ['cache/state'], ref: 'target' }], ['merge', { ref: 'target' }], ['rebase', { base: 'target' }], ['git_pull', {}]]) {
    const r = await call(n, { repo: p, ...args });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /ignored local files/);
    assert.equal(readFileSync(join(p, 'cache', 'state'), 'utf8'), 'private ignored');
  }
});

test('pre-aborted work never spawns or consumes preview token', async () => {
  const p = repo(); const preview = await call('switch', { repo: p, branch: 'master' });
  const ac = new AbortController(); ac.abort(); let calls = 0;
  setGitRunner(async () => { calls++; throw new Error('must not spawn'); });
  try { const r = await call('switch', { repo: p, branch: 'master', confirm: true, token: data(preview).token }, ac.signal); assert.equal(r.isError, true); assert.equal(calls, 0); const r2 = await git({ cwd: p, args: ['status'], signal: ac.signal }); assert.equal(r2.aborted, true); assert.equal(calls, 0); } finally { setGitRunner(null); }
  const retry = await call('switch', { repo: p, branch: 'master', confirm: true, token: data(preview).token });
  assert.equal(retry.isError, undefined, retry.content[0].text);
});

test('cancellation kills a TERM-resistant hook within escalation deadline', { timeout: 12000 }, async () => {
  const p = repo(); writeFileSync(join(p, 'base'), 'next'); sh(p, 'add', 'base');
  const script = join(p, '.git', 'hooks', 'hang.mjs');
  writeFileSync(script, "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);\n");
  const hook = join(p, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, `#!/bin/sh\nexec '${process.execPath}' '${script}'\n`); chmodSync(hook, 0o755);
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 700);
  const start = Date.now();
  try { const r = await call('git_commit', { repo: p, message: 'fix: Update base' }, ac.signal); assert.equal(r.isError, true); assert.match(r.content[0].text, /cancelled/); assert.ok(Date.now() - start < 10000); } finally { clearTimeout(timer); }
});

test('failed truncated fetch and pull never return success', async () => {
  const p = repo();
  setGitRunner(async ({ args }) => {
    if (args[0] === 'rev-parse') return { stdout: p, stderr: '', code: 0, aborted: false, truncated: false };
    if (args[0] === 'ls-files') return { stdout: '', stderr: '', code: 0, aborted: false, truncated: false };
    return { stdout: 'partial', stderr: 'failed', code: 1, aborted: false, truncated: true };
  });
  try { for (const n of ['git_fetch', 'git_pull']) { const r = await call(n, { repo: p }); assert.equal(r.isError, true); assert.equal(data(r).ok, false); } } finally { setGitRunner(null); }
});

test('remote validation and nested response boundary do not expose credentials', async () => {
  const p = repo(); const r = await call('git_fetch', { repo: p, remote: 'https://user:secret@example/x.git' });
  assert.equal(r.isError, true); assert.ok(!JSON.stringify(r).includes('secret'));
  const nested = result('https://user:secret@example/x', { nested: ['https://user:secret@example/x'] }, true);
  assert.ok(!JSON.stringify(nested).includes('secret'));
});

test('commit and generator enforce whole-message hygiene; rejected commit leaves HEAD unchanged', async () => {
  const p = repo(); writeFileSync(join(p, 'base'), 'next'); sh(p, 'add', 'base'); const head = sh(p, 'rev-parse', 'HEAD');
  for (const message of ['fix: Change\n\nCo-authored-by: Bot <bot@localhost>', 'fix: Change as requested', 'fix: Change following review feedback', 'fix: See https://github.com/acme/repo/issues/123', 'fix: Generated with Claude']) {
    const r = await call('git_commit', { repo: p, message }); assert.equal(r.isError, true); assert.equal(sh(p, 'rev-parse', 'HEAD'), head);
  }
  const generated = await call('commit_message', { repo: p, type: 'fix', summary: 'Change as requested' }); assert.equal(generated.isError, true);
});

test('missing git reports installation hint in ordinary tools', async () => {
  const p = repo(); const previous = process.env.PATH; process.env.PATH = '';
  try { const r = await call('git_status', { repo: p }); assert.equal(r.isError, true); assert.match(r.content[0].text, /brew install git/); } finally { process.env.PATH = previous; }
});
