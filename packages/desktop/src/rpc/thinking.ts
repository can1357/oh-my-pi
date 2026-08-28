import type { RpcSessionState } from "./protocol";

/**
 * The thinking levels a model actually offers, plus `off`.
 *
 * The picker used to hardcode `off, low, medium, high`, which matches no model
 * in the catalog: across the 37 models `omp models --json` reports there are
 * seven distinct effort sets, from `["low","medium","high"]` to
 * `["minimal","low","medium","high","xhigh"]`. So the list was simultaneously
 * hiding levels a model had and offering ones it did not.
 *
 * `off` leads because omp orders it that way too — `CLI_THINKING_LEVELS` is
 * `["off", ...THINKING_EFFORTS, "auto"]`. The rest mirrors `getSupportedEfforts`
 * in packages/catalog/src/model-thinking.ts: a model that cannot reason has no
 * levels at all, which is worth saying rather than drawing dead buttons.
 *
 * Lives apart from the component because it is the only logic in that picker
 * and the package has no DOM test environment.
 */
export function thinkingLevels(model: RpcSessionState["model"]): string[] {
	if (!model?.reasoning) return [];
	const efforts = model.thinking?.efforts ?? [];
	return efforts.length > 0 ? ["off", ...efforts] : [];
}
