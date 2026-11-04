import { afterEach, describe, expect, it } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import * as path from "node:path";
import * as vm from "node:vm";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	registerArtifactsDir,
	resetRegisteredArtifactDirsForTests,
} from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import { AgentRegistry } from "../../src/registry/agent-registry";
import type { AgentSession } from "../../src/session/agent-session";
import { createHelpers } from "../../src/eval/js/shared/helpers";
import { JAVASCRIPT_PRELUDE_SOURCE } from "../../src/eval/js/shared/prelude";
import { callSessionTool } from "../../src/eval/js/tool-bridge";
import { artifactReadBridge } from "../helpers/artifact-read-bridge";

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

	function loadArtifactPrelude(
		artifacts: string | undefined,
		readTool: (args: { path: string }) => Promise<unknown> = async () => ({ text: "from the read tool" }),
	) {
		const roots: Record<string, string> = artifacts === undefined ? {} : { artifact: artifacts };
		const calls: Array<{ name: string; args: unknown }> = [];
		const sandbox = loadPrelude(async (name, args) => {
			calls.push({ name, args });
			return readTool(args as { path: string });
		});
		sandbox.__omp_helpers__ = createHelpers({
			cwd: () => process.cwd(),
			env: new Map(),
			localRoots: () => roots,
			emitStatus: () => {},
		});
		return { calls, sandbox };
	}

	// Over the 50 KB a bare `:raw` read inlines, with a line wider than any column cap and a trailing newline.
	const largeArtifact = ["head", "w".repeat(60_000), ...Array.from({ length: 3000 }, (_, i) => `row ${i}`), ""].join(
		"\n",
	);

	it("returns an empty string for artifact:// reads with a non-positive limit", async () => {
		using tmp = TempDir.createSync("@eval-prelude-artifact-limit-");
		await Bun.write(path.join(tmp.path(), "12.eval.log"), "first\nsecond\nthird\n");
		const { calls, sandbox } = loadArtifactPrelude(tmp.path());

		expect(await vm.runInContext(`read("artifact://12", { limit: 0 })`, sandbox)).toBe("");
		expect(await vm.runInContext(`read("artifact://12", { limit: -1 })`, sandbox)).toBe("");
		expect(await vm.runInContext(`read("artifact://7", { limit: 0 })`, sandbox)).toBe("");
		expect(calls).toEqual([]);
	});

	it("reads an artifact another session holds in full, however large, through the read tool", async () => {
		using tmp = TempDir.createSync("@eval-prelude-artifact-fallback-");
		const owner = path.join(tmp.path(), "owner");
		await Bun.write(path.join(owner, "7.bash.log"), largeArtifact);
		const { calls, sandbox } = loadArtifactPrelude(
			path.join(tmp.path(), "own"),
			artifactReadBridge(tmp.path(), owner),
		);

		expect(await vm.runInContext(`read("artifact://7")`, sandbox)).toBe(largeArtifact);
		expect(await vm.runInContext(`read("artifact://7", { offset: 2, limit: 2 })`, sandbox)).toBe(
			`${"w".repeat(60_000)}\nrow 0`,
		);
		expect(await vm.runInContext(`read("artifact://7", { offset: 3 })`, sandbox)).toBe(
			`${Array.from({ length: 3000 }, (_, i) => `row ${i}`).join("\n")}\n`,
		);
		expect(calls).toEqual([
			{ name: "read", args: { path: "artifact://7:raw:1-1" } },
			{ name: "read", args: { path: "artifact://7:raw:1-1" } },
			{ name: "read", args: { path: "artifact://7:raw:1-1" } },
		]);
	});

	it("reads an artifact in full through the read tool when no artifacts dir was injected", async () => {
		using tmp = TempDir.createSync("@eval-prelude-artifact-no-root-");
		await Bun.write(path.join(tmp.path(), "12.eval.log"), largeArtifact);
		const { calls, sandbox } = loadArtifactPrelude(undefined, artifactReadBridge(tmp.path(), tmp.path()));

		expect(await vm.runInContext(`read("artifact://12")`, sandbox)).toBe(largeArtifact);
		expect(await vm.runInContext(`read("artifact://12:raw:1-1")`, sandbox)).toBe("head");
		expect(calls).toEqual([
			{ name: "read", args: { path: "artifact://12:raw:1-1" } },
			{ name: "read", args: { path: "artifact://12:raw:1-1" } },
		]);
	});

	it("returns a replacement read tool's text when it names no artifact file", async () => {
		// An extension's same-name `read` replacement returns its own content without the built-in's `details`.
		const { calls, sandbox } = loadArtifactPrelude(undefined, async args => ({ text: `replaced ${args.path}` }));

		expect(await vm.runInContext(`read("artifact://12")`, sandbox)).toBe("replaced artifact://12:raw");
		expect(await vm.runInContext(`read("artifact://12", { offset: 2, limit: 2 })`, sandbox)).toBe(
			"replaced artifact://12:raw:2-3",
		);
		expect(calls).toEqual([
			{ name: "read", args: { path: "artifact://12:raw:1-1" } },
			{ name: "read", args: { path: "artifact://12:raw" } },
			{ name: "read", args: { path: "artifact://12:raw:1-1" } },
			{ name: "read", args: { path: "artifact://12:raw:2-3" } },
		]);
	});
});

describe("eval js workpool model selection", () => {
	it("sends an exact selector through the shipped workpool helper", async () => {
		const calls: Array<{ name: string; args: unknown }> = [];
		const sandbox = loadPrelude(async (name, args) => {
			calls.push({ name, args });
			return { name: "chosen", agent: "scout", limit: 2 };
		});
		const create = sandbox.workpool as (agent: string, options: Record<string, unknown>) => Promise<unknown>;
		await create("scout", { name: "chosen", model: "p/chosen:high" });
		expect(calls).toEqual([
			{
				name: "__workpool__",
				args: { op: "create", agent: "scout", name: "chosen", model: "p/chosen:high" },
			},
		]);
	});
});

describe("eval js output() options (issue #17455)", () => {
	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		resetRegisteredArtifactDirsForTests();
	});

	// Over the 50 KB the read tool pages agent:// at, so only a verbatim read reaches the tail.
	const rows = Array.from({ length: 4000 }, (_, i) => `ROW ${i + 1} ${"x".repeat(20)}`);

	/** The prelude behind the real eval bridge: schema validation, then the built-in read tool on agent://. */
	async function loadOutputPrelude(tmp: TempDir): Promise<Record<string, unknown>> {
		const artifacts = path.join(tmp.path(), "artifacts");
		await Bun.write(path.join(artifacts, "Scout.md"), `${rows.join("\n")}\n`);
		await Bun.write(
			path.join(artifacts, "Report.md"),
			JSON.stringify({ files: [{ path: "a.ts" }, { path: "b.ts" }] }),
		);
		await Bun.write(path.join(artifacts, "Shell.md"), "\x1b[31mred\x1b[0m plain\n");
		await Bun.write(path.join(artifacts, "Wide.md"), `${"w".repeat(60_000)}\nlast\n`);
		registerArtifactsDir(artifacts);
		const session: ToolSession = {
			cwd: tmp.path(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getArtifactsDir: () => artifacts,
			settings: Settings.isolated(),
		};
		const readTool = new ReadTool(session);
		session.getToolByName = name => (name === "read" ? (readTool as unknown as AgentTool) : undefined);
		const sandbox = loadPrelude((name, args) => callSessionTool(name, args, { session }));
		sandbox.__omp_helpers__ = createHelpers({
			cwd: () => tmp.path(),
			env: new Map(),
			localRoots: () => ({}),
			emitStatus: () => {},
		});
		return sandbox;
	}

	it("selects the offset/limit line window, verbatim past the read tool's page", async () => {
		using tmp = TempDir.createSync("@eval-prelude-output-lines-");
		const sandbox = await loadOutputPrelude(tmp);

		expect(await vm.runInContext(`output("Scout", { offset: 3990, limit: 2 })`, sandbox)).toBe(
			`${rows[3989]}\n${rows[3990]}`,
		);
		expect(await vm.runInContext(`output("Scout")`, sandbox)).toBe(`${rows.join("\n")}\n`);
		expect(await vm.runInContext(`output("Wide", { offset: 2, limit: 1 })`, sandbox)).toBe("last");
		expect(await vm.runInContext(`output("Scout", "Shell", { limit: 1 })`, sandbox)).toEqual([
			{ id: "Scout", content: rows[0] },
			{ id: "Shell", content: "\x1b[31mred\x1b[0m plain" },
		]);
		await expect(vm.runInContext(`output("Scout", { offset: 4001 })`, sandbox)).rejects.toThrow(
			"Offset 4001 is beyond end of output (4000 lines) for Scout",
		);
	});

	it("extracts a JSON query and refuses to combine it with a line window", async () => {
		using tmp = TempDir.createSync("@eval-prelude-output-query-");
		const sandbox = await loadOutputPrelude(tmp);

		expect(await vm.runInContext(`output("Report", { query: ".files[1].path" })`, sandbox)).toBe('"b.ts"');
		expect(await vm.runInContext(`output("Report", { query: ".files[5]" })`, sandbox)).toBe("null");
		await expect(vm.runInContext(`output("Scout", { query: ".x" })`, sandbox)).rejects.toThrow(
			"Output Scout is not valid JSON",
		);
		await expect(vm.runInContext(`output("Report", { query: ".files", limit: 1 })`, sandbox)).rejects.toThrow(
			"query cannot be combined with offset/limit",
		);
	});

	it("strips ANSI for format stripped and returns metadata for format json", async () => {
		using tmp = TempDir.createSync("@eval-prelude-output-format-");
		const sandbox = await loadOutputPrelude(tmp);

		expect(await vm.runInContext(`output("Shell", { format: "stripped" })`, sandbox)).toBe("red plain\n");
		expect(await vm.runInContext(`output("Scout", { format: "json", offset: 2, limit: 1 })`, sandbox)).toEqual({
			id: "Scout",
			path: path.join(tmp.path(), "artifacts", "Scout.md"),
			line_count: 4000,
			char_count: rows.join("\n").length + 1,
			content: rows[1],
			range: { start_line: 2, end_line: 2, total_lines: 4000 },
		});
	});

	it("keeps the previous-run banner while the agent streams a follow-up, but queries the published data", async () => {
		using tmp = TempDir.createSync("@eval-prelude-output-superseded-");
		const sandbox = await loadOutputPrelude(tmp);
		const registry = AgentRegistry.global();
		for (const id of ["Scout", "Report"]) {
			registry.register({
				id,
				displayName: id,
				kind: "sub",
				session: { isStreaming: true } as AgentSession,
				status: "running",
			});
		}

		expect(await vm.runInContext(`output("Scout", { limit: 1 })`, sandbox)).toContain("PREVIOUS run");
		expect(await vm.runInContext(`output("Report", { query: ".files[0].path" })`, sandbox)).toBe('"a.ts"');

		registry.setStatus("Scout", "idle");
		expect(await vm.runInContext(`output("Scout")`, sandbox)).toBe(`${rows.join("\n")}\n`);
	});
});
