import { useMemo, useState } from 'react';
import { Keyboard, Search } from 'lucide-react';
import { Keys, OR, SHORTCUTS, type Shortcut } from '@/components/shortcuts';

/**
 * The full keyboard reference.
 *
 * The same list drives the in-session overlay, so there is one source of truth
 * and no chance of the two disagreeing. Grouped by what you are doing rather
 * than by which key is pressed, because that is how you go looking for one.
 */

interface Group {
  title: string;
  blurb: string;
  match: (shortcut: Shortcut) => boolean;
}

const NAVIGATION = new Set(['O', 'L', ';', '.', ',']);

const GROUPS: Group[] = [
  {
    title: 'Typing',
    blurb: 'Every printable key is being scored, so commands sit on a modifier.',
    match: (s) =>
      (s.scope === 'typing' || s.scope === 'both') &&
      !NAVIGATION.has(s.keys[s.keys.length - 1]) &&
      !['M', '/'].includes(s.keys[s.keys.length - 1]),
  },
  {
    title: 'Documentation sets',
    blurb: 'Available on any page imported from a URL.',
    match: (s) => NAVIGATION.has(s.keys[s.keys.length - 1]),
  },
  {
    title: 'Modes and help',
    blurb: 'Reading mode is a scroll-through pass with nothing scored.',
    match: (s) => ['M', '/'].includes(s.keys[s.keys.length - 1]),
  },
  {
    title: 'Reading mode',
    blurb: 'Nothing is being graded here, so the bare keys navigate.',
    match: (s) => s.scope === 'reading',
  },
];

export default function ShortcutsPage() {
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();

    const matches = (shortcut: Shortcut) =>
      !needle ||
      shortcut.label.toLowerCase().includes(needle) ||
      shortcut.keys
        .filter((key) => key !== OR)
        .join(' ')
        .toLowerCase()
        .includes(needle);

    const used = new Set<Shortcut>();
    const out = GROUPS.map((group) => {
      const items = SHORTCUTS.filter(
        (shortcut) => !used.has(shortcut) && group.match(shortcut) && matches(shortcut)
      );
      for (const item of items) used.add(item);
      return { ...group, items };
    });

    // Anything a group did not claim still has to be listed somewhere.
    const rest = SHORTCUTS.filter((shortcut) => !used.has(shortcut) && matches(shortcut));
    if (rest.length) {
      out.push({ title: 'Other', blurb: '', match: () => false, items: rest });
    }

    return out.filter((group) => group.items.length);
  }, [query]);

  const total = SHORTCUTS.length;

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-8">
        <h1 className="flex items-center gap-3 font-serif text-3xl text-foreground">
          <Keyboard className="h-7 w-7 text-muted-foreground" />
          Keyboard shortcuts
        </h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          {total} shortcuts. Press <Kbd>Ctrl</Kbd> <Kbd>/</Kbd> while typing to see this same list
          without leaving the page.
        </p>
      </header>

      <div className="mb-8 flex items-center gap-2 rounded-lg border border-input bg-background px-3">
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by what it does, or by key"
          className="w-full bg-transparent py-2.5 text-sm outline-none placeholder:text-muted-foreground"
          data-testid="input-shortcut-search"
        />
      </div>

      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">No shortcut matches that.</p>
      ) : (
        <div className="space-y-10">
          {groups.map((group) => (
            <section key={group.title} data-testid={`group-${group.title}`}>
              <h2 className="font-serif text-xl text-foreground">{group.title}</h2>
              {group.blurb && (
                <p className="mt-1 text-sm text-muted-foreground">{group.blurb}</p>
              )}

              <dl className="mt-4 divide-y divide-border rounded-lg border border-card-border bg-card">
                {group.items.map((shortcut, i) => (
                  <div
                    key={`${shortcut.label}-${i}`}
                    className="flex items-center justify-between gap-6 px-4 py-3"
                  >
                    <dt className="text-sm text-foreground">{shortcut.label}</dt>
                    <dd>
                      <Keys keys={shortcut.keys} />
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-border bg-secondary px-1.5 py-0.5 font-mono text-xs text-foreground">
      {children}
    </kbd>
  );
}
