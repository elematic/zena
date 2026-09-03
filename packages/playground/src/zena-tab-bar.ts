import {html, css, nothing, type PropertyValues} from 'lit';
import {customElement, property, state} from 'lit/decorators.js';
import '@radica/ui/components/tab-group/tab-group.js';
import '@radica/ui/components/tab/tab.js';
import '@radica/ui/components/tab-panel/tab-panel.js';
import '@radica/ui/components/button/button.js';
import '@radica/ui/components/icon-button/icon-button.js';
import '@radica/bootstrap-icons/icons/plus-lg.svg.js';
import '@radica/bootstrap-icons/icons/layout-sidebar.svg.js';
import '@radica/ui/components/dialog/dialog.js';
import './zena-theme-selector.js';
import {PlaygroundConnectedElement} from './connected-element.js';

/**
 * A tab bar displaying files for a `<zena-project>`.
 *
 * Allows switching between files, creating new files (+), renaming tabs
 * (double-click), closing/deleting files, and selecting the editor theme.
 *
 * ```html
 * <zena-tab-bar project="my-project"></zena-tab-bar>
 * ```
 */
@customElement('zena-tab-bar')
export class ZenaTabBar extends PlaygroundConnectedElement {
  static override styles = css`
    :host {
      display: block;
      background: var(--rad-surface-chrome);
      border-bottom: 1px solid var(--rad-neutral-stroke-faint);
      box-sizing: border-box;
    }

    .tabs-header {
      display: flex;
      align-items: stretch;
      justify-content: space-between;
      width: 100%;
      height: 40px;
      min-height: 40px;
      max-height: 40px;
      box-sizing: border-box;
      padding-right: 8px;
    }

    .tabs-header ::slotted([slot='start']) {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      align-self: center;
      margin-left: 6px;
      margin-right: 2px;
      flex-shrink: 0;
    }

    rad-tab-group {
      flex: 1;
      min-width: 0;
      height: 40px;
      --track-color: transparent;
      --indicator-color: var(--zena-c-brand-1, var(--rad-primary-fill-solid));
      --track-width: 2px;
    }

    rad-tab-group::part(tab-bar),
    rad-tab-group::part(tabs) {
      height: 40px;
      box-sizing: border-box;
    }

    rad-tab {
      height: 40px;
      box-sizing: border-box;
      padding: 0 14px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      font-weight: 500;
      color: var(--rad-neutral-text-muted);
      border-radius: 0;
      transition:
        color 0.15s ease,
        background-color 0.15s ease;
    }

    rad-tab:hover:not([disabled]) {
      color: var(--rad-neutral-text-normal);
    }

    rad-tab[active] {
      color: var(--zena-c-brand-1, var(--rad-primary-fill-solid));
    }

    rad-tab-group::part(body),
    rad-tab-panel {
      display: none !important;
    }

    rad-tab::part(close-button) {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      line-height: 1;
      height: 18px;
      width: 18px;
      margin-left: 6px;
      opacity: 0;
      transition: opacity 0.15s ease-in-out;
    }

    rad-tab[active]::part(close-button),
    rad-tab:hover::part(close-button),
    rad-tab:focus-within::part(close-button) {
      opacity: 0.7;
    }

    rad-tab::part(close-button):hover {
      opacity: 1;
    }

    rad-tab::part(close-button__button) {
      height: 18px !important;
      width: 18px !important;
      min-height: 0 !important;
      line-height: 1 !important;
      padding: 0 !important;
    }

    .tab-rename-input {
      background: var(--rad-color-surface-sunken, rgba(0, 0, 0, 0.4));
      border: 1px solid var(--rad-color-border-focused, #38bdf8);
      border-radius: var(--rad-border-radius-small, 4px);
      color: var(--rad-neutral-text-normal, #f1f5f9);
      font-family: inherit;
      font-size: 13px;
      line-height: 1.2;
      padding: 1px 6px;
      outline: none;
      width: 100px;
      box-shadow: 0 0 0 1px
        var(--rad-primary-fill-subtle, rgba(56, 189, 248, 0.3));
    }

    .tab-label {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
    }

    .tab-badge {
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
    }

    .tab-badge-error {
      background-color: var(--rad-danger-text-normal, #ef4444);
      box-shadow: 0 0 6px var(--rad-danger-text-normal, rgba(239, 68, 68, 0.7));
    }

    .tab-badge-warning {
      background-color: var(--rad-warning-text-normal, #f59e0b);
      box-shadow: 0 0 6px
        var(--rad-warning-text-normal, rgba(245, 158, 11, 0.7));
    }

    .btn-add-file {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      align-self: center;
      margin-left: 2px;
      margin-right: 4px;
      height: 28px;
      width: 28px;
      color: var(--rad-neutral-text-muted, #94a3b8);
    }

    .btn-add-file:hover {
      color: var(--rad-neutral-text-normal, #f1f5f9);
    }

    .tabs-controls {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
      height: 100%;
    }
  `;

  /** Whether the user can create, rename, or delete files. */
  @property({type: Boolean, attribute: 'editable-file-system'})
  editableFileSystem = true;

  /** Selected CodeMirror theme name. */
  @property({type: String})
  theme = 'one-dark';

  /** Whether to show the theme selection dropdown (opt-in). */
  @property({type: Boolean, attribute: 'show-theme-selector'})
  showThemeSelector = false;

  @state()
  private editingTab: string | null = null;

  @state()
  private editingName = '';

  @state()
  private deleteTargetFile: string | null = null;

  override firstUpdated() {
    requestAnimationFrame(() => {
      const activeFile = this.projectElement?.activeFile;
      if (activeFile) {
        const tabGroup = this.shadowRoot?.querySelector('rad-tab-group') as {
          show?: (name: string) => void;
        } | null;
        if (tabGroup && typeof tabGroup.show === 'function') {
          tabGroup.show(activeFile);
        }
      }
    });
  }

  override updated(changedProperties: PropertyValues) {
    super.updated(changedProperties);
    const activeFile = this.projectElement?.activeFile;
    if (activeFile) {
      const tabGroup = this.shadowRoot?.querySelector('rad-tab-group') as {
        show?: (name: string) => void;
      } | null;
      if (tabGroup && typeof tabGroup.show === 'function') {
        tabGroup.show(activeFile);
      }
    }
  }

  private selectFile(filename: string) {
    this.projectElement?.selectFile(filename);
  }

  private onTabGroupClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const tab = target.closest('rad-tab');
    if (tab && tab.panel) {
      this.selectFile(tab.panel);
    }
  };

  private addFile = () => {
    const project = this.projectElement;
    if (!project) return;
    const all = project.getAllFiles();
    let num = 1;
    let newName = `file${num}.zena`;
    while (all[newName] !== undefined) {
      num++;
      newName = `file${num}.zena`;
    }
    project.addFile(newName, `// ${newName}\nexport let hello = () => {\n};\n`);
  };

  private onThemeChange = (e: CustomEvent<{theme: string}>) => {
    if (e.detail?.theme) {
      this.theme = e.detail.theme;
      this.dispatchEvent(
        new CustomEvent('theme-change', {
          detail: {theme: this.theme},
          bubbles: true,
          composed: true,
        }),
      );
    }
  };

  private startEditingTab(filename: string) {
    if (!this.editableFileSystem || filename === 'main.zena') return;
    this.editingTab = filename;
    this.editingName = filename;
    this.updateComplete.then(() => {
      const input = this.shadowRoot?.querySelector(
        '.tab-rename-input',
      ) as HTMLInputElement | null;
      if (input) {
        input.focus();
        input.select();
      }
    });
  }

  private commitRename(oldFilename: string) {
    const newFilename = this.editingName.trim();
    this.editingTab = null;
    this.editingName = '';
    if (!newFilename || newFilename === oldFilename) return;
    this.projectElement?.renameFile(oldFilename, newFilename);
  }

  private cancelRename() {
    this.editingTab = null;
    this.editingName = '';
  }

  private requestCloseFile(filename: string, e: Event) {
    e.stopPropagation();
    e.preventDefault();
    if (!this.editableFileSystem || filename === 'main.zena') return;
    this.deleteTargetFile = filename;
  }

  private executeDeleteFile = () => {
    const filename = this.deleteTargetFile;
    this.deleteTargetFile = null;
    if (!filename || filename === 'main.zena') return;
    this.projectElement?.deleteFile(filename);
  };

  override render() {
    const project = this.projectElement;
    const files = (project?.files ?? []).filter((f) => !f.hidden);
    const activeFile = project?.activeFile ?? files[0]?.name ?? 'main.zena';

    return html`
      <div class="tabs-header">
        <slot name="start"></slot>
        <rad-tab-group @click=${this.onTabGroupClick}>
          ${files.map((file) => {
            const filename = file.name;
            const fileDiags = project?.getFileDiagnostics(filename) ?? [];
            const errorCount = fileDiags.filter(
              (d) => d.severity === 'error',
            ).length;
            const warningCount = fileDiags.filter(
              (d) => d.severity === 'warning',
            ).length;
            const closable =
              this.editableFileSystem &&
              filename !== 'main.zena' &&
              files.length > 1;

            return html`
              <rad-tab
                slot="tabs"
                panel=${filename}
                ?active=${activeFile === filename}
                ?closable=${closable}
                @close=${(e: Event) => this.requestCloseFile(filename, e)}
                @dblclick=${(e: MouseEvent) => {
                  e.stopPropagation();
                  this.startEditingTab(filename);
                }}
              >
                ${this.editingTab === filename
                  ? html`
                      <input
                        class="tab-rename-input"
                        .value=${this.editingName}
                        @click=${(e: MouseEvent) => e.stopPropagation()}
                        @dblclick=${(e: MouseEvent) => e.stopPropagation()}
                        @input=${(e: InputEvent) => {
                          this.editingName = (
                            e.target as HTMLInputElement
                          ).value;
                        }}
                        @keydown=${(e: KeyboardEvent) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            e.stopPropagation();
                            this.commitRename(filename);
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            e.stopPropagation();
                            this.cancelRename();
                          }
                        }}
                        @blur=${() => this.commitRename(filename)}
                      />
                    `
                  : html`
                      <span class="tab-label">
                        ${file.label ?? filename}
                        ${errorCount > 0
                          ? html`<span
                              class="tab-badge tab-badge-error"
                              title="${errorCount} error${errorCount === 1
                                ? ''
                                : 's'}"
                            ></span>`
                          : warningCount > 0
                            ? html`<span
                                class="tab-badge tab-badge-warning"
                                title="${warningCount} warning${warningCount ===
                                1
                                  ? ''
                                  : 's'}"
                              ></span>`
                            : nothing}
                      </span>
                    `}
              </rad-tab>
            `;
          })}
          ${this.editableFileSystem
            ? html`
                <rad-icon-button
                  class="btn-add-file"
                  slot="tabs"
                  icon-name="plus-lg"
                  size="small"
                  variant="text"
                  @click=${this.addFile}
                  title="Add file"
                ></rad-icon-button>
              `
            : nothing}
          ${files.map(
            (file) => html` <rad-tab-panel name=${file.name}></rad-tab-panel> `,
          )}
        </rad-tab-group>

        <div class="tabs-controls">
          <slot name="actions"></slot>
          ${this.showThemeSelector
            ? html`
                <zena-theme-selector
                  .theme=${this.theme}
                  @theme-change=${this.onThemeChange}
                ></zena-theme-selector>
              `
            : nothing}
        </div>
      </div>

      <rad-dialog
        ?open=${this.deleteTargetFile !== null}
        title="Delete File"
        @close=${() => (this.deleteTargetFile = null)}
      >
        <p
          style="margin: 0; font-size: 14px; line-height: 1.5; color: var(--rad-on-surface-overlay, var(--rad-neutral-text-normal, #cbd5e1));"
        >
          Are you sure you want to delete
          <strong>${this.deleteTargetFile}</strong>?
        </p>
        <div
          slot="footer"
          style="display: flex; justify-content: flex-end; gap: 8px;"
        >
          <rad-button @click=${() => (this.deleteTargetFile = null)}
            >Cancel</rad-button
          >
          <rad-button variant="danger" @click=${this.executeDeleteFile}
            >Delete</rad-button
          >
        </div>
      </rad-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'zena-tab-bar': ZenaTabBar;
  }
}
