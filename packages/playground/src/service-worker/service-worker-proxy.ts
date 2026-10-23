/**
 * @license
 * Copyright 2020 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import type {ServiceWorkerMessage} from '../preview-shared/service-worker-api.js';
import {INIT, MISSING_FILE_API} from '../preview-shared/service-worker-api.js';
import type {ProxyMessage} from '../preview-shared/proxy-api.js';
import {
  CONNECT_PROJECT_TO_SW,
  CONFIGURE_PROXY,
  UPDATE_SERVICE_WORKER,
} from '../preview-shared/proxy-api.js';

try {
  // Detect same-origin by trying to access the parent window. On localhost in
  // local development this is expected; warn on non-localhost origins.
  if (
    window.location.hostname !== 'localhost' &&
    window.location.hostname !== '127.0.0.1'
  ) {
    parent.window.console.warn(
      'Zena playground preview sandbox is executing with the same origin as its parent.',
      'Configure sandbox-base-url to a separate origin in production.',
    );
  }
} catch {}

// Wait for our parent to send us:
// 1. The URL and scope of the Service Worker to register.
// 2. A MessagePort, on which we'll forward up new Service Worker ports.
const {scope, port: parentPort} = await new Promise<{
  scope: string;
  port: MessagePort;
}>((resolve) => {
  const listener = (event: MessageEvent<ProxyMessage>) => {
    if (event.data?.type === CONFIGURE_PROXY) {
      window.removeEventListener('message', listener);
      resolve(event.data);
    }
  };
  window.addEventListener('message', listener);
});

const registration = await navigator.serviceWorker.register(
  new URL('service-worker.js', new URL(scope, import.meta.url)).href,
  {scope, type: 'module'},
);

const getNewestWorker = () =>
  registration.installing ?? registration.waiting ?? registration.active;

const activated = async (sw: ServiceWorker): Promise<void> => {
  if (sw.state === 'activated') {
    return;
  }
  return new Promise<void>((resolve) => {
    const aborter = new AbortController();
    sw.addEventListener(
      'statechange',
      () => {
        if (sw.state === 'activated') {
          resolve();
          aborter.abort();
        }
      },
      {signal: aborter.signal},
    );
  });
};

let connected: ServiceWorker | null = null;

const connectToNewest = async (force = false) => {
  const sw = getNewestWorker();
  if (!force && sw === connected) {
    return;
  }
  connected = sw;
  if (sw === null) {
    console.error('No service worker found.');
    return;
  }

  await activated(sw);

  if (sw !== connected) {
    return;
  }

  const {port1, port2} = new MessageChannel();
  port1.start();
  port2.start();

  parentPort.postMessage(
    {
      type: CONNECT_PROJECT_TO_SW,
      port: port1,
    } satisfies ProxyMessage,
    [port1],
  );

  sw.postMessage(
    {
      type: INIT,
      port: port2,
    } satisfies ServiceWorkerMessage,
    [port2],
  );
};

void connectToNewest();

registration.addEventListener('updatefound', () => {
  void connectToNewest();
});

navigator.serviceWorker.addEventListener(
  'message',
  (event: MessageEvent<ServiceWorkerMessage>) => {
    if (event.source !== connected) {
      return;
    }
    if (event.data?.type === MISSING_FILE_API) {
      void connectToNewest(true);
    }
  },
);

window.addEventListener(
  'message',
  async (event: MessageEvent<ProxyMessage>) => {
    if (event.data?.type === UPDATE_SERVICE_WORKER) {
      const newestBefore = getNewestWorker();
      await registration.update();
      if (getNewestWorker() === newestBefore) {
        console.error('Service worker update failed.');
      }
    }
  },
);
