import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useCompanyId } from "@/hooks/use-company";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AlertCircle, RefreshCw, ChevronDown, ChevronRight as ChevronRightIcon, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  fetchPipelineRunStatus,
  relativeTime,
  extractionEstimate,
  timeseriesEstimate,
  stateMachineEstimate,
  usePipelineRunTracker,
  type PipelineRunStatus,
  type StepEstimate,
} from "@/lib/pipeline-status";

interface EntityState {
  id: number;
  entityId: number;
  geography: string;
  state: string;
  stateEnteredAt: string;
  lastTransitionReason: string | null;
  volume7d: number;
  volume30d: number;
  volume90d: number;
  velocity: number;
  growthWow: number;
  growthMom: number;
  volatility: number;
  platformsSeen: string[];
  computedAt: string;
  entity: {
    id: number;
    canonicalLabel: string;
    entityType: string;
    aliases: string[];
    totalMentions: number;
    firstSeenAt: string | null;
    lastSeenAt: string | null;
  };
}

interface TimeseriesRow {
  id: number;
  platform: string;
  geography: string;
  bucketDate: string;
  mentions: number;
  uniqueAuthors: number;
  engagementSum: number;
}

const STATE_COLORS: Record<string, string> = {
  candidate: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  emerging: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  confirmed: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  peaking: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  declining: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  dormant: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  resurgent: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
};

// Fallback colour for any entity type the user removed from the taxonomy
// (so historical rows still render with a chip).
const FALLBACK_TYPE_COLOR = "bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-300";

const STATE_OPTIONS = ["all", "candidate", "emerging", "confirmed", "peaking", "declining", "dormant", "resurgent"];

interface EntityTypeConfig {
  id: string;
  label: string;
  description: string;
  examples: string;
  color: string;
}

async function fetchEntityTypes(companyId: number): Promise<EntityTypeConfig[]> {
  const res = await fetch(`/api/pipeline/companies/${companyId}/pipeline-config`);
  if (!res.ok) throw new Error(await res.text());
  const cfg = (await res.json()) as { entityTypes?: EntityTypeConfig[] };
  return cfg.entityTypes ?? [];
}

function pct(v: number): string {
  return `${v >= 0 ? "+" : ""}${(v * 100).toFixed(0)}%`;
}

async function fetchEntityStates(companyId: number, state: string, geography: string): Promise<EntityState[]> {
  const params = new URLSearchParams();
  if (state !== "all") params.set("state", state);
  if (geography !== "all") params.set("geography", geography);
  const res = await fetch(`/api/pipeline/companies/${companyId}/entity-states?${params}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function fetchTimeseries(entityId: number): Promise<TimeseriesRow[]> {
  const res = await fetch(`/api/pipeline/entities/${entityId}/timeseries?windowDays=30`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function runStateMachine(companyId: number): Promise<void> {
  const res = await fetch(`/api/pipeline/companies/${companyId}/run-state-machine`, { method: "POST" });
  if (!res.ok) throw new Error(await res.text());
}

async function runTimeseries(companyId: number): Promise<void> {
  const res = await fetch(`/api/pipeline/companies/${companyId}/run-timeseries`, { method: "POST" });
  if (!res.ok) throw new Error(await res.text());
}

async function runEntityExtraction(companyId: number): Promise<void> {
  const res = await fetch(`/api/pipeline/companies/${companyId}/run-entity-extraction`, { method: "POST" });
  if (!res.ok) throw new Error(await res.text());
}

function TimeseriesInline({ entityId }: { entityId: number }) {
  const { data, isLoading } = useQuery({
    queryKey: ["entity-timeseries", entityId],
    queryFn: () => fetchTimeseries(entityId),
    staleTime: 60_000,
  });

  if (isLoading) return <span className="text-muted-foreground/50 text-xs">loading…</span>;
  if (!data || data.length === 0) return <span className="text-muted-foreground/40 text-xs">no data</span>;

  const byDate = new Map<string, number>();
  for (const r of data) {
    byDate.set(r.bucketDate, (byDate.get(r.bucketDate) ?? 0) + r.mentions);
  }
  const sorted = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const max = Math.max(...sorted.map(([, v]) => v), 1);

  return (
    <div className="flex items-end gap-0.5 h-8">
      {sorted.slice(-14).map(([date, v]) => (
        <div
          key={date}
          title={`${date}: ${v}`}
          className="w-1.5 rounded-sm bg-primary/50 hover:bg-primary transition-colors"
          style={{ height: `${Math.max((v / max) * 100, 4)}%` }}
        />
      ))}
    </div>
  );
}

interface PipelineStepRowProps {
  index: number;
  title: string;
  description: string;
  step: StepEstimate;
  lastRunAt: string | null;
  autoTrigger: string;
  pending: boolean;
  primary?: boolean;
  onRun: () => void;
}

function PipelineStepRow({
  index,
  title,
  description,
  step,
  lastRunAt,
  autoTrigger,
  pending,
  primary,
  onRun,
}: PipelineStepRowProps) {
  return (
    <div className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-xs font-mono">
            {index}.
          </span>
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          {pending && (
            <span className="text-primary inline-flex items-center gap-1 text-xs">
              <Loader2 className="h-3 w-3 animate-spin" />
              running…
            </span>
          )}
        </div>
        <p className="text-muted-foreground mt-1 text-xs">{description}</p>
        <p className="text-muted-foreground/80 mt-1 text-xs italic">
          Auto: {autoTrigger}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="text-foreground font-medium">{step.scope}</span>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">
            estimated {step.estimate}
          </span>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">
            last run {relativeTime(lastRunAt)}
          </span>
        </div>
      </div>
      <Button
        size="sm"
        variant={primary ? "default" : "outline"}
        className="gap-1.5 sm:w-32 sm:justify-center"
        disabled={pending || !step.willDoWork}
        onClick={onRun}
        title={!step.willDoWork ? "Nothing to do" : undefined}
      >
        {pending ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Running…
          </>
        ) : (
          "Run"
        )}
      </Button>
    </div>
  );
}

interface PipelinePanelProps {
  registerStart: (
    fn: (step: "extraction" | "timeseries" | "stateMachine") => void
  ) => void;
  onRunExtraction: () => void;
  onRunTimeseries: () => void;
  onRunStateMachine: () => void;
}

function PipelinePanel({
  registerStart,
  onRunExtraction,
  onRunTimeseries,
  onRunStateMachine,
}: PipelinePanelProps) {
  const queryClient = useQueryClient();
  const companyId = useCompanyId();

  const { data: status, isLoading } = useQuery<PipelineRunStatus>({
    queryKey: ["pipeline-run-status", companyId],
    queryFn: () => fetchPipelineRunStatus(companyId),
    refetchOnWindowFocus: false,
    refetchInterval: (query) => {
      // Poll every 3s while any step is still running. The tracker decides
      // when "running" ends (lastRunAt advances OR heuristic timeout).
      // We can't read tracker state here directly, so we rely on the
      // closure captured by the component below via the staleTime/refetch
      // mechanism. As a simple proxy: while we have no data yet, poll
      // once; otherwise leave polling control to the effect below.
      void query;
      return false;
    },
    staleTime: 10_000,
  });

  const tracker = usePipelineRunTracker(status);

  // Expose markStarted to the parent so its mutation onSuccess can call it.
  useEffect(() => {
    registerStart(tracker.markStarted);
  }, [registerStart, tracker.markStarted]);

  // Active polling driven by the tracker: while any step is "running",
  // refetch the status every 3s and invalidate any other consumers.
  useEffect(() => {
    if (!tracker.anyRunning) return;
    const id = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: ["pipeline-run-status", companyId] });
    }, 3_000);
    return () => clearInterval(id);
  }, [tracker.anyRunning, queryClient, companyId]);

  // When a long-running job completes, refresh the entity list so users see
  // updated states without having to click Refresh.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !tracker.anyRunning) {
      queryClient.invalidateQueries({ queryKey: ["entity-states"] });
    }
    wasRunning.current = tracker.anyRunning;
  }, [tracker.anyRunning, queryClient]);

  if (isLoading || !status) {
    return (
      <div className="border-border mb-6 rounded-xl border p-4">
        <Skeleton className="mb-2 h-5 w-32" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  const ext = extractionEstimate(status);
  const ts = timeseriesEstimate(status);
  const sm = stateMachineEstimate(status);

  return (
    <div className="border-border mb-6 rounded-xl border overflow-hidden">
      <div className="border-border bg-muted/30 border-b px-4 py-2">
        <h2 className="text-sm font-semibold text-foreground">Pipeline</h2>
        <p className="text-muted-foreground text-xs">
          Run these steps in order to refresh entities from the latest signals.
          Each runs in the background; this page polls for progress while it's
          running and updates the timestamp when the job finishes.
        </p>
      </div>
      <div className="divide-border divide-y">
        <PipelineStepRow
          index={1}
          title="Entity Extraction"
          description="Pulls named entities (trends, ingredients, products, places) out of raw signals using the LLM."
          step={ext}
          lastRunAt={status.extraction.lastExtractionAt}
          autoTrigger="runs continuously as ingestion delivers new signals"
          pending={tracker.isRunning("extraction")}
          onRun={onRunExtraction}
        />
        <PipelineStepRow
          index={2}
          title="Timeseries Aggregation"
          description="Buckets signals into daily mention counts per entity / platform / geography over the last 90 days."
          step={ts}
          lastRunAt={status.timeseries.lastComputedAt}
          autoTrigger="after every scout pull + nightly 02:00 UTC when new signals exist"
          pending={tracker.isRunning("timeseries")}
          onRun={onRunTimeseries}
        />
        <PipelineStepRow
          index={3}
          title="State Machine"
          description="Advances entities through their lifecycle (candidate → emerging → confirmed → peaking → declining → dormant)."
          step={sm}
          lastRunAt={status.stateMachine.lastComputedAt}
          autoTrigger="after every scout pull + nightly 02:30 UTC"
          pending={tracker.isRunning("stateMachine")}
          primary
          onRun={onRunStateMachine}
        />
      </div>
    </div>
  );
}

export default function EntitiesAuditPage() {
  const companyId = useCompanyId();
  const [stateFilter, setStateFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [geoFilter, setGeoFilter] = useState("all");
  const [expanded, setExpanded] = useState<number | null>(null);

  const { data: allStates = [], isLoading, error, refetch } = useQuery({
    queryKey: ["entity-states", companyId, stateFilter, geoFilter],
    queryFn: () => fetchEntityStates(companyId, stateFilter, geoFilter),
    refetchOnWindowFocus: false,
  });

  const { data: entityTypes = [] } = useQuery({
    queryKey: ["entity-types-config", companyId],
    queryFn: () => fetchEntityTypes(companyId),
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });

  // Lookup table of id -> { label, color } built from the per-company config.
  const typeLookup: Record<string, { label: string; color: string }> = {};
  for (const t of entityTypes) typeLookup[t.id] = { label: t.label, color: t.color };

  // PipelinePanel registers its tracker.markStarted via this ref so the
  // mutations below can flag a step as "running" the moment the POST returns.
  // The tracker (inside the panel) clears the flag when the matching
  // last-run timestamp advances or a heuristic timeout elapses.
  const markStartedRef = useRef<
    ((step: "extraction" | "timeseries" | "stateMachine") => void) | null
  >(null);
  const registerStart = useCallback(
    (fn: (step: "extraction" | "timeseries" | "stateMachine") => void) => {
      markStartedRef.current = fn;
    },
    []
  );

  const stateMachineMutation = useMutation({
    mutationFn: () => runStateMachine(companyId),
    onSuccess: () => {
      markStartedRef.current?.("stateMachine");
      toast.success("State machine running — this page will refresh when it finishes");
    },
    onError: (err: Error) => toast.error(err.message || "Failed to start state machine"),
  });

  const timeseriesMutation = useMutation({
    mutationFn: () => runTimeseries(companyId),
    onSuccess: () => {
      markStartedRef.current?.("timeseries");
      toast.success("Timeseries aggregation running — this page will refresh when it finishes");
    },
    onError: (err: Error) => toast.error(err.message || "Failed to start timeseries"),
  });

  const extractionMutation = useMutation({
    mutationFn: () => runEntityExtraction(companyId),
    onSuccess: () => {
      markStartedRef.current?.("extraction");
      toast.success("Entity extraction running — run Timeseries then State Machine when it finishes");
    },
    onError: (err: Error) => toast.error(err.message || "Failed to start entity extraction"),
  });

  const filtered = typeFilter === "all"
    ? allStates
    : allStates.filter((s) => s.entity.entityType === typeFilter);

  const geographies = [...new Set(allStates.map((s) => s.geography).filter(Boolean))].sort();

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
            {error instanceof Error ? error.message : "Failed to load entities."}
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
          <h1 className="text-2xl font-bold text-foreground mb-1">Entities Audit</h1>
          <p className="text-muted-foreground text-sm max-w-3xl">
            Step 5 of 5 — Entities are the named concepts — trends, ingredients, products, places —
            that the LLM extracted from raw signals. Each entity progresses through a lifecycle: it
            starts as a candidate, may advance to emerging or confirmed as mention volume and
            week-over-week growth cross configured thresholds across multiple platforms, and eventually
            peaks, declines, or goes dormant. v7d is the mention count over the last 7 days; WoW and
            MoM are week-over-week and month-over-month growth rates. Entities reaching "confirmed" or
            above are surfaced to the Radar. The 30-day sparkline shows daily mention volume. Use "Run
            Timeseries" to recompute mention buckets from signals, then "Run State Machine" to advance
            entities through lifecycle transitions based on the latest data.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => refetch()}>
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Pipeline run panel */}
      <PipelinePanel
        registerStart={registerStart}
        onRunExtraction={() => extractionMutation.mutate()}
        onRunTimeseries={() => timeseriesMutation.mutate()}
        onRunStateMachine={() => stateMachineMutation.mutate()}
      />

      {/* Filters */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <Select value={stateFilter} onValueChange={(v) => { setStateFilter(v); }}>
          <SelectTrigger className="h-8 w-40 text-xs">
            <SelectValue placeholder="State" />
          </SelectTrigger>
          <SelectContent>
            {STATE_OPTIONS.map((s) => (
              <SelectItem key={s} value={s} className="text-xs">
                {s === "all" ? "All states" : s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={typeFilter} onValueChange={(v) => { setTypeFilter(v); }}>
          <SelectTrigger className="h-8 w-44 text-xs">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-xs">All types</SelectItem>
            {entityTypes.map((t) => (
              <SelectItem key={t.id} value={t.id} className="text-xs">
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={geoFilter} onValueChange={(v) => { setGeoFilter(v); }}>
          <SelectTrigger className="h-8 w-36 text-xs">
            <SelectValue placeholder="Geography" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-xs">All geographies</SelectItem>
            {geographies.map((g) => (
              <SelectItem key={g} value={g} className="text-xs">{g}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <span className="text-xs text-muted-foreground ml-auto">
          {filtered.length.toLocaleString()} entit{filtered.length !== 1 ? "ies" : "y"}
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-border p-12 text-center">
          <p className="text-sm font-medium text-muted-foreground">No entities found</p>
          <p className="text-xs text-muted-foreground mt-2 max-w-sm mx-auto">
            Run the three steps in order from the Pipeline panel above:
          </p>
          <ol className="text-xs text-muted-foreground mt-2 space-y-1 text-left max-w-xs mx-auto list-decimal list-inside">
            <li><span className="font-medium">Run Extraction</span> — extract named entities from signals via LLM</li>
            <li><span className="font-medium">Run Timeseries</span> — bucket signals into daily mention counts</li>
            <li><span className="font-medium">Run State Machine</span> — advance entities through lifecycle states</li>
          </ol>
          <p className="text-xs text-muted-foreground mt-2">
            You need ingested signals first — check the Runs page if no scraper runs have succeeded.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-border overflow-hidden">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-left">
                <th className="px-3 py-2.5 font-medium text-muted-foreground w-6" />
                <th className="px-3 py-2.5 font-medium text-muted-foreground">Entity</th>
                <th className="px-3 py-2.5 font-medium text-muted-foreground w-20">Type</th>
                <th className="px-3 py-2.5 font-medium text-muted-foreground w-28">State</th>
                <th className="px-3 py-2.5 font-medium text-muted-foreground w-16">Geo</th>
                <th className="px-3 py-2.5 font-medium text-muted-foreground w-20 text-right">v7d</th>
                <th className="px-3 py-2.5 font-medium text-muted-foreground w-20 text-right">WoW</th>
                <th className="px-3 py-2.5 font-medium text-muted-foreground w-20 text-right">MoM</th>
                <th className="px-3 py-2.5 font-medium text-muted-foreground">Platforms</th>
                <th className="px-3 py-2.5 font-medium text-muted-foreground w-32">Trend (30d)</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s, i) => {
                const isExpanded = expanded === s.id;
                return (
                  <>
                    <tr
                      key={s.id}
                      className={`border-b border-border cursor-pointer hover:bg-muted/20 ${i % 2 === 0 ? "" : "bg-muted/10"}`}
                      onClick={() => setExpanded(isExpanded ? null : s.id)}
                    >
                      <td className="px-3 py-2.5 text-muted-foreground/50">
                        {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRightIcon className="h-3 w-3" />}
                      </td>
                      <td className="px-3 py-2.5 font-medium text-foreground">
                        {s.entity.canonicalLabel}
                        {s.entity.aliases?.length > 0 && (
                          <span className="ml-1.5 text-muted-foreground/60 font-normal">
                            {s.entity.aliases.slice(0, 2).join(", ")}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <span
                          className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${
                            typeLookup[s.entity.entityType]?.color ?? FALLBACK_TYPE_COLOR
                          }`}
                        >
                          {typeLookup[s.entity.entityType]?.label ?? s.entity.entityType}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${STATE_COLORS[s.state] ?? "bg-gray-100 text-gray-700"}`}>
                          {s.state}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 font-mono text-muted-foreground">{s.geography}</td>
                      <td className="px-3 py-2.5 text-right font-mono">{s.volume7d}</td>
                      <td className={`px-3 py-2.5 text-right font-mono ${s.growthWow > 0.1 ? "text-green-600" : s.growthWow < -0.1 ? "text-red-500" : "text-muted-foreground"}`}>
                        {pct(s.growthWow)}
                      </td>
                      <td className={`px-3 py-2.5 text-right font-mono ${s.growthMom > 0.1 ? "text-green-600" : s.growthMom < -0.1 ? "text-red-500" : "text-muted-foreground"}`}>
                        {pct(s.growthMom)}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex gap-1 flex-wrap">
                          {s.platformsSeen?.map((p) => (
                            <span key={p} className="text-[9px] bg-muted px-1 py-0.5 rounded font-mono">{p.slice(0, 2).toUpperCase()}</span>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <TimeseriesInline entityId={s.entityId} />
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr key={`${s.id}-detail`} className="border-b border-border bg-muted/5">
                        <td colSpan={10} className="px-6 py-3">
                          <div className="grid grid-cols-3 gap-4 text-xs">
                            <div>
                              <p className="text-muted-foreground font-medium mb-1">Volumes</p>
                              <p>7d: <span className="font-mono">{s.volume7d}</span></p>
                              <p>30d: <span className="font-mono">{s.volume30d}</span></p>
                              <p>90d: <span className="font-mono">{s.volume90d}</span></p>
                              <p>Total: <span className="font-mono">{s.entity.totalMentions}</span></p>
                            </div>
                            <div>
                              <p className="text-muted-foreground font-medium mb-1">Metrics</p>
                              <p>Velocity: <span className="font-mono">{s.velocity.toFixed(2)}/day</span></p>
                              <p>Volatility: <span className="font-mono">{s.volatility.toFixed(2)}</span></p>
                              <p>WoW: <span className="font-mono">{pct(s.growthWow)}</span></p>
                              <p>MoM: <span className="font-mono">{pct(s.growthMom)}</span></p>
                            </div>
                            <div>
                              <p className="text-muted-foreground font-medium mb-1">Transition</p>
                              <p className="text-muted-foreground/80 break-words">{s.lastTransitionReason ?? "—"}</p>
                              <p className="mt-1 text-muted-foreground/60">
                                Entered {s.state} {new Date(s.stateEnteredAt).toLocaleDateString()}
                              </p>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
