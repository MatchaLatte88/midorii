import { Dialog, injectStyles } from '../../../src/ui';

/**
 * The one door between a chart and a real account, and it does not open quietly.
 *
 * Everything else in this app is reversible. A paper account can be reset, a replay can be
 * played again, a drawing can be undone. An order sent to a live venue cannot be any of
 * those, and the only moment at which that is worth saying is BEFORE the first one — after
 * it, the thing to say is what it cost.
 *
 * So this asks once, per session, and it asks differently depending on which account the
 * credentials point at. On a demo account it is a notice: this is fake money, go ahead. On a
 * live one it names the account and states what is about to become possible.
 *
 * It can be switched off in the trading settings. Stored per machine, like the fill sound:
 * it describes the person at this desk, not an account.
 */

const STYLE_ID = 'midorii-capital-arm';
const CSS = `
.midorii-arm-p {
    margin: 0 0 12px;
    font-size: var(--vela-font-size-md);
    line-height: 1.5;
    color: var(--vela-fg);
    max-width: 46ch;
}
.midorii-arm-p:last-of-type { margin-bottom: 16px; }
.midorii-arm-live {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    background: var(--vela-danger);
    color: #fff;
}
.midorii-arm-demo {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    background: var(--vela-surface-elev);
    border: 1px solid var(--vela-border);
    color: var(--vela-fg-muted);
}
/* What the venue says this account is, quoted rather than paraphrased — a recessed card,
   the shape every other stated fact in the app is printed in. */
.midorii-arm-account {
    margin: 0 0 16px;
    padding: 11px 13px;
    border: 1px solid var(--vela-border-faint);
    border-radius: 12px;
    background: var(--vela-surface-sunken);
    font-family: var(--vela-font-mono);
    font-size: 12px;
    color: var(--vela-fg-bright);
}
`;

const STORAGE_KEY = 'midorii-arm-prompt';

/** Whether arming an account asks first on this machine. On until somebody turns it off. */
export function armPromptOn(): boolean {
    try {
        return localStorage.getItem(STORAGE_KEY) !== '0';
    } catch (err) {
        console.error('[midorii] could not read the arm-confirmation setting', err);
        return true;
    }
}

export function setArmPrompt(on: boolean): void {
    try {
        localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
    } catch (err) {
        console.error('[midorii] could not persist the arm-confirmation setting', err);
    }
}

export interface ArmOptions {
    /** Whether the credentials point at the real-money account. */
    live: boolean;
    /** The account the venue reports, for the person to recognise. Null while unknown. */
    accountName?: string | null;
    currency?: string | null;
    balance?: number | null;
    /** The instrument the chart is on — the one this would trade. */
    epic: string;
}

/**
 * Ask before the chart is wired to a real account. Resolves true to go ahead.
 *
 * Called once per time trading is switched on, not once per order: a confirmation on every
 * press is one people learn to dismiss without reading, which is worse than none. Resolves
 * true without asking when the confirmation is switched off.
 */
export async function askToArm(host: HTMLElement, opts: ArmOptions): Promise<boolean> {
    if (!armPromptOn()) return true;
    const doc = host.ownerDocument;
    injectStyles(STYLE_ID, CSS, doc);

    return new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (go: boolean): void => {
            if (settled) return;
            settled = true;
            dialog.hide();
            resolve(go);
        };

        // The kit's footer buttons: plain to step back, and for the one that commits either
        // the accent (demo — nothing is at stake) or the destructive tone (live), so the two
        // doors never look alike at the moment they are pressed.
        const button = (text: string, tone?: 'primary' | 'danger'): HTMLButtonElement => {
            const b = doc.createElement('button');
            b.type = 'button';
            b.className = tone ? `vela-dialog-btn vela-dialog-btn-${tone}` : 'vela-dialog-btn';
            b.textContent = text;
            return b;
        };

        const go = button(opts.live ? 'Trade this account for real' : 'Start trading the demo account', opts.live ? 'danger' : 'primary');
        go.onclick = () => finish(true);

        const dialog = new Dialog({
            title: opts.live ? 'Trade a real account' : 'Trade the demo account',
            eyebrow: 'Capital.com',
            host,
            align: 'center',
            closeOnInteractOutside: false,
            onOpenChange: (open) => { if (!open) finish(false); },
            content: (body) => {
                const badge = doc.createElement('span');
                badge.className = opts.live ? 'midorii-arm-live' : 'midorii-arm-demo';
                badge.textContent = opts.live ? 'Live money' : 'Demo';

                const lead = doc.createElement('p');
                lead.className = 'midorii-arm-p';
                lead.append(badge);
                lead.append(doc.createTextNode(opts.live
                    ? ` From here, an order placed on this chart is a real order on a real account. It cannot be undone, it will be filled at whatever the market is doing, and it can lose money.`
                    : ` This account trades at real market prices with money that is not real. Nothing here can cost you anything.`));

                const account = doc.createElement('p');
                account.className = 'midorii-arm-account';
                const balance = opts.balance != null && opts.currency
                    ? ` · ${opts.balance.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${opts.currency}`
                    : '';
                account.textContent = `${opts.accountName ?? 'Capital.com account'}${balance} · trading ${opts.epic}`;

                const what = doc.createElement('p');
                what.className = 'midorii-arm-p';
                what.textContent = opts.live
                    ? 'Market orders only for now. Everything on this chart — the ticket, a block traded from a '
                    + 'right-click, a stop dragged to a new level — will go to the venue. What is drawn is what '
                    + 'the venue reports back, so a position appears only once it has actually opened.'
                    : 'Everything on this chart — the ticket, a block traded from a right-click, a stop dragged '
                    + 'to a new level — goes to the demo venue, and what is drawn is what it reports back.';

                body.append(lead, account, what);
            },
            footer: (el) => {
                const cancel = button('Cancel');
                cancel.onclick = () => finish(false);
                el.append(cancel, go);
            },
        });

        dialog.show();
    });
}
