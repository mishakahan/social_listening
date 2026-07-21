import { useMemo, useState } from "react";
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
}

interface LongTailResponse {
  candidates: LongTailRow[];
  lastRunAt: string | null;
  minMentions: number;
  minPosterior: number;
}

type SortKey = "posterior" | "uplift" | "current";

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
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const { data, isLoading, error } = useQuery({
    queryKey: ["long-tail", companyId],
    queryFn: () => fetchLongTail(companyId),
    refetchOnWindowFocus: false,
  });

  const runMutation = useMutation({
    mutationFn: () => runLongTail(companyId),
    onSuccess: () => {
      toast.success("Long-tail re-evaluation complete");
      queryClient.invalidateQueries({ queryKey: ["long-tail", companyId] });
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
        case "posterior":
        default:
          av = a.posteriorProb;
          bv = b.posteriorProb;
          break;
      }
      return (av - bv) * mul;
    });
  }, [data, sortBy, sortDir]);

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

  const candidates = sorted;
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
            <div className="grid grid-cols-[2fr_96px_96px_96px_140px_140px] gap-3 px-5 py-2.5 bg-muted/30 border-b border-border text-xs font-medium text-muted-foreground uppercase tracking-wide">
              <div>Entity</div>
              <div className="text-right">
                <SortHeader label="Current" field="current" current={sortBy} dir={sortDir} onSort={handleSort} />
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
                  className="grid grid-cols-[2fr_96px_96px_96px_140px_140px] gap-3 px-5 py-3.5 items-center hover:bg-muted/30"
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
                    </div>
                  </div>
                  <div className="text-right text-sm tabular-nums">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span>{c.currentMentions}</span>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">
                        {c.currentMentions} mentions in last 30d ({c.windowStart} → {c.windowEnd})
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
