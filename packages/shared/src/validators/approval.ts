import { z } from "zod";
import { APPROVAL_TYPES } from "../constants.js";
import type { GateReversibility, GateImpact } from "../gate-policy.js";

export const createApprovalSchema = z.object({
  type: z.enum(APPROVAL_TYPES),
  requestedByAgentId: z.string().uuid().optional().nullable(),
  payload: z.record(z.unknown()),
  issueIds: z.array(z.string().uuid()).optional(),
});

export type CreateApproval = z.infer<typeof createApprovalSchema>;

export const resolveApprovalSchema = z.object({
  decisionNote: z.string().optional().nullable(),
  decidedByUserId: z.string().optional().default("board"),
});

export type ResolveApproval = z.infer<typeof resolveApprovalSchema>;

export const requestApprovalRevisionSchema = z.object({
  decisionNote: z.string().optional().nullable(),
  decidedByUserId: z.string().optional().default("board"),
});

export type RequestApprovalRevision = z.infer<typeof requestApprovalRevisionSchema>;

export const resubmitApprovalSchema = z.object({
  payload: z.record(z.unknown()).optional(),
});

export type ResubmitApproval = z.infer<typeof resubmitApprovalSchema>;

export const addApprovalCommentSchema = z.object({
  body: z.string().min(1),
});

export type AddApprovalComment = z.infer<typeof addApprovalCommentSchema>;

export const createLoopEscalationSchema = z.object({
  actionKind: z.string().min(1),
  reversibility: z.enum(["reversible", "irreversible"] as [GateReversibility, GateReversibility]).optional().nullable(),
  impact: z.enum(["low", "high"] as [GateImpact, GateImpact]).optional().nullable(),
  waitCondition: z.string().optional().nullable(),
  requestedByAgentId: z.string().uuid().optional().nullable(),
});

export type CreateLoopEscalation = z.infer<typeof createLoopEscalationSchema>;
