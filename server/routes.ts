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
import type { ImportResult } from '@shared/schema';

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
function persist(parsed: ParsedBook, sourceName: string): ImportResult['imported'][number] {
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
  };

  const book = storage.createBook(payload);

  return {
    id: book.id,
    title: book.title,
    typeableCount: book.typeableCount,
    codeBlockCount: book.codeBlockCount,
    imageCount: book.imageCount,
    notes: parsed.notes,
  };
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
        caretStyle: z.enum(['line', 'block', 'underline']).optional(),
        keepInPosition: z.number().int().min(0).max(1).optional(),
        markIncorrectWords: z.number().int().min(0).max(1).optional(),
        autoPauseMs: z.number().int().min(0).max(60000).optional(),
        readingFontSize: z.number().int().min(14).max(40).optional(),
        readingLineHeight: z.enum(['xs', 's', 'm', 'l', 'xl']).optional(),
      })
      .safeParse(req.body);
    if (!body.success) return fail(res, 400, 'Invalid settings.');

    res.json(storage.updateSettings(body.data));
  });

  return httpServer;
}
