/**
 * Lightweight glob matcher supporting *, **, and ? patterns.
 * No external dependencies — converts a glob pattern to a RegExp.
 */
export function matchGlob(pattern: string, filePath: string): boolean {
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\0')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\0/g, '.*');
  return new RegExp(`^${re}$`).test(filePath);
}
