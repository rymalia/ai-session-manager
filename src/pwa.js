// PWA service-worker registration.
//
// Importing this module registers /sw.js after the window 'load' event so it
// never blocks initial render. It is a graceful no-op if service workers are
// unsupported or registration fails (e.g. insecure context, dev quirks).
//
// To disable: comment out the `import './pwa.js';` line in main.jsx, then
// unregister any existing worker via DevTools > Application > Service Workers.

export function registerServiceWorker() {
  if (typeof window === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .catch((err) => {
        // Swallow errors so a failed registration never breaks the app.
        console.warn('[pwa] service worker registration failed:', err);
      });
  });
}

registerServiceWorker();
