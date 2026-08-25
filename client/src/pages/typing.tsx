import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useRoute } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Link2,
  Keyboard,
  List,
  Pause,
  RotateCcw,
  SkipForward,
} from 'lucide-react';
import { ShortcutsOverlay } from '@/components/shortcuts';
import { Hint } from '@/components/hint';
import {
  ContentsPanel,
  JumpPalette,
  useOpenPage,
  usePageContext,
} from '@/components/page-nav';
import { LinksPanel, usePageLinks } from '@/components/links-panel';
import { playError } from '@/lib/sound';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { cn } from '@/lib/utils';
import { useSettings } from '@/components/chrome';
import { stringIsTypeable, type KeyboardLayout } from '@/lib/keyboard';
import { ReaderBlock, type BlockMode } from '@/components/reader';
import {
  accuracy,
  applyKey,
  createBlockState,
  emptyMetrics,
  isTypeable as blockIsTypeable,
  isTypingKey,
  recordKey,
  restartBlock,
  shouldPreventDefault,
  skipLine,
  wpm,
  type BlockState,
  type EngineOptions,
  type Metrics,
} from '@/lib/typing';
import type { BlockView, Book } from '@shared/schema';

/** Result of one typed block, shown as a small chip under the block. */
export interface BlockSummary {
  wpm: number;
  accuracy: number;
  durationMs: number;
  keystrokes: number;
  errors: number;
}

/** Blocks fetched per request, and how much slack to keep ahead of the cursor. */
const WINDOW = 60;
const REFETCH_MARGIN = 14;
/** Rendered context around the cursor. */
const BEHIND = 6;
const AHEAD = 8;
/** Reading mode is for reading, so it shows much more of the page. */
const READING_BEHIND = 10;
const READING_AHEAD = 24;

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
  /**
   * Mirror of `idx` in a ref so the keydown closure (bound once per render)
   * always sees the currently-active block when it computes a completion
   * summary. Without it, rapid auto-advance can write results against the
   * previous block's index and silently drop chips.
   */
  const idxRef = useRef<number | null>(null);
  const [fetchFrom, setFetchFrom] = useState(0);
  const [paused, setPaused] = useState(false);
  /**
   * Why the session is paused, so the overlay knows how loudly to interrupt.
   *
   * - `manual` (Escape or the Pause button): reader chose to stop; show the
   *   full overlay with the Library exit.
   * - `blur` (tab switch): reader left the app; show the full overlay because
   *   they may not come back for a while.
   * - `idle` (auto-pause after no keys): still on the page; show only a small
   *   floating chip so the reader can look around freely.
   */
  const [pauseReason, setPauseReason] = useState<'manual' | 'blur' | 'idle' | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [tick, setTick] = useState(0);
  /** A read-only view of the current position — no keystrokes are scored. */
  const [readingMode, setReadingMode] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [jumpOpen, setJumpOpen] = useState(false);
  const [linksOpen, setLinksOpen] = useState(false);
  const [, navigate] = useLocation();

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
    enabled: Number.isFinite(bookId),
  });

  /*
   * Per-block progress from the server. Loads once per book, then the client
   * writes back on every completion or skip so a page refresh or a book
   * switch keeps the chips and colours intact.
   */
  const { data: serverProgress } = useQuery<import('@shared/schema').BlockProgress[]>({
    queryKey: ['/api/books', bookId, 'progress'],
    enabled: Number.isFinite(bookId),
  });

  const skipCode = (settings?.skipCode ?? 0) === 1;

  /**
   * The keyboard layout the user has told us they are on, plus whether to
   * skip blocks the layout cannot type. Falls back to the widest setting if
   * settings have not loaded yet, so the reader never blocks progress.
   */
  const keyboardLayout: KeyboardLayout =
    (settings?.keyboardLayout as KeyboardLayout | undefined) ?? 'any';
  const skipUntypeable = settings?.skipUntypeable === 1 && keyboardLayout !== 'any';

  const matchesLayout = useCallback(
    (block: BlockView): boolean => {
      if (!skipUntypeable) return true;
      if (block.kind === 'image' || block.kind === 'embed') return true;
      return stringIsTypeable(block.text, keyboardLayout);
    },
    [skipUntypeable, keyboardLayout]
  );

  /* ---------------------------------------------------------------- *
   * Position
   * ---------------------------------------------------------------- */

  // A different page means a fresh cursor, window, and reading position.
  useEffect(() => {
    setIdx(null);
    setFetchFrom(0);
    setLinksOpen(false);
    setBlockResults({});
    setSkippedBlocks(new Set());
    scrolledOnceRef.current = false;
  }, [bookId]);

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
        if (blockIsTypeable(block, skipCode) && matchesLayout(block)) return i;
      }
      return null;
    },
    [book, byIdx, skipCode, matchesLayout]
  );

  useEffect(() => {
    if (idx === null || !book) return;
    const block = byIdx.get(idx);
    if (!block || (blockIsTypeable(block, skipCode) && matchesLayout(block))) return;

    const next = nextTypeable(idx + 1);
    if (next !== null && next !== idx) {
      setIdx(next);
    } else if (next === null && book && idx < book.blockCount - 1) {
      // Nothing typeable ahead — land on the last block so the finished view
      // takes over and explains why.
      setIdx(book.blockCount - 1);
    }
  }, [idx, byIdx, book, skipCode, nextTypeable, matchesLayout]);

  const currentBlock = idx === null ? undefined : byIdx.get(idx);
  const typing = !!currentBlock && blockIsTypeable(currentBlock, skipCode) && matchesLayout(currentBlock);

  // Case is only ever relaxed in prose; a listing that ignores case is wrong.
  /* ---------------------------------------------------------------- *
   * Documentation navigation
   * ---------------------------------------------------------------- */

  const { data: pageContext } = usePageContext(bookId);
  const { data: pageLinks, isLoading: linksLoading } = usePageLinks(bookId, linksOpen);
  const openPage = useOpenPage();
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);

  /** Opens another page in the same doc set, importing it first if needed. */
  const openUrl = useCallback(
    (url: string) => {
      setPendingUrl(url);
      openPage.mutate(url, {
        onSuccess: ({ bookId: target }) => {
          setPendingUrl(null);
          setJumpOpen(false);
          setOutlineOpen(false);
          if (target !== bookId) navigate(`/type/${target}`);
        },
        onError: () => setPendingUrl(null),
      });
    },
    [openPage, navigate, bookId]
  );

  const options: EngineOptions = useMemo(
    () => ({
      mistakeMode: (settings?.mistakeMode ?? 'block') as EngineOptions['mistakeMode'],
      autoIndent: (settings?.autoIndent ?? 1) === 1,
      ignoreCase: (settings?.ignoreCaseProse ?? 0) === 1 && currentBlock?.kind !== 'code',
    }),
    [settings?.mistakeMode, settings?.autoIndent, settings?.ignoreCaseProse, currentBlock?.kind]
  );
  const finished = Boolean(book && idx !== null && idx >= book.blockCount - 1 && !typing);

  /* ---------------------------------------------------------------- *
   * Block state
   * ---------------------------------------------------------------- */

  const [state, setState] = useState<BlockState | null>(null);

  useEffect(() => {
    idxRef.current = idx;
  }, [idx]);

  useEffect(() => {
    if (!currentBlock || !typing) {
      setState(null);
      return;
    }
    setState(createBlockState(currentBlock.text, options));
    blockBaselineRef.current = { ...metricsRef.current };
  }, [currentBlock?.id, typing, options]);

  /* ---------------------------------------------------------------- *
   * Metrics — kept in refs so keystrokes never trigger a re-render storm
   * ---------------------------------------------------------------- */

  const metricsRef = useRef<Metrics>(emptyMetrics());
  const lastKeyAtRef = useRef<number>(0);
  const savingRef = useRef(false);

  /**
   * Metrics captured at the start of the current block, so per-block WPM and
   * accuracy can be computed by subtracting them from the running totals.
   * Reset whenever the block changes.
   */
  const blockBaselineRef = useRef<Metrics>(emptyMetrics());

  /**
   * Results of every block that was actually typed, keyed by block idx.
   *
   * Skipped blocks never write here, so the reader can tell whether a "done"
   * block was typed through or jumped past — a colour difference and a small
   * summary under the block use this map.
   */
  const [blockResults, setBlockResults] = useState<Record<number, BlockSummary>>({});
  /**
   * Indexes of blocks the reader deliberately moved past without completing.
   * A block enters this set when advance/retreat/jump leaves it while the
   * block state is not `done`. Typed blocks never enter this set even if the
   * reader later revisits and skips them.
   */
  const [skippedBlocks, setSkippedBlocks] = useState<Set<number>>(() => new Set());

  /*
   * Hydrate the two per-block maps whenever fresh progress arrives from the
   * server. Only fills in rows the client does not already have, so the
   * optimistic writes made during a live session are preserved.
   */
  useEffect(() => {
    if (!serverProgress?.length) return;
    setBlockResults((prior) => {
      const next = { ...prior };
      let changed = false;
      for (const row of serverProgress) {
        if (row.status === 'typed' && !next[row.blockIdx] && row.wpm !== null && row.accuracyBp !== null) {
          next[row.blockIdx] = {
            wpm: row.wpm,
            accuracy: Math.round(row.accuracyBp / 100),
            durationMs: row.durationMs ?? 0,
            keystrokes: row.keystrokes ?? 0,
            errors: row.errors ?? 0,
          };
          changed = true;
        }
      }
      return changed ? next : prior;
    });
    setSkippedBlocks((prior) => {
      const next = new Set(prior);
      let changed = false;
      for (const row of serverProgress) {
        if (row.status === 'skipped' && !next.has(row.blockIdx)) {
          next.add(row.blockIdx);
          changed = true;
        }
      }
      return changed ? next : prior;
    });
  }, [serverProgress]);

  /*
   * Fire-and-forget POST for a completion or skip. The optimistic client
   * state has already been updated; if the request fails we simply retry on
   * the next event.
   */
  const persistProgress = useCallback(
    (payload: {
      blockIdx: number;
      status: 'typed' | 'skipped';
      wpm?: number;
      accuracyBp?: number;
      durationMs?: number;
      keystrokes?: number;
      errors?: number;
    }) => {
      if (!Number.isFinite(bookId)) return;
      void apiRequest('POST', `/api/books/${bookId}/progress`, {
        blockIdx: payload.blockIdx,
        status: payload.status,
        wpm: payload.wpm ?? null,
        accuracyBp: payload.accuracyBp ?? null,
        durationMs: payload.durationMs ?? null,
        keystrokes: payload.keystrokes ?? null,
        errors: payload.errors ?? null,
      }).catch(() => {
        /* server persistence is opportunistic; the reader keeps typing */
      });
    },
    [bookId]
  );

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

  /**
   * Record a block as skipped. Typed blocks are never marked skipped, so
   * revisiting a typed block and moving off it does not clear the typed chip.
   */
  const markSkipped = useCallback(
    (blockIdx: number) => {
      setSkippedBlocks((prior) => {
        if (prior.has(blockIdx)) return prior;
        const next = new Set(prior);
        next.add(blockIdx);
        return next;
      });
      persistProgress({ blockIdx, status: 'skipped' });
    },
    [persistProgress]
  );

  /** Moves the cursor to a block, persisting the new position. */
  const goTo = useCallback(
    (target: number) => {
      const clamped = Math.max(0, target);
      /*
       * Jumping forward past the current block (outline click, next-section
       * shortcut, next-page button) counts as a skip unless the block was
       * completed. Jumping to the same block or earlier is a navigation, not
       * a skip.
       */
      const current = idxRef.current;
      if (
        current !== null &&
        clamped > current &&
        stateRef.current &&
        !stateRef.current.done
      ) {
        markSkipped(current);
      }
      setFetchFrom((from) => (clamped < from || clamped > from + WINDOW - REFETCH_MARGIN ? Math.max(0, clamped - BEHIND) : from));
      setIdx(clamped);
      savePosition(clamped);
    },
    [savePosition, markSkipped]
  );

  const advance = useCallback(() => {
    setIdx((current) => {
      if (current === null) return current;
      /*
       * A block that is being left behind without being completed is a skip,
       * whether the reader pressed Skip, Ctrl+Right, or clicked next. The
       * `stateRef` is checked before we move so a just-completed block is not
       * misfiled as skipped.
       */
      if (!stateRef.current?.done) {
        markSkipped(current);
      }
      const next = nextTypeable(current + 1);
      const target = next ?? current + 1;
      savePosition(target);
      return target;
    });
  }, [nextTypeable, savePosition, markSkipped]);

  /** Walks back to the previous block that expects keystrokes. */
  const retreat = useCallback(() => {
    setIdx((current) => {
      if (current === null || current === 0) return current;
      for (let i = current - 1; i >= 0; i -= 1) {
        const block = byIdx.get(i);
        if (!block) break;
        if (blockIsTypeable(block, skipCode) && matchesLayout(block)) {
          savePosition(i);
          return i;
        }
      }
      const target = Math.max(0, current - 1);
      savePosition(target);
      return target;
    });
  }, [byIdx, savePosition, skipCode, matchesLayout]);

  /** Jumps to the neighbouring section heading, using the chapter outline. */
  const jumpSection = useCallback(
    (direction: 1 | -1) => {
      if (idx === null || !outline?.length) return;
      const target =
        direction === 1
          ? outline.find((entry) => entry.idx > idx)
          : [...outline].reverse().find((entry) => entry.idx < idx);
      if (target) goTo(target.idx);
    },
    [idx, outline, goTo]
  );

  const kindRef = useRef<string>('prose');
  kindRef.current = currentBlock?.kind ?? 'prose';

  const stateRef = useRef<BlockState | null>(null);
  stateRef.current = state;

  const advanceMode = settings?.advanceMode ?? 'auto';

  /* ---------------------------------------------------------------- *
   * Auto-pause
   *
   * The same threshold that stops counting idle time also parks the session,
   * so the clock and the screen agree about whether you are still working.
   * ---------------------------------------------------------------- */

  const autoPauseMs = settings?.autoPauseMs ?? 5000;

  useEffect(() => {
    if (paused || readingMode || autoPauseMs <= 0) return;

    const interval = window.setInterval(() => {
      if (!lastKeyAtRef.current) return;
      if (performance.now() - lastKeyAtRef.current < autoPauseMs) return;

      lastKeyAtRef.current = 0;
      setPaused(true);
      setPauseReason('idle');
      void flushSession();
    }, 500);

    return () => window.clearInterval(interval);
  }, [paused, readingMode, autoPauseMs, flushSession]);

  /*
   * When the tab is hidden or the window loses focus, pause loudly so the
   * reader is nudged to reconnect on return. Coming back to the tab does not
   * un-pause automatically — pressing any key does, mirroring the idle path.
   */
  useEffect(() => {
    if (readingMode) return;
    const onHide = () => {
      if (document.visibilityState === 'hidden') {
        setPaused(true);
        setPauseReason((prev) => prev === 'manual' ? prev : 'blur');
        void flushSession();
      }
    };
    const onBlur = () => {
      setPaused(true);
      setPauseReason((prev) => prev === 'manual' ? prev : 'blur');
      void flushSession();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('blur', onBlur);
    };
  }, [readingMode, flushSession]);

  /* ---------------------------------------------------------------- *
   * Keyboard
   *
   * Typing consumes every printable key, so in-session commands live on
   * modifiers. Reading mode scores nothing, which frees the bare keys.
   * ---------------------------------------------------------------- */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      const ctrl = event.ctrlKey && !event.metaKey && !event.altKey;

      /* ---- Available in both modes ---- */

      if (ctrl && event.key.toLowerCase() === 'm') {
        event.preventDefault();
        setReadingMode((reading) => {
          // Leaving reading mode resumes a clean session clock; entering it
          // banks the session so far and clears any pause.
          lastKeyAtRef.current = 0;
          if (!reading) void flushSession();
          setPaused(false);
          setPauseReason(null);
          return !reading;
        });
        return;
      }

      if (ctrl && (event.key === '/' || event.key === '?')) {
        event.preventDefault();
        setShortcutsOpen((open) => !open);
        return;
      }

      /* ---- Documentation set navigation ---- */

      if (ctrl && (event.key === 'l' || event.key === 'L')) {
        event.preventDefault();
        setLinksOpen((open) => !open);
        return;
      }

      if (ctrl && (event.key === 'o' || event.key === 'O')) {
        event.preventDefault();
        setOutlineOpen((open) => !open);
        return;
      }

      if (ctrl && event.key === ';' && pageContext) {
        event.preventDefault();
        setJumpOpen((open) => !open);
        return;
      }

      if (ctrl && event.key === '.' && pageContext?.next?.url) {
        event.preventDefault();
        openUrl(pageContext.next.url);
        return;
      }

      if (ctrl && event.key === ',' && pageContext?.previous?.url) {
        event.preventDefault();
        openUrl(pageContext.previous.url);
        return;
      }

      // The palette owns the keyboard while it is open.
      if (jumpOpen) {
        if (event.key === 'Escape') {
          event.preventDefault();
          setJumpOpen(false);
        }
        return;
      }

      if (shortcutsOpen) {
        if (event.key === 'Escape' || event.key === 'Enter') {
          event.preventDefault();
          setShortcutsOpen(false);
        }
        return;
      }

      /* ---- Reading mode: bare keys navigate ---- */

      if (readingMode) {
        if (event.shiftKey && event.key === 'ArrowRight') {
          event.preventDefault();
          jumpSection(1);
          return;
        }
        if (event.shiftKey && event.key === 'ArrowLeft') {
          event.preventDefault();
          jumpSection(-1);
          return;
        }
        if (event.key === 'ArrowDown' || event.key.toLowerCase() === 'j') {
          event.preventDefault();
          advance();
          return;
        }
        if (event.key === 'ArrowUp' || event.key.toLowerCase() === 'k') {
          event.preventDefault();
          retreat();
          return;
        }
        if (event.key === 'Enter' || event.key === 'Escape') {
          event.preventDefault();
          lastKeyAtRef.current = 0;
          setReadingMode(false);
          return;
        }
        return; // Space, PageDown and friends keep their native scrolling
      }

      /* ---- Typing mode commands ---- */

      if (ctrl && event.shiftKey && event.key === 'ArrowRight') {
        event.preventDefault();
        jumpSection(1);
        return;
      }
      if (ctrl && event.shiftKey && event.key === 'ArrowLeft') {
        event.preventDefault();
        jumpSection(-1);
        return;
      }

      // Skip the rest of the current line. Prose has no internal breaks, so
      // there it degrades to skipping the whole block.
      if (ctrl && event.key === 'ArrowDown') {
        event.preventDefault();
        setState((previous) => {
          if (!previous) return previous;
          const skipped = skipLine(previous, options);
          if (skipped === previous) {
            window.setTimeout(advance, 0);
            return previous;
          }
          return skipped;
        });
        return;
      }

      if (ctrl && event.key === 'ArrowRight') {
        event.preventDefault();
        advance();
        return;
      }

      if (ctrl && event.key === 'ArrowLeft') {
        event.preventDefault();
        retreat();
        return;
      }

      if (ctrl && event.key === 'Backspace') {
        event.preventDefault();
        setState((previous) => (previous ? restartBlock(previous, options) : previous));
        return;
      }

      // Never swallow other browser and OS shortcuts.
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      // With confirm-to-advance, a finished block waits here for Enter.
      if (advanceMode === 'confirm' && stateRef.current?.done && event.key === 'Enter') {
        event.preventDefault();
        advance();
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        setPaused((p) => {
          const next = !p;
          setPauseReason(next ? 'manual' : null);
          return next;
        });
        void flushSession();
        return;
      }

      if (paused) {
        if (isTypingKey(event)) {
          event.preventDefault();
          lastKeyAtRef.current = 0;
          setPaused(false);
          setPauseReason(null);
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
        if (!outcome.correct && outcome.counted && settings?.soundOnError === 1) playError();
        metricsRef.current = recordKey(
          metricsRef.current,
          outcome,
          kindRef.current,
          gap,
          autoPauseMs
        );

        if (outcome.completed) {
          metricsRef.current = {
            ...metricsRef.current,
            blocksCompleted: metricsRef.current.blocksCompleted + 1,
          };

          /*
           * Take the delta between the block's baseline and the running totals
           * to describe how the reader just did on this block alone. Errors
           * are counted so accuracy reflects the run, not the whole session.
           */
          const baseline = blockBaselineRef.current;
          const totals = metricsRef.current;
          const durationMs = Math.max(0, totals.activeMs - baseline.activeMs);
          const keystrokes = totals.keystrokes - baseline.keystrokes;
          const correct = totals.correctChars - baseline.correctChars;
          const errors = totals.errors - baseline.errors;

          const completedIdx = idxRef.current;
          if (completedIdx !== null && keystrokes > 0) {
            // A block that was previously skipped and then re-typed loses the skip mark.
            setSkippedBlocks((prior) => {
              if (!prior.has(completedIdx)) return prior;
              const next = new Set(prior);
              next.delete(completedIdx);
              return next;
            });
            const blockWpm = wpm(correct, durationMs);
            const blockAccuracy = accuracy(keystrokes, errors);
            setBlockResults((prior) => ({
              ...prior,
              [completedIdx]: {
                wpm: blockWpm,
                accuracy: blockAccuracy,
                durationMs,
                keystrokes,
                errors,
              },
            }));
            persistProgress({
              blockIdx: completedIdx,
              status: 'typed',
              wpm: blockWpm,
              accuracyBp: Math.round(blockAccuracy * 100),
              durationMs,
              keystrokes,
              errors,
            });
          }

          // Let the finished block render once, then move on.
          if (advanceMode === 'auto') window.setTimeout(advance, 90);
        }

        return outcome.state;
      });
    };

    window.addEventListener('keydown', onKeyDown, { passive: false });
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    advance,
    retreat,
    jumpSection,
    flushSession,
    options,
    paused,
    readingMode,
    shortcutsOpen,
    autoPauseMs,
    advanceMode,
    settings?.soundOnError,
    pageContext,
    jumpOpen,
    openUrl,
  ]);

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
    const behind = readingMode ? READING_BEHIND : BEHIND;
    const ahead = readingMode ? READING_AHEAD : AHEAD;
    const out: { block: BlockView; mode: BlockMode; summary: BlockSummary | null }[] = [];
    for (let i = Math.max(0, idx - behind); i <= idx + ahead; i += 1) {
      const block = byIdx.get(i);
      if (!block) continue;
      /*
       * A block above the cursor is either a page you typed through, one you
       * deliberately jumped past, or one that was never active. Each state
       * gets its own colour and its own chip so a mid-page mix is unambiguous.
       */
      const summary = blockResults[i] ?? null;
      let mode: BlockMode;
      if (i === idx) mode = 'active';
      else if (i > idx) mode = 'ahead';
      else if (summary) mode = 'typed';
      else if (skippedBlocks.has(i)) mode = 'skipped';
      else mode = 'done';
      out.push({ block, mode, summary });
    }
    return out;
  }, [idx, byIdx, readingMode, blockResults, skippedBlocks]);

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
            <div className="truncate text-xs text-muted-foreground">
              {pageContext ? (
                <>
                  <span>{pageContext.collection.title}</span>
                  {currentBlock?.section && <span> · {currentBlock.section}</span>}
                </>
              ) : (
                currentBlock?.section
              )}
            </div>
          </div>

          {book.sourceUrl && (
            <Hint label="Open the original page">
              <a
                href={book.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded-md p-2 text-muted-foreground hover-elevate active-elevate-2"
                aria-label={`Open ${book.title} on ${new URL(book.sourceUrl).hostname}`}
                data-testid="button-open-source"
              >
                <ExternalLink className="h-4 w-4" />
              </a>
            </Hint>
          )}

          {/*
            * Prev/next belong in the header for every book. When a page is part
            * of a documentation set they walk the TOC; on a file they step to
            * the neighbouring block, which is what "the previous page" means
            * when there is only one page.
            */}
          <Hint
            label={
              pageContext?.previous
                ? `Previous page: ${pageContext.previous.title}`
                : book.sourceUrl
                  ? 'No previous page'
                  : 'Back to the previous paragraph'
            }
            keys={['Ctrl', pageContext ? ',' : 'Left']}
          >
            <button
              type="button"
              disabled={
                pageContext ? !pageContext.previous?.url || openPage.isPending : idx === null || idx === 0
              }
              onClick={() => {
                if (pageContext?.previous?.url) openUrl(pageContext.previous.url);
                else if (idx !== null && idx > 0) {
                  const target = idx - 1;
                  setIdx(target);
                  savePosition(target);
                }
              }}
              className="rounded-md p-2 text-muted-foreground hover-elevate active-elevate-2 disabled:opacity-40"
              aria-label="Previous"
              data-testid="button-prev-page"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          </Hint>
          <Hint
            label={
              pageContext?.next
                ? `Next page: ${pageContext.next.title}`
                : book.sourceUrl
                  ? 'No next page'
                  : 'Skip this paragraph'
            }
            keys={['Ctrl', pageContext ? '.' : 'Right']}
          >
            <button
              type="button"
              disabled={
                pageContext
                  ? !pageContext.next?.url || openPage.isPending
                  : idx === null || idx >= book.blockCount - 1
              }
              onClick={() => {
                if (pageContext?.next?.url) openUrl(pageContext.next.url);
                else if (idx !== null && idx < book.blockCount - 1) {
                  const target = idx + 1;
                  setIdx(target);
                  savePosition(target);
                }
              }}
              className="rounded-md p-2 text-muted-foreground hover-elevate active-elevate-2 disabled:opacity-40"
              aria-label="Next"
              data-testid="button-next-page"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </Hint>

          <Hint label="Links on this page" keys={['Ctrl', 'L']}>
            <button
              type="button"
              onClick={() => setLinksOpen((o) => !o)}
              className={cn(
                'rounded-md p-2 hover-elevate active-elevate-2',
                linksOpen ? 'bg-secondary text-foreground' : 'text-muted-foreground'
              )}
              aria-label="Links on this page"
              data-testid="button-links"
            >
              <Link2 className="h-4 w-4" />
            </button>
          </Hint>
          <Hint label="Contents" keys={['Ctrl', 'O']}>
            <button
              type="button"
              onClick={() => setOutlineOpen((o) => !o)}
              className="rounded-md p-2 text-muted-foreground hover-elevate active-elevate-2"
              aria-label="Contents"
              data-testid="button-outline"
            >
              <List className="h-4 w-4" />
            </button>
          </Hint>
          <Hint label={readingMode ? 'Exit reading mode' : 'Reading mode'} keys={['Ctrl', 'M']}>
            <button
              type="button"
              onClick={() => {
                setReadingMode((reading) => {
                  lastKeyAtRef.current = 0;
                  if (!reading) void flushSession();
                  return !reading;
                });
                setPaused(false);
                setPauseReason(null);
              }}
              className={cn(
                'rounded-md p-2 hover-elevate active-elevate-2',
                readingMode ? 'text-primary' : 'text-muted-foreground'
              )}
              aria-label={readingMode ? 'Exit reading mode' : 'Reading mode'}
              data-testid="button-reading-mode"
            >
              <BookOpen className="h-4 w-4" />
            </button>
          </Hint>
          <Hint label={paused ? 'Resume' : 'Pause'} keys={['Esc']}>
            <button
              type="button"
              onClick={() => {
                setPaused((p) => {
                  const next = !p;
                  setPauseReason(next ? 'manual' : null);
                  return next;
                });
                void flushSession();
              }}
              className="rounded-md p-2 text-muted-foreground hover-elevate active-elevate-2"
              aria-label={paused ? 'Resume' : 'Pause'}
              data-testid="button-pause"
            >
              <Pause className="h-4 w-4" />
            </button>
          </Hint>
        </div>

        <div className="h-0.5 w-full bg-border">
          <div
            className="h-full bg-primary transition-[width] duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
      </header>

      {/* ---- Contents: the doc set's TOC, or this page's headings ---- */}
      {outlineOpen &&
        (pageContext ? (
          <ContentsPanel
            context={pageContext}
            currentUrl={book.sourceUrl ?? null}
            outline={outline ?? []}
            pendingUrl={pendingUrl}
            onOpenUrl={openUrl}
            onJumpBlock={(target) => {
              void flushSession();
              setFetchFrom(Math.max(0, target - BEHIND));
              setIdx(target);
              savePosition(target);
              setOutlineOpen(false);
            }}
            onClose={() => setOutlineOpen(false)}
          />
        ) : (
          /* A file-based book has chapters but no page navigation. */
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOutlineOpen(false)} aria-hidden />
            <div className="fixed left-1/2 top-16 z-50 w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2">
              <div className="max-h-[60vh] overflow-y-auto rounded-lg border border-border bg-card p-2 shadow-lg">
                {(outline ?? []).length === 0 && (
                  <div className="px-3 py-2 text-sm text-muted-foreground">
                    No headings in this book.
                  </div>
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
        ))}

      {linksOpen && (
        <LinksPanel
          links={pageLinks ?? []}
          loading={linksLoading}
          currentIdx={idx}
          pendingUrl={pendingUrl}
          onJumpBlock={(target) => {
            void flushSession();
            setFetchFrom(Math.max(0, target - BEHIND));
            setIdx(target);
            savePosition(target);
          }}
          onOpenPage={openUrl}
          onClose={() => setLinksOpen(false)}
        />
      )}

      {jumpOpen && pageContext && (
        <JumpPalette
          context={pageContext}
          currentUrl={book.sourceUrl ?? null}
          pendingUrl={pendingUrl}
          onOpenUrl={openUrl}
          onClose={() => setJumpOpen(false)}
        />
      )}

      {/* ---- Reading surface ---- */}
      <div
        className={cn(
          'mx-auto max-w-3xl px-4 pt-10 transition-[padding] duration-200',
          linksOpen && 'lg:pr-[22rem]'
        )}
      >
        {finished ? (
          <div className="rounded-xl border border-card-border bg-card px-6 py-16 text-center">
            <Check className="mx-auto h-8 w-8 text-primary" />
            <h2 className="mt-4 font-serif text-lg text-foreground">
              {skipUntypeable ? 'Nothing typeable on this page' : 'You reached the end'}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {skipUntypeable
                ? `Every block on this page uses characters your ${keyboardLayout === 'us-intl' ? 'US International' : 'US'} layout cannot type. Change the layout in Settings to widen what counts as typeable.`
                : `Every block in ${book.title} has been typed.`}
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
          visible.map(({ block, mode, summary }) => (
            <div
              key={block.id}
              ref={mode === 'active' ? activeRef : undefined}
              data-caret={mode === 'active' ? settings?.caretStyle ?? 'line' : undefined}
              data-caret-blink={
                mode === 'active' ? (settings?.caretBlink === 0 ? 'off' : 'on') : undefined
              }
              className={cn(
                'border-l-2 pl-5 transition-colors',
                mode === 'active' ? 'border-primary/50' : 'border-transparent',
                mode === 'active' &&
                  !readingMode &&
                  settings?.keepInPosition === 1 &&
                  'tw-keep-in-position bg-background'
              )}
            >
              <ReaderBlock
                block={block}
                mode={mode}
                state={!readingMode && mode === 'active' && state ? state : undefined}
                fontSize={readingMode ? settings?.readingFontSize ?? 18 : settings?.fontSize ?? 20}
                lineHeight={
                  readingMode ? READING_LINE_HEIGHT[settings?.readingLineHeight ?? 'm'] : undefined
                }
                typeface={settings?.typeface ?? 'serif'}
                markIncorrectWords={settings?.markIncorrectWords === 1}
                showNewlines={settings?.showNewlines !== 0}
                keyboardLayout={skipUntypeable ? keyboardLayout : undefined}
                summary={summary}
              />
            </div>
          ))
        )}
      </div>

      {/* ---- Paused overlay ---- */}
      {paused && !readingMode && (pauseReason === 'manual' || pauseReason === 'blur') && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur">
          <div className="rounded-xl border border-border bg-card px-8 py-10 text-center shadow-lg">
            <Keyboard className="mx-auto h-7 w-7 text-muted-foreground" />
            <h2 className="mt-4 font-serif text-lg text-foreground">Paused</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {pauseReason === 'blur'
                ? 'Session paused because the tab lost focus. Press any key to carry on.'
                : 'Press any key to carry on. Escape toggles this.'}
            </p>
            <button
              type="button"
              onClick={() => {
                void flushSession();
                navigate('/');
              }}
              className="mt-6 inline-flex items-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-sm text-foreground transition hover:bg-muted"
              data-testid="button-paused-library"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to library
            </button>
          </div>
        </div>
      )}

      {/* ---- Idle-pause chip (non-blocking) ---- */}
      {paused && !readingMode && pauseReason === 'idle' && (
        <div
          className="fixed bottom-16 left-1/2 z-40 -translate-x-1/2 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground shadow-sm"
          data-testid="chip-paused-idle"
        >
          Paused · press any key to resume
        </div>
      )}

      {shortcutsOpen && <ShortcutsOverlay onClose={() => setShortcutsOpen(false)} />}

      {/* ---- HUD ---- */}
      {!readingMode && (
      <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-border bg-background/90 backdrop-blur-sm">
        <div className="mx-auto flex max-w-4xl items-center gap-6 px-4 py-3">
          <span className="hidden text-[10px] font-medium uppercase tracking-wide text-muted-foreground sm:inline">
            This session
          </span>
          <HudStat label="WPM" value={liveWpm} testId="text-live-wpm" />
          <HudStat label="Accuracy" value={`${liveAccuracy}%`} testId="text-live-accuracy" />
          <HudStat
            label="Position"
            value={`${Math.min(idx + 1, book.blockCount).toLocaleString()} / ${book.blockCount.toLocaleString()}`}
            testId="text-position"
          />

          <div className="ml-auto flex items-center gap-2">
            {advanceMode === 'confirm' && state?.done && (
              <span
                className="rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs text-primary"
                data-testid="text-confirm-hint"
              >
                Enter to continue
              </span>
            )}
            {currentBlock?.kind === 'code' && !state?.done && (
              <span className="hidden rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground sm:inline">
                Enter for newline · Tab for indent
              </span>
            )}
            <Hint label="Shortcuts" keys={['Ctrl', '/']}>
              <button
                type="button"
                onClick={() => setShortcutsOpen(true)}
                className="rounded-md p-2 text-muted-foreground hover-elevate active-elevate-2"
                aria-label="Shortcuts"
                data-testid="button-shortcuts"
              >
                <Keyboard className="h-4 w-4" />
              </button>
            </Hint>
            <Hint label="Skip this block" keys={['Ctrl', 'Right']}>
              <button
                type="button"
                onClick={advance}
                className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-muted-foreground hover-elevate active-elevate-2"
                data-testid="button-skip"
              >
                <SkipForward className="h-4 w-4" />
                Skip
              </button>
            </Hint>
          </div>
        </div>
      </div>
      )}
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
