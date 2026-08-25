import { memo, useState } from 'react';
import { ImageOff, Play } from 'lucide-react';
import { assetUrl } from '@/lib/queryClient';
import { cn } from '@/lib/utils';
import type { BlockState } from '@/lib/typing';
import type { BlockLink, BlockView } from '@shared/schema';

/**
 * The reading surface.
 *
 * Blocks are rendered in source order — prose, listings, and figures — so the
 * chapter reads like the book while you type through it. Figures stay on screen
 * above the cursor, which is the whole point of typing a technical book rather
 * than a novel.
 */

export type BlockMode = 'done' | 'active' | 'ahead';

interface BlockProps {
  block: BlockView;
  mode: BlockMode;
  /** Present only for the active block. */
  state?: BlockState;
  fontSize: number;
  /** Overrides the default prose leading — reading mode sets its own. */
  lineHeight?: number;
  /** 'serif' | 'sans' — prose only; code is always monospace. */
  typeface: string;
  /** Underline the whole word on a mistake, not just the missed character. */
  markIncorrectWords?: boolean;
  /** Draw the ⏎ marker at the end of each line inside a listing. */
  showNewlines?: boolean;
}

/* ------------------------------------------------------------------ *
 * Characters
 * ------------------------------------------------------------------ */

const STATUS_CLASS = {
  pending: 'tw-char-pending',
  correct: 'tw-char-correct',
  wrong: 'tw-char-wrong',
  skipped: 'tw-char-skipped',
} as const;

/** Character indexes covered by a link, so the linked words can be marked. */
function linkedChars(links: BlockLink[] | undefined, length: number): Set<number> | null {
  if (!links?.length) return null;

  const marked = new Set<number>();
  for (const link of links) {
    for (let i = Math.max(0, link.start); i < Math.min(length, link.end); i += 1) marked.add(i);
  }
  return marked.size ? marked : null;
}

const CharRun = memo(function CharRun({
  state,
  showNewlines,
  markIncorrectWords,
  links,
}: {
  state: BlockState;
  showNewlines: boolean;
  markIncorrectWords?: boolean;
  links?: BlockLink[];
}) {
  const chars = [...state.expected];
  const linked = linkedChars(links, chars.length);

  // When on, every character sharing a word with a mistake is underlined,
  // not just the missed one — easier to spot at a glance.
  const wordHasError = new Set<number>();
  if (markIncorrectWords) {
    let wordStart = 0;
    let sawError = false;
    for (let i = 0; i <= chars.length; i += 1) {
      const boundary = i === chars.length || /\s/.test(chars[i]);
      if (boundary) {
        if (sawError) for (let j = wordStart; j < i; j += 1) wordHasError.add(j);
        wordStart = i + 1;
        sawError = false;
      } else if (state.status[i] === 'wrong') {
        sawError = true;
      }
    }
  }

  return (
    <>
      {chars.map((char, i) => {
        const isNewline = char === '\n';
        const status = state.status[i];
        const current = i === state.pos;

        // A wrong space or newline needs a visible body to show the error.
        const showAsError = status === 'wrong' && (char === ' ' || isNewline);
        const wordUnderline = markIncorrectWords && wordHasError.has(i) && status !== 'wrong';

        // The return glyph is drawn before the break so it ends the line it
        // belongs to, and stays out of the caret's ::before slot.
        const body =
          isNewline && showNewlines ? (
            <>
              <span className="opacity-30">{'\u23CE'}</span>
              {'\n'}
            </>
          ) : isNewline ? (
            '\n'
          ) : (
            char
          );

        return (
          <span
            key={i}
            className={cn(
              'tw-char',
              STATUS_CLASS[status],
              current && 'tw-char-current',
              showAsError && 'tw-char-wrong',
              wordUnderline && 'underline decoration-destructive decoration-2 underline-offset-2',
              linked?.has(i) && 'tw-linked'
            )}
          >
            {body}
          </span>
        );
      })}
      {/* Caret parking spot once the block is finished. */}
      {state.pos >= chars.length ? <span className="tw-char tw-char-current"> </span> : null}
    </>
  );
});

/* ------------------------------------------------------------------ *
 * Figures
 * ------------------------------------------------------------------ */

function Figure({ block, mode }: { block: BlockView; mode: BlockMode }) {
  return (
    <figure
      className={cn(
        'my-8 overflow-hidden rounded-lg border border-card-border bg-card transition-opacity',
        mode === 'ahead' && 'opacity-70'
      )}
      data-testid={`figure-block-${block.idx}`}
    >
      {block.asset ? (
        <img
          src={assetUrl(block.asset.id)}
          alt={block.text || block.label || 'Figure'}
          width={block.asset.width ?? undefined}
          height={block.asset.height ?? undefined}
          crossOrigin="anonymous"
          loading="lazy"
          className="mx-auto max-h-[min(60vh,520px)] w-auto max-w-full bg-white object-contain"
        />
      ) : (
        <div className="flex items-center gap-2 px-4 py-8 text-sm text-muted-foreground">
          <ImageOff className="h-4 w-4" />
          Image missing from this import
        </div>
      )}

      {(block.label || block.text) && (
        <figcaption className="border-t border-card-border px-4 py-3 text-sm text-muted-foreground">
          {block.label && <span className="font-medium text-foreground">{block.label} </span>}
          {block.text}
        </figcaption>
      )}
    </figure>
  );
}

/* ------------------------------------------------------------------ *
 * Listings
 * ------------------------------------------------------------------ */

function CodeBlock({ block, mode, state, fontSize, markIncorrectWords, showNewlines }: BlockProps) {
  const active = mode === 'active' && state;

  return (
    <div
      className={cn(
        'tw-block my-6 overflow-hidden rounded-lg border tw-code-surface lg:-mx-8',
        active && 'ring-2 ring-primary/40'
      )}
      data-testid={`code-block-${block.idx}`}
    >
      {(block.label || block.lang) && (
        <div className="flex items-center justify-between gap-3 border-b border-[hsl(var(--code-border))] px-4 py-2">
          <span className="truncate text-xs font-medium text-muted-foreground">
            {block.label ?? ''}
          </span>
          {block.lang && (
            <span className="shrink-0 rounded-full border border-border px-2 py-0.5 font-mono text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
              {block.lang}
            </span>
          )}
        </div>
      )}

      <pre
        className={cn(
          'overflow-x-auto px-4 py-4 font-mono leading-relaxed',
          !active && (mode === 'done' ? 'tw-block-done' : 'tw-block-ahead')
        )}
        style={{ fontSize: Math.max(13, fontSize - 4), tabSize: 4 }}
      >
        <code className="whitespace-pre">
          {active ? (
            <CharRun
              state={state}
              showNewlines={showNewlines !== false}
              markIncorrectWords={markIncorrectWords}
            />
          ) : (
            block.text
          )}
        </code>
      </pre>

      {block.note && (
        <div className="border-t border-[hsl(var(--code-border))] px-4 py-2 font-mono text-xs leading-relaxed text-muted-foreground">
          {block.note}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Embedded media
 * ------------------------------------------------------------------ */

/**
 * Rewrites a player URL into an embed that autoplays on click.
 *
 * `youtube-nocookie` refuses to start inline in a lot of contexts and falls back
 * to its own "watch on YouTube" card, so the plain embed host is used with
 * autoplay — the load already follows a click, which is the gesture browsers
 * want before starting media.
 */
function embedSrc(src: string, autoplay: boolean): string | null {
  try {
    const url = new URL(src);
    const id =
      /(^|\.)youtu\.be$/i.test(url.hostname)
        ? url.pathname.split('/').filter(Boolean)[0]
        : /(^|\.)youtube(-nocookie)?\.com$/i.test(url.hostname)
          ? url.pathname.match(/\/embed\/([\w-]+)/)?.[1] ?? url.searchParams.get('v')
          : null;

    if (id) {
      const params = new URLSearchParams({ rel: '0', playsinline: '1', modestbranding: '1' });
      if (autoplay) params.set('autoplay', '1');
      return `https://www.youtube.com/embed/${id}?${params}`;
    }

    if (/(^|\.)vimeo\.com$/i.test(url.hostname)) {
      const vimeoId = url.pathname.split('/').filter(Boolean).pop();
      if (vimeoId && /^\d+$/.test(vimeoId)) {
        return `https://player.vimeo.com/video/${vimeoId}${autoplay ? '?autoplay=1' : ''}`;
      }
    }

    if (autoplay) url.searchParams.set('autoplay', '1');
    return url.toString();
  } catch {
    return null;
  }
}

/** The page to open when inline playback is refused. */
function watchUrl(src: string): string {
  try {
    const url = new URL(src);
    const id = url.pathname.match(/\/embed\/([\w-]+)/)?.[1];
    if (id && /youtube/i.test(url.hostname)) return `https://www.youtube.com/watch?v=${id}`;
    return src;
  } catch {
    return src;
  }
}

/**
 * A video or interactive sample from the page. Watched, never typed.
 *
 * Nothing is loaded from the video host until you click: the poster frame was
 * downloaded with the page, so the block looks like a video offline and while
 * you are typing past it. Some videos are restricted by their owner to specific
 * sites and will refuse to start anywhere else — the caption keeps a direct link
 * for that case.
 */
function Embed({ block, mode }: { block: BlockView; mode: BlockMode }) {
  const [playing, setPlaying] = useState(false);

  const src = block.src ? embedSrc(block.src, playing) : null;
  const isVideoFile = Boolean(block.src && /\.(mp4|webm|ogg|mov)(\?|$)/i.test(block.src));
  const caption = block.text || 'Embedded media';

  return (
    <figure
      className={cn(
        'my-8 overflow-hidden rounded-lg border border-card-border bg-card transition-opacity',
        mode === 'ahead' && 'opacity-70'
      )}
      data-testid={`embed-block-${block.idx}`}
    >
      {!src ? (
        <div className="flex items-center gap-2 px-4 py-8 text-sm text-muted-foreground">
          <Play className="h-4 w-4" />
          Media could not be loaded
        </div>
      ) : isVideoFile ? (
        <video src={src} controls preload="metadata" className="aspect-video w-full bg-black" />
      ) : playing ? (
        <iframe
          src={src}
          title={caption}
          allow="autoplay; fullscreen; encrypted-media; picture-in-picture; clipboard-write"
          allowFullScreen
          className="aspect-video w-full border-0 bg-black"
        />
      ) : (
        <button
          type="button"
          onClick={() => setPlaying(true)}
          className="group relative block aspect-video w-full bg-black"
          aria-label={`Play ${caption}`}
          data-testid={`button-play-${block.idx}`}
        >
          {block.asset ? (
            <img
              src={assetUrl(block.asset.id)}
              alt=""
              crossOrigin="anonymous"
              loading="lazy"
              className="h-full w-full object-cover opacity-90 transition-opacity group-hover:opacity-100"
            />
          ) : (
            <span className="absolute inset-0 bg-gradient-to-br from-secondary to-muted" />
          )}

          <span className="absolute inset-0 flex items-center justify-center">
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-background/85 shadow-lg transition-transform group-hover:scale-110">
              <Play className="ml-0.5 h-6 w-6 fill-current text-foreground" />
            </span>
          </span>
        </button>
      )}

      <figcaption className="flex items-center justify-between gap-3 border-t border-card-border px-4 py-3 text-sm text-muted-foreground">
        <span className="truncate">{caption}</span>
        {block.src && (
          <a
            href={watchUrl(block.src)}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 text-xs underline decoration-dotted underline-offset-2 hover:text-foreground"
          >
            Watch on {hostLabel(block.src)}
          </a>
        )}
      </figcaption>
    </figure>
  );
}

function hostLabel(src: string): string {
  try {
    const host = new URL(src).hostname.replace(/^www\./, '').replace(/-nocookie/, '');
    return host.split('.').slice(-2, -1)[0] ?? host;
  } catch {
    return 'the site';
  }
}

/* ------------------------------------------------------------------ *
 * Prose and headings
 * ------------------------------------------------------------------ */

/** Splits text so the words that were links can be marked without being typed differently. */
function LinkedText({ text, links }: { text: string; links: BlockLink[] }) {
  const ordered = [...links].sort((a, b) => a.start - b.start);
  const parts: React.ReactNode[] = [];
  let cursor = 0;

  for (const [i, link] of ordered.entries()) {
    if (link.start < cursor || link.end > text.length) continue;
    if (link.start > cursor) parts.push(text.slice(cursor, link.start));
    parts.push(
      <span key={i} className="tw-linked">
        {text.slice(link.start, link.end)}
      </span>
    );
    cursor = link.end;
  }
  parts.push(text.slice(cursor));

  return <>{parts}</>;
}

function TextBlock({
  block,
  mode,
  state,
  fontSize,
  lineHeight,
  typeface,
  markIncorrectWords,
}: BlockProps) {
  const active = mode === 'active' && state;
  const heading = block.kind === 'heading';

  return (
    <div
      className={cn(
        'tw-block',
        heading ? 'mt-10 mb-4 first:mt-0' : 'my-4',
        typeface === 'serif' ? 'font-serif' : 'font-sans',
        heading && 'font-semibold tracking-tight',
        !active && (mode === 'done' ? 'tw-block-done' : 'tw-block-ahead')
      )}
      style={{
        fontSize: heading ? Math.min(30, fontSize + 4) : fontSize,
        lineHeight: heading ? 1.3 : lineHeight ?? 1.75,
      }}
      data-testid={`text-block-${block.idx}`}
    >
      {active ? (
        <CharRun
          state={state}
          showNewlines={false}
          markIncorrectWords={markIncorrectWords}
          links={block.links}
        />
      ) : block.links?.length ? (
        <LinkedText text={block.text} links={block.links} />
      ) : (
        block.text
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Dispatcher
 * ------------------------------------------------------------------ */

export const ReaderBlock = memo(function ReaderBlock(props: BlockProps) {
  if (props.block.kind === 'image') return <Figure block={props.block} mode={props.mode} />;
  if (props.block.kind === 'embed') return <Embed block={props.block} mode={props.mode} />;
  if (props.block.kind === 'code') return <CodeBlock {...props} />;
  return <TextBlock {...props} />;
});
