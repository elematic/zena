import {BehaviorElement} from './light-element.js';

let carouselCount = 0;

interface SlideItem {
  figure: HTMLElement;
  title: string;
}

/**
 * An interactive code carousel component for highlighting code samples.
 *
 * Authored in Markdown with child `<figure>` blocks:
 * ```html
 * <zena-code-carousel>
 *   <figure>
 *     <figcaption>Pattern matching</figcaption>
 *     ```zena
 *     sealed class Shape { ... }
 *     ```
 *     <div class="carousel-output">
 *       <div class="output-label">Output</div>
 *       <pre><code>&rarr; Area: 314.159</code></pre>
 *     </div>
 *   </figure>
 * </zena-code-carousel>
 * ```
 */
export class ZenaCodeCarousel extends BehaviorElement {
  #upgraded = false;
  private slides: SlideItem[] = [];
  private activeIndex = 0;

  connectedCallback(): void {
    if (this.#upgraded) return;

    const figures = [...this.querySelectorAll<HTMLElement>(':scope > figure')];
    if (figures.length === 0) return;
    this.#upgraded = true;

    const signal = this.disconnectedSignal;
    const id = `code-carousel-${carouselCount++}`;

    // Extract slide metadata and structure
    this.slides = figures.map((figure, i) => {
      const caption = figure.querySelector('figcaption');
      const title = caption?.textContent?.trim() || `Example ${i + 1}`;

      figure.id = `${id}-slide-${i}`;
      figure.setAttribute('role', 'group');
      figure.setAttribute('aria-roledescription', 'slide');
      figure.setAttribute(
        'aria-label',
        `${i + 1} of ${figures.length}: ${title}`,
      );

      return {figure, title};
    });

    // Build the top header with slide title and navigation controls
    const header = document.createElement('div');
    header.className = 'carousel-header';

    const titleEl = document.createElement('div');
    titleEl.className = 'carousel-title';
    titleEl.setAttribute('aria-live', 'polite');

    const controls = document.createElement('div');
    controls.className = 'carousel-controls';

    // Dots indicator
    const dotsContainer = document.createElement('div');
    dotsContainer.className = 'carousel-dots';
    dotsContainer.setAttribute('role', 'tablist');
    dotsContainer.setAttribute('aria-label', 'Code example slides');

    const dots = this.slides.map((slide, i) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'carousel-dot';
      dot.setAttribute('role', 'tab');
      dot.setAttribute('aria-label', `Go to slide ${i + 1}: ${slide.title}`);
      dot.setAttribute('aria-controls', slide.figure.id);
      dot.addEventListener(
        'click',
        () => {
          this.goToSlide(i);
        },
        {signal},
      );
      dotsContainer.append(dot);
      return dot;
    });

    // Prev / Next arrow buttons
    const prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'carousel-nav-btn carousel-prev';
    prevBtn.setAttribute('aria-label', 'Previous code example');
    prevBtn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="15 18 9 12 15 6"></polyline>
      </svg>
    `;

    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'carousel-nav-btn carousel-next';
    nextBtn.setAttribute('aria-label', 'Next code example');
    nextBtn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="9 18 15 12 9 6"></polyline>
      </svg>
    `;

    prevBtn.addEventListener(
      'click',
      () => {
        this.prev();
      },
      {signal},
    );

    nextBtn.addEventListener(
      'click',
      () => {
        this.next();
      },
      {signal},
    );

    controls.append(dotsContainer, prevBtn, nextBtn);
    header.append(titleEl, controls);
    this.prepend(header);

    // Keyboard navigation on carousel container
    this.tabIndex = 0;
    this.setAttribute('role', 'region');
    this.setAttribute('aria-label', 'Zena code features carousel');

    this.addEventListener(
      'keydown',
      (e: KeyboardEvent) => {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          this.prev();
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          this.next();
        }
      },
      {signal},
    );

    // Touch swipe support
    let touchStartX = 0;
    let touchStartY = 0;

    this.addEventListener(
      'touchstart',
      (e: TouchEvent) => {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
      },
      {passive: true, signal},
    );

    this.addEventListener(
      'touchend',
      (e: TouchEvent) => {
        const touchEndX = e.changedTouches[0].clientX;
        const touchEndY = e.changedTouches[0].clientY;
        const diffX = touchEndX - touchStartX;
        const diffY = touchEndY - touchStartY;

        // Ensure horizontal swipe is dominant and above threshold
        if (Math.abs(diffX) > 40 && Math.abs(diffX) > Math.abs(diffY) * 1.5) {
          if (diffX < 0) {
            this.next();
          } else {
            this.prev();
          }
        }
      },
      {passive: true, signal},
    );

    // Initialize slide 0
    this.goToSlide(0);
  }

  public next(): void {
    if (this.slides.length === 0) return;
    const nextIndex = (this.activeIndex + 1) % this.slides.length;
    this.goToSlide(nextIndex);
  }

  public prev(): void {
    if (this.slides.length === 0) return;
    const prevIndex =
      (this.activeIndex - 1 + this.slides.length) % this.slides.length;
    this.goToSlide(prevIndex);
  }

  public goToSlide(index: number): void {
    if (index < 0 || index >= this.slides.length) return;
    this.activeIndex = index;

    const currentSlide = this.slides[index];

    // Update title
    const titleEl = this.querySelector('.carousel-title');
    if (titleEl && currentSlide) {
      titleEl.textContent = currentSlide.title;
    }

    // Update slides visibility
    this.slides.forEach((slide, i) => {
      const isActive = i === index;
      slide.figure.classList.toggle('active', isActive);
      slide.figure.toggleAttribute('hidden', !isActive);
      slide.figure.setAttribute('aria-hidden', String(!isActive));
    });

    // Update dots
    const dots = this.querySelectorAll<HTMLButtonElement>('.carousel-dot');
    dots.forEach((dot, i) => {
      const isSelected = i === index;
      dot.classList.toggle('active', isSelected);
      dot.setAttribute('aria-selected', String(isSelected));
      dot.tabIndex = isSelected ? 0 : -1;
    });
  }
}

customElements.define('zena-code-carousel', ZenaCodeCarousel);

declare global {
  interface HTMLElementTagNameMap {
    'zena-code-carousel': ZenaCodeCarousel;
  }
}
