import { useQuery, useMutation } from "@tanstack/react-query";
import { useState } from "react";
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
import { AlertCircle, RefreshCw, ChevronDown, ChevronRight as ChevronRightIcon } from "lucide-react";
import { toast } from "sonner";

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

const TYPE_COLORS: Record<string, string> = {
  ingredient: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  flavour: "bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-300",
  format: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  packaging: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
  functional_benefit: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  emotional_benefit: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300",
  occasion: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
  provenance: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  dietary_claim: "bg-lime-100 text-lime-700 dark:bg-lime-900/30 dark:text-lime-300",
  brand: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  segment: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300",
  aesthetic_tag: "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-900/30 dark:text-fuchsia-300",
  other: "bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-300",
};

const STATE_OPTIONS = ["all", "candidate", "emerging", "confirmed", "peaking", "declining", "dormant", "resurgent"];
const TYPE_OPTIONS = [
  "all",
  "ingredient",
  "flavour",
  "format",
  "packaging",
  "functional_benefit",
  "emotional_benefit",
  "occasion",
  "provenance",
  "dietary_claim",
  "brand",
  "segment",
  "aesthetic_tag",
  "other",
];

function pct(v: number): string {
  return `${v >= 0 ? "+" : ""}${(v * 100).toFixed(0)}%`;
}

async function fetchEntityStates(state: string, geography: string): Promise<EntityState[]> {
  const params = new URLSearchParams();
  if (state !== "all") params.set("state", state);
  if (geography !== "all") params.set("geography", geography);
  const res = await fetch(`/api/pipeline/companies/1/entity-states?${params}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function fetchTimeseries(entityId: number): Promise<TimeseriesRow[]> {
  const res = await fetch(`/api/pipeline/entities/${entityId}/timeseries?windowDays=30`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function runStateMachine(): Promise<void> {
  const res = await fetch("/api/pipeline/companies/1/run-state-machine", { method: "POST" });
  if (!res.ok) throw new Error(await res.text());
}

async function runTimeseries(): Promise<void> {
  const res = await fetch("/api/pipeline/companies/1/run-timeseries", { method: "POST" });
  if (!res.ok) throw new Error(await res.text());
}

async function runEntityExtraction(): Promise<void> {
  const res = await fetch("/api/pipeline/companies/1/run-entity-extraction", { method: "POST" });
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

export default function EntitiesAuditPage() {
  const [stateFilter, setStateFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [geoFilter, setGeoFilter] = useState("all");
  const [expanded, setExpanded] = useState<number | null>(null);

  const { data: allStates = [], isLoading, error, refetch } = useQuery({
    queryKey: ["entity-states", stateFilter, geoFilter],
    queryFn: () => fetchEntityStates(stateFilter, geoFilter),
    refetchOnWindowFocus: false,
  });

  const stateMachineMutation = useMutation({
    mutationFn: runStateMachine,
    onSuccess: () => {
      toast.success("State machine started — refreshing in 5s…");
      setTimeout(() => refetch(), 5000);
    },
    onError: (err: Error) => toast.error(err.message || "Failed to start state machine"),
  });

  const timeseriesMutation = useMutation({
    mutationFn: runTimeseries,
    onSuccess: () => {
      toast.success("Timeseries aggregation started — refreshing in 5s…");
      setTimeout(() => refetch(), 5000);
    },
    onError: (err: Error) => toast.error(err.message || "Failed to start timeseries"),
  });

  const extractionMutation = useMutation({
    mutationFn: runEntityExtraction,
    onSuccess: () => toast.success("Entity extraction started — run Timeseries then State Machine after it completes"),
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
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            disabled={extractionMutation.isPending}
            onClick={() => extractionMutation.mutate()}
          >
            {extractionMutation.isPending ? "Extracting…" : "1. Run Extraction"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            disabled={timeseriesMutation.isPending}
            onClick={() => timeseriesMutation.mutate()}
          >
            {timeseriesMutation.isPending ? "Aggregating…" : "2. Run Timeseries"}
          </Button>
          <Button
            size="sm"
            className="gap-1.5"
            disabled={stateMachineMutation.isPending}
            onClick={() => stateMachineMutation.mutate()}
          >
            {stateMachineMutation.isPending ? "Running…" : "3. Run State Machine"}
          </Button>
        </div>
      </div>

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
          <SelectTrigger className="h-8 w-36 text-xs">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            {TYPE_OPTIONS.map((t) => (
              <SelectItem key={t} value={t} className="text-xs">
                {t === "all" ? "All types" : t}
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
            Run the three steps in order using the buttons above:
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
                        <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${TYPE_COLORS[s.entity.entityType] ?? "bg-gray-100 text-gray-700"}`}>
                          {s.entity.entityType}
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
