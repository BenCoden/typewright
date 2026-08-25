/**
 * "Can this string be typed on the chosen keyboard layout?"
 *
 * The check is deliberately conservative: characters that are trivially
 * produced by any modern keyboard (letters, digits, punctuation, common
 * symbols, whitespace) are typeable; everything else — combining marks,
 * currency, accented letters, non-Latin scripts — is not, unless the user has
 * opted in to a wider layout.
 *
 * The result feeds two features: skipping unreachable blocks in the reader,
 * and marking the same characters so a reader can see why a block is being
 * stepped over. Both use the same source of truth.
 */

export type KeyboardLayout = 'us' | 'us-intl' | 'any';

/** ASCII printable range plus the whitespace characters typing engines accept. */
const US_TYPEABLE = /^[\x20-\x7E\t\n\r]$/;

/** US-International adds the standard set of Latin accents via dead keys. */
const US_INTL_TYPEABLE =
  /^[\x20-\x7E\t\n\r\u00A1-\u017F\u00A0\u2019\u2013\u2014\u201C\u201D\u2018]$/;

/** A character that any layout can produce (US-Intl is a strict superset of US). */
export function isTypeable(char: string, layout: KeyboardLayout): boolean {
  if (layout === 'any') return true;
  if (layout === 'us-intl') return US_INTL_TYPEABLE.test(char);
  return US_TYPEABLE.test(char);
}

/** True when every character in the string is reachable on the layout. */
export function stringIsTypeable(text: string, layout: KeyboardLayout): boolean {
  if (layout === 'any') return true;
  for (const char of text) {
    if (!isTypeable(char, layout)) return false;
  }
  return true;
}

/** Characters in the string that are not typeable on the layout, deduplicated. */
export function untypeableCharacters(text: string, layout: KeyboardLayout): string[] {
  if (layout === 'any') return [];
  const seen = new Set<string>();
  for (const char of text) {
    if (!isTypeable(char, layout) && !seen.has(char)) seen.add(char);
  }
  return [...seen];
}
