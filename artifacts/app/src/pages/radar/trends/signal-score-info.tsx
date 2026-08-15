import { Info } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface SignalScoreInfoProps {
  className?: string;
  iconSize?: "sm" | "md";
  align?: "start" | "center" | "end";
}

export function SignalScoreInfo({
  className,
  iconSize = "sm",
  align = "center",
}: SignalScoreInfoProps) {
  const sizeClass = iconSize === "md" ? "h-4 w-4" : "h-3.5 w-3.5";

  return (
    <Popover>
      <PopoverTrigger
        type="button"
        aria-label="How signal strength is calculated"
        className={cn(
          "inline-flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <Info className={sizeClass} />
      </PopoverTrigger>
      <PopoverContent
        align={align}
        className="w-80 text-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="space-y-3">
          <div>
            <p className="font-semibold text-foreground">How signal strength is calculated</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              A 0–100 percentile for how well-evidenced a trend is, relative to
              everything else on this radar.
            </p>
          </div>

          <p className="text-sm">
            It ranks each trend against the others on two things:
          </p>
          <ul className="space-y-2 text-sm">
            <li className="flex items-start gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-foreground shrink-0" />
              <span>
                <span className="font-medium">Volume of evidence.</span>{" "}
                <span className="text-muted-foreground">
                  How many posts mention it in the last 30 days.
                </span>
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-foreground shrink-0" />
              <span>
                <span className="font-medium">Spread across platforms.</span>{" "}
                <span className="text-muted-foreground">
                  The same volume carries more weight when it comes from several
                  places rather than one.
                </span>
              </span>
            </li>
          </ul>

          <p className="text-xs text-muted-foreground">
            A score of 80 means it is better evidenced than 80% of the trends on
            this radar. It deliberately excludes growth — that is what the
            Movement column measures. Being a percentile rather than a fixed
            formula means it stays meaningful however much data we collect.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
