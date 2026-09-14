/* Writing the live feed down as it arrives, so a day can be played back at the ladder.
 *
 * Fed from the ProjectX relay — every print and every folded quote on a contract the app is
 * streaming anyway, because a chart, a ticket or a ladder has it open. It opens no subscription
 * of its own: what is recorded is what was watched, and a contract nobody looked at costs the
 * gateway nothing extra.
 *
 * Two things come out of it:
 *
 *   - the TAPE, in the tick store (store/tickStore.js), every event as it arrived;
 *   - CANDLES built from that tape, one-minute bars in the bar store under the contract's name
 *     with `.REC` after it. A recorded day is then a dataset like any other: it can be charted,
 *     backtested and replayed without anything having been downloaded, and its candles and its
 *     tape cannot disagree, since one is made from the other.
 *
 * Buffered and written every few seconds rather than per message. A busy contract sends
 * dozens of prints a second, and a write per message would be a disk busier than the market.
 * A crash costs the seconds since the last flush.
 *
 * On by default and switched off in Settings — see recorderStore.js for why.
 */
import { appendTicks, PRINT, QUOTE, writeRecordingMeta } from './store/tickStore.js';
import { mergeBars } from './store/barStore.js';

const MINUTE_MS = 60_000;

/**
 * How long after a minute ends its candle is still left open.
 *
 * Prints reach the relay a moment after they happen, in batches. A candle written the instant
 * its minute ended would miss the last of them — and one of those arriving afterwards would
 * start a candle of its own at the same minute and overwrite the real one with a single print.
 */
const GRACE_MS = 30_000;

/** The dataset a contract's recorded candles are kept under. */
export function recordedDatasetName(name) {
  return `${name}.REC`;
}

/**
 * @param {object} opts
 * @param {string} opts.ticksRoot   where the tick store lives
 * @param {string} opts.dataDir     the bar store
 * @param {(contractId: string) => string} opts.nameOf   the contract's name — `NQU6` for `CON.F.US.ENQ.U26`
 * @param {(contractId: string) => ({tickSize?: number, tickValue?: number} | null)} [opts.infoOf]
 *   what the gateway says about the contract, written beside the recording once
 * @param {boolean} [opts.enabled]
 * @param {() => number} [opts.now]
 * @param {number} [opts.flushMs]
 */
export function createTickRecorder({ ticksRoot, dataDir, nameOf, infoOf = () => null, enabled = true, now = Date.now, flushMs = 5_000 }) {
  let on = enabled;
  /** Recordings whose contract details have been written down in this run of the app. */
  const described = new Set();

  /**
   * Write down what the contract is, once — its price increment is what a ladder is drawn on,
   * and a replay a week from now has no gateway to ask.
   */
  const describe = (contractId, name) => {
    if (described.has(name)) return;
    const info = infoOf(contractId);
    if (!info) return;
    described.add(name);
    void writeRecordingMeta(ticksRoot, name, { contractId, tickSize: info.tickSize ?? null, tickValue: info.tickValue ?? null })
      .catch((err) => {
        described.delete(name);
        console.error(`[midorii] could not write down what ${name} is`, err);
      });
  };
  /** name → events not yet on disk */
  const pending = new Map();
  /** name → minute time → bar being built */
  const minutes = new Map();
  /** name → the newest minute whose candle is already on disk */
  const written = new Map();
  let timer = null;
  let flushing = null;

  const eventsFor = (name) => {
    if (!pending.has(name)) pending.set(name, []);
    return pending.get(name);
  };

  const arm = () => {
    if (timer || !on) return;
    timer = setInterval(() => { void flush(); }, flushMs);
    // A recorder alone must not keep the process alive.
    timer.unref?.();
  };

  /** Fold one print into the minute it belongs to. */
  const foldMinute = (name, time, price, volume, side) => {
    if (!minutes.has(name)) minutes.set(name, new Map());
    const bars = minutes.get(name);
    const at = Math.floor(time / MINUTE_MS) * MINUTE_MS;
    /* Later than the grace allowed for: the candle is written, and a print on its own would
     * replace it. It is on the tape, where it belongs; the candle keeps what it had. */
    if (at <= (written.get(name) ?? -Infinity)) return;
    const bar = bars.get(at);
    const bought = side === 0 ? volume : 0;
    if (!bar) {
      bars.set(at, { time: at, open: price, high: price, low: price, close: price, volume, buyVolume: bought });
      return;
    }
    /* Prints arrive in the order they happened, so the last one folded in is the close. A late
     * print is still counted in the range and the volume, which it is part of. */
    bar.high = Math.max(bar.high, price);
    bar.low = Math.min(bar.low, price);
    bar.close = price;
    bar.volume += volume;
    bar.buyVolume += bought;
  };

  /** A batch of prints off the hub, as the gateway sends them. */
  const onPrints = (contractId, prints) => {
    if (!on || !Array.isArray(prints)) return;
    const name = nameOf(contractId);
    describe(contractId, name);
    const events = eventsFor(name);
    for (const print of prints) {
      if (!print || typeof print.price !== 'number') continue;
      const time = print.timestamp ? Date.parse(print.timestamp) : now();
      if (Number.isNaN(time)) continue;
      const volume = typeof print.volume === 'number' ? print.volume : 0;
      // 0 = the buyer crossed the spread, 1 = the seller. Measured on the feed, not documented.
      const side = print.type === 0 || print.type === 1 ? print.type : null;
      events.push([time, PRINT, print.price, volume, side]);
      foldMinute(name, time, print.price, volume, side);
    }
    arm();
  };

  /** A complete quote, after the relay has folded the gateway's delta into it. */
  const onQuote = (contractId, quote) => {
    if (!on || !quote) return;
    if (quote.bid == null && quote.ask == null && quote.last == null) return;
    const time = Number.isFinite(quote.time) && quote.time > 0 ? quote.time : now();
    eventsFor(nameOf(contractId)).push([time, QUOTE, quote.bid ?? null, quote.ask ?? null, quote.last ?? null]);
    arm();
  };

  /**
   * Write out what is buffered.
   *
   * Candles only for minutes that are OVER, unless `all`: a minute still running is written
   * once it has finished, so the bar store never holds half a candle that a later flush would
   * have to overwrite. `all` is for closing the app, where half a candle is better than none.
   */
  const flush = async (all = false) => {
    if (flushing) return flushing;
    flushing = (async () => {
      const failures = [];
      for (const [name, events] of pending) {
        if (events.length === 0) continue;
        const batch = events.splice(0, events.length);
        try {
          await appendTicks(ticksRoot, name, batch);
        } catch (err) {
          // Put back at the front: a failed write must not quietly lose the tape.
          events.unshift(...batch);
          failures.push(`${name} tape: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const cutoff = Math.floor((now() - GRACE_MS) / MINUTE_MS) * MINUTE_MS;
      for (const [name, bars] of minutes) {
        const done = [...bars.values()].filter((b) => all || b.time < cutoff);
        if (done.length === 0) continue;
        try {
          await mergeBars(dataDir, recordedDatasetName(name), done, { source: 'projectx-recording' });
          for (const bar of done) bars.delete(bar.time);
          written.set(name, Math.max(written.get(name) ?? -Infinity, ...done.map((b) => b.time)));
        } catch (err) {
          failures.push(`${name} candles: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (failures.length > 0) {
        console.error(`[midorii] recording could not be written — ${failures.join('; ')}`);
      }
    })().finally(() => { flushing = null; });
    return flushing;
  };

  return {
    onPrints,
    onQuote,
    flush,
    isEnabled: () => on,
    /** Switching off writes out what was already recorded, and records nothing further. */
    async setEnabled(next) {
      on = next === true;
      if (!on) {
        if (timer) clearInterval(timer);
        timer = null;
        await flush(true);
      }
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await flush(true);
    },
  };
}
