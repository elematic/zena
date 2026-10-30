/**
 * The script every page of the PDS's web app loads. The pages are rendered
 * on the server (`packages/pds/zena/web`); this defines the Radica elements
 * they use, and does what must happen in the browser: signing in and out
 * with atproto OAuth (`./auth.ts`, loaded only when it is needed).
 */

import '@radica/ui/components/theme-select/theme-select.js';

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

/** Progressive enhancement for the static `/docs/` pages: sidebar, outline, and code copy. */
const wireDocs = () => {
  const sidebar = document.querySelector<HTMLElement>('[data-docs-sidebar]');
  const backdrop = document.querySelector<HTMLElement>('[data-close-sidebar]');
  const menuBtn = document.querySelector<HTMLButtonElement>('[data-toggle-sidebar]');

  const setSidebarOpen = (open: boolean) => {
    sidebar?.classList.toggle('open', open);
    backdrop?.classList.toggle('open', open);
    menuBtn?.setAttribute('aria-expanded', String(open));
  };

  menuBtn?.addEventListener('click', () => {
    const open = !sidebar?.classList.contains('open');
    setSidebarOpen(open);
  });
  backdrop?.addEventListener('click', () => setSidebarOpen(false));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sidebar?.classList.contains('open')) {
      setSidebarOpen(false);
    }
  });

  // Expand/collapse sidebar sections.
  const toggleSection = (section: HTMLElement) => {
    const collapsed = section.classList.toggle('collapsed');
    section
      .querySelector('.item > .caret')
      ?.setAttribute('aria-expanded', String(!collapsed));
    section
      .querySelector('.item[role="button"]')
      ?.setAttribute('aria-expanded', String(!collapsed));
  };

  sidebar?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const item = target.closest<HTMLElement>('.item');
    const section = item?.parentElement?.closest<HTMLElement>(
      '.sidebar-item.collapsible',
    );
    if (!item || !section || item.parentElement !== section) return;
    const isCaret = !!target.closest('.caret');
    if (section.classList.contains('is-link') && !isCaret) return;
    e.preventDefault();
    toggleSection(section);
  });

  sidebar?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const target = e.target as HTMLElement;
    const item = target.closest<HTMLElement>('.item[role="button"], .caret');
    const section = item?.closest<HTMLElement>('.sidebar-item.collapsible');
    if (!section) return;
    e.preventDefault();
    toggleSection(section);
  });

  // Mobile "On this page" outline dropdown.
  const localOutline = document.querySelector<HTMLElement>(
    '[data-local-outline]',
  );
  const localToggle = localOutline?.querySelector<HTMLButtonElement>(
    '[data-local-outline-toggle]',
  );
  const localItems = localOutline?.querySelector<HTMLElement>('.items');
  if (localOutline && localToggle && localItems) {
    localToggle.addEventListener('click', () => {
      const open = Boolean(localItems.hidden);
      localItems.hidden = !open;
      localToggle.setAttribute('aria-expanded', String(open));
      localOutline.classList.toggle('open', open);
    });
    localItems.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('a')) {
        localItems.hidden = true;
        localToggle.setAttribute('aria-expanded', 'false');
        localOutline.classList.remove('open');
      }
    });
  }

  // Right-hand "On this page" scroll-spy outline.
  const docOutline = document.querySelector<HTMLElement>('[data-doc-outline]');
  if (docOutline) {
    const marker = docOutline.querySelector<HTMLElement>('.outline-marker');
    const links = [
      ...docOutline.querySelectorAll<HTMLAnchorElement>('.outline-link'),
    ];
    const headings = links
      .map((a) => document.getElementById(decodeURIComponent(a.hash.slice(1))))
      .filter((el): el is HTMLElement => el !== null);
    let prevActive: HTMLAnchorElement | null = null;

    const updateOutline = () => {
      if (headings.length === 0) return;
      const scrollY = window.scrollY;
      const innerHeight = window.innerHeight;
      const offsetHeight = document.body.offsetHeight;
      const atBottom = Math.abs(scrollY + innerHeight - offsetHeight) < 2;

      let active: HTMLElement | undefined;
      if (atBottom) {
        active = headings[headings.length - 1];
      } else {
        for (const h of headings) {
          if (h.getBoundingClientRect().top > 100) break;
          active = h;
        }
        active ??= headings[0];
      }

      const link =
        links.find(
          (a) => decodeURIComponent(a.hash.slice(1)) === active!.id,
        ) ?? null;
      if (link === prevActive) return;
      prevActive?.classList.remove('active');
      link?.classList.add('active');
      prevActive = link;
      if (marker) {
        if (link) {
          marker.style.top = `${link.offsetTop + 6}px`;
          marker.style.opacity = '1';
        } else {
          marker.style.opacity = '0';
        }
      }
    };

    if (headings.length > 0) {
      window.addEventListener('scroll', updateOutline, {passive: true});
      window.addEventListener('resize', updateOutline, {passive: true});
      requestAnimationFrame(updateOutline);
    }
  }

  // Copy-to-clipboard for Shiki code blocks.
  document.addEventListener('click', async (e) => {
    const button = (e.target as HTMLElement).closest<HTMLButtonElement>(
      'button.copy',
    );
    if (!button) return;
    const code = button.parentElement?.querySelector('code');
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.textContent ?? '');
      button.classList.add('copied');
      clearTimeout(Number(button.dataset['timer']));
      button.dataset['timer'] = String(
        setTimeout(() => button.classList.remove('copied'), 2000),
      );
    } catch {
      // Clipboard unavailable.
    }
  });
};

wireSignIn();
wireSignOut();
wireDocs();
if (location.pathname === '/oauth/callback') {
  void finishSignIn();
} else if (isStaticPage) {
  const domainEl = document.querySelector<HTMLElement>('[data-host-domain]');
  if (domainEl && location.host) {
    domainEl.textContent = location.host;
  }
  if (localStorage.getItem(SIGNED_IN_AS) !== null) {
    document.querySelector<HTMLElement>('[data-static-me]')?.removeAttribute('hidden');
  }
} else if (signedIn === '') {
  const remembered = localStorage.getItem(SIGNED_IN_AS);
  if (remembered !== null && sessionStorage.getItem(RENEW_TRIED) === null) {
    void renew(remembered);
  }
}
