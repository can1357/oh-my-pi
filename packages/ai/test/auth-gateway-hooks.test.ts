import { describe, expect, it } from "bun:test";
import { type GatewayHookContext, type GatewayHooks, runHook } from "@oh-my-pi/pi-ai/auth-gateway/hooks";

const ctx: GatewayHookContext = {
	requestId: "req_1",
	routeId: "virtual/primary",
	target: "primary",
	generation: 1,
};

describe("runHook", () => {
	it("is a no-op when the hook is undefined", async () => {
		await expect(runHook(undefined, ctx)).resolves.toBeUndefined();
	});

	it("invokes a defined hook with the argument", async () => {
		const seen: GatewayHookContext[] = [];
		const hooks: GatewayHooks = {
			beforeRequest: arg => {
				seen.push(arg);
			},
		};
		await runHook(hooks.beforeRequest, ctx);
		expect(seen).toEqual([ctx]);
	});

	it("awaits an async hook before resolving", async () => {
		let ran = false;
		await runHook(async () => {
			await Promise.resolve();
			ran = true;
		}, ctx);
		expect(ran).toBe(true);
	});

	it("rejects when the hook throws (negative)", async () => {
		const boom = new Error("hook failed");
		await expect(
			runHook(() => {
				throw boom;
			}, ctx),
		).rejects.toBe(boom);
	});

	it("rejects when an async hook rejects (negative)", async () => {
		const boom = new Error("async hook failed");
		await expect(
			runHook(async () => {
				throw boom;
			}, ctx),
		).rejects.toBe(boom);
	});

	it("passes ok through afterAttempt", async () => {
		const seen: boolean[] = [];
		const hooks: GatewayHooks = {
			afterAttempt: arg => {
				seen.push(arg.ok);
			},
		};
		await runHook(hooks.afterAttempt, { ...ctx, ok: false });
		expect(seen).toEqual([false]);
	});
});
