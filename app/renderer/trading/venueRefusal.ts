/**
 * A venue's refusal, in words the person who pressed the button can act on.
 *
 * Capital.com answers a refused order with a code — `INSUFFICIENT_FUNDS`, `MARKET_CLOSED`,
 * `error.invalid.stoploss.maxvalue` — and nothing else. Put on screen as it arrives, that is
 * a string a trader has to go and look up while a position they meant to open does not exist.
 *
 * Not a dictionary
 * ----------------
 * The full set of these codes is not published anywhere, so this does NOT try to translate
 * them: a lookup table built by guessing would eventually explain a refusal wrongly, and a
 * confident wrong reason about money is worse than a terse right one. Instead the code is made
 * READABLE — that alone carries most of them, because the venue names them after what went
 * wrong — and a sentence of help is added only for the handful whose name already says
 * exactly that. Anything unrecognised comes through in the venue's own words, tidied but never
 * reinterpreted.
 */

/**
 * The extra sentence, for codes whose meaning follows from the name itself.
 *
 * Every entry here has to be defensible from the code alone. Nothing goes in because it seemed
 * likely — a code nobody can explain is better shown bare.
 */
const HELP: Record<string, string> = {
    INSUFFICIENT_FUNDS: 'The account does not have enough available margin for a position this size.',
    MARKET_CLOSED: 'The market is not open for trading right now.',
    MARKET_OFFLINE: 'The market is not open for trading right now.',
    INSUFFICIENT_LIQUIDITY: 'There was not enough of the instrument available to fill the order.',
    POSITION_NOT_FOUND: 'That position is no longer open — it may have closed while this was in flight.',
    MIN_SIZE: 'The size is below the smallest deal this instrument accepts.',
    MAX_SIZE: 'The size is above the largest deal this instrument accepts.',
};

/**
 * `INSUFFICIENT_FUNDS` → `Insufficient funds`; `error.invalid.stoploss` → `Invalid stoploss`.
 *
 * Both shapes the venue uses, reduced to one sentence-cased phrase. A leading `error.` is
 * dropped: every one of these is an error, and saying so twice takes room a reason needs.
 */
export function readableCode(code: string): string {
    const words = code
        .replace(/^error\./i, '')
        .split(/[._\s-]+/)
        .filter(Boolean);
    if (words.length === 0) return code;
    const phrase = words.join(' ').toLowerCase();
    return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

/**
 * What to put in front of the person, for a refusal `reason`.
 *
 * `action` names what they were trying to do, so a rejection that arrives seconds later is
 * still attached to the press that caused it.
 */
export function refusalMessage(reason: string | null | undefined, action = 'The order'): string {
    if (!reason) return `${action} was refused, and the venue gave no reason.`;
    const help = HELP[reason.toUpperCase()];
    const readable = readableCode(reason);
    return help ? `${action} was refused: ${readable}. ${help}` : `${action} was refused: ${readable}.`;
}
