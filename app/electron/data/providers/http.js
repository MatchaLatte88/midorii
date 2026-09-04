/* Shared HTTP plumbing for the network-paged download sources.
 *
 * Binance is the exception that needs none of this: it publishes whole months
 * as files, so a year is a dozen requests. Coinbase and Hyperliquid serve
 * candles a few hundred or a few thousand at a time, which turns a year of
 * minutes into hundreds of calls — and the thing that decides whether that
 * finishes is staying under the venue's rate limit rather than going as fast
 * as the socket allows.
 *
 * So requests are issued one at a time with a fixed minimum spacing, and a 429
 * is waited out rather than retried immediately. Slower than a burst, and it
 * completes, which a burst does not.
 */

/** Sleep, as a promise. */
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A serial request gate: one call in flight, never closer together than
 * `spacingMs`. Shared per source, so two downloads running at once still add
 * up to one venue's worth of traffic.
 */
export function createGate(spacingMs) {
  let chain = Promise.resolve();
  let earliest = 0;

  return function run(fn) {
    const result = chain.then(async () => {
      const wait = earliest - Date.now();
      if (wait > 0) await delay(wait);
      earliest = Date.now() + spacingMs;
      return fn();
    });
    // The gate keeps going after a failed call; the failure goes to the caller.
    chain = result.then(() => undefined, () => undefined);
    return result;
  };
}

/** How long a 429 asked us to wait, in ms. Zero when it did not say. */
function retryAfterMs(res) {
  const header = res.headers.get('retry-after');
  if (!header) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

/**
 * One request through `gate`, waiting out rate limits.
 *
 * A 429 or a 5xx is transient — the venue is asking for a moment, not refusing
 * — so it is retried with a growing backoff. Anything else throws: a 400 on a
 * misspelled symbol must reach the user as an error, not as an empty dataset.
 */
export async function request(gate, url, init = {}, { retries = 5, backoffMs = 1000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await gate(() => fetch(url, init));
    if (res.ok) return res;

    const transient = res.status === 429 || res.status >= 500;
    if (!transient || attempt >= retries) {
      throw new Error(`${url} → HTTP ${res.status} ${res.statusText}`);
    }
    const backoff = backoffMs * 2 ** attempt + Math.random() * 250;
    await delay(Math.max(retryAfterMs(res), backoff));
  }
}

/** `YYYY-MM` for a moment — the label a download reports progress against. */
export function monthLabel(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
