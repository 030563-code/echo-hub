import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Nothing reaches an outside company on one click.
 *
 * Dean, 16 Sep 2026: "add second confirmation before sending to Manufacturing on
 * the email and the contents of the email as well as confirmation before sending
 * to Cargo partner along with CC everything and where it comes from."
 *
 * Source grep, the house style of stock-write-guard and factory-guard. The rule
 * it holds is easy to undo by accident: wiring the primary button back to send()
 * is a one-word edit that looks like a tidy-up and removes the only thing
 * standing between a typo and a factory.
 */

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')

/** Source with comments removed, so a guard cannot pass on its own prose. */
const code = (f: string) =>
  read(f)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

const SHAPE = 'src/lib/send-preview.ts'
const DIALOG = 'src/components/po/send-confirm-dialog.tsx'
const MFG_ACTION = 'src/app/actions/purchase-orders/send-manufacturing-po.ts'
const MFG_CARD = 'src/app/(dashboard)/purchase-orders/[id]/manufacturing-card.tsx'
const CARGO_ACTION = 'src/app/actions/purchase-orders/cargo-request.ts'
const CARGO_CARD = 'src/app/(dashboard)/purchase-orders/[id]/cargo-request-card.tsx'
const NOTIFY_CARGO = 'src/app/actions/purchase-orders/notify-cargo-partner.ts'

/** The body of one exported function, up to the next export in the file. */
function exportBody(file: string, name: string): string {
  const source = code(file)
  const start = source.indexOf(`export async function ${name}`)
  expect(start, `${name} not found in ${file}`).toBeGreaterThan(-1)
  const next = source.indexOf('export async function ', start + 1)
  return source.slice(start, next === -1 ? undefined : next)
}

describe('the shape both halves agree on stays pure', () => {
  // Comments stripped: this file's own doc comment quotes the import it bans.
  const source = code(SHAPE)

  it('drags nothing server-side into the client bundle', () => {
    // The dialog imports these types. A 'server-only' import here, or a reach
    // into the recipient resolver, would break the page rather than this test,
    // which is exactly why it is cheaper to assert it.
    expect(source).not.toContain("'server-only'")
    expect(source).not.toContain('@/lib/email-recipients')
    expect(source).not.toContain('@/lib/supabase')
    expect(source).not.toContain('process.env')
  })

  it('names every origin an address can have', () => {
    for (const origin of ['typed', 'server', 'built-in', 'test-override']) {
      expect(source, origin).toContain(`'${origin}'`)
    }
  })
})

describe('the dialog says who gets it and what it carries', () => {
  const source = read(DIALOG)

  it('prints all three lists, the blind copy included', () => {
    // BAMIDA_PO_BCC appears on no screen in the Hub. This dialog is the only
    // place a person can discover that a blind copy is being sent at all.
    expect(source).toContain('preview.to')
    expect(source).toContain('preview.cc')
    expect(source).toContain('preview.bcc')
    expect(source).toContain('Blind copy')
  })

  it('says where every address came from', () => {
    expect(source).toContain('ORIGIN_LABELS[entry.origin]')
    expect(source).toContain('entry.from')
  })

  it('says plainly when the test override means nobody real will get it', () => {
    expect(source).toContain('preview.isTest')
    expect(source).toContain('This will not reach them.')
    expect(source).toContain('preview.instead')
  })

  it('shows the contents and any warning', () => {
    expect(source).toContain('preview.facts')
    expect(source).toContain('preview.lines')
    expect(source).toContain('preview.warnings')
  })

  it('cannot confirm while the preview is still being worked out', () => {
    expect(source).toMatch(/disabled=\{pending \|\| loading \|\| !preview\}/)
  })
})

describe('a preview claims nothing and posts nothing', () => {
  const cases: Array<[string, string, string]> = [
    ['manufacturing', MFG_ACTION, 'previewManufacturingPoSend'],
    ['cargo', CARGO_ACTION, 'previewCargoRequestSend'],
  ]

  for (const [label, file, name] of cases) {
    it(`${label}: the preview writes nothing and contacts nobody`, () => {
      const body = exportBody(file, name)
      expect(body).not.toContain('fetch(')
      expect(body).not.toContain('.update(')
      expect(body).not.toContain('.upsert(')
      expect(body).not.toContain('.insert(')
      expect(body).not.toContain('sent_at')
      expect(body).not.toContain('revalidatePath')
    })

    it(`${label}: the preview passes the same gate the send does`, () => {
      const body = exportBody(file, name)
      const gated = /planManufacturingSend\(/.test(body) || /authorise\(/.test(body)
      expect(gated, `${name} reaches no capability check`).toBe(true)
    })
  }

  it('the manufacturing preview and send are one planner, so they cannot drift', () => {
    const source = code(MFG_ACTION)
    expect((source.match(/await planManufacturingSend\(input\)/g) ?? []).length).toBe(2)
  })

  it('the cargo preview and send resolve their audience through one function', () => {
    const notify = code(NOTIFY_CARGO)
    expect(notify).toContain('export function cargoRecipients(')
    // The send's own resolution goes through it too, rather than repeating the call.
    expect((notify.match(/resolveRecipients\(\{ to: draft\.to, cc: draft\.cc \}\)/g) ?? []).length).toBe(1)
    expect(code(CARGO_ACTION)).toContain('cargoRecipients(draft)')
  })

  it('the manufacturing preview surfaces the copies nobody typed', () => {
    const source = code(MFG_ACTION)
    expect(source).toContain("addressesFrom(process.env.BAMIDA_PO_BCC, \"server\", \"BAMIDA_PO_BCC\")")
    expect(source).toContain('"the Send to box"')
    expect(source).toContain('"the Copy to box"')
  })
})

describe('the button asks before it sends', () => {
  const cases: Array<[string, string, string]> = [
    ['manufacturing', MFG_CARD, 'Send to Bamida'],
    ['cargo', CARGO_CARD, 'Approve and send'],
  ]

  for (const [label, file, buttonText] of cases) {
    it(`${label}: the primary button opens the dialog rather than sending`, () => {
      const source = code(file)
      // The button that carries the send wording must not be wired to send().
      const button = source.slice(source.indexOf('onClick={askToSend}'))
      expect(source).toContain('onClick={askToSend}')
      expect(button.slice(0, 400)).toContain(buttonText)
      expect(source).not.toContain('onClick={send}')
    })

    it(`${label}: only the dialog can start the send`, () => {
      const source = code(file)
      expect(source).toContain('<SendConfirmDialog')
      expect(source).toContain('onConfirm={send}')
    })

    it(`${label}: opening the dialog reads a fresh preview from the server`, () => {
      const source = code(file)
      expect(source).toMatch(/function askToSend\(\)[\s\S]{0,700}preview(Manufacturing|Cargo)\w*\(/)
      // A stale preview from a previous open must never be what somebody approves.
      expect(source).toMatch(/function askToSend\(\)[\s\S]{0,200}setPreview\(null\)/)
    })
  }
})
