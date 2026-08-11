import { useMemo, useState, Fragment } from "react";
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
  /**
   * Growth in this item's SHARE of conversation, measured within each
   * platform and corroborated across 2+ of them. Null when there is not
   * enough cross-platform history to make the claim honestly. Prefer this
   * over momGrowthPct: raw mention growth is inflated by how much we happened
   * to scrape (see services/share-of-voice.ts on the server).
   */
  sovGrowthPct?: number | null;
  /** ingredient / brand / format / dietary_claim / occasion / flavour / ... */
  entityType?: string;
  momCurrent?: number | null;
  momPrior?: number | null;
  yoyCurrent?: number | null;
  yoyPrior?: number | null;
  platforms: string[];
  evidenceCount: number;
  /** Precomputed mention counts per window (7/30/90). See storage EVIDENCE_WINDOWS. */
  evidenceByWindow?: Record<string, number>;
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
  | "evidence"
  | "sov";

// Windows the Evidence column can show. These mirror storage's EVIDENCE_WINDOWS
// exactly — every one is a value the state machine precomputes, so switching
// window shows a genuinely different number rather than a relabelled one.
const EVIDENCE_WINDOWS = [7, 30, 90] as const;
type EvidenceWindow = (typeof EVIDENCE_WINDOWS)[number];

async function fetchTrends(
  companyId: number,
  sortBy: SortKey,
  sortDir: "asc" | "desc",
  evidenceWindow: EvidenceWindow
): Promise<Trend[]> {
  const res = await fetch(
    `/api/pipeline/companies/${companyId}/trends?sortBy=${sortBy}&sortDir=${sortDir}&evidenceWindow=${evidenceWindow}`
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
  // Only append the "X vs Y prior" counts when we actually have them.
  // Share-of-voice has no single pair of counts behind it (it is a median of
  // per-platform shares), and defaulting them to 0 rendered a confident
  // "0 vs 0 prior" under every Movement value — a number that was not just
  // missing but wrong.
  const hasCounts = current != null && prior != null;
  const tip =
    pct == null
      ? insufficientNote
      : hasCounts
        ? `${windowLabel}: ${current} vs ${prior} prior`
        : windowLabel;
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
  // Default to movement, not volume. Sorting by signal strength led with the
  // largest items regardless of direction — guacamole and mango sat 4th and
  // 5th while their share of conversation was actually falling. Movement puts
  // what is genuinely gaining ground first, which is what a trend radar is
  // for, and it demotes ubiquitous staples on their own merit.
  const [sortBy, setSortBy] = useState<SortKey>("sov");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  // 30 stays the default so the list opens on exactly the number it showed
  // before, and keeps agreeing with the trend-detail page.
  const [evidenceWindow, setEvidenceWindow] = useState<EvidenceWindow>(30);

  const { data: trends = [], isLoading, error } = useQuery({
    // The window is in the key: the server sorts by it, so a stale cache entry
    // would show one window's numbers in another window's order.
    queryKey: ["trends", companyId, sortBy, sortDir, evidenceWindow],
    queryFn: () => fetchTrends(companyId, sortBy, sortDir, evidenceWindow),
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
          {/* PAGE-LEVEL DEFINITION. The client's words: "I do need this type of
              stuff clearly defined." The distinction that matters is this page
              versus Emerging, and it was only ever explained in conversation:
              this page is things that are already established, Emerging is
              things that are still small. Both pages state the contrast, so
              whichever you land on first tells you what the other is for. */}
          <p className="text-muted-foreground text-sm max-w-3xl">
            Things being talked about at enough volume, across enough different
            platforms and people, to be worth acting on. Everything here has
            cleared four checks: it is growing, it has real volume, the
            conversation is spread across more than one platform, and it is
            specific enough to be a thing rather than a category.
          </p>
          <p className="text-muted-foreground text-sm max-w-3xl mt-2">
            These are established, not early. Something big and steady sits near
            the top because it is <span className="font-medium text-foreground">big</span>,
            not because it just moved. For small things moving unusually fast,
            which is the opposite question, see{" "}
            <button
              type="button"
              onClick={() => navigate("/radar/emerging")}
              className="text-primary hover:underline underline-offset-2 font-medium"
            >
              Emerging
            </button>
            .
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
              evidenceWindow={evidenceWindow}
              onEvidenceWindowChange={setEvidenceWindow}
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
  evidenceWindow: EvidenceWindow;
  onEvidenceWindowChange: (w: EvidenceWindow) => void;
  navigate: (to: string) => void;
}

function SingleEntityTab({
  trends,
  isLoading,
  error,
  sortBy,
  sortDir,
  onSort: handleSort,
  evidenceWindow,
  onEvidenceWindowChange,
  navigate,
}: SingleEntityTabProps) {
  const [watchTopicFilter, setWatchTopicFilter] = useState(ALL);
  // Kind-of-thing filter. Jonathan's standing note is that the radar surfaces
  // items too generic to be interesting; entities already carry a type, so
  // this lets him choose what counts as interesting rather than us guessing a
  // threshold on his behalf. Client-side because the list is already loaded.
  const [entityTypeFilter, setEntityTypeFilter] = useState(ALL);
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

  const entityTypeOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of trends) {
      const ty = t.entityType ?? "other";
      counts.set(ty, (counts.get(ty) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [trends]);

  const rows = useMemo(() => {
    const bySearchTerm =
      searchTermFilter === ALL
        ? byWatchTopic
        : byWatchTopic.filter((t) => searchTermOf(t) === searchTermFilter);
    return entityTypeFilter === ALL
      ? bySearchTerm
      : bySearchTerm.filter((t) => (t.entityType ?? "other") === entityTypeFilter);
  }, [byWatchTopic, searchTermFilter, entityTypeFilter]);

  // Split scored from unscored. Roughly two thirds of the radar has no
  // corroborated cross-platform movement yet, and mixing those into the main
  // list left most rows with a blank where a number should be — which reads
  // as broken even though it is the honest answer. They are real detections
  // with real evidence, they just cannot carry a growth CLAIM, so they get
  // their own section rather than a gap.
  const scored = useMemo(() => rows.filter((t) => t.sovGrowthPct != null), [rows]);
  const unscored = useMemo(() => rows.filter((t) => t.sovGrowthPct == null), [rows]);

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

            <Select value={entityTypeFilter} onValueChange={setEntityTypeFilter}>
              <SelectTrigger className="h-8 w-48 text-xs">
                <SelectValue placeholder="Kind of thing" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL} className="text-xs">
                  All kinds
                </SelectItem>
                {entityTypeOptions.map(([ty, n]) => (
                  <SelectItem key={ty} value={ty} className="text-xs">
                    {ty.replace(/_/g, " ")} ({n})
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
            <div className="grid grid-cols-[2fr_72px_88px_112px_128px_88px_24px] gap-3 px-5 py-2.5 bg-muted/30 border-b border-border text-xs font-medium text-muted-foreground uppercase tracking-wide">
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
                  label="Movement"
                  field="sov"
                  current={sortBy}
                  dir={sortDir}
                  onSort={handleSort}
                />
              </div>

              <div>State</div>
              <div>Platforms</div>
              {/* Evidence header + window picker. The label no longer hardcodes
                  30d because the window is now a real choice: 7/30/90 are all
                  precomputed by the state machine, and the server sorts by
                  whichever is selected. */}
              <div className="flex items-center justify-end gap-1">
                <SortHeader
                  label="Evidence"
                  field="evidence"
                  current={sortBy}
                  dir={sortDir}
                  onSort={handleSort}
                />
                <Select
                  value={String(evidenceWindow)}
                  onValueChange={(v) => onEvidenceWindowChange(Number(v) as EvidenceWindow)}
                >
                  <SelectTrigger
                    className="h-6 w-[68px] text-xs px-2 py-0"
                    aria-label="Evidence window"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EVIDENCE_WINDOWS.map((w) => (
                      <SelectItem key={w} value={String(w)} className="text-xs">
                        {w}d
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div></div>
            </div>

            {/* Rows. Scored first, then a divider, then the ones we cannot
                score yet — see the `scored`/`unscored` split above. */}
            <div className="divide-y divide-border">
              {[...scored, ...unscored].map((trend, rowIndex) => {
                const stateCfg =
                  STATE_CONFIG[trend.state] ?? {
                    label: trend.state,
                    className: "bg-gray-500 text-white border-0",
                  };
                const startsWatchlist =
                  rowIndex === scored.length && unscored.length > 0;
                return (
                  <Fragment key={`row-${trend.id}`}>
                  {startsWatchlist && (
                    <div className="px-5 py-2.5 bg-muted/20 border-t border-border">
                      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                        Watching · {unscored.length}
                      </div>
                      {/* Name the actual column. This section and the dash in
                          Movement are the same fact (sovGrowthPct == null);
                          calling it "a growth number" here was vocabulary left
                          over from before WoW/MoM/YoY became Movement, and made
                          the dash look like a separate missing value. */}
                      <div className="text-xs text-muted-foreground mt-0.5">
                        Detected and evidenced, but their conversation has not
                        moved measurably on two or more platforms yet. That is
                        why Movement is blank: one platform on its own is not
                        enough to stand behind a number.
                      </div>
                    </div>
                  )}
                  <div
                    className="grid grid-cols-[2fr_72px_88px_112px_128px_88px_24px] gap-3 px-5 py-3.5 items-center hover:bg-muted/30 cursor-pointer transition-colors"
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

                    {/* Movement — share of conversation, not raw mentions */}
                    <div onClick={(e) => e.stopPropagation()}>
                      <GrowthCell
                        pct={trend.sovGrowthPct}
                        current={null}
                        prior={null}
                        windowLabel="Share of conversation, last 60 days vs the 60 before"
                        insufficientNote="No movement score: this needs at least 3 mentions on each of 2 or more platforms during the EARLIER comparison window, and it does not have that. Stricter than the Platforms column, which shows every platform the trend appeared on at all in the last 90 days — a single post earns a badge but is not enough to measure change against."
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
                      {trend.evidenceByWindow?.[String(evidenceWindow)] ??
                        trend.evidenceCount ??
                        0}
                    </div>

                    {/* Arrow */}
                    <div>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </div>
                  </div>
                  </Fragment>
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
// Rendered with an explicit accent colour and a soft fill. It previously
// inherited whatever colour it landed in, so the "Trend" column read as grey
// noise next to the numbers.
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
    <svg width={w} height={h} className="text-primary">
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
  const [page, setPage] = useState(0);
  const { data, isLoading, error } = useQuery({
    queryKey: ["composite-trends", companyId],
    queryFn: () => fetchComposite(companyId),
    refetchOnWindowFocus: false,
  });

  // Sorted so TRUSTWORTHY pairs lead. The server sorts by raw lift, which puts
  // the tiny-denominator artifacts on top: every pair on the first page scored
  // >100x purely because chance predicted ~0.01 joint mentions. Measured on
  // this data, only 13 of 105 pairs have expected >= 1, and the strongest real
  // finding (aguacate x michoacan: 35 joint, lift 30x, 251/42 per-entity) sat
  // below dozens of 5-mention artifacts. Reliable first, then lift within each
  // group — same principle as leading the radar with Movement rather than a
  // fabricated growth number.
  const candidates = useMemo(() => {
    const list = data?.candidates ?? [];
    return [...list].sort((a, b) => {
      const aOk = a.expectedCount >= LIFT_RELIABLE_MIN_EXPECTED ? 1 : 0;
      const bOk = b.expectedCount >= LIFT_RELIABLE_MIN_EXPECTED ? 1 : 0;
      if (aOk !== bOk) return bOk - aOk;
      return b.lift - a.lift;
    });
  }, [data]);

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

  // Same 50/page treatment as the runs and entities tables. 105 pairs today,
  // but this grows with the corpus and the whole list was rendering at once.
  const COMPOSITE_PAGE_SIZE = 50;
  const pageCount = Math.max(1, Math.ceil(candidates.length / COMPOSITE_PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pagedCandidates = candidates.slice(
    safePage * COMPOSITE_PAGE_SIZE,
    safePage * COMPOSITE_PAGE_SIZE + COMPOSITE_PAGE_SIZE
  );
  const lastRun = data?.lastRunAt
    ? new Date(data.lastRunAt).toLocaleString()
    : "never";

  return (
    <div>
      <div className="mb-3 flex items-start justify-between text-xs text-muted-foreground">
        <p className="max-w-2xl">
          Entity pairs mentioned together in the same post far more often than
          chance would predict, over the last {data?.windowDays ?? 14} days.
          Showing pairs with at least {data?.minJointMentions ?? 5} joint
          mentions and lift ≥ {(data?.minLift ?? 2).toFixed(1)}×. Hover any
          column heading for what it means. Greyed-out lift means the pair is
          too rare for the ratio to be trustworthy — judge those on Joint and
          Per-entity. Last run: {lastRun}.
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
            <CompositeHeader label="Trend" tip="Daily joint mentions of the two together across the window. Flat means a steady association, a spike means they started being mentioned together recently." />
            <CompositeHeader label="Joint" tip="How many separate posts mentioned BOTH of these in the window. This is the raw count everything else is derived from." />
            <CompositeHeader label="Expected" tip="How many joint mentions you would get by chance alone, if the two were unrelated: (times A appears x times B appears) / total posts. Below 1 means chance predicts they should essentially never co-occur." />
            <CompositeHeader label="Lift" tip="Joint divided by Expected: how many times more often they appear together than chance predicts. Reliable when Expected is around 1 or more. When Expected is far below 1 the division blows up and the number stops being meaningful — those rows are greyed out." />
            <CompositeHeader label="Per-entity" tip="How often each one appeared on its own in this window, A / B. Small numbers here mean the pair rests on very little evidence, however large the Lift looks." />
            <CompositeHeader label="Window" tip="The rolling date range this was measured over, set by Window (days) in the Control Panel." />
          </div>
          <div className="divide-y divide-border">
            {pagedCandidates.map((c) => (
              <CompositeRow key={c.id} c={c} />
            ))}
          </div>

          {/* Always rendered so the visible range is stated even on one page. */}
          <div className="flex items-center justify-between px-3 py-2.5 border-t border-border bg-muted/20 text-xs">
            <span className="text-muted-foreground tabular-nums">
              {`${safePage * COMPOSITE_PAGE_SIZE + 1}–${Math.min(
                (safePage + 1) * COMPOSITE_PAGE_SIZE,
                candidates.length
              )} of ${candidates.length.toLocaleString()}`}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={safePage === 0}
                className="px-2 py-1 rounded border border-border disabled:opacity-40 disabled:cursor-not-allowed hover:bg-muted/50 transition-colors"
              >
                Previous
              </button>
              <span className="text-muted-foreground tabular-nums">
                Page {safePage + 1} of {pageCount.toLocaleString()}
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                disabled={safePage >= pageCount - 1}
                className="px-2 py-1 rounded border border-border disabled:opacity-40 disabled:cursor-not-allowed hover:bg-muted/50 transition-colors"
              >
                Next
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function LiftCell({ lift, expected }: { lift: number; expected: number }) {
  const reliable = expected >= LIFT_RELIABLE_MIN_EXPECTED;
  if (!reliable) {
    return (
      <div className="text-right">
        <Tooltip>
          <TooltipTrigger asChild>
            {/* An em dash, not ">100x". The whole point is that lift is not
                measurable for this pair, and any number here — even a hedged
                one — still reads as a magnitude and pulls the eye. Same
                convention the Movement column uses when there is not enough
                evidence to score something. */}
            <span className="tabular-nums text-muted-foreground/70 cursor-help">—</span>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs text-xs">
            Chance predicted only {expected < 0.01 ? "<0.01" : expected.toFixed(2)} joint
            mentions here, so dividing by it produces a huge number from very little
            evidence. Read the Joint and Per-entity counts instead.
          </TooltipContent>
        </Tooltip>
      </div>
    );
  }
  // Genuine, well-supported lift: the higher it is, the stronger the pairing.
  const tone =
    lift >= 10 ? "text-green-600" : lift >= 4 ? "text-emerald-600" : "text-foreground";
  return (
    <div className={`text-right tabular-nums font-semibold ${tone}`}>
      {lift.toFixed(1)}×
    </div>
  );
}

function CompositeHeader({ label, tip }: { label: string; tip: string }) {
  return (
    <div className="text-right">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help underline decoration-dotted decoration-muted-foreground/50 underline-offset-4">
            {label}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs text-xs font-normal normal-case tracking-normal">
          {tip}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

// Lift = joint / expected, and expected = (countA * countB) / totalPosts. When
// both entities are rare, expected falls far below 1 and the division explodes:
// a pair seen 5 times together scored 1490x purely because chance predicted
// ~0.003. That is arithmetic, not evidence. Rows below this threshold are shown
// muted with the reason, rather than presented as the strongest finds.
const LIFT_RELIABLE_MIN_EXPECTED = 1;

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
        <div className="tabular-nums font-medium">{c.jointCount}</div>
        <PriorDelta current={c.jointCount} prior={c.priorJointCount} />
      </div>
      <div className="text-right tabular-nums text-muted-foreground">
        {c.expectedCount < 0.01 ? "<0.01" : c.expectedCount.toFixed(2)}
      </div>
      <LiftCell lift={c.lift} expected={c.expectedCount} />
      <div className="text-right tabular-nums text-muted-foreground text-xs">
        <span className="text-foreground/70">{c.countA}</span>
        <span className="mx-0.5">/</span>
        <span className="text-foreground/70">{c.countB}</span>
      </div>
      <div className="text-right text-xs text-muted-foreground">
        {c.windowStart} → {c.windowEnd}
      </div>
    </div>
  );
}
