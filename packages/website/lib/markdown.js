import anchor from 'markdown-it-anchor';
import attrs from 'markdown-it-attrs';
import container from 'markdown-it-container';
import {renderCodeBlock} from './highlight.js';

/** Custom containers that mirror VitePress's `::: tip` family. */
const BLOCK_TYPES = ['info', 'note', 'tip', 'important', 'warning', 'danger'];

const DEFAULT_TITLES = {
  info: 'INFO',
  note: 'NOTE',
  tip: 'TIP',
  important: 'IMPORTANT',
  warning: 'WARNING',
  danger: 'DANGER',
};

/**
 * Parses a fence's info string: ``` ```zena [main.zena] ``` ```
 * yields `{lang: 'zena', label: 'main.zena'}`.
 */
const parseFenceInfo = (info) => {
  const trimmed = (info ?? '').trim();
  const [lang = 'text', ...rest] = trimmed.split(/\s+/);
  const label = /\[(.+)\]/.exec(rest.join(' '))?.[1];
  return {lang: lang.toLowerCase(), label};
};

const escapeHtml = (s) =>
  s.replace(
    /[&<>"]/g,
    (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c],
  );

/**
 * Applies the site's markdown conventions to Eleventy's markdown-it instance.
 *
 * @param {import('markdown-it')} md
 * @param {Awaited<ReturnType<import('./highlight.js').createZenaHighlighter>>} highlighter
 */
export const configureMarkdown = (md, highlighter) => {
  md.set({html: true, linkify: true, typographer: false});

  // Without this, linkify reads bare filenames as bare domains: prose mentioning
  // `strings.md` renders as a link to http://strings.md. Explicit `http://…`
  // URLs still linkify; only schemeless guesses are turned off.
  md.linkify.set({fuzzyLink: false});

  md.use(attrs);

  md.use(anchor, {
    level: [2, 3, 4],
    permalink: anchor.permalink.linkInsideHeader({
      symbol: '&ZeroWidthSpace;',
      class: 'header-anchor',
      renderAttrs: (slug, state, idx) => ({
        'aria-label': `Permalink to "${state.tokens[idx + 1]?.content ?? slug}"`,
      }),
    }),
    slugify: (s) =>
      encodeURIComponent(
        String(s)
          .trim()
          .toLowerCase()
          .replace(/[^\w\- ]+/g, '')
          .replace(/\s+/g, '-'),
      ),
  });

  // ::: tip / warning / danger / …
  for (const type of BLOCK_TYPES) {
    md.use(container, type, {
      render(tokens, idx) {
        const token = tokens[idx];
        if (token.nesting !== 1) return '</div>\n';
        const title = token.info.trim().slice(type.length).trim();
        return (
          `<div class="${type} custom-block">` +
          `<p class="custom-block-title">${escapeHtml(title || DEFAULT_TITLES[type])}</p>\n`
        );
      },
    });
  }

  // ::: details Summary text
  md.use(container, 'details', {
    render(tokens, idx) {
      const token = tokens[idx];
      if (token.nesting !== 1) return '</details>\n';
      const title = token.info.trim().slice('details'.length).trim();
      return (
        `<details class="details custom-block">` +
        `<summary>${escapeHtml(title || 'Details')}</summary>\n`
      );
    },
  });

  // ::: code-group — consecutive fences become tabs. Labels come from the
  // fence info strings: ```zena [main.zena]
  md.use(container, 'code-group', {
    render(tokens, idx) {
      if (tokens[idx].nesting !== 1) return '</div></zena-code-group>\n';

      const labels = [];
      for (let i = idx + 1; i < tokens.length; i++) {
        if (tokens[i].type === 'container_code-group_close') break;
        if (tokens[i].type !== 'fence') continue;
        const {lang, label} = parseFenceInfo(tokens[i].info);
        labels.push(label ?? lang);
      }

      const tabs = labels
        .map(
          (label, i) =>
            `<button role="tab" aria-selected="${i === 0}">${escapeHtml(label)}</button>`,
        )
        .join('');

      return (
        `<zena-code-group class="code-group">` +
        `<div class="tabs" role="tablist">${tabs}</div>` +
        `<div class="blocks">`
      );
    },
  });

  // Hide every code-group tab panel but the first, so the group degrades to a
  // single readable block without JS.
  const defaultFence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const {lang, label} = parseFenceInfo(tokens[idx].info);
    const html = renderCodeBlock(
      highlighter,
      tokens[idx].content,
      lang,
      label ?? undefined,
    );

    if (env?.codeGroupDepth) {
      const hidden = env.codeGroupSeen++ > 0 ? ' hidden' : '';
      return html.replace(
        '<div class="language-',
        `<div${hidden} class="language-`,
      );
    }
    return html;
  };
  // Keep a reference so the rule can be restored if a plugin wraps it later.
  md.renderer.rules.fence.defaultFence = defaultFence;

  // Track code-group nesting for the fence rule above.
  const openCodeGroup = md.renderer.rules['container_code-group_open'];
  md.renderer.rules['container_code-group_open'] = (
    tokens,
    idx,
    options,
    env,
    self,
  ) => {
    env.codeGroupDepth = (env.codeGroupDepth ?? 0) + 1;
    env.codeGroupSeen = 0;
    return openCodeGroup(tokens, idx, options, env, self);
  };

  const closeCodeGroup = md.renderer.rules['container_code-group_close'];
  md.renderer.rules['container_code-group_close'] = (
    tokens,
    idx,
    options,
    env,
    self,
  ) => {
    env.codeGroupDepth = Math.max(0, (env.codeGroupDepth ?? 1) - 1);
    return closeCodeGroup(tokens, idx, options, env, self);
  };

  // Mark off-site links so the doc CSS can add the external-link icon.
  const defaultLinkOpen =
    md.renderer.rules.link_open ??
    ((tokens, idx, options, env, self) =>
      self.renderToken(tokens, idx, options));

  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const href = tokens[idx].attrGet('href') ?? '';
    if (/^https?:\/\//.test(href)) {
      tokens[idx].attrSet('target', '_blank');
      tokens[idx].attrSet('rel', 'noreferrer');
    }
    return defaultLinkOpen(tokens, idx, options, env, self);
  };

  return md;
};
