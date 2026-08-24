import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useRoute } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  BookOpen,
  Check,
  Keyboard,
  List,
  Pause,
  RotateCcw,
  SkipForward,
} from 'lucide-react';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { cn } from '@/lib/utils';
import { useSettings } from '@/components/chrome';
import { ReaderBlock, type BlockMode } from '@/components/reader';
import {
  accuracy,
  applyKey,
  createBlockState,
  emptyMetrics,
  isTypeable,
  isTypingKey,
  recordKey,
  shouldPreventDefault,
  skipLine,
  wpm,
  type BlockState,
  type EngineOptions,
  type Metrics,
} from '@/lib/typing';
import type { BlockView, Book } from '@shared/schema';

/** Blocks fetched per request, and how much slack to keep ahead of the cursor. */
const WINDOW = 60;
const REFETCH_MARGIN = 14;
/** Rendered context around the cursor. */
const BEHIND = 6;
const AHEAD = 8;

const READING_LINE_HEIGHT: Record<string, number> = {
  xs: 1.3,
  s: 1.5,
  m: 1.75,
  l: 2,
  xl: 2.25,
};

export default function TypingPage() {
  const [, params] = useRoute('/type/:id');
  const bookId = Number(params?.id);

  const { data: settings } = useSettings();
  const { data: book } = useQuery<Book>({
    queryKey: ['/api/books', bookId],
    enabled: Number.isFinite(bookId),
  });

  const [idx, setIdx] = useState<number | null>(null);
  const [fetchFrom, setFetchFrom] = useState(0);
  const [paused, setPaused] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [tick, setTick] = useState(0);
  /** A read-only view of the current position — no keystrokes are scored. */
  const [readingMode, setReadingMode] = useState(false);

  const { data: blocks } = useQuery<BlockView[]>({
    queryKey: ['/api/books', bookId, 'blocks', fetchFrom],
    enabled: Number.isFinite(bookId),
    queryFn: async () => {
      const res = await apiRequest(
        'GET',
        `/api/books/${bookId}/blocks?from=${fetchFrom}&count=${WINDOW}`
      );
      return (await res.json()) as BlockView[];
    },
  });

  const { data: outline } = useQuery<{ idx: number; section: string }[]>({
    queryKey: ['/api/books', bookId, 'outline'],
    enabled: Number.isFinite(bookId) && outlineOpen,
  });

  const options: EngineOptions = useMemo(
    () => ({
      strictMode: (settings?.strictMode ?? 1) === 1,
      autoIndent: (settings?.autoIndent ?? 1) === 1,
    }),
    [settings?.strictMode, settings?.autoIndent]
  );
  const skipCode = (settings?.skipCode ?? 0) === 1;

  /* ---------------------------------------------------------------- *
   * Position
   * ---------------------------------------------------------------- */

  // Resume where the book was left off, once.
  useEffect(() => {
    if (book && idx === null) {
      setIdx(book.positionIdx);
      setFetchFrom(Math.max(0, book.positionIdx - BEHIND));
    }
  }, [book, idx]);

  const byIdx = useMemo(() => {
    const map = new Map<number, BlockView>();
    for (const block of blocks ?? []) map.set(block.idx, block);
    return map;
  }, [blocks]);

  // Keep the loaded window centred on the cursor.
  useEffect(() => {
    if (idx === null) return;
    const loadedEnd = fetchFrom + WINDOW;
    if (idx < fetchFrom || idx > loadedEnd - REFETCH_MARGIN) {
      setFetchFrom(Math.max(0, idx - BEHIND));
    }
  }, [idx, fetchFrom]);

  /**
   * Images — and code, when the typist has opted out — are read, not typed. The
   * cursor walks forward to the next block that expects keystrokes.
   */
  const nextTypeable = useCallback(
    (start: number): number | null => {
      if (!book) return null;
      for (let i = start; i < book.blockCount; i += 1) {
        const block = byIdx.get(i);
        if (!block) return i; // not loaded yet — stop here and let the fetch land
        if (isTypeable(block, skipCode)) return i;
      }
      return null;
    },
    [book, byIdx, skipCode]
  );

  useEffect(() => {
    if (idx === null || !book) return;
    const block = byIdx.get(idx);
    if (!block || isTypeable(block, skipCode)) return;

    const next = nextTypeable(idx + 1);
    if (next !== null && next !== idx) setIdx(next);
  }, [idx, byIdx, book, skipCode, nextTypeable]);

  const currentBlock = idx === null ? undefined : byIdx.get(idx);
  const typing = isTypeable(currentBlock, skipCode);
  const finished = Boolean(book && idx !== null && idx >= book.blockCount - 1 && !typing);

  /* ---------------------------------------------------------------- *
   * Block state
   * ---------------------------------------------------------------- */

  const [state, setState] = useState<BlockState | null>(null);

  useEffect(() => {
    if (!currentBlock || !typing) {
      setState(null);
      return;
    }
    setState(createBlockState(currentBlock.text, options));
  }, [currentBlock?.id, typing, options]);

  /* ---------------------------------------------------------------- *
   * Metrics — kept in refs so keystrokes never trigger a re-render storm
   * ---------------------------------------------------------------- */

  const metricsRef = useRef<Metrics>(emptyMetrics());
  const lastKeyAtRef = useRef<number>(0);
  const savingRef = useRef(false);

  const flushSession = useCallback(async () => {
    const metrics = metricsRef.current;
    if (savingRef.current) return;
    if (metrics.keystrokes < 5 || metrics.activeMs < 1000) return;

    savingRef.current = true;
    const payload = {
      bookId,
      durationMs: Math.round(metrics.activeMs),
      keystrokes: metrics.keystrokes,
      correctChars: metrics.correctChars,
      errors: metrics.errors,
      blocksCompleted: metrics.blocksCompleted,
      proseChars: metrics.proseChars,
      proseMs: Math.round(metrics.proseMs),
      codeChars: metrics.codeChars,
      codeMs: Math.round(metrics.codeMs),
      errorsByKey: metrics.errorsByKey,
    };

    metricsRef.current = emptyMetrics();

    try {
      await apiRequest('POST', '/api/sessions', payload);
      queryClient.invalidateQueries({ queryKey: ['/api/stats'] });
    } finally {
      savingRef.current = false;
    }
  }, [bookId]);

  const savePosition = useCallback(
    (position: number) => {
      void apiRequest('PATCH', `/api/books/${bookId}`, { positionIdx: position }).then(() => {
        queryClient.invalidateQueries({ queryKey: ['/api/books'] });
      });
    },
    [bookId]
  );

  // Persist progress and the session periodically, and on the way out.
  const positionRef = useRef<number | null>(null);
  positionRef.current = idx;

  useEffect(() => {
    const interval = window.setInterval(() => {
      void flushSession();
      if (positionRef.current !== null) savePosition(positionRef.current);
    }, 60_000);

    const onLeave = () => {
      void flushSession();
      if (positionRef.current !== null) savePosition(positionRef.current);
    };
    window.addEventListener('beforeunload', onLeave);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener('beforeunload', onLeave);
      onLeave();
    };
  }, [flushSession, savePosition]);

  // Live HUD refresh while typing.
  useEffect(() => {
    if (paused) return;
    const interval = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(interval);
  }, [paused]);

  /* ---------------------------------------------------------------- *
   * Keyboard
   * ---------------------------------------------------------------- */

  const advance = useCallback(() => {
    setIdx((current) => {
      if (current === null) return current;
      const next = nextTypeable(current + 1);
      const target = next ?? current + 1;
      savePosition(target);
      return target;
    });
  }, [nextTypeable, savePosition]);

  const kindRef = useRef<string>('prose');
  kindRef.current = currentBlock?.kind ?? 'prose';

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      // Reading mode: Ctrl+M toggles in and out, and nothing else is live
      // while it's on — keystrokes are read, not scored.
      if (event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === 'm') {
        event.preventDefault();
        setReadingMode((r) => !r);
        return;
      }
      if (readingMode) return;

      // Ctrl+Down: skip the rest of the current line (code listings only —
      // prose has no internal line breaks, so it falls through to the block
      // skip below).
      if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === 'ArrowDown') {
        event.preventDefault();
        setState((previous) => {
          if (!previous) return previous;
          const skipped = skipLine(previous);
          if (skipped === previous) {
            window.setTimeout(advance, 0);
            return previous;
          }
          return skipped;
        });
        return;
      }

      // Ctrl+Right: skip the whole current paragraph / listing / figure.
      if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === 'ArrowRight') {
        event.preventDefault();
        advance();
        return;
      }

      // Never swallow other browser and OS shortcuts.
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        setPaused((p) => !p);
        void flushSession();
        return;
      }

      if (paused) {
        if (isTypingKey(event)) {
          event.preventDefault();
          setPaused(false);
        }
        return;
      }

      if (!isTypingKey(event)) return;
      if (shouldPreventDefault(event)) event.preventDefault();

      setState((previous) => {
        if (!previous) return previous;

        const now = performance.now();
        const gap = lastKeyAtRef.current ? now - lastKeyAtRef.current : 0;
        lastKeyAtRef.current = now;

        const outcome = applyKey(previous, event.key, options);
        metricsRef.current = recordKey(
          metricsRef.current,
          outcome,
          kindRef.current,
          gap,
          settings?.autoPauseMs
        );

        if (outcome.completed) {
          metricsRef.current = {
            ...metricsRef.current,
            blocksCompleted: metricsRef.current.blocksCompleted + 1,
          };
          // Let the finished block render once, then move on.
          window.setTimeout(advance, 90);
        }

        return outcome.state;
      });
    };

    window.addEventListener('keydown', onKeyDown, { passive: false });
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [advance, flushSession, options, paused, readingMode, settings?.autoPauseMs]);

  /* ---------------------------------------------------------------- *
   * Scroll the cursor into view
   * ---------------------------------------------------------------- */

  const activeRef = useRef<HTMLDivElement | null>(null);
  const scrolledOnceRef = useRef(false);

  // The block may mount after `idx` changes (its window is still loading), so
  // this also keys on the block itself. The first jump is instant; later moves
  // glide so the reader keeps their place.
  useEffect(() => {
    const node = activeRef.current;
    if (!node) return;

    node.scrollIntoView({
      block: 'center',
      behavior: scrolledOnceRef.current ? 'smooth' : 'auto',
    });
    scrolledOnceRef.current = true;
  }, [idx, currentBlock?.id]);

  /* ---------------------------------------------------------------- *
   * Render
   * ---------------------------------------------------------------- */

  const visible = useMemo(() => {
    if (idx === null) return [];
    const out: { block: BlockView; mode: BlockMode }[] = [];
    for (let i = Math.max(0, idx - BEHIND); i <= idx + AHEAD; i += 1) {
      const block = byIdx.get(i);
      if (!block) continue;
      out.push({ block, mode: i === idx ? 'active' : i < idx ? 'done' : 'ahead' });
    }
    return out;
  }, [idx, byIdx]);

  const metrics = metricsRef.current;
  void tick; // the interval above drives HUD refreshes
  const liveWpm = wpm(metrics.correctChars, metrics.activeMs);
  const liveAccuracy = accuracy(metrics.keystrokes, metrics.errors);
  const progress = book && idx !== null ? Math.min(100, (idx / Math.max(1, book.blockCount - 1)) * 100) : 0;

  if (!book || idx === null) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16">
        <div className="h-6 w-48 animate-pulse rounded bg-muted" />
        <div className="mt-8 space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-5 animate-pulse rounded bg-muted" style={{ width: `${90 - i * 8}%` }} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-32">
      {/* ---- Top bar ---- */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-4xl items-center gap-3 px-4">
          <Link
            href="/"
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover-elevate active-elevate-2"
            data-testid="link-back-library"
          >
            <ArrowLeft className="h-4 w-4" />
            <span className="hidden sm:inline">Library</span>
          </Link>

          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-foreground" data-testid="text-book-title">
              {book.title}
            </div>
            {currentBlock?.section && (
              <div className="truncate text-xs text-muted-foreground">{currentBlock.section}</div>
            )}
          </div>

          <button
            type="button"
            onClick={() => setOutlineOpen((o) => !o)}
            className="rounded-md p-2 text-muted-foreground hover-elevate active-elevate-2"
            aria-label="Chapters"
            data-testid="button-outline"
          >
            <List className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setReadingMode((r) => !r)}
            className={cn(
              'rounded-md p-2 hover-elevate active-elevate-2',
              readingMode ? 'text-primary' : 'text-muted-foreground'
            )}
            aria-label={readingMode ? 'Exit reading mode (Ctrl+M)' : 'Reading mode (Ctrl+M)'}
            title="Reading mode — Ctrl+M"
            data-testid="button-reading-mode"
          >
            <BookOpen className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              setPaused((p) => !p);
              void flushSession();
            }}
            className="rounded-md p-2 text-muted-foreground hover-elevate active-elevate-2"
            aria-label={paused ? 'Resume' : 'Pause'}
            data-testid="button-pause"
          >
            <Pause className="h-4 w-4" />
          </button>
        </div>

        <div className="h-0.5 w-full bg-border">
          <div
            className="h-full bg-primary transition-[width] duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
      </header>

      {/* ---- Chapter jump ---- */}
      {/* Fixed to the header rather than placed in the flow, so it is reachable
          no matter how far down the book you have scrolled. */}
      {outlineOpen && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOutlineOpen(false)}
            aria-hidden
          />
          <div className="fixed left-1/2 top-16 z-50 w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2">
            <div className="max-h-[60vh] overflow-y-auto rounded-lg border border-border bg-card p-2 shadow-lg">
            {(outline ?? []).length === 0 && (
              <div className="px-3 py-2 text-sm text-muted-foreground">No headings in this book.</div>
            )}
            {(outline ?? []).map((entry) => (
              <button
                key={entry.idx}
                type="button"
                onClick={() => {
                  void flushSession();
                  setFetchFrom(Math.max(0, entry.idx - BEHIND));
                  setIdx(entry.idx);
                  savePosition(entry.idx);
                  setOutlineOpen(false);
                }}
                className="block w-full truncate rounded-md px-3 py-1.5 text-left text-sm text-muted-foreground hover-elevate active-elevate-2"
                data-testid={`button-outline-${entry.idx}`}
              >
                {entry.section}
              </button>
            ))}
            </div>
          </div>
        </>
      )}

      {/* ---- Reading mode banner ---- */}
      {readingMode && (
        <div className="sticky top-14 z-30 border-b border-primary/30 bg-primary/10 px-4 py-1.5 text-center text-xs text-primary">
          Reading mode — keystrokes are not scored. Ctrl+M to resume typing.
        </div>
      )}

      {/* ---- Reading surface ---- */}
      <div className="mx-auto max-w-3xl px-4 pt-10">
        {readingMode && currentBlock ? (
          <div
            className={cn(
              'tw-block',
              settings?.typeface === 'serif' ? 'font-serif' : 'font-sans'
            )}
            style={{
              fontSize: settings?.readingFontSize ?? 18,
              lineHeight: READING_LINE_HEIGHT[settings?.readingLineHeight ?? 'm'],
            }}
            data-testid="text-reading-mode-block"
          >
            {currentBlock.kind === 'code' ? (
              <pre className="overflow-x-auto whitespace-pre font-mono" style={{ fontSize: Math.max(13, (settings?.readingFontSize ?? 18) - 4) }}>
                {currentBlock.text}
              </pre>
            ) : (
              currentBlock.text
            )}
          </div>
        ) : finished ? (
          <div className="rounded-xl border border-card-border bg-card px-6 py-16 text-center">
            <Check className="mx-auto h-8 w-8 text-primary" />
            <h2 className="mt-4 font-serif text-lg text-foreground">You reached the end</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Every block in {book.title} has been typed.
            </p>
            <button
              type="button"
              onClick={() => {
                setFetchFrom(0);
                setIdx(0);
                savePosition(0);
              }}
              className="mt-6 inline-flex items-center gap-2 rounded-md border border-primary-border bg-primary px-4 py-2 text-sm text-primary-foreground hover-elevate active-elevate-2"
              data-testid="button-restart"
            >
              <RotateCcw className="h-4 w-4" />
              Start again
            </button>
          </div>
        ) : (
          visible.map(({ block, mode }) => (
            <div
              key={block.id}
              ref={mode === 'active' ? activeRef : undefined}
              data-caret={mode === 'active' ? settings?.caretStyle ?? 'line' : undefined}
              className={cn(
                'border-l-2 pl-5 transition-colors',
                mode === 'active' ? 'border-primary/50' : 'border-transparent',
                mode === 'active' && settings?.keepInPosition === 1 && 'tw-keep-in-position bg-background'
              )}
            >
              <ReaderBlock
                block={block}
                mode={mode}
                state={mode === 'active' && state ? state : undefined}
                fontSize={settings?.fontSize ?? 20}
                typeface={settings?.typeface ?? 'serif'}
                markIncorrectWords={settings?.markIncorrectWords === 1}
              />
            </div>
          ))
        )}
      </div>

      {/* ---- Paused overlay ---- */}
      {paused && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur">
          <div className="rounded-xl border border-border bg-card px-8 py-10 text-center shadow-lg">
            <Keyboard className="mx-auto h-7 w-7 text-muted-foreground" />
            <h2 className="mt-4 font-serif text-lg text-foreground">Paused</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Press any key to carry on. Escape toggles this.
            </p>
          </div>
        </div>
      )}

      {/* ---- HUD ---- */}
      <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-border bg-background/90 backdrop-blur-sm">
        <div className="mx-auto flex max-w-4xl items-center gap-6 px-4 py-3">
          <HudStat label="WPM" value={liveWpm} testId="text-live-wpm" />
          <HudStat label="Accuracy" value={`${liveAccuracy}%`} testId="text-live-accuracy" />
          <HudStat
            label="Block"
            value={`${Math.min(idx + 1, book.blockCount).toLocaleString()} / ${book.blockCount.toLocaleString()}`}
            testId="text-position"
          />

          <div className="ml-auto flex items-center gap-2">
            {currentBlock?.kind === 'code' && (
              <span className="hidden rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground sm:inline">
                Enter for newline · Tab for indent
              </span>
            )}
            <button
              type="button"
              onClick={advance}
              className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-muted-foreground hover-elevate active-elevate-2"
              data-testid="button-skip"
            >
              <SkipForward className="h-4 w-4" />
              Skip
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function HudStat({
  label,
  value,
  testId,
}: {
  label: string;
  value: string | number;
  testId: string;
}) {
  return (
    <div>
      <div className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="font-mono text-sm tabular-nums text-foreground" data-testid={testId}>
        {value}
      </div>
    </div>
  );
}
