import {BehaviorElement} from './light-element.js';

/**
 * Coordinates the mobile chrome: the hamburger nav screen, the slide-in
 * sidebar, and the backdrop that dismisses either of them.
 *
 * Wraps the whole `.layout` element and enhances markup Eleventy already
 * rendered, so the page is fully navigable with JS disabled — only the
 * mobile-only overlays need this element.
 */
export class ZenaLayout extends BehaviorElement {
  #sidebarOpen = false;
  #screenOpen = false;

  connectedCallback(): void {
    const signal = this.disconnectedSignal;

    this.#initDetailsAnchors();

    // If loaded with a hash in the URL, open matching details and scroll to it.
    if (window.location.hash) {
      setTimeout(() => this.#syncHashTarget(false), 50);
    }

    window.addEventListener('hashchange', () => this.#syncHashTarget(true), {
      signal,
    });
    window.addEventListener('popstate', () => this.#syncHashTarget(true), {
      signal,
    });

    // Update URL hash when a details element is opened or closed.
    this.addEventListener(
      'toggle',
      (e) => {
        const details = (e.target as HTMLElement)?.closest('details');
        if (!details || !details.id) return;

        if (details.open) {
          if (window.location.hash !== `#${details.id}`) {
            history.pushState(null, '', `#${details.id}`);
          }
        } else if (window.location.hash === `#${details.id}`) {
          history.replaceState(
            null,
            '',
            window.location.pathname + window.location.search,
          );
        }
      },
      {capture: true, signal},
    );

    this.addEventListener(
      'click',
      (e) => {
        const target = e.target as HTMLElement;
        const anchor = target.closest<HTMLAnchorElement>('a.header-anchor');
        if (anchor && anchor.closest('summary')) {
          const href = anchor.getAttribute('href');
          if (href?.startsWith('#')) {
            const id = decodeURIComponent(href.slice(1));
            const details = anchor.closest('details');
            if (details) {
              e.preventDefault();
              e.stopPropagation();
              details.open = true;
              if (window.location.hash !== `#${id}`) {
                history.pushState(null, '', `#${id}`);
              }
              details.scrollIntoView({behavior: 'smooth', block: 'start'});
            }
          }
          return;
        }

        if (target.closest('[data-toggle-sidebar]')) {
          this.#setSidebar(!this.#sidebarOpen);
        } else if (target.closest('[data-toggle-nav-screen]')) {
          this.#setScreen(!this.#screenOpen);
        } else if (target.closest('.backdrop')) {
          this.#setSidebar(false);
        } else if (target.closest('.sidebar a, .nav-screen a')) {
          this.#setSidebar(false);
          this.#setScreen(false);
        }
      },
      {signal},
    );

    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape') {
          this.#setSidebar(false);
          this.#setScreen(false);
        }
      },
      {signal},
    );

    // The desktop layout has no overlays; make sure we never leave the body
    // scroll-locked when the viewport grows.
    window
      .matchMedia('(min-width: 960px)')
      .addEventListener('change', (e) => e.matches && this.#setSidebar(false), {
        signal,
      });
    window
      .matchMedia('(min-width: 768px)')
      .addEventListener('change', (e) => e.matches && this.#setScreen(false), {
        signal,
      });

    // On the home page the nav bar is transparent until the page scrolls.
    const navBar = this.querySelector('.nav-bar.home');
    if (navBar) {
      const onScroll = () =>
        navBar.classList.toggle('top', window.scrollY === 0);
      window.addEventListener('scroll', onScroll, {passive: true, signal});
      onScroll();
    }
  }

  #initDetailsAnchors(): void {
    const detailsElements =
      this.querySelectorAll<HTMLDetailsElement>('details');
    for (const details of detailsElements) {
      const summary = details.querySelector('summary');
      if (!summary) continue;

      if (!details.id) {
        const clone = summary.cloneNode(true) as HTMLElement;
        clone
          .querySelectorAll('.badge, .header-anchor')
          .forEach((b) => b.remove());
        const slug = (clone.textContent ?? '')
          .trim()
          .toLowerCase()
          .replace(/&/g, 'and')
          .replace(/[^\w\s-]/g, '')
          .replace(/\s+/g, '-')
          .replace(/-+/g, '-');
        if (slug) details.id = slug;
      }

      if (details.id && !summary.querySelector('a.header-anchor')) {
        const anchor = document.createElement('a');
        anchor.className = 'header-anchor';
        anchor.href = `#${details.id}`;
        const titleText =
          summary.textContent?.replace(/[\s\n]+/g, ' ').trim() ?? details.id;
        anchor.setAttribute('aria-label', `Permalink to "${titleText}"`);
        anchor.innerHTML = '&ZeroWidthSpace;';
        summary.append(anchor);
      }
    }
  }

  #syncHashTarget(smooth = true): void {
    const hash = window.location.hash;
    if (!hash) return;
    const id = decodeURIComponent(hash.slice(1));
    if (!id) return;
    const el = document.getElementById(id);
    if (!el) return;

    let current: HTMLElement | null = el;
    while (current && current !== this) {
      if (current instanceof HTMLDetailsElement) {
        if (!current.open) {
          current.open = true;
        }
      }
      current = current.parentElement;
    }

    requestAnimationFrame(() => {
      el.scrollIntoView({
        block: 'start',
        behavior: smooth ? 'smooth' : 'auto',
      });
    });
  }

  #setSidebar(open: boolean): void {
    if (open === this.#sidebarOpen) return;
    this.#sidebarOpen = open;

    const sidebar = this.querySelector('.sidebar');
    sidebar?.classList.toggle('open', open);
    this.querySelector('[data-toggle-sidebar]')?.setAttribute(
      'aria-expanded',
      String(open),
    );
    if (open) (sidebar as HTMLElement | null)?.focus();

    this.#syncBackdrop();
  }

  #setScreen(open: boolean): void {
    if (open === this.#screenOpen) return;
    this.#screenOpen = open;

    this.querySelector('.nav-screen')?.classList.toggle('open', open);
    this.querySelector('.nav-bar')?.classList.toggle('screen-open', open);
    const hamburger = this.querySelector('[data-toggle-nav-screen]');
    hamburger?.classList.toggle('active', open);
    hamburger?.setAttribute('aria-expanded', String(open));

    this.#syncBackdrop();
  }

  #syncBackdrop(): void {
    const anyOpen = this.#sidebarOpen || this.#screenOpen;
    this.querySelector('.backdrop')?.classList.toggle('open', anyOpen);
    document.documentElement.classList.toggle('scroll-locked', anyOpen);
  }
}

customElements.define('zena-layout', ZenaLayout);

declare global {
  interface HTMLElementTagNameMap {
    'zena-layout': ZenaLayout;
  }
}
