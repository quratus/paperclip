import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { juliusApi, type NeedsJuliusReason } from "../api/julius";
import { approvalsApi } from "../api/approvals";
import { queryKeys } from "../lib/queryKeys";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";

const REASON_LABEL: Record<NeedsJuliusReason, string> = {
  mention: "Mention",
  parked: "Parked",
  blocked: "Blocked",
  labeled: "Labeled",
};

const REASON_CLASS: Record<NeedsJuliusReason, string> = {
  mention: "bg-blue-500/15 text-blue-600 dark:text-blue-300",
  parked: "bg-amber-500/15 text-amber-600 dark:text-amber-300",
  blocked: "bg-red-500/15 text-red-600 dark:text-red-300",
  labeled: "bg-purple-500/15 text-purple-600 dark:text-purple-300",
};

export function NeedsJuliusPanel({ companyId }: { companyId: string | null }) {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.needsJulius(companyId ?? "__none__"),
    queryFn: () => juliusApi.needsJulius(companyId!),
    enabled: !!companyId,
    refetchInterval: 60_000,
  });

  const { data: approvals } = useQuery({
    queryKey: queryKeys.approvals.list(companyId ?? "__none__", "pending"),
    queryFn: () => approvalsApi.list(companyId!, "pending"),
    enabled: !!companyId,
    refetchInterval: 60_000,
  });

  const items = data ?? [];
  const pendingApprovals = approvals ?? [];
  const totalCount = items.length + pendingApprovals.length;

  return (
    <div className="min-w-0 rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Needs Julius
        </h3>
        {totalCount > 0 && (
          <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-primary/15 px-1.5 text-xs font-medium text-primary">
            {totalCount}
          </span>
        )}
      </div>

      {totalCount === 0 ? (
        <p className="px-4 py-4 text-sm text-muted-foreground">
          {isLoading ? "Loading…" : "Nothing waiting on you."}
        </p>
      ) : (
        <div className="divide-y divide-border">
          {pendingApprovals.map((approval) => {
            const title = (approval.payload.title as string | undefined) ?? "Board decision";
            const summary = approval.payload.summary as string | undefined;
            return (
              <Link
                key={approval.id}
                to={`/approvals/${approval.id}`}
                className="block px-4 py-3 text-inherit no-underline transition-colors hover:bg-accent/50"
              >
                <div className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide bg-orange-500/15 text-orange-600 dark:text-orange-300">
                      Approval
                    </span>
                    <span className="ml-auto text-xs text-muted-foreground" title={String(approval.createdAt)}>
                      {timeAgo(String(approval.createdAt))}
                    </span>
                  </div>
                  <span className="line-clamp-2 text-sm text-foreground">{title}</span>
                  {summary && (
                    <span className="line-clamp-1 text-xs text-muted-foreground">{summary}</span>
                  )}
                </div>
              </Link>
            );
          })}
          {items.map((item) => (
            <Link
              key={item.issueId}
              to={`/issues/${item.identifier ?? item.issueId}${item.commentId ? `#comment-${item.commentId}` : ""}`}
              className="block px-4 py-3 text-inherit no-underline transition-colors hover:bg-accent/50"
            >
              <div className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={cn(
                      "rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                      REASON_CLASS[item.reason],
                    )}
                  >
                    {REASON_LABEL[item.reason]}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {item.identifier ?? item.issueId.slice(0, 8)}
                  </span>
                  <span className="ml-auto text-xs text-muted-foreground" title={item.triggerAt}>
                    {timeAgo(item.triggerAt)}
                  </span>
                </div>
                <span className="line-clamp-2 text-sm text-foreground">{item.title}</span>
                {item.snippet && (
                  <span className="line-clamp-1 text-xs text-muted-foreground">{item.snippet}</span>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
