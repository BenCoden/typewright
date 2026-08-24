import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { assets, blocks, books, sessions, settings } from '@shared/schema';
import type {
  Asset,
  Block,
  BlockView,
  Book,
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
    note     TEXT
  );
  CREATE INDEX IF NOT EXISTS blocks_book_idx ON blocks (book_id, idx);

  CREATE TABLE IF NOT EXISTS sessions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id          INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    ended_at         INTEGER NOT NULL,
    duration_ms      INTEGER NOT NULL,
    keystrokes       INTEGER NOT NULL,
    correct_chars    INTEGER NOT NULL,
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
}

export interface NewBook {
  title: string;
  author: string;
  sourceName: string;
  format: string;
  blocks: NewBlock[];
  assets: NewAsset[];
  coverKey?: string;
}

export interface IStorage {
  listBooks(): Book[];
  getBook(id: number): Book | undefined;
  createBook(input: NewBook): Book;
  deleteBook(id: number): void;
  updateBook(id: number, patch: { title?: string; author?: string }): Book | undefined;
  setPosition(id: number, idx: number): Book | undefined;
  getBlocks(bookId: number, from: number, count: number): BlockView[];
  /** Chapter/section outline for the jump-to menu. */
  getOutline(bookId: number): { idx: number; section: string; kind: string }[];
  getAsset(id: number): Asset | undefined;
  createSession(input: Omit<Session, 'id'>): Session;
  getSettings(): Settings;
  updateSettings(patch: Partial<Settings>): Settings;
  getStats(): StatsSummary;
}

/* ------------------------------------------------------------------ *
 * Implementation
 * ------------------------------------------------------------------ */

const TYPEABLE = new Set(['prose', 'heading', 'code']);

class SqliteStorage implements IStorage {
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
    const typeable = input.blocks.filter((b) => TYPEABLE.has(b.kind));
    const charCount = typeable.reduce((sum, b) => sum + b.text.length, 0);
    const wordCount = typeable.reduce(
      (sum, b) => sum + b.text.split(/\s+/).filter(Boolean).length,
      0
    );

    const insert = sqlite.transaction(() => {
      const book = db
        .insert(books)
        .values({
          title: input.title,
          author: input.author,
          sourceName: input.sourceName,
          format: input.format,
          charCount,
          wordCount,
          blockCount: input.blocks.length,
          typeableCount: typeable.length,
          codeBlockCount: input.blocks.filter((b) => b.kind === 'code').length,
          imageCount: input.blocks.filter((b) => b.kind === 'image').length,
          addedAt: Date.now(),
        })
        .returning()
        .get();

      // Images land on disk under data/assets/<bookId>/ with flattened names.
      const bookAssetDir = path.join(ASSETS_DIR, String(book.id));
      fs.mkdirSync(bookAssetDir, { recursive: true });

      const assetIdByKey = new Map<string, number>();
      const assetStmt = sqlite.prepare(
        'INSERT INTO assets (book_id, rel_path, mime, width, height, bytes) VALUES (?, ?, ?, ?, ?, ?)'
      );

      for (const asset of input.assets) {
        const safeName = asset.key.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-120);
        const relPath = path.posix.join(String(book.id), safeName);
        fs.writeFileSync(path.join(ASSETS_DIR, relPath), asset.data);
        const result = assetStmt.run(
          book.id,
          relPath,
          asset.mime,
          asset.width ?? null,
          asset.height ?? null,
          asset.data.length
        );
        assetIdByKey.set(asset.key, Number(result.lastInsertRowid));
      }

      const blockStmt = sqlite.prepare(
        `INSERT INTO blocks (book_id, idx, kind, text, section, label, lang, asset_id, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      input.blocks.forEach((b, i) => {
        blockStmt.run(
          book.id,
          i,
          b.kind,
          b.text,
          b.section ?? null,
          b.label ?? null,
          b.lang ?? null,
          b.imageKey ? assetIdByKey.get(b.imageKey) ?? null : null,
          b.note ?? null
        );
      });

      const coverAssetId = input.coverKey ? assetIdByKey.get(input.coverKey) ?? null : null;
      if (coverAssetId) {
        db.update(books).set({ coverAssetId }).where(eq(books.id, book.id)).run();
        return { ...book, coverAssetId };
      }
      return book;
    });

    return insert();
  }

  deleteBook(id: number): void {
    sqlite.transaction(() => {
      db.delete(blocks).where(eq(blocks.bookId, id)).run();
      db.delete(sessions).where(eq(sessions.bookId, id)).run();
      db.delete(assets).where(eq(assets.bookId, id)).run();
      db.delete(books).where(eq(books.id, id)).run();
    })();

    fs.rmSync(path.join(ASSETS_DIR, String(id)), { recursive: true, force: true });
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

    return rows.map((row) => ({ ...(row.block as Block), asset: row.asset ?? null }));
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

  getSettings(): Settings {
    return db.select().from(settings).where(eq(settings.id, 1)).get()!;
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
        const keystrokes = Number(d.keystrokes) || 0;
        return {
          day: String(d.day),
          wpm: wpmOf(Number(d.correct), ms),
          accuracyBp:
            keystrokes > 0 ? Math.round(((keystrokes - Number(d.errors)) / keystrokes) * 10000) : 0,
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
        accuracyBp:
          Number(totals.keystrokes) > 0
            ? Math.round(
                ((Number(totals.keystrokes) - Number(totals.errors)) / Number(totals.keystrokes)) *
                  10000
              )
            : 0,
        bestWpm: Number(totals.bestWpm),
        avgWpm: wpmOf(Number(totals.correct), Number(totals.ms)),
        proseWpm: wpmOf(Number(totals.proseChars), Number(totals.proseMs)),
        codeWpm: wpmOf(Number(totals.codeChars), Number(totals.codeMs)),
      },
      daily,
      recent,
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
