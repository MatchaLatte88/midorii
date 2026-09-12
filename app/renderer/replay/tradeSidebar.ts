import { NumberInput, injectStyles, overlayScrollbarCss } from '../../../src/ui';
import { formatMoney, formatPercent, formatPrice, formatR, formatSignedMoney, formatSize, formatWhen } from '../format';
import { equityPath } from '../runs/runStats';
import { bracketLevels, emptyTicket, normalizeQuickSizes, ticketOrder, ticketPlan, ticketRefusal } from './orderTicket';
import type { BracketSettings, TicketAccount, TicketDraft, TicketSizing } from './orderTicket';
import { loadOverlayDisplay, onOverlayDisplayChange, saveOverlayDisplay } from './overlayDisplay';
import { mountPriceLadder, type LadderOrder, type LadderPosition, type PriceLadder } from './priceLadder';
import { mountTimeAndSales, type TapePrint, type TimeAndSales } from './timeAndSales';
import { DEFAULT_RISK } from './replayOrders';
import type { RiskSettings } from './replayOrders';
import type { HistoryRow } from './tradeBook';
import type { OrderSpec } from '../../../shared/engine/broker.js';

/**
 * The ticket: getting in, without drawing anything.
 *
 * The chart's position block is the considered way in — you draw where the trade is wrong,
 * look at it, and trade it when it still looks right. This is the other way in, and it is a
 * different frame of mind: a level is already known, or the market is moving and the block
 * would be three drags too slow. Both go to the same Broker at the same costs, so a run made
 * of the two is still one run.
 *
 * Beside the plot rather than under it, because it is used while looking at the chart and the
 * eye should not have to leave it. The dock below stays what it is — the dock is about what is
 * already ON, this is about what is not yet.
 *
 * It folds away to a rail. Screen is what a chart is for, and a panel that cannot be got rid
 * of is a panel people close by not opening the app.
 */

const STYLE_ID = 'midorii-side';
const CSS = `
.midorii-side {
    flex: 0 0 auto;
    width: 296px;
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--vela-border);
    background: var(--vela-surface);
    color: var(--vela-fg);
    font-size: 12px;
    overflow: hidden;
}
.midorii-side[data-collapsed] { width: 34px; }

.midorii-side-head {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    height: 38px;
    padding: 0 4px 0 12px;
    border-bottom: 1px solid var(--vela-border-faint);
    background: var(--vela-chrome);
}
/* Two tabs where the title was. The ticket and the record are read at different moments and
   296px is not wide enough to hold both, so they take turns rather than share. */
.midorii-side-tabs { flex: 1 1 auto; align-self: stretch; display: flex; gap: 14px; }
.midorii-side-tab {
    all: unset;
    display: grid;
    align-items: center;
    box-shadow: inset 0 -2px 0 transparent;
    font-family: var(--vela-font-mono);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--vela-fg-muted);
    cursor: pointer;
}
.midorii-side-tab:hover { color: var(--vela-fg-bright); }
.midorii-side-tab[data-on] { color: var(--vela-fg-bright); box-shadow: inset 0 -2px 0 var(--vela-accent); }
.midorii-side-fold {
    all: unset;
    flex: 0 0 auto;
    width: 26px;
    height: 26px;
    display: grid;
    place-items: center;
    border-radius: var(--vela-radius-sm);
    color: var(--vela-fg-muted);
    cursor: pointer;
    font-size: 13px;
}
.midorii-side-fold:hover { background: var(--vela-hover); color: var(--vela-fg-bright); }

/* Folded: the head keeps only the button, and the rail below it is the rest of the target. */
.midorii-side[data-collapsed] .midorii-side-head { padding: 0; justify-content: center; }
.midorii-side[data-collapsed] .midorii-side-tabs,
.midorii-side[data-collapsed] .midorii-side-body,
.midorii-side[data-collapsed] .midorii-side-ladder,
.midorii-side[data-collapsed] .midorii-side-hist,
.midorii-side[data-collapsed] .midorii-side-foot { display: none; }

/* The ladder fills what is left of the column, like the record does. */
.midorii-side-ladder { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.midorii-side-ladder[hidden] { display: none; }
.midorii-side-rail { display: none; }
.midorii-side[data-collapsed] .midorii-side-rail {
    all: unset;
    display: block;
    flex: 1 1 auto;
    writing-mode: vertical-rl;
    padding: 14px 0;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--vela-fg-muted);
    cursor: pointer;
}
.midorii-side[data-collapsed] .midorii-side-rail:hover { color: var(--vela-fg-bright); }

.midorii-side-body { flex: 1 1 auto; overflow-y: auto; padding: 10px 12px 6px; }
${overlayScrollbarCss('.midorii-side-body')}

/* ── the two-sided price, and which way this trade goes ──────────────────
   Not a readout: pressing a side is HOW the direction is chosen. The price you are trading
   against and the direction you are trading in are then one control, and the panel says
   which way it is pointed before it says anything else. */
.midorii-side-quote {
    flex: 0 0 auto;
    position: relative;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1px;
    background: var(--vela-border-faint);
    border-bottom: 1px solid var(--vela-border-faint);
}
.midorii-side-quote button {
    all: unset;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 9px 12px 10px;
    background: var(--vela-surface-sunken);
    cursor: pointer;
}
.midorii-side-quote button[data-side='sell'] { align-items: flex-start; }
.midorii-side-quote button[data-side='buy'] { align-items: flex-end; }
.midorii-side-quote small { font-size: 11px; font-weight: 600; color: var(--vela-fg-muted); }
.midorii-side-quote b {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-variant-numeric: tabular-nums;
    font-size: 15px;
    font-weight: 500;
    color: var(--vela-fg);
}
.midorii-side-quote button:hover { background: var(--vela-hover); }
.midorii-side-quote button[data-on][data-side='sell'] { background: color-mix(in srgb, var(--vela-down) 22%, var(--vela-surface-sunken)); }
.midorii-side-quote button[data-on][data-side='buy'] { background: color-mix(in srgb, var(--vela-up) 22%, var(--vela-surface-sunken)); }
.midorii-side-quote button[data-on][data-side='sell'] small,
.midorii-side-quote button[data-on][data-side='sell'] b { color: var(--vela-down); }
.midorii-side-quote button[data-on][data-side='buy'] small,
.midorii-side-quote button[data-on][data-side='buy'] b { color: var(--vela-up); }
/* What crossing costs, drawn in the gap it is the gap of. Absent where the venue quotes one
   price — an account with no two-sided feed has no spread to name, and a zero would claim it
   is free rather than unknown. */
.midorii-side-spread {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    padding: 2px 6px;
    border-radius: var(--vela-radius-sm);
    background: var(--vela-bg);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-variant-numeric: tabular-nums;
    font-size: 10px;
    color: var(--vela-fg-muted);
    pointer-events: none;
}
.midorii-side-spread:empty { display: none; }

/* The order type, as a strip rather than a control: it is chosen first, and it decides what
   the rest of the panel asks for. */
.midorii-side-types { flex: 0 0 auto; display: flex; border-bottom: 1px solid var(--vela-border-faint); }
.midorii-side-types button {
    all: unset;
    flex: 1 1 0;
    padding: 9px 0 8px;
    box-shadow: inset 0 -2px 0 transparent;
    text-align: center;
    font-size: 11px;
    font-weight: 600;
    color: var(--vela-fg-muted);
    cursor: pointer;
}
.midorii-side-types button:hover { color: var(--vela-fg-bright); }
.midorii-side-types button[data-on] { color: var(--vela-fg-bright); box-shadow: inset 0 -2px 0 var(--vela-accent); }

/* A section that can be shut. What is under Extra settings is decided once a session; a panel
   that keeps all of it open spends its height on questions nobody is asking.

   The air above a section belongs to the section, not to its heading: the heading is always
   the first thing inside its own wrapper, so a margin there would be collapsed away by the
   very :first-child rule meant to keep the top of the panel tight. */
.midorii-side-group { margin-top: 16px; }
.midorii-side-group:first-child { margin-top: 0; }
.midorii-side-sect {
    all: unset;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    margin: 0 0 8px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--vela-fg-muted);
    cursor: pointer;
}
.midorii-side-sect:hover { color: var(--vela-fg-bright); }
.midorii-side-sect em {
    font-style: normal;
    font-size: 11px;
    color: var(--vela-fg-muted);
    transition: transform var(--vela-dur-fast) var(--vela-ease);
}
.midorii-side-sect[data-shut] em { transform: rotate(-90deg); }

/* The caption over a field, with room on the right for the switch that turns it off. */
.midorii-side-label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 20px;
    margin: 12px 0 5px;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--vela-fg-muted);
    opacity: 0.85;
}
.midorii-side-label:first-child { margin-top: 0; }
.midorii-side-pick {
    all: unset;
    display: flex;
    align-items: center;
    gap: 4px;
    letter-spacing: 0.06em;
    color: var(--vela-fg-muted);
    cursor: pointer;
}
.midorii-side-pick:hover { color: var(--vela-fg-bright); }
.midorii-side-pick em { font-style: normal; font-size: 9px; }

/* Off is a switch, not an empty box: a target you meant to set and left blank looks exactly
   like a target you did not want, and only one of the two is a mistake. */
.midorii-side-switch {
    all: unset;
    box-sizing: border-box;
    flex: 0 0 auto;
    width: 30px;
    height: 17px;
    padding: 2px;
    border-radius: 999px;
    background: var(--vela-border-strong);
    cursor: pointer;
    transition: background var(--vela-dur-fast) var(--vela-ease);
}
.midorii-side-switch i {
    display: block;
    width: 13px;
    height: 13px;
    border-radius: 50%;
    background: var(--vela-fg-bright);
    transition: transform var(--vela-dur-fast) var(--vela-ease);
}
.midorii-side-switch[data-on] { background: var(--vela-accent); }
.midorii-side-switch[data-on] i { transform: translateX(13px); }

/* One number, one frame — and inside the frame, on the right, what that number comes to in
   the unit you did not type. Two boxes for one quantity is how a stop gets typed into the
   wrong one. */
.midorii-side-field {
    display: flex;
    align-items: center;
    gap: 6px;
    padding-right: 9px;
    border: 1px solid var(--vela-border-soft);
    border-radius: var(--vela-control-radius);
    background: var(--vela-surface-overlay);
    transition: border-color var(--vela-dur-fast) ease;
}
.midorii-side-field:focus-within { border-color: var(--vela-accent-line); }
.midorii-side-field > input {
    flex: 1 1 auto;
    min-width: 0;
    box-sizing: border-box;
    padding: 7px 9px;
    border: none;
    background: transparent;
    color: var(--vela-fg-bright);
    font: inherit;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-variant-numeric: tabular-nums;
    font-size: 13px;
    outline: none;
}
.midorii-side-field > input::placeholder { color: var(--vela-fg-faint); }
/* A NumberInput dropped in here brings its own frame; the field is the frame. */
.midorii-side-field .vela-num[data-size] { flex: 1 1 auto; width: auto; }
.midorii-side-field .vela-num[data-size] input {
    height: 32px;
    border: none;
    border-radius: 0;
    background: transparent;
    color: var(--vela-fg-bright);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-variant-numeric: tabular-nums;
    font-size: 13px;
}
.midorii-side-field .vela-num[data-size] input:focus { box-shadow: none; }
/* The one thing that qualifies what is in the field above, under its right-hand end so it
   reads off the same edge as the number it is about. Gone entirely when there is nothing to
   say, rather than holding a line of air open. */
.midorii-side-hint {
    margin: 4px 0 0;
    font-size: 10px;
    font-variant-numeric: tabular-nums;
    text-align: right;
    color: var(--vela-fg-faint);
}
.midorii-side-hint:empty { display: none; }
.midorii-side-field aside {
    flex: 0 0 auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-variant-numeric: tabular-nums;
    font-size: 10px;
    color: var(--vela-fg-muted);
    white-space: nowrap;
}
.midorii-side-field aside:empty { display: none; }
.midorii-side-field button {
    all: unset;
    flex: 0 0 auto;
    padding: 2px 5px;
    border-radius: var(--vela-radius-sm);
    font-size: 10px;
    font-weight: 600;
    color: var(--vela-fg-muted);
    cursor: pointer;
}
.midorii-side-field button:hover { background: var(--vela-hover); color: var(--vela-fg-bright); }

/* A display set by a class beats the user agent's own rule for [hidden], so a row switched
   off with el.hidden would otherwise stay on screen. This is what actually hides it. */
.midorii-side [hidden] { display: none; }

/* One derived figure: what it is called, what it is, and what qualifies it. */
.midorii-side-stat {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: baseline;
    gap: 1px 8px;
    margin-top: 9px;
    font-size: 11px;
    color: var(--vela-fg-muted);
}
.midorii-side-stat > b {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-variant-numeric: tabular-nums;
    font-size: 12px;
    font-weight: 600;
    color: var(--vela-fg-bright);
    text-align: right;
    white-space: nowrap;
}
.midorii-side-stat > i {
    grid-column: 1 / -1;
    font-style: normal;
    font-size: 10px;
    text-align: right;
    color: var(--vela-fg-faint);
}
.midorii-side-stat > i:empty { display: none; }
.midorii-side-stat > i.warn { color: var(--vela-danger); }

.midorii-side-out {
    margin-top: 12px;
    padding: 10px 12px 11px;
    border: 1px solid var(--vela-border-faint);
    border-radius: 12px;
    background: var(--vela-surface-sunken);
}
.midorii-side-out .midorii-side-stat:first-child { margin-top: 0; }

/* Size in one press, in the sizes this account is actually traded in. Minus and plus walk
   off the ends of that list, for the size that is not on it. */
.midorii-side-chips {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-top: 7px;
}
.midorii-side-chips button {
    all: unset;
    box-sizing: border-box;
    display: grid;
    place-items: center;
    min-width: 26px;
    height: 26px;
    padding: 0 7px;
    border-radius: 999px;
    background: var(--vela-surface-overlay);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-variant-numeric: tabular-nums;
    font-size: 11px;
    font-weight: 600;
    color: var(--vela-fg-muted);
    cursor: pointer;
}
.midorii-side-chips button:hover { background: var(--vela-hover-strong); color: var(--vela-fg-bright); }
.midorii-side-chips button[data-on] { background: var(--vela-selected-bg); color: var(--vela-selected-fg); }
.midorii-side-chips-list { flex: 1 1 auto; display: flex; justify-content: center; gap: 5px; }
.midorii-side-chips button[data-role='edit'] { background: transparent; }
.midorii-side-chips button[data-role='edit']:hover { background: var(--vela-hover); }
.midorii-side-chips-edit { display: flex; align-items: center; gap: 6px; margin-top: 7px; }
.midorii-side-chips-edit .midorii-side-field { flex: 1 1 auto; }


.midorii-side-foot {
    flex: 0 0 auto;
    padding: 10px 12px 12px;
    border-top: 1px solid var(--vela-border-faint);
}
.midorii-side-why {
    margin-bottom: 8px;
    font-size: 11px;
    line-height: 1.35;
    color: var(--vela-danger);
}
.midorii-side-why:empty { display: none; }
/* One button, in the direction the header is pointed. Two buttons would ask the direction
   twice — once at the top where the price is, once at the bottom where the click is — and
   the panel would have no answer of its own to show in between. */
.midorii-side-go {
    all: unset;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    width: 100%;
    padding: 11px 0 10px;
    border-radius: var(--vela-control-radius);
    color: var(--vela-fg-on-fill);
    font-size: 14px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-align: center;
    cursor: pointer;
}
.midorii-side-go small {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-variant-numeric: tabular-nums;
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0;
    opacity: 0.85;
}
.midorii-side-go[data-side='buy'] { background: var(--vela-up); }
.midorii-side-go[data-side='sell'] { background: var(--vela-down); }
.midorii-side-go:hover:not(:disabled) { filter: brightness(1.1); }
.midorii-side-go:disabled { opacity: 0.35; cursor: default; }


.midorii-side-quick { display: flex; gap: 6px; margin-top: 8px; }
.midorii-side-quick button {
    all: unset;
    box-sizing: border-box;
    flex: 1 1 0;
    padding: 5px 0;
    border: 1px solid var(--vela-border-soft);
    border-radius: var(--vela-control-radius);
    text-align: center;
    font-size: 11px;
    font-weight: 600;
    color: var(--vela-fg-muted);
    cursor: pointer;
}
.midorii-side-quick button:hover:not(:disabled) { background: var(--vela-hover); color: var(--vela-fg-bright); }
.midorii-side-quick button:disabled { opacity: 0.35; cursor: default; }
.midorii-side-quick button[data-tone='danger']:hover:not(:disabled) { color: var(--vela-danger); }

/* The record. Nothing on a closed trade can be edited, so the rows wear no controls and are
   free to stack two lines deep — which is what fits beside a chart. */
.midorii-side-hist { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }

/* The curve is head, not list: it answers "how has it been going", which is the question the
   list is scrolled to answer one trade at a time — it must not scroll away while that happens. */
.midorii-side-pnl {
    flex: 0 0 auto;
    padding: 10px 12px 9px;
    border-bottom: 1px solid var(--vela-border-faint);
}
.midorii-side-curve {
    display: block;
    width: 100%;
    margin-top: 8px;
    border-radius: var(--vela-radius-sm);
    background: var(--vela-surface-sunken);
}
.midorii-side-pnl-net {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    margin-top: 6px;
    font-size: 10px;
    color: var(--vela-fg-muted);
}
.midorii-side-pnl-net b {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-variant-numeric: tabular-nums;
    font-size: 12px;
    font-weight: 600;
    color: var(--vela-fg-bright);
}

.midorii-side-hist-list { flex: 1 1 auto; overflow-y: auto; padding: 8px 12px 10px; }
${overlayScrollbarCss('.midorii-side-hist-list')}
.midorii-side-hist-empty { padding: 2px 0; color: var(--vela-fg-muted); }
.midorii-side-more {
    padding: 8px 0 2px;
    font-size: 10px;
    line-height: 1.35;
    color: var(--vela-fg-faint);
}

.midorii-side-trade {
    padding: 7px 0;
    border-bottom: 1px solid var(--vela-border-faint);
    font-variant-numeric: tabular-nums;
}
.midorii-side-trade-top { display: flex; align-items: center; gap: 8px; }
.midorii-side-trade-dir {
    flex: 0 0 auto;
    min-width: 44px;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-align: center;
}
.midorii-side-trade-dir[data-dir='long'] { color: var(--vela-up); background: color-mix(in srgb, var(--vela-up) 14%, transparent); }
.midorii-side-trade-dir[data-dir='short'] { color: var(--vela-down); background: color-mix(in srgb, var(--vela-down) 14%, transparent); }
.midorii-side-trade-when { flex: 1 1 auto; font-size: 10px; color: var(--vela-fg-faint); }
.midorii-side-trade-pnl {
    flex: 0 0 auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    font-weight: 600;
    color: var(--vela-fg-bright);
}
.midorii-side-trade-sub {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 10px;
    margin-top: 3px;
    padding-left: 52px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 10px;
    color: var(--vela-fg-muted);
}
.midorii-side .up { color: var(--vela-up); }
.midorii-side .down { color: var(--vela-down); }
`;

/** Which of the panel's three faces is showing. */
type TabName = 'trade' | 'ladder' | 'tape' | 'history';

/** Nothing to state yet — a dash, never a zero. */
const NONE = '—';

/** What the panel can ask the session to do. Every one already exists on the controller. */
export interface SidebarActions {
    order(spec: OrderSpec): void;
    flatten(): void;
    cancelAll(): void;
}

export interface TradeSidebarOptions {
    /** The account and the last price, read fresh on every repaint. */
    account(): TicketAccount;
    /** What is open and what is waiting — only the counts, for the two quick buttons. */
    counts(): { positions: number; orders: number };
    actions: SidebarActions;
    /** Starting risk settings. The panel owns them from then on — see {@link TradeSidebar.risk}. */
    risk?: RiskSettings;
    /**
     * Closed round trips, newest first, read fresh on every repaint.
     *
     * Absent where the account keeps none — a replay's result is read in the run library
     * afterwards, in one piece — and then the tab is not offered at all rather than offered
     * empty.
     */
    history?(): readonly HistoryRow[];
    /**
     * Where a fresh ticket's stop and target start, read fresh on every repaint.
     *
     * Absent where nobody decided — a replay bootstrapped without settings — and then the
     * ticket simply arrives empty, which is what it has always done.
     */
    brackets?(): BracketSettings;
    /**
     * The instrument's own price increment, or null where it is not known.
     *
     * A bracket measured in ticks has no length without it, and nothing is placed rather
     * than a stop four increments away on an instrument that moves in hundredths.
     */
    tick?(): number | null;
    /** The sizes offered as one press. No row at all where this is not supplied. */
    quickSizes?(): readonly number[];
    /** Where an edited list of those sizes goes. Without it the row cannot be edited. */
    onQuickSizes?(next: number[]): void;
    /**
     * What the ladder needs, where this account can offer one.
     *
     * Absent — a replay, an account with no working book, an instrument with no published
     * increment — and the tab is not offered at all rather than offered empty.
     */
    ladder?: {
        quote(): { bid: number; ask: number } | null;
        positions(): readonly LadderPosition[];
        orders(): readonly LadderOrder[];
        cancelOrder(id: number): void;
    };
    /**
     * Whether this account's feed carries the prints themselves.
     *
     * The tab is offered on that alone — a venue whose feed is candles has no tape to show,
     * and an empty one would be a promise the data cannot keep. Prints arrive through
     * {@link TradeSidebar.pushPrints}.
     */
    tape?: boolean;
    /**
     * Which way of saying how big the ticket should open on — read once, at mount.
     *
     * Read once and not on every repaint, unlike the settings above it: this one is changed
     * BY the panel, and re-reading it would mean the account it is stored against could put
     * the ticket back mid-edit. Absent where nobody remembers it, and then the ticket opens
     * the way {@link emptyTicket} leaves it.
     */
    sizing?(): TicketSizing;
    /** Where a change to it goes, so the next ticket — and the next session — opens on it. */
    onSizing?(next: TicketSizing): void;
}

export interface TradeSidebar {
    /** The panel itself, so whoever mounted it can take it away again. */
    readonly el: HTMLElement;
    /**
     * The risk settings as they stand.
     *
     * The panel is where they are set, and they are not only its own: a block traded from the
     * chart is sized by the same numbers. One session, one answer to "how much may this lose"
     * — two would mean the same 1% meant different money depending on which hand placed the
     * trade.
     */
    risk(): RiskSettings;
    /** Repaint the derived figures from the account as it stands. Never touches the boxes. */
    refresh(): void;
    /**
     * Point the ticket one way and send it — exactly what pressing the button does.
     *
     * For a key binding. A hotkey that built an order of its own would be a second answer to
     * how big, where the stop goes and whether it may be sent at all; this way the key and
     * the button are the same press, refusals included, and there is nothing to keep in step.
     */
    submit(which: 'buy' | 'sell'): void;
    /** Fold a bar into the ladder's session volume. Does nothing without a ladder. */
    markVolume(price: number, volume: number): void;
    /** Hand the tape a burst of prints. Does nothing without one. */
    pushPrints(prints: readonly TapePrint[]): void;
    /**
     * Let go of what the panel listens to outside itself — the chart-card switches it mirrors.
     *
     * Separate from taking the element off, because a panel is unmounted every time trading is
     * switched off and a listener left behind would hold a whole dead panel per switch.
     */
    dispose(): void;
}

/**
 * A row of mutually exclusive buttons. Returns the element; `sync` repaints the selection.
 *
 * `className` is how the same control wears two faces: the order type is a strip of
 * underlined tabs across the top of the panel, the history windows a small inset group. One
 * behaviour, because picking one of a few is one behaviour.
 */
function segmented<T extends string>(
    doc: Document,
    options: readonly { value: T; label: string }[],
    current: () => T,
    onPick: (value: T) => void,
    className = 'midorii-side-seg',
): { el: HTMLElement; sync(): void } {
    const el = doc.createElement('div');
    el.className = className;
    const buttons = options.map((o) => {
        const b = doc.createElement('button');
        b.type = 'button';
        b.textContent = o.label;
        b.onclick = () => onPick(o.value);
        el.append(b);
        return { b, value: o.value };
    });
    const sync = (): void => {
        for (const { b, value } of buttons) {
            if (value === current()) b.dataset.on = '';
            else delete b.dataset.on;
        }
    };
    sync();
    return { el, sync };
}

/**
 * A price box that commits on Enter or on leaving it, and never on every keystroke — a stop
 * typed one digit at a time would otherwise be read as 7, then 77, then 779, and the size
 * beside it would jump about while it was being typed.
 *
 * Empty means "no level", which is how a stop is taken back off.
 */
function priceInput(doc: Document, placeholder: string, commit: (price: number | null) => void): HTMLInputElement {
    const input = doc.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.placeholder = placeholder;

    const apply = (): void => {
        const raw = input.value.trim();
        if (raw === '') {
            commit(null);
            return;
        }
        const price = Number(raw);
        // A price that does not parse is left in the box rather than silently dropped: it is
        // what was typed, and clearing it would hide the typo instead of showing it.
        if (Number.isFinite(price) && price > 0) commit(price);
        else commit(null);
    };

    input.addEventListener('blur', apply);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            input.blur();
        } else if (e.key === 'Escape') {
            input.value = '';
            commit(null);
            input.blur();
        }
    });
    return input;
}

/** The caption over a field. Whatever is passed as `trailing` sits at its right end. */
function caption(doc: Document, text: string, trailing?: HTMLElement): HTMLElement {
    const el = doc.createElement('div');
    el.className = 'midorii-side-label';
    const name = doc.createElement('span');
    name.textContent = text;
    el.append(name);
    if (trailing) el.append(trailing);
    return el;
}

/** The frame one number is typed into. Whatever else is passed rides inside that frame. */
function fieldBox(doc: Document, ...parts: readonly HTMLElement[]): HTMLElement {
    const el = doc.createElement('div');
    el.className = 'midorii-side-field';
    el.append(...parts);
    return el;
}

/** The greyed half of a field: what the typed number comes to in the other unit. */
function fieldAside(doc: Document): HTMLElement {
    return doc.createElement('aside');
}

/** The line under a field, for the one thing that qualifies what is in it. */
function hintLine(doc: Document): HTMLElement {
    const el = doc.createElement('div');
    el.className = 'midorii-side-hint';
    return el;
}

/** On or off, as a switch rather than as an empty box. */
function toggle(doc: Document, onFlip: (on: boolean) => void): {
    el: HTMLButtonElement;
    on(): boolean;
    set(on: boolean): void;
} {
    const el = doc.createElement('button');
    el.className = 'midorii-side-switch';
    el.type = 'button';
    el.append(doc.createElement('i'));

    const on = (): boolean => el.hasAttribute('data-on');
    const set = (next: boolean): void => {
        if (next) el.setAttribute('data-on', '');
        else el.removeAttribute('data-on');
        el.setAttribute('aria-pressed', String(next));
    };
    el.onclick = () => {
        set(!on());
        onFlip(on());
    };
    set(false);
    return { el, on, set };
}

/** A titled section whose contents can be shut away. Append to `body`, mount `el`. */
function section(doc: Document, title: string, open: boolean): { el: HTMLElement; body: HTMLElement } {
    const el = doc.createElement('div');
    el.className = 'midorii-side-group';
    const head = doc.createElement('button');
    head.className = 'midorii-side-sect';
    head.type = 'button';
    const name = doc.createElement('span');
    name.textContent = title;
    const chevron = doc.createElement('em');
    chevron.textContent = '⌄';
    head.append(name, chevron);

    const body = doc.createElement('div');

    const paint = (shown: boolean): void => {
        body.hidden = !shown;
        if (shown) head.removeAttribute('data-shut');
        else head.setAttribute('data-shut', '');
        head.setAttribute('aria-expanded', String(shown));
    };
    head.onclick = () => paint(body.hidden);
    paint(open);

    el.append(head, body);
    return { el, body };
}

/** One derived figure: what it is called, what it is, and what qualifies it. */
function stat(doc: Document, name: string): { el: HTMLElement; value: HTMLElement; sub: HTMLElement } {
    const el = doc.createElement('div');
    el.className = 'midorii-side-stat';
    const label = doc.createElement('span');
    label.textContent = name;
    const value = doc.createElement('b');
    const sub = doc.createElement('i');
    el.append(label, value, sub);
    return { el, value, sub };
}

/** How far back the curve is drawn. */
type PnlSpan = 'all' | 'month' | 'week' | 'day';

/** How far back each window reaches. All time has no floor. */
const SPAN_MS: Record<Exclude<PnlSpan, 'all'>, number> = {
    month: 30 * 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
};

/**
 * The window's realised PnL, trade by trade, oldest first.
 *
 * Realised only: what is still open moves with every tick and belongs on the chart, not in a
 * record of what has already been decided.
 *
 * It starts at zero where the first trade in the window was OPENED rather than at the edge of
 * the window itself — the line then says what has been made since trading last started, and
 * does not spend half its width on hours nothing happened in.
 */
function pnlPoints(history: readonly HistoryRow[], span: PnlSpan): { time: number; balance: number }[] {
    const since = span === 'all' ? 0 : Date.now() - SPAN_MS[span];
    // The history is newest first; a curve is read the other way round.
    const trades = history.filter((t) => t.closedAt >= since).reverse();
    if (trades.length === 0) return [];

    const first = trades[0]!;
    const points = [{ time: Math.min(first.openedAt, first.closedAt), balance: 0 }];
    let sum = 0;
    for (const t of trades) {
        sum += t.netPnl;
        points.push({ time: t.closedAt, balance: sum });
    }
    return points;
}

/**
 * The window as a line, with zero drawn across it so up and down are visible.
 *
 * The geometry is the run library's own — one answer to "where does this point go", so a
 * curve read beside the chart and the same curve read afterwards are the same shape.
 */
function pnlCurveSvg(doc: Document, points: ReadonlyArray<{ time: number; balance: number }>): SVGSVGElement {
    const NS = 'http://www.w3.org/2000/svg';
    const W = 280;
    const H = 56;

    const svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'midorii-side-curve');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.style.height = `${H}px`;

    // Room above and below, so a line that ends at its own high is not drawn on the edge.
    const line = equityPath(points, W, H - 12, 0);
    if (!line.d) return svg;

    const g = doc.createElementNS(NS, 'g');
    g.setAttribute('transform', 'translate(0 6)');

    if (line.baselineY !== null) {
        const base = doc.createElementNS(NS, 'line');
        base.setAttribute('x1', '0');
        base.setAttribute('x2', String(W));
        base.setAttribute('y1', String(line.baselineY));
        base.setAttribute('y2', String(line.baselineY));
        base.setAttribute('stroke', 'var(--vela-border-strong)');
        base.setAttribute('stroke-dasharray', '4 4');
        base.setAttribute('vector-effect', 'non-scaling-stroke');
        g.appendChild(base);
    }

    const path = doc.createElementNS(NS, 'path');
    path.setAttribute('d', line.d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    // The whole window in one colour: it is up or it is not.
    path.setAttribute('stroke', points[points.length - 1]!.balance >= 0 ? 'var(--vela-up)' : 'var(--vela-down)');
    g.appendChild(path);

    svg.appendChild(g);
    return svg;
}

/** How many closed trades are put in the DOM. Older ones are counted, not drawn — a history
 *  of ten thousand rows is a scroll nobody reads and a paint everybody waits for. */
const HISTORY_SHOWN = 200;

/** One closed trade, as a record: two lines, and nothing on it to press. */
function tradeRow(doc: Document, t: HistoryRow): HTMLElement {
    const el = doc.createElement('div');
    el.className = 'midorii-side-trade';

    const top = doc.createElement('div');
    top.className = 'midorii-side-trade-top';
    const dir = doc.createElement('span');
    dir.className = 'midorii-side-trade-dir';
    dir.dataset.dir = t.side;
    dir.textContent = t.side === 'long' ? 'LONG' : 'SHORT';
    const when = doc.createElement('span');
    when.className = 'midorii-side-trade-when';
    when.textContent = formatWhen(t.closedAt);
    const pnl = doc.createElement('b');
    pnl.className = 'midorii-side-trade-pnl';
    if (t.netPnl !== 0) pnl.classList.add(t.netPnl > 0 ? 'up' : 'down');
    pnl.textContent = formatSignedMoney(t.netPnl);
    top.append(dir, when, pnl);

    const sub = doc.createElement('div');
    sub.className = 'midorii-side-trade-sub';
    const part = (text: string, tone?: 'up' | 'down'): HTMLElement => {
        const span = doc.createElement('span');
        if (tone) span.classList.add(tone);
        span.textContent = text;
        return span;
    };
    sub.append(
        part(formatSize(t.size)),
        part(`${formatMoney(t.entryPrice)} → ${formatMoney(t.exitPrice)}`),
        part(formatR(t.r), t.r == null || t.r === 0 ? undefined : t.r > 0 ? 'up' : 'down'),
    );
    // How it ended, where the engine recorded one — a stop and a target read very differently.
    if (t.exitTag) sub.append(part(t.exitTag));
    el.append(top, sub);
    return el;
}

/**
 * Mount the panel. The caller owns the element afterwards — `el.remove()` takes it away, and
 * there is nothing else to release.
 */
export function mountTradeSidebar(host: HTMLElement, opts: TradeSidebarOptions): TradeSidebar {
    const doc = host.ownerDocument;
    injectStyles(STYLE_ID, CSS, doc);

    const draft: TicketDraft = emptyTicket();
    // The way this account was last sized, where whoever mounted the panel kept it.
    draft.sizing = opts.sizing?.() ?? draft.sizing;
    const risk: RiskSettings = { ...(opts.risk ?? DEFAULT_RISK) };

    /**
     * Move to one of the two ways of saying how big, and remember having done so.
     *
     * How a person sizes is a habit rather than a decision they make per ticket, so the
     * change is handed back to be stored — every time it actually changes, and never when
     * it does not, since the store behind it is written through the account's settings.
     */
    function setSizing(next: TicketSizing): void {
        if (draft.sizing === next) return;
        draft.sizing = next;
        opts.onSizing?.(next);
    }

    const el = doc.createElement('div');
    el.className = 'midorii-side';

    // ── head ─────────────────────────────────────────────────────────────
    const head = doc.createElement('div');
    head.className = 'midorii-side-head';

    const tabs = doc.createElement('div');
    tabs.className = 'midorii-side-tabs';
    const tab = (name: TabName, label: string): HTMLButtonElement => {
        const b = doc.createElement('button');
        b.className = 'midorii-side-tab';
        b.type = 'button';
        b.textContent = label;
        b.onclick = () => setTab(name);
        tabs.append(b);
        return b;
    };
    const tradeTab = tab('trade', 'Trade');
    const ladderTab = tab('ladder', 'Ladder');
    const tapeTab = tab('tape', 'Tape');
    const historyTab = tab('history', 'History');
    /* Nothing to show without an account that keeps one, so nothing is offered. A tab that is
     * always there and always empty is a worse answer than no tab. */
    ladderTab.hidden = opts.ladder == null;
    tapeTab.hidden = opts.tape !== true;
    historyTab.hidden = opts.history == null;

    const fold = doc.createElement('button');
    fold.className = 'midorii-side-fold';
    head.append(tabs, fold);

    const rail = doc.createElement('button');
    rail.className = 'midorii-side-rail';

    const setFolded = (folded: boolean): void => {
        if (folded) el.setAttribute('data-collapsed', '');
        else el.removeAttribute('data-collapsed');
        fold.textContent = folded ? '‹' : '›';
        fold.title = folded ? 'Open the ticket' : 'Fold the ticket away';
        rail.title = fold.title;
    };
    fold.onclick = () => setFolded(!el.hasAttribute('data-collapsed'));
    rail.onclick = () => setFolded(false);
    setFolded(false);

    // ── which way, and against what price ───────────────────────────────
    /* The direction lives here rather than in the draft, because the PLAN does not depend on
     * it: the size, the notional, the cash at risk and the reward:risk are the same figures
     * whichever way the trade goes. Only whether it may be sent depends on the side — see
     * ticketPlan and ticketRefusal, which split exactly along that line. */
    let side: 'buy' | 'sell' = 'buy';

    const quote = doc.createElement('div');
    quote.className = 'midorii-side-quote';
    const quoteSide = (which: 'sell' | 'buy'): { btn: HTMLButtonElement; value: HTMLElement } => {
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.dataset.side = which;
        btn.title = which === 'sell' ? 'Point this ticket short' : 'Point this ticket long';
        const label = doc.createElement('small');
        label.textContent = which === 'sell' ? 'Sell' : 'Buy';
        const value = doc.createElement('b');
        value.textContent = NONE;
        btn.append(label, value);
        btn.onclick = () => {
            side = which;
            refresh();
        };
        quote.append(btn);
        return { btn, value };
    };
    // Sell on the left and buy on the right, the way a two-sided price is always printed.
    const sellSide = quoteSide('sell');
    const buySide = quoteSide('buy');
    const spreadTag = doc.createElement('span');
    spreadTag.className = 'midorii-side-spread';
    quote.append(spreadTag);

    // ── what kind of order ──────────────────────────────────────────────
    const types = segmented(
        doc,
        [{ value: 'market', label: 'Market' }, { value: 'limit', label: 'Limit' }, { value: 'stop', label: 'Stop' }] as const,
        () => draft.type,
        (value) => {
            draft.type = value;
            types.sync();
            refresh();
        },
        'midorii-side-types',
    );

    const body = doc.createElement('div');
    body.className = 'midorii-side-body';

    // ── where it goes in ────────────────────────────────────────────────
    const entryBox = priceInput(doc, 'Price', (v) => { draft.entryPrice = v; refresh(); });
    const entryAside = fieldAside(doc);
    const entryCaption = caption(doc, 'Entry price');
    const entryField = fieldBox(doc, entryBox, entryAside);

    // ── how big ─────────────────────────────────────────────────────────
    /* One caption doing the work of a dropdown: which question this field is asking is
     * itself the thing being chosen, and there are only two answers. */
    const sizingPick = doc.createElement('button');
    sizingPick.className = 'midorii-side-pick';
    sizingPick.type = 'button';
    sizingPick.title = 'Size from what the trade may lose, or type a number of units';
    const sizingName = doc.createElement('span');
    const sizingChevron = doc.createElement('em');
    sizingChevron.textContent = '⌄';
    sizingPick.append(sizingName, sizingChevron);
    sizingPick.onclick = () => {
        setSizing(draft.sizing === 'risk' ? 'fixed' : 'risk');
        refresh();
    };
    const sizingCaption = doc.createElement('div');
    sizingCaption.className = 'midorii-side-label';
    sizingCaption.append(sizingPick);

    const riskValue = new NumberInput({
        value: risk.value, min: 0.01, max: 1e6, step: 0.25, size: 'sm', fill: true,
        onChange: (v) => { risk.value = v; refresh(); },
    });
    /* Percent or cash, on the field itself rather than in a second dropdown: it is one
     * question about one number, and the answer belongs next to it. */
    const unitBtn = doc.createElement('button');
    unitBtn.type = 'button';
    unitBtn.title = 'Read the risk as a percentage of equity, or as cash';
    unitBtn.onclick = () => {
        risk.mode = risk.mode === 'percent' ? 'fixed' : 'percent';
        refresh();
    };
    const riskAside = fieldAside(doc);
    const riskField = fieldBox(doc, riskValue.el, unitBtn, riskAside);

    const fixed = new NumberInput({
        value: 0, min: 0, step: 0.01, size: 'sm', fill: true,
        onChange: (v) => { draft.fixedSize = v > 0 ? v : null; refresh(); },
    });
    const fixedAside = fieldAside(doc);
    const fixedField = fieldBox(doc, fixed.el, fixedAside);

    /* ── the sizes this account is actually traded in ─────────────────────
     *
     * A press, not a typed number. The step the ends of the row walk in is the SMALLEST of
     * them rather than a hard 1: on a futures account the sizes are 1, 3, 5 and the step is
     * one contract; on a crypto account they are 0.01, 0.05, 0.1 and a step of one whole coin
     * would be the entire account. The list itself says which kind of instrument this is.
     */
    const chips = doc.createElement('div');
    chips.className = 'midorii-side-chips';
    const chipList = doc.createElement('div');
    chipList.className = 'midorii-side-chips-list';
    const chipStep = (): number => {
        const sizes = presetSizes();
        return sizes.length > 0 ? sizes[0]! : 1;
    };
    const walk = (dir: 1 | -1): void => {
        const step = chipStep();
        const from = draft.fixedSize ?? 0;
        const next = from + dir * step;
        /* Off a step of 0.01 the arithmetic lands on 0.11000000000000001, and a size box is
         * the wrong place to show it. Rounded to the step's own precision. */
        const decimals = Math.min(8, (String(step).split('.')[1] ?? '').length);
        const snapped = Number((next > 0 ? next : step).toFixed(decimals));
        pickSize(snapped);
    };
    const chipDown = doc.createElement('button');
    chipDown.type = 'button';
    chipDown.textContent = '−';
    chipDown.title = 'One size smaller';
    chipDown.onclick = () => walk(-1);
    const chipUp = doc.createElement('button');
    chipUp.type = 'button';
    chipUp.textContent = '+';
    chipUp.title = 'One size larger';
    chipUp.onclick = () => walk(1);
    const chipEdit = doc.createElement('button');
    chipEdit.type = 'button';
    chipEdit.dataset.role = 'edit';
    chipEdit.textContent = '✎';
    chipEdit.title = 'Change which sizes are offered here';
    chips.append(chipDown, chipList, chipUp, chipEdit);

    /* The same row, in the one state where it is a text field: the presets being rewritten.
     * A separate element rather than a swapped-out input, so leaving the edit alone leaves
     * the row it was opened from exactly as it was. */
    const chipEditRow = doc.createElement('div');
    chipEditRow.className = 'midorii-side-chips-edit';
    const chipEditBox = doc.createElement('input');
    chipEditBox.type = 'text';
    chipEditBox.placeholder = '1, 3, 5, 10, 15';
    chipEditBox.title = 'The sizes offered on the row, separated by commas';
    const chipEditDone = doc.createElement('button');
    chipEditDone.type = 'button';
    chipEditDone.textContent = '✓';
    chipEditDone.title = 'Keep these sizes';
    chipEditRow.append(fieldBox(doc, chipEditBox), chipEditDone);
    chipEditRow.hidden = true;

    // ── where it gets out ───────────────────────────────────────────────
    /* Off is a switch, and a switch that is ON with an empty box is a level still being
     * decided — not a level of nothing. `autoTarget`/`autoStop` say the number in the box is
     * still the setting's answer rather than a person's: the moment one is typed over it is
     * theirs, and the panel stops moving it as the market moves. */
    let autoStop = true;
    let autoTarget = true;

    const targetBox = priceInput(doc, NONE, (v) => {
        draft.takeProfit = v;
        autoTarget = false;
        refresh();
    });
    const targetAside = fieldAside(doc);
    const targetField = fieldBox(doc, targetBox, targetAside);
    const targetHint = hintLine(doc);
    const targetSwitch = toggle(doc, (on) => {
        autoTarget = on;
        if (!on) {
            draft.takeProfit = null;
            targetBox.value = '';
        }
        refresh();
        if (on) targetBox.focus();
    });
    const targetCaption = caption(doc, 'Take profit', targetSwitch.el);

    const stopBox = priceInput(doc, NONE, (v) => {
        draft.stopLoss = v;
        autoStop = false;
        refresh();
    });
    const stopAside = fieldAside(doc);
    const stopField = fieldBox(doc, stopBox, stopAside);
    const stopHint = hintLine(doc);
    const stopSwitch = toggle(doc, (on) => {
        autoStop = on;
        if (!on) {
            draft.stopLoss = null;
            stopBox.value = '';
        }
        refresh();
        if (on) stopBox.focus();
    });
    const stopCaption = caption(doc, 'Stop loss', stopSwitch.el);

    const rr = stat(doc, 'Risk / reward');

    const exits = section(doc, 'Exits', true);
    exits.body.append(
        targetCaption, targetField, targetHint,
        stopCaption, stopField, stopHint,
        rr.el,
    );

    // ── the settings that are decided once ──────────────────────────────
    const leverage = new NumberInput({
        value: risk.maxLeverage, min: 1, max: 100, step: 0.5, size: 'sm', fill: true,
        onChange: (v) => { risk.maxLeverage = v; refresh(); },
    });
    const leverageCaption = caption(doc, 'Max leverage');
    const leverageField = fieldBox(doc, leverage.el);
    /* The other panel's switch, kept here as well.
     *
     * The quick panel floats over the plot and this one sits beside it; they are the two ways
     * into the same market and somebody who wants only one of them is looking at both. The
     * chart's own gear has the same switch under Chart cards — one setting, two doors, and
     * whichever is thrown the other follows, because they read and write the same record. */
    const quickSwitch = toggle(doc, (on) => saveOverlayDisplay({ ...loadOverlayDisplay(), showQuick: on }));
    quickSwitch.set(loadOverlayDisplay().showQuick);
    const quickCaption = caption(doc, 'Quick Buy / Sell panel', quickSwitch.el);
    const stopWatchingDisplay = onOverlayDisplayChange((display) => quickSwitch.set(display.showQuick));

    const extra = section(doc, 'Extra settings', false);
    extra.body.append(leverageCaption, leverageField, quickCaption);

    // ── what it comes to ────────────────────────────────────────────────
    const out = doc.createElement('div');
    out.className = 'midorii-side-out';
    const outSize = stat(doc, 'Size');
    const outNotional = stat(doc, 'Notional');
    const outRisk = stat(doc, 'Risk');
    out.append(outSize.el, outNotional.el, outRisk.el);

    body.append(
        entryCaption, entryField,
        sizingCaption, riskField, fixedField, chips, chipEditRow,
        exits.el,
        extra.el,
        out,
    );

    // ── send ────────────────────────────────────────────────────────────
    const foot = doc.createElement('div');
    foot.className = 'midorii-side-foot';
    const why = doc.createElement('div');
    why.className = 'midorii-side-why';

    const goBtn = doc.createElement('button');
    goBtn.className = 'midorii-side-go';
    goBtn.type = 'button';
    const goName = doc.createElement('span');
    const goSub = doc.createElement('small');
    goBtn.append(goName, goSub);
    goBtn.onclick = () => send();

    const quick = doc.createElement('div');
    quick.className = 'midorii-side-quick';
    const cancelAll = doc.createElement('button');
    cancelAll.type = 'button';
    cancelAll.textContent = 'Cancel orders';
    cancelAll.onclick = () => opts.actions.cancelAll();
    const flatten = doc.createElement('button');
    flatten.type = 'button';
    flatten.dataset.tone = 'danger';
    flatten.textContent = 'Flatten';
    /* The panic button, where the hand already is. The dock has one too — that is not a
     * duplicate to tidy away: reaching to the other end of the screen to get out is exactly
     * the moment it must not be a reach. */
    flatten.onclick = () => opts.actions.flatten();
    quick.append(cancelAll, flatten);

    foot.append(why, goBtn, quick);

    // ── history ──────────────────────────────────────────────────────────
    const hist = doc.createElement('div');
    hist.className = 'midorii-side-hist';

    /* Four windows on the same trades. "How has it been going" is a different question over a
     * day than over a year, and a week that undid a month is only visible from both. */
    let span: PnlSpan = 'all';
    const spans = segmented(
        doc,
        [
            { value: 'all', label: 'All time' },
            { value: 'month', label: 'Month' },
            { value: 'week', label: 'Week' },
            { value: 'day', label: 'Day' },
        ] as const,
        () => span,
        (value) => {
            span = value;
            spans.sync();
            renderCurve();
        },
    );

    const pnl = doc.createElement('div');
    pnl.className = 'midorii-side-pnl';
    let curve = pnlCurveSvg(doc, []);
    const net = doc.createElement('div');
    net.className = 'midorii-side-pnl-net';
    const netValue = doc.createElement('b');
    const netCount = doc.createElement('span');
    net.append(netValue, netCount);
    pnl.append(spans.el, curve, net);

    const histList = doc.createElement('div');
    histList.className = 'midorii-side-hist-list';
    hist.append(pnl, histList);

    /* How long the drawn list is, so an unchanged one is left alone: refresh() runs on every
     * tick, and rebuilding two hundred closed trades at that rate is the one thing in this
     * panel that would make the chart stutter. A history only ever grows or is replaced
     * wholesale by a reset, so its length identifies it. */
    let drawnHistory = -1;

    /* The ladder is built once and hidden with its tab, never rebuilt on a switch: it carries
     * this session's volume and the size somebody picked, and both would be thrown away. */
    const ladderHost = doc.createElement('div');
    ladderHost.className = 'midorii-side-ladder';
    let ladder: PriceLadder | null = null;
    if (opts.ladder) {
        const feeds = opts.ladder;
        ladder = mountPriceLadder(ladderHost, {
            price: () => opts.account().price,
            quote: feeds.quote,
            tick: () => opts.tick?.() ?? null,
            positions: feeds.positions,
            orders: feeds.orders,
            sizes: () => opts.quickSizes?.() ?? [1],
            /* The same call the ticket's own button makes, so a press on the ladder meets the
             * session limits and the venue's refusals in the same words. */
            order: (spec) => opts.actions.order(spec),
            cancelOrder: feeds.cancelOrder,
        });
    }

    const tapeHost = doc.createElement('div');
    tapeHost.className = 'midorii-side-ladder';
    const tape: TimeAndSales | null = opts.tape === true
        ? mountTimeAndSales(tapeHost, { priceText: (price) => formatPrice(price) })
        : null;

    el.append(head, rail, quote, types.el, body, ladderHost, tapeHost, hist, foot);
    host.appendChild(el);

    /** Which face is on. The others are hidden rather than unmounted — a ticket half-typed is
     *  not a thing to throw away because the record was glanced at. */
    function setTab(next: TabName): void {
        for (const [b, name] of [[tradeTab, 'trade'], [ladderTab, 'ladder'], [tapeTab, 'tape'], [historyTab, 'history']] as const) {
            if (name === next) b.dataset.on = '';
            else delete b.dataset.on;
        }
        /* The foot goes with the ticket: Buy and Sell under a list of finished trades would
         * send an order from a panel that is not showing what it was sized against. */
        for (const part of [quote, types.el, body, foot]) part.hidden = next !== 'trade';
        ladderHost.hidden = next !== 'ladder';
        tapeHost.hidden = next !== 'tape';
        hist.hidden = next !== 'history';
        rail.textContent = next === 'trade' ? 'Trade'
            : next === 'ladder' ? 'Ladder'
                : next === 'tape' ? 'Tape' : 'History';
        // Re-priced on the way in: it has been hidden and the market has moved under it.
        if (next === 'ladder') ladder?.refresh();
    }

    /** Redraw the curve over the window as it stands, and the money it comes to. */
    function renderCurve(): void {
        const points = pnlPoints(opts.history?.() ?? [], span);
        const next = pnlCurveSvg(doc, points);
        curve.replaceWith(next);
        curve = next;

        netValue.classList.remove('up', 'down');
        if (points.length === 0) {
            netValue.textContent = NONE;
            netCount.textContent = span === 'all' ? 'Nothing closed yet' : 'Nothing closed in this window';
            return;
        }

        // The first point is the zero the line starts from, not a trade.
        const closed = points.length - 1;
        const total = points[closed]!.balance;
        netValue.textContent = formatSignedMoney(total);
        if (total !== 0) netValue.classList.add(total > 0 ? 'up' : 'down');
        netCount.textContent = closed === 1 ? '1 trade' : `${closed} trades`;
    }

    /** Redraw the closed trades, but only when there is a different set of them. */
    function renderHistory(): void {
        const history = opts.history?.() ?? [];
        if (history.length === drawnHistory) return;
        drawnHistory = history.length;

        renderCurve();

        histList.replaceChildren();
        if (history.length === 0) {
            const empty = doc.createElement('div');
            empty.className = 'midorii-side-hist-empty';
            empty.textContent = 'Nothing closed yet.';
            histList.append(empty);
            return;
        }

        histList.append(...history.slice(0, HISTORY_SHOWN).map((t) => tradeRow(doc, t)));
        if (history.length > HISTORY_SHOWN) {
            const more = doc.createElement('div');
            more.className = 'midorii-side-more';
            more.textContent = `${history.length - HISTORY_SHOWN} older trades are in the account but not drawn here.`;
            histList.append(more);
        }
    }

    /** Distance from the reference, as a signed percentage — or nothing to say. */
    function away(level: number | null, reference: number | null): string {
        if (level == null || reference == null || reference <= 0) return '';
        return formatPercent((level - reference) / reference, 2, true);
    }

    /** The sizes on the quick row, as the settings have them. */
    function presetSizes(): readonly number[] {
        return opts.quickSizes?.() ?? [];
    }

    /** Take a size and mean it: a quick size is a typed size, so the ticket switches to one. */
    function pickSize(size: number): void {
        setSizing('fixed');
        draft.fixedSize = size > 0 ? size : null;
        fixed.setValue(size);
        refresh();
    }

    /* What the row currently has drawn on it. refresh() runs on every tick and the sizes
     * change about once a month; the buttons are rebuilt only when the list itself differs. */
    let drawnSizes: string | null = null;

    /** Redraw the row of sizes, and mark whichever one the ticket is holding. */
    function renderChips(): void {
        // An account whose sizes nobody supplied has no row — not an empty one.
        if (opts.quickSizes == null) {
            chips.hidden = true;
            chipEditRow.hidden = true;
            return;
        }
        const sizes = presetSizes();
        const key = sizes.join(',');
        if (key !== drawnSizes) {
            drawnSizes = key;
            chipList.replaceChildren(...sizes.map((n) => {
                const b = doc.createElement('button');
                b.type = 'button';
                b.dataset.size = String(n);
                b.textContent = formatSize(n);
                b.title = `Trade ${formatSize(n)}`;
                b.onclick = () => pickSize(n);
                return b;
            }));
        }
        const held = draft.sizing === 'fixed' ? draft.fixedSize : null;
        for (const b of chipList.children) {
            const on = held != null && b instanceof HTMLElement && Number(b.dataset.size) === held;
            if (on) (b as HTMLElement).dataset.on = '';
            else if (b instanceof HTMLElement) delete b.dataset.on;
        }
        // Nothing to step down from at the smallest step the row knows.
        chipDown.disabled = (draft.fixedSize ?? 0) <= chipStep();
    }

    /** Keep whatever is in the edit box, and put the row back. */
    function commitSizes(): void {
        const next = normalizeQuickSizes(chipEditBox.value.split(','));
        // An unreadable list leaves the sizes as they were rather than emptying the row.
        if (next != null) opts.onQuickSizes?.(next);
        chipEditRow.hidden = true;
        chips.hidden = false;
        refresh();
    }

    chipEdit.onclick = () => {
        chipEditBox.value = presetSizes().map((n) => formatSize(n)).join(', ');
        chips.hidden = true;
        chipEditRow.hidden = false;
        chipEditBox.focus();
        chipEditBox.select();
    };
    chipEditDone.onclick = () => commitSizes();
    chipEditBox.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            commitSizes();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            chipEditRow.hidden = true;
            chips.hidden = false;
        }
    });

    /**
     * Put the automatic levels where the settings say they go.
     *
     * They FOLLOW: an untouched ticket keeps its stop the same distance from the market as
     * the market moves, which is the only reading of "automatic" that is any use while
     * waiting for an entry. Typing over one ends that for the box that was typed in — see
     * `autoStop`/`autoTarget` — and so does switching it off.
     */
    function applyAutoBrackets(account: TicketAccount): void {
        const brackets = opts.brackets?.();
        if (brackets == null || !brackets.on) return;
        if (!autoStop && !autoTarget) return;

        // Measured from where the trade would actually go in — the plan's own reference.
        const reference = draft.type === 'market'
            ? (account.price > 0 ? account.price : null)
            : (draft.entryPrice != null && draft.entryPrice > 0 ? draft.entryPrice : null);
        /* No reference, no levels. A resting order whose price has not been typed yet would
         * otherwise keep the pair worked out from the last market it had one against — a stop
         * measured from a price this trade is not going in at, shown as though it were. */
        const levels = reference == null
            ? { stopLoss: null, takeProfit: null }
            : bracketLevels(reference, side, brackets, opts.tick?.() ?? null);

        /* Never into a box somebody is typing in. refresh() runs on every tick, and a level
         * rewritten under the cursor is a level nobody typed and nobody can retype. */
        if (autoStop && stopSwitch.on() && doc.activeElement !== stopBox) {
            draft.stopLoss = levels.stopLoss;
            stopBox.value = levels.stopLoss == null ? '' : formatPrice(levels.stopLoss);
        }
        if (autoTarget && targetSwitch.on() && doc.activeElement !== targetBox) {
            draft.takeProfit = levels.takeProfit;
            targetBox.value = levels.takeProfit == null ? '' : formatPrice(levels.takeProfit);
        }
    }

    /** Empty the ticket back to what a fresh one looks like under the current settings. */
    function resetTicket(): void {
        draft.entryPrice = null;
        draft.stopLoss = null;
        draft.takeProfit = null;
        entryBox.value = '';
        stopBox.value = '';
        targetBox.value = '';
        /* Both switches go back to whatever the settings say a fresh ticket arrives with, and
         * both levels are the settings' answer again rather than anybody's. */
        const bracketed = opts.brackets?.().on ?? false;
        autoStop = true;
        autoTarget = true;
        stopSwitch.set(bracketed);
        targetSwitch.set(bracketed);
    }

    function refresh(): void {
        const account = opts.account();
        // The automatic levels first: they write into the draft, and everything below reads it.
        applyAutoBrackets(account);
        const plan = ticketPlan(draft, account, risk);
        const refusal = ticketRefusal(draft, side, account, plan);

        /* The two sides of the market, where the venue quotes two. Where it quotes one, both
         * halves show it and the spread tag stays empty: a spread of zero would say crossing
         * is free, and what is true is that this feed does not say what it costs. */
        const twoSided = account.bid != null && account.ask != null && account.ask > account.bid;
        const last = account.price > 0 ? account.price : null;
        const bid = twoSided ? account.bid! : last;
        const ask = twoSided ? account.ask! : last;
        sellSide.value.textContent = bid == null ? NONE : formatMoney(bid);
        buySide.value.textContent = ask == null ? NONE : formatMoney(ask);
        spreadTag.textContent = twoSided ? formatMoney(account.ask! - account.bid!) : '';
        for (const [g, which] of [[sellSide, 'sell'], [buySide, 'buy']] as const) {
            if (which === side) g.btn.dataset.on = '';
            else delete g.btn.dataset.on;
        }

        // A market order has no price of its own to wait at.
        const resting = draft.type !== 'market';
        entryCaption.hidden = !resting;
        entryField.hidden = !resting;
        entryAside.textContent = resting ? away(draft.entryPrice, account.price > 0 ? account.price : null) : '';

        const byRisk = draft.sizing === 'risk';
        sizingName.textContent = byRisk ? 'Risk' : 'Units';
        riskField.hidden = !byRisk;
        fixedField.hidden = byRisk;

        unitBtn.textContent = risk.mode === 'percent' ? '%' : 'cash';
        // The half that was not typed: 1% of this account is that much money, and vice versa.
        riskAside.textContent = risk.mode === 'percent'
            ? `≈ ${formatMoney((account.equity * risk.value) / 100)}`
            : account.equity > 0 ? `≈ ${formatPercent(risk.value / account.equity)} of equity` : '';
        /* Against a typed size the useful second figure is the one nobody worked out: what
         * this many units at this price actually costs if the stop is hit. */
        fixedAside.textContent = plan.risk == null ? '' : `${formatMoney(plan.risk.cash)} at the stop`;
        renderChips();

        stopHint.textContent = away(draft.stopLoss, plan.reference);
        targetHint.textContent = away(draft.takeProfit, plan.reference);
        /* What the automatic levels are: the distance the settings asked for, said in the
         * unit they were asked in, so a stop of "40 ticks" is legible as one. */
        const brackets = opts.brackets?.();
        const unit = brackets?.unit === 'cash' ? '' : ' ticks';
        stopAside.textContent = autoStop && brackets?.on && draft.stopLoss != null ? `auto ${brackets.stop}${unit}` : '';
        targetAside.textContent = autoTarget && brackets?.on && draft.takeProfit != null ? `auto ${brackets.target}${unit}` : '';

        rr.value.textContent = plan.rr == null ? NONE : `${plan.rr.toFixed(2)} R`;

        leverageCaption.hidden = !byRisk;
        leverageField.hidden = !byRisk;

        outSize.value.textContent = plan.size == null ? NONE : formatSize(plan.size);
        /* Which ceiling bit says something different about the trade. A leverage cap is a rule
         * the account's owner wrote; running out of margin is the venue saying no, and the
         * remedy for the two is not the same. */
        outSize.sub.textContent = plan.capped
            ? (plan.margin ? 'all the margin the account has left' : 'at the leverage cap')
            : '';
        outSize.sub.classList.toggle('warn', plan.capped);

        outNotional.value.textContent = plan.notional == null ? NONE : formatMoney(plan.notional);
        /* On a margined account the useful second line is not what the position is worth
         * against equity — it is what opening it actually takes out of the money left. */
        outNotional.sub.textContent = plan.margin != null
            ? `${formatMoney(plan.margin.required)} margin of ${formatMoney(plan.margin.available)}`
            : plan.notional != null && account.equity > 0
                ? `${(plan.notional / account.equity).toFixed(2)}× equity`
                : '';
        outNotional.sub.classList.toggle('warn', plan.margin != null && plan.margin.required > plan.margin.available);

        outRisk.value.textContent = plan.risk == null ? NONE : formatMoney(plan.risk.cash);
        outRisk.sub.textContent = plan.risk?.share == null ? '' : `${formatPercent(plan.risk.share)} of equity`;

        /* The button is the direction, so it says the direction, and underneath it says
         * exactly what pressing it sends. */
        goBtn.dataset.side = side;
        goBtn.disabled = refusal != null;
        goBtn.title = refusal ?? '';
        goName.textContent = side === 'buy' ? 'Buy' : 'Sell';
        goSub.textContent = plan.size == null || plan.reference == null
            ? draft.type.toUpperCase()
            : `${formatSize(plan.size)} @ ${formatMoney(plan.reference)} ${draft.type.toUpperCase()}`;
        // The reason in full under the button, where the button cannot fit it.
        why.textContent = refusal ?? '';

        const counts = opts.counts();
        cancelAll.disabled = counts.orders === 0;
        flatten.disabled = counts.positions === 0;

        if (!ladderHost.hidden) ladder?.refresh();
        renderHistory();
    }

    function send(): void {
        const account = opts.account();
        const plan = ticketPlan(draft, account, risk);
        if (ticketRefusal(draft, side, account, plan) != null || plan.size == null) return;

        opts.actions.order(ticketOrder(draft, side, plan.size));

        /* Emptied afterwards. A ticket still holding the last trade's stop is the one mistake
         * here that costs money: the next click would send a level from a setup that is over.
         * The order type, the direction and the risk settings stay — those are how this
         * session is being traded, not what this trade was. */
        resetTicket();
        refresh();
    }

    resetTicket();

    setTab('trade');
    refresh();

    return {
        el,
        risk: () => ({ ...risk }),
        refresh,
        markVolume(price: number, volume: number): void {
            ladder?.mark(price, volume);
        },
        pushPrints(prints: readonly TapePrint[]): void {
            /* Kept up even while the tab is not showing: a tape somebody switches to should be
             * the last two hundred prints, not the ones since they looked. */
            tape?.push(prints);
        },
        submit(which: 'buy' | 'sell'): void {
            /* Pointed first, then sent — the same two steps a press on the quote and then on
             * the button are, in the same order, so the refusal a key runs into is the one
             * that would have been on screen. */
            side = which;
            refresh();
            send();
        },
        dispose(): void {
            stopWatchingDisplay();
            ladder?.destroy();
            tape?.destroy();
        },
    };
}
