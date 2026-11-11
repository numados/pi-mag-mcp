/**
 * One string in — bare id, ABC-123, owner/repo#123, or an ADO/Jira/GitHub web
 * URL — resolved to a routing target. Scope is NOT decided here: route.ts only
 * says where the reference points, scope.ts decides whether this installation
 * may touch it. Keeping the two apart is what makes an out-of-scope reference
 * a refusal instead of a request.
 */
import type { Backend } from "./types.js";

export interface RouteTarget {
  backend: Backend;
  kind: "item" | "pr";
  id: string;
  /** Host captured from a URL, lowercase, without port. */
  host?: string;
  /** ADO organization captured from a URL. */
  org?: string;
  /** ADO project (decoded) or GitHub "owner/repo", when captured. */
  project?: string;
  repo?: string;
  /** Jira issue key (ABC-123), when applicable. */
  key?: string;
}

export interface RouteTable {
  defaultBackend: Backend;
  jira: { projects: string[] };
}

// Every URL pattern is anchored and captures the real host, so a reference
// like https://evil.example/github.com/acme/x/issues/1 cannot pass as GitHub.
const ADO_ITEM_URL = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/_workitems\/edit\/(\d+)/i;
const ADO_PR_URL = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)/i;
const JIRA_BROWSE = /^https?:\/\/([^/]+)\/browse\/([A-Z][A-Z0-9]+-\d+)/i;
const GH_URL = /^https?:\/\/([^/]+)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(issues|pull)\/(\d+)/i;
const GH_REF = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/;
const JIRA_KEY = /^([A-Z][A-Z0-9]+)-(\d+)$/;
const NUMERIC = /^\d+$/;

export function parseRef(ref: string, table: RouteTable, kindHint?: "item" | "pr"): RouteTarget | null {
  const s = ref.trim();

  const pr = s.match(ADO_PR_URL);
  if (pr) {
    return {
      backend: "ado",
      kind: "pr",
      id: pr[5] as string,
      org: decodeURIComponent(pr[2] as string),
      project: decodeURIComponent(pr[3] as string),
      host: (pr[1] as string).toLowerCase(),
    };
  }

  const wi = s.match(ADO_ITEM_URL);
  if (wi) {
    return {
      backend: "ado",
      kind: "item",
      id: wi[4] as string,
      org: decodeURIComponent(wi[2] as string),
      project: decodeURIComponent(wi[3] as string),
      host: (wi[1] as string).toLowerCase(),
    };
  }

  const ju = s.match(JIRA_BROWSE);
  if (ju) {
    return { backend: "jira", kind: "item", id: ju[2] as string, key: ju[2] as string, host: (ju[1] as string).toLowerCase() };
  }

  const gh = s.match(GH_URL);
  if (gh) {
    const host = (gh[1] as string).toLowerCase().replace(/^www\./, "");
    return {
      backend: "github",
      kind: gh[4] === "pull" ? "pr" : "item",
      id: gh[5] as string,
      repo: `${gh[2]}/${gh[3]}`,
      host,
    };
  }

  const ghr = s.match(GH_REF);
  if (ghr) {
    return { backend: "github", kind: kindHint ?? "item", id: ghr[3] as string, repo: `${ghr[1]}/${ghr[2]}` };
  }

  const jk = s.match(JIRA_KEY);
  if (jk) {
    const project = jk[1] as string;
    const known = table.jira.projects.length === 0 || table.jira.projects.includes(project);
    if (known || table.defaultBackend === "jira") {
      return { backend: "jira", kind: "item", id: s, key: s };
    }
    return null; // a Jira key, but not a project this installation knows
  }

  if (NUMERIC.test(s)) return { backend: table.defaultBackend, kind: kindHint ?? "item", id: s };

  return null;
}

export function unroutableMessage(ref: string, table: RouteTable): string {
  return (
    `cannot route "${ref}" — accepted: bare id (12345), Jira key (ABC-123), owner/repo#123, ` +
    `or a work-item URL (dev.azure.com/<org>/<project>/_workitems/edit/N, _git/<repo>/pullrequest/N, ` +
    `<host>/browse/ABC-123, github.com/<owner>/<repo>/issues|pull/N). ` +
    `Default backend: ${table.defaultBackend}. Jira projects routed here: ${table.jira.projects.join(", ") || "(none configured)"}.`
  );
}
