import { AsyncLocalStorage } from "node:async_hooks";

const approvalScope = new AsyncLocalStorage<{ token: object }>();

/** Give a wrapped call independent approval bindings, restoring its parent's scope after nested calls. */
export function withToolApprovalScope<T>(run: () => T): T {
	return approvalScope.run({ token: {} }, run);
}

/** Discard preflight bindings before final approval; do nothing outside a wrapped call. */
export function resetToolApprovalScope(): void {
	const scope = approvalScope.getStore();
	if (scope) scope.token = {};
}

/** Key feature-owned typed storage by this token; undefined means execution is outside the approval wrapper. */
export function toolApprovalScopeToken(): object | undefined {
	return approvalScope.getStore()?.token;
}
