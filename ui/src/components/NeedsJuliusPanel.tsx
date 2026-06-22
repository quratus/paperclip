import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { juliusApi, type NeedsJuliusReason } from "../api/julius";
import { queryKeys } from "../lib/queryKeys";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";

const REASON_LABEL: Record<NeedsJuliusReason, string> = {
  mention: "Mention",
  parked: "Parked",
  blocked: "Blocked",
};

const REASON_CLASS: Record<NeedsJuliusReason, string> = {
  mention: "bg-blue-500/15 text-blue-600 dark:text-blue-300",
  parked: "bg-amber-500/15 text-amber-600 dark:text-amber-300",
  blocked: "bg-red-500/15 text-red-600 dark:text-red-300",
};

export function NeedsJuliusPanel({ companyId }: { companyId: string | null }) {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.needsJulius(companyId ?? "__none__"),
    queryFn: () => juliusApi.needsJulius(companyId!),
    enabled: !!companyId,
    refetchInterval: 60_000,
  });

  const items = data ?? [];

  return (
    <div className="min-w-0 rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Needs Julius
        </h3>
        {items.length > 0 && (
          <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-primary/15 px-1.5 text-xs font-medium text-primary">
            {items.length}
          </span>
        )}
      </div>

      {items.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted-foreground">
          {isLoading ? "Loading…" : "Nothing waiting on you."}
        </p>
      ) : (
        <div className="divide-y divide-border">
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
