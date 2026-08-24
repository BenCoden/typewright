import { useCallback, useRef, useState } from 'react';
import { Link } from 'wouter';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  BookOpen,
  Code2,
  ClipboardPaste,
  FolderOpen,
  Image as ImageIcon,
  Loader2,
  Trash2,
  Upload,
} from 'lucide-react';
import { API_BASE, apiRequest, assetUrl, queryClient } from '@/lib/queryClient';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/components/chrome';
import { useToast } from '@/hooks/use-toast';
import type { Book, ImportResult } from '@shared/schema';

const ACCEPT = '.epub,.pdf,.txt,.md,.markdown,.html,.htm';

export default function LibraryPage() {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [paste, setPaste] = useState({ title: '', text: '', asCode: false });

  const { data: books, isLoading } = useQuery<Book[]>({ queryKey: ['/api/books'] });
  const { data: hostFolder } = useQuery<{ dir: string | null; files: { name: string; bytes: number }[] }>(
    { queryKey: ['/api/library'] }
  );

  const importFiles = useMutation({
    mutationFn: async (files: File[]) => {
      const form = new FormData();
      for (const file of files) form.append('files', file);

      // FormData must not carry a JSON content-type, so this bypasses apiRequest.
      const res = await fetch(`${API_BASE}/api/import`, {
        method: 'POST',
        body: form,
      });
      const payload = (await res.json()) as ImportResult & { message?: string };
      if (!res.ok && !payload.imported?.length) throw new Error(payload.message ?? 'Import failed.');
      return payload;
    },
    onSuccess: (payload) => {
      setResult(payload);
      queryClient.invalidateQueries({ queryKey: ['/api/books'] });
      if (payload.imported.length) {
        toast({
          title: `Imported ${payload.imported.length} ${payload.imported.length === 1 ? 'book' : 'books'}`,
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

  const remove = useMutation({
    mutationFn: async (id: number) => apiRequest('DELETE', `/api/books/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/api/books'] }),
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
    <div className="space-y-10">
      <div>
        <h1 className="font-serif text-2xl font-semibold tracking-tight text-foreground">
          Your library
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Import EPUB, PDF, Markdown, HTML, or plain text. Prose becomes typing practice, code
          listings are typed verbatim, and figures are extracted and shown inline as you go.
        </p>
      </div>

      {/* ---- Import ---- */}
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

      {/* ---- Paste a snippet or passage ---- */}
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
                importPaste.isPending || paste.title.trim().length === 0 || paste.text.trim().length < 10
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

      {/* ---- Mounted host folder ---- */}
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

      {/* ---- Books ---- */}
      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-44 animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      ) : (books?.length ?? 0) === 0 ? (
        <EmptyState icon={BookOpen} title="Nothing imported yet">
          Drop an EPUB above to get started. Everything is parsed on this machine and stored in a
          local SQLite file — no account, no upload, no network.
        </EmptyState>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {books!.map((book) => (
            <BookCard key={book.id} book={book} onDelete={() => remove.mutate(book.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function BookCard({ book, onDelete }: { book: Book; onDelete: () => void }) {
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
              <span className="uppercase tracking-wide">{book.format}</span>
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

      <button
        type="button"
        onClick={onDelete}
        className="absolute right-2 top-2 rounded-md bg-card/80 p-1.5 text-muted-foreground opacity-0 transition-opacity hover-elevate group-hover:opacity-100 focus-visible:opacity-100"
        aria-label={`Remove ${book.title}`}
        data-testid={`button-delete-${book.id}`}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
