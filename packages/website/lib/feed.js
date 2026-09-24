/**
 * Feed utilities for Atom / RSS feed generation.
 */

/**
 * Rewrites relative `href` and `src` attributes in HTML to absolute URLs.
 *
 * Preserves existing absolute URLs (http:, https:, //), in-page hashes (#),
 * mailto, tel, and javascript links.
 *
 * @param {string} html - HTML string to transform.
 * @param {string} [base='https://zena-lang.dev'] - Base URL to resolve against.
 * @returns {string} Transformed HTML with absolute URLs.
 */
export function htmlToAbsoluteUrls(html, base = 'https://zena-lang.dev') {
  if (!html) return '';
  return html.replace(
    /(href|src)=["']([^"']+)["']/gi,
    (match, attr, urlVal) => {
      if (
        urlVal.startsWith('http://') ||
        urlVal.startsWith('https://') ||
        urlVal.startsWith('//') ||
        urlVal.startsWith('#') ||
        urlVal.startsWith('mailto:') ||
        urlVal.startsWith('tel:') ||
        urlVal.startsWith('javascript:')
      ) {
        return match;
      }
      try {
        const absolute = new URL(urlVal, base).toString();
        return `${attr}="${absolute}"`;
      } catch {
        return match;
      }
    },
  );
}

/**
 * Formats a Date or date string into an RFC 3339 / ISO 8601 string.
 *
 * @param {Date | string | number} value
 * @returns {string} ISO date-time string (e.g. 2026-09-24T12:00:00.000Z).
 */
export function isoDateTime(value) {
  return new Date(value).toISOString();
}

/**
 * Extracts the newest date from a collection of items (such as `collections.posts`).
 * Falls back to the current date if the collection is empty.
 *
 * @param {Array<{date?: Date | string}>} collection
 * @returns {Date}
 */
export function getNewestDate(collection) {
  if (!collection || collection.length === 0) {
    return new Date();
  }
  return collection[0].date ? new Date(collection[0].date) : new Date();
}

/**
 * Escapes XML special characters: &, <, >, ", '.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeXml(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
