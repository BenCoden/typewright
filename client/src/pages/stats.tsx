import { useQuery } from '@tanstack/react-query';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Activity, Flame } from 'lucide-react';
import { EmptyState, Stat } from '@/components/chrome';
import type { StatsSummary } from '@shared/schema';

export default function StatsPage() {
  const { data, isLoading } = useQuery<StatsSummary>({ queryKey: ['/api/stats'] });

  if (isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-20 animate-pulse rounded-lg bg-muted" />
        ))}
      </div>
    );
  }

  if (!data || data.totals.sessions === 0) {
    return (
      <EmptyState icon={Activity} title="No sessions recorded yet">
        Type for a minute or two and your speed, accuracy, and weakest keys will show up here.
      </EmptyState>
    );
  }

  const { totals, daily, recent, worstKeys, streak } = data;
  const chartData = daily.map((d) => ({
    day: d.day.slice(5),
    wpm: d.wpm,
    accuracy: Math.round(d.accuracyBp / 100),
    minutes: d.minutes,
  }));

  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="font-serif text-2xl font-semibold tracking-tight text-foreground">Progress</h1>
        {streak > 0 && (
          <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Flame className="h-4 w-4 text-primary" />
            <span data-testid="text-streak">
              {streak} day{streak === 1 ? '' : 's'} in a row
            </span>
          </div>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Average" value={totals.avgWpm} suffix="wpm" testId="text-avg-wpm" />
        <Stat label="Best session" value={totals.bestWpm} suffix="wpm" testId="text-best-wpm" />
        <Stat
          label="Accuracy"
          value={`${(totals.accuracyBp / 100).toFixed(1)}%`}
          testId="text-accuracy"
        />
        <Stat {...duration(totals.activeMs)} testId="text-minutes" />
      </div>

      {/* Prose and code are different skills, so they get separate numbers. */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Stat label="Prose speed" value={totals.proseWpm} suffix="wpm" testId="text-prose-wpm" />
        <Stat label="Code speed" value={totals.codeWpm} suffix="wpm" testId="text-code-wpm" />
      </div>

      {/* One data point is not a trend, so the chart waits for a second day. */}
      {chartData.length >= 2 && (
      <section>
        <h2 className="mb-4 text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Last {chartData.length} active days
        </h2>
        <div className="h-64 rounded-lg border border-card-border bg-card p-4">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
              <defs>
                <linearGradient id="wpmFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(var(--chart-1))" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="hsl(var(--chart-1))" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="hsl(var(--border))" vertical={false} />
              <XAxis
                dataKey="day"
                stroke="hsl(var(--muted-foreground))"
                fontSize={12}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                stroke="hsl(var(--muted-foreground))"
                fontSize={12}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip
                contentStyle={{
                  background: 'hsl(var(--popover))',
                  border: '1px solid hsl(var(--popover-border))',
                  borderRadius: 8,
                  fontSize: 12,
                  color: 'hsl(var(--popover-foreground))',
                }}
              />
              <Area
                type="monotone"
                dataKey="wpm"
                stroke="hsl(var(--chart-1))"
                strokeWidth={2}
                fill="url(#wpmFill)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </section>
      )}

      {worstKeys.length > 0 && (
        <section>
          <h2 className="mb-4 text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Characters you miss most
          </h2>
          <div className="flex flex-wrap gap-2">
            {worstKeys.map(({ key, count }) => (
              <div
                key={key}
                className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5"
                data-testid={`chip-key-${key}`}
              >
                <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm text-foreground">
                  {label(key)}
                </kbd>
                <span className="font-mono text-xs text-muted-foreground">{count}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-4 text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Recent sessions
        </h2>
        <div className="overflow-hidden rounded-lg border border-card-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Book</th>
                <th className="px-4 py-2 text-right font-medium">WPM</th>
                <th className="px-4 py-2 text-right font-medium">Accuracy</th>
                <th className="hidden px-4 py-2 text-right font-medium sm:table-cell">Minutes</th>
                <th className="hidden px-4 py-2 text-right font-medium sm:table-cell">When</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((session) => (
                <tr key={session.id} className="border-t border-border bg-card">
                  <td className="max-w-[16rem] truncate px-4 py-2 text-foreground">
                    {session.bookTitle}
                  </td>
                  <td className="px-4 py-2 text-right font-mono tabular-nums">{session.wpm}</td>
                  <td className="px-4 py-2 text-right font-mono tabular-nums">
                    {(session.accuracyBp / 100).toFixed(1)}%
                  </td>
                  <td className="hidden px-4 py-2 text-right font-mono tabular-nums sm:table-cell">
                    {Math.max(1, Math.round(session.durationMs / 60000))}
                  </td>
                  <td className="hidden px-4 py-2 text-right text-muted-foreground sm:table-cell">
                    {new Date(session.endedAt).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

/** Picks the unit that keeps the number readable. */
function duration(ms: number): { label: string; value: string | number; suffix: string } {
  if (ms < 60_000) return { label: 'Time typed', value: Math.round(ms / 1000), suffix: 'sec' };
  if (ms < 3_600_000) return { label: 'Time typed', value: Math.round(ms / 60_000), suffix: 'min' };
  return { label: 'Time typed', value: (ms / 3_600_000).toFixed(1), suffix: 'hrs' };
}

/** Whitespace and newline keys need a printable stand-in. */
function label(key: string): string {
  if (key === ' ') return 'space';
  if (key === '\n') return '⏎';
  if (key === '\t') return 'tab';
  return key;
}
