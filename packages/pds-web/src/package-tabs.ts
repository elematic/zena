/**
 * Keeps a package page's tab (`<rad-tab-group>` in
 * `registry/web/pages/package`) in the URL's fragment, `#readme`, `#files`,
 * `#dependencies` or `#versions`, so that a reload, a link or Back shows the
 * same tab. A fragment that names an element in a tab, such as a heading
 * of the README, shows that tab and scrolls to it. A rendered Markdown
 * file's heading IDs start with `user-content-`, which a fragment may leave
 * out, as on GitHub.
 */

import type {TabGroup} from '@radica/ui/components/tab-group/tab-group.js';

/** The tab group's panel names, which are its fragments. */
const panelsOf = (group: TabGroup): string[] =>
  [...group.querySelectorAll('rad-tab')].map(
    (tab) => tab.getAttribute('panel') ?? '',
  );

/** What the IDs of a rendered Markdown file's headings start with (`registry/release-contents`). */
const ANCHOR_PREFIX = 'user-content-';

/** The element the fragment names, with or without `ANCHOR_PREFIX`, or null. */
const fragmentTarget = (): Element | null => {
  const name = decodeURIComponent(location.hash.slice(1));
  if (name === '') {
    return null;
  }
  return (
    document.getElementById(name) ??
    document.getElementById(`${ANCHOR_PREFIX}${name}`)
  );
};

/**
 * Shows the tab the fragment names, or the tab that holds the element it
 * names, and scrolls to that element.
 */
const showFragment = async (group: TabGroup) => {
  const name = decodeURIComponent(location.hash.slice(1));
  if (panelsOf(group).includes(name)) {
    group.show(name);
    return;
  }
  const target = fragmentTarget();
  const panel = target?.closest('rad-tab-panel')?.getAttribute('name');
  if (target && panel && group.contains(target)) {
    group.show(panel);
    await group.updateComplete;
    target.scrollIntoView();
  }
};

/**
 * Follows `group`: shows the fragment's tab now and when the fragment
 * changes, and writes the fragment when a tab is chosen. A `<rad-tab>`
 * fires `tab-change`, which bubbles, once its `active`, `panel` or
 * `disabled` has changed; Radica's declarations do not list it.
 */
const follow = async (group: TabGroup) => {
  await customElements.whenDefined('rad-tab-group');
  await group.updateComplete;
  void showFragment(group);
  addEventListener('hashchange', () => void showFragment(group));
  addEventListener('popstate', () => void showFragment(group));
  group.addEventListener('tab-change', (event) => {
    const tab = event.target as Element;
    const name = tab.getAttribute('panel');
    // A fragment that names an element in the tab, such as a heading, stays.
    const within = fragmentTarget()?.closest('rad-tab-panel');
    if (
      tab.hasAttribute('active') &&
      name &&
      location.hash !== `#${name}` &&
      within?.getAttribute('name') !== name
    ) {
      // A new history entry, so that Back returns to the tab before.
      history.pushState(null, '', `#${name}`);
    }
  });
};

for (const group of document.querySelectorAll<TabGroup>(
  'rad-tab-group[data-fragment]',
)) {
  void follow(group);
}
