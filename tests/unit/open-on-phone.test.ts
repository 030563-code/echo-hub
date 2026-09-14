import { describe, expect, it } from 'vitest'
import { phoneUrl } from '@/lib/open-on-phone'

describe('phoneUrl', () => {
  it('keeps the path and the query exactly', () => {
    expect(phoneUrl('https://hub.example.com/quotes/create/123?tab=lines&from=qr-test')).toBe(
      'https://hub.example.com/quotes/create/123?tab=lines&from=qr-test',
    )
  })

  it('drops the hash', () => {
    expect(phoneUrl('https://hub.example.com/po/42?view=board#line-3')).toBe(
      'https://hub.example.com/po/42?view=board',
    )
    expect(phoneUrl('https://hub.example.com/po#')).toBe('https://hub.example.com/po')
  })

  it('keeps a port on a local address', () => {
    expect(phoneUrl('http://192.168.1.20:3000/?from=qr-test')).toBe('http://192.168.1.20:3000/?from=qr-test')
  })

  it('handles a bare origin', () => {
    expect(phoneUrl('https://hub.example.com')).toBe('https://hub.example.com/')
  })

  it('returns anything unparseable unchanged', () => {
    expect(phoneUrl('not a url')).toBe('not a url')
    expect(phoneUrl('')).toBe('')
    expect(phoneUrl('/relative/path?x=1#y')).toBe('/relative/path?x=1#y')
    expect(phoneUrl('mailto:someone@example.com')).toBe('mailto:someone@example.com')
  })
})
