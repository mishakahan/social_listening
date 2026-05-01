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
              A 0–100 score blending recent volume with growth.
            </p>
          </div>

          <p className="text-sm">
            Three ingredients are added together with these weights, then the result is rounded
            and capped at 100:
          </p>
          <ul className="space-y-2 text-sm">
            <li className="flex items-start gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-foreground shrink-0" />
              <span>
                <span className="font-medium">Recent volume — weight 30.</span>{" "}
                <span className="text-muted-foreground">
                  Mentions in the last 7 days, divided by 10. So 10 mentions adds 30, 20 mentions
                  adds 60.
                </span>
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-foreground shrink-0" />
              <span>
                <span className="font-medium">Week-over-week growth — weight 40.</span>{" "}
                <span className="text-muted-foreground">
                  Positive WoW growth rate × 40 (e.g. +50% growth adds 20).
                </span>
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-foreground shrink-0" />
              <span>
                <span className="font-medium">Month-over-month growth — weight 30.</span>{" "}
                <span className="text-muted-foreground">
                  Positive MoM growth rate × 30.
                </span>
              </span>
            </li>
          </ul>

          <div className="rounded-md bg-muted px-2.5 py-2 font-mono text-xs leading-relaxed text-muted-foreground">
            score = min(100, round(
            <br />
            &nbsp;&nbsp;(volume7d / 10) × 30
            <br />
            &nbsp;&nbsp;+ max(0, growthWoW) × 40
            <br />
            &nbsp;&nbsp;+ max(0, growthMoM) × 30
            <br />
            ))
          </div>

          <p className="text-xs text-muted-foreground">
            Only positive growth contributes — declining trends earn points only from raw volume.
            A high-volume trend can hit 100 from volume alone. Scores above 70 show in green,
            40–69 in amber, below 40 in gray.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
