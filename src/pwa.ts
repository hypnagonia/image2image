// Installable app: the service worker (dist/sw.js, generated at build time)
// exists only in production builds.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => { /* private mode, unsupported */ });
  });
}

export {};
