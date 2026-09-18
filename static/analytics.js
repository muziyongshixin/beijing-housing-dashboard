/* Optional, production-only Cloudflare Web Analytics. Never pass business data. */
(() => {
  const beaconURL = 'https://static.cloudflareinsights.com/beacon.min.js';
  const sitePaths = new Set([
    '/beijing-housing-dashboard',
    '/beijing-housing-dashboard/',
    '/beijing-housing-dashboard/index.html',
  ]);
  try {
    // Fail closed on localhost, previews, other projects, HTTP and nonstandard ports.
    if (window.DASHBOARD_STATIC_BUILD !== true || location.protocol !== 'https:' ||
        location.hostname !== 'liyongzhi.xyz' || location.port || !sitePaths.has(location.pathname)) return;
    if (navigator.doNotTrack === '1' || navigator.globalPrivacyControl === true) return;
    if (document.querySelector(`script[src^="${beaconURL}"]`)) return;

    const beacon = document.createElement('script');
    beacon.id = 'housing-analytics-beacon';
    beacon.type = 'module';
    beacon.src = beaconURL;
    beacon.referrerPolicy = 'strict-origin';
    // Public site identifier, NOT a Cloudflare account/API secret or paid token.
    // Disable SPA route tracking: searching/filtering is not a new site visit.
    beacon.dataset.cfBeacon = JSON.stringify({
      token: 'cf346192757847d19471adb6584b743c',
      spa: false,
    });
    // Optional statistics must not interrupt queries, authentication or charts.
    beacon.onerror = () => {};
    document.head.appendChild(beacon);
  } catch {
    // Restricted browser environments should retain the working dashboard.
  }
})();
