import type {ZenaPlayground} from '@zena-lang/playground';
import {BehaviorElement} from './light-element.js';

let examplePlaygroundCount = 0;

interface ExampleItem {
  id: string;
  title: string;
  files: Record<string, string>;
  currentFiles: Record<string, string>;
}

function unindent(text: string): string {
  const lines = text.split('\n');
  while (lines.length > 0 && lines[0].trim() === '') {
    lines.shift();
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  if (lines.length === 0) return '';

  let minIndent = Infinity;
  for (const line of lines) {
    if (line.trim().length > 0) {
      const match = line.match(/^[ \t]*/);
      const indent = match ? match[0].length : 0;
      if (indent < minIndent) minIndent = indent;
    }
  }

  if (minIndent !== Infinity && minIndent > 0) {
    return lines
      .map((line) => (line.length >= minIndent ? line.slice(minIndent) : line))
      .join('\n');
  }
  return lines.join('\n');
}

/**
 * An interactive example playground with desktop vertical sidebar navigation
 * and mobile dropdown selection.
 *
 * Authored in Markdown with child `<figure>` blocks, each containing a `<figcaption>`
 * and one or more code blocks or `<script type="sample/zena">` tags:
 *
 * ```html
 * <zena-example-playground>
 *   <figure>
 *     <figcaption>Functions</figcaption>
 *     ```zena
 *     export function main() { console.log('Hello'); }
 *     ```
 *   </figure>
 * </zena-example-playground>
 * ```
 */
export class ZenaExamplePlayground extends BehaviorElement {
  #upgraded = false;
  private examples: ExampleItem[] = [];
  private activeIndex = 0;

  connectedCallback(): void {
    if (this.#upgraded) return;

    const figures = [...this.querySelectorAll<HTMLElement>(':scope > figure')];
    if (figures.length === 0) return;
    this.#upgraded = true;

    const signal = this.disconnectedSignal;
    const id = `example-pg-${examplePlaygroundCount++}`;

    // Extract all example definitions
    this.examples = figures.map((figure, i) => {
      const caption = figure.querySelector('figcaption');
      const title = caption?.textContent?.trim() || `Example ${i + 1}`;

      const sampleScripts = Array.from(
        figure.querySelectorAll<HTMLScriptElement>('script[type^="sample/"]'),
      );

      const files: Record<string, string> = {};
      if (sampleScripts.length > 0) {
        for (let sIdx = 0; sIdx < sampleScripts.length; sIdx++) {
          const script = sampleScripts[sIdx];
          const filename =
            script.getAttribute('filename') ||
            (sIdx === 0 ? 'main.zena' : `file_${sIdx}.zena`);
          files[filename] = unindent(script.textContent ?? '');
        }
      } else {
        const codeEl =
          figure.querySelector('pre code') ?? figure.querySelector('code');
        const rawCode = codeEl?.textContent ?? '';
        files['main.zena'] = unindent(rawCode);
      }

      // Hide static figures so only the upgraded playground is displayed
      figure.setAttribute('hidden', '');
      figure.style.display = 'none';

      return {
        id: `${id}-ex-${i}`,
        title,
        files: {...files},
        currentFiles: {...files},
      };
    });

    const wrapper = document.createElement('div');
    wrapper.className = 'example-playground-wrapper';

    // Mobile / narrow dropdown selector
    const dropdownWrapper = document.createElement('div');
    dropdownWrapper.className = 'example-selector-dropdown';

    const selectLabel = document.createElement('label');
    selectLabel.className = 'example-select-label';
    selectLabel.htmlFor = `${id}-select`;
    selectLabel.textContent = 'Example:';

    const selectContainer = document.createElement('div');
    selectContainer.className = 'example-select-container';

    const select = document.createElement('select');
    select.id = `${id}-select`;
    select.className = 'example-select';
    select.setAttribute('aria-label', 'Choose code example');

    this.examples.forEach((ex, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = ex.title;
      select.append(opt);
    });

    const selectIcon = document.createElement('span');
    selectIcon.className = 'example-select-icon';
    selectIcon.setAttribute('aria-hidden', 'true');
    selectIcon.innerHTML = '&#x25BE;';

    selectContainer.append(select, selectIcon);
    dropdownWrapper.append(selectLabel, selectContainer);

    // Desktop tabs sidebar list
    const tabsList = document.createElement('div');
    tabsList.className = 'example-selector-tabs';
    tabsList.setAttribute('role', 'tablist');
    tabsList.setAttribute('aria-orientation', 'vertical');
    tabsList.setAttribute('aria-label', 'Code examples');

    const tabs = this.examples.map((ex, i) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.id = `${id}-tab-${i}`;
      tab.className = 'example-tab-button';
      tab.setAttribute('role', 'tab');
      tab.textContent = ex.title;
      tab.setAttribute('aria-controls', `${id}-playground`);
      tabsList.append(tab);
      return tab;
    });

    // Playground container
    const playgroundPane = document.createElement('div');
    playgroundPane.className = 'example-playground-pane';

    const playground = document.createElement(
      'zena-playground',
    ) as ZenaPlayground;
    playground.id = `${id}-playground`;
    playground.setAttribute('vertical', '');
    playground.setAttribute('tabs', 'auto');
    playgroundPane.append(playground);

    wrapper.append(dropdownWrapper, tabsList, playgroundPane);
    this.append(wrapper);

    const selectExample = (index: number) => {
      if (index < 0 || index >= this.examples.length) return;
      this.activeIndex = index;

      tabs.forEach((tab, i) => {
        const isSelected = i === index;
        tab.setAttribute('aria-selected', String(isSelected));
        tab.tabIndex = isSelected ? 0 : -1;
      });

      select.value = String(index);

      const activeExample = this.examples[index];
      if (activeExample) {
        playground.files = {...activeExample.currentFiles};
        playground.clearConsole();
      }
    };

    // Track user edits per example
    playground.addEventListener(
      'files-changed',
      (e: Event) => {
        const customEvent = e as CustomEvent<{
          files?: Array<{name: string; content: string}>;
        }>;
        const currentExample = this.examples[this.activeIndex];
        if (currentExample && customEvent.detail?.files) {
          const fileMap: Record<string, string> = {};
          for (const f of customEvent.detail.files) {
            fileMap[f.name] = f.content;
          }
          currentExample.currentFiles = fileMap;
        }
      },
      {signal},
    );

    // Tab list events
    tabsList.addEventListener(
      'click',
      (e) => {
        const tab = (e.target as HTMLElement).closest('button');
        const index = tab ? tabs.indexOf(tab as HTMLButtonElement) : -1;
        if (index >= 0) selectExample(index);
      },
      {signal},
    );

    tabsList.addEventListener(
      'keydown',
      (e: KeyboardEvent) => {
        const current = this.activeIndex;
        let nextIndex = -1;

        if (e.key === 'ArrowDown') {
          nextIndex = (current + 1) % tabs.length;
        } else if (e.key === 'ArrowUp') {
          nextIndex = (current - 1 + tabs.length) % tabs.length;
        } else if (e.key === 'Home') {
          nextIndex = 0;
        } else if (e.key === 'End') {
          nextIndex = tabs.length - 1;
        }

        if (nextIndex >= 0) {
          e.preventDefault();
          selectExample(nextIndex);
          tabs[nextIndex]?.focus();
        }
      },
      {signal},
    );

    // Dropdown change event
    select.addEventListener(
      'change',
      () => {
        selectExample(Number(select.value));
      },
      {signal},
    );

    // Initialize with first example
    selectExample(0);
  }
}

customElements.define('zena-example-playground', ZenaExamplePlayground);

declare global {
  interface HTMLElementTagNameMap {
    'zena-example-playground': ZenaExamplePlayground;
  }
}
