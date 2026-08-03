import {BehaviorElement} from './light-element.js';

const PAGE_OFFSET = 71;

/**
 * Highlights the current section in the right-hand "On this page" rail and
 * slides the brand-coloured marker to it.
 *
 * Port of VitePress's `useActiveAnchor` composable: rather than an
 * IntersectionObserver (which fires per-heading and gets confused by short
 * sections), it recomputes on scroll from the headings' positions, which is
 * what makes the highlight track long and short sections alike.
 */
export class ZenaOutline extends BehaviorElement {
  #marker!: HTMLElement | null;
  #links!: HTMLAnchorElement[];
  #headings: HTMLElement[] = [];
  #prevActive: HTMLAnchorElement | null = null;

  connectedCallback(): void {
    const signal = this.disconnectedSignal;

    this.#marker = this.querySelector('.outline-marker');
    this.#links = [
      ...this.querySelectorAll<HTMLAnchorElement>('.outline-link'),
    ];
    this.#headings = this.#links
      .map((a) => document.getElementById(decodeURIComponent(a.hash.slice(1))))
      .filter((el): el is HTMLElement => el !== null);

    if (this.#headings.length === 0) return;

    const onScroll = () => this.#update();
    window.addEventListener('scroll', onScroll, {passive: true, signal});
    window.addEventListener('resize', onScroll, {passive: true, signal});
    requestAnimationFrame(onScroll);
  }

  #update(): void {
    const scrollY = window.scrollY;
    const innerHeight = window.innerHeight;
    const offsetHeight = document.body.offsetHeight;
    const atBottom = Math.abs(scrollY + innerHeight - offsetHeight) < 1;

    let active: HTMLElement | undefined;

    if (atBottom) {
      // Anything else would leave the last heading unreachable.
      active = this.#headings[this.#headings.length - 1];
    } else {
      for (const heading of this.#headings) {
        if (heading.getBoundingClientRect().top > PAGE_OFFSET) break;
        active = heading;
      }
      active ??= this.#headings[0];
    }

    const link =
      this.#links.find(
        (a) => decodeURIComponent(a.hash.slice(1)) === active!.id,
      ) ?? null;

    if (link === this.#prevActive) return;
    this.#prevActive?.classList.remove('active');
    link?.classList.add('active');
    this.#prevActive = link;

    if (this.#marker) {
      if (link) {
        this.#marker.style.top = `${link.offsetTop + 39}px`;
        this.#marker.style.opacity = '1';
      } else {
        this.#marker.style.opacity = '0';
      }
    }
  }
}

customElements.define('zena-outline', ZenaOutline);

declare global {
  interface HTMLElementTagNameMap {
    'zena-outline': ZenaOutline;
  }
}
