import { useMemo, useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useCompanyId } from "@/hooks/use-company";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Loader2,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { toast } from "sonner";

interface LongTailRow {
  id: number;
  entityId: number;
  canonicalLabel: string;
  entityType: string | null;
  aliases: string[];
  windowStart: string;
  windowEnd: string;
  currentMentions: number;
  baselineMentions: number;
  baselineKind: "yoy" | "prior_window" | string;
  upliftScore: number;
  posteriorProb: number;
  computedAt: string;
  sparkline: number[];
  /** All-time mentions, every platform and geography. */
  totalMentions: number;
  watchTopic: string | null;
  /** The search that found it; null means no seed keyword went looking for it. */
  searchTerm: string | null;
}

interface LongTailResponse {
  candidates: LongTailRow[];
  lastRunAt: string | null;
  minMentions: number;
  minPosterior: number;
}

type SortKey = "posterior" | "uplift" | "current" | "total";

const ALL = "all";
const NO_SEARCH_TERM = "No matching search term";

async function fetchLongTail(companyId: number): Promise<LongTailResponse> {
  const res = await fetch(`/api/pipeline/companies/${companyId}/long-tail`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function runLongTail(companyId: number): Promise<unknown> {
  const res = await fetch(`/api/pipeline/companies/${companyId}/run-long-tail`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function promoteEntity(companyId: number, entityId: number): Promise<unknown> {
  const res = await fetch(
    `/api/pipeline/companies/${companyId}/entities/${entityId}/promote`,
    { method: "POST" }
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length === 0) {
    return <div className="text-xs text-muted-foreground">—</div>;
  }
  const max = Math.max(1, ...values);
  const w = 120;
  const h = 28;
  const stepX = w / Math.max(values.length - 1, 1);
  const points = values
    .map((v, i) => `${(i * stepX).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`)
    .join(" ");
  return (
    <svg width={w} height={h} className="text-emerald-500">
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PosteriorBadge({ p }: { p: number }) {
  const pct = Math.round(p * 100);
  const className =
    p >= 0.95
      ? "bg-emerald-500 text-white border-0"
      : p >= 0.9
        ? "bg-green-500 text-white border-0"
        : "bg-amber-500 text-white border-0";
  return <Badge className={`text-xs tabular-nums ${className}`}>{pct}%</Badge>;
}

function SortHeader({
  label,
  field,
  current,
  dir,
  onSort,
}: {
  label: string;
  field: SortKey;
  current: SortKey;
  dir: "asc" | "desc";
  onSort: (k: SortKey) => void;
}) {
  const active = current === field;
  return (
    <button
      type="button"
      onClick={() => onSort(field)}
      className="flex items-center gap-1 justify-end w-full hover:text-foreground transition-colors"
    >
      <span>{label}</span>
      {active ? (
        dir === "desc" ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronUp className="h-3 w-3" />
        )
      ) : (
        <ChevronDown className="h-3 w-3 opacity-20" />
      )}
    </button>
  );
}

export default function EmergingLongTailPage() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const companyId = useCompanyId();
  const [sortBy, setSortBy] = useState<SortKey>("posterior");
  // Client-side: the candidate list is small (tens of rows) and already loaded.
  const [typeFilter, setTypeFilter] = useState(ALL);
  const [searchFilter, setSearchFilter] = useState(ALL);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // POST /run-long-tail is FIRE-AND-FORGET: it returns {ok:true} the moment
  // the run is queued, not when it finishes (see routes/pipeline.ts). So the
  // old handler declared "re-evaluation complete" and invalidated the query
  // immediately — the refetch raced ahead of the evaluation and pulled back
  // the OLD rows. The page then sat there showing stale results, or "no
  // candidates yet", while the run was still going. Measured: server wrote
  // results at 4:51:13 while the page still displayed 4:48:21.
  //
  // Fixed by polling until the server's own lastRunAt actually advances,
  // which is the only signal that the work is done.
  const [runStartedAt, setRunStartedAt] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["long-tail", companyId],
    queryFn: () => fetchLongTail(companyId),
    refetchOnWindowFocus: false,
    // Poll only while a run is in flight; stop as soon as it lands.
    refetchInterval: runStartedAt ? 4000 : false,
  });

  // Detect completion: lastRunAt has moved past what it was when we started.
  useEffect(() => {
    if (!runStartedAt || !data) return;
    const current = data.lastRunAt ?? "";
    if (current && current !== runStartedAt) {
      setRunStartedAt(null);
      toast.success("Long-tail re-evaluation complete");
    }
  }, [data, runStartedAt]);

  const runMutation = useMutation({
    mutationFn: () => runLongTail(companyId),
    onSuccess: () => {
      // "started", not "complete" — the server has only queued it.
      toast.info("Re-evaluation started, this takes a minute");
      setRunStartedAt(data?.lastRunAt ?? "none");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const promoteMutation = useMutation({
    mutationFn: (entityId: number) => promoteEntity(companyId, entityId),
    onSuccess: () => {
      toast.success("Promoted to main radar");
      queryClient.invalidateQueries({ queryKey: ["long-tail", companyId] });
      queryClient.invalidateQueries({ queryKey: ["trends"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const handleSort = (k: SortKey) => {
    if (k === sortBy) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortBy(k);
      setSortDir("desc");
    }
  };

  const sorted = useMemo(() => {
    const list = data?.candidates ?? [];
    const mul = sortDir === "asc" ? 1 : -1;
    return [...list].sort((a, b) => {
      let av: number;
      let bv: number;
      switch (sortBy) {
        case "uplift":
          av = a.upliftScore;
          bv = b.upliftScore;
          break;
        case "current":
          av = a.currentMentions;
          bv = b.currentMentions;
          break;
        case "total":
          av = a.totalMentions;
          bv = b.totalMentions;
          break;
        case "posterior":
        default:
          av = a.posteriorProb;
          bv = b.posteriorProb;
          break;
      }
      return (av - bv) * mul;
    });
  }, [data, sortBy, sortDir]);

  // Facet options derived from the data itself, so a filter can never offer a
  // value that returns nothing.
  const entityTypes = useMemo(
    () => [...new Set((data?.candidates ?? []).map((c) => c.entityType ?? "uncategorised"))].sort(),
    [data]
  );
  const searchTerms = useMemo(
    () => [...new Set((data?.candidates ?? []).map((c) => c.searchTerm ?? NO_SEARCH_TERM))].sort(),
    [data]
  );

  const candidates = useMemo(
    () =>
      sorted.filter(
        (c) =>
          (typeFilter === ALL || (c.entityType ?? "uncategorised") === typeFilter) &&
          (searchFilter === ALL || (c.searchTerm ?? NO_SEARCH_TERM) === searchFilter)
      ),
    [sorted, typeFilter, searchFilter]
  );

  if (isLoading) {
    return (
      <div className="p-8 max-w-6xl mx-auto">
        <div className="mb-6">
          <Skeleton className="h-7 w-48 mb-2" />
          <Skeleton className="h-4 w-80" />
        </div>
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8 max-w-6xl mx-auto">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {error instanceof Error ? error.message : "Failed to load long-tail candidates."}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const lastRunAt = data?.lastRunAt
    ? new Date(data.lastRunAt).toLocaleString()
    : "never";

  return (
    <TooltipProvider delayDuration={150}>
      <div className="p-8 max-w-6xl mx-auto">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Sparkles className="h-5 w-5 text-emerald-500" />
              <h1 className="text-2xl font-bold text-foreground">Emerging long-tail</h1>
            </div>
            <p className="text-muted-foreground text-sm max-w-2xl">
              Low-volume entities that show a statistically meaningful jump
              vs their prior-year (or prior 30-day) baseline. Ranked by
              Bayesian posterior probability that the rate at least doubled.
              Posterior threshold: {Math.round((data?.minPosterior ?? 0.9) * 100)}%.
              Minimum current mentions: {data?.minMentions ?? 5}.
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Last evaluated: {lastRunAt}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => runMutation.mutate()}
            disabled={runMutation.isPending}
            className="gap-1.5"
          >
            {runMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Re-evaluate now
          </Button>
        </div>

        {/* Facets. Country is NOT here on purpose: the long-tail lane groups by
            entity only and sums across geographies, so the data carries no
            country to filter on. Adding a dropdown over data that cannot
            support it would be a filter that silently lies. */}
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="h-8 w-[190px] text-xs">
              <SelectValue placeholder="All kinds" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL} className="text-xs">All kinds</SelectItem>
              {entityTypes.map((t) => (
                <SelectItem key={t} value={t} className="text-xs">{t}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={searchFilter} onValueChange={setSearchFilter}>
            <SelectTrigger className="h-8 w-[260px] text-xs">
              <SelectValue placeholder="All search terms" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL} className="text-xs">All search terms</SelectItem>
              {searchTerms.map((t) => (
                <SelectItem key={t} value={t} className="text-xs">{t}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground ml-auto tabular-nums">
            {candidates.length} of {(data?.candidates ?? []).length}
          </span>
        </div>

        {candidates.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-16 text-center">
            <TrendingUp className="h-12 w-12 mx-auto mb-4 text-muted-foreground opacity-30" />
            <p className="text-sm font-medium text-muted-foreground">
              No long-tail candidates yet
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Either no entity has cleared the posterior threshold, or the lane
              hasn't been evaluated. Click "Re-evaluate now" to run it.
            </p>
          </div>
        ) : (
          <div className="rounded-xl border border-border overflow-hidden">
            <div className="grid grid-cols-[2fr_84px_84px_84px_84px_130px_130px] gap-3 px-5 py-2.5 bg-muted/30 border-b border-border text-xs font-medium text-muted-foreground uppercase tracking-wide">
              <div>Entity</div>
              <div className="text-right">
                <SortHeader label="Window" field="current" current={sortBy} dir={sortDir} onSort={handleSort} />
              </div>
              <div className="text-right">
                <SortHeader label="Total" field="total" current={sortBy} dir={sortDir} onSort={handleSort} />
              </div>
              <div className="text-right">
                <SortHeader label="Uplift" field="uplift" current={sortBy} dir={sortDir} onSort={handleSort} />
              </div>
              <div className="text-right">
                <SortHeader label="Posterior" field="posterior" current={sortBy} dir={sortDir} onSort={handleSort} />
              </div>
              <div>Trend (30d)</div>
              <div className="text-right">Action</div>
            </div>
            <div className="divide-y divide-border">
              {candidates.map((c) => (
                <div
                  key={c.id}
                  className="grid grid-cols-[2fr_84px_84px_84px_84px_130px_130px] gap-3 px-5 py-3.5 items-center hover:bg-muted/30"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-foreground leading-tight truncate">
                      {c.canonicalLabel}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {c.entityType ?? "uncategorised"}
                      {c.aliases.length > 0 && (
                        <span className="ml-1.5">· aka {c.aliases.slice(0, 2).join(", ")}</span>
                      )}
                      {c.searchTerm ? (
                        <span className="ml-1.5">· {c.searchTerm}</span>
                      ) : (
                        <span className="ml-1.5 text-purple-600 dark:text-purple-400">
                          · discovered
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="text-right text-sm tabular-nums">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="cursor-help">{c.currentMentions}</span>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">
                        {c.currentMentions} mentions in the scoring window
                        ({c.windowStart} → {c.windowEnd}). This lane only admits
                        entities inside a narrow band, so this number barely varies.
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  {/* All-time volume. Without it every row looks the same size,
                      because the lane selects on the window count: pesto at 39
                      all-time and mandioca at 12 both show 9 here. */}
                  <div className="text-right text-sm tabular-nums font-medium">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="cursor-help">{c.totalMentions}</span>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs max-w-[260px]">
                        {c.totalMentions} mentions all time, across every platform and
                        geography. Tells you whether this is genuinely small or a
                        bigger thing having a quiet month.
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  <div className="text-right text-sm tabular-nums font-medium">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span>{c.upliftScore.toFixed(1)}×</span>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs max-w-[260px]">
                        {c.currentMentions} now vs {c.baselineMentions} baseline (
                        {c.baselineKind === "yoy" ? "same 30d last year" : "prior 30d"}
                        )
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  <div className="flex justify-end">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span>
                          <PosteriorBadge p={c.posteriorProb} />
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs max-w-[280px]">
                        Bayesian posterior that the true rate is at least 2× the
                        baseline rate, under a Beta(1,1) prior on the proportion.
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  <div>
                    <Sparkline values={c.sparkline} />
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => navigate(`/radar/audit/entities?entityId=${c.entityId}`)}
                    >
                      Inspect
                    </Button>
                    <Button
                      variant="default"
                      size="sm"
                      className="h-7 text-xs"
                      disabled={promoteMutation.isPending}
                      onClick={() => promoteMutation.mutate(c.entityId)}
                    >
                      Promote
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
