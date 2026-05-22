import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard, Search, ClipboardCheck, PlayCircle, TrendingUp,
  Settings, Radar, ChevronRight, Activity, Tag, Sparkles, Layers,
} from "lucide-react";

const navItems = [
  { href: "/radar/setup", label: "Setup", icon: LayoutDashboard },
  { href: "/radar/audit/seeds", label: "Seeds", parent: "Audit", icon: Search },
  { href: "/radar/audit/queries", label: "Queries", parent: "Audit", icon: ClipboardCheck },
  { href: "/radar/audit/runs", label: "Runs", parent: "Audit", icon: PlayCircle },
  { href: "/radar/audit/signals", label: "Signals", parent: "Audit", icon: Activity },
  { href: "/radar/audit/entities", label: "Entities", parent: "Audit", icon: Tag },
  { href: "/radar/trends", label: "Trends", icon: TrendingUp },
  { href: "/radar/emerging", label: "Emerging", icon: Sparkles },
  { href: "/radar/attributes", label: "Attributes", icon: Layers },
  { href: "/radar/control-panel", label: "Control Panel", icon: Settings },
];

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  return (
    <div className="flex h-screen bg-background">
      {/* Left nav */}
      <aside className="w-60 flex-shrink-0 border-r border-border bg-sidebar flex flex-col">
        <div className="h-14 flex items-center px-4 border-b border-border">
          <Radar className="h-5 w-5 text-primary mr-2" />
          <span className="font-semibold text-foreground">Trend Pipeline</span>
        </div>
        <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider px-2 py-1">RADAR</p>
          {navItems.map((item) => {
            const isActive = location === item.href || location.startsWith(item.href + "/");
            const Icon = item.icon;
            return (
              <Link key={item.href} href={item.href}>
                <a className={cn(
                  "flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors",
                  isActive
                    ? "bg-primary/10 text-primary font-medium"
                    : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                  item.parent && "ml-4"
                )}>
                  <Icon className="h-4 w-4 flex-shrink-0" />
                  {item.label}
                </a>
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 border-b border-border bg-background flex items-center px-6">
          <Breadcrumbs location={location} />
        </header>
        <main className="flex-1 min-h-0 overflow-auto">
          {children}
        </main>
      </div>
    </div>
  );
}

function Breadcrumbs({ location }: { location: string }) {
  const parts = location.split("/").filter(Boolean);
  const labels: Record<string, string> = {
    radar: "Radar",
    setup: "Setup",
    audit: "Audit",
    seeds: "Seeds",
    queries: "Queries",
    runs: "Runs",
    signals: "Signals",
    entities: "Entities",
    trends: "Trends",
    "control-panel": "Control Panel",
  };

  return (
    <nav className="flex items-center gap-1 text-sm text-muted-foreground">
      {parts.map((part, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <ChevronRight className="h-3 w-3" />}
          <span className={i === parts.length - 1 ? "text-foreground font-medium" : ""}>
            {labels[part] ?? part}
          </span>
        </span>
      ))}
    </nav>
  );
}
