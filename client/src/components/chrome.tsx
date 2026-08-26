import { useEffect, useMemo } from 'react';
import { Link, useLocation } from 'wouter';
import { useMutation, useQuery } from '@tanstack/react-query';
import { BarChart3, BookOpen, Keyboard, Moon, Settings as SettingsIcon, Sun, Upload } from 'lucide-react';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { cn } from '@/lib/utils';
import type { Settings } from '@shared/schema';

/* ------------------------------------------------------------------ *
 * Logo — a pen nib, drawn as one geometric mark
 * ------------------------------------------------------------------ */

export function Logo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={cn('h-6 w-6', className)}
      aria-label="Typewright"
      role="img"
    >
      <path
        d="M12 2.5 19 15.5 12 21.5 5 15.5Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M12 9.5V21.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="12" cy="8" r="1.7" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

/* ------------------------------------------------------------------ *
 * Settings-backed theme
 *
 * The preference lives in the local database rather than localStorage, so it
 * survives restarts and works inside a sandboxed frame.
 * ------------------------------------------------------------------ */

export function useSettings() {
  return useQuery<Settings>({ queryKey: ['/api/settings'] });
}

export function useUpdateSettings() {
  return useMutation({
    mutationFn: async (patch: Partial<Settings>) => {
      const res = await apiRequest('PATCH', '/api/settings', patch);
      return (await res.json()) as Settings;
    },
    onSuccess: (settings) => queryClient.setQueryData(['/api/settings'], settings),
  });
}

export function ThemeSync() {
  const { data: settings } = useSettings();
  const theme = settings?.theme ?? 'system';

  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia('(prefers-color-scheme: dark)');

    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches);
      root.classList.toggle('dark', dark);
    };

    apply();
    if (theme !== 'system') return;
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);

  return null;
}

export function ThemeToggle() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();

  const isDark = useMemo(() => {
    if (!settings) return false;
    if (settings.theme === 'dark') return true;
    if (settings.theme === 'light') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }, [settings]);

  return (
    <button
      type="button"
      onClick={() => update.mutate({ theme: isDark ? 'light' : 'dark' })}
      className="rounded-md p-2 text-muted-foreground hover-elevate active-elevate-2"
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      data-testid="button-theme-toggle"
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * Shell
 * ------------------------------------------------------------------ */

const NAV = [
  { href: '/', label: 'Library', icon: BookOpen },
  { href: '/import', label: 'Import', icon: Upload },
  { href: '/stats', label: 'Progress', icon: BarChart3 },
  { href: '/shortcuts', label: 'Shortcuts', icon: Keyboard },
  { href: '/settings', label: 'Settings', icon: SettingsIcon },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 sm:gap-6 sm:px-6">
          <Link
            href="/"
            className="flex items-center gap-2 text-foreground"
            data-testid="link-home"
          >
            <Logo className="h-5 w-5 shrink-0 text-primary" />
            <span className="hidden font-serif text-lg font-semibold tracking-tight sm:inline">
              Typewright
            </span>
          </Link>

          <nav className="flex items-center gap-1">
            {NAV.map(({ href, label, icon: Icon }) => {
              const active = href === '/' ? location === '/' : location.startsWith(href);
              return (
                <Link
                  key={href}
                  href={href}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover-elevate active-elevate-2 sm:px-3',
                    active ? 'bg-secondary text-foreground' : 'text-muted-foreground'
                  )}
                  data-testid={`link-nav-${label.toLowerCase()}`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="hidden md:inline">{label}</span>
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            {/* Only shown once the nav has room to spare for it. */}
            <span className="hidden text-xs text-muted-foreground lg:inline">
              Local only — nothing leaves this machine
            </span>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Small shared pieces
 * ------------------------------------------------------------------ */

export function Stat({
  label,
  value,
  suffix,
  testId,
}: {
  label: string;
  value: string | number;
  suffix?: string;
  testId?: string;
}) {
  return (
    <div className="rounded-lg border border-card-border bg-card px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-lg tabular-nums text-foreground" data-testid={testId}>
        {value}
        {suffix ? <span className="ml-1 text-sm text-muted-foreground">{suffix}</span> : null}
      </div>
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-card/50 px-6 py-16 text-center">
      <Icon className="mx-auto h-8 w-8 text-muted-foreground" />
      <h2 className="mt-4 font-serif text-lg text-foreground">{title}</h2>
      <div className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">{children}</div>
    </div>
  );
}
