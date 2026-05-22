import { useQuery } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertCircle,
  ArrowLeft,
  ExternalLink,
  TrendingUp,
  TrendingDown,
  Minus,
  Globe,
  Tag,
  BarChart2,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { SignalScoreInfo } from "./signal-score-info";
import { TrendTimeseriesChart } from "./trend-timeseries-chart";

interface EvidenceItem {
  id: number;
  title: string;
  source: string;
  url?: string;
  publishedAt?: string;
  engagementScore?: number;
  platform?: string;
  author?: string;
  excerpt?: string;
}

interface TrendDetail {
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
  growthMomPct?: number;
  momGrowthPct?: number | null;
  yoyGrowthPct?: number | null;
  momCurrent?: number | null;
  momPrior?: number | null;
  yoyCurrent?: number | null;
  yoyPrior?: number | null;
  volume7d?: number;
  volume30d?: number;
  platforms: string[];
  evidenceCount: number;
  geography?: string;
  territoryTag?: string;
  summary?: string;
  description?: string;
  evidence?: EvidenceItem[];
  updatedAt?: string;
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

async function fetchTrend(id: string): Promise<TrendDetail> {
  const res = await fetch(`/api/pipeline/companies/1/trends/${id}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function GrowthStatCard({
  pct,
  label,
  tooltip,
}: {
  pct: number | null;
  label: string;
  tooltip: string;
}) {
  const hasValue = pct != null;
  const isPos = hasValue && pct > 0;
  const isNeg = hasValue && pct < 0;
  const color = isPos
    ? "text-green-600"
    : isNeg
    ? "text-red-500"
    : "text-muted-foreground";
  const Icon = isPos ? TrendingUp : isNeg ? TrendingDown : Minus;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Card className="cursor-help">
          <CardContent className="p-4 flex flex-col items-center justify-center gap-1">
            <Icon className={`h-5 w-5 ${color}`} />
            <span className={`text-3xl font-bold tabular-nums ${color}`}>
              {hasValue ? `${isPos ? "+" : ""}${pct.toFixed(1)}%` : "—"}
            </span>
            <span className="text-xs text-muted-foreground">{label}</span>
          </CardContent>
        </Card>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[260px] text-xs">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

function WoWGrowth({ pct }: { pct?: number }) {
  if (pct == null) return null;
  const isPos = pct > 0;
  const isNeg = pct < 0;
  return (
    <div
      className={`flex items-center gap-1 text-sm font-semibold ${
        isPos ? "text-green-600" : isNeg ? "text-red-500" : "text-muted-foreground"
      }`}
    >
      {isPos ? (
        <TrendingUp className="h-4 w-4" />
      ) : isNeg ? (
        <TrendingDown className="h-4 w-4" />
      ) : (
        <Minus className="h-4 w-4" />
      )}
      {isPos ? "+" : ""}
      {pct.toFixed(1)}% WoW
    </div>
  );
}

function formatDate(iso?: string) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatEngagement(n?: number) {
  if (n == null) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

export default function TrendDetailPage() {
  const { trendId } = useParams<{ trendId: string }>();
  const [, navigate] = useLocation();

  const { data: trend, isLoading, error } = useQuery({
    queryKey: ["trend", trendId],
    queryFn: () => fetchTrend(trendId!),
    enabled: !!trendId,
  });

  if (isLoading) {
    return (
      <div className="p-8 max-w-4xl mx-auto">
        <Skeleton className="h-5 w-24 mb-6" />
        <div className="space-y-4">
          <Skeleton className="h-8 w-72" />
          <div className="flex gap-2">
            <Skeleton className="h-6 w-24 rounded-full" />
            <Skeleton className="h-6 w-20 rounded-full" />
          </div>
          <div className="grid grid-cols-3 gap-4 mt-6">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-48 rounded-xl" />
        </div>
      </div>
    );
  }

  if (error || !trend) {
    return (
      <div className="p-8 max-w-4xl mx-auto">
        <Button
          variant="ghost"
          size="sm"
          className="mb-4 gap-2"
          onClick={() => navigate("/radar/trends")}
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Trends
        </Button>
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {error instanceof Error ? error.message : "Trend not found."}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const stateCfg = STATE_CONFIG[trend.state] ?? {
    label: trend.state,
    className: "bg-gray-500 text-white border-0",
  };

  const signalColor =
    trend.signalStrength >= 70
      ? "text-green-500"
      : trend.signalStrength >= 40
      ? "text-amber-500"
      : "text-gray-400";

  return (
    <div className="p-8 max-w-4xl mx-auto">
      {/* Back */}
      <Button
        variant="ghost"
        size="sm"
        className="mb-5 gap-2 -ml-2 text-muted-foreground"
        onClick={() => navigate("/radar/trends")}
      >
        <ArrowLeft className="h-4 w-4" />
        All Trends
      </Button>

      {/* Title + meta */}
      <div className="mb-6">
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-2xl font-bold text-foreground leading-tight">{trend.title}</h1>
          <Badge className={`flex-shrink-0 text-sm px-3 py-1 ${stateCfg.className}`}>
            {stateCfg.label}
          </Badge>
        </div>

        <div className="flex flex-wrap items-center gap-2 mt-3">
          {trend.geography && (
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground border border-border">
              <Globe className="h-3 w-3" />
              {trend.geography}
            </span>
          )}
          {trend.territoryTag && (
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground border border-border">
              <Tag className="h-3 w-3" />
              {trend.territoryTag}
            </span>
          )}
          {(trend.platforms ?? []).map((p) => {
            const pcfg = PLATFORM_CONFIG[p.toLowerCase()] ?? {
              label: p.slice(0, 3).toUpperCase(),
              className: "bg-gray-500 text-white border-0",
            };
            return (
              <Badge key={p} className={`text-xs font-mono ${pcfg.className}`}>
                {pcfg.label}
              </Badge>
            );
          })}
        </div>

        {trend.description && (
          <p className="text-sm text-muted-foreground mt-3 leading-relaxed">{trend.description}</p>
        )}
      </div>

      {/* Stats grid */}
      <TooltipProvider delayDuration={150}>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 mb-6">
          {/* Signal strength */}
          <Card>
            <CardContent className="p-4 flex flex-col items-center justify-center gap-1">
              <BarChart2 className={`h-5 w-5 ${signalColor}`} />
              <span className={`text-3xl font-bold tabular-nums ${signalColor}`}>
                {trend.signalStrength}
              </span>
              <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
                Signal
                <SignalScoreInfo />
              </span>
            </CardContent>
          </Card>

          {/* WoW growth */}
          <GrowthStatCard
            pct={trend.wowGrowthPct ?? null}
            label="WoW"
            tooltip="Week over week — this week vs prior week."
          />

          {/* MoM growth (fixed window) */}
          <GrowthStatCard
            pct={trend.momGrowthPct ?? null}
            label="MoM"
            tooltip={
              trend.momGrowthPct == null
                ? "Not enough history for MoM — need at least 30 days of activity in the 60-day comparison window."
                : `Last 30 days vs prior 30 days: ${trend.momCurrent ?? 0} mentions vs ${trend.momPrior ?? 0}.`
            }
          />

          {/* YoY growth (fixed window) */}
          <GrowthStatCard
            pct={trend.yoyGrowthPct ?? null}
            label="YoY"
            tooltip={
              trend.yoyGrowthPct == null
                ? "No mentions in the same 90-day window one year ago — no YoY baseline."
                : `Last 90 days vs same 90 days last year: ${trend.yoyCurrent ?? 0} mentions vs ${trend.yoyPrior ?? 0}.`
            }
          />

          {/* Volume */}
          <Card>
            <CardContent className="p-4 flex flex-col items-center justify-center gap-1">
              <div className="h-5 w-5 rounded-full bg-primary/20 flex items-center justify-center">
                <span className="text-[10px] font-bold text-primary">V</span>
              </div>
              <span className="text-3xl font-bold tabular-nums text-foreground">
                {trend.volume7d ?? trend.evidenceCount ?? 0}
              </span>
              <span className="text-xs text-muted-foreground">Vol 7d</span>
            </CardContent>
          </Card>
        </div>
      </TooltipProvider>

      {/* Mentions vs search-interest time-series */}
      <TrendTimeseriesChart trendId={trend.id} />


      {/* Evidence cards */}
      {trend.evidence && trend.evidence.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-foreground mb-3">
            Evidence ({trend.evidence.length})
          </h2>
          <div className="space-y-3">
            {trend.evidence.map((ev) => {
              const pcfg = ev.platform
                ? PLATFORM_CONFIG[ev.platform.toLowerCase()]
                : undefined;
              return (
                <Card key={ev.id} className="hover:border-primary/40 transition-colors">
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          {pcfg && (
                            <Badge className={`text-[10px] font-mono px-1.5 py-0 ${pcfg.className}`}>
                              {pcfg.label}
                            </Badge>
                          )}
                          <span className="text-xs text-muted-foreground">{ev.source}</span>
                          {ev.author && (
                            <span className="text-xs text-muted-foreground">· {ev.author}</span>
                          )}
                          {formatDate(ev.publishedAt) && (
                            <span className="text-xs text-muted-foreground">
                              · {formatDate(ev.publishedAt)}
                            </span>
                          )}
                        </div>
                        <h3 className="text-sm font-medium text-foreground leading-tight">
                          {ev.title}
                        </h3>
                        {ev.excerpt && (
                          <p className="text-xs text-muted-foreground mt-1 line-clamp-2 leading-relaxed">
                            {ev.excerpt}
                          </p>
                        )}
                        {ev.engagementScore != null && (
                          <p className="text-xs text-muted-foreground mt-1.5">
                            Engagement:{" "}
                            <span className="font-medium text-foreground">
                              {formatEngagement(ev.engagementScore)}
                            </span>
                          </p>
                        )}
                      </div>
                      {ev.url && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="flex-shrink-0 gap-1.5 text-xs h-8"
                          onClick={() => window.open(ev.url, "_blank", "noopener,noreferrer")}
                        >
                          Open
                          <ExternalLink className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      )}

      {/* Empty evidence state */}
      {(!trend.evidence || trend.evidence.length === 0) && (
        <Card className="p-8 text-center">
          <p className="text-sm text-muted-foreground">No evidence items available yet.</p>
        </Card>
      )}
    </div>
  );
}
