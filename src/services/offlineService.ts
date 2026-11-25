export interface OfflineReadinessState {
  isOnline: boolean;
  swSupported: boolean;
  swActive: boolean;
  swControlled: boolean;
  persistedStorage: boolean | null;
  cachedAssetCount: number;
  storageUsageBytes: number | null;
  storageQuotaBytes: number | null;
  lastVerifiedAt: number | null;
}

const CORE_OFFLINE_URLS = [
  '/',
  '/manifest.webmanifest',
  '/icon.svg',
  '/apple-touch-icon.png',
  '/pwa-192x192.png',
  '/pwa-512x512.png',
  '/pwa-maskable-512x512.png',
];

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = window.setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

export async function requestPersistentStorage(): Promise<boolean | null> {
  if (typeof navigator === 'undefined' || !navigator.storage) return null;
  try {
    if (typeof navigator.storage.persisted === 'function') {
      const already = await navigator.storage.persisted();
      if (already) return true;
    }
    if (typeof navigator.storage.persist === 'function') {
      return await navigator.storage.persist();
    }
    return null;
  } catch {
    return null;
  }
}

async function countAllCachedEntries(): Promise<number> {
  if (typeof window === 'undefined' || !('caches' in window)) return 0;
  try {
    const names = await window.caches.keys();
    let total = 0;
    for (const name of names) {
      const cache = await window.caches.open(name);
      const keys = await cache.keys();
      total += keys.length;
    }
    return total;
  } catch {
    return 0;
  }
}

export async function getOfflineReadinessStatus(): Promise<OfflineReadinessState> {
  const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
  const swSupported = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;

  let swActive = false;
  let swControlled = false;
  if (swSupported) {
    swControlled = Boolean(navigator.serviceWorker.controller);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      swActive = Boolean(reg?.active || reg?.waiting || reg?.installing);
    } catch {
      swActive = false;
    }
  }

  let persistedStorage: boolean | null = null;
  let storageUsageBytes: number | null = null;
  let storageQuotaBytes: number | null = null;

  if (typeof navigator !== 'undefined' && navigator.storage) {
    try {
      if (typeof navigator.storage.persisted === 'function') {
        persistedStorage = await navigator.storage.persisted();
      }
      if (typeof navigator.storage.estimate === 'function') {
        const est = await navigator.storage.estimate();
        storageUsageBytes = typeof est.usage === 'number' ? est.usage : null;
        storageQuotaBytes = typeof est.quota === 'number' ? est.quota : null;
      }
    } catch {
      // Ignore restricted storage estimate errors
    }
  }

  const cachedAssetCount = await countAllCachedEntries();

  return {
    isOnline,
    swSupported,
    swActive,
    swControlled,
    persistedStorage,
    cachedAssetCount,
    storageUsageBytes,
    storageQuotaBytes,
    lastVerifiedAt: Date.now(),
  };
}

/**
 * Ensures persistent local storage and warms the Service Worker CacheStorage
 * with the app shell, manifest, icons, and loaded same-origin scripts/styles
 * so the studio continues working seamlessly if internet disconnects.
 */
export async function warmOfflineCache(): Promise<OfflineReadinessState> {
  await requestPersistentStorage();

  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    await withTimeout(navigator.serviceWorker.ready.then(() => true).catch(() => false), 2500, false);
  }

  if (typeof window !== 'undefined' && navigator.onLine) {
    const urlsToWarm = new Set<string>(CORE_OFFLINE_URLS);

    // Collect currently loaded same-origin module/style/asset URLs (critical in Vite dev/preview)
    document
      .querySelectorAll<HTMLScriptElement | HTMLLinkElement>('script[src], link[href]')
      .forEach((el) => {
        const raw = el instanceof HTMLScriptElement ? el.src : el.href;
        if (!raw) return;
        try {
          const parsed = new URL(raw, window.location.origin);
          if (
            parsed.origin === window.location.origin &&
            !parsed.pathname.startsWith('/__') &&
            !parsed.pathname.startsWith('/_') &&
            !parsed.pathname.endsWith('/sw.js') &&
            !parsed.pathname.endsWith('/dev-sw.js')
          ) {
            urlsToWarm.add(parsed.pathname + parsed.search);
          }
        } catch {
          // Ignore invalid URL
        }
      });

    // Warm via normal same-origin fetch so Workbox runtimeCaching stores each resource
    // without forcing network bypass; also mirror into fallback runtime cache if needed.
    const list = Array.from(urlsToWarm);
    const chunkSize = 6;
    for (let i = 0; i < list.length; i += chunkSize) {
      const slice = list.slice(i, i + chunkSize);
      await Promise.all(
        slice.map(async (url) => {
          try {
            const res = await fetch(url, { credentials: 'same-origin' });
            if (res.ok && 'caches' in window) {
              const runtimeCache = await window.caches.open('smartplay-app-runtime');
              const existing = await runtimeCache.match(url);
              if (!existing) {
                await runtimeCache.put(url, res.clone());
              }
            }
          } catch {
            // Ignore single transient fetch failure
          }
        })
      );
    }
  }

  return getOfflineReadinessStatus();
}
