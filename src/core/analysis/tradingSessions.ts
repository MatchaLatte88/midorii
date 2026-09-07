import type { OHLCV } from '../model/ohlcv';

/**
 * Trading-session windows — Asia, London, New York — read off a wall clock in each market's
 * own time zone.
 *
 * A session is a window in *local* time, and that is the whole difficulty: London runs
 * 08:00-17:00 London, which is a different UTC offset in summer than in winter, and Britain,
 * the US and Australia each move their clocks on a different weekend. A window defined in
 * fixed UTC hours is wrong for three weeks a year. So every session is read through
 * `Intl.DateTimeFormat` against its own IANA zone, which already knows every one of those
 * rules — nothing here maintains an offset table.
 *
 * Bar times must be milliseconds: everything below goes through `new Date(bar.time)`, and
 * seconds land every bar in January 1970.
 *
 * Only the two preset desks {@link stophunt.ts} needs are here — a custom session editor is a
 * separate feature this module does not attempt.
 */

/** One session window, in minutes past local midnight, and the zone it is read in. */
interface SessionDef {
    name: string;
    zone: string;
    startMin: number;
    endMin: number;
}

export type SessionPreset = 'futures' | 'forex';

const FUTURES_SESSIONS: readonly SessionDef[] = [
    /* Index futures trade around the clock, so these are the stretches desks mean by "the Asia
     * session" and so on, not exchange opening hours. New York is the regular cash session,
     * because that is when the volume is. */
    { name: 'Asia', zone: 'Asia/Tokyo', startMin: 9 * 60, endMin: 15 * 60 },
    { name: 'London', zone: 'Europe/London', startMin: 8 * 60, endMin: 16 * 60 + 30 },
    { name: 'New York', zone: 'America/New_York', startMin: 9 * 60 + 30, endMin: 16 * 60 },
];

const FOREX_SESSIONS: readonly SessionDef[] = [
    // The classic four, each the local business day of its centre.
    { name: 'Sydney', zone: 'Australia/Sydney', startMin: 8 * 60, endMin: 17 * 60 },
    { name: 'Tokyo', zone: 'Asia/Tokyo', startMin: 9 * 60, endMin: 18 * 60 },
    { name: 'London', zone: 'Europe/London', startMin: 8 * 60, endMin: 17 * 60 },
    { name: 'New York', zone: 'America/New_York', startMin: 8 * 60, endMin: 17 * 60 },
];

/** One session occurrence: the bars it spans and the high/low reached inside it. A session
 *  that runs over midnight (Asia, mostly) is one entry, not two. */
export interface SessionWindow {
    name: string;
    startIndex: number;
    endIndex: number;
    startTime: number;
    endTime: number;
    high: number;
    low: number;
}

/* One formatter per zone, reused across every bar — building one costs far more than using
 * it, and a month of 15m bars asks the same question thousands of times. */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
    let f = formatters.get(zone);
    if (!f) {
        f = new Intl.DateTimeFormat('en-GB', {
            timeZone: zone, hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric', hour12: false,
        });
        formatters.set(zone, f);
    }
    return f;
}

/**
 * Local wall-clock reading of a timestamp in a zone: minutes past local midnight, and a local
 * date stamp. The date is what separates one occurrence of a session from the next; UTC days
 * would split the Tokyo session in half every night.
 *
 * Exported because a session is not the only thing read off a local clock — the Silver Bullet
 * hours are three fixed windows in New York time, and reading them through a second
 * implementation is how two features end up disagreeing about which bars a window covers.
 */
export function localReading(timeMs: number, zone: string): { minutes: number; day: string } {
    const parts = formatterFor(zone).formatToParts(new Date(timeMs));
    const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
    // Some locales render midnight as 24; both mean the same instant.
    const hour = Number(get('hour')) % 24;
    return { minutes: hour * 60 + Number(get('minute')), day: `${get('year')}-${get('month')}-${get('day')}` };
}

/** Whether a local time falls inside a window, wrapping over midnight if it must. */
export function inWindow(minutes: number, start: number, end: number): boolean {
    // A window that ends before it starts runs through midnight — Asia, mostly.
    return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/**
 * Which local day an occurrence belongs to. For a window that wraps midnight, the hours after
 * midnight belong to the day before — otherwise Tokyo's evening and its small hours count as
 * two separate sessions with a gap between them that never existed.
 */
function dayKeyFor(day: string, minutes: number, start: number, end: number): string {
    if (start <= end || minutes >= start) return day;
    const [y, m, d] = day.split('-').map(Number) as [number, number, number];
    // Date.UTC normalises day 0 into the last day of the previous month.
    return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/**
 * Session occurrences over the given bars, one list across every session in the preset,
 * ordered by the bar they opened on.
 */
export function computeSessionWindows(bars: readonly OHLCV[], preset: SessionPreset): SessionWindow[] {
    const definitions = preset === 'forex' ? FOREX_SESSIONS : FUTURES_SESSIONS;
    if (bars.length === 0) return [];

    const out: SessionWindow[] = [];

    for (const def of definitions) {
        let open: SessionWindow | null = null;
        let openDay: string | null = null;

        for (let i = 0; i < bars.length; i += 1) {
            const bar = bars[i]!;
            const { minutes, day } = localReading(bar.time, def.zone);
            const inside = inWindow(minutes, def.startMin, def.endMin);
            const key = dayKeyFor(day, minutes, def.startMin, def.endMin);

            /* Keyed by the local day it STARTED on, so a session that runs past midnight
             * stays a single block instead of breaking at 00:00. */
            if (inside && open && openDay === key) {
                open.endIndex = i;
                open.endTime = bar.time;
                open.high = Math.max(open.high, bar.high);
                open.low = Math.min(open.low, bar.low);
                continue;
            }

            if (open) {
                out.push(open);
                open = null;
                openDay = null;
            }
            if (!inside) continue;

            open = { name: def.name, startIndex: i, endIndex: i, startTime: bar.time, endTime: bar.time, high: bar.high, low: bar.low };
            openDay = key;
        }
        if (open) out.push(open);
    }

    // One list, in the order the sessions opened, whichever desk they belong to.
    out.sort((a, b) => a.startIndex - b.startIndex);
    return out;
}
