/**
 * Message protocol between `<zena-preview>` and the service worker proxy iframe.
 */

/**
 * Sent from `<zena-preview>` to the proxy iframe, with configuration and a port
 * for further messages.
 */
export const CONFIGURE_PROXY = 1;

/**
 * Sent from the proxy iframe to `<zena-preview>`, with a port that will be
 * connected to the service worker.
 */
export const CONNECT_PROJECT_TO_SW = 3;

/**
 * Sent from `<zena-preview>` to the service worker proxy when there is a
 * version mismatch to request a call to `ServiceWorkerRegistration.update()`.
 */
export const UPDATE_SERVICE_WORKER = 6;

export type ProxyMessage =
  | {
      type: typeof CONFIGURE_PROXY;
      scope: string;
      port: MessagePort;
    }
  | {
      type: typeof CONNECT_PROJECT_TO_SW;
      port: MessagePort;
    }
  | {
      type: typeof UPDATE_SERVICE_WORKER;
    };
