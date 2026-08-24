import type { BlockView } from '@shared/schema';

/**
 * Typing engine — pure logic, no React.
 *
 * A block is a string of expected characters plus a per-character status array
 * and a cursor. Prose and code differ only in three rules:
 *
 *   - code contains newlines, so Enter is a real expected character
 *   - after Enter, auto-indent can consume the next line's leading spaces
 *   - Tab consumes expected indentation instead of moving focus
 *
 * Character status drives colour only, never weight, so the text never reflows.
 */

export type CharStatus = 'pending' | 'correct' | 'wrong' | 'skipped';

export interface BlockState {
  /** Exactly what must be typed. */
  expected: string;
  status: CharStatus[];
  /** Index of the next character to type. */
  pos: number;
  /** True once pos reaches the end with no unresolved mistakes. */
  done: boolean;
}

export type MistakeMode = 'block' | 'mark' | 'fix';

export interface EngineOptions {
  /**
   * block — hold the cursor on a mistake until it is corrected
   * mark  — mark the mistake and move on
   * fix   — count the mistake, then fill in the right character
   */
  mistakeMode: MistakeMode;
  /** Skip the next line's indentation automatically after Enter. */
  autoIndent: boolean;
  /** Accept the wrong case. Never applied inside a listing. */
  ignoreCase: boolean;
}

/** What a keystroke did, so the caller can update metrics. */
export interface KeyOutcome {
  state: BlockState;
  /** A real keystroke that counted toward speed and accuracy. */
  counted: boolean;
  correct: boolean;
  /** Characters newly resolved as correct (auto-indent can resolve several). */
  correctChars: number;
  /** The expected character when a mistake was made, for the error histogram. */
  missedKey: string | null;
  /** The block was completed by this keystroke. */
  completed: boolean;
}

export const TYPEABLE_KINDS = new Set(['prose', 'heading', 'code']);

export function isTypeable(block: BlockView | undefined, skipCode: boolean): boolean {
  if (!block) return false;
  if (!TYPEABLE_KINDS.has(block.kind)) return false;
  if (skipCode && block.kind === 'code') return false;
  return block.text.trim().length > 0;
}

export function createBlockState(expected: string, options: EngineOptions): BlockState {
  const state: BlockState = {
    expected,
    status: Array<CharStatus>(expected.length).fill('pending'),
    pos: 0,
    done: expected.length === 0,
  };

  // A listing may open on an indented line; fill that indentation in for free.
  if (options.autoIndent) consumeIndent(state);
  return state;
}

/** Marks a run of leading spaces at the cursor as filled-in whitespace. */
function consumeIndent(state: BlockState): number {
  let filled = 0;
  while (state.pos < state.expected.length && state.expected[state.pos] === ' ') {
    // Only indentation counts — a space mid-line must still be typed.
    const lineStart = state.expected.lastIndexOf('\n', state.pos - 1) + 1;
    if (state.expected.slice(lineStart, state.pos).trim().length > 0) break;
    state.status[state.pos] = 'skipped';
    state.pos += 1;
    filled += 1;
  }
  return filled;
}

function finish(state: BlockState): boolean {
  if (state.pos < state.expected.length) return false;
  state.done = !state.status.includes('wrong');
  return state.done;
}

const NO_OP = (state: BlockState): KeyOutcome => ({
  state,
  counted: false,
  correct: false,
  correctChars: 0,
  missedKey: null,
  completed: false,
});

/**
 * Apply one key to a block. `key` is a KeyboardEvent.key value; only printable
 * keys, 'Enter', 'Tab', and 'Backspace' do anything.
 */
export function applyKey(previous: BlockState, key: string, options: EngineOptions): KeyOutcome {
  const state: BlockState = {
    expected: previous.expected,
    status: [...previous.status],
    pos: previous.pos,
    done: previous.done,
  };

  if (key === 'Backspace') {
    if (state.pos === 0) return NO_OP(state);

    // Step back over auto-filled indentation in one go.
    let cursor = state.pos - 1;
    while (cursor > 0 && state.status[cursor] === 'skipped') cursor -= 1;

    for (let i = cursor; i < state.pos; i += 1) state.status[i] = 'pending';
    state.pos = cursor;
    state.status[cursor] = 'pending';
    state.done = false;
    return NO_OP(state);
  }

  if (state.pos >= state.expected.length) return NO_OP(state);

  const expectedChar = state.expected[state.pos];

  if (key === 'Tab') {
    // Tab is only meaningful where indentation is expected.
    if (expectedChar !== ' ') return NO_OP(state);

    let filled = 0;
    while (state.pos < state.expected.length && state.expected[state.pos] === ' ' && filled < 8) {
      state.status[state.pos] = 'correct';
      state.pos += 1;
      filled += 1;
    }
    const completed = finish(state);
    return { state, counted: true, correct: true, correctChars: filled, missedKey: null, completed };
  }

  const typed = key === 'Enter' ? '\n' : key;
  if (typed.length !== 1) return NO_OP(state);

  const matches =
    typed === expectedChar ||
    (options.ignoreCase && typed.toLowerCase() === expectedChar.toLowerCase());

  if (matches) {
    state.status[state.pos] = 'correct';
    state.pos += 1;

    let correctChars = 1;
    if (typed === '\n' && options.autoIndent) correctChars += consumeIndent(state);

    const completed = finish(state);
    return { state, counted: true, correct: true, correctChars, missedKey: null, completed };
  }

  /* ---- A mistake ---- */

  // 'fix' repairs the character so the page stays readable, but the error is
  // still counted and the repaired character earns no credit.
  state.status[state.pos] = options.mistakeMode === 'fix' ? 'correct' : 'wrong';

  if (options.mistakeMode !== 'block') {
    state.pos += 1;
    if (options.autoIndent && expectedChar === '\n') consumeIndent(state);
  }

  const completed = options.mistakeMode === 'block' ? false : finish(state);
  return {
    state,
    counted: true,
    correct: false,
    correctChars: 0,
    missedKey: expectedChar,
    completed,
  };
}

/** Keys the browser must not act on while a session is running. */
export function shouldPreventDefault(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;

  return (
    event.key === 'Tab' ||
    event.key === 'Enter' ||
    event.key === 'Backspace' ||
    event.key === ' ' ||
    event.key === "'" ||
    event.key === '/' ||
    event.key === 'ArrowUp' ||
    event.key === 'ArrowDown'
  );
}

/** True when a key should be routed into the engine at all. */
export function isTypingKey(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  return event.key.length === 1 || event.key === 'Enter' || event.key === 'Tab' || event.key === 'Backspace';
}

/**
 * Advances the cursor to just past the next line break in `expected`,
 * marking everything it jumps over as 'skipped'. Used by the skip-line
 * shortcut inside multi-line code listings. Prose blocks have no internal
 * newlines, so this is a no-op there — the caller falls back to
 * skip-paragraph in that case.
 */
export function skipLine(previous: BlockState, options: EngineOptions): BlockState {
  const nextBreak = previous.expected.indexOf('\n', previous.pos);
  if (nextBreak === -1) return previous;

  const status = [...previous.status];
  for (let i = previous.pos; i <= nextBreak; i += 1) status[i] = 'skipped';

  const state: BlockState = { ...previous, status, pos: nextBreak + 1, done: false };

  // Land on the first real character of the next line, not its indentation.
  if (options.autoIndent) consumeIndent(state);
  return state;
}

/** Clears a block back to its opening position, keeping any leading indent. */
export function restartBlock(previous: BlockState, options: EngineOptions): BlockState {
  return createBlockState(previous.expected, options);
}

/* ------------------------------------------------------------------ *
 * Metrics
 * ------------------------------------------------------------------ */

/** Gaps longer than this are treated as "away from the keyboard". */
export const IDLE_CUTOFF_MS = 5000;

/** Effectively "no cutoff" for the Auto-pause = Never setting. */
const NO_CUTOFF_MS = 24 * 60 * 60 * 1000;

export interface Metrics {
  /** Active typing time, idle gaps excluded. */
  activeMs: number;
  keystrokes: number;
  correctChars: number;
  errors: number;
  blocksCompleted: number;
  proseChars: number;
  proseMs: number;
  codeChars: number;
  codeMs: number;
  errorsByKey: Record<string, number>;
}

export function emptyMetrics(): Metrics {
  return {
    activeMs: 0,
    keystrokes: 0,
    correctChars: 0,
    errors: 0,
    blocksCompleted: 0,
    proseChars: 0,
    proseMs: 0,
    codeChars: 0,
    codeMs: 0,
    errorsByKey: {},
  };
}

/**
 * Folds one keystroke into a metrics accumulator. `gapMs` is the time since the
 * previous keystroke; anything over the idle cutoff is discarded so a coffee
 * break does not destroy your WPM.
 */
export function recordKey(
  metrics: Metrics,
  outcome: KeyOutcome,
  kind: string,
  gapMs: number,
  /** From Settings.autoPauseMs; 0 means "Never", i.e. no cutoff. */
  idleCutoffMs: number = IDLE_CUTOFF_MS
): Metrics {
  if (!outcome.counted) return metrics;

  const cutoff = idleCutoffMs > 0 ? idleCutoffMs : NO_CUTOFF_MS;
  const billable = gapMs > 0 && gapMs < cutoff ? gapMs : 0;
  const isCode = kind === 'code';

  const next: Metrics = {
    ...metrics,
    activeMs: metrics.activeMs + billable,
    keystrokes: metrics.keystrokes + 1,
    correctChars: metrics.correctChars + outcome.correctChars,
    errors: metrics.errors + (outcome.correct ? 0 : 1),
    proseMs: metrics.proseMs + (isCode ? 0 : billable),
    codeMs: metrics.codeMs + (isCode ? billable : 0),
    proseChars: metrics.proseChars + (isCode ? 0 : outcome.correctChars),
    codeChars: metrics.codeChars + (isCode ? outcome.correctChars : 0),
    errorsByKey: metrics.errorsByKey,
  };

  if (outcome.missedKey) {
    next.errorsByKey = {
      ...metrics.errorsByKey,
      [outcome.missedKey]: (metrics.errorsByKey[outcome.missedKey] ?? 0) + 1,
    };
  }

  return next;
}

export function wpm(chars: number, ms: number): number {
  if (ms <= 0) return 0;
  return Math.round(chars / 5 / (ms / 60000));
}

export function accuracy(keystrokes: number, errors: number): number {
  if (keystrokes <= 0) return 100;
  return Math.round(((keystrokes - errors) / keystrokes) * 1000) / 10;
}
