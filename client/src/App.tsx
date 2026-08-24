import { Route, Router, Switch, useLocation } from 'wouter';
import { useHashLocation } from 'wouter/use-hash-location';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './lib/queryClient';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AppShell, ThemeSync } from '@/components/chrome';
import LibraryPage from '@/pages/library';
import TypingPage from '@/pages/typing';
import StatsPage from '@/pages/stats';
import SettingsPage from '@/pages/settings';
import NotFound from '@/pages/not-found';

/**
 * The typing view is deliberately outside the app shell — no nav, no chrome,
 * nothing competing with the page you are typing.
 */
function Routes() {
  const [location] = useLocation();
  const focused = location.startsWith('/type/');

  const routes = (
    <Switch>
      <Route path="/" component={LibraryPage} />
      <Route path="/type/:id" component={TypingPage} />
      <Route path="/stats" component={StatsPage} />
      <Route path="/settings" component={SettingsPage} />
      <Route component={NotFound} />
    </Switch>
  );

  return focused ? routes : <AppShell>{routes}</AppShell>;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ThemeSync />
        <Toaster />
        <Router hook={useHashLocation}>
          <Routes />
        </Router>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
