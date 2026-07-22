import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, heartbeatRuns } from "@paperclipai/db";
import type { CompanyOperatingMode } from "@paperclipai/shared";
import { conflict } from "../errors.js";

export interface CompanyOperatingModeState {
  companyId: string;
  operatingMode: CompanyOperatingMode;
  pilotAllowlist: string[];
  drainingRunCount: number;
}

export interface CompanyAdmissionDecision extends CompanyOperatingModeState {
  admitted: boolean;
  reason: string | null;
}

function normalizePilotAllowlist(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function companyOperatingModeService(db: Db) {
  async function getState(companyId: string): Promise<CompanyOperatingModeState | null> {
    const company = await db
      .select({
        companyId: companies.id,
        operatingMode: companies.operatingMode,
        pilotAllowlist: companies.pilotAllowlist,
      })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    if (!company) return null;

    const [draining] = await db
      .select({ count: sqlCount() })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, companyId),
        inArray(heartbeatRuns.status, ["queued", "running"]),
      ));

    return {
      companyId,
      operatingMode: company.operatingMode ?? "active",
      pilotAllowlist: normalizePilotAllowlist(company.pilotAllowlist),
      drainingRunCount: Number(draining?.count ?? 0),
    };
  }

  async function decide(companyId: string, agentId: string | null): Promise<CompanyAdmissionDecision | null> {
    const state = await getState(companyId);
    if (!state) return null;
    if (state.operatingMode === "active") return { ...state, admitted: true, reason: null };
    if (state.operatingMode === "frozen") {
      return { ...state, admitted: false, reason: "company.operating_mode.frozen" };
    }
    const admitted = !!agentId && state.pilotAllowlist.includes(agentId);
    return {
      ...state,
      admitted,
      reason: admitted ? null : "company.operating_mode.pilot_denied",
    };
  }

  async function assertAdmitted(companyId: string, agentId: string, source: "checkout" | "wakeup" | "scheduler") {
    const decision = await decide(companyId, agentId);
    if (!decision || decision.admitted) return decision;
    throw conflict(
      decision.operatingMode === "frozen"
        ? "Company operating mode is frozen"
        : "Agent is not in the company pilot allowlist",
      {
        code: decision.reason,
        companyId,
        agentId,
        source,
        operatingMode: decision.operatingMode,
        drainingRunCount: decision.drainingRunCount,
      },
    );
  }

  return {
    getState,
    decide,
    assertAdmitted,
  };
}

function sqlCount() {
  return sql<number>`count(*)::int`;
}
