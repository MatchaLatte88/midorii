/* Market data out of a CSV file.
 *
 * The other way bars get into the store. A download knows exactly what it is fetching;
 * a file someone exported from a data vendor, a broker or a spreadsheet knows nothing
 * about this app, so everything about it has to be worked out from the text: which
 * character separates the columns, which column is the close, whether 12/26/2022 is
 * December or a day in the twelfth month, and what clock the timestamps are on.
 *
 * Sniff first, then parse
 * -----------------------
 * The two halves are separate on purpose. `sniffCsv` reads the head of the file and
 * reports what it believes — delimiter, columns, date style — so the import dialog can
 * show it and let someone correct it BEFORE a million rows are turned into bars.
 * `parseMarketCsv` then parses under the settings that came back, with nothing left to
 * guess.
 *
 * A wrong guess that goes unnoticed is the failure mode worth designing against: a
 * day-first file read as month-first produces a dataset that looks completely normal
 * and is wrong about every date after the twelfth of a month.
 *
 * Time zones
 * ----------
 * An epoch number is absolute and needs no clock. A written-out timestamp does, and the
 * file rarely says which — the NQ export that prompted this writes `timestamp ET` in
 * the header and nothing else. So the caller names the zone, and a naive timestamp is
 * read as wall-clock time in it, DST included. UTC is the default because that is what
 * the store, the chart and the engine all speak.
 */

/** The delimiters worth trying, most likely first. */
const DELIMITERS = [',', ';', '\t', '|'];

/** How many lines the sniffer reads. Enough to see the shape, not the whole file. */
const SNIFF_LINES = 50;

/** A byte-order mark, which arrives at the front of anything Excel wrote. */
const BOM = '﻿';

/**
 * The zones the import dialog offers. Anything Intl accepts works — this is the short
 * list of clocks market data actually arrives on, not a limit.
 */
export const CSV_TIME_ZONES = [
  { value: 'UTC', label: 'UTC' },
  { value: 'America/New_York', label: 'New York (ET)' },
  { value: 'America/Chicago', label: 'Chicago (CT)' },
  { value: 'Europe/London', label: 'London' },
  { value: 'Europe/Berlin', label: 'Frankfurt / Berlin' },
  { value: 'Asia/Tokyo', label: 'Tokyo' },
  { value: 'Asia/Singapore', label: 'Singapore' },
  { value: 'Australia/Sydney', label: 'Sydney' },
];

/** Column names, normalized, that name each field. Checked in order, first match wins. */
const ALIASES = {
  time: [/^(open )?time$/, /^timestamp/, /^date time$/, /^datetime$/, /^unix/, /^epoch/, /^bar time$/],
  date: [/^date$/, /^day$/],
  clock: [/^time$/, /^time of day$/],
  open: [/^open$/, /^o$/, /^open price$/],
  high: [/^high$/, /^h$/, /^high price$/],
  low: [/^low$/, /^l$/, /^low price$/],
  close: [/^close$/, /^c$/, /^last$/, /^close price$/, /^adj close$/],
  volume: [/^volume$/, /^vol$/, /^v$/, /^base volume$/, /^quantity$/, /^qty$/],
  buyVolume: [/^taker buy base/, /^buy volume$/, /^taker buy volume$/],
};

/** The order a headerless file is read in — the Binance kline layout, which is the one
 *  headerless market CSV anybody actually has. */
const POSITIONAL = ['time', 'open', 'high', 'low', 'close', 'volume'];

/** Lowercase, punctuation to spaces, runs of space collapsed: `Timestamp ET` becomes
 *  `timestamp et`. */
function normalizeHeader(name) {
  return String(name).replace(BOM, '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Splits one CSV line, honouring double quotes. */
export function splitRow(line, delimiter) {
  const out = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

/** Every non-empty line of the head of `text`, without their line endings. */
function headLines(text, limit) {
  const out = [];
  let start = 0;
  while (out.length < limit && start < text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    const line = text.slice(start, end).replace(/\r$/, '');
    if (line.trim()) out.push(line);
    start = end + 1;
  }
  return out;
}

/**
 * The delimiter that splits the head into the most columns, consistently.
 *
 * Consistency decides it, not the count: a file of ISO timestamps has more colons than
 * commas, and picking the character that appears most would split every row differently.
 */
function sniffDelimiter(lines) {
  let best = { delimiter: ',', columns: 1 };
  for (const delimiter of DELIMITERS) {
    const counts = lines.map((l) => splitRow(l, delimiter).length);
    const columns = counts[0] ?? 1;
    if (columns < 2) continue;
    if (!counts.every((c) => c === columns)) continue;
    if (columns > best.columns) best = { delimiter, columns };
  }
  return best.delimiter;
}

/** Whether the first row names its columns rather than holding data. A data row's cells
 *  are all numbers, dates or times; a header has at least one word in it. */
function looksLikeHeader(cells) {
  return cells.some((c) => c.trim() && !/^-?[\d.,:/ +-]+$/.test(c.trim().replace(BOM, '')));
}

/**
 * Maps the header row onto the fields the store needs.
 *
 * Returns indices, `null` where the file has nothing for that field. `date`/`clock` are
 * the split-column case — a `Date` column beside a `Time` one — which is joined back
 * together at parse time.
 */
export function mapColumns(headers) {
  const normalized = headers.map(normalizeHeader);
  const mapping = {
    time: null, date: null, clock: null,
    open: null, high: null, low: null, close: null, volume: null, buyVolume: null,
  };

  // One column cannot be two fields: whatever has been claimed is out of the running.
  const taken = new Set();
  const find = (patterns, skip = taken) => {
    for (let i = 0; i < normalized.length; i++) {
      const name = normalized[i];
      if (!name || skip.has(i)) continue;
      if (patterns.some((p) => p.test(name))) return i;
    }
    return null;
  };
  const claim = (field, patterns) => {
    const at = find(patterns);
    if (at != null) {
      mapping[field] = at;
      taken.add(at);
    }
    return at;
  };

  /* A `Date` column beside a `Time` column is one timestamp written in two halves, and
   * that has to be settled before anything claims the `Time` column on its own: a bare
   * clock read as a whole timestamp parses as nothing at all, and the import would come
   * back empty on a file that is perfectly readable. */
  const dateAt = find(ALIASES.date);
  const clockAt = find(ALIASES.clock, new Set(dateAt == null ? [] : [dateAt]));
  if (dateAt != null && clockAt != null) {
    mapping.date = dateAt;
    mapping.clock = clockAt;
    taken.add(dateAt);
    taken.add(clockAt);
  } else if (claim('time', ALIASES.time) == null) {
    // A lone `date` column IS the timestamp — a daily file has no clock to go with it.
    claim('time', ALIASES.date);
  }

  for (const field of ['open', 'high', 'low', 'close', 'volume', 'buyVolume']) {
    claim(field, ALIASES[field]);
  }
  return mapping;
}

/** The fields a dataset cannot be built without. */
const REQUIRED = ['open', 'high', 'low', 'close'];

/** Which of those the mapping has nothing for, timestamp included. */
export function missingFields(mapping) {
  const missing = REQUIRED.filter((f) => mapping[f] == null);
  if (mapping.time == null && (mapping.date == null || mapping.clock == null)) missing.unshift('time');
  return missing;
}

/* ─── dates ──────────────────────────────────────────────────────────────── */

/** Epoch numbers past this are microseconds; a millisecond stamp would not reach it
 *  until the year 5138. Binance switched its dumps to µs during 2025. */
const MICROSECOND_THRESHOLD = 1e14;
/** Below this an epoch stamp is seconds — 1e11 seconds is the year 5138 as well. */
const SECOND_THRESHOLD = 1e11;

/** A stamp that carries its own clock — `…Z`, `+02:00`, a trailing `UTC` — and must not
 *  be re-read in another one. */
const HAS_OFFSET = /(?:[zZ]|[+-]\d{2}:?\d{2}|\s?(?:UTC|GMT))$/;

const ISO_LIKE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** `12/26/2022 18:01`, `26.12.2022 18:01:30`, `2022/12/26 18:01` — separator and order
 *  both vary, which is what `dateStyle` settles. */
const SLASHED = /^(\d{1,4})[./-](\d{1,2})[./-](\d{2,4})(?:[T ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/;

/** An epoch number, with nothing else in the cell. */
const EPOCH = /^-?\d+(\.\d+)?$/;

/**
 * Which of two ambiguous numbers is the day.
 *
 * `'mdy'` and `'dmy'` are the two readings of `03/04/2024`; `'ymd'` is `2024/03/04`,
 * which is not ambiguous at all. Decided over the sample rather than per row — a file
 * is written in one style, and switching halfway through would make every date after
 * the twelfth of a month wrong in a way nothing downstream can detect.
 */
export function sniffDateStyle(samples) {
  let sawDayFirst = false;
  let sawYearFirst = false;

  for (const raw of samples) {
    const text = String(raw).trim();
    if (ISO_LIKE.test(text) || ISO_DATE.test(text)) return 'ymd';
    const m = SLASHED.exec(text);
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 31 || m[1].length === 4) sawYearFirst = true;
    else if (a > 12) sawDayFirst = true;
    else if (b > 12) return 'mdy'; // the second number cannot be a month
  }
  if (sawYearFirst) return 'ymd';
  if (sawDayFirst) return 'dmy';
  /* Nothing in the sample decides it. Month-first is what exported market data
   * overwhelmingly uses, and the dialog shows the choice rather than hiding it. */
  return 'mdy';
}

/**
 * A cached wall-clock-to-UTC converter for one zone.
 *
 * Building an Intl formatter per row would cost more than the rest of the parse put
 * together, so the offset is resolved once per calendar day. A day where the offset
 * changes is marked and its rows are resolved individually — that is the two days a
 * year DST moves, rather than every row of the file.
 */
function zoneConverter(timeZone) {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });

  /** How far the zone is ahead of UTC at this instant, in ms. */
  const offsetAt = (utcMs) => {
    const at = {};
    for (const p of format.formatToParts(new Date(utcMs))) {
      if (p.type !== 'literal') at[p.type] = Number(p.value);
    }
    // `24` is how some ICU versions spell midnight under hour12:false.
    const asUtc = Date.UTC(at.year, at.month - 1, at.day, at.hour % 24, at.minute, at.second);
    return asUtc - utcMs;
  };

  const days = new Map();
  const dayInfo = (dayStart) => {
    let info = days.get(dayStart);
    if (!info) {
      const start = offsetAt(dayStart);
      const end = offsetAt(dayStart + 86_400_000 - 1);
      info = { offset: start, mixed: start !== end };
      days.set(dayStart, info);
    }
    return info;
  };

  return (wallMs) => {
    const info = dayInfo(Math.floor(wallMs / 86_400_000) * 86_400_000);
    if (!info.mixed) return wallMs - info.offset;
    /* Inside a transition: correct once against the offset actually in force at the
     * first guess. A second pass never moves it again. */
    const guess = wallMs - info.offset;
    const actual = offsetAt(guess);
    return actual === info.offset ? guess : wallMs - actual;
  };
}

/**
 * A timestamp reader for one set of import settings.
 *
 * Returns a function from the raw cell — or a `date` and `clock` pair — to epoch ms, or
 * NaN when the cell is not a timestamp at all.
 */
export function makeTimeReader({ dateStyle = 'mdy', timeZone = 'UTC' } = {}) {
  const toUtc = timeZone === 'UTC' ? (wall) => wall : zoneConverter(timeZone);
  const fromParts = (y, mo, d, h, mi, s, ms = 0) => toUtc(Date.UTC(y, mo - 1, d, h, mi, s, ms));

  return (raw, clock = '') => {
    const left = String(raw).trim();
    const right = String(clock).trim();
    const text = right ? `${left} ${right}` : left;
    if (!text) return NaN;

    // An epoch number is absolute — no date style, no zone.
    if (EPOCH.test(text)) {
      const n = Number(text);
      if (!Number.isFinite(n)) return NaN;
      const magnitude = Math.abs(n);
      if (magnitude >= MICROSECOND_THRESHOLD) return Math.floor(n / 1000);
      if (magnitude >= SECOND_THRESHOLD) return Math.floor(n);
      return Math.floor(n * 1000);
    }

    // Anything carrying its own offset is absolute too, and Date.parse handles it.
    if (HAS_OFFSET.test(text)) {
      const parsed = Date.parse(text);
      return Number.isFinite(parsed) ? parsed : NaN;
    }

    const iso = ISO_LIKE.exec(text);
    if (iso) {
      const fraction = iso[7] ? Math.floor(Number(`0.${iso[7]}`) * 1000) : 0;
      return fromParts(+iso[1], +iso[2], +iso[3], +iso[4], +iso[5], iso[6] ? +iso[6] : 0, fraction);
    }
    const isoDate = ISO_DATE.exec(text);
    if (isoDate) return fromParts(+isoDate[1], +isoDate[2], +isoDate[3], 0, 0, 0);

    const m = SLASHED.exec(text);
    if (!m) return NaN;

    let year;
    let month;
    let day;
    if (dateStyle === 'ymd' || m[1].length === 4) {
      year = +m[1]; month = +m[2]; day = +m[3];
    } else if (dateStyle === 'dmy') {
      day = +m[1]; month = +m[2]; year = +m[3];
    } else {
      month = +m[1]; day = +m[2]; year = +m[3];
    }
    if (year < 100) year += year < 70 ? 2000 : 1900;
    if (month < 1 || month > 12 || day < 1 || day > 31) return NaN;

    return fromParts(year, month, day, m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0);
  };
}

/* ─── numbers ────────────────────────────────────────────────────────────── */

/**
 * A price or a size as written in the file.
 *
 * Thousands separators and the European decimal comma both appear in exported data, and
 * which is which follows from the delimiter: a comma-separated file cannot use commas
 * inside a number, so there a comma separates thousands; a semicolon-separated one is
 * European and its comma is the decimal point.
 */
function makeNumberReader(delimiter) {
  const decimalComma = delimiter === ';';
  return (raw) => {
    const text = String(raw).trim().replace(/^["']|["']$/g, '');
    if (!text) return NaN;
    const lowered = text.toLowerCase();
    if (text === '-' || lowered === 'null' || lowered === 'nan' || lowered === 'na') return NaN;
    const cleaned = decimalComma
      ? text.replace(/\./g, '').replace(',', '.')
      : text.replace(/,/g, '');
    return Number(cleaned);
  };
}

/* ─── the two entry points ───────────────────────────────────────────────── */

/**
 * Reads the head of a file and reports what it believes about it.
 *
 * Everything here is a proposal the caller can override — which is the point. The
 * dialog shows the mapping and the date style it found, so a file that would have been
 * read wrong is corrected before a million rows are parsed under the wrong reading.
 */
export function sniffCsv(text, forced = {}) {
  const lines = headLines(text, SNIFF_LINES);
  if (lines.length === 0) throw new Error('The file is empty.');

  /* A forced delimiter is the dialog overruling the guess, and everything else follows
   * from it — which columns there are at all, and therefore what they mean. */
  const delimiter = forced.delimiter ?? sniffDelimiter(lines);
  const firstRow = splitRow(lines[0], delimiter);
  const hasHeader = forced.hasHeader ?? looksLikeHeader(firstRow);

  const headers = hasHeader
    ? firstRow.map((c) => c.replace(BOM, '').trim())
    : firstRow.map((_, i) => `Column ${i + 1}`);

  const mapping = hasHeader
    ? mapColumns(headers)
    : {
      time: 0, date: null, clock: null,
      open: 1, high: 2, low: 3, close: 4,
      volume: firstRow.length > 5 ? 5 : null,
      // The Binance kline layout, which is what a headerless market CSV almost always is.
      buyVolume: firstRow.length > 9 ? 9 : null,
    };

  const rows = lines.slice(hasHeader ? 1 : 0).map((l) => splitRow(l, delimiter));
  const timeColumn = mapping.time ?? mapping.date;
  const samples = timeColumn == null ? [] : rows.map((r) => (r[timeColumn] ?? '').trim());

  return {
    delimiter,
    hasHeader,
    headers,
    mapping,
    dateStyle: sniffDateStyle(samples),
    /** True when the timestamps are written out rather than epoch numbers, so the
     *  dialog knows whether asking for a time zone is meaningful at all. */
    needsTimeZone: samples.some((s) => s && !EPOCH.test(s)),
    missing: missingFields(mapping),
    sample: rows.slice(0, 5),
    columnCount: firstRow.length,
    /** What the positional fallback assumes, so the dialog can say so. */
    positional: hasHeader ? null : POSITIONAL,
  };
}

/**
 * Turns the whole file into bars.
 *
 * Rows that cannot be read are counted, not dropped silently and not fatal: an export
 * with a trailing total line or a handful of blank prices is normal, an export where
 * every second row fails is a wrong delimiter. The count is what tells those apart, so
 * it comes back with the bars and the caller decides.
 *
 * @param {string} text
 * @param {object} settings  the sniffed values, as corrected by the caller
 * @returns {{bars:Array, skipped:number, rows:number, intervalMs:number|null, firstError:string|null}}
 */
export function parseMarketCsv(text, settings = {}) {
  const {
    delimiter = ',', hasHeader = true, mapping, dateStyle = 'mdy', timeZone = 'UTC',
  } = settings;

  if (!mapping) throw new Error('parseMarketCsv: a column mapping is required — call sniffCsv first');
  const missing = missingFields(mapping);
  if (missing.length > 0) throw new Error(`The file has no column for: ${missing.join(', ')}.`);

  const readTime = makeTimeReader({ dateStyle, timeZone });
  const readNumber = makeNumberReader(delimiter);
  const lines = text.split('\n');

  const bars = [];
  let skipped = 0;
  let rows = 0;
  let firstError = null;

  for (let i = hasHeader ? 1 : 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (!line.trim()) continue;
    rows++;

    const cells = splitRow(i === 0 ? line.replace(BOM, '') : line, delimiter);
    const time = mapping.clock != null && mapping.date != null
      ? readTime(cells[mapping.date] ?? '', cells[mapping.clock] ?? '')
      : readTime(cells[mapping.time] ?? '');

    const open = readNumber(cells[mapping.open] ?? '');
    const high = readNumber(cells[mapping.high] ?? '');
    const low = readNumber(cells[mapping.low] ?? '');
    const close = readNumber(cells[mapping.close] ?? '');
    const volume = mapping.volume == null ? 0 : readNumber(cells[mapping.volume] ?? '');
    const buyVolume = mapping.buyVolume == null ? NaN : readNumber(cells[mapping.buyVolume] ?? '');

    /* A bar whose high is below its own open is not a bar with a typo in it, it is a
     * row that was read as something it is not — the wrong column, or the wrong
     * delimiter. Letting it through would put prices in the store that never traded. */
    const bad = !Number.isFinite(time) || !Number.isFinite(open) || !Number.isFinite(high)
      || !Number.isFinite(low) || !Number.isFinite(close)
      || high < low || high < open || high < close || low > open || low > close;

    if (bad) {
      skipped++;
      firstError ??= `line ${i + 1}: ${line.slice(0, 120)}`;
      continue;
    }

    bars.push({
      time,
      open,
      high,
      low,
      close,
      // A missing size is zero traded, which is a fact. A missing BUY size is not
      // "nobody bought" — that stays NaN, the way every other source spells unknown.
      volume: Number.isFinite(volume) ? volume : 0,
      buyVolume,
    });
  }

  if (bars.length === 0) {
    throw new Error(
      `Nothing in this file parsed as a bar (${rows.toLocaleString()} rows read). `
      + (firstError ? `The first one reads: ${firstError}` : 'Check the delimiter and the columns.'),
    );
  }

  bars.sort((a, b) => a.time - b.time);
  return { bars, skipped, rows, intervalMs: dominantInterval(bars), firstError };
}

/**
 * How long one bar is, as the gap that occurs most often.
 *
 * The most common gap rather than the smallest: a session break, a holiday or a missing
 * minute all make gaps larger than the bar, and one duplicated timestamp would make the
 * smallest gap zero. The mode survives all of that.
 *
 * Null when the bars do not agree on any interval — an irregular series is not
 * something the store can bucket, and the caller has to say so rather than pick one.
 */
export function dominantInterval(bars) {
  if (bars.length < 3) return null;

  const counts = new Map();
  for (let i = 1; i < bars.length; i++) {
    const gap = bars[i].time - bars[i - 1].time;
    if (gap <= 0) continue;
    counts.set(gap, (counts.get(gap) ?? 0) + 1);
  }

  let best = null;
  let bestCount = 0;
  for (const [gap, count] of counts) {
    if (count > bestCount) { best = gap; bestCount = count; }
  }
  // A "most common" gap that only holds for a handful of bars describes nothing.
  return bestCount >= Math.max(2, (bars.length - 1) * 0.1) ? best : null;
}
