import { injectStyles } from '../../../src/ui';
import { iconAt } from '../../../src/core/icons';
import type { AppThemeName } from './themes';

/**
 * The app's own top bar — above Vela's own chart topbar, not instead of it: the brand mark
 * on the left, the app's top-level views as tabs beside them, then the settings gear, the
 * light/dark switch and (Windows/Linux) the window's own minimize/maximize/close on the
 * right. It IS the window's title bar: the app runs frameless (see app/electron/main.js),
 * so the empty space in this row is the only thing left to drag the window by.
 *
 * Settings is a view like the others and is reached by an icon rather than a labelled tab:
 * it is where you go when something is wrong with how the app behaves, not one of the
 * places the work happens. So it sits with the window's own controls, at the far end of
 * the row, and the tab strip stays a list of the things there are to do.
 */

export type AppTab = 'chart' | 'replay' | 'backtest' | 'analysis' | 'strategies' | 'bot' | 'settings';

const TABS: ReadonlyArray<{ id: AppTab; label: string }> = [
    { id: 'chart', label: 'Chart' },
    { id: 'replay', label: 'Replay' },
    { id: 'backtest', label: 'Backtest' },
    { id: 'analysis', label: 'Analysis' },
    { id: 'strategies', label: 'Strategies' },
    { id: 'bot', label: 'Trading Bot' },
];

/** Placeholder mark until Midorii has a real one — a simple up-candle glyph. */
const LOGO_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">'
    + '<rect x="1" y="1" width="22" height="22" rx="6" fill="#089981" fill-opacity="0.16"/>'
    + '<path d="M9 4.5v3M9 16.5v3M15 3v5M15 14v7" stroke="#089981" stroke-width="1.6" stroke-linecap="round"/>'
    + '<rect x="7" y="7.5" width="4" height="8" rx="1" fill="#089981"/>'
    + '<rect x="13" y="8" width="4" height="6" rx="1" fill="#089981"/>'
    + '</svg>';

/** The same gear the chart's own settings sit behind — one icon for one idea. */
const GEAR_SVG = iconAt('gear', 15);

const SUN_SVG = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">'
    + '<circle cx="8" cy="8" r="3.2"/>'
    + '<path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.5 3.5l1.1 1.1M11.4 11.4l1.1 1.1M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1"/>'
    + '</svg>';
const MOON_SVG = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M13 9.3A5.5 5.5 0 1 1 6.7 3a4.3 4.3 0 0 0 6.3 6.3z"/>'
    + '</svg>';

const WIN_ICONS = {
    minimize: '<svg viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor"><path d="M0.5 5h9"/></svg>',
    maximize: '<svg viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor"><rect x="0.5" y="0.5" width="9" height="9"/></svg>',
    restore: '<svg viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor"><rect x="0.5" y="2.3" width="7.2" height="7.2"/><path d="M2.3 2.3V0.5h7.2v7.2H7.7"/></svg>',
    close: '<svg viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor"><path d="M0.5 0.5l9 9M9.5 0.5l-9 9"/></svg>',
} as const;

const STYLE_ID = 'midorii-app-topbar';
const CSS = `
.midorii-app-topbar {
    display: flex;
    align-items: stretch;
    height: 100%;
    background: var(--vela-bg);
    border-bottom: 1px solid var(--vela-border);
    font-family: var(--vela-font, sans-serif);
    -webkit-user-select: none;
    user-select: none;
}
/* The bar's own empty space is the window's drag handle; every control opts back out
   so dragging never swallows a click (the row also inherits 'drag' from its host,
   #app-topbar, in index.html — this is belt-and-braces for anything nested deeper). */
.midorii-app-topbar { -webkit-app-region: drag; }
.midorii-app-topbar button { -webkit-app-region: no-drag; }

.midorii-topbar-brand { display: inline-flex; align-items: center; gap: 8px; flex: none; padding: 0 14px 0 12px; }
.midorii-topbar-logo { display: inline-flex; flex: none; }
.midorii-topbar-name { font-size: 13.5px; font-weight: 700; letter-spacing: 0.01em; color: var(--vela-fg-bright); white-space: nowrap; }
.midorii-topbar-name-dot { color: var(--vela-highlight); }

.midorii-topbar-tabs { display: inline-flex; align-items: stretch; flex: none; }
.midorii-topbar-tab {
    all: unset;
    display: inline-flex;
    align-items: center;
    height: 100%;
    padding: 0 14px;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--vela-fg-muted);
    cursor: pointer;
    border-bottom: 2px solid transparent;
}
.midorii-topbar-tab:hover { color: var(--vela-fg-bright); background: var(--vela-hover); }
.midorii-topbar-tab[data-active='1'] { color: var(--vela-fg-bright); border-bottom-color: var(--vela-accent-bright); }

.midorii-topbar-spacer { flex: 1 1 auto; }

.midorii-topbar-right { display: inline-flex; align-items: center; flex: none; }
.midorii-topbar-icon {
    all: unset;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 28px;
    border-radius: var(--vela-radius-sm);
    color: var(--vela-fg-muted);
    cursor: pointer;
}
.midorii-topbar-icon:hover { background: var(--vela-hover); color: var(--vela-fg-bright); }
.midorii-topbar-icon[data-active='1'] { background: var(--vela-active); color: var(--vela-fg-bright); }
/* The last thing before the window's own buttons — or before the window edge on macOS,
   which draws none of its own here. Either way it does not sit flush against them. */
.midorii-topbar-theme { margin-right: 8px; }

.midorii-topbar-winctl { display: inline-flex; align-items: stretch; height: 100%; }
.midorii-topbar-winbtn {
    all: unset;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 46px;
    height: 100%;
    color: var(--vela-fg-muted);
    cursor: pointer;
}
.midorii-topbar-winbtn:hover { background: var(--vela-hover); color: var(--vela-fg-bright); }
.midorii-topbar-winbtn:active { background: var(--vela-active); color: var(--vela-fg-bright); }
.midorii-topbar-winbtn[data-close='1']:hover { background: #e81123; color: #ffffff; }
.midorii-topbar-winbtn[data-close='1']:active { background: #f1707a; color: #ffffff; }
`;

export interface AppTopbarOptions {
    active: AppTab;
    theme: AppThemeName;
    onSelectTab: (tab: AppTab) => void;
    onToggleTheme: () => void;
    /** The gear, left of the light/dark switch — the Settings view. */
    onOpenSettings: () => void;
}

export interface AppTopbarHandle {
    readonly el: HTMLElement;
    setActiveTab(tab: AppTab): void;
    setTheme(theme: AppThemeName): void;
}

/** Mount the app's top bar into `host` (`#app-topbar` in index.html). */
export function mountAppTopbar(host: HTMLElement, opts: AppTopbarOptions): AppTopbarHandle {
    const doc = host.ownerDocument;
    injectStyles(STYLE_ID, CSS, doc);

    const el = doc.createElement('div');
    el.className = 'midorii-app-topbar';

    const brand = doc.createElement('span');
    brand.className = 'midorii-topbar-brand';

    const logo = doc.createElement('span');
    logo.className = 'midorii-topbar-logo';
    logo.innerHTML = LOGO_SVG;

    const name = doc.createElement('span');
    name.className = 'midorii-topbar-name';
    name.innerHTML = 'Midorii<span class="midorii-topbar-name-dot">.</span>';

    // The version is the bottombar brand's to state (about/brand.ts), where it comes from
    // package.json at build time. Saying it twice meant saying it twice differently.
    brand.append(logo, name);

    const tabs = doc.createElement('span');
    tabs.className = 'midorii-topbar-tabs';
    const tabButtons = new Map<AppTab, HTMLButtonElement>();
    for (const tab of TABS) {
        const b = doc.createElement('button');
        b.className = 'midorii-topbar-tab';
        b.textContent = tab.label;
        b.addEventListener('click', () => opts.onSelectTab(tab.id));
        tabButtons.set(tab.id, b);
        tabs.appendChild(b);
    }

    const spacer = doc.createElement('span');
    spacer.className = 'midorii-topbar-spacer';

    const right = doc.createElement('span');
    right.className = 'midorii-topbar-right';

    const settingsBtn = doc.createElement('button');
    settingsBtn.className = 'midorii-topbar-icon';
    settingsBtn.innerHTML = GEAR_SVG;
    settingsBtn.title = 'Settings';
    settingsBtn.setAttribute('aria-label', 'Settings');
    settingsBtn.addEventListener('click', () => opts.onOpenSettings());

    const themeBtn = doc.createElement('button');
    themeBtn.className = 'midorii-topbar-icon midorii-topbar-theme';
    themeBtn.addEventListener('click', () => opts.onToggleTheme());
    right.append(settingsBtn, themeBtn);

    // Native traffic lights already cover this on macOS — a second, custom set beside
    // them would just be two ways to do the same thing in two different corners.
    if (window.midori.platform !== 'darwin') right.appendChild(buildWindowControls(doc));

    el.append(brand, tabs, spacer, right);
    host.appendChild(el);

    const setTheme = (theme: AppThemeName): void => {
        themeBtn.innerHTML = theme === 'dark' ? MOON_SVG : SUN_SVG;
        themeBtn.title = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
        themeBtn.setAttribute('aria-label', themeBtn.title);
    };
    const setActiveTab = (tab: AppTab): void => {
        for (const [id, b] of tabButtons) {
            if (id === tab) b.dataset.active = '1';
            else delete b.dataset.active;
        }
        // Settings has no tab in the strip — the gear is its highlight, and no strip tab
        // may stay lit while a different view is on screen.
        if (tab === 'settings') settingsBtn.dataset.active = '1';
        else delete settingsBtn.dataset.active;
    };

    setTheme(opts.theme);
    setActiveTab(opts.active);

    return { el, setActiveTab, setTheme };
}

/** The custom minimize/maximize/close row — what a frameless window on Windows/Linux
 *  otherwise has none of. Kept in its own function only to keep {@link mountAppTopbar}
 *  from disappearing under window-chrome plumbing. */
function buildWindowControls(doc: Document): HTMLElement {
    const wrap = doc.createElement('span');
    wrap.className = 'midorii-topbar-winctl';

    const minimize = doc.createElement('button');
    minimize.className = 'midorii-topbar-winbtn';
    minimize.innerHTML = WIN_ICONS.minimize;
    minimize.setAttribute('aria-label', 'Minimize');
    minimize.addEventListener('click', () => window.midori.window.minimize());

    const maximize = doc.createElement('button');
    maximize.className = 'midorii-topbar-winbtn';
    maximize.innerHTML = WIN_ICONS.maximize;
    maximize.setAttribute('aria-label', 'Maximize');
    maximize.addEventListener('click', () => window.midori.window.toggleMaximize());

    const close = doc.createElement('button');
    close.className = 'midorii-topbar-winbtn';
    close.dataset.close = '1';
    close.innerHTML = WIN_ICONS.close;
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => window.midori.window.close());

    const reflectMaximized = (maximized: boolean): void => {
        maximize.innerHTML = maximized ? WIN_ICONS.restore : WIN_ICONS.maximize;
        maximize.setAttribute('aria-label', maximized ? 'Restore' : 'Maximize');
    };
    void window.midori.window.isMaximized().then(reflectMaximized);
    window.midori.window.onMaximizedChange(reflectMaximized);

    wrap.append(minimize, maximize, close);
    return wrap;
}
