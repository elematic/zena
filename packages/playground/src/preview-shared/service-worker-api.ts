/**
 * Message protocol and Supertalk RPC interfaces between `<zena-preview>`, the
 * proxy iframe, and the preview service worker.
 */

export interface VirtualFile {
  name: string;
  content: string | Uint8Array<ArrayBuffer>;
  contentType?: string;
}

export interface HttpError {
  status: number;
  body: string;
}

/**
 * Received by the service worker with a MessagePort for further messages.
 */
export const INIT = 2;

/**
 * Sent from the service worker to confirm that the INIT message was received.
 */
export const STARTED = 4;

/**
 * Sent from the service worker to the proxy iframe to notify when a file API
 * is missing (e.g., after a service worker restart) and a reconnection is
 * required.
 */
export const MISSING_FILE_API = 5;

export type ServiceWorkerMessage =
  | {
      type: typeof INIT;
      port: MessagePort;
    }
  | {
      type: typeof STARTED;
      version: string;
    }
  | {
      type: typeof MISSING_FILE_API;
    };

export interface ServiceWorkerAPI {
  setFileAPI(fileAPI: FileAPI, sessionID: string): Promise<void>;
  getHash(): Promise<string>;
}

export interface FileAPI {
  getFile(name: string): Promise<VirtualFile | HttpError>;
}
