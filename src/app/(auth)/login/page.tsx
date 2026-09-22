'use client'

import { useState, useSyncExternalStore } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card } from '@/components/ui/card'
import Image from 'next/image'
import { ShieldAlert } from 'lucide-react'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 🔴 Until React has attached, this form is a plain HTML form with
  // method="post" and no action, so a click submits it natively: the browser
  // posts to /login, Next has no POST handler, and the person lands back on an
  // EMPTY login form with nothing said. It looks exactly like being signed out
  // for no reason, and it is why "it just goes back to login" happens on a slow
  // connection or a cold start. Reproduced twice against production while
  // chasing that report.
  //
  // The method="post" stays: without it the native submit is a GET and the
  // browser puts the password in the URL, the history and every log on the way.
  // The button simply waits for the handler that prevents it.
  //
  // useSyncExternalStore rather than an effect: it returns the server snapshot
  // (false) during render and the client snapshot (true) once hydrated, in one
  // pass. Setting state in an effect would do the same thing a render later and
  // the React Compiler rightly refuses it.
  const ready = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  )

  const supabase = createClient()

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)

    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password })
      if (signInError) throw signInError
      // A full page load, not router.replace(). Safari and Chrome only offer to
      // save a password when a form submit is followed by a real navigation, so
      // a client-side route change here is why nobody is ever asked. The
      // dashboard layout resolves capabilities + routes onboarding either way.
      // `loading` deliberately stays true: the button must not flick back to
      // "Sign In" while the next page loads.
      window.location.assign('/')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-black flex flex-col items-center justify-center p-4">
      <Card className="w-full max-w-md bg-[#111] border-gray-800">
        <div className="text-center mb-8">
          <div className="flex justify-center mb-6">
            {/* Echo Barrier's own dark-ink logo, transparent PNG, inverted to
                white for this black ground. It replaced logo.jpg here on 16 Sep
                2026: that file is a CMYK JPEG with an opaque white field, so
                inverting it put a box behind the type instead of nothing. The
                PDFs still read logo.jpg, which wants JPEG bytes. */}
            <Image
              src="/logo-dark.png"
              alt="Echo Barrier"
              width={180}
              height={54}
              className="object-contain invert"
              priority
            />
          </div>
          <h1 className="text-2xl font-bold text-white uppercase tracking-widest">Hub Login</h1>
          <p className="text-xs text-gray-500 mt-2 uppercase tracking-wider">Echo Barrier internal platform</p>
        </div>

        {/* method="post", 16 Sep 2026: without it a submit that lands before
            React has hydrated is a native GET, and the browser puts the email and
            PASSWORD in the URL, the history and every request log on the way. Seen
            happen on a slow connection. Once hydrated, onSubmit prevents the
            default and this attribute never comes into play. */}
        <form method="post" onSubmit={handleLogin} className="space-y-6">
          {/* name + autoComplete are what a password manager matches on. Without
              them Apple Passwords sees two anonymous boxes and offers nothing. */}
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            inputMode="email"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="name@echobarrier.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            label="Email Address"
            required
          />

          <Input
            id="current-password"
            name="password"
            type="password"
            autoComplete="current-password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            label="Password"
            required
          />

          {error && (
            <div className="bg-red-900/20 border border-red-900 text-red-500 p-3 text-sm flex items-center gap-2">
              <ShieldAlert className="w-4 h-4" />
              {error}
            </div>
          )}

          <Button type="submit" className="w-full" variant="primary" disabled={loading || !ready}>
            {loading ? 'Authenticating...' : ready ? 'Sign In' : 'Loading…'}
          </Button>
        </form>
      </Card>
    </div>
  )
}
