import { Link } from 'wouter';
import { ArrowLeft } from 'lucide-react';
import { ImportPanel } from '@/components/import-panel';

/**
 * The import page.
 *
 * Everything to do with adding books lives here now — URL box, pinned sources,
 * dropzone, paste-a-passage, watched folder, and the import report — so the
 * Library page stays a plain grid of what you already have.
 */
export default function ImportPage() {
  return (
    <div className="space-y-8">
      <div className="flex items-center gap-4">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          data-testid="link-back-library"
        >
          <ArrowLeft className="h-4 w-4" />
          Library
        </Link>
      </div>

      <ImportPanel
        heading={
          <div>
            <h1 className="font-serif text-2xl font-semibold tracking-tight text-foreground">
              Import
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Import EPUB, PDF, Markdown, HTML, or plain text, or paste a documentation, wiki, or
              book URL. Prose becomes typing practice, code listings are typed verbatim, and
              figures are extracted and shown inline as you go.
            </p>
          </div>
        }
      />
    </div>
  );
}
