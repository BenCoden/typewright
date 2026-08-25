import crypto from 'node:crypto';
import path from 'node:path';
import { parse as parseHtml, type HTMLElement } from 'node-html-parser';
import {
  LINK_OPEN,
  detectLang,
  htmlToBlocks,
  imageSize,
  markLink,
  normalizeCode,
  stripLinkMarkers,
} from './import';
import type { ExtractedImage, ParsedBook, RawBlock } from './import';
import type { TocEntry } from '@shared/schema';

/**
 * Importing documentation pages and wikis from a URL.
 *
 * A page is routed to the adapter that can give the highest-fidelity source:
 *
 *   git-markdown — the page tells us where its Markdown source lives, so we
 *                  read that instead of the rendered HTML. Code fences and
 *                  headings arrive exactly as the author wrote them.
 *   wiki         — MediaWiki's API returns clean article HTML with no chrome.
 *   readable     — server-rendered HTML, reduced to its main content element.
 *   rendered     — last resort: ask the optional renderer service to run the
 *                  page's JavaScript first, then treat the result as readable.
 *
 * This is the only part of the app that touches the network. Once a page is
 * imported, its text and images are on disk and it never needs the network
 * again unless you explicitly check for updates.
 */

const USER_AGENT =
  'Typewright/1.0 (local typing practice; +https://github.com/typewright) Mozilla/5.0 compatible';

const FETCH_TIMEOUT_MS = 20_000;
/** Guards against a mis-parsed page pulling down something enormous. */
const MAX_BYTES = 12 * 1024 * 1024;

/** Set TYPEWRIGHT_RENDERER to the optional headless-Chromium sidecar. */
const RENDERER_URL = process.env.TYPEWRIGHT_RENDERER || '';

export interface WebPage extends ParsedBook {
  /** The URL the user asked for, normalised. */
  sourceUrl: string;
  /** The source actually parsed — raw Markdown, wiki API, or the page itself. */
  upstreamUrl: string | null;
  adapter: 'git-markdown' | 'wiki' | 'readable' | 'rendered';
  contentHash: string;
  /** The documentation set this page belongs to. */
  collection: { title: string; site: string; homeUrl: string; rootUrl: string; toc: TocEntry[] };
}

/* ------------------------------------------------------------------ *
 * Fetching
 * ------------------------------------------------------------------ */

async function request(url: string, accept: string): Promise<Response> {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'User-Agent': USER_AGENT, Accept: accept },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  return response;
}

async function fetchText(url: string, accept = 'text/html,text/plain,*/*'): Promise<string> {
  const response = await request(url, accept);
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > MAX_BYTES) throw new Error('That page is too large to import.');
  return response.text();
}

async function fetchJson<T>(url: string): Promise<T> {
  return JSON.parse(await fetchText(url, 'application/json')) as T;
}

async function fetchBinary(url: string): Promise<Buffer | null> {
  try {
    const response = await request(url, 'image/*');
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.length && buffer.length < MAX_BYTES ? buffer : null;
  } catch {
    return null; // a missing figure must never fail the whole import
  }
}

export function normalizeUrl(input: string): string {
  const url = new URL(input.trim());
  if (!/^https?:$/.test(url.protocol)) throw new Error('Only http and https URLs can be imported.');

  url.hash = '';
  // Tracking parameters would fragment the "already imported?" lookup.
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|WT\.|ocid$|wt\.)/i.test(key)) url.searchParams.delete(key);
  }
  return url.toString();
}

const hash = (text: string) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 32);

/* ------------------------------------------------------------------ *
 * Markdown -> blocks
 *
 * Docs Markdown is not plain Markdown: Microsoft Learn and friends add
 * directives for listings, figures, alerts, and includes. Those carry the code
 * and the diagrams, so they have to be understood rather than stripped.
 * ------------------------------------------------------------------ */

interface MarkdownContext {
  /** Resolves a repo-relative path (image or snippet) to an absolute raw URL. */
  resolve: (relative: string) => string | null;
  images: Map<string, ExtractedImage>;
  notes: string[];
  /** The published page URL, used to turn source-relative links into site links. */
  pageUrl: string;
}

/** Pulls `#region NAME ... #endregion` out of a snippet file. */
function extractRegion(source: string, id: string): string {
  const patterns = [
    new RegExp(`^[^\\n]*#region\\s+${escapeRegex(id)}\\s*$([\\s\\S]*?)^[^\\n]*#endregion`, 'm'),
    new RegExp(`<${escapeRegex(id)}>([\\s\\S]*?)</${escapeRegex(id)}>`),
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) return match[1];
  }
  return source;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Trims a snippet file down to the lines a `range` attribute asked for. */
function applyRange(source: string, range: string): string {
  const lines = source.split('\n');
  const kept: string[] = [];

  for (const part of range.split(',')) {
    const [from, to] = part.split('-').map((n) => Number(n.trim()));
    if (!Number.isFinite(from)) continue;
    kept.push(...lines.slice(from - 1, Number.isFinite(to) ? to : from));
  }

  return kept.length ? kept.join('\n') : source;
}

async function resolveCodeDirective(
  attributes: string,
  ctx: MarkdownContext
): Promise<RawBlock | null> {
  const attr = (name: string) => attributes.match(new RegExp(`${name}="([^"]+)"`, 'i'))?.[1];
  const source = attr('source');
  const language = attr('language') ?? null;

  if (!source) return null;

  const url = ctx.resolve(source);
  if (!url) return null;

  try {
    let code = await fetchText(url, 'text/plain');
    const id = attr('id');
    const range = attr('range');
    if (id) code = extractRegion(code, id);
    else if (range) code = applyRange(code, range);

    const text = normalizeCode(code);
    if (!text) return null;

    return {
      kind: 'code',
      text,
      section: null,
      lang: language ?? detectLang(text, path.extname(source)),
      label: `Listing — ${path.basename(source)}`,
    };
  } catch {
    ctx.notes.push(`Could not fetch the snippet ${source}.`);
    return null;
  }
}

async function resolveImageDirective(
  attributes: string,
  ctx: MarkdownContext
): Promise<RawBlock | null> {
  const attr = (name: string) => attributes.match(new RegExp(`${name}="([^"]+)"`, 'i'))?.[1];
  const source = attr('source');
  if (!source) return null;

  const key = await downloadImage(source, ctx);
  if (!key) return null;

  return {
    kind: 'image',
    text: attr('alt-text') ?? '',
    section: null,
    imageKey: key,
  };
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

async function downloadImage(reference: string, ctx: MarkdownContext): Promise<string | null> {
  const url = /^https?:/i.test(reference) ? reference : ctx.resolve(reference);
  if (!url) return null;

  const key = path.basename(new URL(url).pathname);
  if (ctx.images.has(key)) return key;

  const ext = path.extname(key).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) return null;

  const data = await fetchBinary(url);
  if (!data) return null;

  ctx.images.set(key, { data, mime, ...imageSize(data) });
  return key;
}

/** The video id of a known player URL, when there is one. */
function videoId(src: string): { provider: 'youtube' | 'vimeo'; id: string } | null {
  try {
    const url = new URL(src);

    if (/(^|\.)youtu\.be$/i.test(url.hostname)) {
      const id = url.pathname.split('/').filter(Boolean)[0];
      return id ? { provider: 'youtube', id } : null;
    }
    if (/(^|\.)youtube(-nocookie)?\.com$/i.test(url.hostname)) {
      const id = url.pathname.match(/\/embed\/([\w-]+)/)?.[1] ?? url.searchParams.get('v');
      return id ? { provider: 'youtube', id } : null;
    }
    if (/(^|\.)vimeo\.com$/i.test(url.hostname)) {
      const id = url.pathname.split('/').filter(Boolean).pop();
      return id && /^\d+$/.test(id) ? { provider: 'vimeo', id } : null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Fetches a poster frame and a real title for an embedded video.
 *
 * The poster is stored with the page like any other figure, so the block looks
 * like a video before anything is loaded from the network, and the caption says
 * what the video is rather than "YouTube video". oEmbed is a documented endpoint
 * on both providers and needs no key.
 */
async function resolveEmbedPoster(
  src: string,
  ctx: MarkdownContext
): Promise<{ imageKey?: string; title?: string }> {
  const video = videoId(src);
  if (!video) return {};

  const endpoint =
    video.provider === 'youtube'
      ? `https://www.youtube.com/oembed?url=${encodeURIComponent(
          `https://www.youtube.com/watch?v=${video.id}`
        )}&format=json`
      : `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(
          `https://vimeo.com/${video.id}`
        )}`;

  let title: string | undefined;
  let thumbnail: string | undefined;

  try {
    const meta = await fetchJson<{ title?: string; thumbnail_url?: string }>(endpoint);
    title = meta.title;
    thumbnail = meta.thumbnail_url;
  } catch {
    // oEmbed is a nicety; a YouTube still can be addressed directly.
  }

  if (!thumbnail && video.provider === 'youtube') {
    thumbnail = `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`;
  }
  if (!thumbnail) return { title };

  // Poster filenames repeat across videos, so key on the id we already have.
  try {
    const key = `embed-${video.provider}-${video.id}${path.extname(new URL(thumbnail).pathname) || '.jpg'}`;
    if (!ctx.images.has(key)) {
      const data = await fetchBinary(thumbnail);
      if (!data) return { title };
      ctx.images.set(key, { data, mime: MIME_BY_EXT[path.extname(key).toLowerCase()] ?? 'image/jpeg', ...imageSize(data) });
    }
    return { imageKey: key, title };
  } catch {
    return { title };
  }
}

/**
 * Walks docs-flavoured Markdown into blocks. Deliberately line-oriented rather
 * than a full Markdown parser: we only need prose, headings, listings, and
 * figures, and the directives are line-level anyway.
 */
async function markdownToBlocks(markdown: string, ctx: MarkdownContext): Promise<RawBlock[]> {
  // Strip YAML front matter.
  let text = markdown.replace(/^---\n[\s\S]*?\n---\n/, '');

  /*
   * Unwrap blockquotes. Docs sets use them for notes and tips whose bodies are
   * ordinary prose and code fences, and leaving the "> " prefix on hides those
   * fences from the fence matcher below.
   */
  text = text
    .split('\n')
    .map((line) => line.replace(/^\s{0,3}>\s?/, ''))
    .filter((line) => !/^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION|INCLUDE.*)\]\s*$/i.test(line))
    .join('\n');

  const out: RawBlock[] = [];
  const lines = text.split('\n');
  let section: string | null = null;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    const joined = inlineMarkdown(paragraph.join(' '), ctx.pageUrl).replace(/\s+/g, ' ').trim();
    if (joined) out.push({ kind: 'prose', text: joined, section });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    /* ---- fenced code ---- */
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+#-]*)/);
    if (fence) {
      flushParagraph();
      const closing = new RegExp(`^\\s*${fence[1][0]}{3,}\\s*$`);
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !closing.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      const code = normalizeCode(body.join('\n'));
      if (code) {
        out.push({
          kind: 'code',
          text: code,
          section,
          lang: fence[2].toLowerCase() || detectLang(code),
        });
      }
      continue;
    }

    /* ---- :::code / :::image / other triple-colon directives ---- */
    const directive = line.match(/^\s*:::(\w[\w-]*)\s*([^:]*)(:::)?\s*$/);
    if (directive) {
      flushParagraph();
      const [, name, attributes] = directive;

      if (name === 'code') {
        const block = await resolveCodeDirective(attributes, ctx);
        if (block) out.push({ ...block, section });
        continue;
      }
      if (name === 'image') {
        const block = await resolveImageDirective(attributes, ctx);
        if (block) out.push({ ...block, section });
        continue;
      }
      // Wrappers such as :::zone / :::moniker / :::row carry no text of their own.
      continue;
    }

    /* ---- headings ---- */
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      const title = inlineMarkdown(heading[2], ctx.pageUrl).trim();
      if (title) {
        if (heading[1].length <= 3) section = stripLinkMarkers(title);
        out.push({ kind: 'heading', text: title, section });
      }
      continue;
    }

    /* ---- alerts: "> [!NOTE]" becomes a heading plus its prose ---- */
    const alert = line.match(/^\s*>\s*\[!(\w+)\]/);
    if (alert) {
      flushParagraph();
      const label = alert[1][0] + alert[1].slice(1).toLowerCase();
      out.push({ kind: 'heading', text: label, section });
      continue;
    }

    /* ---- inline images ---- */
    const image = line.match(/^\s*!\[([^\]]*)\]\(([^)\s]+)/);
    if (image) {
      flushParagraph();
      const key = await downloadImage(image[2], ctx);
      if (key) out.push({ kind: 'image', text: image[1], section, imageKey: key });
      continue;
    }

    /* ---- an include we cannot resolve should be visible, not silent ---- */
    if (/\[!INCLUDE\s*\[/i.test(line)) {
      flushParagraph();
      continue;
    }

    /* ---- table rows and horizontal rules are structure, not prose ---- */
    if (/^\s*\|?\s*[-:]{3,}\s*\|/.test(line) || /^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushParagraph();
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      continue;
    }

    // List items and table cells are each their own thought.
    const listItem = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (listItem) {
      flushParagraph();
      const item = inlineMarkdown(listItem[1]).trim();
      if (item) out.push({ kind: 'prose', text: item, section });
      continue;
    }

    if (/^\s*\|/.test(line)) {
      flushParagraph();
      const cells = line
        .split('|')
        .map((cell) => inlineMarkdown(cell).trim())
        .filter(Boolean);
      if (cells.length) out.push({ kind: 'prose', text: cells.join(' — '), section });
      continue;
    }

    paragraph.push(line.replace(/^\s*>\s?/, ''));
  }

  flushParagraph();
  return out;
}

/** Reduces inline Markdown to the text a person would actually type. */
/** HTML tag names that actually appear inline in documentation Markdown. */
const HTML_TAG =
  /<\/?(?:a|b|i|em|strong|span|br|code|kbd|sub|sup|small|img|div|p|ul|ol|li|table|thead|tbody|tr|td|th|nobr|font|center|h[1-6])(?:\s[^>]*)?\/?>/gi;

/**
 * Turns a Markdown href into the page a reader would land on.
 *
 * Docs repositories link between source files — `../../linq/index.md` — which
 * only means something once it is mapped back onto the published site.
 */
function resolveDocLink(href: string, pageUrl: string): string | null {
  if (/^(mailto|tel|javascript):/i.test(href)) return null;

  try {
    const url = new URL(href, pageUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

    if (/(^|\.)learn\.microsoft\.com$/i.test(url.hostname)) {
      // Source paths end in .md and index files are served as a directory.
      url.pathname = url.pathname
        .replace(/\/index\.md$/i, '/')
        .replace(/\.md$/i, '')
        .replace(/\/toc\.yml$/i, '/');

      // Site-absolute links such as /ef/ are missing the locale segment.
      const locale = new URL(pageUrl).pathname.match(/^\/([a-z]{2}-[a-z]{2})\//i)?.[1];
      if (locale && !new RegExp(`^/${locale}/`, 'i').test(url.pathname)) {
        url.pathname = `/${locale}${url.pathname}`;
      }
    }

    return url.toString();
  } catch {
    return null;
  }
}

/** Marks `[text](href)` links in place while the rest of the inline syntax is removed. */
function inlineMarkdown(text: string, pageUrl?: string): string {
  /*
   * Inline code is pulled out before anything else touches the string.
   * `Task<T>` and `List<int>` look exactly like HTML tags, and stripping them
   * as markup would quietly delete the type names worth typing.
   */
  const spans: string[] = [];
  const withPlaceholders = text.replace(/`([^`]+)`/g, (_m, code: string) => {
    spans.push(code);
    return `\u0000${spans.length - 1}\u0000`;
  });

  const cleaned = withPlaceholders
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\(([^)\s]*)[^)]*\)/g, (_m, label: string, href: string) => {
      if (!pageUrl || href.startsWith('#')) return label;

      const url = resolveDocLink(href, pageUrl);
      if (!url) return label;

      return markLink(url, new URL(url).hostname === new URL(pageUrl).hostname, label);
    })
    .replace(/<xref:([^>]+)>/g, (_m, uid: string) => renderXref(uid))
    .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\s)\*([^*]+)\*/g, '$1$2')
    .replace(/(^|\s)_([^_]+)_/g, '$1$2')
    .replace(/<https?:\/\/[^>]+>/g, '')
    .replace(HTML_TAG, '')
    .replace(/&nbsp;/g, ' ');

  return cleaned.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => spans[Number(i)] ?? '');
}

/* ------------------------------------------------------------------ *
 * Adapter: git-backed documentation
 * ------------------------------------------------------------------ */

/** github.com/o/r/blob/ref/path -> raw.githubusercontent.com/o/r/ref/path */
function toRawGitHub(blobUrl: string): string | null {
  const match = blobUrl.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
  if (!match) return null;
  const [, owner, repo, ref, filePath] = match;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`;
}

function metaContent(html: string, name: string): string | null {
  const pattern = new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i');
  return html.match(pattern)?.[1] ?? null;
}

/* ------------------------------------------------------------------ *
 * Table of contents
 * ------------------------------------------------------------------ */

interface LearnTocNode {
  toc_title?: string;
  href?: string;
  children?: LearnTocNode[];
}

/**
 * Microsoft Learn publishes its sidebar as toc.json, which is far better than
 * scraping a rendered tree: real titles, real hrefs, real nesting.
 */
async function fetchLearnToc(pageUrl: string, html: string): Promise<TocEntry[]> {
  const candidates = new Set<string>();

  for (const match of html.matchAll(/["'([]([^"'()\s]*?toc\.json)["')\]]/g)) {
    candidates.add(match[1]);
  }

  for (const candidate of candidates) {
    if (/breadcrumb/i.test(candidate)) continue; // breadcrumbs are not a TOC
    try {
      const tocUrl = new URL(candidate, pageUrl).toString();
      const data = await fetchJson<{ items?: LearnTocNode[] }>(tocUrl);
      if (!data.items?.length) continue;

      const out: TocEntry[] = [];
      const walk = (nodes: LearnTocNode[], depth: number) => {
        for (const node of nodes) {
          const title = node.toc_title?.trim();
          if (title) {
            out.push({
              title,
              url: node.href ? absolutise(node.href, tocUrl) : null,
              depth,
            });
          }
          if (node.children?.length) walk(node.children, depth + 1);
        }
      };
      walk(data.items, 0);

      if (out.length) return out;
    } catch {
      // try the next candidate
    }
  }

  return [];
}

/** Resolves a TOC href, dropping anything off-site or unusable. */
function absolutise(href: string, base: string): string | null {
  try {
    if (/^(mailto:|javascript:|#)/i.test(href)) return null;
    const url = new URL(href, base);
    if (!/^https?:$/.test(url.protocol)) return null;
    // Learn TOC entries omit the trailing document; keep them as-is.
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Keeps a scraped TOC only if it looks like a documentation sidebar rather than
 * the site's top navigation. The test is whether its links live near the page
 * being imported: a docs TOC shares a path prefix with its pages, while a site
 * header points at unrelated corners of the domain.
 */
function looksLikeDocsToc(entries: TocEntry[], pageUrl: string): boolean {
  const withUrls = entries.filter((entry) => entry.url);
  if (withUrls.length < 3) return false;

  const segments = new URL(pageUrl).pathname.split('/').filter(Boolean);
  if (!segments.length) return false;

  const prefix = `/${segments[0]}/`;
  const sameArea = withUrls.filter((entry) => {
    try {
      const url = new URL(entry.url!);
      return url.hostname === new URL(pageUrl).hostname && url.pathname.startsWith(prefix);
    } catch {
      return false;
    }
  });

  return sameArea.length / withUrls.length >= 0.6;
}

/**
 * Renders a Learn cross-reference as the API name a reader would see.
 *
 * `<xref:System.Threading.Tasks.Task.Run*?displayProperty=nameWithType>` shows up
 * as "Task.Run" on the site; dropping it outright loses the subject of the
 * sentence, which is exactly the word worth typing.
 */
function renderXref(uid: string): string {
  const [rawPath, query = ''] = uid.split('?');

  const path = rawPath
    .replace(/(%2A|\*)$/i, '') // overload marker
    // Generic arity, encoded or literal: Task%601 and Task`1 both -> Task<T>.
    .replace(/(?:%60|`)(\d+)/gi, (_m, arity: string) => {
      const count = Number(arity);
      const params = count === 1 ? 'T' : Array.from({ length: count }, (_v, i) => `T${i + 1}`).join(', ');
      return `<${params}>`;
    })
    .replace(/%60/gi, '');

  if (/displayProperty=fullName/i.test(query)) return path;

  // Split on dots outside the generic argument list.
  const generic = path.match(/<.*>$/)?.[0] ?? '';
  const parts = path.slice(0, path.length - generic.length).split('.').filter(Boolean);
  if (generic) parts[parts.length - 1] += generic;

  if (!parts.length) return path;

  // nameWithType shows Type.Member; the default shows just the last segment.
  if (/displayProperty=nameWithType/i.test(query) && parts.length > 1) {
    return parts.slice(-2).join('.');
  }
  return parts[parts.length - 1];
}

/** Falls back to the page's own nav when there is no TOC feed. */
function tocFromNav(root: HTMLElement, pageUrl: string): TocEntry[] {
  /*
   * Documentation sites have several navs — a top bar, breadcrumbs, prev/next
   * links, and the sidebar that actually lists the doc set. Taking the first
   * one finds the top bar every time, so every candidate is read and the one
   * with the most links into this part of the site wins.
   */
  const candidates = [
    ...root.querySelectorAll('nav[aria-label*="sidebar" i]'),
    ...root.querySelectorAll('nav[aria-label*="ontents" i]'),
    ...root.querySelectorAll('[data-toc-container]'),
    ...root.querySelectorAll('.theme-doc-sidebar-menu'), // Docusaurus
    ...root.querySelectorAll('.md-nav--primary'), // MkDocs Material
    ...root.querySelectorAll('.wy-menu-vertical'), // Read the Docs
    ...root.querySelectorAll('.bd-sidebar'), // PyData / Sphinx book
    ...root.querySelectorAll('[class*="sidebar" i]'),
    ...root.querySelectorAll('[class*="toc" i]'),
    ...root.querySelectorAll('nav'),
    ...root.querySelectorAll('aside'),
  ];

  let best: TocEntry[] = [];
  for (const candidate of candidates) {
    const entries = tocFromContainer(candidate, pageUrl);
    if (entries.length > best.length) best = entries;
  }

  return best;
}

/** Reads one container as a table of contents, or rejects it. */
function tocFromContainer(nav: HTMLElement, pageUrl: string): TocEntry[] {
  const out: TocEntry[] = [];
  const seen = new Set<string>();

  for (const anchor of nav.querySelectorAll('a')) {
    const title = (
      anchor.textContent ||
      anchor.getAttribute('title') ||
      anchor.getAttribute('aria-label') ||
      ''
    )
      .replace(/\s+/g, ' ')
      .trim();
    const href = anchor.getAttribute('href');
    if (!title) continue;

    // Collapsible sidebars label their groups with an anchor that has no href.
    const url = href ? absolutise(href, pageUrl) : null;
    if (href && !url) continue;
    if (url) {
      if (seen.has(url)) continue;
      seen.add(url);
    }

    // Nesting depth from how deeply the anchor sits inside lists.
    let depth = 0;
    let parent = anchor.parentNode as HTMLElement | null;
    while (parent && parent !== nav) {
      if (/^(ul|ol)$/i.test(parent.rawTagName ?? '')) depth += 1;
      parent = parent.parentNode as HTMLElement | null;
    }

    out.push({ title, url, depth: Math.max(0, depth - 1) });
  }

  return looksLikeDocsToc(out, pageUrl) ? out : [];
}

/* ------------------------------------------------------------------ *
 * Adapter: readable HTML
 * ------------------------------------------------------------------ */

const CHROME_SELECTORS = [
  'nav',
  'aside',
  'header',
  'footer',
  'script',
  'style',
  'noscript',
  'form',
  'button',
  'svg',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[aria-hidden="true"]',
  '.breadcrumb',
  '.pagination',
  '.sidebar',
  '.toc',
  '.advertisement',
  '.cookie-banner',
  '[data-nosnippet]',
  'sup.mw-ref',
  'sup.reference',
  '.mw-editsection',
  '.reflist',
  '.navbox',
  '.mw-cite-backlink',
  'figure.mw-halign-right',
  'table.infobox',
  '.copy-button',
  '.visually-hidden',
  '.sr-only',
  '[class*="tableOfContents" i]',
  '.theme-doc-toc-desktop',
  '.theme-doc-toc-mobile',
  '.theme-doc-breadcrumbs',
  '.pagination-nav',
  '[class*="sidebar" i]',
  '[class*="breadcrumb" i]',
  '.hash-link',
  '.anchor-link',
  '[class*="skipToContent" i]',
];

/**
 * Repairs unquoted attribute values that end in a slash.
 *
 * Minified HTML writes `href=/docs/welcome/releases/>` — legal, but the closing
 * `/>` reads as a self-closing tag, which empties the element and throws its
 * label out as a sibling. Docusaurus sites are built this way, and it is why
 * their sidebars look like a list of untitled links.
 */
function repairUnquotedAttributes(html: string): string {
  return html.replace(/(\s[a-zA-Z][\w:-]*=)([^\s"'<>]*\/)>/g, '$1"$2">');
}

/** Parses a fetched page, working around minified-HTML quirks. */
function parseDocument(html: string) {
  return parseHtml(repairUnquotedAttributes(html), {
    blockTextElements: { script: false, style: false, pre: true },
  });
}

/** Picks the element most likely to hold the article, then strips its chrome. */
function readableContent(html: string): { element: HTMLElement; title: string } | null {
  const root = parseDocument(html);

  const candidates = [
    root.querySelector('main article'),
    root.querySelector('[data-main-column]'),
    root.querySelector('main'),
    root.querySelector('article'),
    root.querySelector('#content'),
    root.querySelector('.markdown-body'),
    root.querySelector('#mw-content-text'),
    root.querySelector('body'),
  ].filter((element): element is HTMLElement => Boolean(element));

  // The best candidate is the one with the most prose, not the first match.
  let best: HTMLElement | null = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const score = candidate.querySelectorAll('p, pre, li').length;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  if (!best || bestScore < 2) return null;

  for (const selector of CHROME_SELECTORS) {
    for (const node of best.querySelectorAll(selector)) node.remove();
  }

  const title =
    root.querySelector('h1')?.textContent.replace(/\s+/g, ' ').trim() ||
    root.querySelector('title')?.textContent.replace(/\s+/g, ' ').trim() ||
    '';

  return { element: best, title };
}

/**
 * Picks the best URL for an image element.
 *
 * Documentation sites lazy-load figures, so the useful URL is often in
 * `data-src` or the largest entry of a `srcset` rather than in `src`.
 */
function imageSource(img: HTMLElement): string | null {
  const direct = img.getAttribute('src');
  if (direct && !/^data:image\/(gif|svg)/i.test(direct)) return direct;

  const lazy =
    img.getAttribute('data-src') ??
    img.getAttribute('data-original') ??
    img.getAttribute('data-lazy-src');
  if (lazy) return lazy;

  const srcset =
    img.getAttribute('srcset') ??
    (img.parentNode as HTMLElement | null)?.querySelector?.('source')?.getAttribute('srcset');
  if (srcset) {
    // "a.png 1x, b.png 2x" or "a.png 480w, b.png 1024w" — take the widest.
    const best = srcset
      .split(',')
      .map((part) => part.trim().split(/\s+/))
      .map(([url, size]) => ({ url, weight: Number((size ?? '').replace(/[wx]$/, '')) || 1 }))
      .sort((a, b) => b.weight - a.weight)[0];
    if (best?.url) return best.url;
  }

  return direct ?? null;
}

async function blocksFromHtmlElement(
  element: HTMLElement,
  pageUrl: string,
  ctx: MarkdownContext
): Promise<{ blocks: RawBlock[] }> {
  // Download every referenced image first, so the walker can resolve them.
  const keyBySrc = new Map<string, string>();
  for (const img of element.querySelectorAll('img')) {
    const reference = imageSource(img);
    if (!reference) continue;

    // Rewrite the element so the walker and the download agree on the key.
    img.setAttribute('src', reference);

    try {
      const absolute = new URL(reference, pageUrl).toString();
      const key = await downloadImage(absolute, ctx);
      if (key) keyBySrc.set(reference, key);
    } catch {
      // skip unusable src
    }
  }

  const { blocks } = htmlToBlocks(
    element.outerHTML,
    null,
    (src) => keyBySrc.get(src) ?? null,
    pageUrl
  );

  // Embeds get a poster frame so they read as video before anything loads.
  for (const block of blocks) {
    if (block.kind !== 'embed' || !block.src) continue;

    const { imageKey, title } = await resolveEmbedPoster(block.src, ctx);
    if (imageKey) block.imageKey = imageKey;
    if (title && (!block.text || /^(youtube|vimeo)\b/i.test(block.text))) block.text = title;
  }

  return { blocks };
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

function siteName(url: string): string {
  return new URL(url).hostname.replace(/^www\./, '');
}

/**
 * A readable name for the doc set a page belongs to.
 *
 * The first top-level contents entry is the best answer when it is a real page —
 * "C# documentation". Collapsible sidebars start with a group label instead
 * ("Welcome", "Start") which changes as you move around, so those fall through
 * to the site's own name.
 */
function collectionTitle(html: string, url: string, toc: TocEntry[]): string {
  const first = toc.find((entry) => entry.depth === 0 && entry.title && entry.url);
  if (first) return first.title;

  const siteTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '';
  const trimmed = siteTitle.split(/[|\u2013\u2014]/).pop()?.trim();
  return trimmed || siteName(url);
}

/**
 * The stable identity of a doc set: the first page its contents point at, or
 * failing that the section of the site the page lives in.
 */
function collectionRoot(url: string, toc: TocEntry[]): string {
  const first = toc.find((entry) => entry.url);
  if (first?.url) return first.url.replace(/[#?].*$/, '').replace(/\/+$/, '').toLowerCase();

  // No contents to go on: group by the first path segment, e.g. /docs.
  const parsed = new URL(url);
  const segment = parsed.pathname.split('/').filter(Boolean)[0] ?? '';
  return `${parsed.origin}/${segment}`.toLowerCase();
}

/**
 * Fingerprints a page from the blocks that were extracted from it, not from its
 * raw HTML. That way "check for updates" also picks up an improvement to the
 * extractor, instead of reporting no change because the source is byte-identical
 * while the reading experience would be different.
 */
function blockHash(blocks: RawBlock[]): string {
  return hash(
    blocks.map((b) => `${b.kind}\u0000${b.src ?? ''}\u0000${b.label ?? ''}\u0000${b.text}`).join('\u0001')
  );
}

export async function importUrl(rawUrl: string): Promise<WebPage> {
  const sourceUrl = normalizeUrl(rawUrl);
  const site = siteName(sourceUrl);
  const notes: string[] = [];
  const images = new Map<string, ExtractedImage>();

  let html = await fetchText(sourceUrl);

  /* ---- 1. MediaWiki: ask the API instead of scraping ---- */
  const wiki = await tryWiki(sourceUrl, html, images, notes);
  if (wiki) return wiki;

  /* ---- 2. Git-backed docs: read the Markdown the page was built from ---- */
  const gitUrl =
    metaContent(html, 'original_content_git_url') ?? metaContent(html, 'gitcommit');
  const rawUrlForMarkdown = gitUrl ? toRawGitHub(gitUrl) : null;

  const feedToc = await fetchLearnToc(sourceUrl, html);
  const toc = feedToc.length ? feedToc : tocFromNav(parseDocument(html), sourceUrl);

  if (rawUrlForMarkdown) {
    try {
      const markdown = await fetchText(rawUrlForMarkdown, 'text/plain');
      const base = rawUrlForMarkdown.slice(0, rawUrlForMarkdown.lastIndexOf('/') + 1);

      const ctx: MarkdownContext = {
        images,
        notes,
        pageUrl: sourceUrl,
        resolve: (relative) => {
          try {
            return new URL(relative, base).toString();
          } catch {
            return null;
          }
        },
      };

      const blocks = await markdownToBlocks(markdown, ctx);
      if (blocks.length) {
        const title =
          markdown.match(/^title:\s*(.+)$/m)?.[1]?.replace(/^["']|["']$/g, '').trim() ||
          blocks.find((b) => b.kind === 'heading')?.text ||
          titleFor(sourceUrl);

        return {
          title,
          author: site,
          format: 'web',
          blocks,
          images,
          notes,
          sourceUrl,
          upstreamUrl: rawUrlForMarkdown,
          adapter: 'git-markdown',
          contentHash: blockHash(blocks),
          collection: {
            title: collectionTitle(html, sourceUrl, toc),
            site,
            homeUrl: sourceUrl,
            rootUrl: collectionRoot(sourceUrl, toc),
            toc,
          },
        };
      }
    } catch (error) {
      notes.push(
        `The Markdown source could not be read (${
          error instanceof Error ? error.message : 'unknown error'
        }); fell back to the page itself.`
      );
    }
  }

  /* ---- 3. Readable HTML, rendering first if the page came back empty ---- */
  let adapter: WebPage['adapter'] = 'readable';
  let content = readableContent(html);
  let renderReason: string | null = null;

  if (!content) {
    const rendered = await renderPage(sourceUrl);
    if (rendered.html) {
      html = rendered.html;
      adapter = 'rendered';
      content = readableContent(html);
      if (!content) renderReason = 'rendered-empty';
    } else {
      renderReason = (rendered as Extract<RenderOutcome, { html: null }>).reason;
    }
  }

  if (!content) {
    throw new Error(explainNoContent(renderReason));
  }

  const ctx: MarkdownContext = {
    images,
    notes,
    pageUrl: sourceUrl,
    resolve: (relative) => {
      try {
        return new URL(relative, sourceUrl).toString();
      } catch {
        return null;
      }
    },
  };

  const { blocks } = await blocksFromHtmlElement(content.element, sourceUrl, ctx);
  if (!blocks.length) throw new Error('That page produced no typeable text.');

  return {
    title: content.title || titleFor(sourceUrl),
    author: site,
    format: 'web',
    blocks,
    images,
    notes,
    sourceUrl,
    upstreamUrl: null,
    adapter,
    contentHash: blockHash(blocks),
    collection: {
      title: collectionTitle(html, sourceUrl, toc),
      site,
      homeUrl: sourceUrl,
      rootUrl: collectionRoot(sourceUrl, toc),
      toc,
    },
  };
}

/** Turns the reason a page could not be read into something actionable. */
function explainNoContent(reason: string | null): string {
  switch (reason) {
    case 'rendered-empty':
      return 'No article content found on that page, even after running its JavaScript. It may be a landing page rather than an article.';
    case 'unreachable':
      return 'That page needs JavaScript to render, and the renderer is not running. Start it with: docker compose --profile render up -d';
    case 'failed':
      return 'That page needs JavaScript to render, and the renderer could not load it.';
    default:
      return 'That page has no readable article in its HTML — it needs JavaScript to render. Enable the optional renderer with: docker compose --profile render up -d';
  }
}

function titleFor(url: string): string {
  const last = new URL(url).pathname.replace(/\/+$/, '').split('/').pop() ?? '';
  return last.replace(/[-_]+/g, ' ').replace(/\.\w+$/, '').trim() || siteName(url);
}

/* ------------------------------------------------------------------ *
 * MediaWiki
 * ------------------------------------------------------------------ */

async function tryWiki(
  sourceUrl: string,
  html: string,
  images: Map<string, ExtractedImage>,
  notes: string[]
): Promise<WebPage | null> {
  // Detect MediaWiki from its own generator tag rather than guessing from URLs.
  if (!/<meta\s+name="generator"\s+content="MediaWiki/i.test(html)) return null;

  const url = new URL(sourceUrl);
  const match = url.pathname.match(/\/wiki\/(.+)$/);
  if (!match) return null;

  const titleSlug = match[1];
  const apiUrl = `${url.origin}/api/rest_v1/page/html/${encodeURIComponent(
    decodeURIComponent(titleSlug)
  )}`;

  try {
    const articleHtml = await fetchText(apiUrl, 'text/html');
    const content = readableContent(articleHtml);
    if (!content) return null;

    const ctx: MarkdownContext = {
      images,
      notes,
      pageUrl: sourceUrl,
      resolve: (relative) => {
        try {
          return new URL(relative, sourceUrl).toString();
        } catch {
          return null;
        }
      },
    };

    const { blocks } = await blocksFromHtmlElement(content.element, sourceUrl, ctx);
    if (!blocks.length) return null;

    const site = siteName(sourceUrl);
    return {
      title: content.title || decodeURIComponent(titleSlug).replace(/_/g, ' '),
      author: site,
      format: 'web',
      blocks,
      images,
      notes,
      sourceUrl,
      upstreamUrl: apiUrl,
      adapter: 'wiki',
      contentHash: blockHash(blocks),
      collection: {
        title: site,
        site,
        homeUrl: `${url.origin}/wiki/`,
        rootUrl: `${url.origin}/wiki`.toLowerCase(),
        // A wiki has no linear TOC; navigation comes from its own links.
        toc: [],
      },
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Optional renderer sidecar
 * ------------------------------------------------------------------ */

type RenderOutcome =
  | { html: string }
  | { html: null; reason: 'not-configured' | 'unreachable' | 'failed' };

async function renderPage(url: string): Promise<RenderOutcome> {
  if (!RENDERER_URL) return { html: null, reason: 'not-configured' };

  try {
    const response = await fetch(`${RENDERER_URL.replace(/\/+$/, '')}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(90_000),
    });

    if (!response.ok) return { html: null, reason: 'failed' };

    const payload = (await response.json()) as { html?: string };
    return payload.html ? { html: payload.html } : { html: null, reason: 'failed' };
  } catch {
    // Configured but not answering: the profile is almost certainly not running.
    return { html: null, reason: 'unreachable' };
  }
}

/** Whether the sidecar is configured and currently answering. */
export async function rendererStatus(): Promise<{ configured: boolean; reachable: boolean }> {
  if (!RENDERER_URL) return { configured: false, reachable: false };

  try {
    const response = await fetch(`${RENDERER_URL.replace(/\/+$/, '')}/health`, {
      signal: AbortSignal.timeout(2500),
    });
    return { configured: true, reachable: response.ok };
  } catch {
    return { configured: true, reachable: false };
  }
}
