// vela/workspace — the multi-chart shell: a grid of ChartCells with stable identities,
// one shared data feed, an active cell, resizable splitters, and a layout registry
// (`registerLayout`) plugins extend like every other Vela registry.
export { VelaWorkspace } from './VelaWorkspace';
export type { VelaWorkspaceOptions, WorkspaceEventMap, WorkspaceScriptRun } from './VelaWorkspace';
export { ChartCell } from './ChartCell';
export type { CellSeed, CellBoot, CellChartDefaults, PooledCellState, CellNativeInfo } from './ChartCell';
export type { WorkspaceWidgetContext } from './context';
/* The shape of a tab contributed through `VelaWorkspace.setAppSettingsSections` — re-exported
 * here because an API that takes rows is no use to a caller who cannot name one. */
export type { HostSettingsRow, HostSettingsSection } from '../renderers/native/chrome/SettingsDialog';
export {
    registerLayout,
    unregisterLayout,
    layoutDefinition,
    layouts,
    registerBuiltinLayouts,
    gridStyles,
    activeAfterLayout,
    layoutForGrid,
    ensureLayout,
    layoutShape,
    GRID_PICKER_MAX,
} from './layouts';
export type { LayoutDefinition, LayoutShape, TrackSizes } from './layouts';
export { evenTracks, resizeTracks, trackOffsets } from './splitters';
export { syncTargets, rangesWithin } from './sync';
export type { SyncKind, SyncSetting, SyncOptions } from './sync';
export { encodeState, decodeState, sanitizeState, memoryStorageAdapter } from './persist';
export type { WorkspaceState, CellState, ChartState, PanelsState, WorkspaceStorage } from './persist';
