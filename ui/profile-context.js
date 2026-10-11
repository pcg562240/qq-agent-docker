// Bound to the HTML document's worker generation. Never fetch a newer context
// into an old tab: that would allow stale forms to overwrite another robot.
(() => {
  const context = document.querySelector('meta[name="qq-profile-context"]')?.content;
  if (!context) return;
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, options = {}) => {
    const url = new URL(input instanceof Request ? input.url : input, location.href);
    if (url.origin === location.origin && url.pathname.startsWith('/api/')) {
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(options.headers).forEach((v, k) => headers.set(k, v));
      headers.set('x-qq-profile-context', context);
      return originalFetch(input, { ...options, headers });
    }
    return originalFetch(input, options);
  };
  const OriginalEventSource = window.EventSource;
  window.EventSource = class extends OriginalEventSource {
    constructor(input, options) {
      const url = new URL(input, location.href);
      if (url.origin === location.origin && url.pathname === '/api/events') url.searchParams.set('profileContext', context);
      super(url.href, options);
    }
  };
})();
