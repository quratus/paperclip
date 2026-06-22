import { api } from "./client";

export type NeedsJuliusReason = "mention" | "parked" | "blocked";

export type NeedsJuliusItem = {
  issueId: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  triggerAt: string;
  reason: NeedsJuliusReason;
  commentId: string | null;
  snippet: string | null;
};

export const juliusApi = {
  needsJulius: (companyId: string) =>
    api.get<NeedsJuliusItem[]>(`/agents/me/needs-julius?companyId=${encodeURIComponent(companyId)}`),
};
