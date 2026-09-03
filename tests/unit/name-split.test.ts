import { describe, it, expect } from 'vitest'
import { joinFullName, splitFullName } from '@/lib/name'

describe('splitFullName', () => {
  it('handles the ordinary two-word case', () => {
    expect(splitFullName('Jillian Rocco')).toEqual({ firstname: 'Jillian', lastname: 'Rocco' })
  })

  it('leaves a single word as the first name, so validation still catches it', () => {
    // The dialog requires both, so lastname: '' keeps the existing "First and
    // last name are required" message doing its job.
    expect(splitFullName('Cher')).toEqual({ firstname: 'Cher', lastname: '' })
  })

  it('gives three or more words a MULTI-WORD SURNAME, not a middle name', () => {
    // The deliberate call: multi-word surnames are far commoner here than
    // multi-word given names, and both fields stay editable.
    expect(splitFullName('Jean Luc Picard')).toEqual({ firstname: 'Jean', lastname: 'Luc Picard' })
    expect(splitFullName('Ana van der Berg')).toEqual({ firstname: 'Ana', lastname: 'van der Berg' })
    expect(splitFullName('Maria De La Cruz')).toEqual({ firstname: 'Maria', lastname: 'De La Cruz' })
  })

  it('is unbothered by doubled, leading and trailing whitespace', () => {
    // This is the case that would otherwise write " Rocco" to the live CRM.
    expect(splitFullName('  Jillian   Rocco  ')).toEqual({ firstname: 'Jillian', lastname: 'Rocco' })
    expect(splitFullName('\tJillian\nRocco ')).toEqual({ firstname: 'Jillian', lastname: 'Rocco' })
  })

  it('returns two empty strings for empty input rather than throwing', () => {
    expect(splitFullName('')).toEqual({ firstname: '', lastname: '' })
    expect(splitFullName('   ')).toEqual({ firstname: '', lastname: '' })
    expect(splitFullName(undefined as unknown as string)).toEqual({ firstname: '', lastname: '' })
  })
})

describe('joinFullName', () => {
  it('recomposes without leaving stray spaces when a part is blank', () => {
    expect(joinFullName('Jillian', 'Rocco')).toBe('Jillian Rocco')
    expect(joinFullName('Cher', '')).toBe('Cher')
    expect(joinFullName('', 'Rocco')).toBe('Rocco')
    expect(joinFullName('', '')).toBe('')
  })

  it('round-trips a name it just split', () => {
    for (const name of ['Jillian Rocco', 'Ana van der Berg', 'Cher']) {
      const { firstname, lastname } = splitFullName(name)
      expect(joinFullName(firstname, lastname)).toBe(name)
    }
  })
})
