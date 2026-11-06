import { AsyncLocalStorage } from "node:async_hooks";

const approvalScope = new AsyncLocalStorage<Map<object, unknown>>();

export function withToolApprovalScope<T>(run: () => T): T {
	return approvalScope.run(new Map(), run);
}

export function resetToolApprovalScope(): void {
	approvalScope.getStore()?.clear();
}

export function toolApprovalState<T>(owner: object, create: () => T): T | undefined {
	const scope = approvalScope.getStore();
	if (!scope) return undefined;
	if (!scope.has(owner)) scope.set(owner, create());
	return scope.get(owner) as T;
}
