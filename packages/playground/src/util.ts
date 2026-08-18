/**
 * Removes common leading whitespace across all non-empty lines in `text`,
 * and strips any initial or trailing blank line.
 *
 * This matches the indentation trimming behavior of Google Playground Elements
 * when `preserve-whitespace` is not present on `<script>` tags.
 */
export function unindent(text: string): string {
  const lines = text.split('\n');

  // Strip leading blank line (common after an opening <script> tag)
  if (lines.length > 0 && lines[0].trim() === '') {
    lines.shift();
  }

  // Strip trailing blank line (common before a closing </script> tag)
  if (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }

  if (lines.length === 0) {
    return '';
  }

  let minIndent = Infinity;
  for (const line of lines) {
    if (line.trim().length > 0) {
      const match = line.match(/^[ \t]*/);
      const indent = match ? match[0].length : 0;
      if (indent < minIndent) {
        minIndent = indent;
      }
    }
  }

  if (minIndent !== Infinity && minIndent > 0) {
    return lines
      .map((line) => (line.length >= minIndent ? line.slice(minIndent) : line))
      .join('\n');
  }

  return lines.join('\n');
}
