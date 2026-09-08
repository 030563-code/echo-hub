import { describe, it, expect, afterEach } from 'vitest'
import {
  resolveRecipients,
  emailTestModeOn,
  emailTestRecipient,
  sendDescription,
} from '@/lib/email-recipients'

const ORIGINAL = process.env.HUB_EMAIL_TEST_RECIPIENT

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.HUB_EMAIL_TEST_RECIPIENT
  else process.env.HUB_EMAIL_TEST_RECIPIENT = ORIGINAL
})

const REAL = {
  to: 'bamida@example.sk',
  cc: 'juraj@echobarrier.eu, dave.lindsay@echobarrier.com',
  bcc: 'tester@example.com',
}

describe('resolveRecipients with no override', () => {
  it('passes the real audience straight through', () => {
    delete process.env.HUB_EMAIL_TEST_RECIPIENT
    const out = resolveRecipients(REAL)
    expect(out.isTest).toBe(false)
    expect(out.intended).toBeNull()
    expect(out.to).toEqual(['bamida@example.sk'])
    expect(out.cc).toEqual(['juraj@echobarrier.eu', 'dave.lindsay@echobarrier.com'])
    expect(out.bcc).toEqual(['tester@example.com'])
  })

  it('treats an override of only whitespace as unset', () => {
    process.env.HUB_EMAIL_TEST_RECIPIENT = '   '
    expect(emailTestRecipient()).toBe('')
    expect(emailTestModeOn()).toBe(false)
    expect(resolveRecipients(REAL).isTest).toBe(false)
  })
})

describe('resolveRecipients with the override set', () => {
  it('sends only to the override and CLEARS cc and bcc', () => {
    process.env.HUB_EMAIL_TEST_RECIPIENT = 'tester@example.com'
    const out = resolveRecipients(REAL)

    expect(out.isTest).toBe(true)
    expect(out.to).toEqual(['tester@example.com'])
    // The whole point. Redirecting `to` while leaving a real cc in place would
    // still mail Juraj, which is the failure this switch exists to prevent.
    expect(out.cc).toEqual([])
    expect(out.bcc).toEqual([])
  })

  it('keeps no real address anywhere in the outgoing lists', () => {
    process.env.HUB_EMAIL_TEST_RECIPIENT = 'tester@example.com'
    const out = resolveRecipients(REAL)
    const outgoing = [...out.to, ...out.cc, ...out.bcc].join(' ').toLowerCase()

    for (const real of ['bamida@example.sk', 'juraj@echobarrier.eu', 'dave.lindsay@echobarrier.com']) {
      expect(outgoing).not.toContain(real)
    }
  })

  it('reports the real audience under intended, so the body can print it', () => {
    process.env.HUB_EMAIL_TEST_RECIPIENT = 'tester@example.com'
    const out = resolveRecipients(REAL)

    expect(out.intended).toEqual({
      to: ['bamida@example.sk'],
      cc: ['juraj@echobarrier.eu', 'dave.lindsay@echobarrier.com'],
      bcc: ['tester@example.com'],
    })
  })

  it('accepts more than one test address', () => {
    process.env.HUB_EMAIL_TEST_RECIPIENT = 'tester@example.com, dave.lindsay@echobarrier.com'
    const out = resolveRecipients({ to: 'bamida@example.sk' })
    expect(out.to).toEqual(['tester@example.com', 'dave.lindsay@echobarrier.com'])
  })
})

describe('normalising the lists', () => {
  it('accepts an array, a comma string, or one address', () => {
    delete process.env.HUB_EMAIL_TEST_RECIPIENT
    expect(resolveRecipients({ to: ['a@x.com', 'b@x.com'] }).to).toEqual(['a@x.com', 'b@x.com'])
    expect(resolveRecipients({ to: 'a@x.com, b@x.com' }).to).toEqual(['a@x.com', 'b@x.com'])
    expect(resolveRecipients({ to: 'a@x.com' }).to).toEqual(['a@x.com'])
  })

  it('drops blanks, nulls and trailing commas rather than sending to ""', () => {
    delete process.env.HUB_EMAIL_TEST_RECIPIENT
    const out = resolveRecipients({ to: ['a@x.com', '', null, undefined, '  '], cc: 'b@x.com,' })
    expect(out.to).toEqual(['a@x.com'])
    expect(out.cc).toEqual(['b@x.com'])
  })

  it('does not send the same mailbox twice because it was typed two ways', () => {
    delete process.env.HUB_EMAIL_TEST_RECIPIENT
    expect(resolveRecipients({ to: 'A@x.com, a@x.com' }).to).toEqual(['A@x.com'])
  })

  it('defaults cc and bcc to empty when they are not given', () => {
    delete process.env.HUB_EMAIL_TEST_RECIPIENT
    const out = resolveRecipients({ to: 'a@x.com' })
    expect(out.cc).toEqual([])
    expect(out.bcc).toEqual([])
  })
})

describe('sendDescription', () => {
  it('names the real recipient on a real send', () => {
    delete process.env.HUB_EMAIL_TEST_RECIPIENT
    expect(sendDescription(resolveRecipients({ to: 'bamida@example.sk' }))).toBe(
      'Sent to bamida@example.sk',
    )
  })

  it('says plainly that the real recipient did not get it', () => {
    process.env.HUB_EMAIL_TEST_RECIPIENT = 'tester@example.com'
    expect(sendDescription(resolveRecipients({ to: 'bamida@example.sk' }))).toBe(
      'Sent to the test address (tester@example.com), not bamida@example.sk',
    )
  })
})
