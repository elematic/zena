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

    this.addEventListener(
      'click',
      (e) => {
        const target = e.target as HTMLElement;
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
