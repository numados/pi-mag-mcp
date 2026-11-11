/** Central config: the single owner of the source model, its validation and
 *  normalization. One source may span several directories; every accepted
 *  form below collapses into the normalized Source/Root shapes from types.ts.
 *
 *  Loading never throws and never silently falls back on a broken file: a
 *  missing file is state:"missing", an unparsable one is state:"malformed"
 *  with the parser message. Structural problems (a non-absolute root, a path
 *  claimed by two sources, defaultVaults/taskVault naming an unknown source,
 *  a duplicate explicit label) are collected in `errors` while the valid
 *  sources are still returned, so a doctor can print everything at once. */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { isPlainObject } from "./types.js";
import type { ConfigLoadResult, KnowledgeConfig, QmdSettings, Root, Source } from "./types.js";

const DEFAULTS: Record<string, unknown> = {
  vaults: {},
  defaultVaults: [],
  taskVault: null,
  defaultVault: null,
  projects: {},
  knowledgeRoot: null,
  defaultTaskRoot: null,
  allowWrite: true,
  qmd: { enabled: true, updateTtlMinutes: 10 },
};

export function centralConfigPath(): string {
  return process.env.KNOWLEDGE_MCP_CONFIG
    ?? `${process.env.XDG_CONFIG_HOME ?? `${process.env.HOME ?? ""}/.config`}/knowledge-mcp/config.json`;
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const prev = out[k];
    out[k] = isPlainObject(prev) && isPlainObject(v) ? deepMerge(prev, v) : v;
  }
  return out;
}

export function loadConfig(): ConfigLoadResult {
  const path = centralConfigPath();
  const errors: string[] = [];
  let state: ConfigLoadResult["state"] = "ok";
  let error: string | undefined;
  let file: Record<string, unknown> = {};
  if (!existsSync(path)) {
    state = "missing";
  } else {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!isPlainObject(parsed)) {
        state = "malformed";
        error = "config root must be a JSON object";
      } else {
        file = parsed;
      }
    } catch (e) {
      state = "malformed";
      error = e instanceof Error ? e.message : String(e);
    }
  }
  const merged = deepMerge(DEFAULTS, file);
  const config = normalizeConfig(merged, path, errors);
  return { state, ...(error !== undefined ? { error } : {}), path, config, errors };
}

// ── normalization ─────────────────────────────────────────────────────────

function normalizeConfig(raw: Record<string, unknown>, configPath: string, errors: string[]): KnowledgeConfig {
  const sources = normalizeSources(raw.vaults, errors);
  const names = sources.map((s) => s.name);

  const defaultVaults: string[] = [];
  const dv = raw.defaultVaults;
  if (dv !== undefined && dv !== null) {
    if (Array.isArray(dv) && dv.every((x) => typeof x === "string")) {
      for (const name of dv as string[]) {
        if (!names.includes(name)) {
          errors.push(`defaultVaults names unknown source "${name}" (known: ${names.join(", ") || "none"})`);
        } else {
          defaultVaults.push(name);
        }
      }
    } else {
      errors.push("defaultVaults must be an array of source names");
    }
  }

  const projects: Record<string, string> = {};
  if (raw.projects !== undefined && raw.projects !== null) {
    if (isPlainObject(raw.projects)) {
      for (const [prefix, target] of Object.entries(raw.projects)) {
        if (typeof target !== "string") {
          errors.push(`projects["${prefix}"] must be a source name`);
          continue;
        }
        projects[prefix] = target;
      }
    } else {
      errors.push("projects must be an object mapping directory prefix → source name");
    }
  }

  return {
    sources,
    defaultVaults,
    taskVault: knownSourceRef(raw.taskVault, "taskVault", names, errors),
    defaultVault: knownSourceRef(raw.defaultVault, "defaultVault", names, errors),
    projects,
    knowledgeRoot: optString(raw.knowledgeRoot, "knowledgeRoot", errors),
    defaultTaskRoot: optString(raw.defaultTaskRoot, "defaultTaskRoot", errors),
    allowWrite: optBool(raw.allowWrite, true, "allowWrite", errors),
    qmd: normalizeQmd(raw.qmd, errors),
    configPath,
    raw,
  };
}

/** Expand a leading `~` / `~/`: paths in the config are absolute, and a user
 *  writing a home-relative path means the same directory. Anything else is
 *  returned unchanged, so `~` inside a name is not special. */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/** A string naming a registered source; null when absent or unusable. */
function knownSourceRef(v: unknown, key: string, names: string[], errors: string[]): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") {
    errors.push(`${key} must be a source name`);
    return null;
  }
  if (!names.includes(v)) {
    errors.push(`${key} names unknown source "${v}" (known: ${names.join(", ") || "none"})`);
    return null;
  }
  return v;
}

function optString(v: unknown, key: string, errors: string[]): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") {
    errors.push(`${key} must be a string`);
    return null;
  }
  return v;
}

function optBool(v: unknown, fallback: boolean, key: string, errors: string[]): boolean {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "boolean") {
    errors.push(`${key} must be a boolean`);
    return fallback;
  }
  return v;
}

function normalizeQmd(v: unknown, errors: string[]): QmdSettings {
  let enabled = true;
  let updateTtlMinutes = 10;
  if (v !== undefined && v !== null) {
    if (isPlainObject(v)) {
      enabled = optBool(v.enabled, true, "qmd.enabled", errors);
      const ttl = v.updateTtlMinutes;
      if (ttl !== undefined && ttl !== null) {
        if (typeof ttl === "number" && ttl >= 0) updateTtlMinutes = ttl;
        else errors.push("qmd.updateTtlMinutes must be a non-negative number");
      }
    } else {
      errors.push("qmd must be an object {enabled, updateTtlMinutes}");
    }
  }
  return { enabled, updateTtlMinutes };
}

// ── sources ───────────────────────────────────────────────────────────────

interface RootSpec {
  path: string;
  label?: string;
  writable?: boolean;
  qmd?: boolean;
}

interface SourceSpec {
  roots: RootSpec[];
  label?: string;
  writable?: boolean;
  qmd?: boolean;
}

function kindOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  return `a ${typeof v}`;
}

function normalizeSources(vaults: unknown, errors: string[]): Source[] {
  if (vaults === undefined || vaults === null) return [];
  if (!isPlainObject(vaults)) {
    errors.push("vaults must be an object mapping source name → definition");
    return [];
  }
  const sources: Source[] = [];
  const owner = new Map<string, string>(); // normalized root path → first claiming source
  for (const [name, def] of Object.entries(vaults)) {
    const roots = normalizeSource(name, def, errors);
    if (roots === null) continue; // unrecognizable definition — error already recorded
    if (roots.length === 0) {
      errors.push(`source "${name}" has no usable roots`);
      continue;
    }
    for (const root of roots) {
      const first = owner.get(root.path);
      if (first !== undefined) {
        errors.push(`root path ${root.path} is claimed by source "${first}" and source "${name}"`);
      } else {
        owner.set(root.path, name);
      }
    }
    sources.push({ name, roots });
  }
  return sources;
}

/** All accepted forms:
 *  "name": "/path" · ["/a", "/b"] · {path} · {paths: ["/a", {path, label?, writable?, qmd?}]}
 *  plus source-level label/writable/qmd defaults that per-root options override. */
function normalizeSource(name: string, def: unknown, errors: string[]): Root[] | null {
  const spec = readSourceSpec(name, def, errors);
  if (spec === null) return null;

  interface Pending {
    path: string;
    label?: string;
    writable: boolean;
    qmd: boolean | null;
    explicitLabel: boolean;
    labelFinal?: string;
    dropped?: boolean;
  }
  const pending: Pending[] = [];
  const seenPaths = new Set<string>();
  for (const spec_root of spec.roots) {
    const r = { ...spec_root, path: expandHome(spec_root.path) };
    if (!isAbsolute(r.path)) {
      errors.push(`vault "${name}": root path must be absolute: ${r.path}`);
      continue;
    }
    let path = resolve(r.path);
    if (existsSync(path)) {
      try {
        path = realpathSync(path); // containment checks compare real paths
      } catch {
        // keep the resolved path; the fs call that follows will fail loudly
      }
    }
    if (seenPaths.has(path)) {
      errors.push(`source "${name}" repeats root path ${path}`);
      continue;
    }
    seenPaths.add(path);
    const p: Pending = {
      path,
      writable: r.writable ?? spec.writable ?? true,
      qmd: r.qmd ?? spec.qmd ?? null,
      explicitLabel: r.label !== undefined,
    };
    if (r.label !== undefined) p.label = r.label;
    pending.push(p);
  }

  // explicit labels first: they must be unique and are never silently renamed
  for (const p of pending) {
    if (!p.explicitLabel || p.label === undefined) continue;
    if (labelTaken(pending, p.label)) {
      errors.push(`duplicate root label "${p.label}" in source "${name}"`);
      p.dropped = true;
      continue;
    }
    p.labelFinal = p.label;
  }
  // defaulted labels (source-level label, else basename) deduplicate with -2, -3…
  for (const p of pending) {
    if (p.dropped || p.labelFinal !== undefined) continue;
    const base = p.label ?? spec.label ?? basename(p.path);
    let label = base;
    let n = 2;
    while (labelTaken(pending, label)) label = `${base}-${n++}`;
    p.labelFinal = label;
  }

  const roots: Root[] = [];
  for (const p of pending) {
    if (p.dropped || p.labelFinal === undefined) continue;
    roots.push({ label: p.labelFinal, path: p.path, writable: p.writable, qmd: p.qmd });
  }
  return roots;
}

/** Occupied = finalized earlier in declaration order (explicit pass runs
 *  first, so defaults always yield to explicit labels). */
function labelTaken(pending: Array<{ labelFinal?: string; dropped?: boolean }>, label: string): boolean {
  return pending.some((p) => !p.dropped && p.labelFinal === label);
}

function readSourceSpec(name: string, def: unknown, errors: string[]): SourceSpec | null {
  if (typeof def === "string") return { roots: [{ path: def }] };

  if (Array.isArray(def)) {
    const roots: RootSpec[] = [];
    for (const item of def) {
      if (typeof item === "string") {
        roots.push({ path: item });
      } else {
        errors.push(`vault "${name}": array entries must be path strings (got ${kindOf(item)})`);
      }
    }
    return { roots };
  }

  if (isPlainObject(def)) {
    const spec: SourceSpec = { roots: [] };
    if (def.label !== undefined) {
      if (typeof def.label === "string") spec.label = def.label;
      else errors.push(`vault "${name}": label must be a string`);
    }
    if (def.writable !== undefined) {
      if (typeof def.writable === "boolean") spec.writable = def.writable;
      else errors.push(`vault "${name}": writable must be a boolean`);
    }
    if (def.qmd !== undefined) {
      if (typeof def.qmd === "boolean") spec.qmd = def.qmd;
      else errors.push(`vault "${name}": qmd must be a boolean`);
    }
    const rawRoots: unknown[] = [];
    if (def.path !== undefined) rawRoots.push(def.path);
    if (def.paths !== undefined) {
      if (Array.isArray(def.paths)) rawRoots.push(...def.paths);
      else errors.push(`vault "${name}": paths must be an array`);
    }
    if (rawRoots.length === 0) {
      errors.push(`vault "${name}" must define path or paths`);
      return null;
    }
    for (const item of rawRoots) {
      if (typeof item === "string") {
        spec.roots.push({ path: item });
        continue;
      }
      if (isPlainObject(item)) {
        const p = item.path;
        if (typeof p !== "string") {
          errors.push(`vault "${name}": root entries must be path strings or {path} objects`);
          continue;
        }
        const r: RootSpec = { path: p };
        if (item.label !== undefined) {
          if (typeof item.label === "string") r.label = item.label;
          else errors.push(`vault "${name}": root label must be a string`);
        }
        if (item.writable !== undefined) {
          if (typeof item.writable === "boolean") r.writable = item.writable;
          else errors.push(`vault "${name}": root writable must be a boolean`);
        }
        if (item.qmd !== undefined) {
          if (typeof item.qmd === "boolean") r.qmd = item.qmd;
          else errors.push(`vault "${name}": root qmd must be a boolean`);
        }
        spec.roots.push(r);
        continue;
      }
      errors.push(`vault "${name}": root entries must be path strings or {path} objects (got ${kindOf(item)})`);
    }
    return spec;
  }

  errors.push(`vault "${name}" must be a path string, an array of paths or a {path|paths} object (got ${kindOf(def)})`);
  return null;
}
