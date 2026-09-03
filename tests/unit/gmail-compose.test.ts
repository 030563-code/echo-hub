import { describe, it, expect } from 'vitest'
import { buildGmailComposeUrl, buildQuoteEmail } from '@/lib/gmail-compose'

const PREFIX = 'https://mail.google.com/mail/?view=cm&fs=1'

function param(url: string, key: string): string | null {
  const found = url.split('&').find((part) => part.startsWith(`${key}=`))
  return found ? decodeURIComponent(found.slice(key.length + 1)) : null
}

describe('buildGmailComposeUrl', () => {
  it('always opens with the fixed compose prefix', () => {
    expect(buildGmailComposeUrl({})).toBe(PREFIX)
    expect(buildGmailComposeUrl({ to: 'a@b.com' }).startsWith(`${PREFIX}&`)).toBe(true)
  })

  it('uses su for the subject, because Gmail ignores subject=', () => {
    const url = buildGmailComposeUrl({ subject: 'Echo Barrier quote' })
    expect(param(url, 'su')).toBe('Echo Barrier quote')
    expect(url).not.toContain('subject=')
  })

  it('round-trips characters that would otherwise break the URL', () => {
    const body = 'Total: $1,200 & rising\nLine two\nCafé — no\ttab'
    const url = buildGmailComposeUrl({ to: 'jo+quotes@example.com', subject: 'A & B = C?', body })
    expect(param(url, 'to')).toBe('jo+quotes@example.com')
    expect(param(url, 'su')).toBe('A & B = C?')
    expect(param(url, 'body')).toBe(body)
  })

  it('encodes newlines as %0A, the only line break Gmail honours in a body', () => {
    expect(buildGmailComposeUrl({ body: 'one\ntwo' })).toContain('body=one%0Atwo')
  })

  it('drops an empty value rather than leaving an empty recipient chip', () => {
    const url = buildGmailComposeUrl({ to: 'a@b.com', cc: '', bcc: null, authuser: '   ' })
    expect(url).toBe(`${PREFIX}&to=a%40b.com`)
  })

  it('carries the BCC logging address and the sending account when given', () => {
    // authuser decides WHICH signed-in account composes. A rep signed into two
    // Google accounts otherwise sends from the wrong one, and HubSpot then logs
    // nothing because the sender is not the connected inbox.
    const url = buildGmailComposeUrl({ to: 'a@b.com', bcc: '3882358@bcc.hubspot.com', authuser: 'jillian.rocco@echobarrier.com' })
    expect(param(url, 'bcc')).toBe('3882358@bcc.hubspot.com')
    expect(param(url, 'authuser')).toBe('jillian.rocco@echobarrier.com')
  })
})

describe('buildQuoteEmail', () => {
  const full = {
    contactFirstName: 'Mike',
    companyName: 'Sun Valley Resort',
    dealName: 'Sun Valley Pickleball Courts',
    quoteNumber: 'EBUS26123',
    quoteLink: 'https://info.echobarrier.com/ETfdAWvCLmudHmrfNe',
    expiresOn: '1 November 2026',
    repName: 'Jillian Rocco',
    repPhone: '+1 312 278 5759',
  }

  it('names the quote and the deal in the subject', () => {
    expect(buildQuoteEmail(full).subject).toBe('Echo Barrier quote EBUS26123 for Sun Valley Pickleball Courts')
  })

  it('drops whichever half of the subject is unknown, with no dangling words', () => {
    expect(buildQuoteEmail({ ...full, quoteNumber: null }).subject).toBe('Echo Barrier quote for Sun Valley Pickleball Courts')
    expect(buildQuoteEmail({ ...full, dealName: '' }).subject).toBe('Echo Barrier quote EBUS26123')
  })

  it('never lets a pasted line break split the subject, which is a header-injection shape', () => {
    const { subject } = buildQuoteEmail({ ...full, dealName: 'Sun Valley\nBcc: attacker@example.com' })
    expect(subject).not.toContain('\n')
    expect(subject).toContain('Sun Valley Bcc: attacker@example.com')
  })

  it('puts the link on its own line, exactly once', () => {
    const { body } = buildQuoteEmail(full)
    expect(body.split('\n')).toContain(full.quoteLink)
    expect(body.split(full.quoteLink)).toHaveLength(2)
  })

  it('greets by first name, and falls back without leaving a gap', () => {
    expect(buildQuoteEmail(full).body.startsWith('Hi Mike,')).toBe(true)
    expect(buildQuoteEmail({ ...full, contactFirstName: null }).body.startsWith('Hi there,')).toBe(true)
  })

  it('omits the expiry and the sign-off cleanly when they are unknown', () => {
    const { body } = buildQuoteEmail({ ...full, expiresOn: null, repName: null, repPhone: null })
    expect(body).not.toContain('valid until')
    expect(body).not.toContain('Thanks,')
    expect(body).not.toMatch(/\n\n\n/)
  })

  it('carries no em-dash, which is a house rule for anything a customer reads', () => {
    expect(buildQuoteEmail(full).body).not.toContain('—')
    expect(buildQuoteEmail(full).subject).not.toContain('—')
  })

  it('leaves the finished URL comfortably short of where browsers truncate', () => {
    const { subject, body } = buildQuoteEmail(full)
    const url = buildGmailComposeUrl({ to: 'mike@sunvalley.com', bcc: '3882358@bcc.hubspot.com', subject, body })
    expect(url.length).toBeLessThan(2000)
  })
})
