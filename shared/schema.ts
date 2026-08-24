import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

/**
 * Typewright data model.
 *
 * Everything lives in a single local SQLite file (data/typewright.db by
 * default, overridable with TYPEWRIGHT_DB). Extracted images are written next
 * to it under data/assets/<bookId>/. Nothing leaves the machine.
 *
 * A book is an ordered list of BLOCKS rather than a flat stream of text, so a
 * technical book keeps its shape: prose reads as prose, code is typed
 * verbatim, and figures are shown, not typed.
 */

/** Block kinds. Only `prose`, `heading`, and `code` are typeable. */
export type BlockKind = 'prose' | 'heading' | 'code' | 'image';

export const books = sqliteTable('books', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  author: text('author').notNull().default('Unknown'),
  /** Original file name, kept for provenance. */
  sourceName: text('source_name').notNull(),
  /** txt | md | epub | pdf | html | zip */
  format: text('format').notNull(),
  charCount: integer('char_count').notNull(),
  wordCount: integer('word_count').notNull(),
  /** Total blocks, including images. */
  blockCount: integer('block_count').notNull(),
  /** Typeable blocks only — the denominator for progress. */
  typeableCount: integer('typeable_count').notNull(),
  codeBlockCount: integer('code_block_count').notNull().default(0),
  imageCount: integer('image_count').notNull().default(0),
  /** Index of the block the typist is currently on. */
  positionIdx: integer('position_idx').notNull().default(0),
  /** Cover image asset id, when the source had one. */
  coverAssetId: integer('cover_asset_id'),
  addedAt: integer('added_at').notNull(),
  lastOpenedAt: integer('last_opened_at'),
});

export const blocks = sqliteTable(
  'blocks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    bookId: integer('book_id').notNull(),
    idx: integer('idx').notNull(),
    kind: text('kind').notNull(),
    /**
     * For prose/heading: the normalised sentence run to type.
     * For code: the verbatim source, newlines and indentation intact.
     * For image: the caption or alt text (may be empty).
     */
    text: text('text').notNull(),
    /** Chapter / section label carried from the source. */
    section: text('section'),
    /** Caption shown above the block, e.g. "Listing 10.1 PersistentRemoveEmail". */
    label: text('label'),
    /** Detected language for code blocks (best effort, may be null). */
    lang: text('lang'),
    /** Image blocks point at a row in `assets`. */
    assetId: integer('asset_id'),
    /** Annotation legend for a listing, or a figure credit. Displayed, not typed. */
    note: text('note'),
  },
  (t) => ({
    bookIdx: index('blocks_book_idx').on(t.bookId, t.idx),
  })
);

export const assets = sqliteTable(
  'assets',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    bookId: integer('book_id').notNull(),
    /** Path on disk relative to the assets root: <bookId>/<name>. */
    relPath: text('rel_path').notNull(),
    mime: text('mime').notNull(),
    width: integer('width'),
    height: integer('height'),
    bytes: integer('bytes').notNull(),
  },
  (t) => ({
    bookIdx: index('assets_book_idx').on(t.bookId),
  })
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    bookId: integer('book_id').notNull(),
    endedAt: integer('ended_at').notNull(),
    /** Active typing time in ms — idle gaps over 5s are excluded. */
    durationMs: integer('duration_ms').notNull(),
    keystrokes: integer('keystrokes').notNull(),
    correctChars: integer('correct_chars').notNull(),
    errors: integer('errors').notNull(),
    blocksCompleted: integer('blocks_completed').notNull(),
    /** Split so prose and code speeds can be reported separately. */
    proseChars: integer('prose_chars').notNull().default(0),
    proseMs: integer('prose_ms').notNull().default(0),
    codeChars: integer('code_chars').notNull().default(0),
    codeMs: integer('code_ms').notNull().default(0),
    wpm: integer('wpm').notNull(),
    /** 0-10000 basis points, stored as an integer. */
    accuracyBp: integer('accuracy_bp').notNull(),
    /** JSON: { "a": 3, "{": 7, ... } expected-character miss counts. */
    errorsByKey: text('errors_by_key').notNull().default('{}'),
  },
  (t) => ({
    bookIdx: index('sessions_book_idx').on(t.bookId),
  })
);

/** Single-row table (id = 1). */
export const settings = sqliteTable('settings', {
  id: integer('id').primaryKey(),
  theme: text('theme').notNull().default('system'),
  /** Target characters per prose typing block at import time. */
  chunkSize: integer('chunk_size').notNull().default(240),
  /** Must the typist fix mistakes before moving on? */
  strictMode: integer('strict_mode').notNull().default(1),
  /** Smart quotes / dashes normalised to ASCII in PROSE only. Never in code. */
  normalizePunctuation: integer('normalize_punctuation').notNull().default(1),
  /** Skip past code blocks instead of typing them. */
  skipCode: integer('skip_code').notNull().default(0),
  /** After Enter in a code block, jump over the next line's indentation. */
  autoIndent: integer('auto_indent').notNull().default(1),
  soundOnError: integer('sound_on_error').notNull().default(0),
  fontSize: integer('font_size').notNull().default(20),
  /** serif | sans — applies to prose. Code is always monospace. */
  typeface: text('typeface').notNull().default('serif'),

  /* --- Typing mode --------------------------------------------------- */
  /**
   * How a mistake is handled:
   *   block — the cursor holds until you type the right character
   *   mark  — the mistake is marked and the cursor moves on
   *   fix   — the mistake is counted, then corrected for you so you keep flowing
   */
  mistakeMode: text('mistake_mode').notNull().default('block'),
  /** auto — move on when a block is finished; confirm — wait for Enter. */
  advanceMode: text('advance_mode').notNull().default('auto'),
  /** Accept the wrong case in prose. Listings always compare exactly. */
  ignoreCaseProse: integer('ignore_case_prose').notNull().default(0),
  /** Show the ⏎ marker at the end of each line inside a listing. */
  showNewlines: integer('show_newlines').notNull().default(1),
  /** line | block | underline — shape of the active-position caret. */
  caretStyle: text('caret_style').notNull().default('line'),
  /** Blink the caret, or hold it steady. */
  caretBlink: integer('caret_blink').notNull().default(1),
  /** Holds the active line at a fixed spot on screen instead of free scroll. */
  keepInPosition: integer('keep_in_position').notNull().default(0),
  /** Underline the whole word on a mistake, not just the missed character. */
  markIncorrectWords: integer('mark_incorrect_words').notNull().default(0),
  /** never | 2000 | 5000 | 10000 — ms of idle time before the session auto-pauses. */
  autoPauseMs: integer('auto_pause_ms').notNull().default(5000),

  /* --- Reading mode ---------------------------------------------------
   * A distinct read-only prompt (own type size/line height), separate from
   * the typing prompt above, entered with the reading-mode shortcut. */
  readingFontSize: integer('reading_font_size').notNull().default(18),
  readingLineHeight: text('reading_line_height').notNull().default('m'),
});

export type Book = typeof books.$inferSelect;
export type Block = typeof blocks.$inferSelect;
export type Asset = typeof assets.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Settings = typeof settings.$inferSelect;

/** A block joined with its asset, as the typing view consumes it. */
export interface BlockView extends Block {
  asset: Asset | null;
}

/** Shape returned by GET /api/stats. */
export interface StatsSummary {
  totals: {
    sessions: number;
    /** Total active typing time, so the UI can pick a sensible unit. */
    activeMs: number;
    minutes: number;
    words: number;
    keystrokes: number;
    errors: number;
    accuracyBp: number;
    bestWpm: number;
    avgWpm: number;
    proseWpm: number;
    codeWpm: number;
  };
  daily: { day: string; wpm: number; accuracyBp: number; minutes: number }[];
  recent: (Session & { bookTitle: string })[];
  worstKeys: { key: string; count: number }[];
  streak: number;
}

/** Result of an import attempt, per file. */
export interface ImportResult {
  imported: {
    id: number;
    title: string;
    typeableCount: number;
    codeBlockCount: number;
    imageCount: number;
    notes: string[];
  }[];
  failed: { name: string; reason: string }[];
}
