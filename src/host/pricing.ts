/**
 * Token pricing — the harness token-meter's fixed-density heuristic
 * (`dsh-token-meter/estimate.ts`): 4 chars ≈ 1 token, +4 per content block, +4 role framing.
 *
 * One divergence: `image` blocks price by pixel dimensions through the vision docs calculator
 * (shared/imageTokens.ts), falling back to the meter's JSON price.
 */

import { estimateTextTokens } from '../shared/estimate'
import { estimateImageTokens } from '../shared/imageTokens'

const CHARS_PER_TOKEN = 4
const BLOCK_OVERHEAD = 4
const ROLE_OVERHEAD = 4

export function estimateToolsTotal(tools: unknown[]): number {
  return tools.length > 0
    ? Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
    : 0
}

export interface ContentBlock {
  type: string
  text?: string
  name?: string
  arguments?: string
  content?: ContentBlock[]
  callId?: string
  /** Durable image attachment ref; the log is untrusted, so the fold re-proves its shape. */
  attachment?: { width?: unknown; height?: unknown } | null
}

function estimateBlocks(blocks: unknown): number {
  let tokens = 0
  if (!Array.isArray(blocks)) return 0
  for (const item of blocks) {
    // A null or primitive element prices as bare overhead instead of throwing the whole fold.
    if (item === null || typeof item !== 'object') {
      tokens += BLOCK_OVERHEAD
      continue
    }
    const block = item as ContentBlock
    switch (block.type) {
      case 'text':
      case 'reasoning':
        tokens += estimateTextTokens(block.text || '')
        break
      case 'tool-call':
        tokens += Math.ceil((block.name || '').length / CHARS_PER_TOKEN)
          + Math.ceil((block.arguments || '').length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
        break
      case 'image': {
        const ref = block.attachment
        const priced = ref !== null && typeof ref === 'object'
          && typeof ref.width === 'number' && typeof ref.height === 'number'
          ? estimateImageTokens(ref.width, ref.height)
          : null
        tokens += (priced ?? Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN)) + BLOCK_OVERHEAD
        break
      }
      default:
        tokens += BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN)
    }
  }
  return tokens
}

/** Price one surface message exactly like dsh's meter: an empty-content assistant/developer event
 * projects to NO message, so it prices 0. */
export function estimateMessage(message: { content?: ContentBlock[] } | undefined | null, emptyIsZero = false): number {
  if (emptyIsZero && (message === null || message === undefined
    || !Array.isArray(message.content) || message.content.length === 0)) {
    return 0
  }
  return estimateBlocks(message?.content) + ROLE_OVERHEAD
}

/** Per-tool price; the total uses the meter's whole-array price. */
export function estimateToolSchema(tool: unknown): number {
  return Math.ceil(JSON.stringify(tool).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
}

/** Count image blocks recursively; seeds each node's `imgs`, which the stats board sums over the
 * LIVE surface (compacted messages stop counting). */
export function imageCountOf(blocks: unknown): number {
  let count = 0
  if (!Array.isArray(blocks)) return 0
  for (const item of blocks) {
    if (item === null || typeof item !== 'object') continue
    const block = item as ContentBlock
    if (block.type === 'image') count++
    else if (Array.isArray(block.content)) count += imageCountOf(block.content)
  }
  return count
}

export function firstText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  for (const item of blocks) {
    if (item === null || typeof item !== 'object') continue
    const b = item as ContentBlock
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '') {
      return b.text.replace(/\s+/g, ' ').trim().slice(0, 80)
    }
  }
  return ''
}

export function toolCallNames(blocks: unknown): string[] {
  const names: string[] = []
  if (!Array.isArray(blocks)) return names
  for (const item of blocks) {
    if (item === null || typeof item !== 'object') continue
    const b = item as ContentBlock
    if (b.type === 'tool-call' && typeof b.name === 'string') names.push(b.name)
  }
  return names
}

export interface MessageSource {
  kind?: string
  form?: string
  name?: string
  plugin?: string
  summary?: string
  // Entries stay nullable: any plugin may author a snapshot source, so the preview read must not trust the element shape.
  sections?: ({ name?: string } | null)[]
  changes?: ({ path?: string } | null)[]
}

/** Producer label for an injection event, mirroring the dsh transcript's context provenance:
 * workspace instructions name their reconciled files, a plugin source its id, any other producer its durable kind. */
export function injectionSourceName(source: MessageSource | null | undefined): string {
  if (source?.kind === 'agent-instructions' && Array.isArray(source.changes)) {
    const paths: string[] = []
    for (const change of source.changes) {
      const path = change?.path
      if (typeof path === 'string' && path !== '' && !paths.includes(path)) paths.push(path)
    }
    if (paths.length > 0) return paths.join(', ')
  }
  const plugin = source?.plugin
  if (typeof plugin === 'string' && plugin !== '') return plugin
  const kind = source?.kind
  return typeof kind === 'string' && kind !== '' ? kind : ''
}

export function isInjection(source: MessageSource | null | undefined): source is MessageSource {
  // Mirrors the dsh transcript's classification (conversation-nodes/message.ts): a user/message
  // is injected context when its durable source kind is anything but 'user' ('user-rpc' keeps
  // kind 'user'); the form check covers a foreign source with no readable kind.
  return source !== null && source !== undefined
    && ((typeof source.kind === 'string' && source.kind !== '' && source.kind !== 'user')
      || typeof source.form === 'string')
}
