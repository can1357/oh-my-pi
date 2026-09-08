export interface GatewayHookContext {
	requestId: string;
	routeId: string;
	target?: string;
	generation: number;
}

export interface GatewayHooks {
	beforeRequest?(ctx: GatewayHookContext): void | Promise<void>;
	beforeAttempt?(ctx: GatewayHookContext): void | Promise<void>;
	afterAttempt?(ctx: GatewayHookContext & { ok: boolean }): void | Promise<void>;
	afterRequest?(ctx: GatewayHookContext & { ok: boolean }): void | Promise<void>;
}

/**
 * Invoke an optional gateway hook. Missing hooks are a no-op; thrown errors
 * propagate to the caller.
 */
export async function runHook<T>(fn: ((arg: T) => void | Promise<void>) | undefined, arg: T): Promise<void> {
	if (fn === undefined) return;
	await fn(arg);
}
