import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { BookMarked, ExternalLink, Loader2, Plus, Trash2, X } from 'lucide-react';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import type { BookSource } from '@shared/schema';

/**
 * A pinboard for the sites you get books from.
 *
 * A pin, not an import — clicking one opens the site in a new tab. The list is
 * seeded on first run with a handful of well-known DRM-free stores so it is
 * useful the moment the app is installed; anything can be removed, and new
 * entries stick around.
 */
export function BookSources() {
  const { data: sources, isLoading } = useQuery<BookSource[]>({
    queryKey: ['/api/book-sources'],
  });
  const [adding, setAdding] = useState(false);

  return (
    <section className="rounded-xl border border-card-border bg-card">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <BookMarked className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-medium text-foreground">Where to get books</h2>
        <span className="text-xs text-muted-foreground">
          {sources ? `${sources.length}` : '—'}
        </span>
        <button
          type="button"
          onClick={() => setAdding((open) => !open)}
          className={cn(
            'ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-xs hover-elevate active-elevate-2',
            adding ? 'bg-secondary text-foreground' : 'text-muted-foreground'
          )}
          data-testid="button-add-source"
        >
          {adding ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
          {adding ? 'Cancel' : 'Add site'}
        </button>
      </header>

      {adding && <AddSourceForm onDone={() => setAdding(false)} />}

      <div className="grid grid-cols-1 gap-px bg-border sm:grid-cols-2 lg:grid-cols-3">
        {isLoading ? (
          <div className="flex items-center gap-2 bg-card px-4 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading
          </div>
        ) : sources && sources.length > 0 ? (
          sources.map((source) => <SourceRow key={source.id} source={source} />)
        ) : (
          <p className="bg-card px-4 py-6 text-sm text-muted-foreground">
            No sites saved yet. Add the ones you use.
          </p>
        )}
      </div>
    </section>
  );
}

function SourceRow({ source }: { source: BookSource }) {
  const { toast } = useToast();

  const remove = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest('DELETE', `/api/book-sources/${id}`);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/api/book-sources'] }),
    onError: (error: Error) =>
      toast({ title: 'Could not remove', description: error.message, variant: 'destructive' }),
  });

  return (
    <div className="group relative flex items-center gap-3 bg-card px-4 py-3">
      <a
        href={source.url}
        target="_blank"
        rel="noreferrer"
        className="min-w-0 flex-1"
        data-testid={`source-${source.id}`}
      >
        <div className="flex min-w-0 items-center gap-1.5 text-sm text-foreground">
          <span className="min-w-0 truncate">{source.label}</span>
          <ExternalLink className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-60" />
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {source.note || hostOf(source.url)}
        </p>
      </a>

      <button
        type="button"
        onClick={() => remove.mutate(source.id)}
        disabled={remove.isPending}
        className="rounded-md p-1.5 text-muted-foreground opacity-0 transition-opacity hover-elevate group-hover:opacity-100 focus-visible:opacity-100 disabled:opacity-50"
        aria-label={`Remove ${source.label}`}
        data-testid={`button-remove-source-${source.id}`}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function AddSourceForm({ onDone }: { onDone: () => void }) {
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const { toast } = useToast();

  const create = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('POST', '/api/book-sources', {
        label: label.trim(),
        url: url.trim(),
        note: note.trim() || null,
      });
      return (await res.json()) as BookSource;
    },
    onSuccess: () => {
      setLabel('');
      setUrl('');
      setNote('');
      queryClient.invalidateQueries({ queryKey: ['/api/book-sources'] });
      onDone();
    },
    onError: (error: Error) =>
      toast({ title: 'Could not save that site', description: error.message, variant: 'destructive' }),
  });

  /*
   * If someone drops a plain URL into the label box, autofill the URL from it
   * and leave the label to be picked from the hostname. Nine times out of ten
   * that is what they meant.
   */
  const handleLabelBlur = () => {
    if (!url && /^https?:\/\//i.test(label)) {
      setUrl(label);
      try {
        setLabel(new URL(label).hostname.replace(/^www\./, ''));
      } catch {
        /* leave as is */
      }
    }
  };

  const canSave = label.trim().length > 0 && /^https?:\/\/\S+/i.test(url.trim());

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave) create.mutate();
      }}
      className="grid gap-3 border-b border-border px-4 py-3 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto]"
    >
      <input
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        onBlur={handleLabelBlur}
        placeholder="Name"
        required
        className="rounded-md border border-input bg-background px-3 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="input-source-label"
      />
      <input
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        placeholder="https://…"
        type="url"
        required
        className="rounded-md border border-input bg-background px-3 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="input-source-url"
      />
      <button
        type="submit"
        disabled={!canSave || create.isPending}
        className="flex items-center justify-center gap-2 rounded-md border border-primary-border bg-primary px-3 py-1.5 text-sm text-primary-foreground hover-elevate active-elevate-2 disabled:opacity-50"
        data-testid="button-save-source"
      >
        {create.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Save'}
      </button>

      <input
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="Note (optional) — what makes this one worth pinning"
        maxLength={400}
        className="sm:col-span-3 rounded-md border border-input bg-background px-3 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="input-source-note"
      />
    </form>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
