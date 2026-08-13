import type { ApiLike } from './compat';

/**
 * The browser's connection to the chain — lazily created, reference-counted,
 * and torn down when nothing needs it.
 *
 * Three features want a socket (wallet, stash inspection, Live), so callers
 * take a lease on one shared connection rather than opening their own. It opens
 * on the first lease and closes when the last is released, which makes
 * "disabling Live tears down every subscription" a property of the design.
 *
 * `@polkadot/api` is imported dynamically and nowhere else in client code —
 * statically it is megabytes ahead of any application code. The lint rule in
 * `eslint.config.mjs` enforces this and `npm run assert:lazy` checks the built
 * output rather than trusting the rule.
 */

export interface ApiLease {
  api: ApiLike;
  /** Idempotent. Releasing twice must not close someone else's connection. */
  release: () => void;
}

/** Injectable so tests can exercise the lifecycle without a chain. */
export interface ApiFactory {
  (endpoint: string): Promise<{ api: ApiLike; disconnect: () => Promise<void> }>;
}

interface Connection {
  endpoint: string;
  leases: number;
  /** Held as a promise so concurrent acquires share one dial. */
  pending: Promise<{ api: ApiLike; disconnect: () => Promise<void> }>;
}

let current: Connection | null = null;

/**
 * How long to wait for the first connection before giving up. There must be a
 * bound: `WsProvider` auto-reconnects by default, so the initial
 * `ApiPromise.create` never rejects against an unreachable endpoint — it
 * retries forever while the UI shows a skeleton.
 *
 * Shorter than the pipeline's timeout in `lib/chain/connect.ts`, which is tuned
 * for a scheduled job that can afford to wait.
 */
const CONNECT_TIMEOUT_MS = 12_000;

const defaultFactory: ApiFactory = async (endpoint) => {
  const { ApiPromise, WsProvider } = await import('@polkadot/api');
  type ProviderInterface = ConstructorParameters<typeof ApiPromise>[0] extends
    { provider?: infer P } | undefined
    ? P
    : never;

  // Auto-reconnect left on so a mid-session drop heals by itself; the timeout
  // covers the initial dial it would otherwise retry silently forever.
  const provider = new WsProvider(endpoint);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const api = await Promise.race([
      ApiPromise.create({ provider: provider as ProviderInterface, noInitWarn: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Could not reach ${endpoint} within ${CONNECT_TIMEOUT_MS / 1000}s. The node may be down or blocked by your network.`,
              ),
            ),
          CONNECT_TIMEOUT_MS,
        );
      }),
    ]);

    return {
      api,
      disconnect: async () => {
        await api.disconnect();
      },
    };
  } catch (error) {
    // Release the socket, or the provider keeps retrying in the background
    // after we have already reported failure.
    await provider.disconnect().catch(() => undefined);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
};

let factory: ApiFactory = defaultFactory;

/** Test seam. Passing `null` restores the real factory. */
export function setApiFactory(next: ApiFactory | null): void {
  factory = next ?? defaultFactory;
}

/**
 * Takes a lease on the shared connection, opening it if necessary. A failed
 * dial clears the cached entry, so the next attempt genuinely retries rather
 * than re-awaiting a rejected promise.
 */
export async function acquireApi(endpoint: string): Promise<ApiLease> {
  // An endpoint change means a different chain; drop the old one rather than
  // silently serving state from the wrong network.
  if (current != null && current.endpoint !== endpoint) {
    void teardown(current);
    current = null;
  }

  if (current == null) {
    const connection: Connection = {
      endpoint,
      leases: 0,
      pending: factory(endpoint),
    };
    current = connection;

    connection.pending.catch(() => {
      if (current === connection) current = null;
    });
  }

  const connection = current;
  connection.leases += 1;

  // Per *lease*, not per connection: a shared guard on the counter stops it
  // going negative but still lets one caller releasing three times decrement
  // away two other callers' leases and close the socket underneath them.
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseLease(connection);
  };

  try {
    const { api } = await connection.pending;
    return { api, release };
  } catch (error) {
    release();
    throw error;
  }
}

function releaseLease(connection: Connection): void {
  connection.leases -= 1;
  if (connection.leases > 0) return;

  if (current === connection) current = null;
  void teardown(connection);
}

async function teardown(connection: Connection): Promise<void> {
  try {
    const { disconnect } = await connection.pending;
    await disconnect();
  } catch {
    // A connection that never opened has nothing to close, and a disconnect
    // failure is not something a user can act on.
  }
}

/** Open connections. Zero or one — exposed so tests can assert teardown. */
export function activeConnectionCount(): number {
  return current == null ? 0 : 1;
}

/** Outstanding leases on the current connection. */
export function activeLeaseCount(): number {
  return current?.leases ?? 0;
}

/** Drops everything. For tests, and for a hard reset after a fatal error. */
export async function resetApi(): Promise<void> {
  const connection = current;
  current = null;
  if (connection) await teardown(connection);
}
