/** The one plain-object re-proof every untrusted payload passes through before a field is read off
 * it. Arrays are excluded: they are objects at runtime but carry no keyed record to read. */

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
