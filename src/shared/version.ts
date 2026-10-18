/** The harness-version gate's shared arithmetic: the supported dsh baseline and the compare
 * behind it. Dependency-free runtime code used by both halves (the host probes and gates; the
 * client displays the wire record). The baseline mirrors docs/compatibility.md and the
 * package's `dsh.compatibility.dshReleases` declaration. */

export const BASELINE_DSH_VERSION = '0.1.7-rc.2'

/** Release-channel rank at an equal X.Y.Z: a final release > rc > beta > alpha. */
function channelRank(channel: 'alpha' | 'beta' | 'rc'): number {
  return channel === 'rc' ? 3 : channel === 'beta' ? 2 : 1
}
const RELEASE_RANK = 4

export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  rank: number
  serial: number
}

/** Parse `v?X.Y.Z[-(alpha|beta|rc)[.N]][+build]`; other channels (nightly, dev, …) do not parse — the gate fails open on them. */
export function parseVersion(version: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)(?:\.(\d+))?)?(?:\+[0-9a-z.-]+)?$/i.exec(version.trim())
  if (match === null) return null
  const channel = match[4]?.toLowerCase() as 'alpha' | 'beta' | 'rc' | undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    rank: channel === undefined ? RELEASE_RANK : channelRank(channel),
    serial: match[5] ? Number(match[5]) : 0,
  }
}

function compareParsed(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  if (a.rank !== b.rank) return a.rank - b.rank
  return a.serial - b.serial
}

/** FAIL OPEN by design: an unparseable version (a dev/nightly build) must not blank a working
 * deployment, so only a proven below-baseline release trips the gate. */
export function meetsBaseline(version: string, baseline: string = BASELINE_DSH_VERSION): boolean {
  const v = parseVersion(version)
  const b = parseVersion(baseline)
  if (v === null || b === null) return true
  return compareParsed(v, b) >= 0
}
