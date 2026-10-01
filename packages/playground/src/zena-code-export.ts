import {StringStream} from '@codemirror/language';
import {zenaLanguage} from '@zena-lang/codemirror';

export interface ExportCodeImageOptions {
  /** The code string to render */
  code: string;
  /** The filename to display in the title bar (e.g. 'main.zena') */
  filename?: string;
  /** Theme name ('one-dark', 'dracula', 'github-dark', 'monokai', 'nord', 'vscode-dark', 'solarized-dark') */
  theme?: string;
  /** Background preset ('sunset', 'ocean', 'hyper', 'emerald', 'amber', 'midnight', 'dark', 'transparent') */
  background?: string;
  /** Custom background CSS if any */
  customBackground?: string;
  /** Outer padding around window in pixels (0, 16, 32, 48, 64). Default 48 */
  padding?: number;
  /** Show line numbers. Default true */
  showLineNumbers?: boolean;
  /** Show window title bar (with macOS dots and title). Default true */
  showWindowControls?: boolean;
  /** Show subtle Zena watermark. Default true */
  showWatermark?: boolean;
  /** Custom watermark text. Defaults to '⚡ Zena • zena-lang.dev' on zena-lang.dev, or '⚡ Zena' elsewhere. */
  watermarkText?: string;
  /** Scale multiplier for PNG export (e.g. 2 for retina). Default 2 */
  scale?: number;
}

export interface ThemeInfo {
  id: string;
  label: string;
  background: string;
  foreground: string;
  titleColor: string;
  lineNumberColor: string;
  tokenColors: Record<string, string>;
}

export interface BackgroundInfo {
  id: string;
  label: string;
  type: 'gradient' | 'solid' | 'transparent';
  css: string;
  svgFill: string;
  svgDefs?: string;
}

/**
 * Raw color palettes for syntax highlighting in standalone SVG/PNG export.
 *
 * In CodeMirror 6, themes (`cm-theme-*` via `thememirror` and `codemirror-elements`)
 * are opaque `Extension` objects that inject dynamic CSS rules into the live editor
 * DOM rather than exposing raw color maps.
 *
 * For self-contained SVG downloads and client-side Canvas PNG rasterization, tokens
 * require direct inline hex fills (`<tspan fill="...">`) to render correctly without
 * external stylesheets.
 */
export const THEMES: Record<string, ThemeInfo> = {
  'one-dark': {
    id: 'one-dark',
    label: 'One Dark',
    background: '#282c34',
    foreground: '#abb2bf',
    titleColor: '#5c6370',
    lineNumberColor: '#4b5263',
    tokenColors: {
      moduleKeyword: '#c678dd',
      definitionKeyword: '#c678dd',
      controlKeyword: '#c678dd',
      modifier: '#c678dd',
      operatorKeyword: '#c678dd',
      typeName: '#e5c07b',
      variableName: '#e06c75',
      propertyName: '#e06c75',
      punctuation: '#abb2bf',
      operator: '#56b6c2',
      string: '#98c379',
      number: '#d19a66',
      comment: '#5c6370',
      meta: '#c678dd',
      bool: '#d19a66',
      null: '#d19a66',
      self: '#e5c07b',
      escape: '#56b6c2',
    },
  },
  dracula: {
    id: 'dracula',
    label: 'Dracula',
    background: '#282a36',
    foreground: '#f8f8f2',
    titleColor: '#6272a4',
    lineNumberColor: '#6272a4',
    tokenColors: {
      moduleKeyword: '#ff79c6',
      definitionKeyword: '#ff79c6',
      controlKeyword: '#ff79c6',
      modifier: '#ff79c6',
      operatorKeyword: '#ff79c6',
      typeName: '#8be9fd',
      variableName: '#f8f8f2',
      propertyName: '#ffb86c',
      punctuation: '#f8f8f2',
      operator: '#ff79c6',
      string: '#f1fa8c',
      number: '#bd93f9',
      comment: '#6272a4',
      meta: '#50fa7b',
      bool: '#bd93f9',
      null: '#bd93f9',
      self: '#bd93f9',
      escape: '#ff79c6',
    },
  },
  nord: {
    id: 'nord',
    label: 'Nord',
    background: '#2e3440',
    foreground: '#d8dee9',
    titleColor: '#4c566a',
    lineNumberColor: '#4c566a',
    tokenColors: {
      moduleKeyword: '#81a1c1',
      definitionKeyword: '#81a1c1',
      controlKeyword: '#81a1c1',
      modifier: '#81a1c1',
      operatorKeyword: '#81a1c1',
      typeName: '#8fbcbb',
      variableName: '#eceff4',
      propertyName: '#88c0d0',
      punctuation: '#eceff4',
      operator: '#81a1c1',
      string: '#a3be8c',
      number: '#b48ead',
      comment: '#4c566a',
      meta: '#ebcb8b',
      bool: '#b48ead',
      null: '#b48ead',
      self: '#81a1c1',
      escape: '#ebcb8b',
    },
  },
  'vscode-dark': {
    id: 'vscode-dark',
    label: 'VS Code Dark',
    background: '#1e1e1e',
    foreground: '#d4d4d4',
    titleColor: '#858585',
    lineNumberColor: '#858585',
    tokenColors: {
      moduleKeyword: '#569cd6',
      definitionKeyword: '#569cd6',
      controlKeyword: '#c586c0',
      modifier: '#569cd6',
      operatorKeyword: '#569cd6',
      typeName: '#4ec9b0',
      variableName: '#9cdcfe',
      propertyName: '#9cdcfe',
      punctuation: '#d4d4d4',
      operator: '#d4d4d4',
      string: '#ce9178',
      number: '#b5cea8',
      comment: '#6a9955',
      meta: '#dcdcaa',
      bool: '#569cd6',
      null: '#569cd6',
      self: '#569cd6',
      escape: '#d7ba7d',
    },
  },
  monokai: {
    id: 'monokai',
    label: 'Monokai',
    background: '#272822',
    foreground: '#f8f8f2',
    titleColor: '#75715e',
    lineNumberColor: '#75715e',
    tokenColors: {
      moduleKeyword: '#f92672',
      definitionKeyword: '#66d9ef',
      controlKeyword: '#f92672',
      modifier: '#66d9ef',
      operatorKeyword: '#f92672',
      typeName: '#66d9ef',
      variableName: '#f8f8f2',
      propertyName: '#a6e22e',
      punctuation: '#f8f8f2',
      operator: '#f92672',
      string: '#e6db74',
      number: '#ae81ff',
      comment: '#75715e',
      meta: '#a6e22e',
      bool: '#ae81ff',
      null: '#ae81ff',
      self: '#fd971f',
      escape: '#ae81ff',
    },
  },
  'github-dark': {
    id: 'github-dark',
    label: 'GitHub Dark',
    background: '#0d1117',
    foreground: '#c9d1d9',
    titleColor: '#8b949e',
    lineNumberColor: '#484f58',
    tokenColors: {
      moduleKeyword: '#ff7b72',
      definitionKeyword: '#ff7b72',
      controlKeyword: '#ff7b72',
      modifier: '#ff7b72',
      operatorKeyword: '#ff7b72',
      typeName: '#ffa657',
      variableName: '#79c0ff',
      propertyName: '#79c0ff',
      punctuation: '#c9d1d9',
      operator: '#79c0ff',
      string: '#a5d6ff',
      number: '#79c0ff',
      comment: '#8b949e',
      meta: '#d2a8ff',
      bool: '#79c0ff',
      null: '#79c0ff',
      self: '#79c0ff',
      escape: '#79c0ff',
    },
  },
  'solarized-dark': {
    id: 'solarized-dark',
    label: 'Solarized Dark',
    background: '#002b36',
    foreground: '#839496',
    titleColor: '#586e75',
    lineNumberColor: '#586e75',
    tokenColors: {
      moduleKeyword: '#859900',
      definitionKeyword: '#859900',
      controlKeyword: '#859900',
      modifier: '#859900',
      operatorKeyword: '#859900',
      typeName: '#b58900',
      variableName: '#268bd2',
      propertyName: '#268bd2',
      punctuation: '#839496',
      operator: '#859900',
      string: '#2aa198',
      number: '#d33682',
      comment: '#586e75',
      meta: '#cb4b16',
      bool: '#d33682',
      null: '#d33682',
      self: '#268bd2',
      escape: '#dc322f',
    },
  },
};

export const BACKGROUNDS: Record<string, BackgroundInfo> = {
  sunset: {
    id: 'sunset',
    label: 'Sunset',
    type: 'gradient',
    css: 'linear-gradient(140deg, #ec4899, #8b5cf6)',
    svgFill: 'url(#bg-sunset)',
    svgDefs: `<linearGradient id="bg-sunset" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ec4899" />
      <stop offset="100%" stop-color="#8b5cf6" />
    </linearGradient>`,
  },
  ocean: {
    id: 'ocean',
    label: 'Ocean',
    type: 'gradient',
    css: 'linear-gradient(140deg, #06b6d4, #3b82f6)',
    svgFill: 'url(#bg-ocean)',
    svgDefs: `<linearGradient id="bg-ocean" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#06b6d4" />
      <stop offset="100%" stop-color="#3b82f6" />
    </linearGradient>`,
  },
  hyper: {
    id: 'hyper',
    label: 'Hyper',
    type: 'gradient',
    css: 'linear-gradient(140deg, #f43f5e, #8b5cf6, #3b82f6)',
    svgFill: 'url(#bg-hyper)',
    svgDefs: `<linearGradient id="bg-hyper" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#f43f5e" />
      <stop offset="50%" stop-color="#8b5cf6" />
      <stop offset="100%" stop-color="#3b82f6" />
    </linearGradient>`,
  },
  emerald: {
    id: 'emerald',
    label: 'Emerald',
    type: 'gradient',
    css: 'linear-gradient(140deg, #10b981, #0d9488)',
    svgFill: 'url(#bg-emerald)',
    svgDefs: `<linearGradient id="bg-emerald" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#10b981" />
      <stop offset="100%" stop-color="#0d9488" />
    </linearGradient>`,
  },
  amber: {
    id: 'amber',
    label: 'Amber',
    type: 'gradient',
    css: 'linear-gradient(140deg, #f97316, #eab308)',
    svgFill: 'url(#bg-amber)',
    svgDefs: `<linearGradient id="bg-amber" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#f97316" />
      <stop offset="100%" stop-color="#eab308" />
    </linearGradient>`,
  },
  midnight: {
    id: 'midnight',
    label: 'Midnight',
    type: 'gradient',
    css: 'linear-gradient(140deg, #1e293b, #0f172a)',
    svgFill: 'url(#bg-midnight)',
    svgDefs: `<linearGradient id="bg-midnight" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1e293b" />
      <stop offset="100%" stop-color="#0f172a" />
    </linearGradient>`,
  },
  dark: {
    id: 'dark',
    label: 'Dark',
    type: 'solid',
    css: '#18181b',
    svgFill: '#18181b',
  },
  transparent: {
    id: 'transparent',
    label: 'Transparent',
    type: 'transparent',
    css: 'transparent',
    svgFill: 'transparent',
  },
};

export const getAvailableThemes = (): ThemeInfo[] => Object.values(THEMES);
export const getAvailableBackgrounds = (): BackgroundInfo[] =>
  Object.values(BACKGROUNDS);

/**
 * Returns the default watermark text based on current hosting domain.
 * On zena-lang.dev (and local dev), includes the site name. On other domains, defaults to '⚡ Zena'.
 */
export const getDefaultWatermarkText = (): string => {
  if (typeof window !== 'undefined' && window.location?.hostname) {
    const host = window.location.hostname;
    if (
      host === 'zena-lang.dev' ||
      host.endsWith('.zena-lang.dev') ||
      host === 'localhost' ||
      host === '127.0.0.1'
    ) {
      return '⚡ Zena • zena-lang.dev';
    }
  }
  return '⚡ Zena';
};

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

interface HighlightToken {
  text: string;
  style: string | null;
}

/**
 * Tokenizes Zena source code line-by-line using the CodeMirror Zena stream parser.
 */
function tokenizeZenaCode(code: string): HighlightToken[][] {
  const normalized = code.replace(/\r\n/g, '\n').replace(/\n$/, '');
  const lines = normalized.split('\n');
  const parser = (zenaLanguage as any).streamParser;
  const state = parser.startState(2);
  const tokenizedLines: HighlightToken[][] = [];

  for (const line of lines) {
    if (line.length === 0) {
      if (typeof parser.blankLine === 'function') {
        parser.blankLine(state);
      }
      tokenizedLines.push([]);
      continue;
    }

    const stream = new StringStream(line, 2, 2);
    const lineTokens: HighlightToken[] = [];
    while (!stream.eol()) {
      const style = parser.token(stream, state);
      lineTokens.push({
        text: stream.current(),
        style,
      });
      stream.start = stream.pos;
    }
    tokenizedLines.push(lineTokens);
  }

  return tokenizedLines;
}

/**
 * Generates an SVG string representation of the source code card, styled like Carbon.
 */
export function generateCodeSvg(options: ExportCodeImageOptions): string {
  const {
    code,
    filename = 'main.zena',
    theme: themeName = 'one-dark',
    background: bgName = 'sunset',
    padding = 48,
    showLineNumbers = true,
    showWindowControls = true,
    showWatermark = true,
    watermarkText = getDefaultWatermarkText(),
  } = options;

  const theme = THEMES[themeName] ?? THEMES['one-dark'];
  const bg = BACKGROUNDS[bgName] ?? BACKGROUNDS['sunset'];

  const tokenizedLines = tokenizeZenaCode(code);
  const lineCount = tokenizedLines.length;

  const fontSize = 14;
  const lineHeight = 22;
  const monoFont =
    "'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, Monaco, Consolas, monospace";
  const sansFont =
    "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

  // Monospace character advance width approximation at 14px
  const charWidth = 8.42;

  // Find max line character length
  let maxLineChars = filename.length + 8;
  for (const lineTokens of tokenizedLines) {
    let lineLength = 0;
    for (const token of lineTokens) {
      lineLength += token.text.length;
    }
    if (lineLength > maxLineChars) {
      maxLineChars = lineLength;
    }
  }

  // Calculate layout dimensions
  const lineNoDigits = Math.max(2, String(lineCount).length);
  const lineNoWidth = showLineNumbers ? lineNoDigits * charWidth + 16 : 0;
  const codeLeftPadding = 24 + lineNoWidth;
  const codeRightPadding = 28;

  const headerHeight = showWindowControls ? 42 : 20;
  const bottomPadding = 24;

  const contentWidth = maxLineChars * charWidth;
  const windowWidth = Math.max(
    420,
    Math.round(codeLeftPadding + contentWidth + codeRightPadding),
  );
  const windowHeight = Math.round(
    headerHeight + lineCount * lineHeight + bottomPadding,
  );

  const totalWidth = windowWidth + padding * 2;
  const totalHeight = windowHeight + padding * 2;

  // Build SVG lines
  const linesSvg: string[] = [];

  tokenizedLines.forEach((lineTokens, lineIdx) => {
    const lineY = headerHeight + lineIdx * lineHeight + 16;
    const lineNum = lineIdx + 1;

    // Line number
    if (showLineNumbers) {
      const lineNoX = 24 + lineNoDigits * charWidth;
      linesSvg.push(
        `<text x="${lineNoX}" y="${lineY}" text-anchor="end" font-family="${monoFont}" font-size="${fontSize}" fill="${theme.lineNumberColor}" opacity="0.6">${lineNum}</text>`,
      );
    }

    // Code tokens
    if (lineTokens.length > 0) {
      const tspans = lineTokens
        .map((tok) => {
          const color =
            tok.style && theme.tokenColors[tok.style]
              ? theme.tokenColors[tok.style]
              : theme.foreground;
          const escaped = escapeXml(tok.text);
          return `<tspan fill="${color}">${escaped}</tspan>`;
        })
        .join('');

      linesSvg.push(
        `<text x="${codeLeftPadding}" y="${lineY}" font-family="${monoFont}" font-size="${fontSize}" xml:space="preserve">${tspans}</text>`,
      );
    }
  });

  const windowControlsSvg = showWindowControls
    ? `
    <!-- macOS Window Buttons -->
    <circle cx="20" cy="20" r="5.5" fill="#ff5f56" stroke="#e0443e" stroke-width="0.5" />
    <circle cx="38" cy="20" r="5.5" fill="#ffbd2e" stroke="#dea123" stroke-width="0.5" />
    <circle cx="56" cy="20" r="5.5" fill="#27c93f" stroke="#1aab29" stroke-width="0.5" />
    ${
      filename
        ? `<text x="${windowWidth / 2}" y="24" text-anchor="middle" font-family="${sansFont}" font-size="12" font-weight="500" fill="${theme.titleColor}">${escapeXml(
            filename,
          )}</text>`
        : ''
    }`
    : '';

  const watermarkSvg = showWatermark
    ? `<text x="${windowWidth - 18}" y="${windowHeight - 10}" text-anchor="end" font-family="${sansFont}" font-size="11" font-weight="600" fill="${theme.foreground}" opacity="0.3">${escapeXml(watermarkText)}</text>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${totalHeight}" viewBox="0 0 ${totalWidth} ${totalHeight}" style="aspect-ratio: ${totalWidth} / ${totalHeight};">
  <defs>
    ${bg.svgDefs ?? ''}
    <filter id="window-shadow" x="-20%" y="-20%" width="140%" height="150%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="16" />
      <feOffset dx="0" dy="14" result="offsetblur" />
      <feComponentTransfer>
        <feFuncA type="linear" slope="0.45" />
      </feComponentTransfer>
      <feMerge>
        <feMergeNode />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
  </defs>

  <!-- Canvas Background -->
  ${
    bg.type === 'transparent'
      ? `<rect width="${totalWidth}" height="${totalHeight}" fill="none" />`
      : `<rect width="${totalWidth}" height="${totalHeight}" fill="${bg.svgFill}" />`
  }

  <!-- Window Container with Shadow -->
  <g transform="translate(${padding}, ${padding})" filter="url(#window-shadow)">
    <!-- Window Body -->
    <rect width="${windowWidth}" height="${windowHeight}" rx="10" fill="${theme.background}" />

    ${windowControlsSvg}

    <!-- Code Content -->
    ${linesSvg.join('\n    ')}

    ${watermarkSvg}
  </g>
</svg>`;
}

/**
 * Converts the generated code SVG to a high-resolution PNG Blob using client-side HTML5 canvas.
 */
export async function exportCodeToPngBlob(
  options: ExportCodeImageOptions,
  scale = 2,
): Promise<Blob> {
  const svg = generateCodeSvg(options);
  const blob = new Blob([svg], {type: 'image/svg+xml;charset=utf-8'});
  const url = URL.createObjectURL(blob);

  return new Promise<Blob>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth * scale;
        canvas.height = img.naturalHeight * scale;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Failed to get 2D canvas context'));
          return;
        }

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0);

        canvas.toBlob(
          (pngBlob) => {
            if (pngBlob) {
              resolve(pngBlob);
            } else {
              reject(new Error('Canvas toBlob returned null'));
            }
          },
          'image/png',
          1.0,
        );
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(url);
      reject(err);
    };
    img.src = url;
  });
}

/**
 * Copies the PNG code image to the clipboard.
 * Returns true if successful, false otherwise.
 */
export async function copyCodeImageToClipboard(
  options: ExportCodeImageOptions,
): Promise<boolean> {
  try {
    const blob = await exportCodeToPngBlob(options, 2);
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          'image/png': blob,
        }),
      ]);
      return true;
    }
  } catch (err) {
    console.warn('[Zena Playground] Failed to copy image to clipboard:', err);
  }
  return false;
}

/**
 * Downloads the code card as either a PNG or an SVG image.
 */
export async function downloadCodeImage(
  options: ExportCodeImageOptions,
  format: 'png' | 'svg' = 'png',
): Promise<void> {
  const baseName = (options.filename || 'code')
    .replace(/[^\w.-]/g, '_')
    .replace(/\.zena$/i, '');
  const fileName = `${baseName}.${format}`;

  let blob: Blob;
  if (format === 'svg') {
    const svg = generateCodeSvg(options);
    blob = new Blob([svg], {type: 'image/svg+xml;charset=utf-8'});
  } else {
    blob = await exportCodeToPngBlob(options, 2);
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
