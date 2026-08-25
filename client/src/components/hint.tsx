import { Fragment } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useSettings } from '@/components/chrome';
import { OR } from '@/components/shortcuts';

/**
 * A hover tooltip that names an action and, when the user has opted in, spells
 * out its keyboard shortcut.
 *
 * The setting `showShortcutHints` gates the tooltip so someone who has learned
 * the keys can turn it off from Settings. When the setting is off the tooltip
 * still shows the label so a button without an obvious icon is still explained
 * on hover.
 */
export function Hint({
  label,
  keys,
  side = 'bottom',
  children,
}: {
  label: string;
  keys?: string[];
  side?: 'top' | 'right' | 'bottom' | 'left';
  children: React.ReactElement;
}) {
  const { data: settings } = useSettings();
  const hintsOn = settings ? settings.showShortcutHints === 1 : true;

  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} className="flex items-center gap-2 text-xs">
        <span>{label}</span>
        {hintsOn && keys && keys.length > 0 && <KeyRow keys={keys} />}
      </TooltipContent>
    </Tooltip>
  );
}

function KeyRow({ keys }: { keys: string[] }) {
  return (
    <span className="flex items-center gap-1">
      {keys.map((key, i) =>
        key === OR ? (
          <span key={i} className="opacity-60">
            or
          </span>
        ) : (
          <Fragment key={i}>
            {i > 0 && keys[i - 1] !== OR && <span className="opacity-40">+</span>}
            <kbd className="rounded border border-border/70 bg-background/40 px-1 py-px font-mono text-[0.65rem] uppercase tracking-wide">
              {key}
            </kbd>
          </Fragment>
        )
      )}
    </span>
  );
}
