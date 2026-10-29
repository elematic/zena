/**
 * Signing in, with atproto OAuth: a person signs in as their own atproto
 * account, at their own PDS, which never shows this site a password
 * (docs/design/package-manager.md, "The management interface"). The OAuth
 * session stays in the browser. The host's pages learn who is signed in
 * from a web session: a service-auth token from the person's PDS, traded
 * for an HttpOnly cookie (`dev.zena-lang.host.createWebSession`), so the
 * server never holds anything that can write to their repository.
 *
 * `main.ts` loads this module only when someone signs in or out, or comes
 * back with an OAuth session and no cookie, since the OAuth library is
 * most of the page's script.
 *
 * On 127.0.0.1, as in `npm run demo`, the client is atproto's loopback
 * client, which needs no metadata document; elsewhere its client_id is the
 * metadata document the host serves.
 */

import {
  BrowserOAuthClient,
  buildAtprotoLoopbackClientMetadata,
  type OAuthSession,
} from '@atproto/oauth-client-browser';

/** The scope the page asks for; the host's metadata document says the same. */
const SCOPE = 'atproto transition:generic';

/** Where the person's PDS sends them back; a page of the host's (`pds:web/account`). */
export const CALLBACK_PATH = '/oauth/callback';

/** The host method that trades a service-auth token for a web session. */
const CREATE_WEB_SESSION = 'dev.zena-lang.host.createWebSession';

const isLoopback = () =>
  ['127.0.0.1', '[::1]', 'localhost'].includes(location.hostname);

let client: Promise<BrowserOAuthClient> | undefined;

const getClient = () => (client ??= createClient());

const createClient = async (): Promise<BrowserOAuthClient> => {
  // The host resolves handles (com.atproto.identity.resolveHandle), so
  // nobody's handle goes to a third party.
  const handleResolver = location.origin;
  if (isLoopback()) {
    return new BrowserOAuthClient({
      handleResolver,
      clientMetadata: buildAtprotoLoopbackClientMetadata({
        scope: SCOPE,
        redirect_uris: [`http://127.0.0.1:${location.port}${CALLBACK_PATH}`],
      }),
    });
  }
  return BrowserOAuthClient.load({
    clientId: `${location.origin}/oauth/client-metadata.json`,
    handleResolver,
  });
};

/**
 * Sends the browser to the PDS of `identifier`, a handle or a DID, to sign
 * in, coming back to this page afterwards. Never returns unless it fails.
 */
export const signIn = async (identifier: string): Promise<void> => {
  const here =
    location.pathname === CALLBACK_PATH
      ? '/'
      : location.pathname + location.search;
  await (await getClient()).signIn(identifier, {state: here});
};

/**
 * Finishes a sign-in the person's PDS sent them back from: the OAuth
 * session, then the web session. Returns their DID and the page to go back
 * to.
 */
export const finishSignIn = async (
  serviceDid: string,
): Promise<{did: string; next: string}> => {
  const result = await (await getClient()).init();
  if (result === undefined) {
    throw new Error('Your PDS sent no sign-in back. Try signing in again.');
  }
  await createWebSession(result.session, serviceDid);
  const state = result.state ?? '';
  // Only a path on this site, never another origin.
  const next = state.startsWith('/') && !state.startsWith('//') ? state : '/me';
  return {did: result.session.sub, next};
};

/**
 * Makes a new web session for `did` from the OAuth session the browser
 * still has, as when the cookie has expired. Throws when there is none.
 */
export const renew = async (did: string, serviceDid: string): Promise<void> => {
  const session = await (await getClient()).restore(did);
  await createWebSession(session, serviceDid);
};

/** Ends `did`'s OAuth session at their PDS; the form post that follows ends the web session. */
export const signOut = async (did: string): Promise<void> => {
  await (await getClient()).revoke(did);
};

/**
 * Trades a service-auth token from the person's PDS, addressed to the
 * host, for a web session cookie.
 */
const createWebSession = async (session: OAuthSession, serviceDid: string) => {
  const tokenResponse = await session.fetchHandler(
    `/xrpc/com.atproto.server.getServiceAuth?aud=${encodeURIComponent(serviceDid)}&lxm=${encodeURIComponent(CREATE_WEB_SESSION)}`,
  );
  const token = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || typeof token.token !== 'string') {
    throw new Error(
      token.message ?? `Your PDS refused a token (${tokenResponse.status}).`,
    );
  }
  const answer = await fetch(`/xrpc/${CREATE_WEB_SESSION}`, {
    method: 'POST',
    headers: {authorization: `Bearer ${token.token}`},
  });
  if (!answer.ok) {
    const error = await answer.json().catch(() => ({}));
    throw new Error(
      error.message ?? `The host refused the sign-in (${answer.status}).`,
    );
  }
};
