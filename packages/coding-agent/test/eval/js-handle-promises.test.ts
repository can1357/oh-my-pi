import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { JsRuntime, type RuntimeHooks } from "@oh-my-pi/pi-coding-agent/eval/js/shared/runtime";

// `xd://eval/agents` and `xd://eval/judge` tell JS sessions that `workpool()`, `judgeBatch()`,
// `judgeBatch.attach()` and every handle, pool and batch method except `drainIter` return
// Promises, and that `.id`/`.handle` live on the result of `await agent(…)`. A method that stops
// returning a Promise (or a new synchronous one) makes that rule wrong, so every method the
// prelude installs on those classes is called here and its return value checked.

/** Bridge replies just complete enough for the prelude to build handles, pools and batches. */
const bridge: Record<string, (args: { op?: string }) => unknown> = {
	__agent__: () => ({ id: "agent-1", agent: "task" }),
	__completion__: () => ({ id: "completion-1" }),
	__workpool__: args => (args.op === "create" ? { name: "pool-1", agent: "task", limit: 1 } : {}),
	__judge_batch__: args =>
		args.op === "create" || args.op === "attach" ? { id: "batch-1", total: 1, intent: "Judging" } : {},
};

describe("JS eval handle, pool and batch calls", () => {
	const hooks: RuntimeHooks = {
		onText: () => {},
		onDisplay: () => {},
		callTool: async (name, args) => bridge[name]?.(args as { op?: string }),
	};
	let runtime: JsRuntime;
	let observed: {
		methods: Record<string, boolean | string>;
		factories: Record<string, boolean | string>;
		drainIter: boolean | string;
		pending: { id: unknown; handle: unknown };
		awaitedHandle: unknown;
	};

	beforeAll(async () => {
		runtime = new JsRuntime({ initialCwd: process.cwd(), sessionId: "js-handle-promises" });
		observed = JSON.parse(
			(await runtime.run(
				`
				const returnsPromise = call => {
					let value;
					try {
						value = call();
					} catch (error) {
						return "threw " + error;
					}
					const thenable = (typeof value === "object" || typeof value === "function") && typeof value?.then === "function";
					if (thenable) Promise.resolve(value).catch(() => {});
					return thenable;
				};
				const questions = { q: { type: "bool", instructions: "probe" } };
				const pending = agent("probe");
				const instances = {
					PendingHandle: pending,
					AgentHandle: await agent("probe"),
					CompletionHandle: await completion("probe"),
					WorkPool: await workpool(),
					JudgmentBatch: await judgeBatch({ k: "probe" }, questions),
				};
				const skip = { constructor: true, toString: true, then: true, catch: true, finally: true, drainIter: true };
				const methods = {};
				for (const [kind, instance] of Object.entries(instances)) {
					for (let proto = Object.getPrototypeOf(instance); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
						for (const name of Object.getOwnPropertyNames(proto)) {
							if (Object.hasOwn(skip, name) || name.startsWith("_") || typeof proto[name] !== "function") continue;
							methods[kind + "." + name] ??= returnsPromise(() => instance[name]());
						}
					}
				}
				return JSON.stringify({
					methods,
					factories: {
						workpool: returnsPromise(() => workpool()),
						judgeBatch: returnsPromise(() => judgeBatch({ k: "probe" }, questions)),
						"judgeBatch.attach": returnsPromise(() => judgeBatch.attach("batch-1")),
					},
					drainIter: returnsPromise(() => instances.JudgmentBatch.drainIter()),
					pending: { id: pending.id ?? null, handle: pending.handle ?? null },
					awaitedHandle: instances.AgentHandle.handle,
				});
				`,
				undefined,
				hooks,
			)) as string,
		);
	});

	afterAll(() => {
		runtime.dispose();
	});

	it("returns a Promise from every handle, pool and batch method except drainIter", () => {
		expect(Object.keys(observed.methods)).toContain("AgentHandle.status");
		expect(Object.entries(observed.methods).filter(([, returnsPromise]) => returnsPromise !== true)).toEqual([]);
		expect(observed.drainIter).toBe(false);
	});

	it("returns a Promise from workpool(), judgeBatch() and judgeBatch.attach()", () => {
		expect(observed.factories).toEqual({ workpool: true, judgeBatch: true, "judgeBatch.attach": true });
	});

	it("exposes .id/.handle only on the result of await agent(…)", () => {
		expect(observed.pending).toEqual({ id: null, handle: null });
		expect(observed.awaitedHandle).toBe("agent://agent-1");
	});
});
