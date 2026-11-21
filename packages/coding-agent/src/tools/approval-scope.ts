import { AsyncLocalStorage } from "node:async_hooks";

const approvalScope = new AsyncLocalStorage<object>();

/** Give a wrapped call independent approval bindings, restoring its parent's scope after nested calls. */
export function withToolApprovalScope<T>(run: () => T): T {
	return approvalScope.run({}, run);
}

/** Key feature-owned typed storage by this token; undefined means execution is outside the approval wrapper. */
export function toolApprovalScopeToken(): object | undefined {
	return approvalScope.getStore();
}
