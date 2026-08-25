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
export type BlockKind = 'prose' | 'heading' | 'code' | 'image' | 'embed';

/**
 * A link that appeared inside a block, with where it sat in the text.
 *
 * The offsets are into the block's final text, which is what lets the reader
 * underline the exact words that were linked instead of listing bare URLs with
 * no idea where they came from.
 */
export interface BlockLink {
  text: string;
  url: string;
  start: number;
  end: number;
  /** True when the target is another page in the same documentation set. */
  internal: boolean;
}

/** One link, plus where in the page it is, for the links side panel. */
export interface PageLink extends BlockLink {
  blockIdx: number;
  section: string | null;
}

/**
 * A documentation set imported from the web: one TOC, many pages.
 *
 * Books that came from a file have no collection. Books that came from a URL
 * belong to one, which is what makes next/previous and the jump palette work.
 */
export const collections = sqliteTable('collections', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  /** The page that was originally pasted in. */
  homeUrl: text('home_url').notNull(),
  /** Host, shown on the library card. */
  site: text('site').notNull(),
  /**
   * The root of the doc set, from its own table of contents. This is what makes
   * a collection stable: page titles and sidebar group labels change as you move
   * around a site, but the root of the contents does not.
   */
  rootUrl: text('root_url').notNull().default(''),
  /** JSON array of TocEntry, in reading order. */
  tocJson: text('toc_json').notNull().default('[]'),
  addedAt: integer('added_at').notNull(),
});

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

  /* --- Web pages ------------------------------------------------------ */
  /** Set when this page came from a URL rather than a file. */
  collectionId: integer('collection_id'),
  sourceUrl: text('source_url'),
  /** Raw source actually parsed (e.g. the raw.githubusercontent Markdown). */
  upstreamUrl: text('upstream_url'),
  /** Which adapter produced it: git-markdown | wiki | readable | rendered. */
  adapter: text('adapter'),
  /** Hash of the upstream text, so "check for updates" is a cheap comparison. */
  contentHash: text('content_hash'),
  fetchedAt: integer('fetched_at'),
  /** Position of this page within its collection's TOC. */
  tocIdx: integer('toc_idx'),
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
    /** Links inside the text, as JSON `BlockLink[]`. Null for file-based books. */
    linksJson: text('links_json'),
    /** For embeds: the video or page URL to show. */
    src: text('src'),
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
    /**
     * Characters resolved, correct or fumbled. The denominator for accuracy,
     * so a character retried several times counts once.
     */
    scoredChars: integer('scored_chars').notNull().default(0),
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
/**
 * Somewhere to keep the sites you get books from.
 *
 * A pin, not an import: the URL opens in a new tab. Handy for keeping the same
 * three or four bookstores next to the library without having to remember them.
 */
export const bookSources = sqliteTable('book_sources', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  label: text('label').notNull(),
  url: text('url').notNull(),
  note: text('note'),
  /** Manual ordering: lower first. */
  sortIdx: integer('sort_idx').notNull().default(0),
  addedAt: integer('added_at').notNull(),
});

export type BookSource = typeof bookSources.$inferSelect;

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

  /**
   * Show shortcut hints on button tooltips.
   *
   * Every button that duplicates a shortcut names it on hover. On when it helps
   * you learn the keys, off once they are second nature.
   */
  showShortcutHints: integer('show_shortcut_hints').notNull().default(1),

  /**
   * Skip blocks whose text uses characters not on the chosen keyboard.
   *
   * A transliterated Genesis chapter is full of diacritics — ə, ū, ō, ḥ — that
   * a US layout cannot type; a Wikipedia article about a Nordic town is full of
   * ø and æ. On this setting the reader steps over those blocks automatically
   * and marks them so you can tell why.
   */
  skipUntypeable: integer('skip_untypeable').notNull().default(0),
  /** us | us-intl | any — the layout used to decide what counts as typeable. */
  keyboardLayout: text('keyboard_layout').notNull().default('us'),
});

/** One line of a documentation table of contents. */
export interface TocEntry {
  title: string;
  /** Absolute URL, or null for a grouping row with no page of its own. */
  url: string | null;
  depth: number;
}

export type Collection = typeof collections.$inferSelect;
export type Book = typeof books.$inferSelect;
export type Block = typeof blocks.$inferSelect;
export type Asset = typeof assets.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Settings = typeof settings.$inferSelect;

/**
 * Per-block completion state. `typed` blocks carry their WPM/accuracy snapshot;
 * `skipped` blocks carry only the status flag so the reader can distinguish
 * a jump from an untouched page.
 */
export interface BlockProgress {
  bookId: number;
  blockIdx: number;
  status: 'typed' | 'skipped';
  wpm: number | null;
  accuracyBp: number | null;
  durationMs: number | null;
  keystrokes: number | null;
  errors: number | null;
  updatedAt: number;
}

/** A block joined with its asset, as the typing view consumes it. */
export interface BlockView extends Block {
  /** Links found in this block's text, parsed from `linksJson`. */
  links?: BlockLink[];
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

/** What the typing view needs to offer page navigation. */
/**
 * A documentation set as it appears in the library: one entry, however many
 * pages of it you have read. Progress is summed across those pages so the card
 * reflects the whole set rather than whichever page you opened first.
 */
export interface CollectionSummary {
  id: number;
  title: string;
  site: string;
  homeUrl: string;
  /** Pages of this set held locally. */
  pageCount: number;
  /** Pages its table of contents lists, whether imported or not. */
  tocCount: number;
  blockCount: number;
  positionSum: number;
  wordCount: number;
  codeBlockCount: number;
  imageCount: number;
  addedAt: number;
  lastOpenedAt: number | null;
  /** The page to open when the entry is clicked: where you left off. */
  resumeBookId: number;
  resumeTitle: string;
  /** That page's own URL, for opening the original in a browser. */
  resumeUrl: string | null;
}

export interface PageContext {
  collection: Collection;
  toc: TocEntry[];
  /** Index into `toc` of the page being read, or null if it is not listed. */
  tocIdx: number | null;
  /** Neighbouring TOC entries that have a URL. */
  previous: TocEntry | null;
  next: TocEntry | null;
  /** Which TOC urls are already imported, mapped to their book id. */
  imported: Record<string, number>;
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
