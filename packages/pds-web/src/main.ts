/**
 * The script every page of the PDS's web app loads. The pages are rendered
 * on the server (`packages/pds/zena/web`) or built statically (`site/docs/`);
 * this defines the shared Zena website custom elements (`packages/website-client`)
 * and does what must happen in the browser: signing in and out with atproto
 * OAuth (`./auth.ts`, loaded only when it is needed).
 */

import '../../website-client/src/zena-appearance.js';
import '../../website-client/src/zena-code-copy.js';
import '../../website-client/src/zena-code-group.js';
import '../../website-client/src/zena-layout.js';
import '../../website-client/src/zena-local-outline.js';
import '../../website-client/src/zena-outline.js';
import '../../website-client/src/zena-sidebar.js';

/**
 * The DID the browser last signed in as, kept so that a page with no web
 * session can make one from the OAuth session the browser still has.
 */
const SIGNED_IN_AS = 'zena-pkg:did';
/** Set once a tab has tried that, so a failure is not retried on every page. */
const RENEW_TRIED = 'zena-pkg:renew-tried';

const body = document.body;
const serviceDid = body.dataset['serviceDid'] ?? '';
const signedIn = body.dataset['did'] ?? '';
const isStaticPage = body.dataset['static'] === 'true';

const loadAuth = () => import('./auth.js');

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * What someone typed to sign in, as the OAuth client takes it: a handle or
 * a DID, without the `@` handles are shown with, or spaces.
 */
const accountOf = (typed: string) => typed.trim().replace(/^@/, '');

/** The header's sign-in button opens the dialog, which sends the browser to the person's PDS. */
const wireSignIn = () => {
  const dialog = document.querySelector<HTMLDialogElement>('dialog#sign-in');
  const form = dialog?.querySelector('form');
  if (dialog == null || form == null) {
    return;
  }
  const error = form.querySelector<HTMLElement>('.error')!;
  const submit = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
  document
    .querySelector('[data-sign-in]')
    ?.addEventListener('click', () => dialog.showModal());
  form
    .querySelector('[data-close]')
    ?.addEventListener('click', () => dialog.close());
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const identifier = accountOf(
      String(new FormData(form).get('identifier') ?? ''),
    );
    if (identifier === '') {
      return;
    }
    if (!identifier.startsWith('did:') && !identifier.includes('.')) {
      error.textContent = `${identifier} is not a whole handle: a handle is a domain name, such as ${identifier}.bsky.social or ${identifier}.com.`;
      error.hidden = false;
      return;
    }
    error.hidden = true;
    submit.disabled = true;
    submit.textContent = 'Signing in…';
    try {
      await (await loadAuth()).signIn(identifier);
    } catch (e) {
      error.textContent = message(e);
      error.hidden = false;
      submit.disabled = false;
      submit.textContent = 'Sign in';
    }
  });
};

/** On the page the person's PDS sends them back to, finishes signing in. */
const finishSignIn = async () => {
  const status = document.querySelector<HTMLElement>('[data-sign-in-status]');
  try {
    const auth = await loadAuth();
    const {did, next} = await auth.finishSignIn(serviceDid);
    localStorage.setItem(SIGNED_IN_AS, did);
    sessionStorage.removeItem(RENEW_TRIED);
    location.replace(next);
  } catch (e) {
    if (status != null) {
      status.textContent = `Signing in failed: ${message(e)}`;
      status.classList.add('error');
    }
  }
};

/**
 * With no web session, as when its cookie has expired, makes one from the
 * OAuth session the browser still has, once per tab.
 */
const renew = async (did: string) => {
  sessionStorage.setItem(RENEW_TRIED, '1');
  try {
    await (await loadAuth()).renew(did, serviceDid);
    location.reload();
  } catch {
    // The OAuth session is gone too: the person signs in again.
    localStorage.removeItem(SIGNED_IN_AS);
  }
};

/** Signing out also ends the OAuth session at the person's PDS, before the form posts. */
const wireSignOut = () => {
  const form = document.querySelector<HTMLFormElement>('form.sign-out');
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    localStorage.removeItem(SIGNED_IN_AS);
    try {
      await (await loadAuth()).signOut(signedIn);
    } catch {
      // Gone already, or the PDS is unreachable: the web session ends anyway.
    }
    form.submit();
  });
};

wireSignIn();
wireSignOut();
if (location.pathname === '/oauth/callback') {
  void finishSignIn();
} else if (isStaticPage) {
  const domainEl = document.querySelector<HTMLElement>('[data-host-domain]');
  if (domainEl && location.host) {
    domainEl.textContent = location.host;
  }
  if (localStorage.getItem(SIGNED_IN_AS) !== null) {
    document
      .querySelector<HTMLElement>('[data-static-me]')
      ?.removeAttribute('hidden');
  }
} else if (signedIn === '') {
  const remembered = localStorage.getItem(SIGNED_IN_AS);
  if (remembered !== null && sessionStorage.getItem(RENEW_TRIED) === null) {
    void renew(remembered);
  }
}
