import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, AlertCircle, Rocket, Hash, Search, Globe2, Clock } from "lucide-react";
import { toast } from "sonner";

interface ScoutQuery {
  id: number;
  topicLabel: string;
  geography: string;
  language: string;
  keywords: string[];
  hashtags: string[];
  cadence: string;
  status: "active" | "inactive" | "draft";
  platform?: string;
}

async function fetchQueries(): Promise<ScoutQuery[]> {
  const res = await fetch("/api/pipeline/companies/1/scout-queries");
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function patchQuery(id: number, status: "active" | "inactive"): Promise<ScoutQuery> {
  const res = await fetch(`/api/pipeline/companies/1/scout-queries/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function launchScrapers(): Promise<void> {
  const res = await fetch("/api/pipeline/companies/1/scout-queries/launch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(await res.text());
}

function statusBadge(status: string) {
  if (status === "active")
    return <Badge className="bg-green-500 text-white border-0 text-xs">Active</Badge>;
  if (status === "inactive")
    return <Badge variant="outline" className="text-xs text-muted-foreground">Inactive</Badge>;
  return <Badge variant="secondary" className="text-xs">Draft</Badge>;
}

interface QueryRowProps {
  query: ScoutQuery;
  onToggle: (id: number, current: "active" | "inactive" | "draft") => void;
  isToggling: boolean;
}

function QueryRow({ query, onToggle, isToggling }: QueryRowProps) {
  return (
    <div className="flex items-start gap-4 py-3 border-b border-border last:border-0">
      {/* Left: geo + lang */}
      <div className="flex-shrink-0 w-28">
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Globe2 className="h-3 w-3" />
          <span>{query.geography || "Global"}</span>
        </div>
        {query.language && (
          <div className="text-xs text-muted-foreground mt-0.5 pl-4">{query.language}</div>
        )}
        {query.cadence && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5">
            <Clock className="h-3 w-3" />
            <span>{query.cadence}</span>
          </div>
        )}
      </div>

      {/* Middle: keywords + hashtags */}
      <div className="flex-1 min-w-0 space-y-1.5">
        {query.keywords && query.keywords.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {query.keywords.map((kw, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-0.5 rounded-sm bg-blue-50 dark:bg-blue-950/30 px-1.5 py-0.5 text-xs text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800"
              >
                <Search className="h-2.5 w-2.5" />
                {kw}
              </span>
            ))}
          </div>
        )}
        {query.hashtags && query.hashtags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {query.hashtags.map((ht, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-0.5 rounded-sm bg-purple-50 dark:bg-purple-950/30 px-1.5 py-0.5 text-xs text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800"
              >
                <Hash className="h-2.5 w-2.5" />
                {ht.replace(/^#/, "")}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Right: status + toggle */}
      <div className="flex-shrink-0 flex items-center gap-2">
        {statusBadge(query.status)}
        <Button
          size="sm"
          variant="outline"
          className="text-xs h-7 px-2"
          disabled={isToggling}
          onClick={() => onToggle(query.id, query.status)}
        >
          {query.status === "active" ? "Deactivate" : "Activate"}
        </Button>
      </div>
    </div>
  );
}

export default function QueriesAuditPage() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();

  const { data: queries = [], isLoading, error } = useQuery({
    queryKey: ["scout-queries"],
    queryFn: fetchQueries,
    refetchOnWindowFocus: false,
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, next }: { id: number; next: "active" | "inactive" }) =>
      patchQuery(id, next),
    onSuccess: (updated) => {
      queryClient.setQueryData<ScoutQuery[]>(["scout-queries"], (old = []) =>
        old.map((q) => (q.id === updated.id ? updated : q))
      );
      toast.success(`Query ${updated.status}`);
    },
    onError: (err: Error) => toast.error(err.message || "Failed to update query"),
  });

  const launchMutation = useMutation({
    mutationFn: launchScrapers,
    onSuccess: () => {
      toast.success("Scrapers launched!");
      navigate("/radar/audit/runs");
    },
    onError: (err: Error) => toast.error(err.message || "Failed to launch scrapers"),
  });

  const handleToggle = (id: number, current: "active" | "inactive" | "draft") => {
    const next = current === "active" ? "inactive" : "active";
    toggleMutation.mutate({ id, next });
  };

  // Group by topicLabel
  const grouped = queries.reduce<Record<string, ScoutQuery[]>>((acc, q) => {
    const key = q.topicLabel || "Ungrouped";
    if (!acc[key]) acc[key] = [];
    acc[key].push(q);
    return acc;
  }, {});

  const activeCount = queries.filter((q) => q.status === "active").length;

  if (isLoading) {
    return (
      <div className="p-8 max-w-4xl mx-auto">
        <div className="mb-6">
          <Skeleton className="h-7 w-48 mb-2" />
          <Skeleton className="h-4 w-72" />
        </div>
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <Card key={i}>
              <CardHeader className="pb-2">
                <Skeleton className="h-5 w-40" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-12 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8 max-w-4xl mx-auto">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {error instanceof Error ? error.message : "Failed to load queries."}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-4xl mx-auto pb-24">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground mb-1">Queries Audit</h1>
          <p className="text-muted-foreground text-sm">
            Review and activate scout queries. These define what each scraper will collect.
          </p>
        </div>
        <div className="text-right">
          <span className="text-sm font-medium text-foreground">{activeCount}</span>
          <p className="text-xs text-muted-foreground">active queries</p>
        </div>
      </div>

      {queries.length === 0 ? (
        <Card className="p-12 text-center">
          <Search className="h-10 w-10 mx-auto mb-3 opacity-30 text-muted-foreground" />
          <p className="text-sm font-medium text-muted-foreground">No scout queries yet</p>
          <p className="text-xs text-muted-foreground mt-1">
            Commit seeds first to generate queries.
          </p>
          <Button
            variant="outline"
            className="mt-4"
            onClick={() => navigate("/radar/audit/seeds")}
          >
            Go to Seeds
          </Button>
        </Card>
      ) : (
        <div className="space-y-4">
          {Object.entries(grouped).map(([topic, qs]) => (
            <Card key={topic}>
              <CardHeader className="pb-2 pt-4 px-5">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-foreground">{topic}</h2>
                  <Badge variant="outline" className="text-xs">
                    {qs.length} {qs.length === 1 ? "query" : "queries"}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="px-5 pb-2">
                <div>
                  {qs.map((q) => (
                    <QueryRow
                      key={q.id}
                      query={q}
                      onToggle={handleToggle}
                      isToggling={toggleMutation.isPending}
                    />
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Sticky launch bar */}
      <div className="fixed bottom-0 left-60 right-0 border-t border-border bg-background/95 backdrop-blur-sm px-8 py-4 flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {activeCount > 0
            ? `${activeCount} active ${activeCount === 1 ? "query" : "queries"} ready to run`
            : "Activate queries to enable scraping"}
        </p>
        <Button
          onClick={() => launchMutation.mutate()}
          disabled={activeCount === 0 || launchMutation.isPending}
          className="gap-2"
        >
          {launchMutation.isPending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Launching…
            </>
          ) : (
            <>
              <Rocket className="h-4 w-4" />
              Launch Scrapers
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
