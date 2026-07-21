import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useCompanyId } from "@/hooks/use-company";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AlertCircle, Layers, ArrowUpRight, ArrowDownRight, Minus, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Link } from "wouter";

interface AttributeRanked {
  attributeId: number;
  attribute: string;
  attributeClass: string | null;
  categoryId: number;
  categoryLabel: string;
  mentions: number;
  priorMentions: number;
  deltaPct: number | null;
}

interface CategoryWithVocab {
  id: number;
  label: string;
  slug: string;
  attributes: Array<{ id: number; attribute: string; attributeClass: string | null }>;
}

async function fetchAttributes(
  companyId: number,
  windowDays: number,
  categoryId: number | null
): Promise<{
  items: AttributeRanked[];
  windowDays: number;
}> {
  const params = new URLSearchParams();
  params.set("windowDays", String(windowDays));
  if (categoryId !== null) params.set("categoryId", String(categoryId));
  const res = await fetch(
    `/api/pipeline/companies/${companyId}/attributes?${params.toString()}`
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function fetchCategories(companyId: number): Promise<CategoryWithVocab[]> {
  const res = await fetch(`/api/pipeline/companies/${companyId}/categories`);
  if (!res.ok) throw new Error(await res.text());
  const data = (await res.json()) as { categories: CategoryWithVocab[] };
  return data.categories ?? [];
}

function formatDelta(deltaPct: number | null): {
  text: string;
  tone: "up" | "down" | "flat" | "na";
} {
  if (deltaPct === null) return { text: "—", tone: "na" };
  if (Math.abs(deltaPct) < 0.005) return { text: "0%", tone: "flat" };
  const pct = Math.round(deltaPct * 1000) / 10;
  return {
    text: `${pct > 0 ? "+" : ""}${pct}%`,
    tone: pct > 0 ? "up" : "down",
  };
}

function DeltaCell({ deltaPct }: { deltaPct: number | null }) {
  const { text, tone } = formatDelta(deltaPct);
  const cls =
    tone === "up"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "down"
        ? "text-rose-600 dark:text-rose-400"
        : "text-muted-foreground";
  const Icon =
    tone === "up" ? ArrowUpRight : tone === "down" ? ArrowDownRight : Minus;
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs tabular-nums ${cls}`}>
      <Icon className="h-3 w-3" />
      {text}
    </span>
  );
}

export default function AttributesPage() {
  const companyId = useCompanyId();
  const [windowDays, setWindowDays] = useState(30);
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [reaggregating, setReaggregating] = useState(false);

  const categoryIdFilter =
    categoryFilter === "all" ? null : Number(categoryFilter);

  const {
    data: attrData,
    isLoading: attrLoading,
    error: attrError,
    refetch: refetchAttrs,
  } = useQuery({
    queryKey: ["attributes", companyId, windowDays, categoryIdFilter],
    queryFn: () => fetchAttributes(companyId, windowDays, categoryIdFilter),
  });

  const { data: catData, isLoading: catLoading } = useQuery({
    queryKey: ["categories", companyId],
    queryFn: () => fetchCategories(companyId),
  });

  const reaggregate = async () => {
    setReaggregating(true);
    try {
      const res = await fetch(
        `/api/pipeline/companies/${companyId}/run-attribute-aggregation`,
        { method: "POST" }
      );
      if (!res.ok) throw new Error(await res.text());
      toast.success(
        "Aggregation started. Refresh in a few seconds for fresh counts."
      );
      setTimeout(() => refetchAttrs(), 3000);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start");
    } finally {
      setReaggregating(false);
    }
  };

  if (attrLoading || catLoading) {
    return (
      <div className="p-8 max-w-5xl mx-auto">
        <div className="mb-6">
          <Skeleton className="h-7 w-40 mb-2" />
          <Skeleton className="h-4 w-80" />
        </div>
        <div className="space-y-4">
          {[1, 2].map((i) => (
            <Skeleton key={i} className="h-48 w-full rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  if (attrError) {
    return (
      <div className="p-8 max-w-5xl mx-auto">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {attrError instanceof Error ? attrError.message : "Failed to load attributes."}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const categories = catData ?? [];
  const items = attrData?.items ?? [];

  // Empty state: no categories at all.
  if (categories.length === 0) {
    return (
      <div className="p-8 max-w-5xl mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-foreground mb-1">Attributes</h1>
          <p className="text-muted-foreground text-sm">
            Trending descriptors per category. Each post is scored against a
            controlled vocabulary you configure.
          </p>
        </div>
        <Card>
          <CardContent className="py-12 text-center">
            <Layers className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
            <h2 className="text-base font-semibold text-foreground mb-1">
              No categories configured
            </h2>
            <p className="text-sm text-muted-foreground mb-4 max-w-md mx-auto">
              Add at least one category and its attribute vocabulary in the
              Control Panel. Once entities are tagged with a category, posts
              mentioning them will be scored against that category's
              vocabulary.
            </p>
            <Link href="/radar/control-panel">
              <Button variant="outline" size="sm">
                Open Control Panel
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Group ranked items by category for rendering.
  const byCategory = new Map<number, AttributeRanked[]>();
  for (const item of items) {
    const list = byCategory.get(item.categoryId) ?? [];
    list.push(item);
    byCategory.set(item.categoryId, list);
  }

  const TOP_N = 25;

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground mb-1">Attributes</h1>
          <p className="text-muted-foreground text-sm">
            Trending descriptors per category. Current window vs the prior
            same-length window. Scored by a vocab-restricted LLM pass on every
            post tagged with a category.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="h-9 w-44 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {categories.map((cat) => (
                <SelectItem key={cat.id} value={String(cat.id)}>
                  {cat.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={String(windowDays)}
            onValueChange={(v) => setWindowDays(Number(v))}
          >
            <SelectTrigger className="h-9 w-32 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="14">Last 14 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
              <SelectItem value="60">Last 60 days</SelectItem>
              <SelectItem value="90">Last 90 days</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            onClick={reaggregate}
            disabled={reaggregating}
            className="gap-1.5"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${reaggregating ? "animate-spin" : ""}`} />
            Re-aggregate
          </Button>
        </div>
      </div>

      <div className="space-y-4">
        {(categoryIdFilter === null
          ? categories
          : categories.filter((c) => c.id === categoryIdFilter)
        ).map((cat) => {
          const ranked = (byCategory.get(cat.id) ?? []).slice(0, TOP_N);
          const vocabCount = cat.attributes.length;
          return (
            <Card key={cat.id}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-base font-semibold text-foreground">
                        {cat.label}
                      </h2>
                      <Badge variant="outline" className="text-xs">
                        {vocabCount} {vocabCount === 1 ? "term" : "terms"}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Top descriptors mentioned in the last {windowDays} days.
                    </p>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                {vocabCount === 0 ? (
                  <div className="py-6 text-center text-sm text-muted-foreground">
                    No vocabulary configured for this category.{" "}
                    <Link
                      href="/radar/control-panel"
                      className="text-primary underline"
                    >
                      Add terms
                    </Link>
                    .
                  </div>
                ) : ranked.length === 0 ? (
                  <div className="py-6 text-center text-sm text-muted-foreground">
                    No mentions yet in this window. Once posts tagged with
                    this category come in, matched vocabulary terms will rank
                    here.
                  </div>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-muted-foreground border-b border-border">
                        <th className="text-left font-medium py-2 w-10">#</th>
                        <th className="text-left font-medium py-2">Attribute</th>
                        <th className="text-left font-medium py-2 w-28">Class</th>
                        <th className="text-right font-medium py-2 w-24">Mentions</th>
                        <th className="text-right font-medium py-2 w-20">Prior</th>
                        <th className="text-right font-medium py-2 w-20">Change</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ranked.map((r, i) => (
                        <tr
                          key={r.attributeId}
                          className="border-b border-border last:border-0"
                        >
                          <td className="py-2 text-muted-foreground tabular-nums">
                            {i + 1}
                          </td>
                          <td className="py-2 font-medium text-foreground">
                            {r.attribute}
                          </td>
                          <td className="py-2 text-xs text-muted-foreground">
                            {r.attributeClass ?? "—"}
                          </td>
                          <td className="py-2 text-right tabular-nums">
                            {r.mentions.toLocaleString()}
                          </td>
                          <td className="py-2 text-right tabular-nums text-muted-foreground">
                            {r.priorMentions.toLocaleString()}
                          </td>
                          <td className="py-2 text-right">
                            <DeltaCell deltaPct={r.deltaPct} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
