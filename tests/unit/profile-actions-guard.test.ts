import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The profile endpoints act on the session user and nobody else.
 *
 * Every export of a 'use server' file is a public endpoint, and the avatars
 * bucket has no storage.objects policies, so the service-role client in these
 * two files is the only thing standing between a request and anyone's photo.
 * This pins that shape at source level, so a fourth export, a user id
 * parameter, or a new file quietly reaching into the bucket fails here.
 */

const ACTIONS = 'src/app/actions/profile.ts'
const ROUTE = 'src/app/api/avatar/[userId]/route.ts'
/** Where the bucket name is DEFINED. It may name it; it may not use it. */
const CONSTANTS = 'src/lib/profile/avatar.ts'

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(entry) ? [full] : []
  })
}

describe('the profile guard finds its files', () => {
  it('has the actions file, the route and the constants where it expects them', () => {
    // A moved file would otherwise turn every check below into a pass.
    for (const rel of [ACTIONS, ROUTE, CONSTANTS]) {
      expect(existsSync(join(process.cwd(), rel)), rel).toBe(true)
    }
  })
})

describe('src/app/actions/profile.ts', () => {
  const source = existsSync(join(process.cwd(), ACTIONS)) ? read(ACTIONS) : ''

  it('is a server actions file', () => {
    expect(source).toMatch(/^\s*['"]use server['"]/)
  })

  it('exports exactly updateProfileDetails, uploadAvatar and removeAvatar', () => {
    const fns = [...source.matchAll(/^export\s+async\s+function\s+(\w+)/gm)].map((m) => m[1]).sort()
    expect(fns).toEqual(['removeAvatar', 'updateProfileDetails', 'uploadAvatar'])
    // No other runtime export of any kind: a const or a re-export would be a
    // callable endpoint too, or break the 'use server' contract.
    const exportLines = source.split('\n').filter((line) => /^\s*export\b/.test(line))
    const other = exportLines.filter((line) => !/^export\s+(async\s+function|type|interface)\b/.test(line))
    expect(other).toEqual([])
  })

  it('takes no user id in any parameter list', () => {
    const params = [...source.matchAll(/^export\s+async\s+function\s+\w+\s*\(([^)]*)\)/gm)].map((m) => m[1])
    expect(params.length).toBe(3)
    for (const list of params) {
      expect(list, list).not.toMatch(/user_?id|userId|\bid\b|uid/i)
    }
  })

  it('writes the photo and the timestamp for the session user only', () => {
    expect(source).toMatch(/\.upload\(auth\.user\.id,/)
    expect(source).toMatch(/\.remove\(\[auth\.user\.id\]\)/)
    const idFilters = [...source.matchAll(/\.eq\('id',\s*([^)]+)\)/g)].map((m) => m[1].trim())
    expect(idFilters.length).toBeGreaterThanOrEqual(3)
    expect(new Set(idFilters)).toEqual(new Set(['auth.user.id']))
  })

  it('ignores the declared file type and stores the sniffed one', () => {
    expect(source).toMatch(/sniffImageType\(bytes\)/)
    expect(source).not.toMatch(/file\.type/)
  })
})

describe('src/app/api/avatar/[userId]/route.ts', () => {
  const source = existsSync(join(process.cwd(), ROUTE)) ? read(ROUTE) : ''

  it('serves GET only', () => {
    const methods = [...source.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)].map((m) => m[1])
    expect(methods).toEqual(['GET'])
    expect(source).toMatch(/export const dynamic = 'force-dynamic'/)
  })

  it('authorises on the session user or a super admin', () => {
    expect(source).toMatch(/getAuthorizedUser\(\)/)
    expect(source).toMatch(/===\s*auth\.user\.id|auth\.user\.id\s*===/)
    expect(source).toMatch(/auth\.profile\.is_super_admin/)
  })

  it('re-sniffs what it serves and sandboxes the response', () => {
    expect(source).toMatch(/sniffImageType\(/)
    expect(source).toContain(`"default-src 'none'; sandbox"`)
    expect(source).toContain("'X-Content-Type-Options': 'nosniff'")
  })
})

describe('the avatars bucket', () => {
  it('is reached from the actions file and the route, and nowhere else', () => {
    const allowed = new Set([ACTIONS, ROUTE])
    const offenders = walk(join(process.cwd(), 'src'))
      .map((full) => full.replace(`${process.cwd()}/`, ''))
      .filter((rel) => {
        const source = read(rel)
        if (rel === CONSTANTS) {
          // The definition itself, and no other use of the name.
          return (source.match(/['"]avatars['"]/g) ?? []).length !== 1 || /storage\s*\.from\(/.test(source)
        }
        if (allowed.has(rel)) return false
        return /['"]avatars['"]|\bAVATAR_BUCKET\b/.test(source)
      })
    expect(offenders).toEqual([])
  })
})
