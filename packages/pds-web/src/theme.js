// Applies the saved theme before the page paints. Every page loads it as a
// classic script in its <head>, from /assets/, since the pages' content
// security policy runs no inline script (registry:service's PAGE_POLICY).
(() => {
  const stored = localStorage.getItem('zena-appearance');
  const dark =
    stored === 'dark' ||
    (stored !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.classList.toggle('rad-theme-dark', dark);
})();
