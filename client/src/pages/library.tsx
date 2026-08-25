import { useMemo } from 'react';
import { Link } from 'wouter';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  BookOpen,
  Code2,
  ExternalLink,
  Layers,
  RefreshCw,
  Image as ImageIcon,
  Trash2,
  Upload,
} from 'lucide-react';
import { apiRequest, assetUrl, queryClient } from '@/lib/queryClient';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/components/chrome';
import { useToast } from '@/hooks/use-toast';
import type { Book, CollectionSummary } from '@shared/schema';

export default function LibraryPage() {
  const { toast } = useToast();

  const { data: books, isLoading } = useQuery<Book[]>({ queryKey: ['/api/books'] });
  const { data: collections } = useQuery<CollectionSummary[]>({ queryKey: ['/api/collections'] });

  /*
   * A doc set gets one library entry however many of its pages are held, so the
   * pages belonging to one are not listed again beside it. What is left are the
   * books that came off the disk.
   */
  const fileBooks = useMemo(() => (books ?? []).filter((book) => !book.collectionId), [books]);

  const refresh = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest('POST', `/api/books/${id}/refresh`, {});
      return (await res.json()) as { changed: boolean; message?: string };
    },
    onSuccess: (payload) => {
      queryClient.invalidateQueries({ queryKey: ['/api/books'] });
      toast({
        title: payload.changed ? 'Page updated' : 'No change upstream',
        description: payload.changed
          ? 'The page was re-imported, so progress on it has reset.'
          : payload.message,
      });
    },
    onError: (error: Error) =>
      toast({ title: 'Refresh failed', description: error.message, variant: 'destructive' }),
  });

  const removeSet = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest('DELETE', `/api/collections/${id}`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/books'] });
      queryClient.invalidateQueries({ queryKey: ['/api/collections'] });
    },
  });

  const remove = useMutation({
    mutationFn: async (id: number) => apiRequest('DELETE', `/api/books/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/api/books'] }),
  });

  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-2xl font-semibold tracking-tight text-foreground">
            Your library
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Everything you have imported, one entry per doc set or book.
          </p>
        </div>
        <Link
          href="/import"
          className="inline-flex items-center gap-2 rounded-md border border-primary-border bg-primary px-4 py-2 text-sm text-primary-foreground hover-elevate active-elevate-2"
          data-testid="link-import"
        >
          <Upload className="h-4 w-4" />
          Import
        </Link>
      </div>

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-44 animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      ) : fileBooks.length === 0 && (collections?.length ?? 0) === 0 ? (
        <EmptyState icon={BookOpen} title="Nothing imported yet">
          Head to the <Link href="/import" className="underline decoration-dotted underline-offset-2">Import page</Link>{' '}
          to paste a documentation link or drop an EPUB. Everything is parsed on this machine and
          stored in a local SQLite file — no account, no upload, no network.
        </EmptyState>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {collections?.map((collection) => (
            <CollectionCard
              key={`c${collection.id}`}
              collection={collection}
              onDelete={() => removeSet.mutate(collection.id)}
              onRefresh={() => refresh.mutate(collection.resumeBookId)}
              refreshing={refresh.isPending && refresh.variables === collection.resumeBookId}
            />
          ))}
          {fileBooks.map((book) => (
            <BookCard
              key={book.id}
              book={book}
              onDelete={() => remove.mutate(book.id)}
              onRefresh={() => refresh.mutate(book.id)}
              refreshing={refresh.isPending && refresh.variables === book.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CollectionCard({
  collection,
  onDelete,
  onRefresh,
  refreshing,
}: {
  collection: CollectionSummary;
  onDelete: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const progress = Math.min(
    100,
    Math.round((collection.positionSum / Math.max(1, collection.blockCount - collection.pageCount)) * 100)
  );

  return (
    <div
      className="group relative flex flex-col overflow-hidden rounded-lg border border-card-border bg-card"
      data-testid={`card-collection-${collection.id}`}
    >
      <Link href={`/type/${collection.resumeBookId}`} className="flex flex-1 flex-col">
        <div className="flex gap-4 p-4">
          <div className="flex h-24 w-16 shrink-0 items-center justify-center rounded border border-border bg-muted">
            <Layers className="h-5 w-5 text-muted-foreground" />
          </div>

          <div className="min-w-0 flex-1">
            <h3
              className="line-clamp-2 font-serif text-base font-semibold leading-snug text-foreground"
              data-testid={`text-collection-${collection.id}`}
            >
              {collection.title}
            </h3>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {collection.pageCount} of {collection.tocCount || collection.pageCount} pages
            </p>

            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="uppercase tracking-wide">{collection.site}</span>
              {collection.codeBlockCount > 0 && (
                <span className="flex items-center gap-1">
                  <Code2 className="h-3 w-3" />
                  {collection.codeBlockCount}
                </span>
              )}
              {collection.imageCount > 0 && (
                <span className="flex items-center gap-1">
                  <ImageIcon className="h-3 w-3" />
                  {collection.imageCount}
                </span>
              )}
              <span>{Math.round(collection.wordCount / 1000)}k words</span>
            </div>
          </div>
        </div>

        <div className="mt-auto px-4 pb-4">
          <p className="mb-2 truncate text-xs text-muted-foreground">
            <span className="text-foreground">Resume:</span> {collection.resumeTitle}
          </p>
          <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary" style={{ width: `${progress}%` }} />
          </div>
          <div className="mt-2 flex justify-between text-xs text-muted-foreground">
            <span>{progress}% typed</span>
            <span className="font-mono">
              {collection.positionSum.toLocaleString()} / {collection.blockCount.toLocaleString()}
            </span>
          </div>
        </div>
      </Link>

      <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        {collection.resumeUrl && (
          <a
            href={collection.resumeUrl}
            target="_blank"
            rel="noreferrer"
            className="rounded-md bg-card/80 p-1.5 text-muted-foreground hover-elevate"
            aria-label={`Open ${collection.resumeTitle} on ${collection.site}`}
            title="Open the original page"
            data-testid={`button-open-source-${collection.id}`}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="rounded-md bg-card/80 p-1.5 text-muted-foreground hover-elevate"
          aria-label={`Check ${collection.resumeTitle} for updates`}
          title="Check the current page for updates"
          data-testid={`button-refresh-collection-${collection.id}`}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="rounded-md bg-card/80 p-1.5 text-muted-foreground hover-elevate"
          aria-label={`Remove ${collection.title} and its ${collection.pageCount} pages`}
          title="Remove this doc set"
          data-testid={`button-delete-collection-${collection.id}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function BookCard({
  book,
  onDelete,
  onRefresh,
  refreshing,
}: {
  book: Book;
  onDelete: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const progress = Math.min(100, Math.round((book.positionIdx / Math.max(1, book.blockCount - 1)) * 100));

  return (
    <div
      className="group relative flex flex-col overflow-hidden rounded-lg border border-card-border bg-card"
      data-testid={`card-book-${book.id}`}
    >
      <Link href={`/type/${book.id}`} className="flex flex-1 flex-col">
        <div className="flex gap-4 p-4">
          {book.coverAssetId ? (
            <img
              src={assetUrl(book.coverAssetId)}
              alt=""
              crossOrigin="anonymous"
              className="h-24 w-16 shrink-0 rounded border border-border object-cover"
            />
          ) : (
            <div className="flex h-24 w-16 shrink-0 items-center justify-center rounded border border-border bg-muted">
              <BookOpen className="h-5 w-5 text-muted-foreground" />
            </div>
          )}

          <div className="min-w-0 flex-1">
            <h3
              className="line-clamp-2 font-serif text-base font-semibold leading-snug text-foreground"
              data-testid={`text-title-${book.id}`}
            >
              {book.title}
            </h3>
            <p className="mt-1 truncate text-xs text-muted-foreground">{book.author}</p>

            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="uppercase tracking-wide">
                {book.sourceUrl ? new URL(book.sourceUrl).hostname.replace(/^www\./, '') : book.format}
              </span>
              {book.codeBlockCount > 0 && (
                <span className="flex items-center gap-1">
                  <Code2 className="h-3 w-3" />
                  {book.codeBlockCount}
                </span>
              )}
              {book.imageCount > 0 && (
                <span className="flex items-center gap-1">
                  <ImageIcon className="h-3 w-3" />
                  {book.imageCount}
                </span>
              )}
              <span>{Math.round(book.wordCount / 1000)}k words</span>
            </div>
          </div>
        </div>

        <div className="mt-auto px-4 pb-4">
          <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary" style={{ width: `${progress}%` }} />
          </div>
          <div className="mt-2 flex justify-between text-xs text-muted-foreground">
            <span>{progress}% typed</span>
            <span className="font-mono">
              {book.positionIdx.toLocaleString()} / {book.blockCount.toLocaleString()}
            </span>
          </div>
        </div>
      </Link>

      <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        {book.sourceUrl && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="rounded-md bg-card/80 p-1.5 text-muted-foreground hover-elevate"
            aria-label={`Check ${book.title} for updates`}
            title="Check for updates"
            data-testid={`button-refresh-${book.id}`}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
          </button>
        )}
        <button
          type="button"
          onClick={onDelete}
          className="rounded-md bg-card/80 p-1.5 text-muted-foreground hover-elevate"
          aria-label={`Remove ${book.title}`}
          data-testid={`button-delete-${book.id}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
