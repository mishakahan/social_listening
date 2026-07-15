import { useQuery } from "@tanstack/react-query";
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { BarChart2 } from "lucide-react";

interface TimeseriesPoint {
  date: string;
  mentions: number;
  interest: number | null;
}

interface TimeseriesResponse {
  entityId: number | null;
  keywords: string[];
  windowDays: number;
  hasInterest: boolean;
  hasMentions: boolean;
  points: TimeseriesPoint[];
}

async function fetchTimeseries(
  trendId: number,
  windowDays: number
): Promise<TimeseriesResponse> {
  const res = await fetch(
    `/api/pipeline/companies/1/trends/${trendId}/timeseries?windowDays=${windowDays}`
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function formatDateShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function TrendTimeseriesChart({
  trendId,
  windowDays = 90,
}: {
  trendId: number;
  windowDays?: number;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["trend-timeseries", trendId, windowDays],
    queryFn: () => fetchTimeseries(trendId, windowDays),
  });

  return (
    <Card className="mb-6">
      <CardHeader className="pb-2 pt-4 px-5">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold text-foreground">
            Signal Over Time
          </h2>
          <span className="text-xs text-muted-foreground">
            Last {windowDays} days
          </span>
        </div>
        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
          Social mentions (bars, absolute count) and Google search interest
          (line, relative 0–100). The two scales are not directly comparable —
          mentions show <span className="font-medium">supply</span> of
          conversation; interest shows <span className="font-medium">demand</span>.
        </p>
      </CardHeader>
      <CardContent className="px-5 pb-4">
        {isLoading ? (
          <Skeleton className="h-56 w-full rounded-lg" />
        ) : error ? (
          <div className="h-56 flex items-center justify-center rounded-lg bg-muted/30 border border-dashed border-border">
            <p className="text-xs text-muted-foreground">
              Could not load time-series data.
            </p>
          </div>
        ) : !data || data.points.length === 0 ? (
          <div className="h-56 flex items-center justify-center rounded-lg bg-muted/30 border border-dashed border-border">
            <div className="text-center">
              <BarChart2 className="h-6 w-6 mx-auto mb-1 text-muted-foreground opacity-40" />
              <p className="text-xs text-muted-foreground">
                No time-series data for this trend yet.
              </p>
              <p className="text-[11px] text-muted-foreground/70 mt-1">
                Run the timeseries aggregation step or a Google Trends backfill
                to populate this chart.
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="h-56 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={data.points}
                  margin={{ top: 8, right: 8, left: 0, bottom: 4 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    className="stroke-border"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="date"
                    tickFormatter={formatDateShort}
                    tick={{ fontSize: 11 }}
                    className="text-muted-foreground"
                    minTickGap={28}
                  />
                  <YAxis
                    yAxisId="mentions"
                    orientation="left"
                    tick={{ fontSize: 11 }}
                    className="text-muted-foreground"
                    allowDecimals={false}
                    label={{
                      value: "Mentions",
                      angle: -90,
                      position: "insideLeft",
                      style: { fontSize: 10, fill: "currentColor" },
                      className: "text-muted-foreground",
                    }}
                  />
                  <YAxis
                    yAxisId="interest"
                    orientation="right"
                    domain={[0, 100]}
                    tick={{ fontSize: 11 }}
                    className="text-muted-foreground"
                    label={{
                      value: "Search interest",
                      angle: 90,
                      position: "insideRight",
                      style: { fontSize: 10, fill: "currentColor" },
                      className: "text-muted-foreground",
                    }}
                  />
                  <Tooltip
                    contentStyle={{
                      fontSize: 12,
                      borderRadius: 8,
                      border: "1px solid hsl(var(--border))",
                      background: "hsl(var(--popover))",
                      color: "hsl(var(--popover-foreground))",
                    }}
                    labelFormatter={(label) => formatDateShort(String(label))}
                    formatter={(value, name) => {
                      if (value == null) return ["—", name as string];
                      if (name === "Search interest") {
                        return [`${Math.round(Number(value))}/100`, name];
                      }
                      return [value, name as string];
                    }}
                  />
                  <Legend
                    verticalAlign="top"
                    height={28}
                    iconSize={10}
                    wrapperStyle={{ fontSize: 11 }}
                  />
                  <Bar
                    yAxisId="mentions"
                    dataKey="mentions"
                    name="Mentions (supply)"
                    fill="hsl(var(--primary))"
                    fillOpacity={0.7}
                    radius={[2, 2, 0, 0]}
                    maxBarSize={14}
                  />
                  <Line
                    yAxisId="interest"
                    type="monotone"
                    dataKey="interest"
                    name="Search interest"
                    stroke="hsl(217 91% 60%)"
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {!data.hasInterest && (
              <p className="text-[11px] text-muted-foreground mt-2">
                No Google search-interest line — this trend surfaced from social
                conversation and isn&apos;t in the Google Trends keyword set
                (the search-vs-social gap). Mentions still tell the full story.
              </p>
            )}
            {!data.hasMentions && (
              <p className="text-[11px] text-muted-foreground mt-2">
                No social-mention time series yet — run the timeseries
                aggregation step to populate the bars.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
