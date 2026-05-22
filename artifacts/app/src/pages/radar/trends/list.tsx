import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Badge } from "@/components/ui/badge";
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
  ChevronRight,
  ChevronUp,
  Minus,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { SignalScoreInfo } from "./signal-score-info";

interface Trend {
  id: number;
  title: string;
  state:
    | "candidate"
    | "emerging"
    | "confirmed"
    | "peaking"
    | "declining"
    | "dormant"
    | "resurgent";
  signalStrength: number;
  wowGrowthPct?: number;
  momGrowthPct?: number | null;
  yoyGrowthPct?: number | null;
  momCurrent?: number | null;
  momPrior?: number | null;
  yoyCurrent?: number | null;
  yoyPrior?: number | null;
  platforms: string[];
  evidenceCount: number;
  geography?: string;
  territoryTag?: string;
  summary?: string;
}

const STATE_CONFIG: Record<string, { label: string; className: string }> = {
  candidate: { label: "Candidate", className: "bg-gray-500 text-white border-0" },
  emerging: { label: "Emerging", className: "bg-amber-500 text-white border-0" },
  confirmed: { label: "Confirmed", className: "bg-green-500 text-white border-0" },
  peaking: { label: "Peaking", className: "bg-orange-500 text-white border-0" },
  declining: { label: "Declining", className: "bg-blue-500 text-white border-0" },
  dormant: { label: "Dormant", className: "bg-gray-400 text-white border-0" },
  resurgent: { label: "Resurgent", className: "bg-purple-500 text-white border-0" },
};

const PLATFORM_CONFIG: Record<string, { label: string; className: string }> = {
  instagram: { label: "IG", className: "bg-pink-500 text-white border-0" },
  tiktok: { label: "TT", className: "bg-gray-900 text-white border-0" },
  reddit: { label: "RD", className: "bg-orange-500 text-white border-0" },
  xiaohongshu: { label: "XHS", className: "bg-red-500 text-white border-0" },
  google_trends: { label: "GT", className: "bg-blue-500 text-white border-0" },
};

type SortKey =
  | "signal"
  | "wow"
  | "momGrowthPct"
  | "yoyGrowthPct"
  | "evidence";

async function fetchTrends(sortBy: SortKey, sortDir: "asc" | "desc"): Promise<Trend[]> {
  const res = await fetch(
    `/api/pipeline/companies/1/trends?sortBy=${sortBy}&sortDir=${sortDir}`
  );
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function SignalStrengthArc({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value));
  const color =
    pct >= 70 ? "text-green-500" : pct >= 40 ? "text-amber-500" : "text-gray-400";
  return (
    <div className={`flex flex-col items-center ${color}`}>
      <span className="text-lg font-bold tabular-nums leading-none">{pct}</span>
      <span className="text-[10px] text-muted-foreground leading-none mt-0.5">signal</span>
    </div>
  );
}

function GrowthPill({
  pct,
  size = "sm",
}: {
  pct?: number | null;
  size?: "sm" | "xs";
}) {
  const fontSz = size === "xs" ? "text-xs" : "text-sm";
  const iconSz = size === "xs" ? "h-3 w-3" : "h-3.5 w-3.5";
  if (pct == null) {
    return <span className={`text-muted-foreground ${fontSz}`}>—</span>;
  }
  const isPos = pct > 0;
  const isNeg = pct < 0;
  return (
    <div
      className={`inline-flex items-center gap-0.5 font-medium tabular-nums ${fontSz} ${
        isPos ? "text-green-600" : isNeg ? "text-red-500" : "text-muted-foreground"
      }`}
    >
      {isPos ? (
        <TrendingUp className={iconSz} />
      ) : isNeg ? (
        <TrendingDown className={iconSz} />
      ) : (
        <Minus className={iconSz} />
      )}
      {isPos ? "+" : ""}
      {pct.toFixed(1)}%
    </div>
  );
}

function SortHeader({
  label,
  field,
  current,
  dir,
  onSort,
  align = "right",
  extra,
}: {
  label: string;
  field: SortKey;
  current: SortKey;
  dir: "asc" | "desc";
  onSort: (k: SortKey) => void;
  align?: "left" | "right" | "center";
  extra?: React.ReactNode;
}) {
  const active = current === field;
  const justify =
    align === "right" ? "justify-end" : align === "center" ? "justify-center" : "justify-start";
  return (
    <button
      type="button"
      onClick={() => onSort(field)}
      className={`flex items-center gap-1 ${justify} w-full hover:text-foreground transition-colors`}
    >
      <span>{label}</span>
      {extra}
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

function GrowthCell({
  pct,
  current,
  prior,
  windowLabel,
  insufficientNote,
}: {
  pct?: number | null;
  current?: number | null;
  prior?: number | null;
  windowLabel: string;
  insufficientNote: string;
}) {
  const body = (
    <div className="w-20 flex justify-end">
      <GrowthPill pct={pct} />
    </div>
  );
  const tip =
    pct == null
      ? insufficientNote
      : `${windowLabel}: ${current ?? 0} vs ${prior ?? 0} prior`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{body}</TooltipTrigger>
      <TooltipContent side="top" className="max-w-[260px] text-xs">
        {tip}
      </TooltipContent>
    </Tooltip>
  );
}

export default function TrendsListPage() {
  const [, navigate] = useLocation();
  const [sortBy, setSortBy] = useState<SortKey>("signal");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const { data: trends = [], isLoading, error } = useQuery({
    queryKey: ["trends", sortBy, sortDir],
    queryFn: () => fetchTrends(sortBy, sortDir),
    refetchOnWindowFocus: false,
  });

  const handleSort = (k: SortKey) => {
    if (k === sortBy) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortBy(k);
      setSortDir("desc");
    }
  };

  const tooltipped = useMemo(() => trends, [trends]);

  if (isLoading) {
    return (
      <div className="p-8 max-w-6xl mx-auto">
        <div className="mb-6">
          <Skeleton className="h-7 w-32 mb-2" />
          <Skeleton className="h-4 w-64" />
        </div>
        <div className="space-y-2">
          {[1, 2, 3, 4, 5, 6].map((i) => (
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
            {error instanceof Error ? error.message : "Failed to load trends."}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={150}>
      <div className="p-8 max-w-6xl mx-auto">
        {/* Header */}
        <div className="mb-6 flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground mb-1">Trends</h1>
            <p className="text-muted-foreground text-sm">
              Browse all detected trends across platforms and geographies.
            </p>
          </div>
          {trends.length > 0 && (
            <Badge variant="outline">{trends.length} trends</Badge>
          )}
        </div>

        {trends.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-16 text-center">
            <TrendingUp className="h-12 w-12 mx-auto mb-4 text-muted-foreground opacity-30" />
            <p className="text-sm font-medium text-muted-foreground">No trends detected yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              Run scrapers and let the pipeline process evidence to surface trends.
            </p>
          </div>
        ) : (
          <div className="rounded-xl border border-border overflow-hidden">
            {/* Column headers */}
            <div className="grid grid-cols-[2fr_72px_80px_80px_80px_112px_128px_80px_24px] gap-3 px-5 py-2.5 bg-muted/30 border-b border-border text-xs font-medium text-muted-foreground uppercase tracking-wide">
              <div>Title</div>
              <div className="text-center">
                <SortHeader
                  label="Signal"
                  field="signal"
                  current={sortBy}
                  dir={sortDir}
                  onSort={handleSort}
                  align="center"
                  extra={<SignalScoreInfo align="start" />}
                />
              </div>
              <div className="text-right">
                <SortHeader
                  label="WoW"
                  field="wow"
                  current={sortBy}
                  dir={sortDir}
                  onSort={handleSort}
                />
              </div>
              <div className="text-right">
                <SortHeader
                  label="MoM"
                  field="momGrowthPct"
                  current={sortBy}
                  dir={sortDir}
                  onSort={handleSort}
                />
              </div>
              <div className="text-right">
                <SortHeader
                  label="YoY"
                  field="yoyGrowthPct"
                  current={sortBy}
                  dir={sortDir}
                  onSort={handleSort}
                />
              </div>
              <div>State</div>
              <div>Platforms</div>
              <div className="text-right">
                <SortHeader
                  label="Evidence"
                  field="evidence"
                  current={sortBy}
                  dir={sortDir}
                  onSort={handleSort}
                />
              </div>
              <div></div>
            </div>

            {/* Rows */}
            <div className="divide-y divide-border">
              {tooltipped.map((trend) => {
                const stateCfg =
                  STATE_CONFIG[trend.state] ?? {
                    label: trend.state,
                    className: "bg-gray-500 text-white border-0",
                  };
                return (
                  <div
                    key={trend.id}
                    className="grid grid-cols-[2fr_72px_80px_80px_80px_112px_128px_80px_24px] gap-3 px-5 py-3.5 items-center hover:bg-muted/30 cursor-pointer transition-colors"
                    onClick={() => navigate(`/radar/trends/${trend.id}`)}
                  >
                    {/* Title */}
                    <div>
                      <div className="text-sm font-medium text-foreground leading-tight">
                        {trend.title}
                      </div>
                      {(trend.geography || trend.territoryTag) && (
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {[trend.geography, trend.territoryTag].filter(Boolean).join(" · ")}
                        </div>
                      )}
                    </div>

                    {/* Signal */}
                    <div className="flex justify-center">
                      <SignalStrengthArc value={trend.signalStrength} />
                    </div>

                    {/* WoW */}
                    <div className="flex justify-end">
                      <GrowthPill pct={trend.wowGrowthPct} />
                    </div>

                    {/* MoM */}
                    <div onClick={(e) => e.stopPropagation()}>
                      <GrowthCell
                        pct={trend.momGrowthPct}
                        current={trend.momCurrent}
                        prior={trend.momPrior}
                        windowLabel="Last 30 days vs prior 30 days"
                        insufficientNote="No mentions in the prior 30-day window — not enough history for MoM."
                      />
                    </div>

                    {/* YoY */}
                    <div onClick={(e) => e.stopPropagation()}>
                      <GrowthCell
                        pct={trend.yoyGrowthPct}
                        current={trend.yoyCurrent}
                        prior={trend.yoyPrior}
                        windowLabel="Last 90 days vs same 90 days last year"
                        insufficientNote="No mentions in the same 90-day window one year ago — not enough history for YoY."
                      />
                    </div>

                    {/* State */}
                    <div>
                      <Badge className={`text-xs ${stateCfg.className}`}>{stateCfg.label}</Badge>
                    </div>

                    {/* Platforms */}
                    <div className="flex flex-wrap gap-1">
                      {(trend.platforms ?? []).map((p) => {
                        const pcfg = PLATFORM_CONFIG[p.toLowerCase()] ?? {
                          label: p.slice(0, 3).toUpperCase(),
                          className: "bg-gray-500 text-white border-0",
                        };
                        return (
                          <Badge
                            key={p}
                            className={`text-[10px] font-mono px-1.5 py-0 ${pcfg.className}`}
                          >
                            {pcfg.label}
                          </Badge>
                        );
                      })}
                    </div>

                    {/* Evidence */}
                    <div className="text-right text-sm tabular-nums text-muted-foreground">
                      {trend.evidenceCount ?? 0}
                    </div>

                    {/* Arrow */}
                    <div>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
