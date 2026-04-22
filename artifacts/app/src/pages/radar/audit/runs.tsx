import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Loader2, AlertCircle, RefreshCw } from "lucide-react";
import { toast } from "sonner";

interface ActorRun {
  id: number;
  platform: string;
  runMode: string;
  runSubLabel?: string;
  status: "queued" | "running" | "succeeded" | "failed" | "timeout";
  recordsFetched?: number;
  recordsUsable?: number;
  costUsd?: number;
  startedAt?: string;
  finishedAt?: string;
  errorMessage?: string;
}

const PLATFORM_CONFIG: Record<string, { label: string; className: string }> = {
  instagram: { label: "IG", className: "bg-pink-500 text-white border-0" },
  tiktok: { label: "TT", className: "bg-gray-900 text-white border-0" },
  reddit: { label: "RD", className: "bg-orange-500 text-white border-0" },
  xiaohongshu: { label: "XHS", className: "bg-red-500 text-white border-0" },
  google_trends: { label: "GT", className: "bg-blue-500 text-white border-0" },
};

const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  queued: { label: "Queued", className: "bg-gray-400 text-white border-0" },
  running: { label: "Running", className: "bg-blue-500 text-white border-0" },
  succeeded: { label: "Succeeded", className: "bg-green-500 text-white border-0" },
  failed: { label: "Failed", className: "bg-red-500 text-white border-0" },
  timeout: { label: "Timeout", className: "bg-orange-500 text-white border-0" },
};

async function fetchRuns(): Promise<ActorRun[]> {
  const res = await fetch("/api/pipeline/companies/1/actor-runs");
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function retryRun(id: number): Promise<ActorRun> {
  const res = await fetch(`/api/pipeline/companies/1/actor-runs/${id}/retry`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function PlatformBadge({ platform }: { platform: string }) {
  const cfg = PLATFORM_CONFIG[platform.toLowerCase()] ?? {
    label: platform.slice(0, 3).toUpperCase(),
    className: "bg-gray-500 text-white border-0",
  };
  return (
    <Badge className={`text-xs font-mono font-bold tracking-wide ${cfg.className}`}>
      {cfg.label}
    </Badge>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] ?? {
    label: status,
    className: "bg-gray-400 text-white border-0",
  };
  return (
    <Badge className={`text-xs ${cfg.className}`}>
      {status === "running" && (
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-white/80 animate-pulse mr-1" />
      )}
      {cfg.label}
    </Badge>
  );
}

function formatCost(cost?: number) {
  if (cost == null) return "—";
  return `$${cost.toFixed(4)}`;
}

function formatNum(n?: number) {
  if (n == null) return "—";
  return n.toLocaleString();
}

function formatTime(iso?: string) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function RunsAuditPage() {
  const queryClient = useQueryClient();

  const { data: runs = [], isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["actor-runs"],
    queryFn: fetchRuns,
    refetchInterval: 15_000, // auto-refresh every 15s since runs change status
  });

  const retryMutation = useMutation({
    mutationFn: retryRun,
    onSuccess: (updated) => {
      queryClient.setQueryData<ActorRun[]>(["actor-runs"], (old = []) =>
        old.map((r) => (r.id === updated.id ? updated : r))
      );
      toast.success("Run queued for retry");
    },
    onError: (err: Error) => toast.error(err.message || "Failed to retry run"),
  });

  const canRetry = (status: string) => status === "failed" || status === "timeout";

  if (isLoading) {
    return (
      <div className="p-8 max-w-5xl mx-auto">
        <div className="mb-6">
          <Skeleton className="h-7 w-36 mb-2" />
          <Skeleton className="h-4 w-64" />
        </div>
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-12 w-full rounded-md" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8 max-w-5xl mx-auto">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {error instanceof Error ? error.message : "Failed to load runs."}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const runningCount = runs.filter((r) => r.status === "running").length;
  const failedCount = runs.filter((r) => r.status === "failed" || r.status === "timeout").length;

  return (
    <div className="p-8 max-w-5xl mx-auto">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground mb-1">Runs Audit</h1>
          <p className="text-muted-foreground text-sm">
            Monitor actor run status, data collected, and costs.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-2"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Stats */}
      <div className="flex gap-3 mb-6">
        {runningCount > 0 && (
          <Badge className="bg-blue-500 text-white border-0 gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-white/80 animate-pulse inline-block" />
            {runningCount} running
          </Badge>
        )}
        {failedCount > 0 && (
          <Badge className="bg-red-500 text-white border-0">
            {failedCount} failed / timeout
          </Badge>
        )}
        <Badge variant="outline" className="text-xs">
          {runs.length} total runs
        </Badge>
      </div>

      {runs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-12 text-center">
          <p className="text-sm font-medium text-muted-foreground">No runs yet</p>
          <p className="text-xs text-muted-foreground mt-1">
            Launch scrapers from the Queries page to start runs.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30">
                <TableHead className="w-16">Platform</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Fetched</TableHead>
                <TableHead className="text-right">Usable</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead>Started</TableHead>
                <TableHead className="w-20"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => (
                <TableRow key={run.id}>
                  <TableCell>
                    <PlatformBadge platform={run.platform} />
                  </TableCell>
                  <TableCell>
                    <div className="text-sm font-medium">{run.runMode}</div>
                    {run.runSubLabel && (
                      <div className="text-xs text-muted-foreground">{run.runSubLabel}</div>
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={run.status} />
                    {run.errorMessage && (
                      <p className="text-xs text-red-500 mt-0.5 max-w-[200px] truncate">
                        {run.errorMessage}
                      </p>
                    )}
                  </TableCell>
                  <TableCell className="text-right text-sm tabular-nums">
                    {formatNum(run.recordsFetched)}
                  </TableCell>
                  <TableCell className="text-right text-sm tabular-nums">
                    {formatNum(run.recordsUsable)}
                  </TableCell>
                  <TableCell className="text-right text-sm tabular-nums text-muted-foreground">
                    {formatCost(run.costUsd)}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatTime(run.startedAt)}
                  </TableCell>
                  <TableCell>
                    {canRetry(run.status) && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-xs gap-1"
                        onClick={() => retryMutation.mutate(run.id)}
                        disabled={retryMutation.isPending}
                      >
                        {retryMutation.isPending ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3 w-3" />
                        )}
                        Retry
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
