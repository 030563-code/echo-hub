import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ALWAYS_COPIED, FACTORY_CONTACT, mergeAddresses, factoryCopyTo } from '@/lib/factory-contact'

/**
 * Dean, 17 Sep 2026: "readd the ability to enter email addresses for to and CC which will append
 * to the existing ones just make it clear that andy.murphy@echobarrier.com,
 * dave.lindsay@echobarrier.com, juraj@echobarrier.eu and operations@echobarrier.eu is
 * automatically CCed."
 *
 * 🔴 APPEND is the whole point. The boxes existed before and REPLACED the recipient, which meant
 * any caller of the send action could have the Hub post a real purchase order, on Echo Barrier
 * letterhead, to an address of its choosing and to nobody else.
 */

describe('the fixed addresses', () => {
  it('sends to the manufacturer at one address', () => {
    expect(FACTORY_CONTACT).toBe('sklad@bamida.sk')
  })

  it('always copies the four Dean named', () => {
    expect([...ALWAYS_COPIED]).toEqual([
      'andy.murphy@echobarrier.com',
      // 🔴 Dean wrote echoabarrier.com, with an extra 'a'. His real address, from his own Hub
      // account, is this one. The typo would have bounced silently on every order.
      'dave.lindsay@echobarrier.com',
      'juraj@echobarrier.eu',
      'operations@echobarrier.eu',
    ])
  })

  it('holds them in code, not in an environment variable nobody can read from the screen', () => {
    const source = readFileSync(join(process.cwd(), 'src/lib/factory-contact.ts'), 'utf8')
    for (const address of ALWAYS_COPIED) expect(source).toContain(address)
  })
})

describe('mergeAddresses: extra addresses ADD, they never replace', () => {
  it('keeps the standing address when something is typed', () => {
    expect(mergeAddresses(FACTORY_CONTACT, 'vyroba@bamida.sk')).toBe(
      'sklad@bamida.sk, vyroba@bamida.sk',
    )
  })

  it('cannot be made to drop a standing address', () => {
    // Nothing anybody types is subtractive: the first list always survives.
    for (const attempt of ['', '   ', ',,,', 'someone@else.com']) {
      expect(mergeAddresses(FACTORY_CONTACT, attempt)).toContain(FACTORY_CONTACT)
    }
  })

  it('does not copy somebody twice when they are typed as well as standing', () => {
    expect(mergeAddresses(ALWAYS_COPIED.join(', '), 'juraj@echobarrier.eu')).toBe(
      ALWAYS_COPIED.join(', '),
    )
  })

  it('ignores case when deduplicating, because people type addresses how they like', () => {
    expect(mergeAddresses('juraj@echobarrier.eu', 'Juraj@EchoBarrier.EU')).toBe(
      'juraj@echobarrier.eu',
    )
  })

  it('drops blanks and stray commas rather than emailing an empty address', () => {
    expect(mergeAddresses('a@b.com, , ,c@d.com')).toBe('a@b.com, c@d.com')
    expect(mergeAddresses(null, undefined, '')).toBe('')
  })

  it('puts the four on every order even with nothing configured or typed', () => {
    const before = process.env.BAMIDA_PO_CC
    delete process.env.BAMIDA_PO_CC
    try {
      expect(factoryCopyTo()).toBe(ALWAYS_COPIED.join(', '))
    } finally {
      if (before !== undefined) process.env.BAMIDA_PO_CC = before
    }
  })

  it('still carries anyone the server adds, so nothing configured is silently dropped', () => {
    const before = process.env.BAMIDA_PO_CC
    process.env.BAMIDA_PO_CC = 'extra@echobarrier.com'
    try {
      expect(factoryCopyTo()).toBe(`${ALWAYS_COPIED.join(', ')}, extra@echobarrier.com`)
    } finally {
      if (before === undefined) delete process.env.BAMIDA_PO_CC
      else process.env.BAMIDA_PO_CC = before
    }
  })
})

describe('guard: the send action adds, and the screen says so', () => {
  const send = readFileSync(
    join(process.cwd(), 'src/app/actions/purchase-orders/send-manufacturing-po.ts'),
    'utf8',
  )
  const card = readFileSync(
    join(process.cwd(), 'src/app/(dashboard)/purchase-orders/[id]/manufacturing-card.tsx'),
    'utf8',
  )

  it('merges rather than substituting', () => {
    expect(send).toContain('const bamidaTo = mergeAddresses(FACTORY_CONTACT, typedTo)')
    expect(send).toContain('const bamidaCc = mergeAddresses(factoryCopyTo(), typedCc)')
    // The old shape: a typed value OR the configured one. That is what let a caller replace.
    expect(send).not.toMatch(/parsed\.data\.to \?\? ""\)\.trim\(\) \|\|/)
  })

  it('still routes through the one test switch', () => {
    expect(send).toMatch(/resolveRecipients\(\{[\s\S]{0,120}to: bamidaTo,[\s\S]{0,60}cc: bamidaCc,/)
  })

  it('attributes every line so the dialog can say where it came from', () => {
    expect(send).toContain('"the manufacturer\'s point of contact"')
    expect(send).toContain('"always copied"')
    expect(send).toContain('"the Also send to box"')
    expect(send).toContain('"the Also copy to box"')
  })

  it('prints no address twice in the preview', () => {
    expect(send).toContain('const once = (entries: PreviewAddress[])')
    expect(send).toContain('to: once([')
    expect(send).toContain('cc: once([')
  })

  it('shows the standing lists on the screen and says they cannot be removed', () => {
    expect(card).toContain('Always goes to')
    expect(card).toContain('Always copied to')
    expect(card).toContain('alwaysCopied.map')
    expect(card).toContain('not instead of them')
    expect(card).toContain('Also send to')
    expect(card).toContain('Also copy to')
  })

  it('starts the boxes EMPTY, so nothing is pre-filled to be deleted by accident', () => {
    expect(card).toContain("const [to, setTo] = useState('')")
    expect(card).toContain("const [cc, setCc] = useState('')")
  })
})
