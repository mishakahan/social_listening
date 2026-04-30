import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useMemo, useEffect, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AlertCircle, RefreshCw, ChevronLeft, ChevronRight, Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  fetchPipelineRunStatus,
  extractionEstimate,
  relativeTime,
  usePipelineRunTracker,
  type PipelineRunStatus,
} from "@/lib/pipeline-status";

interface RawSignal {
  id: number;
  platform: string;
  sourceId: string;
  sourceUrl: string | null;
  postedAt: string | null;
  capturedAt: string;
  authorHandle: string | null;
  authorTier: string | null;
  text: string | null;
  hashtags: string[];
  language: string | null;
  engagementScore: number | null;
  engagementComposite: number | null;
  entityExtractionStatus: string;
  actorRunId: number | null;
}

const PLATFORM_OPTIONS = ["all", "instagram", "tiktok", "reddit", "xiaohongshu", "google_trends"];
const EXTRACTION_OPTIONS = ["all", "pending", "done", "failed"];
const PAGE_SIZE = 50;

async function fetchSignals(
  platform: string,
  extractionStatus: string,
  page: number
): Promise<{ signals: RawSignal[]; total: number }> {
  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(page * PAGE_SIZE),
  });
  if (platform !== "all") params.set("platform", platform);
  if (extractionStatus !== "all") params.set("entityExtractionStatus", extractionStatus);
  const res = await fetch(`/api/pipeline/companies/1/signals?${params}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function triggerExtraction(): Promise<void> {
  const res = await fetch("/api/pipeline/companies/1/run-entity-extraction", { method: "POST" });
  if (!res.ok) throw new Error(await res.text());
}

async function bulkDeleteSignals(signalIds: number[]): Promise<{ deleted: number }> {
  const res = await fetch("/api/pipeline/companies/1/signals/bulk-delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ signalIds }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

const PLATFORM_COLORS: Record<string, string> = {
  instagram: "bg-pink-100 text-pink-800 dark:bg-pink-900/30 dark:text-pink-300",
  tiktok: "bg-black/10 text-gray-800 dark:bg-white/10 dark:text-gray-200",
  reddit: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  xiaohongshu: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  google_trends: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
};

const EXTRACTION_COLORS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  done: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return "—";
  }
}

export default function SignalsAuditPage() {
  const queryClient = useQueryClient();
  const [platform, setPlatform] = useState("all");
  const [extractionStatus, setExtractionStatus] = useState("all");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["signals", platform, extractionStatus, page],
    queryFn: () => fetchSignals(platform, extractionStatus, page),
    refetchOnWindowFocus: false,
  });

  const { data: pipelineStatus } = useQuery<PipelineRunStatus>({
    queryKey: ["pipeline-run-status", 1],
    queryFn: () => fetchPipelineRunStatus(1),
    refetchOnWindowFocus: false,
    staleTime: 10_000,
  });
  const tracker = usePipelineRunTracker(pipelineStatus);
  const extractionRunning = tracker.isRunning("extraction");

  // Poll status while extraction is actually still running (decoupled from
  // mutation.isPending — the POST is fire-and-forget). Also refresh the
  // signals list when the run completes so users see the new statuses.
  useEffect(() => {
    if (!extractionRunning) return;
    const id = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: ["pipeline-run-status", 1] });
    }, 3_000);
    return () => clearInterval(id);
  }, [extractionRunning, queryClient]);

  const extractionMutation = useMutation({
    mutationFn: triggerExtraction,
    onSuccess: () => {
      tracker.markStarted("extraction");
      toast.success("Entity extraction running — this page will refresh when it finishes");
    },
    onError: (err: Error) => toast.error(err.message || "Failed to start extraction"),
  });

  // Refresh the signals list only when an extraction run actually completes
  // (true → false transition). Skips the initial mount (extractionRunning
  // starts as false) so we don't invalidate gratuitously.
  const wasExtractionRunning = useRef(false);
  useEffect(() => {
    if (wasExtractionRunning.current && !extractionRunning) {
      queryClient.invalidateQueries({ queryKey: ["signals"] });
    }
    wasExtractionRunning.current = extractionRunning;
  }, [extractionRunning, queryClient]);

  const extEstimate = pipelineStatus
    ? extractionEstimate(pipelineStatus)
    : null;

  const deleteMutation = useMutation({
    mutationFn: bulkDeleteSignals,
    onSuccess: ({ deleted }) => {
      toast.success(`Deleted ${deleted} signal${deleted !== 1 ? "s" : ""}`);
      setSelected(new Set());
      queryClient.invalidateQueries({ queryKey: ["signals"] });
    },
    onError: (err: Error) => toast.error(err.message || "Failed to delete signals"),
  });

  const signals = data?.signals ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  const pageIds = useMemo(() => signals.map((s) => s.id), [signals]);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const somePageSelected = pageIds.some((id) => selected.has(id));

  function toggleAll() {
    if (allPageSelected) {
      setSelected((prev) => {
        const next = new Set(prev);
        pageIds.forEach((id) => next.delete(id));
        return next;
      });
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        pageIds.forEach((id) => next.add(id));
        return next;
      });
    }
  }

  function toggleOne(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const handleFilterChange = (setter: (v: string) => void) => (v: string) => {
    setter(v);
    setPage(0);
    setSelected(new Set());
  };

  const handleDelete = () => {
    const ids = Array.from(selected);
    deleteMutation.mutate(ids);
  };

  if (isLoading) {
    return (
      <div className="p-8 max-w-7xl mx-auto">
        <Skeleton className="h-7 w-48 mb-2" />
        <Skeleton className="h-4 w-72 mb-8" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8 max-w-7xl mx-auto">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {error instanceof Error ? error.message : "Failed to load signals."}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-7xl mx-auto pb-8">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground mb-1">Signals Audit</h1>
          <p className="text-muted-foreground text-sm max-w-3xl">
            Step 4 of 5 — Raw signals are the individual records ingested from scraper runs: one row per
            social post, video, or search trend datapoint. Each is normalized from its platform's raw
            schema into a common format covering source ID, post date, author, language, engagement
            score, text, and hashtags. For Google Trends signals, Author, Lang, and Posted will always
            show "—" — these are keyword-level search interest metrics, not content posts, so those
            fields don't apply; Eng. shows the relative search interest (0–100). The Extraction column
            shows whether the LLM entity extraction pass has processed a signal. Signals marked "done"
            have had their named trends and products pulled out and are ready for the Entities step. Use
            "Run Extraction" to process any signals still marked "pending".
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={() => refetch()}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </Button>
          <div className="flex flex-col items-end gap-1">
            <Button
              size="sm"
              className="gap-1.5"
              disabled={
                extractionMutation.isPending ||
                extractionRunning ||
                (extEstimate ? !extEstimate.willDoWork : false)
              }
              onClick={() => extractionMutation.mutate()}
              title={
                extEstimate && !extEstimate.willDoWork
                  ? "No signals waiting for extraction"
                  : undefined
              }
            >
              {extractionMutation.isPending || extractionRunning ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Running…
                </>
              ) : (
                "Run Extraction"
              )}
            </Button>
            {extEstimate && (
              <span className="text-muted-foreground text-[11px] leading-tight text-right">
                {extEstimate.scope}
                {extEstimate.willDoWork ? ` · ${extEstimate.estimate}` : ""}
                {pipelineStatus?.extraction.lastExtractionAt && (
                  <>
                    {" · last run "}
                    {relativeTime(pipelineStatus.extraction.lastExtractionAt)}
                  </>
                )}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Filters + stats */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <Select value={platform} onValueChange={handleFilterChange(setPlatform)}>
          <SelectTrigger className="h-8 w-40 text-xs">
            <SelectValue placeholder="Platform" />
          </SelectTrigger>
          <SelectContent>
            {PLATFORM_OPTIONS.map((p) => (
              <SelectItem key={p} value={p} className="text-xs">
                {p === "all" ? "All platforms" : p}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={extractionStatus} onValueChange={handleFilterChange(setExtractionStatus)}>
          <SelectTrigger className="h-8 w-44 text-xs">
            <SelectValue placeholder="Extraction status" />
          </SelectTrigger>
          <SelectContent>
            {EXTRACTION_OPTIONS.map((s) => (
              <SelectItem key={s} value={s} className="text-xs">
                {s === "all" ? "All extraction statuses" : s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <span className="text-xs text-muted-foreground ml-auto">
          {total.toLocaleString()} signal{total !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 mb-3 px-3 py-2 rounded-lg bg-muted/50 border border-border">
          <span className="text-xs font-medium">
            {selected.size} selected
          </span>
          <Button
            size="sm"
            variant="destructive"
            className="h-7 gap-1.5 text-xs ml-auto"
            disabled={deleteMutation.isPending}
            onClick={handleDelete}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {deleteMutation.isPending ? "Deleting…" : `Delete ${selected.size}`}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            onClick={() => setSelected(new Set())}
          >
            Clear
          </Button>
        </div>
      )}

      {signals.length === 0 ? (
        <div className="rounded-xl border border-border p-12 text-center">
          <p className="text-sm font-medium text-muted-foreground">No signals found</p>
          <p className="text-xs text-muted-foreground mt-1">
            {platform === "all" && extractionStatus === "all"
              ? "Run scrapers and re-ingest a successful run to populate signals."
              : "Try adjusting filters."}
          </p>
        </div>
      ) : (
        <>
          <div className="rounded-xl border border-border overflow-hidden">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-left">
                  <th className="px-3 py-2.5 w-8">
                    <Checkbox
                      checked={allPageSelected}
                      data-state={somePageSelected && !allPageSelected ? "indeterminate" : undefined}
                      onCheckedChange={toggleAll}
                      aria-label="Select all on page"
                    />
                  </th>
                  <th className="px-3 py-2.5 font-medium text-muted-foreground w-8">ID</th>
                  <th className="px-3 py-2.5 font-medium text-muted-foreground">Platform</th>
                  <th className="px-3 py-2.5 font-medium text-muted-foreground">Posted</th>
                  <th className="px-3 py-2.5 font-medium text-muted-foreground">Author</th>
                  <th className="px-3 py-2.5 font-medium text-muted-foreground w-24">Lang</th>
                  <th className="px-3 py-2.5 font-medium text-muted-foreground w-20">Eng.</th>
                  <th className="px-3 py-2.5 font-medium text-muted-foreground">Text preview</th>
                  <th className="px-3 py-2.5 font-medium text-muted-foreground">Extraction</th>
                </tr>
              </thead>
              <tbody>
                {signals.map((s, i) => (
                  <tr
                    key={s.id}
                    className={`border-b border-border last:border-0 ${
                      selected.has(s.id)
                        ? "bg-primary/5"
                        : i % 2 === 0
                        ? ""
                        : "bg-muted/10"
                    }`}
                  >
                    <td className="px-3 py-2">
                      <Checkbox
                        checked={selected.has(s.id)}
                        onCheckedChange={() => toggleOne(s.id)}
                        aria-label={`Select signal ${s.id}`}
                      />
                    </td>
                    <td className="px-3 py-2 text-muted-foreground font-mono">{s.id}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${PLATFORM_COLORS[s.platform] ?? "bg-gray-100 text-gray-700"}`}>
                        {s.platform}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{fmtDate(s.postedAt)}</td>
                    <td className="px-3 py-2 font-mono text-muted-foreground max-w-[120px] truncate">
                      {s.authorHandle ?? "—"}
                    </td>
                    <td className="px-3 py-2">
                      {s.language ? (
                        <span className="font-mono text-muted-foreground">{s.language}</span>
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {s.engagementScore ?? "—"}
                    </td>
                    <td className="px-3 py-2 max-w-xs">
                      {s.sourceUrl ? (
                        <a
                          href={s.sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline truncate block"
                        >
                          {s.text?.slice(0, 80) ?? s.sourceUrl.slice(0, 80)}
                        </a>
                      ) : (
                        <span className="text-muted-foreground truncate block">
                          {s.text?.slice(0, 80) ?? "—"}
                        </span>
                      )}
                      {s.hashtags?.length > 0 && (
                        <span className="text-muted-foreground/60 block mt-0.5">
                          {s.hashtags.slice(0, 3).map((h) => `#${h}`).join(" ")}
                          {s.hashtags.length > 3 ? ` +${s.hashtags.length - 3}` : ""}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${EXTRACTION_COLORS[s.entityExtractionStatus] ?? "bg-gray-100 text-gray-700"}`}>
                        {s.entityExtractionStatus}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4">
              <span className="text-xs text-muted-foreground">
                Page {page + 1} of {totalPages}
              </span>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2"
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2"
                  disabled={page >= totalPages - 1}
                  onClick={() => setPage((p) => p + 1)}
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
