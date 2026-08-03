const HEADING_RE = /<h([23])\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/g;

const stripTags = (html) =>
  html
    .replace(/<a class="header-anchor"[\s\S]*?<\/a>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/​/g, '')
    .trim();

/**
 * Builds the "On this page" tree from rendered page HTML.
 *
 * Reading the output rather than the markdown source means the ids always
 * agree with the anchors markdown-it-anchor actually emitted, including for
 * headings produced by includes or shortcodes.
 *
 * @param {string} html
 * @returns {Array<{id: string, title: string, children: Array<{id: string, title: string}>}>}
 */
export const extractOutline = (html) => {
  const outline = [];

  for (const [, level, id, inner] of html.matchAll(HEADING_RE)) {
    const entry = {id, title: stripTags(inner), children: []};
    if (level === '2' || outline.length === 0) {
      outline.push(entry);
    } else {
      outline[outline.length - 1].children.push(entry);
    }
  }

  return outline;
};

/** Strips markup down to searchable prose. */
export const toPlainText = (html) =>
  html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/g, ' ')
    // Heading permalinks are pure chrome; without this every indexed heading
    // ends in a stray zero-width-space entity.
    .replace(/<a class="header-anchor"[\s\S]*?<\/a>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&ZeroWidthSpace;/g, '')
    .replace(/​/g, '')
    .replace(/\s+/g, ' ')
    .trim();
