'use client'

// page-state: none (registers the worker once, holds nothing)

import { useEffect } from 'react'

/**
 * Registers /sw.js, which is what makes the browser offer to install the Hub.
 *
 * Mounted once in the root layout, so it covers the login page too and the
 * install button is there before anyone signs in. Registration failing is not
 * worth a word to the user: the site works exactly the same, it just cannot be
 * installed, so the error goes to the console and nowhere else.
 */
export function RegisterServiceWorker() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    const register = () => {
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        console.warn('Service worker registration failed', err)
      })
    }
    // After load, so it never competes with the first render for bandwidth.
    if (document.readyState === 'complete') register()
    else {
      window.addEventListener('load', register)
      return () => window.removeEventListener('load', register)
    }
  }, [])

  return null
}
