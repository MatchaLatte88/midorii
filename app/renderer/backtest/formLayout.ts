import { RISK_PARAM_KEYS } from '../strategies';
import type { StrategyParam } from '../strategies';

export interface BacktestParamGroups {
    /** Risk and sizing are the small, common set a run is most likely to override. */
    common: StrategyParam[];
    /** Signal-definition controls are inherited from Strategies and stay behind Advanced. */
    advanced: StrategyParam[];
}

/**
 * Split a strategy schema by how often the Backtest tab needs somebody to touch it.
 *
 * The keys come from the strategy registry's shared risk schema rather than a second list
 * maintained by the view. A new strategy therefore gets the same calm first scan without
 * opting into UI knowledge, and its own signal controls remain available under Advanced.
 */
export function groupBacktestParams(params: readonly StrategyParam[]): BacktestParamGroups {
    return {
        common: params.filter((param) => RISK_PARAM_KEYS.includes(param.key)),
        advanced: params.filter((param) => !RISK_PARAM_KEYS.includes(param.key)),
    };
}
