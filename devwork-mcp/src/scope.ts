/**
 * Scope enforcement — the authorization boundary of an installation. Every
 * check runs before credentials are resolved and before any HTTP request, so a
 * reference outside the declared scope fails without a network call and
 * without revealing whether the credential could reach it.
 *
 * An empty allowlist denies: an installation that names no repository or
 * project has no business talking to that backend. That is deliberately
 * stricter than "empty means any".
 */
import type { Installation } from "./installation.js";
import type { RouteTarget } from "./route.js";
import { safeHost } from "./installation.js";

export interface ScopeDecision {
  ok: boolean;
  reason?: string;
}

const OK: ScopeDecision = { ok: true };

function deny(reason: string): ScopeDecision {
  return { ok: false, reason };
}

export function backendEnabled(inst: Installation, backend: RouteTarget["backend"]): ScopeDecision {
  if (backend === "github" && inst.github.auth === "off") return deny("the GitHub backend is disabled in this installation (github.auth:\"off\")");
  if (backend === "jira" && inst.jira.auth === "off") return deny("the Jira backend is disabled in this installation (jira.auth:\"off\")");
  if (backend === "ado" && inst.ado.auth === "off") return deny("the Azure DevOps backend is disabled in this installation (ado.auth:\"off\")");
  return OK;
}

/** GitHub repository allowlist (owner/repo, case-insensitive). */
export function checkRepo(inst: Installation, repo: string): ScopeDecision {
  const allowed = inst.github.repositories;
  if (allowed.length === 0) {
    return deny(`this installation may not touch any GitHub repository (github.repositories is empty in ${inst.source})`);
  }
  const wanted = repo.toLowerCase();
  if (!allowed.some((entry) => entry.toLowerCase() === wanted)) {
    return deny(`repository "${repo}" is outside this installation's scope — allowed: ${allowed.join(", ")}`);
  }
  return OK;
}

function configuredJiraHost(inst: Installation): string | undefined {
  return inst.jira.domain ? safeHost(inst.jira.domain) ?? undefined : undefined;
}

function configuredAdoHost(inst: Installation): string | undefined {
  return inst.ado.org ? safeHost(inst.ado.org) ?? undefined : undefined;
}

function configuredAdoOrg(inst: Installation): string | undefined {
  if (!inst.ado.org) return undefined;
  const trimmed = inst.ado.org.replace(/\/+$/, "");
  const segment = trimmed.split("/").pop();
  return segment && segment.length > 0 ? segment.toLowerCase() : undefined;
}

/** Full check: backend enabled, host matches, project/repository allowlisted. */
export function checkTarget(inst: Installation, target: RouteTarget): ScopeDecision {
  const enabled = backendEnabled(inst, target.backend);
  if (!enabled.ok) return enabled;

  if (target.backend === "github") {
    if (target.host) {
      const apiHost = safeHost(inst.github.apiBase);
      // api.github.com is served from github.com; an enterprise API base is
      // served from its own host only.
      const served = new Set([...(apiHost ? [apiHost] : []), ...(apiHost === "api.github.com" ? ["github.com"] : [])]);
      if (!served.has(target.host)) {
        return deny(`host "${target.host}" does not serve this installation (github.apiBase is ${inst.github.apiBase})`);
      }
    }
    if (!target.repo) return OK; // caller must supply an allowlisted repository
    return checkRepo(inst, target.repo);
  }

  if (target.backend === "jira") {
    const host = configuredJiraHost(inst);
    if (target.host && host && target.host !== host) {
      return deny(`host "${target.host}" is outside this installation — Jira is bound to ${host}`);
    }
    const key = target.key ?? target.id;
    const project = key.split("-")[0] ?? "";
    if (inst.jira.projects.length === 0) {
      return deny(`this installation may not touch any Jira project (jira.projects is empty in ${inst.source})`);
    }
    if (!inst.jira.projects.includes(project)) {
      return deny(`Jira project "${project}" is outside this installation's scope — allowed: ${inst.jira.projects.join(", ")}`);
    }
    return OK;
  }

  const host = configuredAdoHost(inst);
  if (target.host && host && target.host !== host) {
    return deny(`host "${target.host}" is outside this installation — Azure DevOps is bound to ${host}`);
  }
  const org = configuredAdoOrg(inst);
  if (target.org && org && target.org.toLowerCase() !== org) {
    return deny(`organization "${target.org}" is outside this installation — bound to "${org}"`);
  }
  const project = target.project ?? inst.ado.project ?? inst.ado.projects[0];
  if (!project) {
    return deny(`no Azure DevOps project selected — set ado.project in ${inst.source} or name the project in the reference`);
  }
  if (!inst.ado.projects.includes(project)) {
    return deny(`ADO project "${project}" is outside this installation's scope — allowed: ${inst.ado.projects.join(", ")}`);
  }
  return OK;
}

/** Default project for ADO calls that do not name one. */
export function defaultAdoProject(inst: Installation): string | undefined {
  return inst.ado.project ?? inst.ado.projects[0];
}

/** Default GitHub repository for bare-number references. */
export function defaultGithubRepo(inst: Installation): string | undefined {
  return inst.github.defaultRepo ?? (inst.github.repositories.length === 1 ? inst.github.repositories[0] : undefined);
}

export function describeScope(inst: Installation): string[] {
  return [
    `github: ${inst.github.auth === "off" ? "off" : inst.github.repositories.join(", ") || "(empty — nothing allowed)"}`,
    `jira:   ${inst.jira.auth === "off" ? "off" : `${inst.jira.domain ?? "(no domain)"} · projects ${inst.jira.projects.join(", ") || "(empty — nothing allowed)"}`}`,
    `ado:    ${inst.ado.auth === "off" ? "off" : `${inst.ado.org ?? "(no org)"} · projects ${inst.ado.projects.join(", ") || "(empty — nothing allowed)"}`}`,
  ];
}
