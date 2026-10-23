import {html, css, type PropertyValues} from 'lit';
import {customElement, property, query} from 'lit/decorators.js';
import {wrap, type Remote} from 'supertalk';
import {PlaygroundConnectedElement} from './connected-element.js';
import type {ZenaProject} from './zena-project.js';
import {
  CONFIGURE_PROXY,
  CONNECT_PROJECT_TO_SW,
  UPDATE_SERVICE_WORKER,
  type ProxyMessage,
} from './preview-shared/proxy-api.js';
import {
  type HttpError,
  type ServiceWorkerAPI,
  type VirtualFile,
} from './preview-shared/service-worker-api.js';
import {serviceWorkerHash} from './preview-shared/versions.js';

/**
 * Sandboxed preview iframe element for Zena web projects.
 *
 * Connects to a `<zena-project>` and serves its files (`.html`, `.js`, `.css`,
 * and on-demand compiled `.wasm` from `.zena` files) through a Service Worker.
 *
 * ```html
 * <zena-preview project="my-project"></zena-preview>
 * ```
 */
@customElement('zena-preview')
export class ZenaPreview extends PlaygroundConnectedElement {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      min-height: 0;
      box-sizing: border-box;
      background: #ffffff;
    }

    #proxy {
      display: none !important;
    }

    #preview {
      flex: 1;
      width: 100%;
      height: 100%;
      border: none;
      background: #ffffff;
    }
  `;

  /**
   * Base URL for the preview sandbox origin and service worker files.
   * Defaults to `/sandbox/`.
   */
  @property({type: String, attribute: 'sandbox-base-url'})
  sandboxBaseUrl = '/sandbox/';

  /**
   * Optional explicit entry HTML filename. If omitted, uses the project's
   * single `.html` file or `index.html`.
   */
  @property({type: String, attribute: 'html-file'})
  htmlFile?: string;

  @query('#proxy')
  private proxyIframe!: HTMLIFrameElement;

  @query('#preview')
  private previewIframe!: HTMLIFrameElement;

  #sessionId = `${Math.floor(Math.random() * 2 ** 52)}-${Date.now()}`;
  #serviceWorkerAPI?: Remote<ServiceWorkerAPI>;
  #proxyPort?: MessagePort;
  #swReady = false;
  #initialLoadDone = false;

  #boundOnReloadPreview = () => {
    this.reload();
  };

  #boundOnWindowMessage = (e: MessageEvent) => {
    const data = e.data;
    if (
      data &&
      data.type === 'zena-preview-console' &&
      data.sessionId === this.#sessionId &&
      typeof data.message === 'string'
    ) {
      const level =
        data.level === 'warn' || data.level === 'error' || data.level === 'info'
          ? data.level
          : 'log';
      this.projectElement?.addConsoleLog(level, data.message);
    }
  };

  override connectedCallback() {
    super.connectedCallback();
    if (typeof window !== 'undefined') {
      window.addEventListener('message', this.#boundOnWindowMessage);
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (typeof window !== 'undefined') {
      window.removeEventListener('message', this.#boundOnWindowMessage);
    }
  }

  get #normalizedSandboxUrl(): URL {
    const base =
      typeof window !== 'undefined'
        ? window.location.href
        : 'http://localhost/';
    const url = new URL(this.sandboxBaseUrl, base);
    if (!url.pathname.endsWith('/')) {
      url.pathname += '/';
    }
    return url;
  }

  get #effectiveHtmlFile(): string {
    return (
      this.htmlFile ?? this.projectElement?.getPreviewHtmlFile() ?? 'index.html'
    );
  }

  protected override onProjectConnected(project: ZenaProject) {
    project.addEventListener('reload-preview', this.#boundOnReloadPreview);
  }

  protected override onProjectDisconnected(project: ZenaProject) {
    project.removeEventListener('reload-preview', this.#boundOnReloadPreview);
  }

  protected override onProjectUpdate() {
    super.onProjectUpdate();
    this.#maybeInitialLoad();
  }

  override updated(changedProperties: PropertyValues) {
    super.updated(changedProperties);
    if (changedProperties.has('htmlFile')) {
      if (this.#swReady) {
        this.reload();
      }
    }
  }

  #maybeInitialLoad() {
    if (this.#initialLoadDone || !this.#swReady) return;
    const project = this.projectElement;
    if (!project) return;
    if (project.status === 'ready' || project.status === 'error') {
      this.#initialLoadDone = true;
      this.reload();
    }
  }

  /**
   * Reloads the preview iframe from the project's entry HTML file.
   */
  reload() {
    if (!this.previewIframe || !this.#swReady) return;
    const targetUrl = new URL(
      `${this.#sessionId}/${this.#effectiveHtmlFile}`,
      this.#normalizedSandboxUrl,
    ).href;
    // Setting src reloads the iframe even if the URL hasn't changed.
    this.previewIframe.src = targetUrl;
  }

  #postMessageToProxyIframe(message: ProxyMessage, transfer?: Transferable[]) {
    const proxyWindow = this.proxyIframe?.contentWindow;
    if (!proxyWindow) {
      throw new Error(
        'Unexpected internal error: proxy iframe has no contentWindow',
      );
    }
    proxyWindow.postMessage(message, '*', transfer);
  }

  #onServiceWorkerProxyIframeLoad() {
    const channel = new MessageChannel();
    this.#proxyPort = channel.port1;
    this.#proxyPort.addEventListener(
      'message',
      (e: MessageEvent<ProxyMessage>) => {
        if (e.data.type === CONNECT_PROJECT_TO_SW) {
          void this.#onNewServiceWorkerPort(e.data.port);
        }
      },
    );
    this.#proxyPort.start();
    this.#postMessageToProxyIframe(
      {
        type: CONFIGURE_PROXY,
        scope: this.#normalizedSandboxUrl.pathname,
        port: channel.port2,
      },
      [channel.port2],
    );
  }

  async #onNewServiceWorkerPort(port: MessagePort) {
    port.start();
    this.#serviceWorkerAPI = await wrap<ServiceWorkerAPI>(port, {
      nestedProxies: true,
    });

    const remoteHash = await this.#serviceWorkerAPI.getHash();
    if (remoteHash !== serviceWorkerHash) {
      this.#postMessageToProxyIframe({type: UPDATE_SERVICE_WORKER});
      return;
    }

    await this.#serviceWorkerAPI.setFileAPI(
      {
        getFile: (name: string) => this.#getFile(name),
      },
      this.#sessionId,
    );
    this.#swReady = true;
    this.#maybeInitialLoad();
    if (!this.#initialLoadDone) {
      // If project is still initializing its compiler worker, we can still
      // kick off the initial HTML load because `compileFile` awaits
      // `workerReadyDeferred` when `.wasm` is requested.
      this.#initialLoadDone = true;
      this.reload();
    }
  }

  async #getFile(name: string): Promise<VirtualFile | HttpError> {
    const project = this.projectElement;
    if (!project) {
      return {
        status: 404,
        body: `No project connected for ${name}`,
      };
    }
    return project.getFile(name);
  }

  override render() {
    const proxySrc = new URL(
      `service-worker-proxy.html#session-id=${this.#sessionId}`,
      this.#normalizedSandboxUrl,
    ).href;

    return html`
      <iframe
        id="proxy"
        src=${proxySrc}
        @load=${this.#onServiceWorkerProxyIframeLoad}
      ></iframe>
      <iframe
        id="preview"
        title="Zena Web Preview"
        sandbox="allow-scripts allow-same-origin allow-forms"
      ></iframe>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'zena-preview': ZenaPreview;
  }
}
