import { HardDrive } from 'lucide-react';
import { useSettings, useUpdateSettings } from '@/components/chrome';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';
import type { Settings } from '@shared/schema';

export default function SettingsPage() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();

  if (!settings) {
    return <div className="h-64 animate-pulse rounded-lg bg-muted" />;
  }

  const set = (patch: Partial<Settings>) => update.mutate(patch);

  return (
    <div className="max-w-2xl space-y-10">
      <div>
        <h1 className="font-serif text-2xl font-semibold tracking-tight text-foreground">Settings</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Stored in the same local database as your books and sessions.
        </p>
      </div>

      <Section title="Typing">
        <Toggle
          label="Strict mode"
          hint="The cursor holds until a mistake is corrected. Off means errors are marked and you keep going."
          checked={settings.strictMode === 1}
          onChange={(v) => set({ strictMode: v ? 1 : 0 })}
          testId="switch-strict"
        />
        <Toggle
          label="Auto-indent code"
          hint="After Enter inside a listing, leading whitespace on the next line is filled in for you."
          checked={settings.autoIndent === 1}
          onChange={(v) => set({ autoIndent: v ? 1 : 0 })}
          testId="switch-autoindent"
        />
        <Toggle
          label="Skip code listings"
          hint="Read listings instead of typing them. Figures are always read, never typed."
          checked={settings.skipCode === 1}
          onChange={(v) => set({ skipCode: v ? 1 : 0 })}
          testId="switch-skipcode"
        />
      </Section>

      <Section title="Reading">
        <Choice
          label="Prose typeface"
          hint="Listings always use the monospace face."
          value={settings.typeface}
          options={[
            { value: 'serif', label: 'Serif' },
            { value: 'sans', label: 'Sans' },
          ]}
          onChange={(value) => set({ typeface: value })}
          testId="choice-typeface"
        />

        <Range
          label="Text size"
          value={settings.fontSize}
          min={14}
          max={32}
          step={1}
          suffix="px"
          onCommit={(value) => set({ fontSize: value })}
          testId="slider-fontsize"
        />

        <Choice
          label="Theme"
          value={settings.theme}
          options={[
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
          onChange={(value) => set({ theme: value })}
          testId="choice-theme"
        />
      </Section>

      <Section title="Import">
        <Toggle
          label="Normalise punctuation in prose"
          hint="Curly quotes, em dashes, and ellipses become ASCII so you are never asked for a character your keyboard cannot produce. Listings are always normalised."
          checked={settings.normalizePunctuation === 1}
          onChange={(v) => set({ normalizePunctuation: v ? 1 : 0 })}
          testId="switch-normalize"
        />

        <Range
          label="Prose block length"
          hint="Target characters per typing block. Applies to books imported from now on."
          value={settings.chunkSize}
          min={120}
          max={600}
          step={20}
          suffix="chars"
          onCommit={(value) => set({ chunkSize: value })}
          testId="slider-chunksize"
        />
      </Section>

      <div className="flex gap-3 rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
        <HardDrive className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          Books, extracted figures, progress, and session history live in{' '}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">./data</code> next to the
          app. Back up that folder and you have backed up everything. Delete it and the app starts
          fresh.
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Controls
 * ------------------------------------------------------------------ */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-4 text-sm font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-card-border bg-card">
        {children}
      </div>
    </section>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-6 px-4 py-4">
      <div className="min-w-0">
        <div className="text-sm text-foreground">{label}</div>
        {hint && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{hint}</p>}
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
  testId,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  testId: string;
}) {
  return (
    <Row label={label} hint={hint}>
      <Switch checked={checked} onCheckedChange={onChange} data-testid={testId} />
    </Row>
  );
}

function Choice<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
  testId,
}: {
  label: string;
  hint?: string;
  value: string;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  testId: string;
}) {
  return (
    <Row label={label} hint={hint}>
      <div className="flex overflow-hidden rounded-md border border-border" data-testid={testId}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={cn(
              'px-3 py-1.5 text-sm',
              value === option.value
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover-elevate active-elevate-2'
            )}
            data-testid={`${testId}-${option.value}`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </Row>
  );
}

function Range({
  label,
  hint,
  value,
  min,
  max,
  step,
  suffix,
  onCommit,
  testId,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  onCommit: (value: number) => void;
  testId: string;
}) {
  return (
    <Row label={label} hint={hint}>
      <div className="flex w-48 items-center gap-3">
        <Slider
          value={[value]}
          min={min}
          max={max}
          step={step}
          onValueCommit={([next]) => onCommit(next)}
          data-testid={testId}
        />
        <span className="w-16 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
          {value} {suffix}
        </span>
      </div>
    </Row>
  );
}
