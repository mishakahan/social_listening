import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
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
  status?: "pending" | "approved" | "killed";
}

interface SeedCandidates {
  id: number;
  payload: SeedItem[];
  status: string;
  briefSnapshot: string;
  companyContextSnapshot: unknown;
  createdAt: string;
}

async function fetchSeedCandidates(): Promise<SeedCandidates | null> {
  const res = await fetch("/api/pipeline/companies/1/seed-candidates");
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function patchSeedCandidate(
  candidateId: number,
  payload: SeedItem[]
): Promise<SeedCandidates> {
  const res = await fetch(`/api/pipeline/companies/1/seed-candidates/${candidateId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function commitSeeds(candidateId: number): Promise<void> {
  const res = await fetch("/api/pipeline/companies/1/seeds/commit", {
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
  candidateId: number;
  allItems: SeedItem[];
  onUpdate: (items: SeedItem[]) => void;
  isPending: boolean;
}

function SeedCard({ item, index, allItems, onUpdate, isPending }: SeedCardProps) {
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
      : "border-border";

  return (
    <Card className={`transition-all duration-200 ${cardBorder}`}>
      <CardHeader className="pb-3 pt-4 px-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-foreground text-sm leading-tight">{item.label}</h3>
            {item.description && (
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed line-clamp-2">
                {item.description}
              </p>
            )}
          </div>
          <div className="flex-shrink-0">{centralityBadge(item.strategicCentrality)}</div>
        </div>
      </CardHeader>
      <CardContent className="px-5 pb-4 space-y-3">
        {/* Chips row */}
        <div className="flex flex-wrap gap-1.5">
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
  const [localItems, setLocalItems] = useState<SeedItem[] | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["seed-candidates"],
    queryFn: fetchSeedCandidates,
    refetchOnWindowFocus: false,
  });

  const items: SeedItem[] = localItems ?? data?.payload ?? [];
  const candidateId = data?.id ?? 0;

  const patchMutation = useMutation({
    mutationFn: (updated: SeedItem[]) => patchSeedCandidate(candidateId, updated),
    onSuccess: (updated) => {
      queryClient.setQueryData(["seed-candidates"], updated);
      toast.success("Saved");
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to save");
    },
  });

  const commitMutation = useMutation({
    mutationFn: () => commitSeeds(candidateId),
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

  const approvedCount = items.filter((s) => (s.status ?? "pending") === "approved").length;
  const totalCount = items.length;
  const canCommit = approvedCount > 0;

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
          <p className="text-muted-foreground text-sm">
            Review and approve seed topics for your radar pipeline.
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
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground mb-1">Seeds Audit</h1>
          <p className="text-muted-foreground text-sm">
            Review the generated seed topics. Approve the ones you want to track.
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
      <div className="flex gap-3 mb-6">
        <Badge variant="outline" className="gap-1">
          <span className="h-2 w-2 rounded-full bg-green-500 inline-block" />
          {approvedCount} approved
        </Badge>
        <Badge variant="outline" className="gap-1">
          <span className="h-2 w-2 rounded-full bg-red-400 inline-block" />
          {items.filter((s) => (s.status ?? "pending") === "killed").length} killed
        </Badge>
        <Badge variant="outline" className="gap-1">
          <span className="h-2 w-2 rounded-full bg-gray-400 inline-block" />
          {items.filter((s) => !s.status || s.status === "pending").length} pending
        </Badge>
      </div>

      {/* Seed cards */}
      <div className="space-y-4">
        {items.map((item, i) => (
          <SeedCard
            key={`${item.label}-${i}`}
            item={item}
            index={i}
            candidateId={candidateId}
            allItems={items}
            onUpdate={handleUpdate}
            isPending={patchMutation.isPending}
          />
        ))}
      </div>

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
