import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Loader2, AlertCircle, RefreshCw, XCircle, CheckSquare, Square, Trash2, ExternalLink, Database } from "lucide-react";
import { toast } from "sonner";

interface ActorRun {
  id: number;
  platform: string;
  runMode: string;
  runSubLabel?: string;
  status: "queued" | "running" | "succeeded" | "failed" | "timeout";
  apifyRunId?: string | null;
  apifyDatasetId?: string | null;
  recordsFetched?: number;
  recordsUsable?: number;
  costUsd?: number;
  startedAt?: string;
  completedAt?: string;
  errorMessage?: string;
  ingestionStatus?: string;
}

const PLATFORM_CONFIG: Record<string, { label: string; className: string }> = {
  instagram:    { label: "IG",  className: "bg-pink-500 text-white border-0" },
  tiktok:       { label: "TT",  className: "bg-gray-900 text-white border-0" },
  reddit:       { label: "RD",  className: "bg-orange-500 text-white border-0" },
  xiaohongshu:  { label: "XHS", className: "bg-red-500 text-white border-0" },
  google_trends:{ label: "GT",  className: "bg-blue-500 text-white border-0" },
};

const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  queued:    { label: "Queued",    className: "bg-gray-400 text-white border-0" },
  running:   { label: "Running",   className: "bg-blue-500 text-white border-0" },
  succeeded: { label: "Succeeded", className: "bg-green-500 text-white border-0" },
  failed:    { label: "Failed",    className: "bg-red-500 text-white border-0" },
  timeout:   { label: "Timeout",   className: "bg-orange-500 text-white border-0" },
};

const isActive    = (r: ActorRun) => r.status === "queued" || r.status === "running";
const isBillingError = (r: ActorRun) => !!r.errorMessage?.toLowerCase().includes("maximum usage");
const isRetryable = (r: ActorRun) => (r.status === "failed" || r.status === "timeout") && !isBillingError(r);
const isViewable  = (r: ActorRun) => r.status === "succeeded" && !!r.apifyDatasetId;
// "Runnable" in the bulk sense: this is the bulk equivalent of the per-row
// Retry button, just labeled "Run" for consistency with the user's mental
// model. We deliberately restrict to failed/timeout runs (skipping succeeded
// ones) because relaunching a succeeded run would require coordinated cleanup
// of its prior raw_signals — the dedup index on (companyId, platform,
// sourceId) would otherwise cause the rerun to insert nothing while the run's
// own counters reset to zero. Same rule as isRetryable.
const isRunnable  = isRetryable;
// Re-ingestable = the dataset still exists on Apify, so we can re-process
// signals from it. Only succeeded runs with a dataset qualify.
const isIngestable = (r: ActorRun) => r.status === "succeeded" && !!r.apifyDatasetId;

async function fetchRuns(): Promise<ActorRun[]> {
  const res = await fetch("/api/pipeline/companies/1/actor-runs");
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function retryRunApi(id: number): Promise<ActorRun> {
  const res = await fetch(`/api/pipeline/actor-runs/${id}/retry`, { method: "POST" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function cancelRunApi(id: number): Promise<ActorRun> {
  const res = await fetch(`/api/pipeline/actor-runs/${id}/cancel`, { method: "POST" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function bulkCancelApi(runIds: number[]): Promise<void> {
  const res = await fetch(`/api/pipeline/companies/1/actor-runs/bulk-cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runIds }),
  });
  if (!res.ok) throw new Error(await res.text());
}

async function bulkDeleteApi(runIds: number[]): Promise<void> {
  const res = await fetch(`/api/pipeline/companies/1/actor-runs`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runIds }),
  });
  if (!res.ok) throw new Error(await res.text());
}

async function bulkRetryApi(runIds: number[]): Promise<{ ok: number; failed: number }> {
  // No bulk retry endpoint — fan out to the single-run retry endpoint.
  const results = await Promise.allSettled(runIds.map((id) => retryRunApi(id)));
  const ok = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.length - ok;
  return { ok, failed };
}

async function bulkReIngestApi(runIds: number[]): Promise<{ ok: number; failed: number; okIds: number[] }> {
  // No bulk re-ingest endpoint — fan out to the per-run ingestion trigger.
  const results = await Promise.allSettled(runIds.map((id) => reIngestRunApi(id)));
  const okIds: number[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") okIds.push(runIds[i]!);
  });
  return { ok: okIds.length, failed: runIds.length - okIds.length, okIds };
}

async function fetchRunOutput(id: number): Promise<{ items: unknown[]; total: number }> {
  const res = await fetch(`/api/pipeline/actor-runs/${id}/output`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function reIngestRunApi(runId: number): Promise<void> {
  const res = await fetch("/api/pipeline/companies/1/run-ingestion", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runId }),
  });
  if (!res.ok) throw new Error(await res.text());
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
  const cfg = STATUS_CONFIG[status] ?? { label: status, className: "bg-gray-400 text-white border-0" };
  return (
    <Badge className={`text-xs ${cfg.className}`}>
      {status === "running" && (
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-white/80 animate-pulse mr-1" />
      )}
      {cfg.label}
    </Badge>
  );
}

const fmt = {
  cost: (v?: number) => v == null ? "—" : `$${v.toFixed(4)}`,
  num:  (v?: number) => v == null ? "—" : v.toLocaleString(),
  time: (iso?: string) => !iso ? "—" : new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  }),
};

function OutputDialog({ run, onClose }: { run: ActorRun; onClose: () => void }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["run-output", run.id],
    queryFn: () => fetchRunOutput(run.id),
    staleTime: 60_000,
  });

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <PlatformBadge platform={run.platform} />
            <span className="font-mono text-sm text-muted-foreground">{run.runMode}</span>
            {run.apifyRunId && (
              <a
                href={`https://console.apify.com/actors/runs/${run.apifyRunId}`}
                target="_blank"
                rel="noreferrer"
                className="ml-auto text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
              >
                Apify <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-auto min-h-0">
          {isLoading && (
            <div className="flex items-center justify-center py-12 text-muted-foreground text-sm gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading dataset…
            </div>
          )}
          {error && (
            <Alert variant="destructive" className="m-4">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error instanceof Error ? error.message : "Failed to load"}</AlertDescription>
            </Alert>
          )}
          {data && (
            <div className="text-xs text-muted-foreground px-1 pb-1">
              Showing {data.items.length} of {data.total} items
            </div>
          )}
          {data?.items.map((item, i) => (
            <div key={i} className="border border-border rounded-md mb-2 overflow-hidden">
              <div className="bg-muted/40 px-3 py-1 text-xs text-muted-foreground font-mono">#{i + 1}</div>
              <pre className="p-3 text-xs overflow-x-auto whitespace-pre-wrap break-all font-mono leading-relaxed">
                {JSON.stringify(item, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function RunsAuditPage() {
  const queryClient = useQueryClient();
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [viewingRun, setViewingRun] = useState<ActorRun | null>(null);

  const { data: runs = [], isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["actor-runs"],
    queryFn: fetchRuns,
    refetchInterval: 15_000,
  });

  const retryMutation = useMutation({
    mutationFn: retryRunApi,
    onSuccess: (updated) => {
      queryClient.setQueryData<ActorRun[]>(["actor-runs"], (old = []) =>
        old.map((r) => (r.id === updated.id ? updated : r))
      );
      toast.success("Run queued for retry");
    },
    onError: (err: Error) => toast.error(err.message || "Failed to retry"),
  });

  const cancelMutation = useMutation({
    mutationFn: cancelRunApi,
    onSuccess: (updated) => {
      queryClient.setQueryData<ActorRun[]>(["actor-runs"], (old = []) =>
        old.map((r) => (r.id === updated.id ? updated : r))
      );
      setSelectedIds((prev) => { const n = new Set(prev); n.delete(updated.id); return n; });
      toast.success("Run cancelled");
    },
    onError: (err: Error) => toast.error(err.message || "Failed to cancel"),
  });

  const bulkCancelMutation = useMutation({
    mutationFn: (ids: number[]) => bulkCancelApi(ids),
    onSuccess: (_, ids) => {
      queryClient.setQueryData<ActorRun[]>(["actor-runs"], (old = []) =>
        old.map((r) =>
          ids.includes(r.id) && isActive(r)
            ? { ...r, status: "failed", errorMessage: "Cancelled by user" }
            : r
        )
      );
      setSelectedIds(new Set());
      toast.success(`Cancelled ${ids.length} run${ids.length !== 1 ? "s" : ""}`);
    },
    onError: (err: Error) => toast.error(err.message || "Failed to cancel runs"),
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: (ids: number[]) => bulkDeleteApi(ids),
    onSuccess: (_, ids) => {
      queryClient.setQueryData<ActorRun[]>(["actor-runs"], (old = []) =>
        old.filter((r) => !ids.includes(r.id))
      );
      setSelectedIds(new Set());
      toast.success(`Deleted ${ids.length} run${ids.length !== 1 ? "s" : ""}`);
    },
    onError: (err: Error) => toast.error(err.message || "Failed to delete runs"),
  });

  const reIngestMutation = useMutation({
    mutationFn: (id: number) => reIngestRunApi(id),
    onSuccess: (_, id) => {
      queryClient.setQueryData<ActorRun[]>(["actor-runs"], (old = []) =>
        old.map((r) => r.id === id ? { ...r, ingestionStatus: "pending" } : r)
      );
      toast.success("Re-ingestion triggered");
    },
    onError: (err: Error) => toast.error(err.message || "Failed to trigger re-ingestion"),
  });

  const bulkRetryMutation = useMutation({
    mutationFn: (ids: number[]) => bulkRetryApi(ids),
    onSuccess: ({ ok, failed }) => {
      // Refetch to pick up new statuses for the retried runs (they get
      // re-queued server-side, so the cache rewrite is non-trivial).
      queryClient.invalidateQueries({ queryKey: ["actor-runs"] });
      setSelectedIds(new Set());
      if (failed === 0) {
        toast.success(`Re-launched ${ok} run${ok !== 1 ? "s" : ""}`);
      } else {
        toast.warning(`Re-launched ${ok}; ${failed} failed to queue`);
      }
    },
    onError: (err: Error) => toast.error(err.message || "Failed to re-launch runs"),
  });

  const bulkReIngestMutation = useMutation({
    mutationFn: (ids: number[]) => bulkReIngestApi(ids),
    onSuccess: ({ ok, failed, okIds }) => {
      // Optimistically mark only the runs whose re-ingest request actually
      // succeeded so the row chip updates immediately. Any failures are
      // reconciled by a forced refetch (otherwise the row would stay frozen
      // on its old status until the next 15s poll).
      if (okIds.length > 0) {
        const okSet = new Set(okIds);
        queryClient.setQueryData<ActorRun[]>(["actor-runs"], (old = []) =>
          old.map((r) => (okSet.has(r.id) ? { ...r, ingestionStatus: "pending" } : r))
        );
      }
      if (failed > 0) {
        queryClient.invalidateQueries({ queryKey: ["actor-runs"] });
      }
      setSelectedIds(new Set());
      if (failed === 0) {
        toast.success(`Re-ingestion triggered for ${ok} run${ok !== 1 ? "s" : ""}`);
      } else {
        toast.warning(`Re-ingestion triggered for ${ok}; ${failed} failed`);
      }
    },
    onError: (err: Error) => toast.error(err.message || "Failed to trigger re-ingestion"),
  });

  const handleSelect = (id: number, checked: boolean) => {
    setSelectedIds((prev) => {
      const n = new Set(prev);
      checked ? n.add(id) : n.delete(id);
      return n;
    });
  };

  const handleSelectAll = (ids: number[], checked: boolean) => {
    setSelectedIds((prev) => {
      const n = new Set(prev);
      ids.forEach((id) => checked ? n.add(id) : n.delete(id));
      return n;
    });
  };

  const queuedCount  = runs.filter((r) => r.status === "queued").length;
  const runningCount = runs.filter((r) => r.status === "running").length;
  const failedCount  = runs.filter((r) => r.status === "failed" || r.status === "timeout").length;
  const billingLimitHit = runs.some(isBillingError);

  const activeRuns      = runs.filter(isActive);
  const terminalRuns    = runs.filter((r) => !isActive(r));
  const allRunIds       = runs.map((r) => r.id);
  const allActiveIds    = activeRuns.map((r) => r.id);
  const allTerminalIds  = terminalRuns.map((r) => r.id);
  const failedIds       = runs.filter((r) => r.status === "failed" || r.status === "timeout").map((r) => r.id);
  // Same as failedIds but excludes billing-cap aborts — used for the "Retry
  // all failed" shortcut so we don't fan out requests the server will 409.
  const retryableIds    = runs.filter(isRetryable).map((r) => r.id);

  const selectedRuns      = runs.filter((r) => selectedIds.has(r.id));
  const selectedActiveIds = selectedRuns.filter(isActive).map((r) => r.id);
  const selectedRunnableIds   = selectedRuns.filter(isRunnable).map((r) => r.id);
  const selectedIngestableIds = selectedRuns.filter(isIngestable).map((r) => r.id);
  const selectedTerminalIds = selectedRuns.filter((r) => !isActive(r)).map((r) => r.id);

  const allRowsSelected  = allRunIds.length > 0 && allRunIds.every((id) => selectedIds.has(id));
  const someRowsSelected = allRunIds.some((id) => selectedIds.has(id)) && !allRowsSelected;

  if (isLoading) {
    return (
      <div className="p-8 max-w-5xl mx-auto">
        <div className="mb-6">
          <Skeleton className="h-7 w-36 mb-2" />
          <Skeleton className="h-4 w-64" />
        </div>
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-12 w-full rounded-md" />)}
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

  return (
    <div className="p-8 max-w-5xl mx-auto">
      {viewingRun && (
        <OutputDialog run={viewingRun} onClose={() => setViewingRun(null)} />
      )}

      {/* Header */}
      <div className="mb-4 flex items-start justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-foreground mb-1">Runs Audit</h1>
          <p className="text-muted-foreground text-sm max-w-3xl">
            Step 3 of 5 — Each row is a single Apify actor run: one platform-scraper firing against one
            scout query. Runs progress through Queued → Running → Succeeded / Failed. When a run
            succeeds, its data is automatically fetched from Apify and ingested into raw signals.
            "Fetched" is the total records the scraper returned; "Usable" is how many passed the noise
            floor and language filter; the rest are dropped. "Ingestion" tracks whether records have been
            written to the signals table (pending → done). If a run failed, use Retry to relaunch it. If
            it succeeded but ingestion is stuck, use Re-ingest. Click a succeeded row to inspect the raw
            Apify output. Cost reflects real Apify billing. The list auto-refreshes every 15 seconds.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {failedIds.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="gap-2 text-red-600 border-red-300 hover:bg-red-50"
              onClick={() => bulkDeleteMutation.mutate(failedIds)}
              disabled={bulkDeleteMutation.isPending}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Clear failed ({failedIds.length})
            </Button>
          )}
          {allTerminalIds.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="gap-2 text-muted-foreground"
              onClick={() => bulkDeleteMutation.mutate(allTerminalIds)}
              disabled={bulkDeleteMutation.isPending}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Clear all done ({allTerminalIds.length})
            </Button>
          )}
          <Button variant="outline" size="sm" className="gap-2" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Billing limit banner */}
      {billingLimitHit && (
        <Alert variant="destructive" className="mb-4">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            <span className="font-semibold">Apify billing limit reached.</span> One or more runs were aborted because your Apify account has hit its monthly usage cap. Retrying these runs will not help — upgrade your Apify plan or wait until the billing cycle resets, then re-launch from the Queries page.
          </AlertDescription>
        </Alert>
      )}

      {/* Stats */}
      <div className="flex gap-3 mb-4">
        {queuedCount > 0 && (
          <Badge className="bg-gray-400 text-white border-0">{queuedCount} queued</Badge>
        )}
        {runningCount > 0 && (
          <Badge className="bg-blue-500 text-white border-0 gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-white/80 animate-pulse inline-block" />
            {runningCount} running
          </Badge>
        )}
        {failedCount > 0 && (
          <Badge className="bg-red-500 text-white border-0">{failedCount} failed</Badge>
        )}
        <Badge variant="outline" className="text-xs">{runs.length} total</Badge>
      </div>

      {/* Bulk actions toolbar — visible whenever there are runs. Supports
          selecting every row across statuses and exposes contextual actions
          (cancel for active, retry for failed/timeout, delete for terminal)
          based on what's currently selected. */}
      {runs.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap mb-4 p-2 bg-muted/40 rounded-lg border border-border">
          <button
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-muted transition-colors"
            onClick={() => handleSelectAll(allRunIds, !allRowsSelected)}
          >
            {allRowsSelected ? (
              <CheckSquare className="h-3.5 w-3.5" />
            ) : someRowsSelected ? (
              <CheckSquare className="h-3.5 w-3.5 opacity-50" />
            ) : (
              <Square className="h-3.5 w-3.5" />
            )}
            {allRowsSelected
              ? `Deselect all (${runs.length})`
              : `Select all (${runs.length})`}
          </button>

          {selectedIds.size > 0 && (
            <span className="text-xs text-muted-foreground">
              {selectedIds.size} selected
            </span>
          )}

          <div className="w-px h-4 bg-border mx-1" />

          {selectedIds.size > 0 ? (
            <>
              {selectedRunnableIds.length > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  className="text-xs h-7 px-2 gap-1"
                  disabled={bulkRetryMutation.isPending}
                  onClick={() => bulkRetryMutation.mutate(selectedRunnableIds)}
                  title="Re-launch the actor for every selected failed or timed-out run. Skips already-running runs, succeeded runs, and runs blocked by Apify billing limits."
                >
                  {bulkRetryMutation.isPending
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <RefreshCw className="h-3.5 w-3.5" />}
                  Run {selectedRunnableIds.length}
                </Button>
              )}
              {selectedIngestableIds.length > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  className="text-xs h-7 px-2 gap-1"
                  disabled={bulkReIngestMutation.isPending}
                  onClick={() => bulkReIngestMutation.mutate(selectedIngestableIds)}
                  title="Re-process the dataset for every selected succeeded run. Use this if ingestion failed or signals look stale."
                >
                  {bulkReIngestMutation.isPending
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <Database className="h-3.5 w-3.5" />}
                  Ingest {selectedIngestableIds.length}
                </Button>
              )}
              {selectedActiveIds.length > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  className="text-xs h-7 px-2 text-red-600 border-red-300 hover:bg-red-50 hover:border-red-400 gap-1"
                  disabled={bulkCancelMutation.isPending}
                  onClick={() => bulkCancelMutation.mutate(selectedActiveIds)}
                >
                  {bulkCancelMutation.isPending
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <XCircle className="h-3.5 w-3.5" />}
                  Kill {selectedActiveIds.length}
                </Button>
              )}
              {selectedTerminalIds.length > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  className="text-xs h-7 px-2 text-red-600 border-red-300 hover:bg-red-50 hover:border-red-400 gap-1"
                  disabled={bulkDeleteMutation.isPending}
                  onClick={() => bulkDeleteMutation.mutate(selectedTerminalIds)}
                >
                  {bulkDeleteMutation.isPending
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <Trash2 className="h-3.5 w-3.5" />}
                  Delete {selectedTerminalIds.length}
                </Button>
              )}
            </>
          ) : (
            <>
              {queuedCount > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  className="text-xs h-7 px-2 text-red-600 border-red-300 hover:bg-red-50 hover:border-red-400 gap-1"
                  disabled={bulkCancelMutation.isPending}
                  onClick={() =>
                    bulkCancelMutation.mutate(runs.filter((r) => r.status === "queued").map((r) => r.id))
                  }
                >
                  <XCircle className="h-3.5 w-3.5" />
                  Kill all queued ({queuedCount})
                </Button>
              )}
              {runningCount > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  className="text-xs h-7 px-2 text-red-600 border-red-300 hover:bg-red-50 hover:border-red-400 gap-1"
                  disabled={bulkCancelMutation.isPending}
                  onClick={() =>
                    bulkCancelMutation.mutate(runs.filter((r) => r.status === "running").map((r) => r.id))
                  }
                >
                  <XCircle className="h-3.5 w-3.5" />
                  Kill all running ({runningCount})
                </Button>
              )}
              {retryableIds.length > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  className="text-xs h-7 px-2 gap-1"
                  disabled={bulkRetryMutation.isPending}
                  onClick={() => bulkRetryMutation.mutate(retryableIds)}
                >
                  {bulkRetryMutation.isPending
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <RefreshCw className="h-3.5 w-3.5" />}
                  Retry all failed ({retryableIds.length})
                </Button>
              )}
            </>
          )}
        </div>
      )}

      {runs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-12 text-center">
          <p className="text-sm font-medium text-muted-foreground">No runs yet</p>
          <p className="text-xs text-muted-foreground mt-1">Launch scrapers from the Queries page to start runs.</p>
        </div>
      ) : (
        <div className="rounded-xl border border-border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30">
                <TableHead className="w-10 pl-4">
                  <Checkbox
                    checked={allRowsSelected ? true : someRowsSelected ? "indeterminate" : false}
                    onCheckedChange={(v) => handleSelectAll(allRunIds, !!v)}
                    disabled={allRunIds.length === 0}
                    aria-label="Select all runs"
                  />
                </TableHead>
                <TableHead className="w-16">Platform</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Fetched</TableHead>
                <TableHead className="text-right">Usable</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead>Ingestion</TableHead>
                <TableHead>Started</TableHead>
                <TableHead className="w-24"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => {
                const active   = isActive(run);
                const viewable = isViewable(run);
                return (
                  <TableRow
                    key={run.id}
                    className={[
                      selectedIds.has(run.id) ? "bg-blue-50/40 dark:bg-blue-950/20" : "",
                      viewable ? "cursor-pointer hover:bg-muted/40" : "",
                    ].join(" ")}
                    onClick={viewable ? () => setViewingRun(run) : undefined}
                    title={viewable ? "Click to view output" : undefined}
                  >
                    <TableCell className="pl-4" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selectedIds.has(run.id)}
                        onCheckedChange={(v) => handleSelect(run.id, !!v)}
                        aria-label={`Select run ${run.id}`}
                      />
                    </TableCell>
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
                        <p className="text-xs text-red-500 mt-0.5 max-w-[200px] truncate" title={run.errorMessage}>
                          {run.errorMessage}
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums">
                      {fmt.num(run.recordsFetched)}
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums">
                      {fmt.num(run.recordsUsable)}
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums text-muted-foreground">
                      {fmt.cost(run.costUsd)}
                    </TableCell>
                    <TableCell>
                      {run.ingestionStatus && (
                        <span className={[
                          "inline-block rounded px-1.5 py-0.5 text-[10px] font-medium",
                          run.ingestionStatus === "done" ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300" :
                          run.ingestionStatus === "processing" ? "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300" :
                          run.ingestionStatus === "failed" ? "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300" :
                          "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
                        ].join(" ")}>
                          {run.ingestionStatus}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {fmt.time(run.startedAt)}
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-1">
                        {active && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 p-0 text-red-500 hover:text-red-700 hover:bg-red-50"
                            title="Kill this run"
                            onClick={() => cancelMutation.mutate(run.id)}
                            disabled={cancelMutation.isPending}
                          >
                            <XCircle className="h-4 w-4" />
                          </Button>
                        )}
                        {isRetryable(run) && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 text-xs gap-1"
                            onClick={() => retryMutation.mutate(run.id)}
                            disabled={retryMutation.isPending}
                          >
                            {retryMutation.isPending
                              ? <Loader2 className="h-3 w-3 animate-spin" />
                              : <RefreshCw className="h-3 w-3" />}
                            Retry
                          </Button>
                        )}
                        {!active && !isRetryable(run) && run.status === "succeeded" && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 text-xs gap-1"
                            title="Re-ingest signals from this run"
                            onClick={(e) => { e.stopPropagation(); reIngestMutation.mutate(run.id); }}
                            disabled={reIngestMutation.isPending || run.ingestionStatus === "processing"}
                          >
                            {reIngestMutation.isPending
                              ? <Loader2 className="h-3 w-3 animate-spin" />
                              : <RefreshCw className="h-3 w-3" />}
                            Re-ingest
                          </Button>
                        )}
                        {!active && !isRetryable(run) && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 p-0 text-muted-foreground hover:text-red-600 hover:bg-red-50"
                            title="Delete this run"
                            onClick={(e) => { e.stopPropagation(); bulkDeleteMutation.mutate([run.id]); }}
                            disabled={bulkDeleteMutation.isPending}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
