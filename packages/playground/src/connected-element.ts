import {LitElement, type PropertyValues} from 'lit';
import {property} from 'lit/decorators.js';
import type {ZenaProject} from './zena-project.js';

/**
 * Base element for playground components that connect to a `<zena-project>`.
 *
 * Automatically resolves its project element by ID, instance reference,
 * shadow DOM lookup, or ancestor DOM lookup, and re-renders when project
 * state changes.
 */
export class PlaygroundConnectedElement extends LitElement {
  /**
   * The `<zena-project>` instance or the `id` of a `<zena-project>` to connect to.
   * If omitted, looks for an ancestor or sibling `<zena-project>`.
   */
  @property()
  project?: string | ZenaProject;

  private _resolvedProject?: ZenaProject;
  private _boundOnProjectUpdate = () => this.onProjectUpdate();

  get projectElement(): ZenaProject | undefined {
    if (this.project && typeof this.project === 'object') {
      return this.project;
    }
    return this._resolvedProject ?? this.resolveProject();
  }

  private resolveProject(): ZenaProject | undefined {
    if (this.project && typeof this.project === 'object') {
      return this.project;
    }
    const root = this.getRootNode() as Document | ShadowRoot | null;
    if (typeof this.project === 'string') {
      const el = root?.getElementById
        ? root.getElementById(this.project)
        : typeof document !== 'undefined'
          ? document.getElementById(this.project)
          : null;
      return (el as ZenaProject | null) ?? undefined;
    }
    const closest = this.closest('zena-project');
    if (closest) {
      return closest as ZenaProject;
    }
    if (root instanceof ShadowRoot) {
      const inShadow = root.querySelector('zena-project');
      if (inShadow) {
        return inShadow as ZenaProject;
      }
    }
    return undefined;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.updateProjectSubscription();
  }

  override firstUpdated(changedProperties: PropertyValues) {
    super.firstUpdated(changedProperties);
    this.updateProjectSubscription();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.cleanupProjectSubscription();
  }

  override updated(changedProperties: PropertyValues) {
    super.updated(changedProperties);
    if (changedProperties.has('project')) {
      this.updateProjectSubscription();
    }
  }

  private updateProjectSubscription() {
    const current = this.resolveProject();
    if (current === this._resolvedProject) return;

    this.cleanupProjectSubscription();
    this._resolvedProject = current;

    if (this._resolvedProject) {
      this._resolvedProject.addEventListener(
        'files-changed',
        this._boundOnProjectUpdate,
      );
      this._resolvedProject.addEventListener(
        'diagnostics-changed',
        this._boundOnProjectUpdate,
      );
      this._resolvedProject.addEventListener(
        'console-changed',
        this._boundOnProjectUpdate,
      );
      this._resolvedProject.addEventListener(
        'status-changed',
        this._boundOnProjectUpdate,
      );
      this.requestUpdate();
    }
  }

  private cleanupProjectSubscription() {
    if (this._resolvedProject) {
      this._resolvedProject.removeEventListener(
        'files-changed',
        this._boundOnProjectUpdate,
      );
      this._resolvedProject.removeEventListener(
        'diagnostics-changed',
        this._boundOnProjectUpdate,
      );
      this._resolvedProject.removeEventListener(
        'console-changed',
        this._boundOnProjectUpdate,
      );
      this._resolvedProject.removeEventListener(
        'status-changed',
        this._boundOnProjectUpdate,
      );
      this._resolvedProject = undefined;
    }
  }

  /**
   * Called whenever the connected project updates. Default requests update.
   */
  protected onProjectUpdate() {
    this.requestUpdate();
  }
}
