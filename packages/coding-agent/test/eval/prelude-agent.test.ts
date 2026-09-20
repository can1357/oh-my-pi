import { describe, expect, it } from "bun:test";
import * as vm from "node:vm";
import { JAVASCRIPT_PRELUDE_SOURCE } from "../../src/eval/js/shared/prelude";

/**
 * The eval `agent()` helper always returns an `AgentHandle` — spawning is
 * asynchronous, so callers get a recoverable `agent://<id>` handle and
 * resolve results through `wait()`/`output()` instead of a bare string.
 * These lock the bridge call shape, the handle surface, the positional-arg
 * order, the missing-id error contract, and schema-aware `wait()` parsing.
 *
 * The prelude source is executed verbatim in a throwaway VM context with only
 * the host bridge (`__omp_call_tool__`) stubbed — no worker, no kernel — so the
 * test runs against the real shipped helper, not a re-implementation.
 */
function loadPrelude(callTool: (name: string, args: unknown) => Promise<unknown>): Record<string, unknown> {
	const sandbox: Record<string, unknown> = { __omp_call_tool__: callTool };
	vm.createContext(sandbox);
	vm.runInContext(JAVASCRIPT_PRELUDE_SOURCE, sandbox);
	return sandbox;
}

type AgentHelper = (prompt: string, opts?: Record<string, unknown>) => Promise<unknown>;

describe("eval js agent() handle", () => {
	it("returns an AgentHandle carrying the bridge id, agent name, and agent:// uri", async () => {
		let seenName: string | undefined;
		let seenArgs: Record<string, unknown> | undefined;
		const sandbox = loadPrelude(async (name, args) => {
			seenName = name;
			seenArgs = args as Record<string, unknown>;
			return { id: "abc123", agent: "task" };
		});
		const handle = (await (sandbox.agent as AgentHelper)("say hi", {
			label: "Greeter",
		})) as Record<string, unknown>;
		expect(seenName).toBe("__agent__");
		expect(seenArgs).toEqual({ prompt: "say hi", label: "Greeter" });
		expect(handle.kind).toBe("agent");
		expect(handle.id).toBe("abc123");
		expect(handle.agent).toBe("task");
		expect(handle.handle).toBe("agent://abc123");
	});

	it("maps positional args onto named options in order", async () => {
		let seenArgs: Record<string, unknown> | undefined;
		const sandbox = loadPrelude(async (_name, args) => {
			seenArgs = args as Record<string, unknown>;
			return { id: "legacy", agent: "reviewer" };
		});
		const positionalAgent = sandbox.agent as (
			prompt: string,
			options?: unknown,
			...rest: unknown[]
		) => Promise<unknown>;
		const schema = { type: "object", properties: { ok: { type: "boolean" } } };

		await positionalAgent("scout", "reviewer", "Legacy", schema, true, false, true, "strict", ["read"]);

		expect(seenArgs).toEqual({
			prompt: "scout",
			agent: "reviewer",
			label: "Legacy",
			schema,
			isolated: true,
			apply: false,
			merge: true,
			schemaMode: "strict",
			tools: ["read"],
		});
	});

	it("throws when the bridge omits the handle id", async () => {
		const sandbox = loadPrelude(async () => ({ text: "lonely" }));
		// The factory returns a thenable handle wrapper, so normalize to a Promise
		// before asserting rejection (Bun's `.rejects` requires a real Promise).
		await expect(Promise.resolve((sandbox.agent as AgentHelper)("x"))).rejects.toThrow(
			"agent() did not return a handle",
		);
	});

	it("rejects a positional argument on handle.wait() before any bridge call", async () => {
		// Regression for #12549: `h.wait(3600000)` destructured `{ timeout }` off a
		// boxed number, produced `undefined`, and waited unbounded while the eval
		// watchdog was paused for the `__wait__` bridge call.
		const calls: string[] = [];
		const sandbox = loadPrelude(async name => {
			calls.push(name);
			if (name === "__agent__") return { id: "a-1", agent: "task" };
			throw new Error(`unexpected bridge call ${name}`);
		});
		const handle = (await (sandbox.agent as AgentHelper)("go")) as { wait(options?: unknown): Promise<unknown> };

		await expect(handle.wait(3600000)).rejects.toThrow(
			"AgentHandle.wait() expects an options object like { timeout }",
		);
		await expect(handle.wait("5")).rejects.toThrow("expects an options object");
		expect(calls).toEqual(["__agent__"]);
	});

	it("rejects a positional argument on the un-awaited factory handle", async () => {
		const calls: string[] = [];
		const sandbox = loadPrelude(async name => {
			calls.push(name);
			if (name === "__completion__") return { id: "c-1" };
			throw new Error(`unexpected bridge call ${name}`);
		});
		const completion = sandbox.completion as (
			prompt: string,
			opts?: unknown,
		) => { wait(options?: unknown): Promise<unknown> };

		await expect(completion("x").wait(5000)).rejects.toThrow(
			"CompletionHandle.wait() expects an options object like { timeout }",
		);
		expect(calls).toEqual(["__completion__"]);
	});

	it("rejects a non-object options argument on wait()", async () => {
		const calls: string[] = [];
		const sandbox = loadPrelude(async name => {
			calls.push(name);
			if (name === "__agent__") return { id: "a-1", agent: "task" };
			throw new Error(`unexpected bridge call ${name}`);
		});
		const handle = (await (sandbox.agent as AgentHelper)("go")) as { wait(options?: unknown): Promise<unknown> };
		const waitAll = sandbox.wait as (handles: unknown, options?: unknown) => Promise<unknown[]>;

		await expect(waitAll([handle], 5000)).rejects.toThrow(
			"wait() expects an options object like { timeout, raiseErrors }",
		);
		expect(calls).toEqual(["__agent__"]);
	});

	it("forwards { timeout } as timeoutMs to the __wait__ bridge", async () => {
		const calls: Array<{ name: string; args: unknown }> = [];
		const sandbox = loadPrelude(async (name, args) => {
			calls.push({ name, args });
			if (name === "__agent__") return { id: "a-1", agent: "task" };
			if (name === "__wait__") return { items: [{ status: "completed", text: "done" }] };
			throw new Error(`unexpected bridge call ${name}`);
		});
		const handle = (await (sandbox.agent as AgentHelper)("go")) as { wait(options?: unknown): Promise<unknown> };

		expect(await handle.wait({ timeout: 0 })).toBe("done");
		expect(calls[1]?.args).toEqual({ items: [{ kind: "agent", id: "a-1" }], timeoutMs: 0 });
	});

	it("parses wait() text as JSON only when a schema was given", async () => {
		const sandbox = loadPrelude(async name => {
			if (name === "__agent__") return { id: "id-9", agent: "task" };
			if (name === "__wait__") return { items: [{ status: "completed", text: '{"k":1}' }] };
			throw new Error(`unexpected bridge call ${name}`);
		});
		const withSchema = (await (sandbox.agent as AgentHelper)("emit", {
			schema: { type: "object" },
		})) as { wait(): Promise<unknown> };
		expect(await withSchema.wait()).toEqual({ k: 1 });

		const plain = (await (sandbox.agent as AgentHelper)("emit")) as {
			wait(): Promise<unknown>;
		};
		expect(await plain.wait()).toBe('{"k":1}');
	});
});

describe("eval js immediate-handle contract", () => {
	// Regression for #10986: the JS factories return immediately, so the
	// documented pattern `const h = completion(...); await h.wait()` must work
	// without first `await`-ing the factory itself.
	it("exposes handle methods on the un-awaited factory result", async () => {
		const sandbox = loadPrelude(async name => {
			if (name === "__completion__") return { id: "c-1" };
			if (name === "__wait__") return { items: [{ status: "completed", text: "OK" }] };
			throw new Error(`unexpected bridge call ${name}`);
		});
		const completion = sandbox.completion as (prompt: string, opts?: unknown) => { wait(): Promise<unknown> };

		const handle = completion("Return OK", { model: "smol" });
		expect(typeof handle.wait).toBe("function");
		expect(await handle.wait()).toBe("OK");
	});

	it("treats an un-awaited factory result as a single handle in wait()", async () => {
		const sandbox = loadPrelude(async name => {
			if (name === "__agent__") return { id: "a-2", agent: "task" };
			if (name === "__wait__") return { items: [{ status: "completed", text: "done" }] };
			throw new Error(`unexpected bridge call ${name}`);
		});
		const waitAll = sandbox.wait as (handles: unknown) => Promise<unknown[]>;

		expect(await waitAll((sandbox.agent as AgentHelper)("go"))).toEqual(["done"]);
	});
});

describe("eval js read() URI delegation", () => {
	it("appends line selectors to delegated URI paths", async () => {
		const calls: Array<{ name: string; args: unknown }> = [];
		const sandbox = loadPrelude(async (name, args) => {
			calls.push({ name, args });
			return { text: "resource contents" };
		});

		const result = await vm.runInContext(`read("mcp://server/resource", { offset: 10, limit: 5 })`, sandbox);

		expect(result).toBe("resource contents");
		expect(calls).toEqual([
			{
				name: "read",
				args: { path: "mcp://server/resource:10-14" },
			},
		]);
	});
});
