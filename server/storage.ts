import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { assets, blocks, bookSources, books, collections, sessions, settings } from '@shared/schema';
import type {
  Asset,
  Block,
  BlockLink,
  BlockProgress,
  BlockView,
  Book,
  BookSource,
  Collection,
  CollectionSummary,
  PageLink,
  TocEntry,
  Session,
  Settings,
  StatsSummary,
} from '@shared/schema';

/* ------------------------------------------------------------------ *
 * Paths — everything stays on this machine
 * ------------------------------------------------------------------ */

export const DATA_DIR = process.env.TYPEWRIGHT_DATA || path.resolve(process.cwd(), 'data');
export const ASSETS_DIR = path.join(DATA_DIR, 'assets');
const DB_PATH = process.env.TYPEWRIGHT_DB || path.join(DATA_DIR, 'typewright.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(ASSETS_DIR, { recursive: true });

const sqlite = new Database(DB_PATH);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite);

/** Idempotent schema creation, so a fresh volume self-heals on boot. */
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS book_sources (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    label    TEXT    NOT NULL,
    url      TEXT    NOT NULL,
    note     TEXT,
    sort_idx INTEGER NOT NULL DEFAULT 0,
    added_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS collections (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    title    TEXT    NOT NULL,
    home_url TEXT    NOT NULL,
    site     TEXT    NOT NULL,
    root_url TEXT    NOT NULL DEFAULT '',
    toc_json TEXT    NOT NULL DEFAULT '[]',
    added_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS books (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    title            TEXT    NOT NULL,
    author           TEXT    NOT NULL DEFAULT 'Unknown',
    source_name      TEXT    NOT NULL,
    format           TEXT    NOT NULL,
    char_count       INTEGER NOT NULL,
    word_count       INTEGER NOT NULL,
    block_count      INTEGER NOT NULL,
    typeable_count   INTEGER NOT NULL,
    code_block_count INTEGER NOT NULL DEFAULT 0,
    image_count      INTEGER NOT NULL DEFAULT 0,
    position_idx     INTEGER NOT NULL DEFAULT 0,
    cover_asset_id   INTEGER,
    added_at         INTEGER NOT NULL,
    last_opened_at   INTEGER
  );

  CREATE TABLE IF NOT EXISTS assets (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id  INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    rel_path TEXT    NOT NULL,
    mime     TEXT    NOT NULL,
    width    INTEGER,
    height   INTEGER,
    bytes    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS assets_book_idx ON assets (book_id);

  CREATE TABLE IF NOT EXISTS blocks (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id  INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    idx      INTEGER NOT NULL,
    kind     TEXT    NOT NULL,
    text     TEXT    NOT NULL,
    section  TEXT,
    label    TEXT,
    lang     TEXT,
    asset_id INTEGER REFERENCES assets(id) ON DELETE SET NULL,
    note     TEXT,
    -- Links found in the block text, as JSON. Empty for file-based books.
    links_json TEXT,
    -- For embeds: the page or player URL the block points at.
    src TEXT
  );
  CREATE INDEX IF NOT EXISTS blocks_book_idx ON blocks (book_id, idx);

  CREATE TABLE IF NOT EXISTS sessions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id          INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    ended_at         INTEGER NOT NULL,
    duration_ms      INTEGER NOT NULL,
    keystrokes       INTEGER NOT NULL,
    correct_chars    INTEGER NOT NULL,
    scored_chars     INTEGER NOT NULL DEFAULT 0,
    errors           INTEGER NOT NULL,
    blocks_completed INTEGER NOT NULL,
    prose_chars      INTEGER NOT NULL DEFAULT 0,
    prose_ms         INTEGER NOT NULL DEFAULT 0,
    code_chars       INTEGER NOT NULL DEFAULT 0,
    code_ms          INTEGER NOT NULL DEFAULT 0,
    wpm              INTEGER NOT NULL,
    accuracy_bp      INTEGER NOT NULL,
    errors_by_key    TEXT    NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS sessions_book_idx ON sessions (book_id);

  /*
   * Per-block completion record. Written on the first successful completion of
   * a block and updated to the best-yet WPM/accuracy on later completions. The
   * status flag lets a jumped-past block be tracked without a summary.
   */
  CREATE TABLE IF NOT EXISTS block_progress (
    book_id     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    block_idx   INTEGER NOT NULL,
    status      TEXT    NOT NULL,
    wpm         INTEGER,
    accuracy_bp INTEGER,
    duration_ms INTEGER,
    keystrokes  INTEGER,
    errors      INTEGER,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (book_id, block_idx)
  );

  CREATE TABLE IF NOT EXISTS settings (
    id                    INTEGER PRIMARY KEY,
    theme                 TEXT    NOT NULL DEFAULT 'system',
    chunk_size            INTEGER NOT NULL DEFAULT 240,
    strict_mode           INTEGER NOT NULL DEFAULT 1,
    normalize_punctuation INTEGER NOT NULL DEFAULT 1,
    skip_code             INTEGER NOT NULL DEFAULT 0,
    auto_indent           INTEGER NOT NULL DEFAULT 1,
    sound_on_error        INTEGER NOT NULL DEFAULT 0,
    font_size             INTEGER NOT NULL DEFAULT 20,
    typeface              TEXT    NOT NULL DEFAULT 'serif'
  );
  INSERT OR IGNORE INTO settings (id) VALUES (1);
`);

/**
 * New settings columns land here as `ADD COLUMN IF NOT EXISTS`-style guards,
 * so an existing data/typewright.db from before this change picks them up
 * without a destructive rebuild. SQLite has no `ADD COLUMN IF NOT EXISTS`,
 * so each is guarded by checking pragma table_info first.
 */
function ensureColumn(table: string, column: string, ddl: string) {
  const existing = sqlite
    .prepare(`PRAGMA table_info(${table})`)
    .all() as { name: string }[];
  if (!existing.some((c) => c.name === column)) {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

ensureColumn('books', 'collection_id', 'collection_id INTEGER');
ensureColumn('books', 'source_url', 'source_url TEXT');
ensureColumn('books', 'upstream_url', 'upstream_url TEXT');
ensureColumn('books', 'adapter', 'adapter TEXT');
ensureColumn('books', 'content_hash', 'content_hash TEXT');
ensureColumn('books', 'fetched_at', 'fetched_at INTEGER');
ensureColumn('books', 'toc_idx', 'toc_idx INTEGER');
ensureColumn('collections', 'root_url', "root_url TEXT NOT NULL DEFAULT ''");
ensureColumn('blocks', 'links_json', 'links_json TEXT');
ensureColumn('blocks', 'src', 'src TEXT');
sqlite.exec('CREATE INDEX IF NOT EXISTS books_collection_idx ON books (collection_id)');
sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS books_source_url_idx ON books (source_url) WHERE source_url IS NOT NULL');

ensureColumn('settings', 'mistake_mode', "mistake_mode TEXT NOT NULL DEFAULT 'block'");
ensureColumn('settings', 'advance_mode', "advance_mode TEXT NOT NULL DEFAULT 'auto'");
ensureColumn('settings', 'ignore_case_prose', 'ignore_case_prose INTEGER NOT NULL DEFAULT 0');
ensureColumn('settings', 'show_newlines', 'show_newlines INTEGER NOT NULL DEFAULT 1');
ensureColumn('settings', 'caret_style', "caret_style TEXT NOT NULL DEFAULT 'line'");
ensureColumn('settings', 'caret_blink', 'caret_blink INTEGER NOT NULL DEFAULT 1');

// The old boolean is the seed for the three-way replacement, once.
sqlite.exec(`
  UPDATE settings
  SET mistake_mode = CASE WHEN strict_mode = 1 THEN 'block' ELSE 'mark' END
  WHERE mistake_mode IS NULL OR mistake_mode = '';
`);
ensureColumn('settings', 'keep_in_position', 'keep_in_position INTEGER NOT NULL DEFAULT 0');
ensureColumn(
  'settings',
  'mark_incorrect_words',
  'mark_incorrect_words INTEGER NOT NULL DEFAULT 0'
);
ensureColumn('settings', 'auto_pause_ms', 'auto_pause_ms INTEGER NOT NULL DEFAULT 5000');
ensureColumn('settings', 'reading_font_size', 'reading_font_size INTEGER NOT NULL DEFAULT 18');
ensureColumn('settings', 'show_shortcut_hints', 'show_shortcut_hints INTEGER NOT NULL DEFAULT 1');
ensureColumn('settings', 'skip_untypeable', 'skip_untypeable INTEGER NOT NULL DEFAULT 0');
ensureColumn('settings', 'keyboard_layout', "keyboard_layout TEXT NOT NULL DEFAULT 'us'");
ensureColumn('sessions', 'scored_chars', 'scored_chars INTEGER NOT NULL DEFAULT 0');

seedBookSources();

ensureColumn(
  'settings',
  'reading_line_height',
  "reading_line_height TEXT NOT NULL DEFAULT 'm'"
);

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export interface NewAsset {
  key: string;
  data: Buffer;
  mime: string;
  width?: number;
  height?: number;
}

export interface NewBlock {
  kind: string;
  text: string;
  section: string | null;
  label?: string | null;
  lang?: string | null;
  note?: string | null;
  /** Matches a NewAsset.key. */
  imageKey?: string;
  /** Links found inside `text`, with offsets into it. */
  links?: BlockLink[];
  /** For embeds: the video or page URL to show. */
  src?: string;
}

export interface NewBook {
  title: string;
  author: string;
  sourceName: string;
  format: string;
  blocks: NewBlock[];
  assets: NewAsset[];
  coverKey?: string;
  /** Present only for pages imported from a URL. */
  web?: {
    collectionId: number;
    sourceUrl: string;
    upstreamUrl: string | null;
    adapter: string;
    contentHash: string;
    tocIdx: number | null;
  };
}

export interface IStorage {
  listBooks(): Book[];
  listCollections(): Collection[];
  getCollection(id: number): Collection | undefined;
  /** Finds an existing collection for a site+TOC, or creates one. */
  upsertCollection(input: {
    title: string;
    homeUrl: string;
    site: string;
    rootUrl: string;
    toc: TocEntry[];
  }): Collection;
  updateCollectionToc(id: number, toc: TocEntry[]): void;
  getBookByUrl(url: string): Book | undefined;
  listCollectionBooks(collectionId: number): Book[];
  /** Replaces a page's blocks in place, keeping its id and collection links. */
  replaceBookContent(id: number, input: NewBook): Book | undefined;
  getBook(id: number): Book | undefined;
  createBook(input: NewBook): Book;
  deleteBook(id: number): void;
  updateBook(id: number, patch: { title?: string; author?: string }): Book | undefined;
  setPosition(id: number, idx: number): Book | undefined;
  getBlocks(bookId: number, from: number, count: number): BlockView[];
  getPageLinks(bookId: number): PageLink[];
  listBookSources(): BookSource[];
  createBookSource(input: Pick<BookSource, 'label' | 'url'> & { note?: string | null }): BookSource;
  deleteBookSource(id: number): void;
  listCollectionSummaries(): CollectionSummary[];
  /** Chapter/section outline for the jump-to menu. */
  getOutline(bookId: number): { idx: number; section: string; kind: string }[];
  getAsset(id: number): Asset | undefined;
  createSession(input: Omit<Session, 'id'>): Session;
  /** Every completion or explicit skip the reader has recorded for a book. */
  listBlockProgress(bookId: number): BlockProgress[];
  /** Persist that a block was typed through or deliberately jumped past. */
  upsertBlockProgress(entry: BlockProgress): void;
  getSettings(): Settings;
  updateSettings(patch: Partial<Settings>): Settings;
  getStats(): StatsSummary;
}

/* ------------------------------------------------------------------ *
 * Implementation
 * ------------------------------------------------------------------ */

const TYPEABLE = new Set(['prose', 'heading', 'code']);

function parseLinks(json: string | null): BlockLink[] | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as BlockLink[];
    return Array.isArray(parsed) && parsed.length ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function countBlocks(list: NewBlock[]) {
  const typeable = list.filter((b) => TYPEABLE.has(b.kind));
  return {
    charCount: typeable.reduce((sum, b) => sum + b.text.length, 0),
    wordCount: typeable.reduce((sum, b) => sum + b.text.split(/\s+/).filter(Boolean).length, 0),
    blockCount: list.length,
    typeableCount: typeable.length,
    codeBlockCount: list.filter((b) => b.kind === 'code').length,
    // "Media" on the card: figures and embedded players alike.
    imageCount: list.filter((b) => b.kind === 'image' || b.kind === 'embed').length,
  };
}

/**
 * On first run, drop in a few free and paid stores worth pinning.
 *
 * The seed only fires when the table is empty, so removing an entry does not
 * bring it back on the next start. New entries added by hand stay put.
 */
function seedBookSources(): void {
  const count = (sqlite.prepare('SELECT COUNT(*) AS n FROM book_sources').get() as { n: number }).n;
  if (count > 0) return;

  const now = Date.now();
  const insert = sqlite.prepare(
    'INSERT INTO book_sources (label, url, note, sort_idx, added_at) VALUES (?, ?, ?, ?, ?)'
  );
  const seed: [string, string, string, number][] = [
    ['Project Gutenberg', 'https://www.gutenberg.org/', 'Free public-domain books — EPUB and plain text', 0],
    ['Standard Ebooks', 'https://standardebooks.org/', 'Carefully produced public-domain EPUBs', 1],
    ['eBooks.com — DRM-free', 'https://www.ebooks.com/drm-free/', 'Nearly 300k DRM-free titles across major publishers', 2],
    ['Smashwords', 'https://www.smashwords.com/', 'Indie authors, many free, all DRM-free', 3],
    ['Leanpub', 'https://leanpub.com/bookstore?type=book', 'In-progress and completed books, DRM-free', 4],
    ['Humble Bundle — Books', 'https://www.humblebundle.com/books', 'Cheap bundles; look for the DRM-Free badge', 5],
    ['StoryBundle', 'https://storybundle.com/', 'Curated indie bundles, all DRM-free', 6],
    ['Manning', 'https://www.manning.com/', 'Software titles — MEAP EPUBs keep code listings intact', 7],
    ['Open Library', 'https://openlibrary.org/', 'Internet Archive search for public-domain scans', 8],
    ['Unglue.it', 'https://unglue.it/', 'Crowdfunded DRM-free books, some under free culture licences', 9],
    ['DigiLibraries', 'https://digilibraries.com/', 'Free books across many genres, DRM-free', 10],
    ['Guide to DRM-Free Living', 'https://www.defectivebydesign.org/guide/ebooks', 'More sources of DRM-free ebooks', 11],
    ['Entertrained — sources list', 'https://entertrained.app/upload', 'Their own roundup of DRM-free ebook stores', 12],
    ['OpenStax', 'https://openstax.org/subjects', 'Free peer-reviewed textbooks in EPUB and PDF', 13],
    ['Internet Sacred Text Archive', 'https://sacred-texts.com/', 'Public-domain religious and mythological texts', 14],
  ];
  const write = sqlite.transaction((rows: typeof seed) => {
    for (const [label, url, note, sortIdx] of rows) insert.run(label, url, note, sortIdx, now);
  });
  write(seed);
}

class SqliteStorage implements IStorage {
  listCollections(): Collection[] {
    return db.select().from(collections).orderBy(desc(collections.addedAt)).all();
  }

  getCollection(id: number): Collection | undefined {
    return db.select().from(collections).where(eq(collections.id, id)).get();
  }

  upsertCollection(input: {
    title: string;
    homeUrl: string;
    site: string;
    rootUrl: string;
    toc: TocEntry[];
  }): Collection {
    /*
     * A doc set is identified by its host plus the root of its contents, never
     * by the title of the page that happened to be imported first. Titles and
     * sidebar group labels shift as you move around a site, which is what used
     * to split one doc set across several library entries.
     */
    const existing = db
      .select()
      .from(collections)
      .where(and(eq(collections.site, input.site), eq(collections.rootUrl, input.rootUrl)))
      .get();

    if (existing) {
      // A later page often carries a fuller TOC than the first one did.
      if (input.toc.length > (JSON.parse(existing.tocJson) as TocEntry[]).length) {
        this.updateCollectionToc(existing.id, input.toc);
        return { ...existing, tocJson: JSON.stringify(input.toc) };
      }
      return existing;
    }

    return db
      .insert(collections)
      .values({
        title: input.title,
        homeUrl: input.homeUrl,
        site: input.site,
        rootUrl: input.rootUrl,
        tocJson: JSON.stringify(input.toc),
        addedAt: Date.now(),
      })
      .returning()
      .get();
  }

  updateCollectionToc(id: number, toc: TocEntry[]): void {
    db.update(collections).set({ tocJson: JSON.stringify(toc) }).where(eq(collections.id, id)).run();
  }

  getBookByUrl(url: string): Book | undefined {
    return db.select().from(books).where(eq(books.sourceUrl, url)).get();
  }

  listCollectionBooks(collectionId: number): Book[] {
    return db.select().from(books).where(eq(books.collectionId, collectionId)).all();
  }

  /**
   * Re-import in place: the page keeps its id, its collection, and its place in
   * the TOC, but every block and asset is rebuilt. Progress resets, because the
   * old position no longer means anything.
   */
  replaceBookContent(id: number, input: NewBook): Book | undefined {
    const existing = this.getBook(id);
    if (!existing) return undefined;

    sqlite.transaction(() => {
      db.delete(blocks).where(eq(blocks.bookId, id)).run();
      db.delete(assets).where(eq(assets.bookId, id)).run();
    })();
    fs.rmSync(path.join(ASSETS_DIR, String(id)), { recursive: true, force: true });

    this.writeContent(id, input);

    return db
      .update(books)
      .set({
        title: input.title,
        positionIdx: 0,
        contentHash: input.web?.contentHash ?? existing.contentHash,
        fetchedAt: Date.now(),
      })
      .where(eq(books.id, id))
      .returning()
      .get();
  }

  listBooks(): Book[] {
    return db
      .select()
      .from(books)
      .orderBy(desc(sql`COALESCE(${books.lastOpenedAt}, ${books.addedAt})`))
      .all();
  }

  getBook(id: number): Book | undefined {
    return db.select().from(books).where(eq(books.id, id)).get();
  }

  createBook(input: NewBook): Book {
    const counts = countBlocks(input.blocks);

    const insert = sqlite.transaction(() => {
      const book = db
        .insert(books)
        .values({
          title: input.title,
          author: input.author,
          sourceName: input.sourceName,
          format: input.format,
          ...counts,
          addedAt: Date.now(),
          collectionId: input.web?.collectionId ?? null,
          sourceUrl: input.web?.sourceUrl ?? null,
          upstreamUrl: input.web?.upstreamUrl ?? null,
          adapter: input.web?.adapter ?? null,
          contentHash: input.web?.contentHash ?? null,
          fetchedAt: input.web ? Date.now() : null,
          tocIdx: input.web?.tocIdx ?? null,
        })
        .returning()
        .get();

      const coverAssetId = this.writeContent(book.id, input);
      return coverAssetId ? { ...book, coverAssetId } : book;
    });

    return insert();
  }

  /**
   * Writes a page's assets and blocks. Shared by first import and re-import, so
   * the two can never drift apart. Returns the cover asset id, if any.
   */
  private writeContent(bookId: number, input: NewBook): number | null {
    // Images land on disk under data/assets/<bookId>/ with flattened names.
    fs.mkdirSync(path.join(ASSETS_DIR, String(bookId)), { recursive: true });

    const assetIdByKey = new Map<string, number>();
    const assetStmt = sqlite.prepare(
      'INSERT INTO assets (book_id, rel_path, mime, width, height, bytes) VALUES (?, ?, ?, ?, ?, ?)'
    );

    for (const asset of input.assets) {
      const safeName = asset.key.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-120);
      const relPath = path.posix.join(String(bookId), safeName);
      fs.writeFileSync(path.join(ASSETS_DIR, relPath), asset.data);
      const result = assetStmt.run(
        bookId,
        relPath,
        asset.mime,
        asset.width ?? null,
        asset.height ?? null,
        asset.data.length
      );
      assetIdByKey.set(asset.key, Number(result.lastInsertRowid));
    }

    const blockStmt = sqlite.prepare(
      `INSERT INTO blocks (book_id, idx, kind, text, section, label, lang, asset_id, note, links_json, src)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    input.blocks.forEach((b, i) => {
      blockStmt.run(
        bookId,
        i,
        b.kind,
        b.text,
        b.section ?? null,
        b.label ?? null,
        b.lang ?? null,
        b.imageKey ? assetIdByKey.get(b.imageKey) ?? null : null,
        b.note ?? null,
        b.links?.length ? JSON.stringify(b.links) : null,
        b.src ?? null
      );
    });

    const counts = countBlocks(input.blocks);
    const coverAssetId = input.coverKey ? assetIdByKey.get(input.coverKey) ?? null : null;

    db.update(books)
      .set({ ...counts, coverAssetId })
      .where(eq(books.id, bookId))
      .run();

    return coverAssetId;
  }

  deleteBook(id: number): void {
    const collectionId = this.getBook(id)?.collectionId ?? null;

    sqlite.transaction(() => {
      db.delete(blocks).where(eq(blocks.bookId, id)).run();
      db.delete(sessions).where(eq(sessions.bookId, id)).run();
      db.delete(assets).where(eq(assets.bookId, id)).run();
      db.delete(books).where(eq(books.id, id)).run();
    })();

    fs.rmSync(path.join(ASSETS_DIR, String(id)), { recursive: true, force: true });

    // Drop the collection once its last page is gone.
    if (collectionId) {
      const remaining = db
        .select()
        .from(books)
        .where(eq(books.collectionId, collectionId))
        .all();
      if (!remaining.length) {
        db.delete(collections).where(eq(collections.id, collectionId)).run();
      }
    }
  }

  updateBook(id: number, patch: { title?: string; author?: string }): Book | undefined {
    if (!patch.title && !patch.author) return this.getBook(id);
    return db.update(books).set(patch).where(eq(books.id, id)).returning().get();
  }

  setPosition(id: number, idx: number): Book | undefined {
    return db
      .update(books)
      .set({ positionIdx: idx, lastOpenedAt: Date.now() })
      .where(eq(books.id, id))
      .returning()
      .get();
  }

  getBlocks(bookId: number, from: number, count: number): BlockView[] {
    const rows = db
      .select({ block: blocks, asset: assets })
      .from(blocks)
      .leftJoin(assets, eq(blocks.assetId, assets.id))
      .where(and(eq(blocks.bookId, bookId), gte(blocks.idx, from)))
      .orderBy(blocks.idx)
      .limit(count)
      .all();

    return rows.map((row) => ({
      ...(row.block as Block),
      asset: row.asset ?? null,
      links: parseLinks(row.block.linksJson),
    }));
  }

  /**
   * The library view of every doc set: one row per collection, with its pages'
   * progress and counts rolled up, and the page to resume on.
   */
  listCollectionSummaries(): CollectionSummary[] {
    const out: CollectionSummary[] = [];

    for (const collection of this.listCollections()) {
      const pages = this.listCollectionBooks(collection.id);
      if (!pages.length) continue;

      // Resume on the page last opened, or failing that the one added last —
      // either way, the page you were on rather than the one pasted first.
      const resume =
        [...pages].sort(
          (a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0) || b.addedAt - a.addedAt
        )[0] ?? pages[0];

      out.push({
        id: collection.id,
        title: collection.title,
        site: collection.site,
        homeUrl: collection.homeUrl,
        pageCount: pages.length,
        tocCount: (JSON.parse(collection.tocJson) as TocEntry[]).filter((e) => e.url).length,
        blockCount: pages.reduce((sum, p) => sum + p.blockCount, 0),
        positionSum: pages.reduce((sum, p) => sum + p.positionIdx, 0),
        wordCount: pages.reduce((sum, p) => sum + p.wordCount, 0),
        codeBlockCount: pages.reduce((sum, p) => sum + p.codeBlockCount, 0),
        imageCount: pages.reduce((sum, p) => sum + p.imageCount, 0),
        addedAt: collection.addedAt,
        lastOpenedAt: pages.reduce<number | null>(
          (latest, p) => (p.lastOpenedAt && (!latest || p.lastOpenedAt > latest) ? p.lastOpenedAt : latest),
          null
        ),
        resumeBookId: resume.id,
        resumeTitle: resume.title,
        resumeUrl: resume.sourceUrl,
      });
    }

    return out.sort((a, b) => (b.lastOpenedAt ?? b.addedAt) - (a.lastOpenedAt ?? a.addedAt));
  }

  /** Every link on a page, in reading order, for the links panel. */
  getPageLinks(bookId: number): PageLink[] {
    const rows = sqlite
      .prepare(
        `SELECT idx, section, links_json
         FROM blocks
         WHERE book_id = ? AND links_json IS NOT NULL
         ORDER BY idx`
      )
      .all(bookId) as { idx: number; section: string | null; links_json: string }[];

    const out: PageLink[] = [];
    const seen = new Set<string>();

    for (const row of rows) {
      for (const link of parseLinks(row.links_json) ?? []) {
        // The same destination is often linked several times on a page.
        const key = `${link.url}|${link.text.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ ...link, blockIdx: row.idx, section: row.section });
      }
    }

    return out;
  }

  /**
   * Only top-level headings belong in the jump menu. The importer sets a block's
   * `section` from the nearest h1-h3, so a heading whose text equals its own
   * section is a chapter or section title; "Note", "Important", and other h4-h6
   * asides carry their parent's section instead and are filtered out.
   */
  getOutline(bookId: number): { idx: number; section: string; kind: string }[] {
    return sqlite
      .prepare(
        `SELECT idx, text AS section, kind
         FROM blocks
         WHERE book_id = ? AND kind = 'heading' AND text = section
         ORDER BY idx`
      )
      .all(bookId) as { idx: number; section: string; kind: string }[];
  }

  getAsset(id: number): Asset | undefined {
    return db.select().from(assets).where(eq(assets.id, id)).get();
  }

  createSession(input: Omit<Session, 'id'>): Session {
    return db.insert(sessions).values(input).returning().get();
  }

  listBlockProgress(bookId: number): BlockProgress[] {
    const rows = sqlite
      .prepare(
        'SELECT block_idx AS blockIdx, status, wpm, accuracy_bp AS accuracyBp, duration_ms AS durationMs, keystrokes, errors, updated_at AS updatedAt FROM block_progress WHERE book_id = ?'
      )
      .all(bookId) as Array<Omit<BlockProgress, 'bookId'>>;
    return rows.map((row) => ({ ...row, bookId }));
  }

  upsertBlockProgress(entry: BlockProgress): void {
    /*
     * Keep the best result. A later, slower attempt at a block should not
     * overwrite a faster one; but a first successful completion always wins
     * over a prior skip, and vice versa if the reader skips a typed block.
     */
    sqlite
      .prepare(
        `INSERT INTO block_progress
           (book_id, block_idx, status, wpm, accuracy_bp, duration_ms, keystrokes, errors, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(book_id, block_idx) DO UPDATE SET
           status      = excluded.status,
           wpm         = COALESCE(MAX(block_progress.wpm, excluded.wpm), excluded.wpm),
           accuracy_bp = COALESCE(MAX(block_progress.accuracy_bp, excluded.accuracy_bp), excluded.accuracy_bp),
           duration_ms = COALESCE(excluded.duration_ms, block_progress.duration_ms),
           keystrokes  = COALESCE(excluded.keystrokes, block_progress.keystrokes),
           errors      = COALESCE(excluded.errors, block_progress.errors),
           updated_at  = excluded.updated_at`
      )
      .run(
        entry.bookId,
        entry.blockIdx,
        entry.status,
        entry.wpm,
        entry.accuracyBp,
        entry.durationMs,
        entry.keystrokes,
        entry.errors,
        entry.updatedAt
      );
  }

  getSettings(): Settings {
    return db.select().from(settings).where(eq(settings.id, 1)).get()!;
  }

  listBookSources(): BookSource[] {
    return db.select().from(bookSources).orderBy(bookSources.sortIdx, bookSources.addedAt).all();
  }

  createBookSource(input: {
    label: string;
    url: string;
    note?: string | null;
  }): BookSource {
    const maxSort =
      (sqlite.prepare('SELECT COALESCE(MAX(sort_idx), -1) AS m FROM book_sources').get() as { m: number }).m;
    return db
      .insert(bookSources)
      .values({
        label: input.label,
        url: input.url,
        note: input.note ?? null,
        sortIdx: maxSort + 1,
        addedAt: Date.now(),
      })
      .returning()
      .get();
  }

  deleteBookSource(id: number): void {
    db.delete(bookSources).where(eq(bookSources.id, id)).run();
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const { id: _ignored, ...rest } = patch;
    if (Object.keys(rest).length) {
      db.update(settings).set(rest).where(eq(settings.id, 1)).run();
    }
    return this.getSettings();
  }

  getStats(): StatsSummary {
    const totals = sqlite
      .prepare(
        `SELECT COUNT(*)                        AS sessions,
                COALESCE(SUM(duration_ms), 0)   AS ms,
                COALESCE(SUM(correct_chars), 0) AS correct,
                COALESCE(SUM(keystrokes), 0)    AS keystrokes,
                COALESCE(SUM(scored_chars), 0)  AS scored,
                COALESCE(SUM(errors), 0)        AS errors,
                COALESCE(MAX(wpm), 0)           AS bestWpm,
                COALESCE(SUM(prose_chars), 0)   AS proseChars,
                COALESCE(SUM(prose_ms), 0)      AS proseMs,
                COALESCE(SUM(code_chars), 0)    AS codeChars,
                COALESCE(SUM(code_ms), 0)       AS codeMs
         FROM sessions`
      )
      .get() as Record<string, number>;

    const wpmOf = (chars: number, ms: number) => (ms > 0 ? Math.round(chars / 5 / (ms / 60000)) : 0);

    const daily = (
      sqlite
        .prepare(
          `SELECT date(ended_at / 1000, 'unixepoch', 'localtime') AS day,
                  SUM(correct_chars)                             AS correct,
                  SUM(duration_ms)                               AS ms,
                  SUM(keystrokes)                                AS keystrokes,
                  SUM(scored_chars)                              AS scored,
                  SUM(errors)                                    AS errors
           FROM sessions
           GROUP BY day
           ORDER BY day DESC
           LIMIT 30`
        )
        .all() as Record<string, number | string>[]
    )
      .map((d) => {
        const ms = Number(d.ms) || 0;
        // Older rows predate scored_chars; fall back to keystrokes for them.
        const scored = Number(d.scored) || Number(d.keystrokes) || 0;
        return {
          day: String(d.day),
          wpm: wpmOf(Number(d.correct), ms),
          accuracyBp:
            scored > 0
              ? Math.round((Math.max(0, scored - Number(d.errors)) / scored) * 10000)
              : 0,
          minutes: Math.max(1, Math.round(ms / 60000)),
        };
      })
      .reverse();

    const recent = (
      sqlite
        .prepare(
          `SELECT s.*, b.title AS bookTitle
           FROM sessions s
           JOIN books b ON b.id = s.book_id
           ORDER BY s.ended_at DESC
           LIMIT 12`
        )
        .all() as any[]
    ).map(normalizeSessionRow);

    /*
     * Per-book rollup. A book practised across many short sittings should read
     * as one line of progress, so speed is recomputed from the summed
     * characters and time rather than averaging the per-session WPM values,
     * which would over-weight brief sessions.
     */
    const byBook = (
      sqlite
        .prepare(
          `SELECT s.book_id                     AS bookId,
                  b.title                       AS bookTitle,
                  COUNT(*)                      AS sessions,
                  SUM(s.correct_chars)          AS correct,
                  SUM(s.duration_ms)            AS ms,
                  SUM(s.keystrokes)             AS keystrokes,
                  SUM(s.scored_chars)           AS scored,
                  SUM(s.errors)                 AS errors,
                  MAX(s.wpm)                    AS bestWpm,
                  MAX(s.ended_at)               AS lastAt
           FROM sessions s
           JOIN books b ON b.id = s.book_id
           GROUP BY s.book_id, b.title
           ORDER BY lastAt DESC`
        )
        .all() as Record<string, number | string>[]
    ).map((row) => {
      // Older rows predate scored_chars; fall back to keystrokes for them.
      const scored = Number(row.scored) || Number(row.keystrokes) || 0;
      const errors = Number(row.errors);
      return {
        bookId: Number(row.bookId),
        bookTitle: String(row.bookTitle),
        sessions: Number(row.sessions),
        wpm: wpmOf(Number(row.correct), Number(row.ms)),
        bestWpm: Number(row.bestWpm),
        accuracyBp:
          scored > 0 ? Math.round((Math.max(0, scored - errors) / scored) * 10000) : 0,
        minutes: Math.max(1, Math.round(Number(row.ms) / 60000)),
        lastAt: Number(row.lastAt),
      };
    });

    const tally = new Map<string, number>();
    for (const row of sqlite.prepare('SELECT errors_by_key FROM sessions').all() as {
      errors_by_key: string;
    }[]) {
      try {
        const parsed = JSON.parse(row.errors_by_key) as Record<string, number>;
        for (const [key, count] of Object.entries(parsed)) {
          tally.set(key, (tally.get(key) ?? 0) + count);
        }
      } catch {
        /* ignore malformed rows */
      }
    }

    return {
      totals: {
        sessions: Number(totals.sessions),
        activeMs: Number(totals.ms),
        minutes: Math.round(Number(totals.ms) / 60000),
        words: Math.round(Number(totals.correct) / 5),
        keystrokes: Number(totals.keystrokes),
        errors: Number(totals.errors),
        // Older rows predate scored_chars; fall back to keystrokes for them.
        accuracyBp: (() => {
          const scored = Number(totals.scored) || Number(totals.keystrokes) || 0;
          if (scored <= 0) return 0;
          return Math.round((Math.max(0, scored - Number(totals.errors)) / scored) * 10000);
        })(),
        bestWpm: Number(totals.bestWpm),
        avgWpm: wpmOf(Number(totals.correct), Number(totals.ms)),
        proseWpm: wpmOf(Number(totals.proseChars), Number(totals.proseMs)),
        codeWpm: wpmOf(Number(totals.codeChars), Number(totals.codeMs)),
      },
      daily,
      recent,
      byBook,
      worstKeys: [...tally.entries()]
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 14),
      streak: computeStreak(daily.map((d) => d.day)),
    };
  }
}

/** Raw queries return snake_case; map back to the shared camelCase type. */
function normalizeSessionRow(row: any): Session & { bookTitle: string } {
  return {
    id: row.id,
    bookId: row.book_id,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    keystrokes: row.keystrokes,
    correctChars: row.correct_chars,
    scoredChars: row.scored_chars ?? 0,
    errors: row.errors,
    blocksCompleted: row.blocks_completed,
    proseChars: row.prose_chars,
    proseMs: row.prose_ms,
    codeChars: row.code_chars,
    codeMs: row.code_ms,
    wpm: row.wpm,
    accuracyBp: row.accuracy_bp,
    errorsByKey: row.errors_by_key ?? '{}',
    bookTitle: row.bookTitle,
  };
}

/** Consecutive days of practice, counting back from today or yesterday. */
function computeStreak(days: string[]): number {
  if (!days.length) return 0;

  const set = new Set(days);
  const cursor = new Date();
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  if (!set.has(iso(cursor))) {
    cursor.setDate(cursor.getDate() - 1);
    if (!set.has(iso(cursor))) return 0;
  }

  let streak = 0;
  while (set.has(iso(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

export const storage: IStorage = new SqliteStorage();
