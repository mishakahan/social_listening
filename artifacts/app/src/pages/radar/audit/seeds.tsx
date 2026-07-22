import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useState } from "react";
import { useCompanyId } from "@/hooks/use-company";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Loader2,
  CheckCircle,
  XCircle,
  Rocket,
  AlertCircle,
  Globe,
  Tag,
  Layers,
  Target,
  CheckSquare,
  Square,
} from "lucide-react";
import { toast } from "sonner";

interface SeedItem {
  label: string;
  description: string;
  geography: string;
  productCategoryLink: string;
  territoryTag: string;
  strategicCentrality: number;
  actionableAt: string;
  groundedIn: string[];
  watchTopic?: string;
  status?: "pending" | "approved" | "killed";
}

interface WatchTopicSnapshot {
  title: string;
  description: string;
}

interface SeedCandidates {
  id: number;
  payload: SeedItem[];
  status: string;
  briefSnapshot: string;
  companyContextSnapshot: unknown;
  watchTopicsSnapshot?: WatchTopicSnapshot[];
  createdAt: string;
}

async function fetchSeedCandidates(companyId: number): Promise<SeedCandidates | null> {
  const res = await fetch(`/api/pipeline/companies/${companyId}/seed-candidates`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function patchSeedCandidate(
  companyId: number,
  candidateId: number,
  payload: SeedItem[]
): Promise<SeedCandidates> {
  const res = await fetch(`/api/pipeline/companies/${companyId}/seed-candidates/${candidateId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function commitSeeds(companyId: number, candidateId: number): Promise<void> {
  const res = await fetch(`/api/pipeline/companies/${companyId}/seeds/commit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ candidateId }),
  });
  if (!res.ok) throw new Error(await res.text());
}

function centralityBadge(value: number) {
  if (value >= 70)
    return (
      <Badge className="bg-green-500 text-white border-0 text-xs">
        {value} — High
      </Badge>
    );
  if (value >= 40)
    return (
      <Badge className="bg-amber-500 text-white border-0 text-xs">
        {value} — Medium
      </Badge>
    );
  return (
    <Badge className="bg-gray-400 text-white border-0 text-xs">
      {value} — Low
    </Badge>
  );
}

interface SeedCardProps {
  item: SeedItem;
  index: number;
  selected: boolean;
  onSelect: (index: number, checked: boolean) => void;
  allItems: SeedItem[];
  onUpdate: (items: SeedItem[]) => void;
  isPending: boolean;
}

function SeedCard({ item, index, selected, onSelect, allItems, onUpdate, isPending }: SeedCardProps) {
  const status = item.status ?? "pending";

  const setStatus = (next: "approved" | "killed" | "pending") => {
    const updated = allItems.map((s, i) =>
      i === index ? { ...s, status: next } : s
    );
    onUpdate(updated);
  };

  const cardBorder =
    status === "approved"
      ? "border-green-400 bg-green-50/30 dark:bg-green-950/20"
      : status === "killed"
      ? "border-border opacity-50"
      : selected
      ? "border-blue-300 bg-blue-50/20 dark:bg-blue-950/10"
      : "border-border";

  return (
    <Card className={`transition-all duration-200 ${cardBorder}`}>
      <CardHeader className="pb-3 pt-4 px-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2 flex-1 min-w-0">
            <Checkbox
              checked={selected}
              onCheckedChange={(checked) => onSelect(index, !!checked)}
              className="mt-0.5 flex-shrink-0"
            />
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-foreground text-sm leading-tight">{item.label}</h3>
              {item.description && (
                <p className="text-xs text-muted-foreground mt-1 leading-relaxed line-clamp-2">
                  {item.description}
                </p>
              )}
            </div>
          </div>
          <div className="flex-shrink-0">{centralityBadge(item.strategicCentrality)}</div>
        </div>
      </CardHeader>
      <CardContent className="px-5 pb-4 space-y-3">
        {/* Chips row */}
        <div className="flex flex-wrap gap-1.5">
          {item.watchTopic && (
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-0.5 text-xs text-primary border border-primary/30">
              <Target className="h-3 w-3" />
              {item.watchTopic}
            </span>
          )}
          {item.geography && (
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground border border-border">
              <Globe className="h-3 w-3" />
              {item.geography}
            </span>
          )}
          {item.territoryTag && (
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground border border-border">
              <Tag className="h-3 w-3" />
              {item.territoryTag}
            </span>
          )}
          {item.productCategoryLink && (
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground border border-border">
              <Layers className="h-3 w-3" />
              {item.productCategoryLink}
            </span>
          )}
          {item.actionableAt && (
            <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 dark:bg-blue-950/30 px-2.5 py-0.5 text-xs text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
              {item.actionableAt}
            </span>
          )}
        </div>

        {/* Grounded in */}
        {item.groundedIn && item.groundedIn.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {item.groundedIn.map((g, i) => (
              <span
                key={i}
                className="rounded-sm bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground font-mono"
              >
                {g}
              </span>
            ))}
          </div>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-2 pt-1">
          <Button
            size="sm"
            variant={status === "approved" ? "default" : "outline"}
            className={`gap-1.5 text-xs ${
              status === "approved" ? "bg-green-500 border-green-500 text-white" : ""
            }`}
            onClick={() => setStatus(status === "approved" ? "pending" : "approved")}
            disabled={isPending}
          >
            <CheckCircle className="h-3.5 w-3.5" />
            {status === "approved" ? "Approved" : "Approve"}
          </Button>
          <Button
            size="sm"
            variant={status === "killed" ? "destructive" : "outline"}
            className="gap-1.5 text-xs"
            onClick={() => setStatus(status === "killed" ? "pending" : "killed")}
            disabled={isPending}
          >
            <XCircle className="h-3.5 w-3.5" />
            {status === "killed" ? "Killed" : "Kill"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-4">
      {[1, 2, 3, 4].map((i) => (
        <Card key={i}>
          <CardHeader className="pb-3">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-full mt-2" />
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex gap-2">
              <Skeleton className="h-6 w-20 rounded-full" />
              <Skeleton className="h-6 w-24 rounded-full" />
              <Skeleton className="h-6 w-16 rounded-full" />
            </div>
            <div className="flex gap-2 pt-1">
              <Skeleton className="h-8 w-24 rounded-md" />
              <Skeleton className="h-8 w-20 rounded-md" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export default function SeedsAuditPage() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const companyId = useCompanyId();
  const [localItems, setLocalItems] = useState<SeedItem[] | null>(null);
  const [selectedIndexes, setSelectedIndexes] = useState<Set<number>>(new Set());

  const { data, isLoading, error } = useQuery({
    queryKey: ["seed-candidates", companyId],
    queryFn: () => fetchSeedCandidates(companyId),
    refetchOnWindowFocus: false,
  });

  const items: SeedItem[] = localItems ?? data?.payload ?? [];
  const candidateId = data?.id ?? 0;

  const patchMutation = useMutation({
    mutationFn: (updated: SeedItem[]) => patchSeedCandidate(companyId, candidateId, updated),
    onSuccess: (updated) => {
      queryClient.setQueryData(["seed-candidates", companyId], updated);
      toast.success("Saved");
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to save");
    },
  });

  const commitMutation = useMutation({
    mutationFn: () => commitSeeds(companyId, candidateId),
    onSuccess: () => {
      toast.success("Seeds committed!");
      navigate("/radar/audit/queries");
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to commit");
    },
  });

  const handleUpdate = (updated: SeedItem[]) => {
    setLocalItems(updated);
    patchMutation.mutate(updated);
  };

  const handleSelect = (index: number, checked: boolean) => {
    setSelectedIndexes((prev) => {
      const next = new Set(prev);
      if (checked) next.add(index);
      else next.delete(index);
      return next;
    });
  };

  const handleSelectAll = () => {
    if (selectedIndexes.size === items.length) {
      setSelectedIndexes(new Set());
    } else {
      setSelectedIndexes(new Set(items.map((_, i) => i)));
    }
  };

  const handleBulkStatus = (status: "approved" | "killed" | "pending", indexSet: Set<number>) => {
    const updated = items.map((s, i) =>
      indexSet.has(i) ? { ...s, status } : s
    );
    handleUpdate(updated);
  };

  const approvedCount = items.filter((s) => (s.status ?? "pending") === "approved").length;
  const killedCount = items.filter((s) => (s.status ?? "pending") === "killed").length;
  const pendingCount = items.filter((s) => !s.status || s.status === "pending").length;
  const totalCount = items.length;
  const canCommit = approvedCount > 0;

  const selectedCount = selectedIndexes.size;
  const allSelected = totalCount > 0 && selectedCount === totalCount;
  const someSelected = selectedCount > 0 && !allSelected;

  const pendingSelectedIndexes = new Set(
    [...selectedIndexes].filter((i) => !items[i]?.status || items[i]?.status === "pending")
  );
  const approvedSelectedIndexes = new Set(
    [...selectedIndexes].filter((i) => items[i]?.status === "approved")
  );
  const killedSelectedIndexes = new Set(
    [...selectedIndexes].filter((i) => items[i]?.status === "killed")
  );

  if (isLoading) {
    return (
      <div className="p-8 max-w-3xl mx-auto">
        <div className="mb-6">
          <Skeleton className="h-7 w-40 mb-2" />
          <Skeleton className="h-4 w-64" />
        </div>
        <LoadingSkeleton />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8 max-w-3xl mx-auto">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {error instanceof Error ? error.message : "Failed to load seed candidates."}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!data || items.length === 0) {
    return (
      <div className="p-8 max-w-3xl mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-foreground mb-1">Seeds Audit</h1>
          <p className="text-muted-foreground text-sm max-w-3xl">
            Step 1 of 5 — The LLM analyzed your company brief and proposed a set of seed topics: focused
            areas of consumer interest that are strategically relevant to monitor (e.g., "Premium Gift
            Chocolate — Germany"). Each seed defines a thematic territory, a geography, a product
            category link, and a strategic centrality score. Seeds are the root of the entire pipeline —
            every approved seed will be expanded into keyword/hashtag queries that drive what gets
            scraped. Review the proposals here: approve the ones that align with your strategy, kill the
            ones that don't. Only approved seeds generate scout queries. Once you commit, the pipeline
            moves to Queries.
          </p>
        </div>
        <Card className="p-12 text-center">
          <div className="text-muted-foreground">
            <Layers className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm font-medium">No seed candidates yet</p>
            <p className="text-xs mt-1">Generate seeds from the Setup page first.</p>
          </div>
          <Button
            variant="outline"
            className="mt-4"
            onClick={() => navigate("/radar/setup")}
          >
            Go to Setup
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-3xl mx-auto pb-24">
      {/* Header */}
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground mb-1">Seeds Audit</h1>
          <p className="text-muted-foreground text-sm max-w-3xl">
            Step 1 of 5 — The LLM analyzed your company brief and proposed a set of seed topics: focused
            areas of consumer interest that are strategically relevant to monitor (e.g., "Premium Gift
            Chocolate — Germany"). Each seed defines a thematic territory, a geography, a product
            category link, and a strategic centrality score. Seeds are the root of the entire pipeline —
            every approved seed will be expanded into keyword/hashtag queries that drive what gets
            scraped. Review the proposals here: approve the ones that align with your strategy, kill the
            ones that don't. Only approved seeds generate scout queries. Once you commit, the pipeline
            moves to Queries.
          </p>
        </div>
        <div className="text-right">
          <span className="text-sm font-medium text-foreground">
            {approvedCount} / {totalCount}
          </span>
          <p className="text-xs text-muted-foreground">approved</p>
        </div>
      </div>

      {/* Stats bar */}
      <div className="flex gap-3 mb-4">
        <Badge variant="outline" className="gap-1">
          <span className="h-2 w-2 rounded-full bg-green-500 inline-block" />
          {approvedCount} approved
        </Badge>
        <Badge variant="outline" className="gap-1">
          <span className="h-2 w-2 rounded-full bg-red-400 inline-block" />
          {killedCount} killed
        </Badge>
        <Badge variant="outline" className="gap-1">
          <span className="h-2 w-2 rounded-full bg-gray-400 inline-block" />
          {pendingCount} pending
        </Badge>
      </div>

      {/* Bulk actions toolbar */}
      <div className="flex items-center flex-wrap gap-2 mb-4 p-2 bg-muted/40 rounded-lg border border-border">
        <button
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-muted transition-colors"
          onClick={handleSelectAll}
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

        <div className="w-px h-4 bg-border mx-1" />

        {/* Bulk actions for selection */}
        {selectedCount > 0 ? (
          <>
            <span className="text-xs text-muted-foreground">{selectedCount} selected —</span>
            {(pendingSelectedIndexes.size > 0 || killedSelectedIndexes.size > 0) && (
              <Button
                size="sm"
                variant="outline"
                className="text-xs h-7 px-2 text-green-700 border-green-300 hover:bg-green-50"
                disabled={patchMutation.isPending}
                onClick={() => handleBulkStatus("approved", selectedIndexes)}
              >
                <CheckCircle className="h-3.5 w-3.5 mr-1" />
                Approve selected
              </Button>
            )}
            {(pendingSelectedIndexes.size > 0 || approvedSelectedIndexes.size > 0) && (
              <Button
                size="sm"
                variant="outline"
                className="text-xs h-7 px-2 text-red-700 border-red-300 hover:bg-red-50"
                disabled={patchMutation.isPending}
                onClick={() => handleBulkStatus("killed", selectedIndexes)}
              >
                <XCircle className="h-3.5 w-3.5 mr-1" />
                Kill selected
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="text-xs h-7 px-2 text-muted-foreground"
              disabled={patchMutation.isPending}
              onClick={() => handleBulkStatus("pending", selectedIndexes)}
            >
              Reset selected
            </Button>
          </>
        ) : (
          <>
            {/* Global bulk actions when nothing selected */}
            {pendingCount > 0 && (
              <Button
                size="sm"
                variant="outline"
                className="text-xs h-7 px-2 text-green-700 border-green-300 hover:bg-green-50"
                disabled={patchMutation.isPending}
                onClick={() => {
                  const pendingAll = new Set(
                    items.map((_, i) => i).filter((i) => !items[i]?.status || items[i]?.status === "pending")
                  );
                  handleBulkStatus("approved", pendingAll);
                }}
              >
                <CheckCircle className="h-3.5 w-3.5 mr-1" />
                Approve all pending
              </Button>
            )}
            {pendingCount > 0 && (
              <Button
                size="sm"
                variant="outline"
                className="text-xs h-7 px-2 text-red-700 border-red-300 hover:bg-red-50"
                disabled={patchMutation.isPending}
                onClick={() => {
                  const pendingAll = new Set(
                    items.map((_, i) => i).filter((i) => !items[i]?.status || items[i]?.status === "pending")
                  );
                  handleBulkStatus("killed", pendingAll);
                }}
              >
                <XCircle className="h-3.5 w-3.5 mr-1" />
                Kill all pending
              </Button>
            )}
          </>
        )}
      </div>

      {/* Seed cards — grouped under watch topics when present */}
      {(() => {
        const renderCard = (item: SeedItem, i: number) => (
          <SeedCard
            key={`${item.label}-${i}`}
            item={item}
            index={i}
            selected={selectedIndexes.has(i)}
            onSelect={handleSelect}
            allItems={items}
            onUpdate={handleUpdate}
            isPending={patchMutation.isPending}
          />
        );

        const hasWatchTopics = items.some((it) => it.watchTopic);
        if (!hasWatchTopics) {
          return (
            <div className="space-y-4">
              {items.map((item, i) => renderCard(item, i))}
            </div>
          );
        }

        // Preserve original indices (SeedCard updates status by index).
        const indexed = items.map((item, i) => ({ item, i }));
        const groups = new Map<string, { item: SeedItem; i: number }[]>();
        for (const entry of indexed) {
          const key = entry.item.watchTopic?.trim() || "__ungrouped__";
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key)!.push(entry);
        }

        // Order groups by the snapshot ordering, then any extras, ungrouped last.
        const snapshotTitles = (data?.watchTopicsSnapshot ?? []).map(
          (t) => t.title
        );
        const orderedKeys: string[] = [];
        for (const title of snapshotTitles) {
          if (groups.has(title)) orderedKeys.push(title);
        }
        for (const key of groups.keys()) {
          if (key !== "__ungrouped__" && !orderedKeys.includes(key)) {
            orderedKeys.push(key);
          }
        }
        if (groups.has("__ungrouped__")) orderedKeys.push("__ungrouped__");

        return (
          <div className="space-y-8">
            {orderedKeys.map((key) => {
              const entries = groups.get(key)!;
              const isUngrouped = key === "__ungrouped__";
              return (
                <div key={key} className="space-y-3">
                  <div className="flex items-center gap-2 border-b border-border pb-2">
                    <Target className="h-4 w-4 text-primary flex-shrink-0" />
                    <h2 className="text-sm font-semibold text-foreground">
                      {isUngrouped ? "Other seeds" : key}
                    </h2>
                    <span className="text-xs text-muted-foreground">
                      {entries.length} seed{entries.length !== 1 ? "s" : ""}
                    </span>
                  </div>
                  <div className="space-y-4">
                    {entries.map(({ item, i }) => renderCard(item, i))}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })()}

      {/* Sticky commit bar */}
      <div className="fixed bottom-0 left-60 right-0 border-t border-border bg-background/95 backdrop-blur-sm px-8 py-4 flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {canCommit
            ? `${approvedCount} seed${approvedCount !== 1 ? "s" : ""} ready to commit`
            : "Approve at least one seed to continue"}
        </p>
        <Button
          onClick={() => commitMutation.mutate()}
          disabled={!canCommit || commitMutation.isPending}
          className="gap-2"
        >
          {commitMutation.isPending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Committing…
            </>
          ) : (
            <>
              <Rocket className="h-4 w-4" />
              Commit Seeds
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
