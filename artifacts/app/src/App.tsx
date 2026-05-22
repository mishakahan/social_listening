import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Suspense, lazy } from "react";
import NotFound from "@/pages/not-found";
import { AppLayout } from "@/shells/AppLayout";

const RadarSetupPage = lazy(() => import("@/pages/radar/setup"));
const SeedsAuditPage = lazy(() => import("@/pages/radar/audit/seeds"));
const QueriesAuditPage = lazy(() => import("@/pages/radar/audit/queries"));
const RunsAuditPage = lazy(() => import("@/pages/radar/audit/runs"));
const SignalsAuditPage = lazy(() => import("@/pages/radar/audit/signals"));
const EntitiesAuditPage = lazy(() => import("@/pages/radar/audit/entities"));
const TrendsListPage = lazy(() => import("@/pages/radar/trends/list"));
const TrendDetailPage = lazy(() => import("@/pages/radar/trends/detail"));
const ControlPanelPage = lazy(() => import("@/pages/radar/control-panel"));
const EmergingPage = lazy(() => import("@/pages/radar/emerging"));
const AttributesPage = lazy(() => import("@/pages/radar/attributes"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 2 },
  },
});

function RadarRouter() {
  return (
    <AppLayout>
      <Suspense fallback={<div className="flex items-center justify-center h-full"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>}>
        <Switch>
          <Route path="/" component={() => <Redirect to="/radar/setup" />} />
          <Route path="/radar/setup" component={RadarSetupPage} />
          <Route path="/radar/audit/seeds" component={SeedsAuditPage} />
          <Route path="/radar/audit/queries" component={QueriesAuditPage} />
          <Route path="/radar/audit/runs" component={RunsAuditPage} />
          <Route path="/radar/audit/signals" component={SignalsAuditPage} />
          <Route path="/radar/audit/entities" component={EntitiesAuditPage} />
          <Route path="/radar/trends/:trendId" component={TrendDetailPage} />
          <Route path="/radar/trends" component={TrendsListPage} />
          <Route path="/radar/emerging" component={EmergingPage} />
          <Route path="/radar/attributes" component={AttributesPage} />
          <Route path="/radar/control-panel" component={ControlPanelPage} />
          <Route component={NotFound} />
        </Switch>
      </Suspense>
    </AppLayout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <RadarRouter />
        </WouterRouter>
        <Toaster />
        <Sonner />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
