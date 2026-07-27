import { normalizeIssueExecutionPolicy } from "./issue-execution-policy.js";

export const ISSUE_REFINEMENT_RESPONSIBILITY = "issue_refinement";
export const ISSUE_ADMISSION_RESOLVER_VERSION = 1;
export const ISSUE_ADMISSION_ROUTING_POLICY = "manager_chain_v1";

export type IssueAdmissionSource = "status_transition" | "checkout" | "assignment";

export type IssueAdmissionDisposition =
  | { kind: "allow" }
  | {
      kind: "redirect";
      code: "missing_product_truth_contract";
      issueId: string;
      source: IssueAdmissionSource;
      requiredResponsibility: typeof ISSUE_REFINEMENT_RESPONSIBILITY;
      routingPolicy: typeof ISSUE_ADMISSION_ROUTING_POLICY;
      resolverVersion: typeof ISSUE_ADMISSION_RESOLVER_VERSION;
      missing: string[];
      validWorkClasses: string[];
    };

export function hasProductTruthContract(description: string | null | undefined) {
  return /^##[ \t]+Product Truth Contract[ \t]*$/im.test(description ?? "");
}

export function evaluateIssueAdmission(input: {
  issue: {
    id: string;
    description?: string | null;
    executionPolicy?: unknown;
  };
  nextDescription?: string | null;
  nextExecutionPolicy?: unknown;
  source: IssueAdmissionSource;
  actorType?: string;
}): IssueAdmissionDisposition {
  if (input.actorType === "board") return { kind: "allow" };

  const policy = normalizeIssueExecutionPolicy(
    input.nextExecutionPolicy === undefined
      ? input.issue.executionPolicy ?? null
      : input.nextExecutionPolicy,
  );
  const workClass = policy?.workClass ?? null;
  if (workClass === "docs_ops") return { kind: "allow" };

  const hasContract = hasProductTruthContract(
    input.nextDescription === undefined
      ? input.issue.description ?? null
      : input.nextDescription,
  );
  const hasReviewChain = Boolean(policy?.stages?.length);
  if (hasContract && hasReviewChain) return { kind: "allow" };

  return {
    kind: "redirect",
    code: "missing_product_truth_contract",
    issueId: input.issue.id,
    source: input.source,
    requiredResponsibility: ISSUE_REFINEMENT_RESPONSIBILITY,
    routingPolicy: ISSUE_ADMISSION_ROUTING_POLICY,
    resolverVersion: ISSUE_ADMISSION_RESOLVER_VERSION,
    missing: [
      ...(!workClass ? ["executionPolicy.workClass"] : []),
      ...(!hasContract ? ["## Product Truth Contract"] : []),
      ...(!hasReviewChain ? ["executionPolicy.stages"] : []),
    ],
    validWorkClasses: ["product_ui", "backend", "security", "docs_ops"],
  };
}
