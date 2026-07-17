import type { CompanyOperatingMode } from "@paperclipai/shared";

export const OPERATING_MODE_DENIAL_REASON = "company.operating_mode";

export interface CompanyOperatingModeRow {
  operatingMode: string | null;
  pilotAllowlist: unknown;
}

export interface CompanyAdmissionDecision {
  admitted: boolean;
  mode: CompanyOperatingMode;
  reason: string | null;
  message: string | null;
}

export function normalizeCompanyOperatingMode(value: string | null | undefined): CompanyOperatingMode {
  return value === "frozen" || value === "pilot" ? value : "active";
}

export function normalizePilotAllowlist(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

export function evaluateCompanyAdmission(
  company: CompanyOperatingModeRow,
  agentId: string,
): CompanyAdmissionDecision {
  const mode = normalizeCompanyOperatingMode(company.operatingMode);
  if (mode === "active") {
    return { admitted: true, mode, reason: null, message: null };
  }
  if (mode === "frozen") {
    return {
      admitted: false,
      mode,
      reason: OPERATING_MODE_DENIAL_REASON,
      message: "Company operating mode is frozen; new agent work admission is blocked",
    };
  }
  const allowlist = new Set(normalizePilotAllowlist(company.pilotAllowlist));
  if (allowlist.has(agentId)) {
    return { admitted: true, mode, reason: null, message: null };
  }
  return {
    admitted: false,
    mode,
    reason: OPERATING_MODE_DENIAL_REASON,
    message: "Company operating mode is pilot; this agent is not in the pilot allowlist",
  };
}

