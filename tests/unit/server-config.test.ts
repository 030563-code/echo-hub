import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { serverConfig, missingRequired } from '@/lib/server-config'

/**
 * 🔴 Reading an environment is how secrets end up in a screenshot or a support thread. This page
 * exists to answer "is it there", never "what is it".
 */

describe('server config reports presence, never a value', () => {
  const SECRET = 'super-secret-value-nobody-should-see'

  it('does not carry a value into the result, for any variable', () => {
    const before = { ...process.env }
    try {
      for (const e of serverConfig()) process.env[e.name] = SECRET
      const dumped = JSON.stringify(serverConfig())
      expect(dumped).not.toContain(SECRET)
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k]
      Object.assign(process.env, before)
    }
  })

  it('reports a URL by host only, never its path', () => {
    const before = process.env.N8N_BAMIDA_PO_WEBHOOK_URL
    process.env.N8N_BAMIDA_PO_WEBHOOK_URL = 'https://example.app.n8n.cloud/webhook/hub-bamida-po'
    try {
      const e = serverConfig().find((x) => x.name === 'N8N_BAMIDA_PO_WEBHOOK_URL')!
      expect(e.present).toBe(true)
      expect(e.host).toBe('example.app.n8n.cloud')
      // The path IS the part worth guessing at on a webhook.
      expect(JSON.stringify(e)).not.toContain('hub-bamida-po')
    } finally {
      if (before === undefined) delete process.env.N8N_BAMIDA_PO_WEBHOOK_URL
      else process.env.N8N_BAMIDA_PO_WEBHOOK_URL = before
    }
  })

  it('counts whitespace as absent, because a blank variable configures nothing', () => {
    const before = process.env.BAMIDA_PO_BCC
    process.env.BAMIDA_PO_BCC = '   '
    try {
      expect(serverConfig().find((x) => x.name === 'BAMIDA_PO_BCC')!.present).toBe(false)
    } finally {
      if (before === undefined) delete process.env.BAMIDA_PO_BCC
      else process.env.BAMIDA_PO_BCC = before
    }
  })

  it('says when something present is not a URL at all', () => {
    const before = process.env.N8N_BAMIDA_PO_WEBHOOK_URL
    process.env.N8N_BAMIDA_PO_WEBHOOK_URL = 'paste-error'
    try {
      expect(serverConfig().find((x) => x.name === 'N8N_BAMIDA_PO_WEBHOOK_URL')!.host).toBe('not a URL')
    } finally {
      if (before === undefined) delete process.env.N8N_BAMIDA_PO_WEBHOOK_URL
      else process.env.N8N_BAMIDA_PO_WEBHOOK_URL = before
    }
  })

  it('covers the variable that started this and every other one the Hub reads', () => {
    const named = new Set(serverConfig().map((e) => e.name))
    expect(named.has('N8N_BAMIDA_PO_WEBHOOK_URL')).toBe(true)

    // Anything the code reads but this page does not list is a gap that would send the next person
    // hunting again. Cargo Partner's own credentials are excluded on purpose: nothing writes to
    // that API, so their presence tells a reader nothing they can act on.
    const source = ['src/app/actions', 'src/lib']
      .flatMap((dir) => walk(join(process.cwd(), dir)))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n')
    const used = new Set(
      [...source.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]),
    )
    const interesting = [...used].filter(
      (k) => /^(N8N_|BAMIDA_|READY_|CARGO_NOTIFY)/.test(k),
    )
    const gaps = interesting.filter((k) => !named.has(k))
    expect(gaps, `not listed on the environment page: ${gaps.join(', ')}`).toEqual([])
  })

  it('missingRequired only reports what the Hub actually refuses without', () => {
    const entries = serverConfig().map((e) => ({ ...e, present: false }))
    const missing = missingRequired(entries)
    expect(missing.every((e) => e.required)).toBe(true)
    expect(missing.some((e) => e.name === 'BAMIDA_PO_BCC')).toBe(false)
  })
})

describe('guard: the page is admin only and prints no value', () => {
  const page = readFileSync(
    join(process.cwd(), 'src/app/(dashboard)/settings/environment/page.tsx'),
    'utf8',
  )

  it('refuses anybody who is not an admin', () => {
    expect(page).toContain("auth.profile.is_super_admin || auth.capabilities.has('admin')")
    // notFound, not redirect: whether this page exists is not everybody's business.
    expect(page).toContain('notFound()')
  })

  it('never reaches process.env itself', () => {
    expect(page).not.toContain('process.env')
  })
})

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}
