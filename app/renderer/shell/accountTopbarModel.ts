import { formatMoney, formatSignedMoney } from '../format';

export type AccountTopbarContext = 'live' | 'backtest' | 'bot';

export interface AccountTopbarSnapshot {
    context: AccountTopbarContext;
    /** Omitted in the Backtest view, which has figures but no account selector. */
    account?: {
        label: string;
        detail?: string;
        accent?: string;
        live?: boolean;
    };
    balance: number | null;
    limit: {
        label: 'MLL' | 'DLL' | 'MDD';
        value: number | null;
        title: string;
    };
    realised: number | null;
    unrealised: number | null;
    currency?: string | null;
    /** Whether the selector opens a list. Backtest deliberately never sets this. */
    selectable?: boolean;
    /** The lock is an action, not a status decoration. */
    canLock?: boolean;
    lockTitle?: string;
}

export interface AccountTopbarMetric {
    id: 'balance' | 'limit' | 'realised' | 'unrealised';
    label: string;
    value: string;
    title: string;
    tone: 'up' | 'down' | null;
}

function money(value: number | null, signed: boolean): string {
    if (value == null || !Number.isFinite(value)) return '—';
    return signed ? formatSignedMoney(value) : formatMoney(value);
}

function tone(value: number | null): 'up' | 'down' | null {
    if (value == null || !Number.isFinite(value) || value === 0) return null;
    return value > 0 ? 'up' : 'down';
}

/** Turn account facts into the four compact readouts the title bar paints. */
export function accountTopbarMetrics(snapshot: AccountTopbarSnapshot): readonly AccountTopbarMetric[] {
    const currency = snapshot.currency ? ` ${snapshot.currency}` : '';
    return [
        {
            id: 'balance',
            label: `BAL${currency}`,
            value: money(snapshot.balance, false),
            title: 'Settled account balance, before the result of any open position.',
            tone: null,
        },
        {
            id: 'limit',
            label: snapshot.limit.label,
            value: snapshot.limit.label === 'MDD' && snapshot.limit.value != null
                ? money(-Math.abs(snapshot.limit.value), false)
                : money(snapshot.limit.value, false),
            title: snapshot.limit.title,
            tone: snapshot.limit.label === 'MDD'
                ? (snapshot.limit.value != null && snapshot.limit.value > 0 ? 'down' : null)
                : (snapshot.limit.value != null && snapshot.limit.value <= 0 ? 'down' : null),
        },
        {
            id: 'realised',
            label: 'RP&L',
            value: money(snapshot.realised, true),
            title: 'Profit and loss already realised by closed positions.',
            tone: tone(snapshot.realised),
        },
        {
            id: 'unrealised',
            label: 'UP&L',
            value: money(snapshot.unrealised, true),
            title: 'Current profit and loss on open positions.',
            tone: tone(snapshot.unrealised),
        },
    ];
}
