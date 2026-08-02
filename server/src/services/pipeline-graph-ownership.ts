export function graphRecoveryOwnershipLockKey(companyId: string, issueId: string) {
  return `pipeline-graph-run:recovery-ownership:${companyId}:${issueId}`;
}

export function graphCaseLockKey(caseId: string) {
  return `pipeline-graph-run:case:${caseId}`;
}
