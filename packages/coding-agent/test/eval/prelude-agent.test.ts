import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import * as vm from "node:vm";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import { createHelpers } from "../../src/eval/js/shared/helpers";
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

describe("eval js wait() timeout (issue #12549)", () => {
	type WaitCall = Record<string, unknown>;
	type Waitable = { wait(...args: unknown[]): Promise<unknown> };
	type WaitHelper = (handles: unknown, opts?: unknown, ...rest: unknown[]) => Promise<unknown[]>;

	function loadWaitPrelude(): { sandbox: Record<string, unknown>; waitCalls: WaitCall[] } {
		const waitCalls: WaitCall[] = [];
		const sandbox = loadPrelude(async (name, args) => {
			if (name === "__agent__") return { id: "a-1", agent: "task" };
			if (name === "__wait__") {
				waitCalls.push(args as WaitCall);
				return { items: [{ status: "completed", text: "done" }] };
			}
			throw new Error(`unexpected bridge call ${name}`);
		});
		return { sandbox, waitCalls };
	}

	it("treats a positional wait() timeout as seconds", async () => {
		const { sandbox, waitCalls } = loadWaitPrelude();
		const handle = await (sandbox.agent as AgentHelper)("go");

		expect(await (sandbox.wait as WaitHelper)([handle], 30)).toEqual(["done"]);
		expect(waitCalls).toEqual([{ items: [{ kind: "agent", id: "a-1" }], timeoutMs: 30_000 }]);
	});

	it("treats a positional handle.wait() timeout as seconds on resolved and pending handles", async () => {
		const { sandbox, waitCalls } = loadWaitPrelude();
		const agent = sandbox.agent as (prompt: string) => Waitable;

		expect(await ((await agent("resolved")) as Waitable).wait(45)).toBe("done");
		expect(await agent("pending").wait(5)).toBe("done");
		expect(waitCalls.map(call => call.timeoutMs)).toEqual([45_000, 5_000]);
	});

	it("keeps the options-object form", async () => {
		const { sandbox, waitCalls } = loadWaitPrelude();
		const agent = sandbox.agent as AgentHelper;

		// Each handle caches its result after the first wait, so use one per call.
		await (sandbox.wait as WaitHelper)([await agent("first")], { timeout: 10 });
		await ((await agent("second")) as Waitable).wait({ timeout: 2 });
		expect(waitCalls.map(call => call.timeoutMs)).toEqual([10_000, 2_000]);
	});

	it("rejects mixing an options object with positional args", async () => {
		const { sandbox, waitCalls } = loadWaitPrelude();
		const agent = sandbox.agent as (prompt: string) => Waitable;
		const resolved = (await agent("resolved")) as Waitable;
		// The sandbox has its own TypeError constructor, so match on the message.
		const mixed = /do not mix both forms/;

		await expect((sandbox.wait as WaitHelper)([resolved], { timeout: 10 }, true)).rejects.toThrow(mixed);
		await expect(resolved.wait({ timeout: 1 }, 2)).rejects.toThrow(mixed);
		await expect(agent("pending").wait({ timeout: 1 }, 2)).rejects.toThrow(mixed);
		expect(waitCalls).toEqual([]);
	});
});

describe("eval js read() URI delegation", () => {
	it("appends line selectors to delegated URI paths", async () => {
		const calls: Array<{ name: string; args: unknown }> = [];
		const sandbox = loadPrelude(async (name, args) => {
			calls.push({ name, args });
			return { text: "resource contents" };
		});
		sandbox.__omp_helpers__ = { hasRoot: () => false };

		const result = await vm.runInContext(`read("mcp://server/resource", { offset: 10, limit: 5 })`, sandbox);

		expect(result).toBe("resource contents");
		expect(calls).toEqual([
			{
				name: "read",
				args: { path: "mcp://server/resource:10-14" },
			},
		]);
	});

	function loadArtifactPrelude(artifacts: string | undefined) {
		const roots: Record<string, string> = artifacts === undefined ? {} : { artifact: artifacts };
		const calls: Array<{ name: string; args: unknown }> = [];
		const sandbox = loadPrelude(async (name, args) => {
			calls.push({ name, args });
			return { text: "from the read tool" };
		});
		sandbox.__omp_helpers__ = createHelpers({
			cwd: () => process.cwd(),
			env: new Map(),
			localRoots: () => roots,
			emitStatus: () => {},
		});
		return { calls, sandbox };
	}

	it("returns an empty string for artifact:// reads with a non-positive limit", async () => {
		using tmp = TempDir.createSync("@eval-prelude-artifact-limit-");
		await Bun.write(path.join(tmp.path(), "12.eval.log"), "first\nsecond\nthird\n");
		const { calls, sandbox } = loadArtifactPrelude(tmp.path());

		expect(await vm.runInContext(`read("artifact://12", { limit: 0 })`, sandbox)).toBe("");
		expect(await vm.runInContext(`read("artifact://12", { limit: -1 })`, sandbox)).toBe("");
		expect(await vm.runInContext(`read("artifact://7", { limit: 0 })`, sandbox)).toBe("");
		expect(calls).toEqual([]);
	});

	it("asks the read tool for an artifact another session holds", async () => {
		using tmp = TempDir.createSync("@eval-prelude-artifact-fallback-");
		const { calls, sandbox } = loadArtifactPrelude(tmp.path());

		expect(await vm.runInContext(`read("artifact://7")`, sandbox)).toBe("from the read tool");
		expect(await vm.runInContext(`read("artifact://7", { offset: 2, limit: 2 })`, sandbox)).toBe(
			"from the read tool",
		);
		expect(calls).toEqual([
			{ name: "read", args: { path: "artifact://7:raw" } },
			{ name: "read", args: { path: "artifact://7:raw:2-3" } },
		]);
	});

	it("asks the read tool for the raw view when no artifacts dir was injected", async () => {
		const { calls, sandbox } = loadArtifactPrelude(undefined);

		expect(await vm.runInContext(`read("artifact://12")`, sandbox)).toBe("from the read tool");
		expect(await vm.runInContext(`read("artifact://12:raw:1-1")`, sandbox)).toBe("from the read tool");
		expect(calls).toEqual([
			{ name: "read", args: { path: "artifact://12:raw" } },
			{ name: "read", args: { path: "artifact://12:raw:1-1" } },
		]);
	});
});
