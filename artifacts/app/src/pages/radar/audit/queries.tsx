import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Loader2,
  AlertCircle,
  Rocket,
  Search,
  Trash2,
  CheckSquare,
  Square,
} from "lucide-react";
import { toast } from "sonner";

interface ScoutQuery {
  id: number;
  topicLabel: string;
  geography: string;
  language: string;
  keywords: string[];
  hashtags: string[];
  scrapeCadence: string;
  active: boolean;
}

async function fetchQueries(): Promise<ScoutQuery[]> {
  const res = await fetch("/api/pipeline/companies/1/scout-queries");
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function patchQuery(id: number, active: boolean): Promise<ScoutQuery> {
  const res = await fetch(`/api/pipeline/scout-queries/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ active }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function deleteQueryApi(id: number): Promise<void> {
  const res = await fetch(`/api/pipeline/scout-queries/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await res.text());
}

async function bulkDeleteQueriesApi(queryIds: number[]): Promise<void> {
  const res = await fetch(`/api/pipeline/companies/1/scout-queries/bulk`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ queryIds }),
  });
  if (!res.ok) throw new Error(await res.text());
}

async function launchScrapers(queryIds: number[]): Promise<void> {
  const res = await fetch("/api/pipeline/companies/1/scout-queries/launch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ queryIds }),
  });
  if (!res.ok) throw new Error(await res.text());
}

// A single query entry within a matrix cell
interface CellEntryProps {
  query: ScoutQuery;
  selected: boolean;
  onSelect: (id: number, checked: boolean) => void;
  onToggle: (id: number, active: boolean) => void;
  onDelete: (id: number) => void;
  isToggling: boolean;
  isDeleting: boolean;
}

function CellEntry({ query, selected, onSelect, onToggle, onDelete, isToggling, isDeleting }: CellEntryProps) {
  const tipContent = [
    query.keywords?.length ? `Keywords: ${query.keywords.join(", ")}` : null,
    query.hashtags?.length ? `Hashtags: ${query.hashtags.map(h => h.startsWith("#") ? h : `#${h}`).join(", ")}` : null,
    query.scrapeCadence ? `Cadence: ${query.scrapeCadence}` : null,
  ].filter(Boolean).join("\n");

  return (
    <div className="flex items-center gap-1.5 py-0.5 group/entry">
      <Checkbox
        checked={selected}
        onCheckedChange={(v) => onSelect(query.id, !!v)}
        className="h-3.5 w-3.5 flex-shrink-0"
      />
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-[10px] font-mono uppercase text-muted-foreground cursor-default w-5 flex-shrink-0">
              {query.language}
            </span>
          </TooltipTrigger>
          {tipContent && (
            <TooltipContent side="top" className="max-w-xs text-xs whitespace-pre-line">
              {tipContent}
            </TooltipContent>
          )}
        </Tooltip>
      </TooltipProvider>
      {/* Status dot — click to toggle active */}
      <button
        title={query.active ? "Click to deactivate" : "Click to activate"}
        disabled={isToggling}
        onClick={() => onToggle(query.id, query.active)}
        className={`h-2 w-2 rounded-full flex-shrink-0 transition-colors disabled:cursor-not-allowed ${
          query.active
            ? "bg-green-500 hover:bg-green-700"
            : "bg-gray-300 dark:bg-gray-600 hover:bg-gray-400"
        }`}
      />
      <button
        title="Delete query"
        disabled={isDeleting}
        onClick={() => onDelete(query.id)}
        className="opacity-0 group-hover/entry:opacity-100 transition-opacity disabled:cursor-not-allowed"
      >
        <Trash2 className="h-2.5 w-2.5 text-muted-foreground hover:text-destructive" />
      </button>
    </div>
  );
}

export default function QueriesAuditPage() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const { data: queries = [], isLoading, error } = useQuery({
    queryKey: ["scout-queries"],
    queryFn: fetchQueries,
    refetchOnWindowFocus: false,
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, next }: { id: number; next: boolean }) => patchQuery(id, next),
    onSuccess: (updated) => {
      queryClient.setQueryData<ScoutQuery[]>(["scout-queries"], (old = []) =>
        old.map((q) => (q.id === updated.id ? updated : q))
      );
      toast.success(updated.active ? "Query activated" : "Query deactivated");
    },
    onError: (err: Error) => toast.error(err.message || "Failed to update query"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteQueryApi(id),
    onSuccess: (_, id) => {
      queryClient.setQueryData<ScoutQuery[]>(["scout-queries"], (old = []) =>
        old.filter((q) => q.id !== id)
      );
      setSelectedIds((prev) => { const n = new Set(prev); n.delete(id); return n; });
      toast.success("Query deleted");
    },
    onError: (err: Error) => toast.error(err.message || "Failed to delete query"),
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: (ids: number[]) => bulkDeleteQueriesApi(ids),
    onSuccess: (_, ids) => {
      const idSet = new Set(ids);
      queryClient.setQueryData<ScoutQuery[]>(["scout-queries"], (old = []) =>
        old.filter((q) => !idSet.has(q.id))
      );
      setSelectedIds(new Set());
      toast.success(`Deleted ${ids.length} ${ids.length === 1 ? "query" : "queries"}`);
    },
    onError: (err: Error) => toast.error(err.message || "Failed to delete queries"),
  });

  const bulkActivateMutation = useMutation({
    mutationFn: async ({ ids, active }: { ids: number[]; active: boolean }) =>
      Promise.all(ids.map((id) => patchQuery(id, active))),
    onSuccess: (updated) => {
      queryClient.setQueryData<ScoutQuery[]>(["scout-queries"], (old = []) => {
        const map = new Map(updated.map((q) => [q.id, q]));
        return old.map((q) => map.get(q.id) ?? q);
      });
      const active = updated[0]?.active ?? false;
      toast.success(`${updated.length} ${updated.length === 1 ? "query" : "queries"} ${active ? "activated" : "deactivated"}`);
    },
    onError: (err: Error) => toast.error(err.message || "Failed to update queries"),
  });

  const launchMutation = useMutation({
    mutationFn: () => launchScrapers(Array.from(selectedIds)),
    onSuccess: () => {
      toast.success("Scrapers launched!");
      navigate("/radar/audit/runs");
    },
    onError: (err: Error) => toast.error(err.message || "Failed to launch scrapers"),
  });

  const handleToggle = (id: number, currentActive: boolean) => {
    toggleMutation.mutate({ id, next: !currentActive });
  };

  const handleSelect = (id: number, checked: boolean) => {
    setSelectedIds((prev) => {
      const n = new Set(prev);
      checked ? n.add(id) : n.delete(id);
      return n;
    });
  };

  const handleSelectSet = (ids: number[], checked: boolean) => {
    setSelectedIds((prev) => {
      const n = new Set(prev);
      ids.forEach((id) => (checked ? n.add(id) : n.delete(id)));
      return n;
    });
  };

  // ── Matrix dimensions ────────────────────────────────────────────────────
  const topics = [...new Set(queries.map((q) => q.topicLabel))].sort();
  const geographies = [...new Set(queries.map((q) => q.geography))].sort();

  // matrix[topic][geo] = ScoutQuery[]
  const matrix = new Map<string, Map<string, ScoutQuery[]>>();
  for (const topic of topics) matrix.set(topic, new Map());
  for (const q of queries) {
    const row = matrix.get(q.topicLabel)!;
    row.set(q.geography, [...(row.get(q.geography) ?? []), q]);
  }

  const allSelected = queries.length > 0 && selectedIds.size === queries.length;
  const someSelected = selectedIds.size > 0 && !allSelected;
  const selectedCount = selectedIds.size;
  const selectedActiveCount = queries.filter((q) => selectedIds.has(q.id) && q.active).length;
  const selectedInactiveCount = selectedCount - selectedActiveCount;

  if (isLoading) {
    return (
      <div className="p-8 max-w-6xl mx-auto">
        <Skeleton className="h-7 w-48 mb-2" />
        <Skeleton className="h-4 w-72 mb-8" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8 max-w-6xl mx-auto">
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
    <div className="p-8 max-w-6xl mx-auto pb-24">
      {/* Header */}
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground mb-1">Queries Audit</h1>
          <p className="text-muted-foreground text-sm max-w-3xl">
            Step 2 of 5 — Each committed seed has been expanded into scout queries: specific keyword +
            hashtag combinations per language and geography that will be sent to Apify scrapers. The
            matrix shows topic (rows) × geography (columns), with one entry per query per cell. A green
            dot means the query is active; grey means inactive. Launching selected queries fires actor
            runs for each query × platform combination — typically 4–6 runs per query covering Instagram
            posts, Instagram reels, TikTok, Reddit, and Google Trends. Hover a language tag to see its
            keywords. Once scrapers are launched, monitor results in Runs.
          </p>
        </div>
        <div className="text-right">
          <span className="text-sm font-medium text-foreground">
            {queries.filter((q) => q.active).length}
          </span>
          <p className="text-xs text-muted-foreground">active queries</p>
        </div>
      </div>

      {queries.length === 0 ? (
        <div className="rounded-xl border border-border p-12 text-center">
          <Search className="h-10 w-10 mx-auto mb-3 opacity-30 text-muted-foreground" />
          <p className="text-sm font-medium text-muted-foreground">No scout queries yet</p>
          <p className="text-xs text-muted-foreground mt-1">Commit seeds first to generate queries.</p>
          <Button variant="outline" className="mt-4" onClick={() => navigate("/radar/audit/seeds")}>
            Go to Seeds
          </Button>
        </div>
      ) : (
        <>
          {/* Bulk actions toolbar */}
          <div className="flex items-center gap-2 flex-wrap mb-4 p-2 bg-muted/40 rounded-lg border border-border">
            <button
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-muted transition-colors"
              onClick={() => handleSelectSet(queries.map((q) => q.id), !allSelected)}
            >
              {allSelected ? (
                <CheckSquare className="h-3.5 w-3.5" />
              ) : someSelected ? (
                <CheckSquare className="h-3.5 w-3.5 opacity-50" />
              ) : (
                <Square className="h-3.5 w-3.5" />
              )}
              {allSelected ? "Deselect all" : "Select all"}
            </button>

            {selectedCount > 0 && (
              <>
                <span className="text-xs text-muted-foreground">{selectedCount} selected</span>
                <div className="w-px h-4 bg-border mx-1" />
                {selectedInactiveCount > 0 && (
                  <Button
                    size="sm" variant="outline" className="text-xs h-7 px-2"
                    disabled={bulkActivateMutation.isPending}
                    onClick={() =>
                      bulkActivateMutation.mutate({
                        ids: queries.filter((q) => selectedIds.has(q.id) && !q.active).map((q) => q.id),
                        active: true,
                      })
                    }
                  >
                    Activate selected
                  </Button>
                )}
                {selectedActiveCount > 0 && (
                  <Button
                    size="sm" variant="outline" className="text-xs h-7 px-2"
                    disabled={bulkActivateMutation.isPending}
                    onClick={() =>
                      bulkActivateMutation.mutate({
                        ids: queries.filter((q) => selectedIds.has(q.id) && q.active).map((q) => q.id),
                        active: false,
                      })
                    }
                  >
                    Deactivate selected
                  </Button>
                )}
                <Button
                  size="sm" variant="outline"
                  className="text-xs h-7 px-2 text-destructive hover:text-destructive border-destructive/30 hover:border-destructive"
                  disabled={bulkDeleteMutation.isPending}
                  onClick={() => bulkDeleteMutation.mutate(Array.from(selectedIds))}
                >
                  <Trash2 className="h-3.5 w-3.5 mr-1" />
                  Delete selected
                </Button>
              </>
            )}

            <div className="ml-auto flex items-center gap-2 text-[10px] text-muted-foreground">
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-green-500 inline-block" /> Active
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-gray-300 dark:bg-gray-600 inline-block" /> Inactive
              </span>
            </div>
          </div>

          {/* Matrix table */}
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  {/* Top-left corner: select-all */}
                  <th className="text-left px-4 py-3 font-semibold text-foreground min-w-[180px] sticky left-0 bg-muted/30 z-10">
                    <div className="flex items-center gap-2">
                      <Checkbox
                        checked={allSelected}
                        onCheckedChange={(v) =>
                          handleSelectSet(queries.map((q) => q.id), !!v)
                        }
                      />
                      <span className="text-xs font-medium text-muted-foreground">Topic</span>
                    </div>
                  </th>
                  {geographies.map((geo) => {
                    const geoIds = queries.filter((q) => q.geography === geo).map((q) => q.id);
                    const allGeoSel = geoIds.length > 0 && geoIds.every((id) => selectedIds.has(id));
                    const someGeoSel = geoIds.some((id) => selectedIds.has(id)) && !allGeoSel;
                    return (
                      <th
                        key={geo}
                        className="px-3 py-3 text-center font-medium min-w-[100px]"
                      >
                        <div className="flex flex-col items-center gap-1">
                          <Checkbox
                            checked={allGeoSel}
                            data-indeterminate={someGeoSel}
                            onCheckedChange={(v) => handleSelectSet(geoIds, !!v)}
                            className="h-3.5 w-3.5"
                          />
                          <Badge variant="outline" className="text-xs font-semibold px-2">
                            {geo}
                          </Badge>
                          <span className="text-[10px] text-muted-foreground">
                            {geoIds.length} {geoIds.length === 1 ? "query" : "queries"}
                          </span>
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {topics.map((topic, ti) => {
                  const topicIds = queries.filter((q) => q.topicLabel === topic).map((q) => q.id);
                  const allRowSel = topicIds.length > 0 && topicIds.every((id) => selectedIds.has(id));
                  const someRowSel = topicIds.some((id) => selectedIds.has(id)) && !allRowSel;
                  const rowQueries = matrix.get(topic)!;

                  return (
                    <tr
                      key={topic}
                      className={`border-b border-border last:border-0 ${ti % 2 === 0 ? "" : "bg-muted/10"}`}
                    >
                      {/* Row header: topic */}
                      <td className={`px-4 py-3 sticky left-0 z-10 ${ti % 2 === 0 ? "bg-background" : "bg-muted/10"}`}>
                        <div className="flex items-start gap-2">
                          <Checkbox
                            checked={allRowSel}
                            data-indeterminate={someRowSel}
                            onCheckedChange={(v) => handleSelectSet(topicIds, !!v)}
                            className="mt-0.5 flex-shrink-0"
                          />
                          <span className="text-xs font-medium text-foreground leading-tight">
                            {topic}
                          </span>
                        </div>
                      </td>
                      {/* Cells */}
                      {geographies.map((geo) => {
                        const cellQueries = rowQueries.get(geo) ?? [];
                        return (
                          <td key={geo} className="px-3 py-3 align-top">
                            {cellQueries.length === 0 ? (
                              <span className="text-muted-foreground/30 text-xs block text-center">—</span>
                            ) : (
                              <div className="space-y-0.5">
                                {cellQueries.map((q) => (
                                  <CellEntry
                                    key={q.id}
                                    query={q}
                                    selected={selectedIds.has(q.id)}
                                    onSelect={handleSelect}
                                    onToggle={handleToggle}
                                    onDelete={(id) => deleteMutation.mutate(id)}
                                    isToggling={toggleMutation.isPending}
                                    isDeleting={deleteMutation.isPending}
                                  />
                                ))}
                              </div>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Sticky launch bar */}
      <div className="fixed bottom-0 left-60 right-0 border-t border-border bg-background/95 backdrop-blur-sm px-8 py-4 flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {selectedCount > 0
            ? `${selectedCount} ${selectedCount === 1 ? "query" : "queries"} selected`
            : "Select queries to launch scrapers"}
        </p>
        <Button
          onClick={() => launchMutation.mutate()}
          disabled={selectedCount === 0 || launchMutation.isPending}
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
