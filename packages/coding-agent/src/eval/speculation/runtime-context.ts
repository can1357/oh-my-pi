import { AsyncLocalStorage } from "node:async_hooks";

import type { EvalShadowCellSession } from "./cell-session";

const activeCell = new AsyncLocalStorage<EvalShadowCellSession>();

export function runWithEvalShadowCell<T>(cell: EvalShadowCellSession | undefined, action: () => T): T {
	return cell ? activeCell.run(cell, action) : action();
}

export function getActiveEvalShadowCell(): EvalShadowCellSession | undefined {
	return activeCell.getStore();
}
