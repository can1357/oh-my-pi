import { describe, expect, it } from "bun:test";
import * as vm from "node:vm";
import { JAVASCRIPT_PRELUDE_SOURCE } from "../js/shared/prelude";

/**
 * The eval `agent()` helper grows a `handle` option that turns its bare
 * text result into a DAG node dict carrying the spawned agent's recoverable
 * `agent://<id>` handle, so a downstream `pipeline`/`parallel` stage can wire
 * the transcript by reference instead of re-inlining it. These lock the node
 * shape, backward compatibility of the default path, the schema interaction,
 * and the no-`details` fallback (the helper must never throw).
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
	it("returns a DAG node carrying the agent:// handle when handle is set", async () => {
		let seenName: string | undefined;
		let seenArgs: Record<string, unknown> | undefined;
		const sandbox = loadPrelude(async (name, args) => {
			seenName = name;
			seenArgs = args as Record<string, unknown>;
			return { text: "hello world", details: { agent: "task", id: "abc123", model: "m", structured: false } };
		});
		const node = await (sandbox.agent as AgentHelper)("say hi", { handle: true });
		expect(seenName).toBe("__agent__");
		expect(seenArgs?.handle).toBe(true);
		expect(node).toEqual({
			text: "hello world",
			output: "hello world",
			handle: "agent://abc123",
			id: "abc123",
			agent: "task",
		});
	});

	it("returns bare text by default (backward compatible)", async () => {
		const sandbox = loadPrelude(async () => ({
			text: "hello world",
			details: { agent: "task", id: "abc123", structured: false },
		}));
		const out = await (sandbox.agent as AgentHelper)("say hi");
		expect(out).toBe("hello world");
	});

	it("carries the parsed object under data when schema and handle combine", async () => {
		const payload = JSON.stringify({ k: 1 });
		const sandbox = loadPrelude(async () => ({
			text: payload,
			details: { agent: "task", id: "id-9", structured: true },
		}));
		const node = (await (sandbox.agent as AgentHelper)("emit", {
			schema: { type: "object" },
			handle: true,
		})) as Record<string, unknown>;
		expect(node.handle).toBe("agent://id-9");
		expect(node.data).toEqual({ k: 1 });
		expect(node.text).toBe(payload);
	});

	it("falls back to a null handle without throwing when the bridge omits details", async () => {
		const sandbox = loadPrelude(async () => ({ text: "lonely" }));
		const node = await (sandbox.agent as AgentHelper)("x", { handle: true });
		expect(node).toEqual({ text: "lonely", output: "lonely", handle: null, id: null, agent: null });
	});

	it("exposes patchPath/branchName/nestedPatches/changesApplied/isolated/isolationSummary on the handle", async () => {
		const payload = JSON.stringify({ ok: true });
		const sandbox = loadPrelude(async () => ({
			text: payload,
			details: {
				agent: "task",
				id: "iso-1",
				structured: true,
				isolated: true,
				patchPath: "/artifacts/iso-1.patch",
				changesApplied: null,
				nestedPatches: [{ relativePath: "nested", patch: "diff --git a/file b/file\n" }],
				isolationSummary: "Isolation: changes captured at `/artifacts/iso-1.patch` (apply=false). Not applied.",
			},
		}));
		const node = (await (sandbox.agent as AgentHelper)("scout", {
			schema: { type: "object" },
			isolated: true,
			apply: false,
			handle: true,
		})) as Record<string, unknown>;
		expect(node.handle).toBe("agent://iso-1");
		expect(node.data).toEqual({ ok: true });
		expect(node.isolated).toBe(true);
		expect(node.patchPath).toBe("/artifacts/iso-1.patch");
		expect(node.nestedPatches).toEqual([{ relativePath: "nested", patch: "diff --git a/file b/file\n" }]);
		expect(node.changesApplied).toBeNull();
		expect(node.isolationSummary).toContain("/artifacts/iso-1.patch");
		expect("branchName" in node).toBe(false);
	});
});
