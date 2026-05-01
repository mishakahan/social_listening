import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircle, TrendingUp, TrendingDown, Minus, ChevronRight } from "lucide-react";
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
  platforms: string[];
  evidenceCount: number;
  geography?: string;
  territoryTag?: string;
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

async function fetchTrends(): Promise<Trend[]> {
  const res = await fetch("/api/pipeline/companies/1/trends");
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

function WoWGrowth({ pct }: { pct?: number }) {
  if (pct == null) return <span className="text-muted-foreground text-sm">—</span>;
  const isPos = pct > 0;
  const isNeg = pct < 0;
  return (
    <div
      className={`flex items-center gap-0.5 text-sm font-medium tabular-nums ${
        isPos ? "text-green-600" : isNeg ? "text-red-500" : "text-muted-foreground"
      }`}
    >
      {isPos ? (
        <TrendingUp className="h-3.5 w-3.5" />
      ) : isNeg ? (
        <TrendingDown className="h-3.5 w-3.5" />
      ) : (
        <Minus className="h-3.5 w-3.5" />
      )}
      {isPos ? "+" : ""}
      {pct.toFixed(1)}%
    </div>
  );
}

export default function TrendsListPage() {
  const [, navigate] = useLocation();

  const { data: trends = [], isLoading, error } = useQuery({
    queryKey: ["trends"],
    queryFn: fetchTrends,
    refetchOnWindowFocus: false,
  });

  if (isLoading) {
    return (
      <div className="p-8 max-w-5xl mx-auto">
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
      <div className="p-8 max-w-5xl mx-auto">
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
    <div className="p-8 max-w-5xl mx-auto">
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
          <div className="grid grid-cols-[2fr_auto_auto_auto_auto_auto_auto] gap-4 px-5 py-2.5 bg-muted/30 border-b border-border text-xs font-medium text-muted-foreground uppercase tracking-wide">
            <div>Title</div>
            <div className="text-center w-16 flex items-center justify-center gap-1">
              <span>Signal</span>
              <SignalScoreInfo align="start" />
            </div>
            <div className="text-right w-20">WoW</div>
            <div className="w-28">State</div>
            <div className="w-32">Platforms</div>
            <div className="text-right w-20">Evidence</div>
            <div className="w-4"></div>
          </div>

          {/* Rows */}
          <div className="divide-y divide-border">
            {trends.map((trend) => {
              const stateCfg =
                STATE_CONFIG[trend.state] ?? {
                  label: trend.state,
                  className: "bg-gray-500 text-white border-0",
                };
              return (
                <div
                  key={trend.id}
                  className="grid grid-cols-[2fr_auto_auto_auto_auto_auto_auto] gap-4 px-5 py-3.5 items-center hover:bg-muted/30 cursor-pointer transition-colors"
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
                  <div className="w-16 flex justify-center">
                    <SignalStrengthArc value={trend.signalStrength} />
                  </div>

                  {/* WoW */}
                  <div className="w-20 flex justify-end">
                    <WoWGrowth pct={trend.wowGrowthPct} />
                  </div>

                  {/* State */}
                  <div className="w-28">
                    <Badge className={`text-xs ${stateCfg.className}`}>{stateCfg.label}</Badge>
                  </div>

                  {/* Platforms */}
                  <div className="w-32 flex flex-wrap gap-1">
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
                  <div className="w-20 text-right text-sm tabular-nums text-muted-foreground">
                    {trend.evidenceCount ?? 0}
                  </div>

                  {/* Arrow */}
                  <div className="w-4">
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
