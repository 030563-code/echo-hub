import type { MetadataRoute } from 'next'

/**
 * The Hub as an installable app.
 *
 * Served at /manifest.webmanifest. With this plus the service worker, Chrome
 * and Edge offer an install button in the address bar, macOS Safari offers Add
 * to Dock and iOS offers Add to Home Screen. What gets installed is a window
 * onto hub.echobarrier.com, not a copy of it: there is nothing to update and no
 * app store, and everyone is always on the deployed build.
 *
 * `display: standalone` drops the tabs and the address bar. `start_url` is the
 * dashboard, which sends anyone without a session to the login page as usual.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Echo Barrier Hub',
    short_name: 'Echo Hub',
    description: "Echo Barrier's unified internal operating platform",
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#FF7026',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      // Android masks icons to a circle or a squircle. This one carries the
      // letter well inside the safe zone so the mask never clips it.
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
