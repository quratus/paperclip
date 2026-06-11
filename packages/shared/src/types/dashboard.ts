export type WorkflowQuadrant = "Q1" | "Q2" | "Q3" | "Q4";

export interface WorkflowAnalytics {
  workflowType: string;
  runsTotal: number;
  runsCompleted: number;
  runsFailed: number;
  completionRate: number;
  correctionsTotal: number;
  correctionRate: number;
  quadrant: WorkflowQuadrant;
}

export interface DashboardAnalytics {
  runsTotal: number;
  runsCompleted: number;
  runsFailed: number;
  completionRate: number;
  correctionsTotal: number;
  workflows: WorkflowAnalytics[];
  quadrants: Record<WorkflowQuadrant, string[]>;
}

export interface DashboardSummary {
  companyId: string;
  agents: {
    active: number;
    running: number;
    paused: number;
    error: number;
  };
  tasks: {
    open: number;
    inProgress: number;
    blocked: number;
    done: number;
  };
  costs: {
    monthSpendCents: number;
    monthBudgetCents: number;
    monthUtilizationPercent: number;
  };
  pendingApprovals: number;
  budgets: {
    activeIncidents: number;
    pendingApprovals: number;
    pausedAgents: number;
    pausedProjects: number;
  };
  analytics: DashboardAnalytics;
}
