import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveSelection, type SendContact } from '@/lib/send-contacts'

/**
 * Dean, 17 Sep 2026: "Maybe a tick box that already have these in for him and the ability to add
 * more to a library in supabase that adds to the tickbox", forwarding what Operations actually
 * does: seven addresses on every Bamida order, and a forwarder contact that depends on sea or air.
 *
 * 🔴 REQUIRED IS NOT SELECTED. A required contact is merged in on the SERVER whatever the browser
 * sends. Every export of a 'use server' file is a public endpoint, so if required were merely a
 * default the client could drop the manufacturer's own desk.
 */

const c = (over: Partial<SendContact> & { id: string; address: string }): SendContact => ({
  displayName: null,
  organisation: 'Manufacturer',
  field: 'cc',
  modalities: [],
  defaultSelected: true,
  isRequired: false,
  ...over,
})

const BOOK: SendContact[] = [
  c({ id: 'r1', address: 'sklad@bamida.sk', field: 'to', isRequired: true }),
  c({ id: 'o1', address: 'info@bamida.sk' }),
  c({ id: 'o2', address: 'marketing@bamida.sk' }),
  c({ id: 'r2', address: 'juraj@echobarrier.eu', organisation: 'Echo Barrier', isRequired: true }),
]

describe('resolveSelection: required always goes, ticked adds, typed adds', () => {
  it('sends the required contacts even when NOTHING is ticked', () => {
    const out = resolveSelection(BOOK, [], {})
    expect(out.to).toBe('sklad@bamida.sk')
    expect(out.cc).toBe('juraj@echobarrier.eu')
  })

  it('cannot be made to drop a required contact, however the client lies', () => {
    // The browser does not send required ids at all. A caller posting an empty list, a list of
    // somebody else's ids, or rubbish, still cannot remove these two.
    for (const attempt of [[], ['o1'], ['not-a-real-id'], ['r1']]) {
      const out = resolveSelection(BOOK, attempt, {})
      expect(out.to).toContain('sklad@bamida.sk')
      expect(out.cc).toContain('juraj@echobarrier.eu')
    }
  })

  it('adds the contacts that were ticked, in the order the book lists them', () => {
    // Book order, not required-first: the book is sorted for the screen (the factory's own people,
    // then ours), and the email should read the way the tick boxes did.
    const out = resolveSelection(BOOK, ['o1', 'o2'], {})
    expect(out.cc).toBe('info@bamida.sk, marketing@bamida.sk, juraj@echobarrier.eu')
  })

  it('leaves out the ones that were unticked, for this send only', () => {
    const out = resolveSelection(BOOK, ['o1'], {})
    expect(out.cc).not.toContain('marketing@bamida.sk')
    expect(out.cc).toContain('info@bamida.sk')
  })

  it('adds typed addresses on top of both', () => {
    const out = resolveSelection(BOOK, ['o1'], { to: 'vyroba@bamida.sk', cc: 'someone@else.com' })
    expect(out.to).toBe('sklad@bamida.sk, vyroba@bamida.sk')
    expect(out.cc).toBe('info@bamida.sk, juraj@echobarrier.eu, someone@else.com')
  })

  it('does not send to anybody twice when they are ticked AND typed', () => {
    const out = resolveSelection(BOOK, ['o1'], { cc: 'INFO@Bamida.SK' })
    expect(out.cc).toBe('info@bamida.sk, juraj@echobarrier.eu')
  })

  it('drops blanks and stray commas rather than emailing an empty address', () => {
    const out = resolveSelection([], [], { to: 'a@b.com, , ,c@d.com', cc: '  ' })
    expect(out.to).toBe('a@b.com, c@d.com')
    expect(out.cc).toBe('')
  })

  it('reports which contacts it used, so the dialog can attribute every line', () => {
    const out = resolveSelection(BOOK, ['o2'], {})
    expect(out.used.map((x) => x.id).sort()).toEqual(['o2', 'r1', 'r2'])
  })

  it('returns nothing to send when the book is empty, rather than inventing a recipient', () => {
    expect(resolveSelection([], [], {})).toEqual({ to: '', cc: '', used: [] })
  })
})

describe('guard: the book is the authority, not the browser', () => {
  const send = readFileSync(
    join(process.cwd(), 'src/app/actions/purchase-orders/send-manufacturing-po.ts'),
    'utf8',
  )
  const lib = readFileSync(join(process.cwd(), 'src/lib/send-contacts.ts'), 'utf8')
  const action = readFileSync(
    join(process.cwd(), 'src/app/actions/purchase-orders/send-contacts.ts'),
    'utf8',
  )
  const card = readFileSync(
    join(process.cwd(), 'src/app/(dashboard)/purchase-orders/[id]/manufacturing-card.tsx'),
    'utf8',
  )

  it('resolves the recipients from the book on the server', () => {
    expect(send).toContain("const book = await loadSendContacts(\"manufacturing\")")
    expect(send).toContain('resolveSelection(book, parsed.data.contact_ids ?? []')
  })

  it('refuses rather than sending to nobody when the book has no recipient', () => {
    expect(send).toContain('The address book has no recipient for a manufacturing order.')
  })

  it('still routes through the one test switch', () => {
    expect(send).toMatch(/resolveRecipients\(\{[\s\S]{0,120}to: bamidaTo,[\s\S]{0,60}cc: bamidaCc,/)
  })

  it('never ticks or requires a contact added from a send screen', () => {
    // Required means "on every order the Hub ever sends". Nobody sets that in passing.
    expect(lib).toContain('default_selected: false')
    expect(lib).toContain('is_required: false')
    // The caller cannot name those either: the action takes no such field.
    expect(action).not.toContain('is_required')
    expect(action).not.toContain('default_selected')
  })

  it('gates adding a contact on the capability that raises orders', () => {
    expect(action).toContain("auth.capabilities.has('po.create')")
  })

  it('shows required rows ticked and locked, so nobody thinks they can drop one', () => {
    expect(card).toContain('checked={c.isRequired || picked.includes(c.id)}')
    expect(card).toContain('disabled={c.isRequired || pending}')
    expect(card).toContain('cannot be removed here')
  })

  it('does not put required ids in the browser state at all', () => {
    // If they were in `picked`, unticking one would look possible and then silently do nothing.
    expect(card).toContain('c.defaultSelected && !c.isRequired')
  })
})

describe('the factory emails carry no sign-in', () => {
  // Dean, 24 Sep 2026, once Bamida had saved the login: "please remove the email and password for
  // hub login section". From 17 Sep the password went out in every order email and confirmation,
  // and sat in the n8n execution data. It no longer leaves the Hub.
  const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')
  const code = (f: string) =>
    read(f)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
  const files = {
    send: 'src/app/actions/purchase-orders/send-manufacturing-po.ts',
    confirm: 'src/app/actions/factory/notify-po-confirmed.ts',
    orders: 'src/app/actions/factory/orders.ts',
    contacts: 'src/lib/send-contacts.ts',
  }

  it('sends null for the login on the order email and on the confirmation, which prints nothing', () => {
    expect(code(files.send)).toContain('login: null,')
    expect(code(files.confirm)).toContain('login: null,')
  })

  it('reads no password, so none can be put in an email', () => {
    for (const [name, file] of Object.entries(files)) {
      const src = code(file)
      expect(src, name).not.toMatch(/password/i)
      expect(src, name).not.toContain('factoryLogin')
    }
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [join(dir, e.name)] : [],
      )
    const readers = walk(join(process.cwd(), 'src')).filter((f) => readFileSync(f, 'utf8').includes('BAMIDA_PASSWORD'))
    expect(readers).toEqual([])
  })

  it('is not in the send preview either, which is about recipients and contents', () => {
    const send = read(files.send)
    const preview = send.slice(send.indexOf('export async function previewManufacturingPoSend'))
    expect(preview.slice(0, 1200)).not.toContain('login')
  })
})

describe('the guide is attached, and can never stop an order', () => {
  // Dean, 17 Sep 2026: "can you attache the pdf document you made to each email if possible?"
  const lib = readFileSync(join(process.cwd(), 'src/lib/factory-guide.ts'), 'utf8')
  const send = readFileSync(
    join(process.cwd(), 'src/app/actions/purchase-orders/send-manufacturing-po.ts'),
    'utf8',
  )
  const confirm = readFileSync(
    join(process.cwd(), 'src/app/actions/factory/notify-po-confirmed.ts'),
    'utf8',
  )

  it('is on the order email and the confirmation', () => {
    expect(send).toContain('attachment: await factoryGuideAttachment()')
    expect(confirm).toContain('attachment: meta.attachment ?? null')
  })

  it('returns null rather than throwing, on every failure', () => {
    // 🔴 A guide that cannot be read must never be why a purchase order does not reach the factory.
    expect(lib).toContain('if (!res.ok) return null')
    expect(lib).toContain('} catch {\n    return null')
    expect(lib).toContain('const controller = new AbortController()')
  })

  it('refuses anything that is not actually a PDF', () => {
    // An error page fetched from our own site is 200 and is not a guide.
    expect(lib).toContain("bytes.subarray(0, 4).toString() !== '%PDF'")
    expect(lib).toContain('bytes.length < 10_000')
  })

  it('ships the file the helper asks for', () => {
    expect(existsSync(join(process.cwd(), 'public/guides/navod-pre-vyrobu.pdf'))).toBe(true)
    expect(lib).toContain("'/guides/navod-pre-vyrobu.pdf'")
  })
})
