import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect, useRef, useCallback } from "react";
import { useCompanyId } from "@/hooks/use-company";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Slider } from "@/components/ui/slider";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AlertCircle, CheckCircle2, X, Plus, Loader2, CalendarClock, Layers, Trash2, AlertTriangle } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";

interface EntityTypeConfig {
  id: string;
  label: string;
  description: string;
  examples: string;
  color: string;
}

interface PipelineConfig {
  // Tier 1
  noiseFloor: number;
  commercialIntentThreshold: number;
  languageConfidenceThreshold: number;
  // Tier 2
  candidateToEmergingMinWeeks: number;
  candidateToEmergingMinWowGrowth: number;
  candidateToEmergingMinVolume: number;
  minEvidenceForKnowledgeItem: number;
  volatilityTolerance: number;
  // Tier 3
  peakingWeeksNegVelocity: number;
  decliningWeeksNegVelocity: number;
  dormantThresholdWeeks: number;
  radarSurfaceMinSignalStrength: number;
  // Other
  authorAllowlist: string[];
  coreVocabulary: string[];
  entityTypes: EntityTypeConfig[];
  // Scout pull schedule
  scoutPullCadence: "manual" | "weekly" | "biweekly" | "monthly";
  scoutPullDow: number;
  scoutPullHourUtc: number;
  lastScoutPullAt: string | null;
  [key: string]: unknown;
}

const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatNextPull(
  cadence: PipelineConfig["scoutPullCadence"],
  dow: number,
  hourUtc: number,
  lastPullAt: string | null
): string {
  if (cadence === "manual") return "Manual only";
  const cadenceDays = cadence === "weekly" ? 7 : cadence === "biweekly" ? 14 : 30;
  const now = new Date();
  // Earliest moment cron is allowed to fire again, based on lastScoutPullAt + cadence.
  const earliest = lastPullAt
    ? new Date(new Date(lastPullAt).getTime() + (cadenceDays * 24 - 0.5) * 3600_000)
    : now;
  // Walk forward day-by-day in UTC until we hit the configured DOW + hour at/after `earliest`.
  const candidate = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    hourUtc, 0, 0, 0,
  ));
  for (let i = 0; i < 60; i++) {
    if (candidate.getUTCDay() === dow && candidate.getTime() >= earliest.getTime() && candidate.getTime() >= now.getTime()) {
      return `${DOW_LABELS[dow]} ${String(hourUtc).padStart(2, "0")}:00 UTC (${candidate.toISOString().slice(0, 10)})`;
    }
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  return `${DOW_LABELS[dow]} ${String(hourUtc).padStart(2, "0")}:00 UTC`;
}

// Tailwind colour palette for the entity-type chip picker.
const TYPE_COLOR_SWATCHES: { label: string; value: string }[] = [
  { label: "Slate", value: "bg-slate-100 text-slate-700 dark:bg-slate-900/30 dark:text-slate-300" },
  { label: "Gray", value: "bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-300" },
  { label: "Red", value: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300" },
  { label: "Orange", value: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300" },
  { label: "Amber", value: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300" },
  { label: "Yellow", value: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300" },
  { label: "Lime", value: "bg-lime-100 text-lime-700 dark:bg-lime-900/30 dark:text-lime-300" },
  { label: "Green", value: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300" },
  { label: "Emerald", value: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300" },
  { label: "Teal", value: "bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300" },
  { label: "Cyan", value: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300" },
  { label: "Sky", value: "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300" },
  { label: "Blue", value: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300" },
  { label: "Indigo", value: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300" },
  { label: "Violet", value: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300" },
  { label: "Purple", value: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300" },
  { label: "Fuchsia", value: "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-900/30 dark:text-fuchsia-300" },
  { label: "Pink", value: "bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-300" },
  { label: "Rose", value: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300" },
];

// ---------------------------------------------------------------------------
// Categories & attribute vocabulary editor (Task #4)
// ---------------------------------------------------------------------------

interface CategoryVocabUI {
  id?: number;
  slug: string;
  label: string;
  attributes: Array<{ id?: number; attribute: string; attributeClass: string | null }>;
}

function slugifyCategoryLabel(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function fetchCategoriesApi(companyId: number): Promise<CategoryVocabUI[]> {
  const res = await fetch(`/api/pipeline/companies/${companyId}/categories`);
  if (!res.ok) throw new Error(await res.text());
  const data = (await res.json()) as { categories: CategoryVocabUI[] };
  return data.categories ?? [];
}

async function patchCategoriesApi(
  companyId: number,
  categories: CategoryVocabUI[]
): Promise<CategoryVocabUI[]> {
  const payload = {
    categories: categories.map((c) => ({
      slug: c.slug,
      label: c.label,
      attributes: c.attributes.map((a) => ({
        attribute: a.attribute,
        attributeClass: a.attributeClass,
      })),
    })),
  };
  const res = await fetch(`/api/pipeline/companies/${companyId}/categories`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(await res.text());
  const data = (await res.json()) as { categories: CategoryVocabUI[] };
  return data.categories ?? [];
}

function CategoriesEditor() {
  const queryClient = useQueryClient();
  const companyId = useCompanyId();
  const { data, isLoading, error } = useQuery({
    queryKey: ["categories", companyId],
    queryFn: () => fetchCategoriesApi(companyId),
  });

  const [local, setLocal] = useState<CategoryVocabUI[] | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // Monotonic request counter — out-of-order PATCH responses are ignored so a
  // slow earlier save can't overwrite a newer edit.
  const reqSeqRef = useRef(0);
  const latestAckedRef = useRef(0);

  useEffect(() => {
    if (data && local === null) setLocal(data);
  }, [data, local]);

  const mutation = useMutation({
    mutationFn: async (args: { seq: number; payload: CategoryVocabUI[] }) => {
      const saved = await patchCategoriesApi(companyId, args.payload);
      return { seq: args.seq, saved };
    },
    onSuccess: ({ seq, saved }) => {
      if (seq < latestAckedRef.current) return; // stale response, ignore
      latestAckedRef.current = seq;
      queryClient.setQueryData(["categories", companyId], saved);
      // Only reconcile local state if no newer edits are pending; otherwise
      // the user's in-flight edits would be reverted.
      if (seq === reqSeqRef.current) setLocal(saved);
      setSavedAt(Date.now());
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to save categories");
    },
  });

  const scheduleSave = useCallback(
    (next: CategoryVocabUI[]) => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        reqSeqRef.current += 1;
        const seq = reqSeqRef.current;
        mutation.mutate({ seq, payload: next });
      }, 600);
    },
    [mutation]
  );

  const update = (next: CategoryVocabUI[]) => {
    setLocal(next);
    scheduleSave(next);
  };

  if (isLoading || local === null) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>
          {error instanceof Error ? error.message : "Failed to load categories"}
        </AlertDescription>
      </Alert>
    );
  }

  const addCategory = () => {
    const label = newLabel.trim();
    if (!label) return;
    const slug = slugifyCategoryLabel(label);
    if (!slug) return;
    if (local.some((c) => c.slug === slug)) {
      toast.error("A category with that slug already exists");
      return;
    }
    update([...local, { slug, label, attributes: [] }]);
    setNewLabel("");
  };

  const renameCategory = (idx: number, label: string) => {
    const next = local.map((c, i) => (i === idx ? { ...c, label } : c));
    setLocal(next);
    scheduleSave(next);
  };

  const removeCategory = (idx: number) => {
    if (!confirm(`Delete category "${local[idx]?.label}"? This removes its attribute vocabulary and any extracted attribute mentions.`)) return;
    update(local.filter((_, i) => i !== idx));
  };

  const addAttribute = (idx: number, raw: string) => {
    const attribute = raw.trim();
    if (!attribute) return;
    const lc = attribute.toLowerCase();
    const cat = local[idx]!;
    if (cat.attributes.some((a) => a.attribute.toLowerCase() === lc)) return;
    const next = local.map((c, i) =>
      i === idx
        ? {
            ...c,
            attributes: [...c.attributes, { attribute, attributeClass: null }],
          }
        : c
    );
    update(next);
  };

  const removeAttribute = (catIdx: number, attrIdx: number) => {
    const next = local.map((c, i) =>
      i === catIdx
        ? { ...c, attributes: c.attributes.filter((_, j) => j !== attrIdx) }
        : c
    );
    update(next);
  };

  const showSaved = savedAt && Date.now() - savedAt < 2000;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Input
          placeholder="New category label (e.g. Beverages)"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addCategory()}
          className="h-9 text-sm flex-1"
        />
        <Button size="sm" variant="outline" className="gap-1 h-9" onClick={addCategory}>
          <Plus className="h-3.5 w-3.5" />
          Add category
        </Button>
        {mutation.isPending && (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        )}
        {!mutation.isPending && showSaved && (
          <CheckCircle2 className="h-4 w-4 text-green-500" />
        )}
      </div>

      {local.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No categories yet. Add one above to start defining its attribute vocabulary.
        </p>
      ) : (
        <div className="space-y-3">
          {local.map((cat, idx) => (
            <CategoryRow
              key={cat.id ?? cat.slug}
              category={cat}
              onRename={(label) => renameCategory(idx, label)}
              onRemove={() => removeCategory(idx)}
              onAddAttribute={(v) => addAttribute(idx, v)}
              onRemoveAttribute={(j) => removeAttribute(idx, j)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface CategoryRowProps {
  category: CategoryVocabUI;
  onRename: (label: string) => void;
  onRemove: () => void;
  onAddAttribute: (val: string) => void;
  onRemoveAttribute: (idx: number) => void;
}

function CategoryRow({
  category,
  onRename,
  onRemove,
  onAddAttribute,
  onRemoveAttribute,
}: CategoryRowProps) {
  const [labelLocal, setLabelLocal] = useState(category.label);
  const [attrInput, setAttrInput] = useState("");

  useEffect(() => {
    setLabelLocal(category.label);
  }, [category.label]);

  const commitLabel = () => {
    const trimmed = labelLocal.trim();
    if (trimmed && trimmed !== category.label) onRename(trimmed);
    else setLabelLocal(category.label);
  };

  const submitAttr = () => {
    if (!attrInput.trim()) return;
    onAddAttribute(attrInput);
    setAttrInput("");
  };

  return (
    <div className="rounded-md border border-border p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Input
          value={labelLocal}
          onChange={(e) => setLabelLocal(e.target.value)}
          onBlur={commitLabel}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          className="h-8 text-sm font-medium flex-1"
        />
        <Badge variant="outline" className="text-xs font-mono">
          {category.slug}
        </Badge>
        <Badge variant="outline" className="text-xs">
          {category.attributes.length}{" "}
          {category.attributes.length === 1 ? "term" : "terms"}
        </Badge>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 text-muted-foreground hover:text-destructive"
          onClick={onRemove}
          title="Delete category"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="flex flex-wrap gap-1.5 min-h-[32px] rounded-md border border-input bg-transparent px-2 py-1.5">
        {category.attributes.map((a, j) => (
          <span
            key={a.id ?? `${a.attribute}-${j}`}
            className="inline-flex items-center gap-1 rounded-sm bg-muted px-2 py-0.5 text-xs font-medium"
          >
            {a.attribute}
            <button
              onClick={() => onRemoveAttribute(j)}
              className="text-muted-foreground hover:text-foreground ml-0.5"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        {category.attributes.length === 0 && (
          <span className="text-xs text-muted-foreground">
            No attribute terms yet
          </span>
        )}
      </div>

      <div className="flex gap-2">
        <Input
          placeholder="add attribute term (e.g. matcha, smoky, single-origin)"
          value={attrInput}
          onChange={(e) => setAttrInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submitAttr()}
          className="h-8 text-xs flex-1"
        />
        <Button
          size="sm"
          variant="outline"
          className="gap-1 h-8"
          onClick={submitAttr}
        >
          <Plus className="h-3.5 w-3.5" />
          Add
        </Button>
      </div>
    </div>
  );
}

function slugifyTypeId(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

async function fetchConfig(companyId: number): Promise<PipelineConfig> {
  const res = await fetch(`/api/pipeline/companies/${companyId}/pipeline-config`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function patchConfig(companyId: number, patch: Partial<PipelineConfig>): Promise<PipelineConfig> {
  const res = await fetch(`/api/pipeline/companies/${companyId}/pipeline-config`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// Auto-save field with debounce + success indicator
function useAutoSave(
  key: string,
  value: unknown,
  mutate: (patch: Partial<PipelineConfig>) => void,
  ready: boolean
) {
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFirstRender = useRef(true);

  useEffect(() => {
    if (!ready) return;
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      mutate({ [key]: value } as Partial<PipelineConfig>);
      setSavedKey(key);
      setTimeout(() => setSavedKey(null), 2000);
    }, 500);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  return savedKey === key;
}

interface FieldRowProps {
  label: string;
  help: string;
  saved: boolean;
  children: React.ReactNode;
}

function FieldRow({ label, help, saved, children }: FieldRowProps) {
  return (
    <div className="flex items-start gap-4 py-3 border-b border-border last:border-0">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <Label className="text-sm font-medium">{label}</Label>
          {saved && <CheckCircle2 className="h-3.5 w-3.5 text-green-500 flex-shrink-0" />}
        </div>
        <p className="text-xs text-muted-foreground">{help}</p>
      </div>
      <div className="flex-shrink-0 w-56">{children}</div>
    </div>
  );
}

interface NumberFieldProps {
  fieldKey: string;
  label: string;
  help: string;
  value: number;
  min?: number;
  max?: number;
  onChange: (v: number) => void;
  onSave: (k: string, v: unknown) => void;
  ready: boolean;
}

function NumberField({ fieldKey, label, help, value, min, max, onChange, onSave, ready }: NumberFieldProps) {
  const [local, setLocal] = useState(value);
  const saved = useAutoSave(fieldKey, local, (p) => onSave(fieldKey, p[fieldKey]), ready);

  useEffect(() => { setLocal(value); }, [value]);

  return (
    <FieldRow label={label} help={help} saved={saved}>
      <Input
        type="number"
        min={min}
        max={max}
        value={local}
        onChange={(e) => {
          const n = parseFloat(e.target.value);
          if (!isNaN(n)) { setLocal(n); onChange(n); }
        }}
        className="w-full h-8 text-sm"
      />
    </FieldRow>
  );
}

interface SliderFieldProps {
  fieldKey: string;
  label: string;
  help: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  onSave: (k: string, v: unknown) => void;
  ready: boolean;
}

function SliderField({ fieldKey, label, help, value, min, max, step = 0.01, onChange, onSave, ready }: SliderFieldProps) {
  const [local, setLocal] = useState(value ?? min);
  const saved = useAutoSave(fieldKey, local, (p) => onSave(fieldKey, p[fieldKey]), ready);

  useEffect(() => { setLocal(value ?? min); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <FieldRow label={label} help={help} saved={saved}>
      <div className="flex items-center gap-3">
        <Slider
          min={min}
          max={max}
          step={step}
          value={[local ?? min]}
          onValueChange={([v]) => { setLocal(v); onChange(v); }}
          className="flex-1"
        />
        <span className="text-sm tabular-nums w-10 text-right text-muted-foreground">
          {(local ?? min).toFixed(step < 1 ? 2 : 0)}
        </span>
      </div>
    </FieldRow>
  );
}

interface AuthorAllowlistProps {
  authors: string[];
  onSave: (k: string, v: unknown) => void;
  isSaving: boolean;
  ready: boolean;
}

function AuthorAllowlist({ authors, onSave, isSaving, ready }: AuthorAllowlistProps) {
  const [items, setItems] = useState<string[]>(authors);
  const [input, setInput] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => { setItems(authors); }, [authors]);

  const persist = useCallback((next: string[]) => {
    if (!ready) return;
    onSave("authorAllowlist", next);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }, [onSave, ready]);

  const add = () => {
    const val = input.trim();
    if (!val || items.includes(val)) return;
    const next = [...items, val];
    setItems(next);
    setInput("");
    persist(next);
  };

  const remove = (i: number) => {
    const next = items.filter((_, idx) => idx !== i);
    setItems(next);
    persist(next);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Label className="text-sm font-medium">Author Allowlist</Label>
        {saved && <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />}
        {isSaving && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </div>
      <p className="text-xs text-muted-foreground">
        Trusted creator handles. Evidence from these authors gets a signal boost.
      </p>
      <div className="flex flex-wrap gap-1.5 min-h-[36px] rounded-md border border-input bg-transparent px-3 py-2">
        {items.map((a, i) => (
          <span
            key={i}
            className="inline-flex items-center gap-1 rounded-sm bg-muted px-2 py-0.5 text-xs font-medium"
          >
            @{a}
            <button
              onClick={() => remove(i)}
              className="text-muted-foreground hover:text-foreground ml-0.5"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        {items.length === 0 && (
          <span className="text-xs text-muted-foreground">No authors added yet</span>
        )}
      </div>
      <div className="flex gap-2">
        <Input
          placeholder="handle (without @)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          className="h-8 text-sm flex-1"
        />
        <Button size="sm" variant="outline" className="gap-1 h-8" onClick={add}>
          <Plus className="h-3.5 w-3.5" />
          Add
        </Button>
      </div>
    </div>
  );
}

interface CoreVocabularyProps {
  terms: string[];
  onSave: (k: string, v: unknown) => void;
  isSaving: boolean;
  ready: boolean;
}

function CoreVocabulary({ terms, onSave, isSaving, ready }: CoreVocabularyProps) {
  const [items, setItems] = useState<string[]>(terms);
  const [input, setInput] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => { setItems(terms); }, [terms]);

  const persist = useCallback((next: string[]) => {
    if (!ready) return;
    onSave("coreVocabulary", next);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }, [onSave, ready]);

  const add = () => {
    const val = input.trim().toLowerCase();
    if (!val) return;
    if (items.some((t) => t.toLowerCase() === val)) return;
    const next = [...items, val];
    setItems(next);
    setInput("");
    persist(next);
  };

  const remove = (i: number) => {
    const next = items.filter((_, idx) => idx !== i);
    setItems(next);
    persist(next);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Label className="text-sm font-medium">Core vocabulary (never a trend)</Label>
        {saved && <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />}
        {isSaving && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </div>
      <p className="text-xs text-muted-foreground">
        Generic category words that are part of this company's everyday vocabulary
        (e.g. chocolate, gelato, patisserie) and should never appear as a trend.
        Filtered at extraction time and hidden from the radar. Case-insensitive
        exact match — bare term only. Multi-word entities containing these words
        (e.g. "dubai chocolate") are still extracted normally.
      </p>
      <div className="flex flex-wrap gap-1.5 min-h-[36px] rounded-md border border-input bg-transparent px-3 py-2">
        {items.map((t, i) => (
          <span
            key={i}
            className="inline-flex items-center gap-1 rounded-sm bg-muted px-2 py-0.5 text-xs font-medium"
          >
            {t}
            <button
              onClick={() => remove(i)}
              className="text-muted-foreground hover:text-foreground ml-0.5"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        {items.length === 0 && (
          <span className="text-xs text-muted-foreground">No core vocabulary added yet</span>
        )}
      </div>
      <div className="flex gap-2">
        <Input
          placeholder="generic term (e.g. chocolate)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          className="h-8 text-sm flex-1"
        />
        <Button size="sm" variant="outline" className="gap-1 h-8" onClick={add}>
          <Plus className="h-3.5 w-3.5" />
          Add
        </Button>
      </div>
    </div>
  );
}

interface EntityTypesEditorProps {
  types: EntityTypeConfig[];
  onSave: (k: string, v: unknown) => void;
  isSaving: boolean;
  ready: boolean;
}

function EntityTypesEditor({ types, onSave, isSaving, ready }: EntityTypesEditorProps) {
  const [items, setItems] = useState<EntityTypeConfig[]>(types);
  const [saved, setSaved] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<EntityTypeConfig[] | null>(null);

  useEffect(() => { setItems(types); }, [types]);

  // Debounce persistence so rapid blur/colour/move edits coalesce into one
  // PATCH and out-of-order responses from the server can't overwrite newer
  // local edits.
  const persist = useCallback((next: EntityTypeConfig[]) => {
    if (!ready) return;
    pendingRef.current = next;
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      const payload = pendingRef.current;
      pendingRef.current = null;
      persistTimerRef.current = null;
      if (!payload) return;
      onSave("entityTypes", payload);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }, 600);
  }, [onSave, ready]);

  useEffect(() => () => {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
  }, []);

  const commit = (next: EntityTypeConfig[]) => {
    // Validate ids: non-empty, unique. Validation runs synchronously so the
    // user sees the error immediately while typing; persistence is debounced
    // inside `persist`.
    const seen = new Set<string>();
    for (const t of next) {
      if (!t.id) {
        setErrorMsg("Each type needs an id");
        return;
      }
      if (seen.has(t.id)) {
        setErrorMsg(`Duplicate id "${t.id}" — ids must be unique`);
        return;
      }
      seen.add(t.id);
    }
    if (!next.some((t) => t.label.trim().length > 0)) {
      setErrorMsg("At least one type needs a label");
      return;
    }
    setErrorMsg(null);
    persist(next);
  };

  const updateField = (index: number, patch: Partial<EntityTypeConfig>) => {
    const next = items.map((t, i) => (i === index ? { ...t, ...patch } : t));
    setItems(next);
    commit(next);
  };

  const addType = () => {
    const next: EntityTypeConfig[] = [
      ...items,
      {
        id: `type_${items.length + 1}`,
        label: "New type",
        description: "",
        examples: "",
        color: TYPE_COLOR_SWATCHES[items.length % TYPE_COLOR_SWATCHES.length]!.value,
      },
    ];
    setItems(next);
    commit(next);
  };

  const removeType = (index: number) => {
    const next = items.filter((_, i) => i !== index);
    setItems(next);
    commit(next);
  };

  const moveType = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target]!, next[index]!];
    setItems(next);
    commit(next);
  };

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Label className="text-sm font-medium">Entity Type Taxonomy</Label>
          {saved && <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />}
          {isSaving && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        </div>
        <p className="text-xs text-muted-foreground">
          Categories the LLM uses to classify extracted entities. Each type's
          label, description, and examples are injected into the extraction
          prompt — write them as if briefing a junior analyst. The id is the
          machine-readable code stored on each entity (lowercase, no spaces).
          Existing entities keep their old type even if you rename or remove it.
        </p>
      </div>

      {errorMsg && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription className="text-xs">{errorMsg}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-2">
        {items.map((t, i) => (
          <div
            key={i}
            className="rounded-md border border-border p-3 space-y-2 bg-card"
          >
            <div className="flex items-start gap-2">
              <span
                className={`inline-flex items-center rounded px-2 py-0.5 text-[10px] font-medium ${t.color} flex-shrink-0 mt-1`}
              >
                {t.label || t.id || "—"}
              </span>
              <div className="flex-1" />
              <div className="flex items-center gap-1 flex-shrink-0">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0 text-xs"
                  onClick={() => moveType(i, -1)}
                  disabled={i === 0}
                  title="Move up"
                >
                  ↑
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0 text-xs"
                  onClick={() => moveType(i, 1)}
                  disabled={i === items.length - 1}
                  title="Move down"
                >
                  ↓
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                  onClick={() => removeType(i)}
                  title="Remove"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-[10px] text-muted-foreground uppercase tracking-wide">Label</Label>
                <Input
                  value={t.label}
                  onChange={(e) => updateField(i, { label: e.target.value })}

                  className="h-8 text-sm"
                />
              </div>
              <div>
                <Label className="text-[10px] text-muted-foreground uppercase tracking-wide">Id (machine name)</Label>
                <Input
                  value={t.id}
                  onChange={(e) => updateField(i, { id: slugifyTypeId(e.target.value) })}

                  className="h-8 text-sm font-mono"
                />
              </div>
            </div>

            <div>
              <Label className="text-[10px] text-muted-foreground uppercase tracking-wide">Description (for LLM)</Label>
              <Input
                value={t.description}
                onChange={(e) => updateField(i, { description: e.target.value })}

                placeholder="Short rationale shown in the extraction prompt"
                className="h-8 text-sm"
              />
            </div>

            <div>
              <Label className="text-[10px] text-muted-foreground uppercase tracking-wide">Examples (comma-separated)</Label>
              <Input
                value={t.examples}
                onChange={(e) => updateField(i, { examples: e.target.value })}

                placeholder="e.g. hazelnut, sea salt, oat milk"
                className="h-8 text-sm"
              />
            </div>

            <div>
              <Label className="text-[10px] text-muted-foreground uppercase tracking-wide">Color</Label>
              <div className="flex flex-wrap gap-1 mt-1">
                {TYPE_COLOR_SWATCHES.map((sw) => {
                  const selected = sw.value === t.color;
                  return (
                    <button
                      key={sw.value}
                      type="button"
                      title={sw.label}
                      onClick={() => {
                        const next = items.map((it, idx) => (idx === i ? { ...it, color: sw.value } : it));
                        setItems(next);
                        commit(next);
                      }}
                      className={`h-6 w-6 rounded ${sw.value.split(" ")[0]} ${
                        selected ? "ring-2 ring-offset-1 ring-foreground" : "ring-1 ring-border"
                      }`}
                    />
                  );
                })}
              </div>
            </div>
          </div>
        ))}
      </div>

      <Button size="sm" variant="outline" className="gap-1.5 h-8" onClick={addType}>
        <Plus className="h-3.5 w-3.5" />
        Add entity type
      </Button>
    </div>
  );
}

function FlushDataCard() {
  const queryClient = useQueryClient();
  const companyId = useCompanyId();
  const [confirmText, setConfirmText] = useState("");
  const [open, setOpen] = useState(false);

  const flushMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/pipeline/companies/${companyId}/flush-data`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "FLUSH" }),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json() as Promise<{
        ok: boolean;
        counts: Record<string, number>;
      }>;
    },
    onSuccess: (data) => {
      const total = Object.values(data.counts).reduce((a, b) => a + b, 0);
      toast.success(
        `Flushed ${total.toLocaleString()} rows across ${
          Object.keys(data.counts).length
        } tables. Configuration preserved.`
      );
      queryClient.invalidateQueries();
      setConfirmText("");
      setOpen(false);
    },
    onError: (err: Error) => {
      toast.error(`Flush failed: ${err.message}`);
    },
  });

  return (
    <Card className="mt-4 border-destructive/40">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-destructive" />
          <h2 className="text-sm font-semibold text-foreground">
            Danger zone — flush all pipeline data
          </h2>
        </div>
        <p className="text-xs text-muted-foreground">
          Deletes every collected post, actor run, entity, timeseries point,
          state row, and attribute mention for this company. Use this to test
          the pipeline end-to-end on a clean slate. Your configuration
          (scout queries, categories &amp; vocab, core vocab, entity types,
          synonyms, pipeline settings) is preserved; cron timestamps are
          reset so the next scheduled pull will treat this as a fresh start.
        </p>
      </CardHeader>
      <CardContent className="pt-2 pb-5">
        <AlertDialog open={open} onOpenChange={setOpen}>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" size="sm">
              <Trash2 className="h-3.5 w-3.5 mr-1.5" />
              Flush all data
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Flush all pipeline data?</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-2 text-sm">
                  <p>
                    This permanently deletes all collected and derived data
                    for this company. There is no undo.
                  </p>
                  <p className="text-xs">
                    <strong>Deleted:</strong> actor runs, launch batches, raw
                    signals, signal/entity links, entities, entity timeseries,
                    entity state, keyword interest, co-occurrences, composite
                    &amp; long-tail candidates, attribute signals, attribute
                    extraction log, attribute timeseries.
                  </p>
                  <p className="text-xs">
                    <strong>Preserved:</strong> scout queries, categories
                    &amp; attribute vocab, core vocabulary, entity types,
                    entity synonyms, pipeline settings.
                  </p>
                  <p className="pt-2">
                    Type{" "}
                    <code className="px-1 py-0.5 rounded bg-muted font-mono text-xs">
                      FLUSH
                    </code>{" "}
                    to confirm.
                  </p>
                  <Input
                    autoFocus
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value)}
                    placeholder="FLUSH"
                    className="font-mono"
                  />
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel
                onClick={() => setConfirmText("")}
                disabled={flushMutation.isPending}
              >
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => {
                  e.preventDefault();
                  flushMutation.mutate();
                }}
                disabled={
                  confirmText !== "FLUSH" || flushMutation.isPending
                }
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {flushMutation.isPending ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                    Flushing…
                  </>
                ) : (
                  "Flush all data"
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}

export default function ControlPanelPage() {
  return <ControlPanelInner />;
}

function ControlPanelInner() {
  const companyId = useCompanyId();
  const { data: config, isLoading, error } = useQuery({
    queryKey: ["pipeline-config", companyId],
    queryFn: () => fetchConfig(companyId),
    refetchOnWindowFocus: false,
  });

  const [local, setLocal] = useState<PipelineConfig | null>(null);

  useEffect(() => {
    if (config && !local) setLocal(config);
  }, [config]); // eslint-disable-line react-hooks/exhaustive-deps

  const queryClient = useQueryClient();
  const saveMutation = useMutation({
    mutationFn: (patch: Partial<PipelineConfig>) => patchConfig(companyId, patch),
    onSuccess: (updated) => {
      setLocal(updated);
      // Keep the react-query cache in sync so navigating away and back
      // within the configured staleTime doesn't re-hydrate `local` from a
      // stale snapshot (which would silently hide just-saved fields like
      // coreVocabulary, authorAllowlist, etc.).
      queryClient.setQueryData(["pipeline-config", companyId], updated);
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to save");
    },
  });

  const handleSave = useCallback(
    (key: string, value: unknown) => {
      saveMutation.mutate({ [key]: value } as Partial<PipelineConfig>);
    },
    [saveMutation]
  );

  const setField = <K extends keyof PipelineConfig>(key: K, value: PipelineConfig[K]) => {
    setLocal((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const ready = !!local;

  if (isLoading) {
    return (
      <div className="p-8 max-w-3xl mx-auto">
        <div className="mb-6">
          <Skeleton className="h-7 w-40 mb-2" />
          <Skeleton className="h-4 w-80" />
        </div>
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 w-full rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  if (error || !config) {
    return (
      <div className="p-8 max-w-3xl mx-auto">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {error instanceof Error ? error.message : "Failed to load pipeline configuration."}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const cfg = local ?? config;

  return (
    <div className="p-8 max-w-3xl mx-auto">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground mb-1">Control Panel</h1>
          <p className="text-muted-foreground text-sm">
            Tune pipeline parameters. Changes are auto-saved with a 500ms debounce.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {saveMutation.isPending && (
            <Badge variant="outline" className="gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Saving…
            </Badge>
          )}
        </div>
      </div>

      {/* Scout pull schedule */}
      <Card className="mb-4">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">Scout pull schedule</h2>
          </div>
          <p className="text-xs text-muted-foreground">
            When this fires, every active scout query is launched. After all runs
            finish, timeseries and state machine run automatically.
          </p>
        </CardHeader>
        <CardContent className="pt-2 pb-5">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <Label className="text-xs">Cadence</Label>
              <Select
                value={cfg.scoutPullCadence ?? "weekly"}
                onValueChange={(v) => {
                  setField("scoutPullCadence", v as PipelineConfig["scoutPullCadence"]);
                  handleSave("scoutPullCadence", v);
                }}
              >
                <SelectTrigger className="h-9 mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="manual">Manual only</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="biweekly">Biweekly</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Day of week (UTC)</Label>
              <Select
                value={String(cfg.scoutPullDow ?? 1)}
                onValueChange={(v) => {
                  const n = Number(v);
                  setField("scoutPullDow", n);
                  handleSave("scoutPullDow", n);
                }}
              >
                <SelectTrigger className="h-9 mt-1" disabled={cfg.scoutPullCadence === "manual"}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DOW_LABELS.map((label, i) => (
                    <SelectItem key={i} value={String(i)}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Hour (UTC)</Label>
              <Select
                value={String(cfg.scoutPullHourUtc ?? 6)}
                onValueChange={(v) => {
                  const n = Number(v);
                  setField("scoutPullHourUtc", n);
                  handleSave("scoutPullHourUtc", n);
                }}
              >
                <SelectTrigger className="h-9 mt-1" disabled={cfg.scoutPullCadence === "manual"}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 24 }, (_, h) => (
                    <SelectItem key={h} value={String(h)}>
                      {String(h).padStart(2, "0")}:00
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <span className="text-muted-foreground">
              Next scheduled pull:{" "}
              <span className="text-foreground font-medium">
                {formatNextPull(
                  cfg.scoutPullCadence ?? "weekly",
                  cfg.scoutPullDow ?? 1,
                  cfg.scoutPullHourUtc ?? 6,
                  cfg.lastScoutPullAt ?? null,
                )}
              </span>
            </span>
            {cfg.lastScoutPullAt && (
              <span className="text-muted-foreground">
                Last pull:{" "}
                <span className="text-foreground">
                  {new Date(cfg.lastScoutPullAt).toLocaleString()}
                </span>
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      <Accordion type="multiple" defaultValue={["tier1", "tier2", "tier3"]} className="space-y-3">
        {/* Tier 1 */}
        <Card>
          <AccordionItem value="tier1" className="border-0">
            <AccordionTrigger className="px-5 py-4 hover:no-underline">
              <div className="flex items-center gap-3">
                <Badge className="bg-blue-500 text-white border-0 text-xs">Tier 1</Badge>
                <span className="text-sm font-semibold">Signal Quality</span>
                <span className="text-xs text-muted-foreground font-normal">tune after run 1</span>
              </div>
            </AccordionTrigger>
            <AccordionContent>
              <div className="px-5">
                <NumberField
                  fieldKey="noiseFloor"
                  label="Noise Floor"
                  help="Minimum engagement threshold to consider a post as a signal. Range 1–50."
                  value={cfg.noiseFloor}
                  min={1}
                  max={50}
                  onChange={(v) => setField("noiseFloor", v)}
                  onSave={handleSave}
                  ready={ready}
                />
                <SliderField
                  fieldKey="commercialIntentThreshold"
                  label="Commercial Intent Threshold"
                  help="Minimum commercial intent score (0–1) required to include a post."
                  value={cfg.commercialIntentThreshold}
                  min={0}
                  max={1}
                  step={0.01}
                  onChange={(v) => setField("commercialIntentThreshold", v)}
                  onSave={handleSave}
                  ready={ready}
                />
                <SliderField
                  fieldKey="languageConfidenceThreshold"
                  label="Language Confidence Threshold"
                  help="Minimum confidence for language detection to accept a post."
                  value={cfg.languageConfidenceThreshold}
                  min={0}
                  max={1}
                  step={0.01}
                  onChange={(v) => setField("languageConfidenceThreshold", v)}
                  onSave={handleSave}
                  ready={ready}
                />
              </div>
            </AccordionContent>
          </AccordionItem>
        </Card>

        {/* Tier 2 */}
        <Card>
          <AccordionItem value="tier2" className="border-0">
            <AccordionTrigger className="px-5 py-4 hover:no-underline">
              <div className="flex items-center gap-3">
                <Badge className="bg-amber-500 text-white border-0 text-xs">Tier 2</Badge>
                <span className="text-sm font-semibold">Growth Detection</span>
                <span className="text-xs text-muted-foreground font-normal">tune after runs 2–4</span>
              </div>
            </AccordionTrigger>
            <AccordionContent>
              <div className="px-5">
                <NumberField
                  fieldKey="candidateToEmergingMinWeeks"
                  label="Candidate → Emerging Min Weeks"
                  help="Minimum weeks of sustained signal before a candidate is promoted to emerging."
                  value={cfg.candidateToEmergingMinWeeks}
                  min={1}
                  onChange={(v) => setField("candidateToEmergingMinWeeks", v)}
                  onSave={handleSave}
                  ready={ready}
                />
                <SliderField
                  fieldKey="candidateToEmergingMinWowGrowth"
                  label="Min WoW Growth"
                  help="Minimum week-over-week growth rate required for promotion to Emerging."
                  value={cfg.candidateToEmergingMinWowGrowth}
                  min={0}
                  max={1}
                  step={0.01}
                  onChange={(v) => setField("candidateToEmergingMinWowGrowth", v)}
                  onSave={handleSave}
                  ready={ready}
                />
                <NumberField
                  fieldKey="candidateToEmergingMinVolume"
                  label="Min Volume (30d)"
                  help="Minimum 30-day post count needed before a trend can be promoted."
                  value={cfg.candidateToEmergingMinVolume}
                  min={1}
                  onChange={(v) => setField("candidateToEmergingMinVolume", v)}
                  onSave={handleSave}
                  ready={ready}
                />
                <NumberField
                  fieldKey="minEvidenceForKnowledgeItem"
                  label="Min Evidence for Knowledge Item"
                  help="Minimum number of signals before a trend is surfaced as a Knowledge Item."
                  value={cfg.minEvidenceForKnowledgeItem}
                  min={1}
                  onChange={(v) => setField("minEvidenceForKnowledgeItem", v)}
                  onSave={handleSave}
                  ready={ready}
                />
                <SliderField
                  fieldKey="volatilityTolerance"
                  label="Volatility Tolerance"
                  help="Higher values allow more volatile trends to be promoted. Range 0.5–3.0."
                  value={cfg.volatilityTolerance}
                  min={0.5}
                  max={3}
                  step={0.1}
                  onChange={(v) => setField("volatilityTolerance", v)}
                  onSave={handleSave}
                  ready={ready}
                />
              </div>
            </AccordionContent>
          </AccordionItem>
        </Card>

        {/* Tier 3 */}
        <Card>
          <AccordionItem value="tier3" className="border-0">
            <AccordionTrigger className="px-5 py-4 hover:no-underline">
              <div className="flex items-center gap-3">
                <Badge className="bg-purple-500 text-white border-0 text-xs">Tier 3</Badge>
                <span className="text-sm font-semibold">Lifecycle</span>
                <span className="text-xs text-muted-foreground font-normal">tune after runs 4–8</span>
              </div>
            </AccordionTrigger>
            <AccordionContent>
              <div className="px-5">
                <NumberField
                  fieldKey="peakingWeeksNegVelocity"
                  label="Peaking → Declining Weeks"
                  help="Consecutive weeks of negative velocity before a peaking trend transitions to declining."
                  value={cfg.peakingWeeksNegVelocity}
                  min={1}
                  onChange={(v) => setField("peakingWeeksNegVelocity", v)}
                  onSave={handleSave}
                  ready={ready}
                />
                <NumberField
                  fieldKey="decliningWeeksNegVelocity"
                  label="Declining → Dormant Weeks"
                  help="Consecutive weeks of declining volume before a trend is marked dormant."
                  value={cfg.decliningWeeksNegVelocity}
                  min={1}
                  onChange={(v) => setField("decliningWeeksNegVelocity", v)}
                  onSave={handleSave}
                  ready={ready}
                />
                <NumberField
                  fieldKey="dormantThresholdWeeks"
                  label="Dormant Threshold Weeks"
                  help="Weeks without new evidence before a trend is marked dormant."
                  value={cfg.dormantThresholdWeeks}
                  min={1}
                  onChange={(v) => setField("dormantThresholdWeeks", v)}
                  onSave={handleSave}
                  ready={ready}
                />
                <NumberField
                  fieldKey="radarSurfaceMinSignalStrength"
                  label="Min Signal Strength (0–100)"
                  help="Minimum computed signal strength score before a trend appears in the Trends tab."
                  value={cfg.radarSurfaceMinSignalStrength}
                  min={0}
                  max={100}
                  onChange={(v) => setField("radarSurfaceMinSignalStrength", v)}
                  onSave={handleSave}
                  ready={ready}
                />
              </div>
            </AccordionContent>
          </AccordionItem>
        </Card>
      </Accordion>

      {/* Long-tail lane */}
      <Card className="mt-4">
        <CardHeader className="pb-2">
          <h2 className="text-sm font-semibold text-foreground">Emerging long-tail lane</h2>
          <p className="text-xs text-muted-foreground">
            Bayesian uplift evaluator that surfaces low-volume entities whose
            rate jumped vs prior-year (or prior 30-day) baseline. Tune the
            volume floor and posterior threshold to control how aggressively
            the Emerging tab proposes promotions.
          </p>
        </CardHeader>
        <CardContent className="pt-2 pb-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <NumberField
              fieldKey="longTailMinMentions"
              label="Min mentions (last 30d)"
              help="Entities below this floor are not evaluated. 1–100."
              value={(cfg.longTailMinMentions as number) ?? 5}
              min={1}
              max={100}
              onChange={(v) => setField("longTailMinMentions" as keyof PipelineConfig, v as never)}
              onSave={handleSave}
              ready={ready}
            />
            <SliderField
              fieldKey="longTailMinPosterior"
              label="Min posterior probability"
              help="Bayesian P(true rate ≥ 2× baseline). Higher = stricter. 0.50–0.99."
              value={(cfg.longTailMinPosterior as number) ?? 0.9}
              min={0.5}
              max={0.99}
              step={0.01}
              onChange={(v) => setField("longTailMinPosterior" as keyof PipelineConfig, v as never)}
              onSave={handleSave}
              ready={ready}
            />
          </div>
        </CardContent>
      </Card>

      {/* Composite co-occurrence lane (Task #3) */}
      <Card className="mt-4">
        <CardHeader className="pb-2">
          <h2 className="text-sm font-semibold text-foreground">Composite co-occurrence lane</h2>
          <p className="text-xs text-muted-foreground">
            Pair-level detector that surfaces entity pairs co-mentioned in
            the same posts more often than chance would predict. Tune the
            joint-mention floor, lift threshold, and rolling window to control
            how aggressively the Composite tab surfaces pairs.
          </p>
        </CardHeader>
        <CardContent className="pt-2 pb-5">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <NumberField
              fieldKey="compositeMinJointMentions"
              label="Min joint mentions"
              help="Pairs must co-occur in at least this many distinct signals. 2–100."
              value={(cfg.compositeMinJointMentions as number) ?? 5}
              min={2}
              max={100}
              onChange={(v) =>
                setField("compositeMinJointMentions" as keyof PipelineConfig, v as never)
              }
              onSave={handleSave}
              ready={ready}
            />
            <SliderField
              fieldKey="compositeMinLift"
              label="Min lift"
              help="Ratio of observed-to-expected joint count. Higher = stricter. 1–50."
              value={(cfg.compositeMinLift as number) ?? 2.0}
              min={1}
              max={50}
              step={0.1}
              onChange={(v) =>
                setField("compositeMinLift" as keyof PipelineConfig, v as never)
              }
              onSave={handleSave}
              ready={ready}
            />
            <NumberField
              fieldKey="compositeWindowDays"
              label="Window (days)"
              help="Rolling window for co-occurrence detection. 7–90."
              value={(cfg.compositeWindowDays as number) ?? 14}
              min={7}
              max={90}
              onChange={(v) =>
                setField("compositeWindowDays" as keyof PipelineConfig, v as never)
              }
              onSave={handleSave}
              ready={ready}
            />
          </div>
        </CardContent>
      </Card>

      {/* Author allowlist */}
      <Card className="mt-4">
        <CardContent className="pt-5 pb-5">
          <AuthorAllowlist
            authors={cfg.authorAllowlist ?? []}
            onSave={handleSave}
            isSaving={saveMutation.isPending}
            ready={ready}
          />
        </CardContent>
      </Card>

      {/* Core vocabulary */}
      <Card className="mt-4">
        <CardContent className="pt-5 pb-5">
          <CoreVocabulary
            terms={cfg.coreVocabulary ?? []}
            onSave={handleSave}
            isSaving={saveMutation.isPending}
            ready={ready}
          />
        </CardContent>
      </Card>

      {/* Categories & attribute vocabularies */}
      <Card className="mt-4">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">
              Categories &amp; attribute vocabularies
            </h2>
          </div>
          <p className="text-xs text-muted-foreground">
            Define product/topic categories and the controlled vocabulary of
            descriptors for each. The attribute extraction pass scores every
            post tagged with a category against that exact list of terms only.
          </p>
        </CardHeader>
        <CardContent className="pt-2 pb-5">
          <CategoriesEditor />
        </CardContent>
      </Card>

      {/* Danger zone: flush all pipeline data */}
      <FlushDataCard />

      {/* Entity types */}
      <Accordion type="single" collapsible defaultValue="entity-types" className="mt-4">
        <Card>
          <AccordionItem value="entity-types" className="border-0">
            <AccordionTrigger className="px-5 py-4 hover:no-underline">
              <div className="flex items-center gap-3">
                <Badge variant="outline" className="text-xs">Taxonomy</Badge>
                <span className="text-sm font-semibold">Entity Types</span>
                <span className="text-xs text-muted-foreground font-normal">
                  {cfg.entityTypes?.length ?? 0} types · drives extraction prompt
                </span>
              </div>
            </AccordionTrigger>
            <AccordionContent>
              <div className="px-5 pb-2">
                <EntityTypesEditor
                  types={cfg.entityTypes ?? []}
                  onSave={handleSave}
                  isSaving={saveMutation.isPending}
                  ready={ready}
                />
              </div>
            </AccordionContent>
          </AccordionItem>
        </Card>
      </Accordion>
    </div>
  );
}
