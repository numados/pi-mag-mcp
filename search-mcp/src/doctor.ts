/**
 * Doctor policy: turn the requirement table plus the current provider state into
 * a report that says, per requirement, what to do — install it, forget it, or
 * disable the provider because this machine cannot install it.
 *
 * This module owns the verdict rules. It installs nothing and writes no files:
 * disabling a provider stays an explicit config edit, and the report hands the
 * user the exact line to apply.
 */

import type { RequirementReport, Verdict } from "./contract.js";
import type { Requirement } from "./requirements.js";

export interface DoctorDeps {
  /** Is the `check` binary available? */
  hasBinary: (command: string) => boolean;
  /** Is the package manager the install command needs available? */
  hasManager: (manager: string) => boolean;
  /** Did the config switch this provider off? */
  isEnabled: (provider: string) => boolean;
}

const installable = (requirement: Requirement, deps: DoctorDeps): Verdict => {
  if (!requirement.install) return "builtin";
  if (requirement.manager && !deps.hasManager(requirement.manager)) return "blocked";
  return "installable";
};

export function judgeRequirement(requirement: Requirement, deps: DoctorDeps): RequirementReport {
  let verdict: Verdict;
  let detail: string | undefined;

  if (!deps.isEnabled(requirement.provider)) {
    verdict = "disabled";
    detail = `enable with ${enableHint(requirement.provider)}`;
  } else if (deps.hasBinary(requirement.check)) {
    verdict = "present";
  } else {
    verdict = installable(requirement, deps);
    if (verdict === "blocked") {
      detail = `needs ${requirement.manager}, which is not on PATH — disable with ${disableHint(requirement.provider)}`;
    } else if (verdict === "builtin") {
      detail = "no install command for this platform";
    }
  }

  return {
    ...requirement,
    verdict,
    ...(detail ? { detail } : {}),
  };
}

export function buildDoctorReport(requirements: Requirement[], deps: DoctorDeps): RequirementReport[] {
  return requirements.map((requirement) => judgeRequirement(requirement, deps));
}

/**
 * Readiness rule (the `--doctor` exit code): only an **enabled, required**
 * requirement can fail the run. Disabling a provider is the documented
 * remediation `blocked` recommends, so a requirement the config already turned
 * off — required or not — is an intentional state, never a broken machine;
 * the report still lists it with the line that re-enables it.
 */
export function readinessFailed(report: RequirementReport[]): boolean {
  return report.some((entry) => entry.required && entry.verdict !== "present" && entry.verdict !== "disabled");
}

/** The exact config line that turns one provider off. */
export function disableHint(provider: string): string {
  return JSON.stringify({ providers: { [provider]: { enabled: false } } });
}

/** The exact config line that turns one provider back on. */
export function enableHint(provider: string): string {
  return JSON.stringify({ providers: { [provider]: { enabled: true } } });
}
