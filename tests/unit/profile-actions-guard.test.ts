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

  it('puts the bytes in before the version, and clears the version before the bytes go', () => {
    const body = (name: string) => {
      const start = source.indexOf(`export async function ${name}(`)
      const next = source.indexOf('\nexport ', start + 1)
      return start === -1 ? '' : source.slice(start, next === -1 ? undefined : next)
    }
    // Upload: the object is upserted FIRST, so no version is ever stamped for
    // bytes that are not in place yet.
    const upload = body('uploadAvatar')
    const put = upload.indexOf('.upload(auth.user.id,')
    const stamp = upload.indexOf('avatar_updated_at: new Date().toISOString()')
    expect(put, 'uploadAvatar upserts the object').toBeGreaterThan(-1)
    expect(upload).toMatch(/upsert:\s*true/)
    expect(stamp, 'uploadAvatar stamps avatar_updated_at').toBeGreaterThan(-1)
    expect(put, 'uploadAvatar must upsert the bytes before it stamps the version').toBeLessThan(stamp)
    // Remove: the version is nulled FIRST, so the route 404s even if the
    // object delete then fails.
    const remove = body('removeAvatar')
    const clear = remove.indexOf('avatar_updated_at: null')
    const drop = remove.indexOf('.remove([auth.user.id])')
    expect(clear, 'removeAvatar clears avatar_updated_at').toBeGreaterThan(-1)
    expect(drop, 'removeAvatar removes the object').toBeGreaterThan(-1)
    expect(clear, 'removeAvatar must null the version before it removes the object').toBeLessThan(drop)
  })

  it('ignores the declared file type and stores the sniffed one', () => {
    expect(source).toMatch(/sniffImageType\(bytes\)/)
    expect(source).not.toMatch(/file\.type/)
  })
})

describe('src/app/api/avatar/[userId]/route.ts', () => {
  const source = existsSync(join(process.cwd(), ROUTE)) ? read(ROUTE) : ''

  /**
   * The route without its comments, so prose cannot satisfy a check: block
   * comments first (a denial wrapped in slash-star must not count), then line
   * comments, whole-line or trailing. A trailing one must start after
   * whitespace, so the // inside a url in a string is left alone.
   */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')

  it('serves GET only, and exports nothing but GET and the dynamic flag', () => {
    const methods = [...code.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)].map((m) => m[1])
    expect(methods).toEqual(['GET'])
    expect(code).toMatch(/^export const dynamic = 'force-dynamic'$/m)
    // Every other export is refused: a POST, a const, a let, a default, a
    // re-export, or an export { } list.
    const exportLines = code.split('\n').filter((line) => /\bexport\b/.test(line))
    const allowed = [/^export\s+(?:async\s+)?function\s+GET\s*\(/, /^export const dynamic = 'force-dynamic'$/]
    const other = exportLines.filter((line) => !allowed.some((re) => re.test(line)))
    expect(other).toEqual([])
    expect(exportLines).toHaveLength(2)
    expect(code).not.toMatch(/\bexport\s*\{/)
  })

  it('authorises on the session user or a super admin', () => {
    expect(code).toMatch(/getAuthorizedUser\(\)/)
    expect(code).toMatch(/===\s*auth\.user\.id|auth\.user\.id\s*===/)
    expect(code).toMatch(/auth\.profile\.is_super_admin/)
  })

  it('refuses a non-owner who is not a super admin before it reads the bucket', () => {
    // The decision: the requested id is the session user, or the viewer is a
    // super admin, and NOTHING else. Anchored to the whole line, so a trailing
    // "|| true" or any other clause after is_super_admin does not match.
    const decision =
      /^[ \t]*const\s+(\w+)\s*=\s*parsed\.data\s*===\s*auth\.user\.id\s*\|\|\s*auth\.profile\.is_super_admin[ \t]*;?[ \t]*$/m.exec(
        code,
      )
    expect(decision, 'the owner-or-super-admin decision is missing, or has something after it').toBeTruthy()
    // The denial: an early return of the 404 when that decision is false, on its own line.
    const denial = new RegExp(
      `^[ \\t]*if\\s*\\(\\s*!${decision![1]}\\s*\\)\\s*return\\s+notFound\\(\\)[ \\t]*;?[ \\t]*$`,
      'm',
    ).exec(code)
    expect(denial, 'the early return that refuses everyone else is missing').toBeTruthy()
    // The denial follows the decision directly. Nothing may sit between them: no
    // continuation line ("|| true" on the next line still belongs to the
    // expression) and no reassignment.
    const between = code.slice(decision!.index + decision![0].length, denial!.index)
    expect(between.trim(), 'code between the decision and the denial').toBe('')
    // Both come before the first storage read, so no byte is fetched for a refused viewer.
    const download = code.indexOf('.download(')
    expect(download, 'the storage download call is missing').toBeGreaterThan(-1)
    expect(decision!.index).toBeLessThan(denial!.index)
    expect(denial!.index).toBeLessThan(download)
    // And notFound really answers 404.
    expect(code).toMatch(/function notFound\(\): Response \{\s*return new Response\('Not found', \{\s*status: 404,/)
  })

  it('asks the database for the current version before it reads the bucket, and 404s without one', () => {
    const download = code.indexOf('.download(')
    expect(download, 'the storage download call is missing').toBeGreaterThan(-1)
    // The read: avatar_updated_at for the REQUESTED user, as one row or none.
    const read = /\.from\('profiles'\)\s*\.select\('avatar_updated_at'\)\s*\.eq\('id',\s*parsed\.data\)\s*\.maybeSingle\(\)/.exec(code)
    expect(read, 'the avatar_updated_at read is missing').toBeTruthy()
    expect(read!.index, 'avatar_updated_at must be read before the download').toBeLessThan(download)
    // An error, no row, or a null version all give the same 404, before the download.
    const nullCheck =
      /^[ \t]*if\s*\(\s*rowErr\s*\|\|\s*!row\s*\|\|\s*row\.avatar_updated_at\s*===\s*null\s*\)\s*return\s+notFound\(\)[ \t]*;?[ \t]*$/m.exec(
        code,
      )
    expect(nullCheck, 'the error / no row / null version check returning 404 is missing').toBeTruthy()
    expect(read!.index).toBeLessThan(nullCheck!.index)
    expect(nullCheck!.index).toBeLessThan(download)
    // The version comes from the same conversion avatarSrc() uses.
    expect(code).toMatch(/import \{[^}]*\bavatarVersion\b[^}]*\} from '@\/lib\/profile\/avatar'/)
    const version = /^[ \t]*const\s+(\w+)\s*=\s*avatarVersion\(row\.avatar_updated_at\)[ \t]*;?[ \t]*$/m.exec(code)
    expect(version, 'the version is not computed with avatarVersion()').toBeTruthy()
    expect(code).toMatch(new RegExp(`^[ \\t]*if\\s*\\(\\s*${version![1]}\\s*===\\s*null\\s*\\)\\s*return\\s+notFound\\(\\)`, 'm'))
  })

  it('caches for a year only when the url names the current version', () => {
    const version = /const\s+(\w+)\s*=\s*avatarVersion\(row\.avatar_updated_at\)/.exec(code)
    expect(version, 'the version is not computed with avatarVersion()').toBeTruthy()
    // v must EQUAL the current version, not merely be present.
    const current = new RegExp(
      `^[ \\t]*const\\s+(\\w+)\\s*=\\s*request\\.nextUrl\\.searchParams\\.get\\('v'\\)\\s*===\\s*String\\(${version![1]}\\)[ \\t]*;?[ \\t]*$`,
      'm',
    ).exec(code)
    expect(current, 'the v-equals-current-version comparison is missing').toBeTruthy()
    expect(code).not.toMatch(/searchParams\.has\(/)
    // The immutable header is guarded by that comparison and nothing else.
    const header = new RegExp(
      `'Cache-Control':\\s*${current![1]}\\s*\\?\\s*'private, max-age=31536000, immutable'\\s*:\\s*'private, no-store'`,
    )
    expect(code).toMatch(header)
    expect(code.match(/immutable/g) ?? []).toHaveLength(1)
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
