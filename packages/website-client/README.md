# @zena-lang/website-client

Lit custom elements that add interactivity to the
[Zena docs site](../website).

This package ships TypeScript source only — no build output. The website bundles
it with esbuild from an Eleventy hook, so `npm run build` here just runs `tsc
--noEmit` as a type check.

## Design

**Light DOM everywhere.** Every element either renders into light DOM
(`LightElement`) or only attaches behaviour to existing markup
(`BehaviorElement`). The site's stylesheet is a port of the VitePress default
theme, and a shadow root would cut these elements off from it for no benefit.

**Progressive enhancement.** Eleventy renders the sidebar, the outline, the nav,
and the code groups as complete HTML — including which sidebar group is
expanded and which code-group tab is active. These elements make that markup
interactive; without JavaScript the site is still fully navigable.

## Elements

| Element                | Role                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| `<zena-layout>`        | Mobile chrome: hamburger nav screen, slide-in sidebar, backdrop, scroll lock, nav scroll state |
| `<zena-sidebar>`       | Expands and collapses sidebar groups                                                           |
| `<zena-outline>`       | Highlights the current section in the right-hand rail and moves the marker                     |
| `<zena-local-outline>` | The mobile "On this page" dropdown                                                             |
| `<zena-search>`        | Search button and modal over the prebuilt `/search-index.json`                                 |
| `<zena-appearance>`    | Light/dark switch, persisted to `localStorage`                                                 |
| `<zena-code-copy>`     | Delegated copy-to-clipboard for every `button.copy` beneath it                                 |
| `<zena-code-group>`    | Tabbed code blocks from `::: code-group`                                                       |

`<zena-playground>` is not defined here. It lives in
[`@zena-lang/playground`](../playground), which this package imports for its
side effect so the docs site gets it in the same bundle.
