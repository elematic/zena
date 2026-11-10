/**
 * Keeps a package page's tab (`<rad-tab-group>` in
 * `registry:web/pages/package`) in the URL's fragment, `#readme`, `#files`,
 * `#dependencies` or `#versions`, so that a reload, a link or Back shows the
 * same tab. A fragment that names no tab, such as a heading in the README,
 * leaves the tabs as they are.
 */

import type {TabGroup} from '@radica/ui/components/tab-group/tab-group.js';

/** The tab group's panel names, which are its fragments. */
const panelsOf = (group: TabGroup): string[] =>
  [...group.querySelectorAll('rad-tab')].map(
    (tab) => tab.getAttribute('panel') ?? '',
  );

/** Shows the tab the fragment names, if it names one. */
const showFragment = (group: TabGroup) => {
  const name = location.hash.slice(1);
  if (panelsOf(group).includes(name)) {
    group.show(name);
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
  showFragment(group);
  addEventListener('hashchange', () => showFragment(group));
  addEventListener('popstate', () => showFragment(group));
  group.addEventListener('tab-change', (event) => {
    const tab = event.target as Element;
    const name = tab.getAttribute('panel');
    if (tab.hasAttribute('active') && name && location.hash !== `#${name}`) {
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
