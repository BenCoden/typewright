import { HardDrive, Keyboard } from 'lucide-react';
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
        <Choice
          label="Caret style"
          hint="Shape of the marker at your current position."
          value={settings.caretStyle}
          options={[
            { value: 'line', label: 'Line' },
            { value: 'block', label: 'Block' },
            { value: 'underline', label: 'Underline' },
          ]}
          onChange={(value) => set({ caretStyle: value })}
          testId="choice-caretstyle"
        />
        <Toggle
          label="Keep active line in position"
          hint="Holds the line you're typing at a fixed spot on screen instead of scrolling freely."
          checked={settings.keepInPosition === 1}
          onChange={(v) => set({ keepInPosition: v ? 1 : 0 })}
          testId="switch-keepinposition"
        />
        <Toggle
          label="Mark incorrect words"
          hint="Underline the whole word on a mistake, not just the missed character."
          checked={settings.markIncorrectWords === 1}
          onChange={(v) => set({ markIncorrectWords: v ? 1 : 0 })}
          testId="switch-markincorrectwords"
        />
        <Choice
          label="Auto-pause"
          hint="How long you can sit idle mid-block before the timer pauses itself."
          value={String(settings.autoPauseMs)}
          options={[
            { value: '2000', label: '2 sec' },
            { value: '5000', label: '5 sec' },
            { value: '10000', label: '10 sec' },
            { value: '0', label: 'Never' },
          ]}
          onChange={(value) => set({ autoPauseMs: Number(value) })}
          testId="choice-autopause"
        />
      </Section>

      <Section title="Reading mode">
        <Range
          label="Reading text size"
          hint="Applies only to reading mode (Ctrl+M), separate from the typing text size above."
          value={settings.readingFontSize}
          min={14}
          max={32}
          step={1}
          suffix="px"
          onCommit={(value) => set({ readingFontSize: value })}
          testId="slider-readingfontsize"
        />
        <Choice
          label="Reading line height"
          value={settings.readingLineHeight}
          options={[
            { value: 'xs', label: 'XS' },
            { value: 's', label: 'S' },
            { value: 'm', label: 'M' },
            { value: 'l', label: 'L' },
            { value: 'xl', label: 'XL' },
          ]}
          onChange={(value) => set({ readingLineHeight: value })}
          testId="choice-readinglineheight"
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

      <Section title="Keyboard shortcuts">
        <ShortcutRow keys={['Esc']} label="Pause / resume" />
        <ShortcutRow keys={['Ctrl', 'M']} label="Toggle reading mode" />
        <ShortcutRow keys={['Ctrl', '\u2193']} label="Skip the rest of the current line (code listings)" />
        <ShortcutRow keys={['Ctrl', '\u2192']} label="Skip the current paragraph, listing, or figure" />
        <ShortcutRow keys={['Tab']} label="Consume expected indentation (code listings)" />
        <ShortcutRow keys={['Backspace']} label="Correct a mistake; steps back over auto-indent in one move" />
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

function ShortcutRow({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3">
      <div className="flex items-center gap-2 text-sm text-foreground">
        <Keyboard className="h-3.5 w-3.5 text-muted-foreground" />
        {label}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {keys.map((k, i) => (
          <kbd
            key={i}
            className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground"
          >
            {k}
          </kbd>
        ))}
      </div>
    </div>
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
