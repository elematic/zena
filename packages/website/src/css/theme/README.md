# Theme

This started as the [VitePress](https://vitepress.dev/) **1.6.4** default theme
(`vitepress/dist/client/theme-default/styles/`, MIT — see `LICENSE`). It is
maintained as Zena's own stylesheet now, not as a vendored copy.

| File                          | Origin                                                                   |
| ----------------------------- | ------------------------------------------------------------------------ |
| `vars.css`                    | upstream, class names renamed                                            |
| `base.css`                    | upstream, class names renamed                                            |
| `utils.css`                   | upstream, class names renamed                                            |
| `icons.css`                   | upstream, class names renamed                                            |
| `components/prose.css`        | upstream `vp-doc.css`                                                    |
| `components/code-block.css`   | upstream `vp-code.css`                                                   |
| `components/custom-block.css` | upstream                                                                 |
| `components/nav.css`          | flattened from `VPNav*`, `VPFlyout`, `VPMenu*`, `VPSwitch*`, `VPSocial*` |
| `components/sidebar.css`      | flattened from `VPSidebar`, `VPSidebarItem`, `VPBackdrop`, `VPSkipLink`  |
| `components/layout.css`       | flattened from `Layout`, `VPContent`, `VPDoc*`, `VPFooter`, `VPPage`     |
| `components/home.css`         | flattened from `VPHome`, `VPHero`, `VPFeature*`, `VPButton`, `VPBadge`   |
| `components/local-nav.css`    | flattened from `VPLocalNav`, `VPLocalNavOutlineDropdown`                 |

## Naming

Class names are unprefixed and kebab-case: `VPButton` → `button`, `vp-doc` →
`prose`, `vpi-chevron-right` → `icon-chevron-right`. Five needed more than a
mechanical strip, because the obvious name was already taken by a child element:

| Upstream    | Here           | Why                                                  |
| ----------- | -------------- | ---------------------------------------------------- |
| `VPNav`     | `site-nav`     | the sidebar's own `<nav class="nav">`                |
| `VPContent` | `site-content` | `.content` is a child of `.doc` and `.doc-outline`   |
| `VPMenu`    | `flyout-menu`  | `.menu` is the nav menu and the local-nav button     |
| `VPHome`    | `home-page`    | `.home` is a modifier on the nav bar                 |
| `VPDoc`     | `doc`          | `.doc` is the layout region, `.prose` the type scope |

The flyout's own toggle is `.flyout-toggle` rather than `.button`, for the same
reason.

**Design tokens still use the upstream `--vp-` prefix** (`--vp-c-brand-1`,
`--vp-nav-height`, …). Renaming ~200 custom properties is a separate change with
no functional benefit; they're consistent as-is.

## Flattening

The `components/*.css` files were Vue SFC `<style scoped>` blocks, rewritten with
each selector qualified by its component's root class. Two consequences are
load-bearing:

- **Ordering.** Scoped styles can't collide, so upstream leans on `.VPDoc .aside`
  (specificity 0,2,0) inside a media query beating a bare `.aside` (0,1,0)
  declared afterwards. Flattened, both are equal, so base rules must come
  _before_ their media queries.
- **Child chains.** `.nav-bar .container` would also match the hamburger's
  `.container`, and `.doc .content` would also match the outline's `.content`.
  Those are written as explicit `>` chains.

## Re-syncing

Still possible, just no longer a plain diff — apply the rename table above to the
new upstream file, then compare. Nothing here is byte-identical to upstream any
more, so Prettier is free to format these files along with everything else.

Not ported: sponsors, Carbon ads, Algolia search, i18n/RTL, team pages, and the
bundled Inter web font (the site uses system fonts and makes no third-party
requests). Search is Zena-specific — see `../zena-components.css`.
