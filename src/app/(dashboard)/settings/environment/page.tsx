import { notFound } from 'next/navigation'
import { AlertTriangle, Check, X } from 'lucide-react'
import { getAuthorizedUser } from '@/lib/authz'
import { serverConfig, missingRequired, type ConfigGroup } from '@/lib/server-config'
import InfoHint from '@/components/ui/info-hint'

export const dynamic = 'force-dynamic'

/**
 * What the running server can see, by name.
 *
 * Dean, 17 Sep 2026: "Why when I click on the Send to Bamida it says The Bamida webhook is not
 * configured on the server. But N8N_BAMIDA_PO_WEBHOOK_URL is on the Netlify server?"
 *
 * There was no way to answer that from a browser. A variable can sit in the Netlify UI and be
 * absent from the function that reads it, and the three reasons look identical from outside: wrong
 * scope, wrong deploy context, or no build since it was added.
 *
 * 🔴 Super admin only, and presence only. No value is read into this page, ever.
 */
export default async function EnvironmentPage() {
  const auth = await getAuthorizedUser()
  // notFound rather than redirect: whether this page exists is not everybody's business.
  if (!auth.ok || !(auth.profile.is_super_admin || auth.capabilities.has('admin'))) notFound()

  const entries = serverConfig()
  const missing = missingRequired(entries)
  const groups = [...new Set(entries.map((e) => e.group))] as ConfigGroup[]
  const testing = entries.find((e) => e.name === 'HUB_EMAIL_TEST_RECIPIENT')?.present === true

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
      <h1 className="flex items-center gap-2 text-xl font-semibold text-gray-900">
        Server configuration
        <InfoHint label="About this page" align="left">
          What the running server actually holds, by name. A variable can be set in Netlify and
          still be missing here: check its scope includes Functions, that it is on the Production
          context, and that a deploy has happened since you added it.
        </InfoHint>
      </h1>
      <p className="mt-1 text-sm text-gray-500">
        Names and presence only. No value is ever read into this page.
      </p>

      {missing.length > 0 ? (
        <section className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3">
          <p className="flex items-center gap-2 text-sm font-medium text-red-900">
            <AlertTriangle className="h-4 w-4" />
            {missing.length} required {missing.length === 1 ? 'setting is' : 'settings are'} missing
          </p>
          <ul className="mt-2 space-y-1.5">
            {missing.map((e) => (
              <li key={e.name} className="text-sm text-red-900">
                <span className="font-mono font-medium">{e.name}</span>
                <span className="block text-xs text-red-800">{e.breaks}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-red-800">
            If one of these is set in Netlify but shown as missing here, it is almost always the
            variable&apos;s <strong>scope</strong>: it must include Functions, not only Builds. After
            that, check it is set on the Production deploy context, then redeploy, because a
            variable added after the last build is invisible until the next one.
          </p>
        </section>
      ) : (
        <p className="mt-5 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          Every required setting is present.
        </p>
      )}

      {testing && (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong>Test mode is on.</strong> HUB_EMAIL_TEST_RECIPIENT is set, so every outbound email
          goes there instead of to the real recipient, whatever the send screen says. Nothing reaches
          the factory or the forwarder until it is removed.
        </p>
      )}

      {groups.map((group) => (
        <section key={group} className="mt-6">
          <h2 className="text-sm font-semibold text-gray-900">{group}</h2>
          <div className="mt-2 overflow-hidden rounded-lg border border-gray-200">
            {entries
              .filter((e) => e.group === group)
              .map((e, i) => (
                <div
                  key={e.name}
                  className={`flex items-start gap-3 px-4 py-2.5 ${i > 0 ? 'border-t border-gray-100' : ''}`}
                >
                  <span className="mt-0.5 shrink-0">
                    {e.present ? (
                      <Check className="h-4 w-4 text-emerald-600" />
                    ) : (
                      <X className={`h-4 w-4 ${e.required ? 'text-red-600' : 'text-gray-300'}`} />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-mono text-sm text-gray-900">
                      {e.name}
                      {e.required && <span className="ml-2 text-[10px] uppercase tracking-wider text-gray-400">required</span>}
                    </span>
                    <span className="block text-xs text-gray-500">{e.breaks}</span>
                  </span>
                  {e.host && (
                    <span className="shrink-0 font-mono text-xs text-gray-400">{e.host}</span>
                  )}
                </div>
              ))}
          </div>
        </section>
      ))}
    </div>
  )
}
