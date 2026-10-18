/** The host `connection` service seam every plugin fetch route (detail, backfill trigger, balance,
 * skills) registers through. One home for the face and the bind-at-extraction guard: an unbound
 * hand-off loses `this` on the real face. */

export interface ConnectionHostFace {
  fetch?: {
    register?(route: {
      path: string
      methods: readonly string[]
      requestBody: 'buffered'
      fetch: (request: Request) => Response | Promise<Response>
    }): () => void
  }
}

/** The route registrar off the face, bound at extraction. */
function fetchRouteRegistrar(connection: ConnectionHostFace | undefined) {
  return typeof connection?.fetch?.register === 'function'
    ? connection.fetch.register.bind(connection.fetch)
    : undefined
}

/** The injected fiber's `effect`, as the route registration uses it. */
interface EffectScope {
  effect(effect: () => () => void, hint?: string): unknown
}

/**
 * Register one plugin fetch route. Every route is a POST behind the same `/api` fence, so the shape,
 * the bind-at-extraction guard, and the refuse-quietly catch live here instead of in each watcher.
 * @returns whether the route is now registered — false when the face is absent or the registry refuses.
 */
export function registerPostRoute(
  c: EffectScope,
  connection: ConnectionHostFace | undefined,
  path: string,
  fetch: (request: Request) => Response | Promise<Response>,
  label: string,
): boolean {
  const register = fetchRouteRegistrar(connection)
  if (register === undefined) return false
  try {
    c.effect(() => register({ path, methods: ['POST'], requestBody: 'buffered', fetch }), label)
  } catch {
    // A hostile or rejecting registry must not take the plugin down; the route simply stays absent.
    return false
  }
  return true
}
