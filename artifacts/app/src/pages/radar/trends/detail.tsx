import { useQuery } from "@tanstack/react-query";
import { usePublishBreadcrumbTitle } from "@/hooks/use-breadcrumb-title";
import { useParams, useLocation } from "wouter";
import { useCompanyId } from "@/hooks/use-company";
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
  Check,
  X,
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
  engagementLikes?: number | null;
  engagementViews?: number | null;
  engagementComments?: number | null;
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
    | "sustained"
    | "peaking"
    | "declining"
    | "dormant"
    | "resurgent";
  signalStrength: number;
  wowGrowthPct?: number;
  growthMomPct?: number;
  momGrowthPct?: number | null;
  /** Share-of-voice growth — see services/share-of-voice.ts on the server. */
  sovGrowthPct?: number | null;
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
  evidenceRecentCount?: number;
  evidenceWindowDays?: number;
  evidenceTotalCount?: number;
  discovered?: boolean;
  watchTopic?: string | null;
  searchTerm?: string | null;
  updatedAt?: string;
  confirmationVerdict?: {
    decision: "pass" | "hold";
    reasons: string[];
    significanceP: number;
    entropyBits: number;
    evaluatedAt: string;
  } | null;
  specificityVerdict?: {
    specific: boolean;
    reason: string;
    label: string;
    judgedAt: string;
  } | null;
}

const STATE_CONFIG: Record<string, { label: string; className: string }> = {
  candidate: { label: "Candidate", className: "bg-gray-500 text-white border-0" },
  emerging: { label: "Emerging", className: "bg-amber-500 text-white border-0" },
  sustained: { label: "Sustained", className: "bg-green-500 text-white border-0" },
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

async function fetchTrend(companyId: number, id: string): Promise<TrendDetail> {
  const res = await fetch(`/api/pipeline/companies/${companyId}/trends/${id}`);
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


function formatDate(iso?: string) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatCount(n?: number | null) {
  if (n == null) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

// Raw platform metrics people intuitively recognise, in preference order.
// Falls back to the composite signal score only if no raw metric is present.
function evidenceMetrics(ev: {
  engagementViews?: number | null;
  engagementLikes?: number | null;
  engagementComments?: number | null;
  engagementScore?: number;
}): { label: string; value: string }[] {
  const parts: { label: string; value: string }[] = [];
  if (ev.engagementViews) parts.push({ label: "views", value: formatCount(ev.engagementViews)! });
  if (ev.engagementLikes) parts.push({ label: "likes", value: formatCount(ev.engagementLikes)! });
  if (ev.engagementComments) parts.push({ label: "comments", value: formatCount(ev.engagementComments)! });
  if (parts.length === 0 && ev.engagementScore)
    parts.push({ label: "signal", value: formatCount(ev.engagementScore)! });
  return parts;
}

// One gate-check chip: green tick if it passed, red cross if it didn't.
function VerdictChip({
  pass,
  label,
  detail,
  title,
}: {
  pass: boolean;
  label: string;
  detail: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs border ${
        pass
          ? "bg-green-500/10 text-green-700 dark:text-green-300 border-green-500/30"
          : "bg-red-500/10 text-red-700 dark:text-red-300 border-red-500/30"
      }`}
    >
      {pass ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
      <span className="font-medium">{label}</span>
      <span className="opacity-70">{detail}</span>
    </span>
  );
}

// Renders the "why confirmed / why held" chip row from the stored gate verdict.
// Significance passes below alpha=0.05; breadth passes at >=1.0 bits (the gate's
// own thresholds). Specificity comes from the cached LLM judgment.
function VerdictChips({
  verdict,
  specificity,
}: {
  verdict?: TrendDetail["confirmationVerdict"];
  specificity?: TrendDetail["specificityVerdict"];
}) {
  if (!verdict && !specificity) return null;
  const held = verdict?.decision === "hold";
  return (
    <div className="mt-3">
      <div className="text-xs font-medium text-muted-foreground mb-1.5">
        {held ? "Why it was held" : "Why it passed the gate"}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {verdict && (
          <>
            <VerdictChip
              pass={verdict.significanceP <= 0.05}
              label="Rising"
              detail={`p=${verdict.significanceP.toFixed(3)}`}
              title="Beats the entity's own historical noise (permutation test)."
            />
            <VerdictChip
              pass={verdict.entropyBits >= 1.0}
              label="Broad"
              detail={`${verdict.entropyBits.toFixed(2)} bits`}
              title="Author diversity across platforms (Shannon entropy)."
            />
          </>
        )}
        {specificity && (
          <VerdictChip
            pass={specificity.specific}
            label="Specific"
            detail={specificity.specific ? "trackable" : "generic"}
            title={specificity.reason}
          />
        )}
      </div>
    </div>
  );
}

export default function TrendDetailPage() {
  const { trendId } = useParams<{ trendId: string }>();
  const [, navigate] = useLocation();
  const companyId = useCompanyId();

  const { data: trend, isLoading, error } = useQuery({
    queryKey: ["trend", companyId, trendId],
    queryFn: () => fetchTrend(companyId, trendId!),
    enabled: !!trendId,
  });

  // Otherwise the breadcrumb shows the row id ("Radar > Trends > 61"). Called
  // before the early returns below so the hook order stays stable across the
  // loading, error and loaded renders.
  usePublishBreadcrumbTitle(trend?.title);

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
          <h1 className="text-2xl font-bold text-foreground leading-tight">
            {trend.title}
            {trend.discovered && (
              <span
                title="No keyword we searched for matches this — extraction surfaced it from real posts"
                className="ml-2 align-middle rounded-full bg-violet-100 dark:bg-violet-900/40 px-2 py-0.5 text-xs font-medium text-violet-700 dark:text-violet-300"
              >
                Discovered
              </span>
            )}
          </h1>
          <Badge className={`flex-shrink-0 text-sm px-3 py-1 ${stateCfg.className}`}>
            {stateCfg.label}
          </Badge>
        </div>

        <div className="flex flex-wrap items-center gap-2 mt-3">
          {trend.geography && trend.geography !== "Global" && (
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
          {trend.watchTopic && (
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground border border-border">
              Watch topic: {trend.watchTopic}
            </span>
          )}
          {trend.searchTerm && (
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground border border-border">
              Search term: {trend.searchTerm}
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

        <VerdictChips
          verdict={trend.confirmationVerdict}
          specificity={trend.specificityVerdict}
        />

        {trend.description && (
          <p className="text-sm text-muted-foreground mt-3 leading-relaxed">{trend.description}</p>
        )}
      </div>

      {/* Stats grid */}
      <TooltipProvider delayDuration={150}>
        <div className="grid grid-cols-3 gap-4 mb-6">
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

          {/* Movement — share of conversation.
              WoW, MoM and YoY tiles used to sit here. They are raw mention
              counts, inflated by how much we happened to scrape: this page was
              showing maionese at +340.7% MoM and +16700% YoY while its share
              of conversation grew 34.5%. Removed rather than kept alongside,
              because two growth numbers that disagree on the same screen
              invite exactly the question we cannot answer well. */}
          <GrowthStatCard
            pct={trend.sovGrowthPct ?? null}
            label="Movement"
            tooltip={
              trend.sovGrowthPct == null
                ? "No movement score: this needs at least 3 mentions on each of 2 or more platforms during the EARLIER comparison window, and it does not have that. Note this is stricter than the platform badges above, which list every platform the trend has appeared on at all in the last 90 days — one stray post is enough to earn a badge, but not enough to compare against."
                : "Growth in this trend's share of all conversation, last 60 days vs the 60 before, measured within each platform and corroborated across 2+ of them."
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
            Evidence
            <span className="ml-2 font-normal text-muted-foreground">
              {trend.evidenceRecentCount ?? trend.evidence.length} in the last{" "}
              {trend.evidenceWindowDays ?? 30} days
              {trend.evidenceTotalCount != null &&
                trend.evidenceTotalCount > trend.evidence.length &&
                `, showing ${trend.evidence.length} of ${trend.evidenceTotalCount} all time`}
            </span>
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
                        {(() => {
                          const metrics = evidenceMetrics(ev);
                          if (metrics.length === 0) return null;
                          return (
                            <p className="text-xs text-muted-foreground mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
                              {metrics.map((m) => (
                                <span key={m.label}>
                                  <span className="font-medium text-foreground">{m.value}</span>{" "}
                                  {m.label}
                                </span>
                              ))}
                            </p>
                          );
                        })()}
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
