import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useCompanyId } from "@/hooks/use-company";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
    | "sustained"
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
  discovered?: boolean;
  // The watch topic this trend ladders up to (e.g. "Sauces and dipping in
  // Latin America"), null when no seed term matched it (a genuine discovery)
  // or the matching scout query predates the watch-topic column. Grouped
  // under "Uncategorised" in the UI rather than being hidden — see
  // storage/index.ts getSeedVocabulary / resolveSeedMatch.
  watchTopic?: string | null;
  // The matching scout query's own topicLabel (e.g. "Avocado sauces MX") —
  // the real "search term" facet. NOT the trend's own topicLabel (that field
  // is always identical to `title`, since knowledge_items.topicLabel is set
  // to the entity's canonical label — using it here would render one
  // single-row option per trend instead of grouping by the shared seed
  // query, which is why this is a distinct field). Null under the same
  // conditions as watchTopic.
  searchTerm?: string | null;
}

const UNCATEGORISED = "Uncategorised";
const NO_SEARCH_TERM = "No matching search term";
const ALL = "all";

function watchTopicOf(t: Trend): string {
  return t.watchTopic ?? UNCATEGORISED;
}

// The "search term" facet is keyed on the matched seed's own topicLabel
// (tp_scout_queries.topic_label, e.g. "Avocado sauces MX") — the label the
// client already sees when they configure seeds. A trend with no seed match
// gets the explicit NO_SEARCH_TERM bucket, never its own title: falling back
// to title would put one trend per option and defeat grouping entirely.
function searchTermOf(t: Trend): string {
  return t.searchTerm ?? NO_SEARCH_TERM;
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
  youtube: { label: "YT", className: "bg-red-600 text-white border-0" },
  x: { label: "X", className: "bg-black text-white border-0" },
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

async function fetchTrends(companyId: number, sortBy: SortKey, sortDir: "asc" | "desc"): Promise<Trend[]> {
  const res = await fetch(
    `/api/pipeline/companies/${companyId}/trends?sortBy=${sortBy}&sortDir=${sortDir}`
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
  const companyId = useCompanyId();
  const [sortBy, setSortBy] = useState<SortKey>("signal");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const { data: trends = [], isLoading, error } = useQuery({
    queryKey: ["trends", companyId, sortBy, sortDir],
    queryFn: () => fetchTrends(companyId, sortBy, sortDir),
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

  return (
    <TooltipProvider delayDuration={150}>
      <div className="p-8 max-w-6xl mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-foreground mb-1">Trends</h1>
          <p className="text-muted-foreground text-sm">
            Browse all detected trends across platforms and geographies.
          </p>
        </div>
        <Tabs defaultValue="single">
          <TabsList>
            <TabsTrigger value="single">Single-entity</TabsTrigger>
            <TabsTrigger value="composite">Composite</TabsTrigger>
          </TabsList>
          <TabsContent value="single" className="mt-4">
            <SingleEntityTab
              trends={trends}
              isLoading={isLoading}
              error={error}
              sortBy={sortBy}
              sortDir={sortDir}
              onSort={handleSort}
              navigate={navigate}
            />
          </TabsContent>
          <TabsContent value="composite" className="mt-4">
            <CompositeTrendsTab />
          </TabsContent>
        </Tabs>
      </div>
    </TooltipProvider>
  );
}

interface SingleEntityTabProps {
  trends: Trend[];
  isLoading: boolean;
  error: unknown;
  sortBy: SortKey;
  sortDir: "asc" | "desc";
  onSort: (k: SortKey) => void;
  navigate: (to: string) => void;
}

function SingleEntityTab({
  trends,
  isLoading,
  error,
  sortBy,
  sortDir,
  onSort: handleSort,
  navigate,
}: SingleEntityTabProps) {
  const [watchTopicFilter, setWatchTopicFilter] = useState(ALL);
  const [searchTermFilter, setSearchTermFilter] = useState(ALL);

  const watchTopicOptions = useMemo(() => {
    const set = new Set(trends.map(watchTopicOf));
    // Uncategorised sorts last, real topics sort alphabetically ahead of it.
    return Array.from(set).sort((a, b) => {
      if (a === UNCATEGORISED) return 1;
      if (b === UNCATEGORISED) return -1;
      return a.localeCompare(b);
    });
  }, [trends]);

  const byWatchTopic = useMemo(
    () =>
      watchTopicFilter === ALL
        ? trends
        : trends.filter((t) => watchTopicOf(t) === watchTopicFilter),
    [trends, watchTopicFilter]
  );

  const searchTermOptions = useMemo(() => {
    const set = new Set(byWatchTopic.map(searchTermOf));
    // NO_SEARCH_TERM sorts last, same convention as UNCATEGORISED above.
    return Array.from(set).sort((a, b) => {
      if (a === NO_SEARCH_TERM) return 1;
      if (b === NO_SEARCH_TERM) return -1;
      return a.localeCompare(b);
    });
  }, [byWatchTopic]);

  const handleWatchTopicChange = (v: string) => {
    setWatchTopicFilter(v);
    // Options for the search-term select depend on the chosen watch topic —
    // a stale selection from the previous topic would silently over-filter.
    setSearchTermFilter(ALL);
  };

  const rows = useMemo(
    () =>
      searchTermFilter === ALL
        ? byWatchTopic
        : byWatchTopic.filter((t) => searchTermOf(t) === searchTermFilter),
    [byWatchTopic, searchTermFilter]
  );

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <Skeleton key={i} className="h-16 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>
          {error instanceof Error ? error.message : "Failed to load trends."}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <>
      {trends.length > 0 && (
        <div className="mb-3 flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <Select value={watchTopicFilter} onValueChange={handleWatchTopicChange}>
              <SelectTrigger className="h-8 w-56 text-xs">
                <SelectValue placeholder="Watch topic" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL} className="text-xs">
                  All watch topics
                </SelectItem>
                {watchTopicOptions.map((topic) => (
                  <SelectItem key={topic} value={topic} className="text-xs">
                    {topic}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={searchTermFilter} onValueChange={setSearchTermFilter}>
              <SelectTrigger className="h-8 w-56 text-xs">
                <SelectValue placeholder="Search term" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL} className="text-xs">
                  All search terms
                </SelectItem>
                {searchTermOptions.map((term) => (
                  <SelectItem key={term} value={term} className="text-xs">
                    {term}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Badge variant="outline">
            {rows.length} of {trends.length} trends
          </Badge>
        </div>
      )}
      {trends.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-16 text-center">
            <TrendingUp className="h-12 w-12 mx-auto mb-4 text-muted-foreground opacity-30" />
            <p className="text-sm font-medium text-muted-foreground">No trends detected yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              Run scrapers and let the pipeline process evidence to surface trends.
            </p>
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-16 text-center">
            <TrendingUp className="h-12 w-12 mx-auto mb-4 text-muted-foreground opacity-30" />
            <p className="text-sm font-medium text-muted-foreground">
              No trends match the selected filters
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Try a different watch topic or search term.
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
                  label="Evidence (30d)"
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
              {rows.map((trend) => {
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
                        {trend.discovered && (
                          <span
                            title="No keyword we searched for matches this — extraction surfaced it from real posts"
                            className="ml-2 rounded-full bg-violet-100 dark:bg-violet-900/40 px-2 py-0.5 text-xs font-medium text-violet-700 dark:text-violet-300"
                          >
                            Discovered
                          </span>
                        )}
                      </div>
                      {(() => {
                        const geo = trend.geography === "Global" ? null : trend.geography;
                        const meta = [geo, trend.territoryTag].filter(Boolean).join(" · ");
                        return meta ? (
                          <div className="text-xs text-muted-foreground mt-0.5">{meta}</div>
                        ) : null;
                      })()}
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
                        insufficientNote="Not enough history for MoM — need at least 30 days of activity in the 60-day comparison window."
                      />
                    </div>

                    {/* YoY */}
                    <div onClick={(e) => e.stopPropagation()}>
                      <GrowthCell
                        pct={trend.yoyGrowthPct}
                        current={trend.yoyCurrent}
                        prior={trend.yoyPrior}
                        windowLabel="Last 90 days vs same 90 days last year"
                        insufficientNote="No mentions in the same 90-day window one year ago — no YoY baseline."
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
    </>
  );
}

// ---------------------------------------------------------------------------
// Composite (co-occurrence) trends tab — Task #3
// ---------------------------------------------------------------------------

interface CompositeCandidate {
  id: number;
  entityAId: number;
  entityBId: number;
  entityALabel: string;
  entityBLabel: string;
  entityAType: string | null;
  entityBType: string | null;
  windowStart: string;
  windowEnd: string;
  jointCount: number;
  priorJointCount: number;
  countA: number;
  countB: number;
  totalSignals: number;
  expectedCount: number;
  lift: number;
  sparkline: number[];
  computedAt: string;
}

// Tiny inline sparkline — SVG polyline scaled to its container. Empty or
// all-zero series renders a flat axis line so users see a baseline rather
// than nothing at all.
function Sparkline({ data }: { data: number[] }) {
  const w = 96;
  const h = 28;
  const pad = 2;
  if (!data || data.length === 0) {
    return (
      <svg width={w} height={h} className="text-muted-foreground/40">
        <line
          x1={pad}
          y1={h / 2}
          x2={w - pad}
          y2={h / 2}
          stroke="currentColor"
          strokeWidth={1}
          strokeDasharray="2,2"
        />
      </svg>
    );
  }
  const max = Math.max(1, ...data);
  const step = data.length > 1 ? (w - pad * 2) / (data.length - 1) : 0;
  const points = data
    .map((v, i) => {
      const x = pad + i * step;
      const y = h - pad - (v / max) * (h - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={w} height={h} className="text-foreground">
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

function PriorDelta({
  current,
  prior,
}: {
  current: number;
  prior: number;
}) {
  if (prior === 0) {
    return (
      <span className="text-[10px] text-muted-foreground tabular-nums">
        new
      </span>
    );
  }
  const pct = ((current - prior) / prior) * 100;
  const isPos = pct > 0;
  const isNeg = pct < 0;
  const color = isPos
    ? "text-green-600"
    : isNeg
      ? "text-red-500"
      : "text-muted-foreground";
  return (
    <span className={`text-[10px] tabular-nums ${color}`}>
      {isPos ? "+" : ""}
      {pct.toFixed(0)}% vs prior
    </span>
  );
}

interface CompositeResponse {
  candidates: CompositeCandidate[];
  lastRunAt: string | null;
  minJointMentions: number;
  minLift: number;
  windowDays: number;
}

async function fetchComposite(companyId: number): Promise<CompositeResponse> {
  const res = await fetch(`/api/pipeline/companies/${companyId}/composite-trends`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function CompositeTrendsTab() {
  const companyId = useCompanyId();
  const { data, isLoading, error } = useQuery({
    queryKey: ["composite-trends", companyId],
    queryFn: () => fetchComposite(companyId),
    refetchOnWindowFocus: false,
  });

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-14 w-full rounded-lg" />
        ))}
      </div>
    );
  }
  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>
          {error instanceof Error
            ? error.message
            : "Failed to load composite trends."}
        </AlertDescription>
      </Alert>
    );
  }

  const candidates = data?.candidates ?? [];
  const lastRun = data?.lastRunAt
    ? new Date(data.lastRunAt).toLocaleString()
    : "never";

  return (
    <div>
      <div className="mb-3 flex items-start justify-between text-xs text-muted-foreground">
        <p className="max-w-2xl">
          Entity pairs co-mentioned far more often than chance would predict in
          the last {data?.windowDays ?? 14} days. Joint mentions ≥{" "}
          {data?.minJointMentions ?? 5}, lift ≥{" "}
          {(data?.minLift ?? 2).toFixed(1)}×. Last run: {lastRun}.
        </p>
        {candidates.length > 0 && (
          <Badge variant="outline">{candidates.length} pairs</Badge>
        )}
      </div>
      {candidates.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-16 text-center">
          <p className="text-sm font-medium text-muted-foreground">
            No composite trends yet
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Pairs surface once enough entities co-occur in the rolling window.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-border overflow-hidden">
          <div className="grid grid-cols-[3fr_104px_88px_88px_88px_120px_140px] gap-3 px-5 py-2.5 bg-muted/30 border-b border-border text-xs font-medium text-muted-foreground uppercase tracking-wide">
            <div>Pair</div>
            <div className="text-right">Trend</div>
            <div className="text-right">Joint</div>
            <div className="text-right">Expected</div>
            <div className="text-right">Lift</div>
            <div className="text-right">Per-entity</div>
            <div className="text-right">Window</div>
          </div>
          <div className="divide-y divide-border">
            {candidates.map((c) => (
              <CompositeRow key={c.id} c={c} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CompositeRow({ c }: { c: CompositeCandidate }) {
  const [, navigate] = useLocation();
  const goEntity = (id: number) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Deep-link into the entities audit page; both labels are clickable so
    // users can jump straight to either side of the pair.
    navigate(`/radar/audit/entities?entityId=${id}`);
  };
  return (
    <div className="grid grid-cols-[3fr_104px_88px_88px_88px_120px_140px] gap-3 px-5 py-3 items-center text-sm">
      <div>
        <div className="font-medium leading-tight">
          <button
            type="button"
            onClick={goEntity(c.entityAId)}
            className="text-foreground hover:text-primary hover:underline underline-offset-2"
          >
            {c.entityALabel}
          </button>{" "}
          <span className="text-muted-foreground">×</span>{" "}
          <button
            type="button"
            onClick={goEntity(c.entityBId)}
            className="text-foreground hover:text-primary hover:underline underline-offset-2"
          >
            {c.entityBLabel}
          </button>
        </div>
        {(c.entityAType || c.entityBType) && (
          <div className="text-xs text-muted-foreground mt-0.5">
            {[c.entityAType, c.entityBType].filter(Boolean).join(" · ")}
          </div>
        )}
      </div>
      <div className="flex justify-end">
        <Sparkline data={c.sparkline} />
      </div>
      <div className="text-right">
        <div className="tabular-nums">{c.jointCount}</div>
        <PriorDelta current={c.jointCount} prior={c.priorJointCount} />
      </div>
      <div className="text-right tabular-nums text-muted-foreground">
        {c.expectedCount.toFixed(2)}
      </div>
      <div className="text-right tabular-nums font-medium text-foreground">
        {c.lift.toFixed(1)}×
      </div>
      <div className="text-right tabular-nums text-muted-foreground text-xs">
        {c.countA} / {c.countB}
      </div>
      <div className="text-right text-xs text-muted-foreground">
        {c.windowStart} → {c.windowEnd}
      </div>
    </div>
  );
}
