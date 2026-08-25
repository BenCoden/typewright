import JSZip from 'jszip';
import { parse as parseHtml, type HTMLElement, type Node as HtmlNode } from 'node-html-parser';
import path from 'node:path';
import type { BlockKind, BlockLink } from '@shared/schema';

/**
 * Import pipeline: file bytes -> ordered blocks -> chunked typing units.
 *
 * A technical book is not a stream of prose. It is prose, code listings, and
 * figures, in order. This importer preserves that structure:
 *
 *   prose / heading -> punctuation normalised, split into sentence-sized runs
 *   code            -> verbatim, newlines and indentation intact, never split
 *   image           -> extracted to disk and shown, never typed
 *
 * Normalisation happens once, here, so the typing engine can compare keystrokes
 * to exactly what is stored and never asks for a character the keyboard cannot
 * produce.
 */

export interface RawBlock {
  kind: BlockKind;
  text: string;
  section: string | null;
  lang?: string | null;
  /** Caption such as "Listing 10.1 PersistentRemoveEmail". Displayed, not typed. */
  label?: string | null;
  /** Code annotation legend, figure source note, etc. Displayed, not typed. */
  note?: string | null;
  /** Key into ParsedBook.images for image blocks. */
  imageKey?: string;
  /** Links inside `text`, with offsets into it. */
  links?: BlockLink[];
  /** For embeds: the video or page URL. */
  src?: string;
}

export interface ExtractedImage {
  data: Buffer;
  mime: string;
  width?: number;
  height?: number;
}

export interface ParsedBook {
  title: string;
  author: string;
  format: string;
  blocks: RawBlock[];
  images: Map<string, ExtractedImage>;
  /** Key into `images` for the cover, when the source had one. */
  coverKey?: string;
  /** Import caveats worth surfacing in the UI. */
  notes: string[];
}

export interface ImportOptions {
  chunkSize: number;
  normalizePunctuation: boolean;
}

/* ------------------------------------------------------------------ *
 * Text normalisation
 * ------------------------------------------------------------------ */

/** Characters that are invisible or untypeable — always removed. */
const INVISIBLE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;

/** Non-breaking and exotic spaces — always folded to a plain space. */
const ODD_SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;

const PROSE_MAP: Record<string, string> = {
  '\u2018': "'",
  '\u2019': "'",
  '\u201A': "'",
  '\u201B': "'",
  '\u2032': "'",
  '\u02BC': "'",
  '\u201C': '"',
  '\u201D': '"',
  '\u201E': '"',
  '\u2033': '"',
  '\u00AB': '"',
  '\u00BB': '"',
  '\u2039': "'",
  '\u203A': "'",
  '\u2013': '-',
  '\u2014': '--',
  '\u2015': '--',
  '\u2212': '-',
  '\u2026': '...',
  '\u2044': '/',
  '\u00B7': '.',
  '\u2022': '-',
  '\uFB00': 'ff',
  '\uFB01': 'fi',
  '\uFB02': 'fl',
  '\uFB03': 'ffi',
  '\uFB04': 'ffl',
};

const PROSE_RE = new RegExp(`[${Object.keys(PROSE_MAP).join('')}]`, 'g');

/**
 * Quotes and dashes that a converter mangled inside a code listing. Real source
 * code never contains curly quotes, so these are always folded back to ASCII —
 * independent of the prose punctuation setting.
 */
const CODE_RE = /[\u2018\u2019\u201A\u201B\u2032\u02BC\u201C\u201D\u201E\u2033\u2013\u2014\u2015\u2212]/g;
const CODE_MAP: Record<string, string> = {
  '\u2018': "'",
  '\u2019': "'",
  '\u201A': "'",
  '\u201B': "'",
  '\u2032': "'",
  '\u02BC': "'",
  '\u201C': '"',
  '\u201D': '"',
  '\u201E': '"',
  '\u2033': '"',
  '\u2013': '-',
  '\u2014': '-',
  '\u2015': '-',
  '\u2212': '-',
};

/*
 * Control characters are stripped from every text path — except the three used
 * as link markers (U+0001 open, U+0002 close, U+0003 separator), which have to
 * survive normalisation and sentence splitting. They are removed at the end, by
 * readLinkMarkers or stripLinkMarkers.
 */
const CONTROL = /[\u0000\u0004-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function normalizeProse(input: string, normalizePunctuation: boolean): string {
  let text = input.replace(/\r\n?/g, '\n').replace(INVISIBLE, '').replace(ODD_SPACES, ' ');

  if (normalizePunctuation) {
    text = text.replace(PROSE_RE, (c) => PROSE_MAP[c] ?? c);
  }

  // Re-join words split across a line by a hyphen ("gar-\nden" -> "garden").
  text = text.replace(/(\p{Ll})-\n(\p{Ll})/gu, '$1$2');

  return text
    .replace(CONTROL, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Code keeps its shape. Tabs become four spaces because a Tab keypress is
 * ambiguous across editors, trailing whitespace is dropped because it is
 * invisible and unfair to type, and shared leading indentation is removed so a
 * deeply nested excerpt starts at column zero.
 */
export function normalizeCode(input: string): string {
  let text = input
    .replace(/\r\n?/g, '\n')
    .replace(INVISIBLE, '')
    .replace(ODD_SPACES, ' ')
    .replace(CODE_RE, (c) => CODE_MAP[c] ?? c)
    .replace(/\t/g, '    ')
    .replace(CONTROL, '');

  const lines = text.split('\n').map((l) => l.replace(/[ ]+$/, ''));

  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length) return '';

  const indents = lines.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length);
  const common = indents.length ? Math.min(...indents) : 0;

  return lines.map((l) => (l.trim() ? l.slice(common) : '')).join('\n');
}

/* ------------------------------------------------------------------ *
 * Prose segmentation
 * ------------------------------------------------------------------ */

/**
 * Abbreviations whose trailing period never ends a sentence. Without this,
 * "e.g. Foo" and "Fig. 2" break mid-thought.
 */
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st',
  'fig', 'eq', 'ch', 'sec', 'no', 'vol', 'pp', 'ed',
  'inc', 'ltd', 'co', 'corp', 'vs', 'cf', 'al', 'etc',
  'e.g', 'i.e', 'approx',
]);

/**
 * Splits a paragraph at sentence boundaries.
 *
 * A boundary needs a terminator, then whitespace, then something that can open
 * a sentence. Requiring the whitespace is what keeps ".NET", "Node.js", and
 * "3.5" intact — in those the period is followed immediately by a character, so
 * no boundary exists.
 */
function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;

  const boundary = /([.!?]+["'”’)\]]*)(\s+)(?=["'“‘(\[]?[A-Z0-9])/g;
  let match: RegExpExecArray | null;

  while ((match = boundary.exec(text)) !== null) {
    const end = match.index + match[1].length;

    // "…according to Fig. 2" is one sentence, not two.
    const preceding = text.slice(start, match.index).match(/([\w.]+)$/)?.[1] ?? '';
    if (ABBREVIATIONS.has(preceding.toLowerCase().replace(/\.$/, ''))) continue;

    // A single capital before the period is almost always an initial.
    if (/(^|\s)[A-Z]$/.test(text.slice(start, match.index))) continue;

    out.push(text.slice(start, end));
    start = end + match[2].length;
  }

  if (start < text.length) out.push(text.slice(start));
  return out.filter((sentence) => sentence.trim().length > 0);
}

/**
 * Break a paragraph into typing units of roughly `target` characters, preferring
 * sentence boundaries, then word boundaries. Never splits mid-word.
 */
export function segmentProse(text: string, target: number): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= target * 1.35) return [clean];

  const sentences = splitSentences(clean);
  if (!sentences.length) return [clean];
  const out: string[] = [];
  let buffer = '';

  const flush = () => {
    const trimmed = buffer.trim();
    if (trimmed) out.push(trimmed);
    buffer = '';
  };

  for (const sentence of sentences) {
    if (sentence.trim().length > target * 1.6) {
      flush();
      out.push(...splitOnWords(sentence.trim(), target));
      continue;
    }
    if (buffer && buffer.length + sentence.length > target * 1.15) flush();
    buffer = buffer ? `${buffer} ${sentence}` : sentence;
  }
  flush();

  return out;
}

function splitOnWords(text: string, target: number): string[] {
  const out: string[] = [];
  let buffer = '';
  for (const word of text.split(' ')) {
    if (buffer && buffer.length + word.length + 1 > target) {
      out.push(buffer);
      buffer = '';
    }
    buffer = buffer ? `${buffer} ${word}` : word;
  }
  if (buffer) out.push(buffer);
  return out;
}

/* ------------------------------------------------------------------ *
 * Language detection
 * ------------------------------------------------------------------ */

export function detectLang(code: string, hint?: string | null): string | null {
  if (hint) {
    const m = hint.match(/(?:language|lang|brush:|highlight-source-)[-:]?([a-z0-9+#]+)/i);
    if (m) return m[1].toLowerCase();
  }

  const s = code.slice(0, 900);
  if (/^\s*[{[][\s\S]*[}\]]\s*$/.test(code) && /"[^"]+"\s*:/.test(s)) return 'json';
  if (/<\/[a-z]+>/i.test(s) && /<[a-z]+[\s>]/i.test(s)) return 'xml';
  if (/\b(using System|namespace |public class|Console\.WriteLine|var \w+ = new|async Task|=> *\{)/.test(s))
    return 'csharp';
  if (/^\s*(dotnet|npm|npx|git|docker|setx|export|cd|pip|curl|sudo|az) /m.test(s)) return 'shell';
  if (/\b(def |import |print\(|self\.|elif )/.test(s)) return 'python';
  if (/\b(function |const |let |=>|console\.log|require\()/.test(s)) return 'javascript';
  if (/^\s*(SELECT|INSERT|UPDATE|CREATE TABLE|ALTER TABLE)\b/im.test(s)) return 'sql';
  if (/^\s*[\w.]+\s*[:=]\s*\S+$/m.test(s) && !/[;{}]/.test(s)) return 'config';
  return null;
}

/* ------------------------------------------------------------------ *
 * HTML / XHTML walker
 * ------------------------------------------------------------------ */

const SKIP_TAGS = new Set(['script', 'style', 'head', 'title', 'link', 'meta', 'nav', 'svg']);
const PROSE_TAGS = new Set(['p', 'li', 'blockquote', 'dd', 'dt', 'figcaption', 'td', 'th', 'caption']);
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/** Manning/Leanpub-style annotation legends that sit next to a listing. */
function isAnnotation(el: HTMLElement): boolean {
  const cls = el.getAttribute('class') ?? '';
  return /code-annotation|annotation-overlay|calloutlist/i.test(cls);
}

/**
 * Text of a <pre>, with markup removed.
 *
 * `pre` is parsed as a raw-text element so its whitespace survives, which means
 * any nested markup a syntax highlighter added is still sitting in the string.
 * Line structure comes from real newlines, so only <br> needs translating.
 */
export function preText(el: HTMLElement): string {
  const raw = el.innerHTML ?? '';

  // Nothing nested: the parser already decoded entities for us.
  if (!/<[a-z!/]/i.test(raw)) return el.textContent ?? '';

  return decodeHtmlEntities(
    raw
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(div|p|li|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  );
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(parseInt(code, 10)))
    .replace(/&amp;/g, '&');
}

function textOf(node: HtmlNode): string {
  // node-html-parser decodes entities for us; <br> needs manual handling.
  const html = (node as HTMLElement).innerHTML ?? '';
  if (/<br\s*\/?>/i.test(html)) {
    const cloned = parseHtml(html.replace(/<br\s*\/?>/gi, ' \u0001 '));
    return cloned.textContent.replace(/\u0001/g, ' ');
  }
  return node.textContent ?? '';
}

interface WalkContext {
  blocks: RawBlock[];
  section: string | null;
  /** Resolves an <img src> to a key in ParsedBook.images. Returns null if missing. */
  resolveImage: (src: string) => string | null;
  /**
   * Page URL, set only for web imports. Its presence turns on link capture and
   * embedded-media blocks — a book off the disk has neither.
   */
  pageUrl?: string;
}

/*
 * Anchors are marked in place with two control characters before any text is
 * extracted. The text then goes through exactly the same normalising as
 * everything else, and the markers come out at the end carrying the offsets
 * the reader needs to underline the words that were linked.
 */
export const LINK_OPEN = '\u0001';
const LINK_SEP = '\u0003';
export const LINK_CLOSE = '\u0002';

/**
 * Wraps link text in markers that carry the destination with them.
 *
 * The URL travels inside the string rather than in a side table because the text
 * is still going to be normalised and split into sentence runs before it is
 * stored. Anything held alongside would drift; this cannot.
 */
export function markLink(url: string, internal: boolean, label: string): string {
  return `${LINK_OPEN}${internal ? '1' : '0'}${url}${LINK_SEP}${label}${LINK_CLOSE}`;
}

export function stripLinkMarkers(text: string): string {
  return text.replace(
    new RegExp(`${LINK_OPEN}[^${LINK_SEP}${LINK_CLOSE}]*${LINK_SEP}|[${LINK_OPEN}${LINK_CLOSE}]`, 'g'),
    ''
  );
}

/** Marks every usable anchor in place, and reports how many were marked. */
function markLinks(root: HTMLElement, pageUrl: string): number {
  let marked = 0;
  const host = (() => {
    try {
      return new URL(pageUrl).hostname;
    } catch {
      return '';
    }
  })();

  for (const anchor of root.querySelectorAll('a')) {
    const href = anchor.getAttribute('href');
    const label = anchor.textContent.replace(/\s+/g, ' ').trim();
    // Heading-anchor widgets label themselves with a zero-width character.
    if (!href || !label.replace(INVISIBLE, '').trim()) continue;

    // A link to a spot on this same page is not somewhere to navigate to.
    if (href.startsWith('#')) continue;

    // Anchors inside a listing are part of the code; leave them alone.
    let parent = anchor.parentNode as HTMLElement | null;
    let insidePre = false;
    while (parent) {
      if ((parent.rawTagName ?? '').toLowerCase() === 'pre') {
        insidePre = true;
        break;
      }
      parent = parent.parentNode as HTMLElement | null;
    }
    if (insidePre) continue;

    let url: URL;
    try {
      url = new URL(href, pageUrl);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;

    // Same page, different fragment: still not a destination.
    if (url.href.split('#')[0] === pageUrl.split('#')[0]) continue;

    anchor.textContent = markLink(url.toString(), url.hostname === host, label);
    marked += 1;
  }

  return marked;
}

/**
 * Pulls the markers back out of a finished string, turning each pair into a
 * link with offsets into the cleaned text.
 */
export function readLinkMarkers(text: string): { text: string; links: BlockLink[] } {
  if (!text.includes(LINK_OPEN)) return { text, links: [] };

  let out = '';
  const links: BlockLink[] = [];
  let open: { at: number; url: string; internal: boolean } | null = null;
  let header: string | null = null;

  for (const char of text) {
    if (char === LINK_OPEN) {
      header = '';
      continue;
    }
    if (header !== null) {
      if (char === LINK_SEP) {
        open = { at: out.length, url: header.slice(1), internal: header.startsWith('1') };
        header = null;
      } else {
        header += char;
      }
      continue;
    }
    if (char === LINK_CLOSE) {
      // A run that got split mid-link keeps only the half it still holds.
      if (open && out.length > open.at) {
        links.push({
          text: out.slice(open.at),
          url: open.url,
          start: open.at,
          end: out.length,
          internal: open.internal,
        });
      }
      open = null;
      continue;
    }
    out += char;
  }

  // An unterminated marker means the link ran past the end of this run.
  if (open && out.length > open.at) {
    links.push({
      text: out.slice(open.at),
      url: open.url,
      start: open.at,
      end: out.length,
      internal: open.internal,
    });
  }

  return { text: out, links };
}

/** Video and media embeds worth showing. Anything else is site furniture. */
const EMBED_HOSTS =
  /(?:youtube\.com|youtube-nocookie\.com|youtu\.be|vimeo\.com|player\.vimeo\.com|dailymotion\.com|loom\.com|wistia\.(?:com|net)|streamable\.com|codepen\.io|codesandbox\.io|jsfiddle\.net|asciinema\.org)/i;

function walk(node: HtmlNode, ctx: WalkContext): void {
  const el = node as HTMLElement;
  const tag = (el.rawTagName ?? '').toLowerCase();

  if (!tag) return; // text node — handled by its parent block element
  if (SKIP_TAGS.has(tag)) return;

  if (tag === 'pre') {
    const code = normalizeCode(stripLinkMarkers(preText(el)));
    if (code.replace(/\s/g, '').length) {
      ctx.blocks.push({
        kind: 'code',
        text: code,
        section: ctx.section,
        lang: detectLang(code, el.getAttribute('class') ?? el.querySelector('code')?.getAttribute('class')),
      });
    }
    return;
  }

  if (tag === 'img') {
    const src = el.getAttribute('src') ?? '';
    const key = src ? ctx.resolveImage(src) : null;
    if (key) {
      ctx.blocks.push({
        kind: 'image',
        text: (el.getAttribute('alt') ?? '').trim().replace(/^image$/i, ''),
        section: ctx.section,
        imageKey: key,
      });
    }
    return;
  }

  /* ---- Embedded media: video players and interactive samples ---- */
  if (tag === 'iframe' || tag === 'video') {
    if (!ctx.pageUrl) return;

    const raw =
      el.getAttribute('src') ??
      el.getAttribute('data-src') ??
      el.querySelector('source')?.getAttribute('src') ??
      '';
    if (!raw) return;

    let src: string;
    try {
      const resolved = new URL(raw, ctx.pageUrl);
      /*
       * Imported markup is untrusted. Only http(s) media is kept, so a crafted
       * `javascript:` or `data:` source in a book can never reach the reader
       * and become a live link or a navigation target.
       */
      if (!/^https?:$/.test(resolved.protocol)) return;
      src = resolved.toString();
    } catch {
      return;
    }

    // A bare <video> is real media; an <iframe> only counts if it hosts one.
    if (tag === 'iframe' && !EMBED_HOSTS.test(src)) return;

    ctx.blocks.push({
      kind: 'embed',
      text: (el.getAttribute('title') ?? el.getAttribute('aria-label') ?? '').trim(),
      section: ctx.section,
      src,
    });
    return;
  }

  if (isAnnotation(el)) {
    const note = stripLinkMarkers(textOf(el)).replace(/\s+/g, ' ').trim();
    const last = ctx.blocks[ctx.blocks.length - 1];
    if (note && last && (last.kind === 'code' || last.kind === 'image')) {
      last.note = last.note ? `${last.note} ${note}` : note;
    }
    return;
  }

  if (HEADING_TAGS.has(tag)) {
    const heading = textOf(el).replace(/\s+/g, ' ').trim();
    if (heading) {
      // An h5/h6 straight after a figure is that figure's caption.
      const last = ctx.blocks[ctx.blocks.length - 1];
      if (last?.kind === 'image' && !last.text && (tag === 'h5' || tag === 'h6')) {
        last.text = heading;
        return;
      }
      if (tag === 'h1' || tag === 'h2' || tag === 'h3') ctx.section = stripLinkMarkers(heading);
      ctx.blocks.push({ kind: 'heading', text: heading, section: ctx.section });
      return;
    }
    return;
  }

  if (PROSE_TAGS.has(tag)) {
    // A paragraph can still wrap a figure or an inline listing.
    const nested = el.querySelectorAll('img, pre');
    if (nested.length) {
      for (const child of el.childNodes) walk(child, ctx);
      return;
    }
    const text = textOf(el).replace(/\s+/g, ' ').trim();
    if (text) ctx.blocks.push({ kind: 'prose', text, section: ctx.section });
    return;
  }

  for (const child of el.childNodes) walk(child, ctx);
}

export function htmlToBlocks(
  html: string,
  section: string | null,
  resolveImage: (src: string) => string | null,
  /** Web imports pass the page URL, which turns on links and media embeds. */
  pageUrl?: string
): { blocks: RawBlock[]; section: string | null } {
  const root = parseHtml(html, { blockTextElements: { script: false, style: false, pre: true } });
  const body = root.querySelector('body') ?? root;

  if (pageUrl) markLinks(body as HTMLElement, pageUrl);

  const ctx: WalkContext = { blocks: [], section, resolveImage, pageUrl };
  for (const child of body.childNodes) walk(child, ctx);
  return { blocks: ctx.blocks, section: ctx.section };
}

/* ------------------------------------------------------------------ *
 * EPUB
 * ------------------------------------------------------------------ */

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

export function titleFromFilename(name: string): string {
  return path
    .basename(name, path.extname(name))
    .replace(/[_-]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** PNG / JPEG / GIF header sniffing, so figures can be sized before display. */
export function imageSize(buf: Buffer): { width?: number; height?: number } {
  try {
    if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf.length > 6 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i < buf.length - 9) {
        if (buf[i] !== 0xff) {
          i += 1;
          continue;
        }
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
    if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'GIF') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
  } catch {
    /* header sniffing is best effort */
  }
  return {};
}

async function parseEpub(buffer: Buffer, filename: string): Promise<ParsedBook> {
  const zip = await JSZip.loadAsync(buffer);
  const notes: string[] = [];

  const container = await zip.file('META-INF/container.xml')?.async('string');
  const opfPath =
    container?.match(/full-path="([^"]+)"/i)?.[1] ??
    Object.keys(zip.files).find((f) => f.toLowerCase().endsWith('.opf'));
  if (!opfPath) throw new Error('Not a valid EPUB — no package document found.');

  const opf = await zip.file(opfPath)!.async('string');
  const opfDir = path.posix.dirname(opfPath);
  const resolveFromOpf = (href: string) =>
    opfDir && opfDir !== '.' ? path.posix.normalize(path.posix.join(opfDir, href)) : href;

  const title = decodeEntities(opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1]?.trim() ?? '');
  const author = decodeEntities(opf.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i)?.[1]?.trim() ?? '');

  // manifest: id -> { href, mediaType }
  const manifest = new Map<string, { href: string; mediaType: string }>();
  for (const item of opf.match(/<item\b[^>]*>/gi) ?? []) {
    const id = item.match(/\bid=["']([^"']+)["']/i)?.[1];
    const href = item.match(/\bhref=["']([^"']+)["']/i)?.[1];
    const mediaType = item.match(/\bmedia-type=["']([^"']+)["']/i)?.[1] ?? '';
    if (id && href) manifest.set(id, { href: decodeURIComponent(href), mediaType });
  }

  const spine = (opf.match(/<itemref\b[^>]*>/gi) ?? [])
    .map((ref) => ref.match(/\bidref=["']([^"']+)["']/i)?.[1])
    .filter((id): id is string => Boolean(id))
    .map((id) => manifest.get(id)?.href)
    .filter((href): href is string => Boolean(href) && /\.x?html?$/i.test(href ?? ''));

  const docs = spine.length
    ? spine.map(resolveFromOpf)
    : Object.keys(zip.files)
        .filter((f) => /\.x?html?$/i.test(f))
        .sort();

  if (!spine.length) notes.push('No spine found — chapters were ordered by filename.');

  /* --- images ------------------------------------------------------ */

  const images = new Map<string, ExtractedImage>();

  /** Load a zip image by absolute-in-zip path, memoised into `images`. */
  const loadImage = async (zipPath: string): Promise<string | null> => {
    const normalized = path.posix.normalize(zipPath).replace(/^\/+/, '');
    if (images.has(normalized)) return normalized;

    const file = zip.file(normalized) ?? zip.file(decodeURIComponent(normalized));
    if (!file) return null;

    const ext = path.extname(normalized).toLowerCase();
    const mime = MIME_BY_EXT[ext];
    if (!mime) return null;

    const data = await file.async('nodebuffer');
    if (!data.length) return null;

    images.set(normalized, { data, mime, ...imageSize(data) });
    return normalized;
  };

  // Pre-load every image in the manifest so resolution during the walk is sync.
  for (const { href, mediaType } of manifest.values()) {
    if (mediaType.startsWith('image/') || MIME_BY_EXT[path.extname(href).toLowerCase()]) {
      await loadImage(resolveFromOpf(href));
    }
  }

  const coverId = opf.match(/<meta\b[^>]*name=["']cover["'][^>]*content=["']([^"']+)["']/i)?.[1];
  const coverHref = coverId ? manifest.get(coverId)?.href : undefined;
  const coverKey = coverHref ? path.posix.normalize(resolveFromOpf(coverHref)) : undefined;

  /* --- documents --------------------------------------------------- */

  const blocks: RawBlock[] = [];
  let section: string | null = null;

  for (const docPath of docs) {
    const file = zip.file(docPath) ?? zip.file(decodeURIComponent(docPath));
    if (!file) continue;

    const html = await file.async('string');
    if ((html.match(/<body[\s\S]*<\/body>/i)?.[0] ?? html).replace(/<[^>]+>|\s/g, '').length < 40) {
      continue; // covers, nav documents, blank pages
    }

    const docDir = path.posix.dirname(docPath);
    const result = htmlToBlocks(html, section, (src) => {
      if (/^(https?:|data:)/i.test(src)) return null;
      const clean = decodeURIComponent(src.split('#')[0]);
      const candidates = [
        path.posix.normalize(path.posix.join(docDir, clean)),
        path.posix.normalize(clean.replace(/^\/+/, '')),
        path.posix.normalize(resolveFromOpf(clean)),
      ];
      return candidates.find((c) => images.has(c)) ?? null;
    });

    section = result.section;
    blocks.push(...result.blocks);
  }

  if (!blocks.length) throw new Error('No readable text found in this EPUB.');

  // Cover art is shown on the library card, not typed as a figure.
  const filtered = coverKey ? blocks.filter((b) => b.imageKey !== coverKey) : blocks;

  return {
    title: title || titleFromFilename(filename),
    author: author || 'Unknown',
    format: 'epub',
    blocks: filtered,
    images,
    coverKey: coverKey && images.has(coverKey) ? coverKey : undefined,
    notes,
  };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

/* ------------------------------------------------------------------ *
 * PDF
 * ------------------------------------------------------------------ */

/**
 * PDFs carry no structure — only glyphs at coordinates. Text order is
 * reconstructed per page, and embedded raster images are pulled out and placed
 * at the end of the page they appear on. Indentation and listing boundaries are
 * unreliable, so EPUB is always the better source when both exist.
 */
async function parsePdf(buffer: Buffer, filename: string): Promise<ParsedBook> {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  const notes: string[] = [
    'PDF has no structure for code listings, so indentation and listing boundaries are approximate. Import the EPUB when you have one.',
  ];

  try {
    const info = await parser.getInfo();
    const textResult = await parser.getText({ pageJoiner: '' });

    const images = new Map<string, ExtractedImage>();
    const byPage = new Map<number, string[]>();

    try {
      const imageResult = await parser.getImage({ imageDataUrl: false, imageThreshold: 100 });
      for (const page of imageResult.pages) {
        for (const image of page.images) {
          if (!image.data?.length) continue;
          const key = `p${page.pageNumber}-${image.name}.png`;
          const data = Buffer.from(image.data);
          images.set(key, { data, mime: 'image/png', width: image.width, height: image.height });
          byPage.set(page.pageNumber, [...(byPage.get(page.pageNumber) ?? []), key]);
        }
      }
    } catch {
      notes.push('Embedded images could not be read from this PDF.');
    }

    const blocks: RawBlock[] = [];
    let section: string | null = null;

    for (const page of textResult.pages) {
      for (const paragraph of splitPdfPage(page.text)) {
        if (paragraph.kind === 'code') {
          const code = normalizeCode(paragraph.text);
          if (code) blocks.push({ kind: 'code', text: code, section, lang: detectLang(code) });
          continue;
        }
        const text = paragraph.text.replace(/\s+/g, ' ').trim();
        if (!text) continue;
        if (paragraph.kind === 'heading') {
          section = text;
          blocks.push({ kind: 'heading', text, section });
        } else {
          blocks.push({ kind: 'prose', text, section });
        }
      }

      for (const key of byPage.get(page.num) ?? []) {
        blocks.push({ kind: 'image', text: '', section, imageKey: key });
      }
    }

    if (!blocks.length) {
      throw new Error(
        'No selectable text in this PDF — it is probably a scan. Convert it to EPUB or TXT first.'
      );
    }

    return {
      title: info.info?.Title?.trim() || titleFromFilename(filename),
      author: info.info?.Author?.trim() || 'Unknown',
      format: 'pdf',
      blocks,
      images,
      notes,
    };
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

/** Heuristics for recovering paragraphs, headings, and listings from PDF text. */
function splitPdfPage(pageText: string): { kind: 'prose' | 'code' | 'heading'; text: string }[] {
  const lines = pageText.replace(/\r\n?/g, '\n').split('\n');
  const out: { kind: 'prose' | 'code' | 'heading'; text: string }[] = [];

  let buffer: string[] = [];
  let mode: 'prose' | 'code' = 'prose';

  const flush = () => {
    if (!buffer.length) return;
    const text = mode === 'code' ? buffer.join('\n') : buffer.join(' ');
    if (text.trim()) out.push({ kind: mode, text });
    buffer = [];
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');

    if (!line.trim()) {
      flush();
      continue;
    }

    // "2.2.4 Diving into Semantic Kernel" or an ALL-CAPS run.
    if (/^\d+(\.\d+)+\s+\S/.test(line) || (/^[A-Z0-9 ,'’&:-]{8,70}$/.test(line) && !/[.?!]$/.test(line))) {
      flush();
      out.push({ kind: 'heading', text: line.trim() });
      mode = 'prose';
      continue;
    }

    const looksLikeCode =
      /\t/.test(raw) ||
      /^ {2,}\S/.test(raw) ||
      /[{};]\s*$/.test(line) ||
      /^\s*(using|namespace|public|private|internal|var|const|await|return|import|from|def|class|function|dotnet|npm|git|docker|setx|export)\b/.test(
        line
      ) ||
      /^#[A-Z]\b/.test(line.trim());

    if (looksLikeCode !== (mode === 'code')) {
      flush();
      mode = looksLikeCode ? 'code' : 'prose';
    }

    buffer.push(mode === 'code' ? raw : line.trim());
  }

  flush();
  return out;
}

/* ------------------------------------------------------------------ *
 * Plain text and Markdown
 * ------------------------------------------------------------------ */

function parsePlainText(buffer: Buffer, filename: string): ParsedBook {
  const ext = path.extname(filename).toLowerCase().replace('.', '') || 'txt';
  let text = buffer.toString('utf8').replace(/\r\n?/g, '\n');

  // Strip Project Gutenberg boilerplate when present.
  const start = text.match(/\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^*]*\*\*\*/i);
  const end = text.match(/\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^*]*\*\*\*/i);
  const header = text.slice(0, start?.index ?? 0);
  if (start?.index !== undefined) text = text.slice(start.index + start[0].length);
  if (end?.index !== undefined) {
    const cut = text.indexOf(end[0]);
    if (cut > 0) text = text.slice(0, cut);
  }

  const isMarkdown = ext === 'md' || ext === 'markdown';
  const blocks: RawBlock[] = [];
  let section: string | null = null;

  if (isMarkdown) {
    // Fenced code first, so the fences are never treated as prose.
    const parts = text.split(/^(```|~~~)[ \t]*([\w+#-]*)[ \t]*$/m);
    let i = 0;
    while (i < parts.length) {
      const prose = parts[i] ?? '';
      pushMarkdownProse(prose, blocks, () => section, (s) => (section = s));
      const fence = parts[i + 1];
      if (!fence) break;
      const lang = (parts[i + 2] || '').toLowerCase() || null;
      const body = parts[i + 3] ?? '';
      // Everything up to the closing fence is code; the rest re-enters prose.
      const close = body.search(new RegExp(`^${fence}\\s*$`, 'm'));
      const code = normalizeCode(close >= 0 ? body.slice(0, close) : body);
      if (code) blocks.push({ kind: 'code', text: code, section, lang: lang ?? detectLang(code) });
      const rest = close >= 0 ? body.slice(close).replace(/^.*\n?/, '') : '';
      parts[i + 3] = rest;
      i += 3;
    }
  } else {
    for (const paragraph of text.split(/\n{2,}/)) {
      const indented = /^(?: {4,}|\t)/.test(paragraph);
      if (indented) {
        const code = normalizeCode(paragraph);
        if (code) blocks.push({ kind: 'code', text: code, section, lang: detectLang(code) });
      } else {
        const line = paragraph.replace(/\s+/g, ' ').trim();
        if (line) blocks.push({ kind: 'prose', text: line, section });
      }
    }
  }

  if (!blocks.length) throw new Error('That file produced no typeable text.');

  return {
    title: header.match(/^Title:\s*(.+)$/im)?.[1]?.trim() || titleFromFilename(filename),
    author: header.match(/^Author:\s*(.+)$/im)?.[1]?.trim() || 'Unknown',
    format: isMarkdown ? 'md' : 'txt',
    blocks,
    images: new Map(),
    notes: [],
  };
}

function pushMarkdownProse(
  chunk: string,
  blocks: RawBlock[],
  getSection: () => string | null,
  setSection: (s: string) => void
): void {
  for (const paragraph of chunk.split(/\n{2,}/)) {
    const heading = paragraph.match(/^(#{1,6})\s+(.+)$/m);
    if (heading && paragraph.trim().startsWith('#')) {
      const text = inlineMarkdown(heading[2]);
      if (heading[1].length <= 3) setSection(text);
      if (text) blocks.push({ kind: 'heading', text, section: getSection() });
      continue;
    }

    const text = inlineMarkdown(paragraph).replace(/\s+/g, ' ').trim();
    if (text) blocks.push({ kind: 'prose', text, section: getSection() });
  }
}

function inlineMarkdown(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^#{1,6}\s+/gm, '');
}

/* ------------------------------------------------------------------ *
 * Standalone HTML
 * ------------------------------------------------------------------ */

function parseHtmlFile(buffer: Buffer, filename: string): ParsedBook {
  const html = buffer.toString('utf8');
  const { blocks } = htmlToBlocks(html, null, () => null); // external images are not fetched
  if (!blocks.length) throw new Error('No readable text found in that HTML file.');

  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
  return {
    title: decodeEntities(title || '') || titleFromFilename(filename),
    author: 'Unknown',
    format: 'html',
    blocks,
    images: new Map(),
    notes: html.includes('<img') ? ['Images in a standalone HTML file are not imported — use EPUB.'] : [],
  };
}

/* ------------------------------------------------------------------ *
 * Entry points
 * ------------------------------------------------------------------ */

export const SUPPORTED_EXTENSIONS = ['.txt', '.md', '.markdown', '.epub', '.pdf', '.html', '.htm'];

export async function parseFile(buffer: Buffer, filename: string): Promise<ParsedBook> {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.epub') return parseEpub(buffer, filename);
  if (ext === '.pdf') return parsePdf(buffer, filename);
  if (ext === '.html' || ext === '.htm') return parseHtmlFile(buffer, filename);
  if (SUPPORTED_EXTENSIONS.includes(ext)) return parsePlainText(buffer, filename);
  throw new Error(`Unsupported file type "${ext || filename}". Use EPUB, PDF, HTML, MD, or TXT.`);
}

/**
 * Final pass: split long prose into typing-sized runs, leave code blocks whole,
 * and drop noise. Code and image blocks are never merged or divided.
 */
export function finalizeBlocks(parsed: ParsedBook, options: ImportOptions): RawBlock[] {
  const out: RawBlock[] = [];
  /** Last detected language, used to label unlabelled sibling listings. */
  let lastLang: string | null = null;
  let lastSection: string | null = null;

  for (const block of attachCaptions(dropDecorativeImages(parsed))) {
    if (block.kind === 'code') {
      if (block.text.trim().length >= 2) {
        // A short fragment inherits the language of the listing it sits beside.
        if (block.section !== lastSection) lastLang = null;
        const lang = block.lang ?? (block.text.length < 120 ? lastLang : null);
        if (block.lang) lastLang = block.lang;
        lastSection = block.section;

        out.push({
          ...block,
          lang,
          label: block.label ? normalizeProse(block.label, options.normalizePunctuation) : null,
          note: block.note ? normalizeProse(block.note, options.normalizePunctuation) : null,
        });
      }
      continue;
    }

    // Figures and embeds are shown, not typed, so their captions carry no links.
    if (block.kind === 'image' || block.kind === 'embed') {
      const caption = (text: string | null | undefined) =>
        text ? normalizeProse(stripLinkMarkers(text), options.normalizePunctuation) : null;

      out.push({
        ...block,
        text: caption(block.text) ?? '',
        label: caption(block.label),
        note: caption(block.note),
      });
      continue;
    }

    const normalized = normalizeProse(block.text, options.normalizePunctuation);
    if (stripLinkMarkers(normalized).trim().length < 2) continue;

    if (block.kind === 'heading') {
      const { text, links } = readLinkMarkers(normalized);
      out.push({ ...block, text, links: links.length ? links : undefined });
      continue;
    }

    /*
     * Prose blocks are imported whole — no sentence chunking — so a paragraph
     * in the source stays a paragraph in Typewright. Long paragraphs make for
     * long typing runs, but they preserve the reader's mental model of the page.
     */
    const { text, links } = readLinkMarkers(normalized);
    if (text.trim().length < 2) continue;
    out.push({ kind: 'prose', text, section: block.section, links: links.length ? links : undefined });
  }

  if (!out.length) throw new Error('That file produced no typeable text.');
  return out;
}

/**
 * Publishers title their listings and figures with a heading next to the block:
 * "Listing 10.1 PersistentRemoveEmail" before a <pre>, "Figure 2.1 ..." after an
 * <img>. Those headings are captions, not sections — fold them into the block
 * they describe so they are shown rather than typed.
 */
const CAPTION_RE = /^(listing|figure|table|example|algorithm)\s+[\dA-Z]+([.:]\d+)*\b/i;

/**
 * Publisher logos, rules, and icons are markup furniture, not figures. Anything
 * small in both dimensions, or named like a logo, is dropped from the reading
 * flow so it never interrupts a chapter.
 */
const LOGO_NAME_RE = /(logo|manning_m|publisher|colophon|icon|spacer|bullet|rule|badge|banner)/i;

function dropDecorativeImages(parsed: ParsedBook): RawBlock[] {
  return parsed.blocks.filter((block) => {
    if (block.kind !== 'image' || !block.imageKey) return true;

    if (LOGO_NAME_RE.test(block.imageKey)) return false;

    const image = parsed.images.get(block.imageKey);
    if (!image) return false;

    const { width, height } = image;
    if (width && height && Math.max(width, height) < 220) return false;
    if (image.data.length < 6 * 1024) return false;

    return true;
  });
}

function attachCaptions(blocks: RawBlock[]): RawBlock[] {
  const out: RawBlock[] = [];

  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];

    if (block.kind === 'heading' && CAPTION_RE.test(block.text.trim())) {
      const next = blocks[i + 1];
      if (next && (next.kind === 'code' || next.kind === 'image') && !next.label) {
        next.label = block.text.trim();
        continue;
      }
      const previous = out[out.length - 1];
      if (previous && (previous.kind === 'code' || previous.kind === 'image') && !previous.label) {
        previous.label = block.text.trim();
        continue;
      }
    }

    out.push(block);
  }

  return out;
}
