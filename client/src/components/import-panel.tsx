import { useCallback, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ClipboardPaste,
  FolderOpen,
  Globe,
  Loader2,
  Upload,
} from 'lucide-react';
import { API_BASE, apiRequest, queryClient } from '@/lib/queryClient';
import { cn } from '@/lib/utils';
import { BookSources } from '@/components/book-sources';
import { useToast } from '@/hooks/use-toast';
import type { ImportResult } from '@shared/schema';

/**
 * Everything to do with getting a book into the library.
 *
 * Grouped together as a panel so the same block of state — URL box, sources
 * pinboard, dropzone, paste, host-folder shortcut, import report — can render
 * from the dedicated import page or from anywhere else without duplication.
 */

const ACCEPT = '.epub,.pdf,.txt,.md,.markdown,.html,.htm';

const ADAPTER_LABEL: Record<string, string> = {
  'git-markdown': 'Markdown source',
  wiki: 'wiki API',
  readable: 'article extraction',
  rendered: 'rendered page',
  openstax: 'OpenStax archive',
  'sacred-texts': 'sacred-texts archive',
};

export function ImportPanel({ heading }: { heading?: React.ReactNode }) {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [paste, setPaste] = useState({ title: '', text: '', asCode: false });

  const { data: hostFolder } = useQuery<{
    dir: string | null;
    files: { name: string; bytes: number }[];
  }>({ queryKey: ['/api/library'] });

  const importFiles = useMutation({
    mutationFn: async (files: File[]) => {
      const form = new FormData();
      for (const file of files) form.append('files', file);

      const res = await fetch(`${API_BASE}/api/import`, { method: 'POST', body: form });
      const payload = (await res.json()) as ImportResult & { message?: string };
      if (!res.ok && !payload.imported?.length) throw new Error(payload.message ?? 'Import failed.');
      return payload;
    },
    onSuccess: (payload) => {
      setResult(payload);
      queryClient.invalidateQueries({ queryKey: ['/api/books'] });
      queryClient.invalidateQueries({ queryKey: ['/api/collections'] });
      if (payload.imported.length) {
        toast({
          title: `Imported ${payload.imported.length} ${
            payload.imported.length === 1 ? 'book' : 'books'
          }`,
          description: payload.imported
            .map((b) => `${b.title} — ${b.typeableCount.toLocaleString()} blocks`)
            .join('\n'),
        });
      }
    },
    onError: (error: Error) =>
      toast({ title: 'Import failed', description: error.message, variant: 'destructive' }),
  });

  const importFromFolder = useMutation({
    mutationFn: async (names: string[]) => {
      const res = await apiRequest('POST', '/api/library/import', { names });
      return (await res.json()) as ImportResult;
    },
    onSuccess: (payload) => {
      setResult(payload);
      queryClient.invalidateQueries({ queryKey: ['/api/books'] });
    },
  });

  const importPaste = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('POST', '/api/import/text', {
        title: paste.title.trim(),
        text: paste.text,
        asCode: paste.asCode,
      });
      return (await res.json()) as ImportResult;
    },
    onSuccess: (payload) => {
      setResult(payload);
      setPaste({ title: '', text: '', asCode: false });
      setPasteOpen(false);
      queryClient.invalidateQueries({ queryKey: ['/api/books'] });
    },
    onError: (error: Error) =>
      toast({ title: 'Could not add that', description: error.message, variant: 'destructive' }),
  });

  const importFromUrl = useMutation({
    mutationFn: async (target: string) => {
      const res = await apiRequest('POST', '/api/import/url', { url: target });
      return (await res.json()) as {
        bookId: number;
        title?: string;
        adapter: string;
        alreadyImported: boolean;
        notes: string[];
      };
    },
    onSuccess: (payload) => {
      setUrl('');
      queryClient.invalidateQueries({ queryKey: ['/api/books'] });
      queryClient.invalidateQueries({ queryKey: ['/api/collections'] });
      toast({
        title: payload.alreadyImported
          ? 'Already in your library'
          : `Imported ${payload.title ?? 'page'}`,
        description: payload.alreadyImported
          ? 'Opening the copy you already have.'
          : `Read via the ${ADAPTER_LABEL[payload.adapter] ?? payload.adapter} route.${
              payload.notes.length ? ` ${payload.notes.join(' ')}` : ''
            }`,
      });
    },
    onError: (error: Error) =>
      toast({
        title: 'Could not import that page',
        description: error.message
          .replace(/^\d+:\s*/, '')
          .replace(/^\{"message":"|"\}$/g, ''),
        variant: 'destructive',
      }),
  });

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setDragging(false);
      const files = [...event.dataTransfer.files];
      if (files.length) importFiles.mutate(files);
    },
    [importFiles]
  );

  return (
    <div className="space-y-8">
      {heading}

      {/* ---- Import from a URL ---- */}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (url.trim()) importFromUrl.mutate(url.trim());
        }}
        className="rounded-xl border border-card-border bg-card p-4"
      >
        <label htmlFor="url" className="flex items-center gap-2 text-sm text-foreground">
          <Globe className="h-4 w-4 text-muted-foreground" />
          Paste a documentation, wiki, or book link
        </label>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input
            id="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://learn.microsoft.com/en-us/dotnet/core/introduction"
            className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="input-url"
          />
          <button
            type="submit"
            disabled={importFromUrl.isPending || url.trim().length < 8}
            className="flex items-center justify-center gap-2 rounded-md border border-primary-border bg-primary px-4 py-2 text-sm text-primary-foreground hover-elevate active-elevate-2 disabled:opacity-50"
            data-testid="button-import-url"
          >
            {importFromUrl.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Reading the page…
              </>
            ) : (
              'Import page'
            )}
          </button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Only the article is typed — navigation, banners, and buttons are dropped. The page's
          table of contents comes with it, so the rest of the set is a keystroke away.
        </p>
      </form>

      {/* ---- Where to get books ---- */}
      <BookSources />

      {/* ---- File dropzone ---- */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          'rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors',
          dragging ? 'border-primary bg-primary/5' : 'border-border bg-card/40'
        )}
        data-testid="dropzone-import"
      >
        {importFiles.isPending ? (
          <div className="flex items-center justify-center gap-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Extracting text, listings, and figures…
          </div>
        ) : (
          <>
            <Upload className="mx-auto h-7 w-7 text-muted-foreground" />
            <p className="mt-3 text-sm text-foreground">Drop books here</p>
            <p className="mt-1 text-xs text-muted-foreground">
              EPUB keeps code indentation and figure captions — prefer it over PDF when you have both
            </p>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="mt-4 inline-flex items-center gap-2 rounded-md border border-primary-border bg-primary px-4 py-2 text-sm text-primary-foreground hover-elevate active-elevate-2"
              data-testid="button-choose-files"
            >
              <Upload className="h-4 w-4" />
              Choose files
            </button>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept={ACCEPT}
              className="hidden"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                if (files.length) importFiles.mutate(files);
                e.target.value = '';
              }}
              data-testid="input-files"
            />
            <button
              type="button"
              onClick={() => setPasteOpen((o) => !o)}
              className="mt-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground underline-offset-4 hover:underline"
              data-testid="button-toggle-paste"
            >
              <ClipboardPaste className="h-3.5 w-3.5" />
              or paste a passage
            </button>
          </>
        )}
      </div>

      {/* ---- Paste a passage or snippet ---- */}
      {pasteOpen && (
        <div className="rounded-lg border border-card-border bg-card p-4">
          <input
            value={paste.title}
            onChange={(e) => setPaste((p) => ({ ...p, title: e.target.value }))}
            placeholder="Title"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="input-paste-title"
          />
          <textarea
            value={paste.text}
            onChange={(e) => setPaste((p) => ({ ...p, text: e.target.value }))}
            placeholder="Paste prose, or a snippet you want to drill"
            rows={7}
            className="mt-3 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="input-paste-text"
          />
          <div className="mt-3 flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={paste.asCode}
                onChange={(e) => setPaste((p) => ({ ...p, asCode: e.target.checked }))}
                className="h-4 w-4 rounded border-input"
                data-testid="checkbox-paste-code"
              />
              Treat as code — whitespace kept exactly
            </label>
            <button
              type="button"
              disabled={
                importPaste.isPending ||
                paste.title.trim().length === 0 ||
                paste.text.trim().length < 10
              }
              onClick={() => importPaste.mutate()}
              className="ml-auto rounded-md border border-primary-border bg-primary px-4 py-2 text-sm text-primary-foreground hover-elevate active-elevate-2 disabled:opacity-50"
              data-testid="button-add-paste"
            >
              {importPaste.isPending ? 'Adding…' : 'Add to library'}
            </button>
          </div>
        </div>
      )}

      {/* ---- Mounted host folder (Docker volume) ---- */}
      {hostFolder?.dir && (hostFolder.files?.length ?? 0) > 0 && (
        <div className="rounded-lg border border-card-border bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-foreground">
            <FolderOpen className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium">Watched folder</span>
            <code className="truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
              {hostFolder.dir}
            </code>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {hostFolder.files.map((file) => (
              <button
                key={file.name}
                type="button"
                disabled={importFromFolder.isPending}
                onClick={() => importFromFolder.mutate([file.name])}
                className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover-elevate active-elevate-2 disabled:opacity-50"
                data-testid={`button-import-${file.name}`}
              >
                {file.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ---- Import report ---- */}
      {result && (result.failed.length > 0 || result.imported.some((b) => b.notes.length)) && (
        <div className="space-y-2 rounded-lg border border-border bg-card p-4">
          {result.failed.map((f) => (
            <div key={f.name} className="flex gap-2 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                <span className="font-medium">{f.name}</span> — {f.reason}
              </span>
            </div>
          ))}
          {result.imported.flatMap((b) =>
            b.notes.map((note) => (
              <div key={`${b.id}-${note}`} className="flex gap-2 text-sm text-muted-foreground">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  <span className="font-medium text-foreground">{b.title}</span> — {note}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
