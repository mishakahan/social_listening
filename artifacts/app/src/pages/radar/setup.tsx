import { useState, useCallback } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Loader2,
  Sparkles,
  AlertCircle,
  CheckCircle2,
  Target,
  Plus,
  Trash2,
} from "lucide-react";

const MIN_BRIEF_LENGTH = 500;

interface WatchTopicDraft {
  title: string;
  description: string;
}

export default function RadarSetupPage() {
  const [, navigate] = useLocation();
  const [brief, setBrief] = useState("");
  const [watchTopics, setWatchTopics] = useState<WatchTopicDraft[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const charCount = brief.length;
  const isReady = charCount >= MIN_BRIEF_LENGTH;

  const addWatchTopic = useCallback(() => {
    setWatchTopics((prev) => [...prev, { title: "", description: "" }]);
  }, []);

  const updateWatchTopic = useCallback(
    (index: number, field: keyof WatchTopicDraft, value: string) => {
      setWatchTopics((prev) =>
        prev.map((t, i) => (i === index ? { ...t, [field]: value } : t))
      );
    },
    []
  );

  const removeWatchTopic = useCallback((index: number) => {
    setWatchTopics((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!isReady || isSubmitting) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const cleanedWatchTopics = watchTopics
        .map((t) => ({ title: t.title.trim(), description: t.description.trim() }))
        .filter((t) => t.title.length > 0);
      const res = await fetch("/api/pipeline/companies/1/setup-radar/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief, watchTopics: cleanedWatchTopics }),
      });
      if (!res.ok) {
        const contentType = res.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          const json = await res.json();
          throw new Error(json.error || `Request failed: ${res.status}`);
        }
        throw new Error(`Request failed: ${res.status}. The API server may still be starting up — please try again in a moment.`);
      }
      const data = await res.json();
      navigate(`/radar/audit/seeds?candidateId=${data.candidateId ?? data.id ?? ""}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An unexpected error occurred.");
    } finally {
      setIsSubmitting(false);
    }
  }, [brief, watchTopics, isReady, isSubmitting, navigate]);

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-foreground mb-1">Company Brief</h1>
        <p className="text-muted-foreground text-sm">
          Describe your company to generate trend-tracking seed topics
        </p>
      </div>

      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-base flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            Company Overview
          </CardTitle>
          <CardDescription>
            Write a free-form description of your business. The more context you provide, the more
            relevant your seed topics will be.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            rows={10}
            placeholder={`Describe your company in free form. Include whatever feels relevant — what you do, who you sell to, what you make, where you sell it, who your competitors are, what strategic priorities matter right now, any brand positioning, and the kind of innovation territories you want to watch. Don't worry about structure — write it as if you were explaining the business to a new analyst joining the team.`}
            className="resize-none text-sm leading-relaxed"
            disabled={isSubmitting}
          />

          {/* Character counter */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {isReady ? (
                <CheckCircle2 className="h-4 w-4 text-green-500" />
              ) : (
                <div className="h-4 w-4" />
              )}
              <span
                className={`text-sm font-medium tabular-nums ${
                  isReady ? "text-green-600" : "text-muted-foreground"
                }`}
              >
                {charCount.toLocaleString()} / {MIN_BRIEF_LENGTH.toLocaleString()} minimum characters
              </span>
            </div>
            {!isReady && charCount > 0 && (
              <span className="text-xs text-muted-foreground">
                {MIN_BRIEF_LENGTH - charCount} more to go
              </span>
            )}
          </div>

          {/* Progress bar */}
          <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-300 ${
                isReady ? "bg-green-500" : "bg-primary"
              }`}
              style={{ width: `${Math.min(100, (charCount / MIN_BRIEF_LENGTH) * 100)}%` }}
            />
          </div>

        </CardContent>
      </Card>

      {/* Watch Topics */}
      <Card className="mt-6">
        <CardHeader className="pb-4">
          <CardTitle className="text-base flex items-center gap-2">
            <Target className="h-4 w-4 text-primary" />
            Watch Topics
            <span className="text-xs font-normal text-muted-foreground">
              (optional)
            </span>
          </CardTitle>
          <CardDescription>
            Strategic themes that anchor what your radar tracks. Seeds will be
            generated to ladder up to each topic. Pitch these at the altitude of
            a strategic question — e.g.{" "}
            <span className="italic">
              “LATAM consumer trends in chicken-based products”
            </span>
            . Leave empty to let the brief drive generation on its own.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {watchTopics.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No watch topics yet. Add one to steer seed generation.
            </p>
          )}

          {watchTopics.map((topic, i) => (
            <div
              key={i}
              className="rounded-lg border border-border p-3 space-y-2 bg-muted/20"
            >
              <div className="flex items-center gap-2">
                <Input
                  value={topic.title}
                  onChange={(e) => updateWatchTopic(i, "title", e.target.value)}
                  placeholder="Topic title (e.g. LATAM consumer trends in chicken-based products)"
                  className="text-sm"
                  disabled={isSubmitting}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="flex-shrink-0 text-muted-foreground hover:text-red-600"
                  onClick={() => removeWatchTopic(i)}
                  disabled={isSubmitting}
                  aria-label="Remove watch topic"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              <Textarea
                value={topic.description}
                onChange={(e) =>
                  updateWatchTopic(i, "description", e.target.value)
                }
                rows={2}
                placeholder="Short description — what this theme covers and why it matters (optional)"
                className="resize-none text-sm leading-relaxed"
                disabled={isSubmitting}
              />
            </div>
          ))}

          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={addWatchTopic}
            disabled={isSubmitting}
          >
            <Plus className="h-4 w-4" />
            Add watch topic
          </Button>
        </CardContent>
      </Card>

      {/* Error */}
      {error && (
        <Alert variant="destructive" className="mt-6">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Submit */}
      <div className="flex justify-end pt-6">
        <Button
          onClick={handleSubmit}
          disabled={!isReady || isSubmitting}
          size="lg"
          className="gap-2"
        >
          {isSubmitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Generating…
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4" />
              Generate Seed Topics
            </>
          )}
        </Button>
      </div>

      {/* Tips */}
      <div className="mt-6 p-4 rounded-lg bg-muted/50 border border-border">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
          What to include
        </p>
        <ul className="text-sm text-muted-foreground space-y-1 list-disc list-inside">
          <li>Core products or services and target customers</li>
          <li>Key markets and geographies</li>
          <li>Main competitors and brand positioning</li>
          <li>Strategic priorities and innovation areas to watch</li>
        </ul>
      </div>
    </div>
  );
}
