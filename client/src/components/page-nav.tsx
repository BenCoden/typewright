import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, CornerDownLeft, ExternalLink, Loader2, Search, X } from 'lucide-react';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { cn } from '@/lib/utils';
import type { PageContext, TocEntry } from '@shared/schema';

/**
 * Navigation for pages that came from the web.
 *
 * A documentation set is a table of contents plus however many of its pages you
 * have actually read. Anything in the TOC can be opened, imported or not — an
 * unread page is fetched on demand, which is what makes a single pasted link
 * behave like the whole doc set.
 */

export function usePageContext(bookId: number) {
  return useQuery<PageContext | null>({
    queryKey: ['/api/books', bookId, 'context'],
    enabled: Number.isFinite(bookId),
  });
}

/** Imports a TOC page if needed, then hands back its book id. */
export function useOpenPage() {
  return useMutation({
    mutationFn: async (url: string) => {
      const res = await apiRequest('POST', '/api/import/url', { url });
      return (await res.json()) as { bookId: number; alreadyImported: boolean };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/books'] });
      queryClient.invalidateQueries({ queryKey: ['/api/collections'] });
    },
  });
}

/* ------------------------------------------------------------------ *
 * Contents panel
 * ------------------------------------------------------------------ */

interface PanelProps {
  context: PageContext;
  currentUrl: string | null;
  /** Page headings within the page being read. */
  outline: { idx: number; section: string }[];
  onOpenUrl: (url: string) => void;
  onJumpBlock: (idx: number) => void;
  onClose: () => void;
  pendingUrl: string | null;
}

export function ContentsPanel({
  context,
  currentUrl,
  outline,
  onOpenUrl,
  onJumpBlock,
  onClose,
  pendingUrl,
}: PanelProps) {
  const [tab, setTab] = useState<'contents' | 'outline'>(
    context.toc.length ? 'contents' : 'outline'
  );
  const currentRef = useRef<HTMLButtonElement | null>(null);

  // Open the panel already scrolled to where you are in the book.
  useEffect(() => {
    if (tab === 'contents') currentRef.current?.scrollIntoView({ block: 'center' });
  }, [tab]);

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden />
      <div className="fixed left-1/2 top-16 z-50 w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2">
        <div className="overflow-hidden rounded-lg border border-border bg-card shadow-lg">
          <div className="flex items-center gap-1 border-b border-border px-2 py-2">
            {(['contents', 'outline'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setTab(value)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm capitalize',
                  tab === value
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover-elevate active-elevate-2'
                )}
                data-testid={`tab-${value}`}
              >
                {value === 'contents' ? 'Contents' : 'This page'}
              </button>
            ))}
            <span className="ml-auto min-w-0 truncate px-2 text-xs text-muted-foreground">
              {context.collection.title}
            </span>
            {currentUrl && (
              <a
                href={currentUrl}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 rounded-md p-1.5 text-muted-foreground hover-elevate active-elevate-2"
                aria-label="Open this page on the site"
                title={currentUrl}
                data-testid="button-panel-open-source"
              >
                <ExternalLink className="h-4 w-4" />
              </a>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1.5 text-muted-foreground hover-elevate active-elevate-2"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="max-h-[60vh] overflow-y-auto p-2">
            {tab === 'contents' ? (
              context.toc.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                  This source has no table of contents.
                </p>
              ) : (
                context.toc.map((entry, i) => (
                  <TocRow
                    key={`${entry.title}-${i}`}
                    entry={entry}
                    current={Boolean(entry.url && currentUrl && entry.url === currentUrl)}
                    imported={Boolean(entry.url && context.imported[entry.url])}
                    pending={entry.url === pendingUrl}
                    innerRef={entry.url && currentUrl && entry.url === currentUrl ? currentRef : undefined}
                    onOpen={onOpenUrl}
                  />
                ))
              )
            ) : outline.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                No headings on this page.
              </p>
            ) : (
              outline.map((heading) => (
                <button
                  key={heading.idx}
                  type="button"
                  onClick={() => onJumpBlock(heading.idx)}
                  className="block w-full truncate rounded-md px-3 py-1.5 text-left text-sm text-muted-foreground hover-elevate active-elevate-2"
                  data-testid={`button-outline-${heading.idx}`}
                >
                  {heading.section}
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function TocRow({
  entry,
  current,
  imported,
  pending,
  innerRef,
  onOpen,
}: {
  entry: TocEntry;
  current: boolean;
  imported: boolean;
  pending: boolean;
  innerRef?: React.RefObject<HTMLButtonElement>;
  onOpen: (url: string) => void;
}) {
  // Rows without a URL are grouping headers in the source TOC.
  if (!entry.url) {
    return (
      <div
        className="truncate px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground"
        style={{ paddingLeft: 12 + entry.depth * 14 }}
      >
        {entry.title}
      </div>
    );
  }

  return (
    <button
      ref={innerRef}
      type="button"
      onClick={() => onOpen(entry.url!)}
      className={cn(
        'flex w-full items-center gap-2 rounded-md py-1.5 pr-3 text-left text-sm hover-elevate active-elevate-2',
        current ? 'bg-secondary text-foreground' : 'text-muted-foreground'
      )}
      style={{ paddingLeft: 12 + entry.depth * 14 }}
      data-testid={`button-toc-${entry.title.slice(0, 24)}`}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        {pending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : imported ? (
          <Check className="h-3.5 w-3.5 text-primary" />
        ) : null}
      </span>
      <span className="truncate">{entry.title}</span>
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * Jump palette
 * ------------------------------------------------------------------ */

/** Subsequence match, so "asyncscen" finds "Asynchronous programming scenarios". */
function score(title: string, query: string): number {
  if (!query) return 1;

  const haystack = title.toLowerCase();
  const needle = query.toLowerCase();

  const direct = haystack.indexOf(needle);
  if (direct === 0) return 1000;
  if (direct > 0) return 500 - direct;

  let cursor = 0;
  let hits = 0;
  for (const char of needle) {
    const at = haystack.indexOf(char, cursor);
    if (at === -1) return 0;
    cursor = at + 1;
    hits += 1;
  }
  return hits;
}

export function JumpPalette({
  context,
  currentUrl,
  onOpenUrl,
  onClose,
  pendingUrl,
}: {
  context: PageContext;
  currentUrl: string | null;
  onOpenUrl: (url: string) => void;
  onClose: () => void;
  pendingUrl: string | null;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  const pages = useMemo(
    () => context.toc.filter((entry): entry is TocEntry & { url: string } => Boolean(entry.url)),
    [context.toc]
  );

  const results = useMemo(() => {
    const scored = pages
      .map((entry) => ({ entry, value: score(entry.title, query) }))
      .filter((row) => row.value > 0);
    scored.sort((a, b) => b.value - a.value);
    return scored.slice(0, 60).map((row) => row.entry);
  }, [pages, query]);

  useEffect(() => setActive(0), [query]);

  // Keep the highlighted row on screen while arrowing through a long list.
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => Math.min(results.length - 1, i + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const target = results[active];
      if (target) onOpenUrl(target.url);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-background/70 p-4 pt-[12vh] backdrop-blur"
      onClick={onClose}
      data-testid="overlay-jump"
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-xl border border-border bg-card shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-4">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={`Jump to a page in ${context.collection.title}`}
            className="w-full bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground"
            data-testid="input-jump"
          />
          <span className="shrink-0 text-xs text-muted-foreground">{results.length}</span>
        </div>

        <div ref={listRef} className="max-h-[50vh] overflow-y-auto p-2" data-testid="list-jump">
          {results.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">Nothing matches.</p>
          ) : (
            results.map((entry, i) => (
              <button
                key={`${entry.url}-${i}`}
                type="button"
                data-active={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => onOpenUrl(entry.url)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm',
                  i === active ? 'bg-secondary text-foreground' : 'text-muted-foreground'
                )}
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                  {entry.url === pendingUrl ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : context.imported[entry.url] ? (
                    <Check className="h-3.5 w-3.5 text-primary" />
                  ) : null}
                </span>
                <span className="truncate">{entry.title}</span>
                {entry.url === currentUrl && (
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">current</span>
                )}
                {i === active && (
                  <CornerDownLeft className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
              </button>
            ))
          )}
        </div>

        <div className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
          Unread pages are fetched when you open them.
        </div>
      </div>
    </div>
  );
}
