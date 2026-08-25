import type { Express, Request, Response } from 'express';
import type { Server } from 'node:http';
import multer from 'multer';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ASSETS_DIR, storage } from './storage';
import type { NewBook } from './storage';
import { SUPPORTED_EXTENSIONS, finalizeBlocks, parseFile } from './import';
import type { ParsedBook } from './import';
import { importUrl, normalizeUrl, rendererStatus } from './web-import';
import type { WebPage } from './web-import';
import type { ImportResult, PageContext, TocEntry } from '@shared/schema';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 250 * 1024 * 1024, files: 20 },
});

/** Optional host folder to import from directly, mounted read-only in Docker. */
const LIBRARY_DIR = process.env.TYPEWRIGHT_LIBRARY || '';

const idParam = z.coerce.number().int().positive();

function fail(res: Response, status: number, message: string) {
  res.status(status).json({ message });
}

/** Shared tail of every import path: parse -> chunk -> persist. */
function buildPayload(parsed: ParsedBook, sourceName: string, web?: NewBook['web']): NewBook {
  const settings = storage.getSettings();
  const finalized = finalizeBlocks(parsed, {
    chunkSize: settings.chunkSize,
    normalizePunctuation: settings.normalizePunctuation === 1,
  });

  // Only ship images that a block actually references, plus the cover.
  const usedKeys = new Set(finalized.map((b) => b.imageKey).filter((k): k is string => Boolean(k)));
  if (parsed.coverKey) usedKeys.add(parsed.coverKey);

  const payload: NewBook = {
    title: parsed.title,
    author: parsed.author,
    sourceName,
    format: parsed.format,
    blocks: finalized.map((b) => ({
      kind: b.kind,
      text: b.text,
      section: b.section,
      label: b.label ?? null,
      lang: b.lang ?? null,
      note: b.note ?? null,
      imageKey: b.imageKey,
      links: b.links,
      src: b.src,
    })),
    assets: [...parsed.images.entries()]
      .filter(([key]) => usedKeys.has(key))
      .map(([key, image]) => ({
        key,
        data: image.data,
        mime: image.mime,
        width: image.width,
        height: image.height,
      })),
    coverKey: parsed.coverKey,
    web,
  };

  return payload;
}

function persist(
  parsed: ParsedBook,
  sourceName: string,
  web?: NewBook['web']
): ImportResult['imported'][number] {
  const book = storage.createBook(buildPayload(parsed, sourceName, web));

  return {
    id: book.id,
    title: book.title,
    typeableCount: book.typeableCount,
    codeBlockCount: book.codeBlockCount,
    imageCount: book.imageCount,
    notes: parsed.notes,
  };
}

/**
 * Files off the local disk and pages off the web converge here: attach the page
 * to its collection, remember where it sits in the TOC, then persist.
 */
function persistWebPage(page: WebPage): {
  imported: ImportResult['imported'][number];
  collectionId: number;
  adapter: string;
} {
  const collection = storage.upsertCollection({
    title: page.collection.title,
    homeUrl: page.collection.homeUrl,
    site: page.collection.site,
    rootUrl: page.collection.rootUrl,
    toc: page.collection.toc,
  });

  const toc = JSON.parse(collection.tocJson) as TocEntry[];
  const tocIdx = toc.findIndex((entry) => entry.url && sameUrl(entry.url, page.sourceUrl));

  // The card shows the hostname already; the doc set is the useful subtitle.
  page.author = page.collection.title === page.collection.site ? page.author : page.collection.title;

  /*
   * Sites suffix every <title> with their own name — "Introduction | Wisej.NET".
   * The doc set is already named beside the page, so the suffix is noise.
   */
  const suffixes = [page.collection.title, page.collection.site.replace(/^docs?\./i, '')];
  for (const suffix of suffixes) {
    const trimmed = page.title.replace(
      new RegExp(`\\s*[|\u2013\u2014\u00b7-]\\s*${escapeForTitle(suffix)}\\s*$`, 'i'),
      ''
    );
    if (trimmed && trimmed.length >= 3) page.title = trimmed;
  }

  const imported = persist(page, page.sourceUrl, {
    collectionId: collection.id,
    sourceUrl: page.sourceUrl,
    upstreamUrl: page.upstreamUrl,
    adapter: page.adapter,
    contentHash: page.contentHash,
    tocIdx: tocIdx >= 0 ? tocIdx : null,
  });

  return { imported, collectionId: collection.id, adapter: page.adapter };
}

function escapeForTitle(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** TOC hrefs and page URLs differ by trailing slashes and index documents. */
function tocKey(url: string): string {
  return url
    .replace(/[#?].*$/, '')
    .replace(/\/(index|default)\.\w+$/, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function sameUrl(a: string, b: string): boolean {
  return tocKey(a) === tocKey(b);
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  /* ---------------------------------------------------------------- *
   * Library
   * ---------------------------------------------------------------- */

  app.get('/api/books', (_req, res) => {
    res.json(storage.listBooks());
  });

  app.get('/api/books/:id', (req, res) => {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) return fail(res, 400, 'Invalid book id.');

    const book = storage.getBook(id.data);
    if (!book) return fail(res, 404, 'Book not found.');
    res.json(book);
  });

  /** A window of blocks for the typing view — never the whole book. */
  app.get('/api/books/:id/blocks', (req, res) => {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) return fail(res, 400, 'Invalid book id.');

    const from = Math.max(0, Number(req.query.from ?? 0) || 0);
    const count = Math.min(80, Math.max(1, Number(req.query.count ?? 24) || 24));
    res.json(storage.getBlocks(id.data, from, count));
  });

  app.get('/api/books/:id/outline', (req, res) => {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) return fail(res, 400, 'Invalid book id.');
    res.json(storage.getOutline(id.data));
  });

  app.patch('/api/books/:id', (req, res) => {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) return fail(res, 400, 'Invalid book id.');

    const body = z
      .object({
        title: z.string().min(1).max(300).optional(),
        author: z.string().min(1).max(200).optional(),
        positionIdx: z.number().int().min(0).optional(),
      })
      .safeParse(req.body);
    if (!body.success) return fail(res, 400, 'Invalid update.');

    const book = storage.getBook(id.data);
    if (!book) return fail(res, 404, 'Book not found.');

    if (body.data.positionIdx !== undefined) {
      storage.setPosition(id.data, Math.min(body.data.positionIdx, Math.max(0, book.blockCount - 1)));
    }
    res.json(storage.updateBook(id.data, { title: body.data.title, author: body.data.author }));
  });

  app.delete('/api/books/:id', (req, res) => {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) return fail(res, 400, 'Invalid book id.');

    storage.deleteBook(id.data);
    res.status(204).end();
  });

  /* ---------------------------------------------------------------- *
   * Images
   * ---------------------------------------------------------------- */

  app.get('/api/assets/:id', (req, res) => {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) return fail(res, 400, 'Invalid asset id.');

    const asset = storage.getAsset(id.data);
    if (!asset) return fail(res, 404, 'Image not found.');

    // Resolve and confirm the path stays inside the assets root.
    const full = path.resolve(ASSETS_DIR, asset.relPath);
    if (!full.startsWith(path.resolve(ASSETS_DIR))) return fail(res, 400, 'Bad asset path.');
    if (!fs.existsSync(full)) return fail(res, 404, 'Image file is missing.');

    res.setHeader('Content-Type', asset.mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    fs.createReadStream(full).pipe(res);
  });

  /* ---------------------------------------------------------------- *
   * Import
   * ---------------------------------------------------------------- */

  app.post('/api/import', upload.array('files', 20), async (req: Request, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (!files.length) return fail(res, 400, 'No files received.');

    const result: ImportResult = { imported: [], failed: [] };

    for (const file of files) {
      try {
        const parsed = await parseFile(file.buffer, file.originalname);
        result.imported.push(persist(parsed, file.originalname));
      } catch (error) {
        result.failed.push({
          name: file.originalname,
          reason: error instanceof Error ? error.message : 'Unknown error.',
        });
      }
    }

    res.status(result.imported.length ? 201 : 422).json(result);
  });

  /** Paste-in text or a snippet, for a quick drill without a file. */
  app.post('/api/import/text', (req, res) => {
    const body = z
      .object({
        title: z.string().min(1).max(300),
        author: z.string().max(200).optional(),
        text: z.string().min(10),
        asCode: z.boolean().default(false),
      })
      .safeParse(req.body);
    if (!body.success) return fail(res, 400, 'Give it a title and at least 10 characters of text.');

    const suffix = body.data.asCode ? '.md' : '.txt';
    const content = body.data.asCode ? `\`\`\`\n${body.data.text}\n\`\`\`` : body.data.text;

    // Route pasted content through the same parser the files use.
    parseFile(Buffer.from(content, 'utf8'), `${body.data.title}${suffix}`)
      .then((parsedBook) => {
        parsedBook.title = body.data.title;
        parsedBook.author = body.data.author || 'Unknown';
        res.status(201).json({ imported: [persist(parsedBook, 'pasted text')], failed: [] });
      })
      .catch((error: unknown) =>
        fail(res, 422, error instanceof Error ? error.message : 'Could not process that text.')
      );
  });

  /* ---------------------------------------------------------------- *
   * Web pages and documentation sets
   * ---------------------------------------------------------------- */

  /**
   * Import a URL, or hand back the page if it is already in the library. Used
   * both by the paste-a-link box and by navigating the table of contents, so
   * jumping to an unread page just works.
   */
  app.post('/api/import/url', async (req, res) => {
    const body = z.object({ url: z.string().min(8).max(2000) }).safeParse(req.body);
    if (!body.success) return fail(res, 400, 'Give it a http or https URL.');

    let url: string;
    try {
      url = normalizeUrl(body.data.url);
    } catch (error) {
      return fail(res, 400, error instanceof Error ? error.message : 'That URL is not valid.');
    }

    const existing = storage.getBookByUrl(url);
    if (existing) {
      return res.json({
        bookId: existing.id,
        collectionId: existing.collectionId,
        alreadyImported: true,
        adapter: existing.adapter,
        notes: [],
      });
    }

    try {
      const page = await importUrl(url);
      const result = persistWebPage(page);
      res.status(201).json({
        bookId: result.imported.id,
        collectionId: result.collectionId,
        alreadyImported: false,
        adapter: result.adapter,
        title: result.imported.title,
        notes: result.imported.notes,
      });
    } catch (error) {
      fail(res, 422, error instanceof Error ? error.message : 'Could not import that page.');
    }
  });

  /** Re-fetch a page and rebuild it in place. Progress on it resets. */
  app.post('/api/books/:id/refresh', async (req, res) => {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) return fail(res, 400, 'Invalid book id.');

    const book = storage.getBook(id.data);
    if (!book) return fail(res, 404, 'Page not found.');
    if (!book.sourceUrl) return fail(res, 400, 'That page did not come from a URL.');

    try {
      const page = await importUrl(book.sourceUrl);

      if (page.contentHash === book.contentHash) {
        return res.json({ changed: false, message: 'That page has not changed upstream.' });
      }

      const payload = buildPayload(page, book.sourceUrl, {
        collectionId: book.collectionId!,
        sourceUrl: book.sourceUrl,
        upstreamUrl: page.upstreamUrl,
        adapter: page.adapter,
        contentHash: page.contentHash,
        tocIdx: book.tocIdx,
      });

      const updated = storage.replaceBookContent(book.id, payload);
      res.json({ changed: true, book: updated, notes: page.notes });
    } catch (error) {
      fail(res, 422, error instanceof Error ? error.message : 'Could not refresh that page.');
    }
  });

  app.get('/api/collections', (_req, res) => {
    res.json(storage.listCollectionSummaries());
  });

  /** Removing a doc set removes every page of it that was imported. */
  app.delete('/api/collections/:id', (req, res) => {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) return fail(res, 400, 'Invalid collection id.');

    const pages = storage.listCollectionBooks(id.data);
    if (!pages.length) return fail(res, 404, 'Doc set not found.');

    for (const page of pages) storage.deleteBook(page.id);
    res.json({ removed: pages.length });
  });

  /** The pages of one doc set that are held locally. */
  app.get('/api/collections/:id/pages', (req, res) => {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) return fail(res, 400, 'Invalid collection id.');
    res.json(storage.listCollectionBooks(id.data));
  });

  /** Everything the typing view needs to offer page navigation. */
  app.get('/api/books/:id/context', (req, res) => {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) return fail(res, 400, 'Invalid book id.');

    const book = storage.getBook(id.data);
    if (!book) return fail(res, 404, 'Page not found.');
    if (!book.collectionId) return res.json(null);

    const collection = storage.getCollection(book.collectionId);
    if (!collection) return res.json(null);

    const toc = JSON.parse(collection.tocJson) as TocEntry[];

    // Position by stored index when we have it, else by matching the URL.
    let tocIdx =
      book.tocIdx !== null && toc[book.tocIdx]?.url && sameUrl(toc[book.tocIdx].url!, book.sourceUrl ?? '')
        ? book.tocIdx
        : toc.findIndex((entry) => entry.url && book.sourceUrl && sameUrl(entry.url, book.sourceUrl));
    if (tocIdx < 0) tocIdx = -1;

    const withUrl = (from: number, step: -1 | 1): TocEntry | null => {
      for (let i = from + step; i >= 0 && i < toc.length; i += step) {
        if (toc[i].url) return toc[i];
      }
      return null;
    };

    const imported: Record<string, number> = {};
    for (const page of storage.listCollectionBooks(collection.id)) {
      if (page.sourceUrl) imported[page.sourceUrl] = page.id;
    }

    const context: PageContext = {
      collection,
      toc,
      tocIdx: tocIdx >= 0 ? tocIdx : null,
      previous: tocIdx >= 0 ? withUrl(tocIdx, -1) : null,
      next: tocIdx >= 0 ? withUrl(tocIdx, 1) : null,
      imported,
    };
    res.json(context);
  });

  /**
   * Every link on a page, with the block it appeared in.
   *
   * Links that point at a page in the same table of contents are flagged, since
   * those can be opened as typing practice rather than just visited.
   */
  app.get('/api/books/:id/links', (req, res) => {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) return fail(res, 400, 'Invalid book id.');

    const book = storage.getBook(id.data);
    if (!book) return fail(res, 404, 'Page not found.');

    const links = storage.getPageLinks(book.id);

    // Which of them are pages in this doc set, and which are already imported.
    const inToc = new Set<string>();
    const imported: Record<string, number> = {};

    if (book.collectionId) {
      const collection = storage.getCollection(book.collectionId);
      for (const entry of (JSON.parse(collection?.tocJson ?? '[]') as TocEntry[])) {
        if (entry.url) inToc.add(tocKey(entry.url));
      }
      for (const page of storage.listCollectionBooks(book.collectionId)) {
        if (page.sourceUrl) imported[tocKey(page.sourceUrl)] = page.id;
      }
    }

    res.json(
      links.map((link) => ({
        ...link,
        inToc: inToc.has(tocKey(link.url)),
        bookId: imported[tocKey(link.url)] ?? null,
      }))
    );
  });

  /* ---------------------------------------------------------------- *
   * Book sources — pinned links to places you get books
   * ---------------------------------------------------------------- */

  app.get('/api/book-sources', (_req, res) => {
    res.json(storage.listBookSources());
  });

  app.post('/api/book-sources', (req, res) => {
    const body = z
      .object({
        label: z.string().trim().min(1).max(120),
        url: z.string().url().max(2000),
        note: z.string().max(400).nullish(),
      })
      .safeParse(req.body);
    if (!body.success) return fail(res, 400, 'Give it a label and a URL.');

    try {
      const parsed = new URL(body.data.url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return fail(res, 400, 'Only http and https URLs can be saved.');
      }
    } catch {
      return fail(res, 400, 'That URL is not valid.');
    }

    res.status(201).json(
      storage.createBookSource({
        label: body.data.label,
        url: body.data.url,
        note: body.data.note ?? null,
      })
    );
  });

  app.delete('/api/book-sources/:id', (req, res) => {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) return fail(res, 400, 'Invalid id.');
    storage.deleteBookSource(id.data);
    res.status(204).end();
  });

  app.get('/api/renderer', async (_req, res) => {
    res.json(await rendererStatus());
  });

  /* ---------------------------------------------------------------- *
   * Host folder browsing (Docker volume)
   * ---------------------------------------------------------------- */

  app.get('/api/library', async (_req, res) => {
    if (!LIBRARY_DIR) return res.json({ dir: null, files: [] });

    try {
      const entries = await fsp.readdir(LIBRARY_DIR, { withFileTypes: true });
      const files = await Promise.all(
        entries
          .filter(
            (e) => e.isFile() && SUPPORTED_EXTENSIONS.includes(path.extname(e.name).toLowerCase())
          )
          .map(async (e) => {
            const stat = await fsp.stat(path.join(LIBRARY_DIR, e.name)).catch(() => null);
            return { name: e.name, bytes: stat?.size ?? 0 };
          })
      );
      files.sort((a, b) => a.name.localeCompare(b.name));
      res.json({ dir: LIBRARY_DIR, files });
    } catch {
      res.json({ dir: LIBRARY_DIR, files: [], error: 'That folder is not readable.' });
    }
  });

  app.post('/api/library/import', async (req, res) => {
    if (!LIBRARY_DIR) return fail(res, 400, 'No library folder is configured.');

    const body = z.object({ names: z.array(z.string().min(1)).min(1).max(20) }).safeParse(req.body);
    if (!body.success) return fail(res, 400, 'Select at least one file.');

    const result: ImportResult = { imported: [], failed: [] };

    for (const name of body.data.names) {
      const safe = path.basename(name); // never escape the mounted folder
      try {
        const buffer = await fsp.readFile(path.join(LIBRARY_DIR, safe));
        const parsed = await parseFile(buffer, safe);
        result.imported.push(persist(parsed, safe));
      } catch (error) {
        result.failed.push({
          name: safe,
          reason: error instanceof Error ? error.message : 'Unknown error.',
        });
      }
    }

    res.status(result.imported.length ? 201 : 422).json(result);
  });

  /* ---------------------------------------------------------------- *
   * Sessions and stats
   * ---------------------------------------------------------------- */

  app.post('/api/sessions', (req, res) => {
    const body = z
      .object({
        bookId: z.number().int().positive(),
        durationMs: z.number().int().min(0),
        keystrokes: z.number().int().min(0),
        correctChars: z.number().int().min(0),
        errors: z.number().int().min(0),
        blocksCompleted: z.number().int().min(0),
        proseChars: z.number().int().min(0).default(0),
        proseMs: z.number().int().min(0).default(0),
        codeChars: z.number().int().min(0).default(0),
        codeMs: z.number().int().min(0).default(0),
        errorsByKey: z.record(z.string(), z.number()).default({}),
      })
      .safeParse(req.body);
    if (!body.success) return fail(res, 400, 'Invalid session payload.');

    const { errorsByKey, ...rest } = body.data;
    if (!storage.getBook(rest.bookId)) return fail(res, 404, 'Book not found.');
    if (rest.durationMs < 1000 || rest.keystrokes < 5) {
      return res.status(200).json({ skipped: true }); // too short to be worth recording
    }

    const minutes = rest.durationMs / 60000;
    const session = storage.createSession({
      ...rest,
      endedAt: Date.now(),
      wpm: minutes > 0 ? Math.round(rest.correctChars / 5 / minutes) : 0,
      accuracyBp:
        rest.keystrokes > 0
          ? Math.round(((rest.keystrokes - rest.errors) / rest.keystrokes) * 10000)
          : 0,
      errorsByKey: JSON.stringify(errorsByKey),
    });
    res.status(201).json(session);
  });

  app.get('/api/stats', (_req, res) => {
    res.json(storage.getStats());
  });

  /* ---------------------------------------------------------------- *
   * Per-block progress
   * ---------------------------------------------------------------- */

  app.get('/api/books/:id/progress', (req, res) => {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) return fail(res, 400, 'Invalid book id.');
    if (!storage.getBook(id.data)) return fail(res, 404, 'Book not found.');
    res.json(storage.listBlockProgress(id.data));
  });

  app.post('/api/books/:id/progress', (req, res) => {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) return fail(res, 400, 'Invalid book id.');
    if (!storage.getBook(id.data)) return fail(res, 404, 'Book not found.');

    const body = z
      .object({
        blockIdx: z.number().int().min(0),
        status: z.enum(['typed', 'skipped']),
        wpm: z.number().int().min(0).nullable().default(null),
        accuracyBp: z.number().int().min(0).max(10000).nullable().default(null),
        durationMs: z.number().int().min(0).nullable().default(null),
        keystrokes: z.number().int().min(0).nullable().default(null),
        errors: z.number().int().min(0).nullable().default(null),
      })
      .safeParse(req.body);
    if (!body.success) return fail(res, 400, 'Invalid progress payload.');

    storage.upsertBlockProgress({
      bookId: id.data,
      ...body.data,
      updatedAt: Date.now(),
    });
    res.status(204).end();
  });

  /* ---------------------------------------------------------------- *
   * Settings
   * ---------------------------------------------------------------- */

  app.get('/api/settings', (_req, res) => {
    res.json(storage.getSettings());
  });

  app.patch('/api/settings', (req, res) => {
    const body = z
      .object({
        theme: z.enum(['system', 'light', 'dark']).optional(),
        chunkSize: z.number().int().min(80).max(1200).optional(),
        strictMode: z.number().int().min(0).max(1).optional(),
        normalizePunctuation: z.number().int().min(0).max(1).optional(),
        skipCode: z.number().int().min(0).max(1).optional(),
        autoIndent: z.number().int().min(0).max(1).optional(),
        soundOnError: z.number().int().min(0).max(1).optional(),
        fontSize: z.number().int().min(14).max(40).optional(),
        typeface: z.enum(['serif', 'sans']).optional(),
        mistakeMode: z.enum(['block', 'mark', 'fix']).optional(),
        advanceMode: z.enum(['auto', 'confirm']).optional(),
        ignoreCaseProse: z.number().int().min(0).max(1).optional(),
        showNewlines: z.number().int().min(0).max(1).optional(),
        caretStyle: z.enum(['line', 'block', 'underline']).optional(),
        caretBlink: z.number().int().min(0).max(1).optional(),
        keepInPosition: z.number().int().min(0).max(1).optional(),
        markIncorrectWords: z.number().int().min(0).max(1).optional(),
        autoPauseMs: z.number().int().min(0).max(60000).optional(),
        readingFontSize: z.number().int().min(14).max(40).optional(),
        readingLineHeight: z.enum(['xs', 's', 'm', 'l', 'xl']).optional(),
        showShortcutHints: z.number().int().min(0).max(1).optional(),
        skipUntypeable: z.number().int().min(0).max(1).optional(),
        keyboardLayout: z.enum(['us', 'us-intl', 'any']).optional(),
      })
      .safeParse(req.body);
    if (!body.success) return fail(res, 400, 'Invalid settings.');

    res.json(storage.updateSettings(body.data));
  });

  return httpServer;
}
