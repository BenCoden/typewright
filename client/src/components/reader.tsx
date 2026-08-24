import { memo } from 'react';
import { ImageOff } from 'lucide-react';
import { assetUrl } from '@/lib/queryClient';
import { cn } from '@/lib/utils';
import type { BlockState } from '@/lib/typing';
import type { BlockView } from '@shared/schema';

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
  /** 'serif' | 'sans' — prose only; code is always monospace. */
  typeface: string;
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

const CharRun = memo(function CharRun({ state, showNewlines }: { state: BlockState; showNewlines: boolean }) {
  const chars = [...state.expected];

  return (
    <>
      {chars.map((char, i) => {
        const isNewline = char === '\n';
        const status = state.status[i];
        const current = i === state.pos;

        // A wrong space or newline needs a visible body to show the error.
        const showAsError = status === 'wrong' && (char === ' ' || isNewline);

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
              showAsError && 'tw-char-wrong'
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

function CodeBlock({ block, mode, state, fontSize }: BlockProps) {
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
          {active ? <CharRun state={state} showNewlines /> : block.text}
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
 * Prose and headings
 * ------------------------------------------------------------------ */

function TextBlock({ block, mode, state, fontSize, typeface }: BlockProps) {
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
        lineHeight: heading ? 1.3 : 1.75,
      }}
      data-testid={`text-block-${block.idx}`}
    >
      {active ? <CharRun state={state} showNewlines={false} /> : block.text}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Dispatcher
 * ------------------------------------------------------------------ */

export const ReaderBlock = memo(function ReaderBlock(props: BlockProps) {
  if (props.block.kind === 'image') return <Figure block={props.block} mode={props.mode} />;
  if (props.block.kind === 'code') return <CodeBlock {...props} />;
  return <TextBlock {...props} />;
});
