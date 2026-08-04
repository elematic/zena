import {StreamLanguage, LanguageSupport} from '@codemirror/language';
import {hoverTooltip, EditorView} from '@codemirror/view';
import {customElement} from 'lit/decorators.js';
import {CodeMirrorExtensionElement} from 'codemirror-elements/lib/cm-extension-element.js';

const keywords = new Set([
  'let',
  'var',
  'function',
  'class',
  'sealed',
  'case',
  'interface',
  'mixin',
  'enum',
  'type',
  'new',
  'export',
  'import',
  'from',
  'declare',
  'if',
  'else',
  'while',
  'for',
  'in',
  'return',
  'match',
  'throw',
  'try',
  'catch',
  'is',
  'as',
  'extends',
  'implements',
  'with',
  'on',
  'true',
  'false',
  'null',
  'this',
  'super',
]);

const primitiveTypes = new Set([
  'i32',
  'i64',
  'u32',
  'f32',
  'f64',
  'boolean',
  'string',
  'void',
  'never',
  'any',
  'anyref',
  'ByteArray',
]);

const builtinTypes = new Set([
  'Array',
  'Map',
  'Box',
  'Error',
  'String',
  'FixedArray',
  'GrowableArray',
  'ImmutableArray',
  'Sequence',
  'Iterator',
  'HashSet',
  'HashMap',
  'Console',
]);

export interface ZenaState {
  inBlockComment: number;
  stringType: string | null;
  templateDepth: number;
}

export const zenaLanguage = StreamLanguage.define<ZenaState>({
  name: 'zena',
  startState(): ZenaState {
    return {
      inBlockComment: 0,
      stringType: null,
      templateDepth: 0,
    };
  },
  token(stream, state) {
    // 1. Block comment handling
    if (state.inBlockComment > 0) {
      if (stream.match('*/')) {
        state.inBlockComment--;
        return 'comment';
      }
      if (stream.match('/*')) {
        state.inBlockComment++;
        return 'comment';
      }
      stream.next();
      return 'comment';
    }
    if (stream.match('/*')) {
      state.inBlockComment = 1;
      return 'comment';
    }
    if (stream.match('//')) {
      stream.skipToEnd();
      return 'comment';
    }

    // 2. String & Template String handling
    if (state.stringType) {
      if (state.stringType === '`' && stream.match('${')) {
        state.templateDepth++;
        state.stringType = null;
        return 'punctuation';
      }
      if (stream.match(state.stringType)) {
        state.stringType = null;
        return 'string';
      }
      if (stream.match(/^\\./)) {
        return 'escape';
      }
      stream.next();
      return 'string';
    }

    if (stream.match("'")) {
      state.stringType = "'";
      return 'string';
    }
    if (stream.match('"')) {
      state.stringType = '"';
      return 'string';
    }
    if (stream.match('`')) {
      state.stringType = '`';
      return 'string';
    }

    if (state.templateDepth > 0 && stream.peek() === '}') {
      stream.next();
      state.templateDepth--;
      state.stringType = '`';
      return 'punctuation';
    }

    // 3. Decorators (@intrinsic, etc)
    if (stream.match(/^@[a-zA-Z_$][a-zA-Z0-9_$]*/)) {
      return 'meta';
    }

    // 4. Numbers
    if (stream.match(/^0[xX][0-9a-fA-F]+/)) {
      return 'number';
    }
    if (stream.match(/^[0-9]+\.[0-9]+/)) {
      return 'number';
    }
    if (stream.match(/^[0-9]+/)) {
      return 'number';
    }

    // 5. Operators
    if (stream.match('|>')) return 'operator';
    if (stream.match('??')) return 'operator';
    if (stream.match('?.') || stream.match('?(') || stream.match('?['))
      return 'operator';
    if (stream.match('=>')) return 'operator';
    if (stream.match(/^(===[^=]|!==|==|!=|<=|>=|<|>)/)) return 'operator';
    if (stream.match(/^(\+=|-=|\*=|\/=|%=|&=|\|=|\^=|<<=|>>=|\+|-|\*|\/|%)/))
      return 'operator';
    if (stream.match(/^(&&|\|\||!)/)) return 'operator';
    if (stream.match('...')) return 'operator';
    if (stream.match(/^[=|&|^~]/)) return 'operator';

    // 6. Private fields / setters (#field, #count)
    if (stream.match(/^#[a-zA-Z_$][a-zA-Z0-9_$]*/)) {
      return 'propertyName';
    }

    // 7. Keywords / Types / Identifiers
    if (stream.match(/^[a-zA-Z_$][a-zA-Z0-9_$]*/)) {
      const word = stream.current();
      if (keywords.has(word)) {
        if (word === 'true' || word === 'false' || word === 'null')
          return 'atom';
        if (word === 'this' || word === 'super') return 'keyword';
        return 'keyword';
      }
      if (primitiveTypes.has(word)) {
        return 'typeName';
      }
      if (builtinTypes.has(word)) {
        return 'className';
      }
      if (/^[A-Z]/.test(word)) {
        return 'typeName';
      }
      return 'variableName';
    }

    // 8. Punctuation
    if (stream.match(/^[()\[\]{}:;,.]/)) {
      return 'punctuation';
    }

    stream.next();
    return null;
  },
});

export function zena() {
  return new LanguageSupport(zenaLanguage);
}

/**
 * `<cm-lang-zena>` custom element for CodeMirror.
 * When placed inside `<cm-editor>`, it declaratively provides Zena syntax highlighting.
 */
@customElement('cm-lang-zena')
export class CodeMirrorLangZena extends CodeMirrorExtensionElement {
  constructor() {
    super();
    this.setExtensions([
      zena(),
      EditorView.theme({
        '&': {
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          flex: '1 1 0%',
          minHeight: '0',
        },
        '.cm-scroller': {
          height: '100%',
          flex: '1 1 0%',
          minHeight: '0',
          overflow: 'auto',
        },
      }),
    ]);
  }
}

/** Type information for a source offset, as the language service reports it. */
export interface ZenaHoverInfo {
  /** Rendered declaration, e.g. `let greet: (name: String) => String`. */
  label: string;
  /** The type alone, shown when there is no label. */
  type: string;
  /** Doc comment attached to the declaration, if any. */
  doc: string;
}

/**
 * Answers "what is at this offset?" for `<cm-hover-zena>`.
 *
 * Structurally what `ZenaLanguageService.hover()` returns, but the editor
 * never talks to the compiler directly — in a browser it lives in a worker,
 * which is why this is async and injected.
 */
export type ZenaHoverProvider = (
  offset: number,
) => Promise<ZenaHoverInfo | null> | ZenaHoverInfo | null;

/**
 * `<cm-hover-zena>` custom element for CodeMirror.
 *
 * When placed inside `<cm-editor>`, it shows type signatures and doc comments
 * on hover. Inert until given a `hoverProvider`:
 *
 * ```js
 * editor.querySelector('cm-hover-zena').hoverProvider =
 *   (offset) => service.hover('main.zena', offset);
 * ```
 */
@customElement('cm-hover-zena')
export class CodeMirrorHoverZena extends CodeMirrorExtensionElement {
  #hoverProvider?: ZenaHoverProvider;

  set hoverProvider(provider: ZenaHoverProvider | undefined) {
    this.#hoverProvider = provider;
    this.updateHoverExtension();
  }

  get hoverProvider(): ZenaHoverProvider | undefined {
    return this.#hoverProvider;
  }

  updateHoverExtension() {
    const provider = this.#hoverProvider;
    if (!provider) return;

    const hoverExtension = hoverTooltip(async (view, pos) => {
      const line = view.state.doc.lineAt(pos);
      const lineText = line.text;
      const linePos = pos - line.from;
      if (
        linePos < 0 ||
        linePos >= lineText.length ||
        !/[a-zA-Z0-9_$#]/.test(lineText[linePos])
      ) {
        return null;
      }
      var start = linePos;
      while (start > 0 && /[a-zA-Z0-9_$#]/.test(lineText[start - 1])) {
        start--;
      }
      var end = linePos;
      while (end < lineText.length && /[a-zA-Z0-9_$#]/.test(lineText[end])) {
        end++;
      }
      const tokenFrom = line.from + start;
      const tokenTo = line.from + end;

      const hoverData = await provider(pos);
      if (!hoverData || (!hoverData.label && !hoverData.type)) {
        return null;
      }
      return {
        pos: tokenFrom,
        end: tokenTo,
        above: true,
        create() {
          const dom = document.createElement('div');
          dom.className = 'cm-zena-hover-tooltip';

          if (hoverData.doc) {
            const docEl = document.createElement('div');
            docEl.className = 'cm-zena-hover-doc';
            docEl.textContent = hoverData.doc;
            dom.appendChild(docEl);
          }

          const labelEl = document.createElement('div');
          labelEl.className = 'cm-zena-hover-label';
          labelEl.textContent = hoverData.label || hoverData.type;
          dom.appendChild(labelEl);

          return {dom};
        },
      };
    });

    this.setExtensions([hoverExtension]);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'cm-lang-zena': CodeMirrorLangZena;
    'cm-hover-zena': CodeMirrorHoverZena;
  }
}
