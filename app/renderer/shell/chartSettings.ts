import type { HostSettingsSection, VelaWorkspace } from '../../../src/workspace';

/**
 * More than one part of the app has something to say in a chart's own settings dialog.
 *
 * The workspace takes the whole list at once — `setAppSettingsSections` REPLACES what is
 * there — which is right for a library with one host and wrong for a host with several
 * things to contribute. Trading arrives when an account is opened and leaves when it is put
 * down; the chart's cards are there whatever is being traded. Left to talk to the workspace
 * directly, whichever of them ran last would silently be the only one in the dialog.
 *
 * So each contributor names itself and this keeps the list, in the order they first appeared —
 * a tab that comes and goes with an account does not reshuffle the ones beside it. Per
 * workspace, weakly held: a replay builds its own, and closing it should not leave its tabs
 * behind in a map somewhere.
 */

const contributions = new WeakMap<VelaWorkspace, Map<string, HostSettingsSection>>();

/**
 * Put a section in this chart's settings dialog under `id`, replacing whatever that id had —
 * or, with `null`, take it back out.
 *
 * The id is the contributor's own name, not the tab's title: it is what lets the same module
 * update its tab without knowing who else is in the dialog.
 */
export function contributeChartSettings(
    workspace: VelaWorkspace,
    id: string,
    section: HostSettingsSection | null,
): void {
    let sections = contributions.get(workspace);
    if (!sections) {
        sections = new Map();
        contributions.set(workspace, sections);
    }
    if (section) sections.set(id, section);
    else sections.delete(id);
    workspace.setAppSettingsSections([...sections.values()]);
}
