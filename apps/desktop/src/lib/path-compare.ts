/** Comparing two paths for identity or containment, across host spellings.
 *
 *  A cwd reaches us from the backend, a picker, a session row and a project
 *  record, and the four don't agree on separator, trailing slash or drive-letter
 *  case. Compare through these rather than `===` / `startsWith`.
 */

/** Windows drive (`C:\\`, `C:/`) or UNC (`\\\\server\\share`) absolute path.
 *  Such a path never gets joined onto a cwd. */
export const isWindowsAbsolutePath = (path: string): boolean => /^(?:[A-Za-z]:[\\/]|\\\\)/.test(path)

/** POSIX-style spelling: one separator, no trailing slash.
 *  Tolerates garbage inputs: all four path sources disagree on spelling AND
 *  type — a session row can carry a null/number cwd here (live capture
 *  `e.trim is not a function` at cleanPath during spike image-paste playtest —
 *  filterIgnored → ancestorDirs), so compare on a settled `String` or bail. */
export const cleanPath = (path: string): string => {
  if (typeof path !== 'string') {
    return '/'
  }

  return path.trim().replace(/\\/g, '/').replace(/\/+$/, '') || '/'
}

/** Case-folded comparison key. Windows drive/UNC paths are case-insensitive;
 *  POSIX paths are not, and callers that display a path want its real spelling,
 *  so fold only the key. Expects an already-`cleanPath`ed value. */
export const comparisonPath = (path: string): string =>
  typeof path !== 'string' ? '' : /^[A-Za-z]:(?:\/|$)/.test(path) || path.startsWith('//') ? path.toLowerCase() : path

/** True when `child` IS `parent` or lives underneath it. */
export const isUnderPath = (parent: string, child: string): boolean => {
  const p = comparisonPath(cleanPath(parent))
  const c = comparisonPath(cleanPath(child))

  return c === p || c.startsWith(`${p}/`)
}
