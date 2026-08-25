import { Keyboard, X } from 'lucide-react';

/**
 * Shortcut reference, shared by the in-session overlay and the settings page so
 * the two can never drift apart.
 *
 * Printable keys are all consumed by the typing engine, so every in-session
 * command is on a modifier. Reading mode is the exception: nothing is being
 * scored there, which frees the bare keys for navigation.
 */
export interface Shortcut {
  keys: string[];
  label: string;
  /** Which mode the shortcut applies in. */
  scope: 'typing' | 'reading' | 'both';
}

/** Separator token rendered as the word "or", so a literal "/" stays a key. */
export const OR = '\u0000or';

export const SHORTCUTS: Shortcut[] = [
  { keys: ['Ctrl', 'M'], label: 'Switch in and out of reading mode', scope: 'both' },
  { keys: ['Ctrl', '/'], label: 'Show this shortcut list', scope: 'both' },
  { keys: ['Esc'], label: 'Pause and resume', scope: 'typing' },

  { keys: ['Ctrl', 'Down'], label: 'Skip the rest of the current line', scope: 'typing' },
  { keys: ['Ctrl', 'Right'], label: 'Skip this paragraph, listing, or figure', scope: 'typing' },
  { keys: ['Ctrl', 'Left'], label: 'Back to the previous paragraph', scope: 'typing' },
  { keys: ['Ctrl', 'Shift', 'Right'], label: 'Jump to the next section heading', scope: 'typing' },
  { keys: ['Ctrl', 'Shift', 'Left'], label: 'Jump to the previous section heading', scope: 'typing' },
  { keys: ['Ctrl', 'Backspace'], label: 'Start this block over', scope: 'typing' },

  { keys: ['Ctrl', 'O'], label: 'Contents: the doc set, or this page', scope: 'both' },
  { keys: ['Ctrl', 'L'], label: 'Links on this page, and where they appeared', scope: 'both' },
  { keys: ['Ctrl', ';'], label: 'Jump to any page in the table of contents', scope: 'both' },
  { keys: ['Ctrl', '.'], label: 'Next page in the documentation set', scope: 'both' },
  { keys: ['Ctrl', ','], label: 'Previous page in the documentation set', scope: 'both' },

  { keys: ['Tab'], label: 'Fill in expected indentation', scope: 'typing' },
  { keys: ['Enter'], label: 'A real character inside a listing', scope: 'typing' },
  { keys: ['Backspace'], label: 'Fix a mistake; clears auto-indent in one step', scope: 'typing' },

  { keys: ['Down', OR, 'J'], label: 'Move forward a block', scope: 'reading' },
  { keys: ['Up', OR, 'K'], label: 'Move back a block', scope: 'reading' },
  { keys: ['Shift', 'Right'], label: 'Next section heading', scope: 'reading' },
  { keys: ['Shift', 'Left'], label: 'Previous section heading', scope: 'reading' },
  { keys: ['Space'], label: 'Scroll the page', scope: 'reading' },
  { keys: ['Enter'], label: 'Start typing from here', scope: 'reading' },
];

export function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {keys.map((key, i) =>
        key === OR ? (
          <span key={i} className="text-xs text-muted-foreground">
            or
          </span>
        ) : (
          <kbd
            key={i}
            className="rounded border border-border bg-muted px-1.5 py-0.5 text-xs text-foreground"
          >
            {key}
          </kbd>
        )
      )}
    </span>
  );
}

function Group({ title, scope }: { title: string; scope: Shortcut['scope'] }) {
  const rows = SHORTCUTS.filter((s) => s.scope === scope || (scope !== 'both' && s.scope === 'both'));

  return (
    <div>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <div className="space-y-1.5">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-6">
            <span className="text-sm text-foreground">{row.label}</span>
            <Keys keys={row.keys} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** In-session overlay, opened with Ctrl+/. */
export function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-background/70 p-4 backdrop-blur"
      onClick={onClose}
      data-testid="overlay-shortcuts"
    >
      <div
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl border border-border bg-card p-6 shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-5 flex items-center gap-2">
          <Keyboard className="h-4 w-4 text-primary" />
          <h2 className="font-serif text-lg text-foreground">Shortcuts</h2>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-md p-1.5 text-muted-foreground hover-elevate active-elevate-2"
            aria-label="Close"
            data-testid="button-close-shortcuts"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-6">
          <Group title="While typing" scope="typing" />
          <Group title="In reading mode" scope="reading" />
        </div>
      </div>
    </div>
  );
}
