const CACHE_NAME = 'worthdelta-v2'
const APP_SHELL = [
  '/WorthDelta/',
  '/WorthDelta/manifest.webmanifest',
  '/WorthDelta/icons/worthdelta-192.png',
  '/WorthDelta/icons/worthdelta-512.png',
  '/WorthDelta/icons/worthdelta-maskable-512.png',
  '/WorthDelta/icons/apple-touch-icon.png',
]

async function cacheAppShell() {
  const cache = await caches.open(CACHE_NAME)
  await cache.addAll(APP_SHELL)

  const pageResponse = await fetch('/WorthDelta/', { cache: 'reload' })
  const html = await pageResponse.clone().text()
  await cache.put('/WorthDelta/', pageResponse)

  const assetUrls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => new URL(match[1], self.location.origin))
    .filter((url) => url.origin === self.location.origin && url.pathname.startsWith('/WorthDelta/'))
    .map((url) => url.href)

  await cache.addAll([...new Set(assetUrls)])
}

self.addEventListener('install', (event) => {
  event.waitUntil(cacheAppShell())
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('worthdelta-') && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)

  if (request.method !== 'GET' || url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone()
          void caches.open(CACHE_NAME).then((cache) => cache.put('/WorthDelta/', copy))
          return response
        })
        .catch(() => caches.match('/WorthDelta/')),
    )
    return
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached

      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone()
          void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy))
        }
        return response
      })
    }),
  )
})
