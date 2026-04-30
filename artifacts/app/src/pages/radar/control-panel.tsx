import { useQuery, useMutation } from "@tanstack/react-query";
import { useState, useEffect, useRef, useCallback } from "react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Slider } from "@/components/ui/slider";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircle, CheckCircle2, X, Plus, Loader2 } from "lucide-react";
import { toast } from "sonner";

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
  [key: string]: unknown;
}

async function fetchConfig(): Promise<PipelineConfig> {
  const res = await fetch("/api/pipeline/companies/1/pipeline-config");
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function patchConfig(patch: Partial<PipelineConfig>): Promise<PipelineConfig> {
  const res = await fetch("/api/pipeline/companies/1/pipeline-config", {
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

export default function ControlPanelPage() {
  const { data: config, isLoading, error } = useQuery({
    queryKey: ["pipeline-config"],
    queryFn: fetchConfig,
    refetchOnWindowFocus: false,
  });

  const [local, setLocal] = useState<PipelineConfig | null>(null);

  useEffect(() => {
    if (config && !local) setLocal(config);
  }, [config]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveMutation = useMutation({
    mutationFn: patchConfig,
    onSuccess: (updated) => {
      setLocal(updated);
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
    </div>
  );
}
