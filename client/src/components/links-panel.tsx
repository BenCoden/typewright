import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, BookOpen, Check, ExternalLink, Loader2, Link2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PageLink } from '@shared/schema';

/**
 * The links a page pointed at, kept to the side of the typing surface.
 *
 * The point is the mapping: each row says which paragraph the link came from
 * and which words carried it, so a list of destinations still reads as part of
 * the page rather than a detached bookmark dump. Links that lead to another page
 * in the same documentation set can be opened as typing practice; everything
 * else opens in a browser tab.
 */

export interface PageLinkRow extends PageLink {
  /** True when the destination is a page in this doc set's table of contents. */
  inToc: boolean;
  /** Set when that page is already in the library. */
  bookId: number | null;
}

export function usePageLinks(bookId: number, enabled: boolean) {
  return useQuery<PageLinkRow[]>({
    queryKey: ['/api/books', bookId, 'links'],
    enabled: enabled && Number.isFinite(bookId),
  });
}

type Filter = 'all' | 'pages' | 'external';

export function LinksPanel({
  links,
  loading,
  currentIdx,
  pendingUrl,
  onJumpBlock,
  onOpenPage,
  onClose,
}: {
  links: PageLinkRow[];
  loading: boolean;
  /** The block being typed, so the nearest link can be highlighted. */
  currentIdx: number | null;
  pendingUrl: string | null;
  onJumpBlock: (idx: number) => void;
  onOpenPage: (url: string) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState<Filter>('all');

  const shown = useMemo(
    () =>
      links.filter((link) =>
        filter === 'all' ? true : filter === 'pages' ? link.inToc : !link.inToc
      ),
    [links, filter]
  );

  const counts = useMemo(
    () => ({
      all: links.length,
      pages: links.filter((l) => l.inToc).length,
      external: links.filter((l) => !l.inToc).length,
    }),
    [links]
  );

  // Group by the section they appeared under, keeping reading order.
  const groups = useMemo(() => {
    const out: { section: string; links: PageLinkRow[] }[] = [];
    for (const link of shown) {
      const section = link.section ?? 'Start of the page';
      const last = out[out.length - 1];
      if (last?.section === section) last.links.push(link);
      else out.push({ section, links: [link] });
    }
    return out;
  }, [shown]);

  return (
    <aside
      className="fixed right-0 top-14 bottom-0 z-40 flex w-[min(22rem,100vw)] flex-col border-l border-border bg-card"
      data-testid="panel-links"
      aria-label="Links on this page"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="text-sm text-foreground">Links on this page</span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded-md p-1.5 text-muted-foreground hover-elevate active-elevate-2"
          aria-label="Close links panel"
          data-testid="button-close-links"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex items-center gap-1 border-b border-border px-2 py-2">
        {(
          [
            ['all', 'All'],
            ['pages', 'In this doc set'],
            ['external', 'Elsewhere'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setFilter(value)}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs',
              filter === value
                ? 'bg-secondary text-foreground'
                : 'text-muted-foreground hover-elevate active-elevate-2'
            )}
            data-testid={`filter-links-${value}`}
          >
            {label} <span className="tabular-nums opacity-60">{counts[value]}</span>
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {loading ? (
          <div className="flex items-center gap-2 px-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Reading the page
          </div>
        ) : groups.length === 0 ? (
          <p className="px-2 py-6 text-sm text-muted-foreground">
            {links.length === 0
              ? 'This page does not link anywhere.'
              : 'Nothing in this filter.'}
          </p>
        ) : (
          groups.map((group, gi) => (
            <div key={`${group.section}-${gi}`} className="mb-3">
              <div className="truncate px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {group.section}
              </div>
              {group.links.map((link, i) => (
                <LinkRow
                  key={`${link.url}-${i}`}
                  link={link}
                  here={currentIdx !== null && link.blockIdx === currentIdx}
                  pending={link.url === pendingUrl}
                  onJumpBlock={onJumpBlock}
                  onOpenPage={onOpenPage}
                />
              ))}
            </div>
          ))
        )}
      </div>

      <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
        Linked words are underlined in the text. Click a row to jump to where it appeared.
      </p>
    </aside>
  );
}

function LinkRow({
  link,
  here,
  pending,
  onJumpBlock,
  onOpenPage,
}: {
  link: PageLinkRow;
  here: boolean;
  pending: boolean;
  onJumpBlock: (idx: number) => void;
  onOpenPage: (url: string) => void;
}) {
  return (
    <div
      className={cn(
        'group rounded-md px-2 py-1.5',
        here ? 'bg-secondary' : 'hover:bg-secondary/50'
      )}
      data-testid={`link-row-${link.blockIdx}`}
    >
      <button
        type="button"
        onClick={() => onJumpBlock(link.blockIdx)}
        className="block w-full text-left"
        title={link.url}
      >
        <span className="line-clamp-2 text-sm text-foreground">{link.text}</span>
        <span className="mt-0.5 flex items-baseline gap-1.5 text-xs text-muted-foreground">
          <span className="shrink-0 whitespace-nowrap tabular-nums">block {link.blockIdx + 1}</span>
          <span className="shrink-0" aria-hidden>
            ·
          </span>
          <span className="min-w-0 truncate">{hostOf(link.url)}</span>
        </span>
      </button>

      <div className="mt-1 flex items-center gap-1">
        {link.inToc ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => onOpenPage(link.url)}
            className="flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover-elevate active-elevate-2 disabled:opacity-50"
            data-testid={`button-open-link-${link.blockIdx}`}
          >
            {pending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : link.bookId ? (
              <Check className="h-3 w-3 text-primary" />
            ) : (
              <BookOpen className="h-3 w-3" />
            )}
            {link.bookId ? 'Open' : 'Type this page'}
          </button>
        ) : (
          <span className="flex items-center gap-1 px-1 text-xs text-muted-foreground">
            <ArrowUpRight className="h-3 w-3" />
            {link.internal ? 'Same site' : 'External'}
          </span>
        )}

        <a
          href={link.url}
          target="_blank"
          rel="noreferrer"
          className="ml-auto rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover-elevate group-hover:opacity-100 focus-visible:opacity-100"
          aria-label={`Open ${link.text} in a new tab`}
        >
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    </div>
  );
}

function hostOf(url: string): string {
  try {
    const { hostname, pathname } = new URL(url);
    return `${hostname.replace(/^www\./, '')}${pathname === '/' ? '' : pathname}`;
  } catch {
    return url;
  }
}
