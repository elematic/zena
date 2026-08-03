import {BehaviorElement} from './light-element.js';

/**
 * The "On this page" dropdown in the sticky local nav, shown on narrow
 * viewports where the right-hand rail is hidden.
 */
export class ZenaLocalOutline extends BehaviorElement {
  #open = false;

  connectedCallback(): void {
    const signal = this.disconnectedSignal;
    const button = this.querySelector<HTMLButtonElement>('button');

    button?.addEventListener('click', () => this.#setOpen(!this.#open), {
      signal,
    });

    document.addEventListener(
      'click',
      (e) => {
        if (this.#open && !this.contains(e.target as Node))
          this.#setOpen(false);
      },
      {signal},
    );

    document.addEventListener(
      'keydown',
      (e) => e.key === 'Escape' && this.#setOpen(false),
      {signal},
    );

    this.querySelector('.items')?.addEventListener(
      'click',
      (e) => {
        const target = e.target as HTMLElement;
        if (target.classList.contains('outline-link')) this.#setOpen(false);
        if (target.classList.contains('top-link')) {
          e.preventDefault();
          window.scrollTo({top: 0, behavior: 'smooth'});
          this.#setOpen(false);
        }
      },
      {signal},
    );
  }

  #setOpen(open: boolean): void {
    this.#open = open;
    const button = this.querySelector('button');
    button?.classList.toggle('open', open);
    button?.setAttribute('aria-expanded', String(open));
    this.querySelector('.items')?.toggleAttribute('hidden', !open);

    if (open) {
      const navHeight = parseInt(
        getComputedStyle(document.documentElement).getPropertyValue(
          '--vp-nav-height',
        ),
      );
      const vh = window.innerHeight + Math.min(window.scrollY - navHeight, 0);
      this.style.setProperty('--vp-vh', `${vh}px`);
    }
  }
}

customElements.define('zena-local-outline', ZenaLocalOutline);

declare global {
  interface HTMLElementTagNameMap {
    'zena-local-outline': ZenaLocalOutline;
  }
}
