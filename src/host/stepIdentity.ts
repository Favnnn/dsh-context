/**
 * Step-boundary message identity guard (issue #51 compatibility).
 *
 * The harness refuses to LOAD a session whose durable log carries a `user/message` without a
 * non-empty string `id` (`assertMessageEventShape`: "session event at seq N lacks an identified
 * message"), while the runtime append path runs no such check — one unidentified message
 * persists silently and bricks the session at its next load.
 *
 * The guard hardens the durability boundary: `agent/pre-step` is the one seam all claimed inbox
 * input flows through before it persists, and a prepended listener sits OUTERMOST in that
 * waterfall, so after `next()` it sees the final message list. Fail-open by contract: a hostile
 * entry, a missing list, or any unexpected shape leaves the decision verbatim.
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'

const MINTED_ID_PREFIX = 'dshctx-'

export interface PreStepDecision {
  kind?: unknown
  messages?: unknown[]
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    'agent/pre-step'(
      this: Context,
      input: { agent: unknown; messages: unknown[]; signal: AbortSignal; step: number; turn: number },
      next: () => Promise<PreStepDecision>,
    ): Promise<PreStepDecision>
  }
}

/** Whether the message fails the harness's restore-time identity check (a non-empty string id).
 * Non-object entries are unfixable — an id needs a container — and stay verbatim. */
function lacksId(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false
  const id = (message as { id?: unknown }).id
  return typeof id !== 'string' || id === ''
}

/** Mint ids for the messages that would persist unidentified; untouched entries pass by reference,
 * and undefined means every entry already carried an identity. */
export function identifiedMessages(messages: readonly unknown[]): unknown[] | undefined {
  let copy: unknown[] | undefined
  for (const [index, message] of messages.entries()) {
    if (!lacksId(message)) {
      copy?.push(message)
      continue
    }
    copy ??= messages.slice(0, index)
    copy.push({ ...(message as object), id: MINTED_ID_PREFIX + randomUUID() })
  }
  return copy
}

export function watchStepIdentity(ctx: Context): void {
  ctx.on('agent/pre-step', async (_input, next) => {
    const decision = await next()
    try {
      if (decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
      const identified = identifiedMessages(decision.messages)
      return identified === undefined
        ? decision
        : { ...decision, messages: identified }
    } catch {
      return decision
    }
  }, { prepend: true })
}
