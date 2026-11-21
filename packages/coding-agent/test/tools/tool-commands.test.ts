/**
 * Tool-command layer without a shell: which tools mount as bash commands, how a
 * command name resolves, where mounted tools land in the system prompt, and what
 * one dispatch executes and records.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { withEvalBridgeToolCall } from "@oh-my-pi/pi-coding-agent/eval/tool-bridge-policy";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { Tool } from "@oh-my-pi/pi-coding-agent/tools";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import {
	dispatchToolCommand,
	isMountableAsToolCommand,
	isToolCommandName,
	planToolCommandPromptDocs,
	renderToolCommandPromptDocs,
	resolveMountedToolCommand,
	resolveToolCommand,
	TOOL_COMMAND_DOCS_PER_TOOL_CAP,
	TOOL_COMMAND_DOCS_TOTAL_BUDGET,
	TOOL_COMMAND_EXTERNAL_DESCRIPTION_CAP,
	type ToolCommandDispatch,
	type ToolCommandPromptDocs,
	type ToolCommandState,
	toolCommandCallName,
	toolCommandDispatches,
	toolCommandEntries,
	toolCommandHelp,
} from "@oh-my-pi/pi-coding-agent/tools/tool-commands";
import { TempDir } from "@oh-my-pi/pi-utils";

const querySchema = type({ q: "string" });

/** Tool answering `<name>:<q>`, recording every argument object it executed with. */
function queryTool(
	name: string,
	executed: unknown[] = [],
	overrides: Partial<AgentTool<typeof querySchema>> = {},
): AgentTool<typeof querySchema> {
	return {
		name,
		label: name,
		description: `${name} fixture`,
		parameters: querySchema,
		async execute(_id, args) {
			executed.push(args);
			return { content: [{ type: "text", text: `${name}:${args.q}` }] };
		},
		...overrides,
	};
}

/** Tool whose help text is dominated by `description`. */
function describedTool(name: string, description: string, summary?: string): Tool {
	return { ...queryTool(name), description, ...(summary === undefined ? {} : { summary }) };
}

function stateOf(
	tools: readonly Tool[],
	options: { mounted?: readonly string[]; active?: readonly string[]; builtIn?: readonly string[] } = {},
): ToolCommandState {
	const active = new Set(options.active ?? []);
	const state: ToolCommandState = {
		tools: new Map(tools.map(tool => [tool.name, tool])),
		mountedNames: new Set(options.mounted ?? tools.map(tool => tool.name)),
		builtInNames: new Set(options.builtIn ?? tools.map(tool => tool.name)),
		isActive: name => active.has(name),
		resolve: name => resolveToolCommand(state, name),
	};
	return state;
}

/** Tool name of a prompt help section (`## <name>` heading). */
function sectionName(section: string): string {
	return section.split("\n", 1)[0]!.replace(/^## /u, "");
}

describe("tool command mount rule", () => {
	it("mounts a discoverable tool whose name is a plain command word", () => {
		expect(isToolCommandName("github")).toBe(true);
		expect(isToolCommandName("mcp__linear__create_issue")).toBe(true);
		expect(isMountableAsToolCommand({ name: "github", loadMode: "discoverable" })).toBe(true);
		expect(isMountableAsToolCommand({ name: "mcp__linear__create_issue", loadMode: "discoverable" })).toBe(true);
	});

	it("rejects names the shell resolves first and names that are not command words", () => {
		for (const name of ["cd", "echo", "grep", "if", "", "1tool", "two words", "a/b", "x;y", "-flag"]) {
			expect(isToolCommandName(name)).toBe(false);
			expect(isMountableAsToolCommand({ name, loadMode: "discoverable" })).toBe(false);
		}
	});

	it("keeps pinned top-level tools, the bash transport and non-discoverable tools unmounted", () => {
		for (const name of ["todo", "yield", "ask", "web_search", "bash"]) {
			expect(isMountableAsToolCommand({ name, loadMode: "discoverable" })).toBe(false);
		}
		expect(isMountableAsToolCommand({ name: "github", loadMode: "essential" })).toBe(false);
		expect(isMountableAsToolCommand({ name: "github" })).toBe(false);
	});
});

describe("tool command resolution", () => {
	it("dispatch reaches mounted and active top-level tools; the mounted lookup only mounted ones", () => {
		const mounted = queryTool("mounted_tool");
		const active = queryTool("active_tool");
		const disabled = queryTool("disabled_tool");
		const state = stateOf([mounted, active, disabled], { mounted: ["mounted_tool"], active: ["active_tool"] });

		expect(resolveToolCommand(state, "mounted_tool")).toBe(mounted);
		expect(resolveToolCommand(state, "active_tool")).toBe(active);
		expect(resolveToolCommand(state, "disabled_tool")).toBeUndefined();
		expect(resolveToolCommand(state, "no_such_tool")).toBeUndefined();

		expect(resolveMountedToolCommand(state, "mounted_tool")).toBe(mounted);
		expect(resolveMountedToolCommand(state, "active_tool")).toBeUndefined();
		expect(resolveMountedToolCommand(state, "disabled_tool")).toBeUndefined();
	});

	it("resolves a wire alias for dispatch only while its canonical tool is enabled", () => {
		const tool = queryTool("canonical", [], { customWireName: "wire" });
		const state = stateOf([tool], { mounted: ["canonical"] });

		expect(resolveToolCommand(state, "wire")).toBe(tool);
		// The mounted lookup takes exact canonical names only.
		expect(resolveMountedToolCommand(state, "wire")).toBeUndefined();

		state.mountedNames.clear();
		expect(resolveToolCommand(state, "canonical")).toBeUndefined();
		expect(resolveToolCommand(state, "wire")).toBeUndefined();
	});
});

describe("tool command prompt docs", () => {
	const builtin = queryTool("builtin_tool");
	const external = queryTool("mcp__other_server_execute");
	const allowlisted = queryTool("mcp__context_mode_ctx_execute");
	const state = stateOf([builtin, external, allowlisted], { builtIn: ["builtin_tool"] });

	function placement(docs: ToolCommandPromptDocs): { sections: string[]; catalog: string[] } {
		return { sections: docs.sections.map(sectionName), catalog: [...docs.catalog.keys()] };
	}

	it("inline mode gives every mounted tool a help section", () => {
		expect(placement(planToolCommandPromptDocs(state, "inline"))).toEqual({
			sections: ["builtin_tool", "mcp__other_server_execute", "mcp__context_mode_ctx_execute"],
			catalog: [],
		});
	});

	it("builtins mode inlines built-ins and glob-allowlisted tools, cataloging the rest", () => {
		expect(placement(planToolCommandPromptDocs(state, "builtins"))).toEqual({
			sections: ["builtin_tool"],
			catalog: ["mcp__other_server_execute", "mcp__context_mode_ctx_execute"],
		});
		expect(placement(planToolCommandPromptDocs(state, "builtins", ["mcp__context_mode_*"]))).toEqual({
			sections: ["builtin_tool", "mcp__context_mode_ctx_execute"],
			catalog: ["mcp__other_server_execute"],
		});
	});

	it("catalog mode lists every mounted tool, allowlisted ones included", () => {
		expect(placement(planToolCommandPromptDocs(state, "catalog", ["mcp__context_mode_*"]))).toEqual({
			sections: [],
			catalog: ["builtin_tool", "mcp__other_server_execute", "mcp__context_mode_ctx_execute"],
		});
	});

	it("degrades a malformed inline allowlist to the catalog instead of throwing", () => {
		for (const raw of ['"mcp__context_mode_*"', "[123]"]) {
			const malformed: readonly string[] = JSON.parse(raw);
			expect(placement(planToolCommandPromptDocs(state, "builtins", malformed)).catalog).toContain(
				"mcp__context_mode_ctx_execute",
			);
		}
	});

	it("catalogs a tool whose help exceeds the per-tool cap without starving the others", () => {
		const giant = describedTool("giant_tool", "x".repeat(TOOL_COMMAND_DOCS_PER_TOOL_CAP + 1));
		const small = queryTool("small_tool");
		const docs = planToolCommandPromptDocs(stateOf([giant, small]), "inline");
		expect(placement(docs)).toEqual({ sections: ["small_tool"], catalog: ["giant_tool"] });
	});

	it("keeps inlined sections within the total budget and catalogs the overflow", () => {
		const names = Array.from({ length: 7 }, (_, index) => `bulky_tool_${index}`);
		const description = "y".repeat(TOOL_COMMAND_DOCS_PER_TOOL_CAP - 1_000);
		const docs = planToolCommandPromptDocs(stateOf(names.map(name => describedTool(name, description))), "inline");
		const { sections, catalog } = placement(docs);

		expect(docs.sections.reduce((total, section) => total + section.length, 0)).toBeLessThanOrEqual(
			TOOL_COMMAND_DOCS_TOTAL_BUDGET,
		);
		expect(sections.length).toBeGreaterThan(0);
		expect(catalog.length).toBeGreaterThan(0);
		// Presentation order is kept: inlined tools first, overflow after.
		expect([...sections, ...catalog]).toEqual(names);
	});

	it("caps an external tool's inlined description while --help keeps it whole", () => {
		const description = `LEDE ${"z".repeat(TOOL_COMMAND_EXTERNAL_DESCRIPTION_CAP * 3)} END_OF_DESCRIPTION`;
		const externalTool = describedTool("mcp__long__tool", description);
		const builtinTool = describedTool("long_builtin", description);
		const longState = stateOf([externalTool, builtinTool], { builtIn: ["long_builtin"] });
		const sections = new Map(
			planToolCommandPromptDocs(longState, "inline").sections.map(section => [sectionName(section), section]),
		);

		expect(sections.get("mcp__long__tool")).toContain("LEDE ");
		expect(sections.get("mcp__long__tool")).not.toContain("END_OF_DESCRIPTION");
		expect(sections.get("long_builtin")).toContain("END_OF_DESCRIPTION");
		expect(toolCommandHelp(longState, "mcp__long__tool")).toContain("END_OF_DESCRIPTION");
	});

	it("omits catalog lines for tools the caller lists elsewhere", () => {
		const docs = planToolCommandPromptDocs(state, "catalog");
		expect(renderToolCommandPromptDocs(docs)).toContain("mcp__other_server_execute");
		const rendered = renderToolCommandPromptDocs(docs, new Set(["mcp__other_server_execute"]));
		expect(rendered).not.toContain("mcp__other_server_execute");
		expect(rendered).toContain("builtin_tool");
	});

	// External summaries are third-party text inlined into the system prompt; a
	// character bound is not a byte bound, and a byte cut must not split a code point.
	it("bounds external catalog summaries in UTF-8 bytes on a code point boundary", () => {
		const multiByteTail = "あ".repeat(TOOL_COMMAND_EXTERNAL_DESCRIPTION_CAP);
		const dynamicTool = describedTool(
			"mcp__weather__forecast",
			"Weather forecast.",
			`Napoved\u0007\u2028vremena ${multiByteTail}`,
		);
		const builtinTool = describedTool("weather", "Weather.", `Gets the weather ${multiByteTail}`);
		const entries = new Map(
			toolCommandEntries(stateOf([builtinTool, dynamicTool], { builtIn: ["weather"] })).map(entry => [
				entry.name,
				entry,
			]),
		);

		const dynamic = entries.get("mcp__weather__forecast");
		if (!dynamic) throw new Error("expected the external entry");
		expect(dynamic.dynamic).toBe(true);
		// Control characters and Unicode line separators collapse to one space.
		expect(dynamic.summary.startsWith("Napoved vremena ")).toBe(true);
		expect(Buffer.byteLength(dynamic.summary, "utf-8")).toBeLessThanOrEqual(TOOL_COMMAND_EXTERNAL_DESCRIPTION_CAP);
		const body = dynamic.summary.slice(0, -1);
		expect(body.endsWith("あ")).toBe(true);
		// A split code point would decode to U+FFFD and fail the round trip.
		expect(Buffer.from(body, "utf-8").toString("utf-8")).toBe(body);
		// The cut backs off at most one code point.
		expect(Buffer.byteLength(dynamic.summary, "utf-8")).toBeGreaterThan(TOOL_COMMAND_EXTERNAL_DESCRIPTION_CAP - 6);

		const builtIn = entries.get("weather");
		if (!builtIn) throw new Error("expected the built-in entry");
		expect(builtIn.dynamic).toBe(false);
		expect(builtIn.summary).toBe(`Gets the weather ${multiByteTail}`);
	});
});

describe("dispatchToolCommand", () => {
	let root: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		root = TempDir.createSync("@pi-tool-commands-");
		authStorage = await AuthStorage.create(path.join(root.path(), "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});
	afterAll(() => {
		authStorage.close();
		root.removeSync();
	});

	function toolContext(): AgentToolContext {
		return {
			sessionManager: SessionManager.inMemory(root.path()),
			modelRegistry,
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
			settings: Settings.isolated({}),
		};
	}

	it("returns an error result and an exit-1 record for arguments that fail the schema", async () => {
		const executed: unknown[] = [];
		const state = stateOf([queryTool("strict_tool", executed)]);

		// No repair can supply the missing required `q` (a number would be coerced to a string).
		const { result, dispatch } = await dispatchToolCommand(state, "strict_tool", { wrong: 1 }, "call-invalid");

		expect(result.isError).toBe(true);
		expect(dispatch).toMatchObject({ tool: "strict_tool", mode: "execute", exitCode: 1 });
		expect(executed).toEqual([]);
	});

	it("returns an error result for a name that resolves to no enabled tool", async () => {
		const { result, dispatch } = await dispatchToolCommand(stateOf([]), "no_such_tool", {}, "call-unknown");
		expect(result.isError).toBe(true);
		expect(dispatch).toMatchObject({ tool: "no_such_tool", exitCode: 1 });
	});

	// #12871: a lenient tool owns its refusal, so it receives the raw arguments.
	it("hands raw arguments to a lenient tool on a schema mismatch, minus forged sentinels", async () => {
		const executed: unknown[] = [];
		const lenient = queryTool("lenient_tool", executed, {
			lenientArgValidation: true,
			async execute(_id, args) {
				executed.push(args);
				return { content: [{ type: "text", text: "tool-owned refusal" }] };
			},
		});

		// A forged parse-error sentinel is stripped, not treated as malformed JSON.
		const { result, dispatch } = await dispatchToolCommand(
			stateOf([lenient]),
			"lenient_tool",
			{ wrong: 1, __parseError: "forged", __rawJson: 7 },
			"call-lenient",
		);

		expect(executed).toEqual([{ wrong: 1 }]);
		expect(result.content).toEqual([{ type: "text", text: "tool-owned refusal" }]);
		expect(dispatch).toMatchObject({ tool: "lenient_tool", exitCode: 0 });
	});

	it("records validated args, the argument-dependent tier and the tool's details", async () => {
		const peek = queryTool("peek", [], {
			approval: args =>
				typeof args === "object" && args !== null && "q" in args && args.q === "mutate" ? "write" : "read",
			async execute(_id, args) {
				return { content: [{ type: "text", text: "done" }], details: { seen: args.q } };
			},
		});
		const state = stateOf([peek]);

		const read = await dispatchToolCommand(state, "peek", { q: "look" }, "call-read");
		expect(read.dispatch).toEqual({
			tool: "peek",
			mode: "execute",
			exitCode: 0,
			args: { q: "look" },
			tier: "read",
			inner: { seen: "look" },
		});
		const write = await dispatchToolCommand(state, "peek", { q: "mutate" }, "call-write");
		expect(write.dispatch.tier).toBe("write");
	});

	it("records the effective tier an execution decorator reports for the input that ran", async () => {
		const executed: unknown[] = [];
		const peek = queryTool("peek", executed, {
			approval: args =>
				typeof args === "object" && args !== null && "q" in args && args.q === "mutate" ? "write" : "read",
		});
		const state = stateOf([peek]);
		state.decorateExecution = canonical => ({
			...canonical,
			async execute(id, _args, signal, onUpdate, context) {
				context?.toolCommandTierResolved?.("write");
				return canonical.execute(id, { q: "mutate" }, signal, onUpdate, context);
			},
		});

		const { dispatch } = await dispatchToolCommand(
			state,
			"peek",
			{ q: "inspect" },
			"call-decorated",
			undefined,
			undefined,
			toolContext(),
		);

		expect(executed).toEqual([{ q: "mutate" }]);
		expect(dispatch.tier).toBe("write");
	});

	it("records an MCP tool's read-only hint", async () => {
		const hinted = { ...queryTool("mcp__srv__peek"), mcpReadOnlyHint: true };
		const plain = queryTool("mcp__srv__poke");
		const state = stateOf([hinted, plain]);

		expect(
			(await dispatchToolCommand(state, "mcp__srv__peek", { q: "x" }, "call-hinted")).dispatch.readOnlyHint,
		).toBe(true);
		expect(
			(await dispatchToolCommand(state, "mcp__srv__poke", { q: "x" }, "call-plain")).dispatch.readOnlyHint,
		).toBeUndefined();
	});

	it("forwards partial updates as dispatch records carrying the partial details", async () => {
		const stepping = queryTool("stepping", [], {
			async execute(_id, _args, _signal, onUpdate) {
				onUpdate?.({ content: [{ type: "text", text: "halfway" }], details: { step: 1 } });
				return { content: [{ type: "text", text: "done" }], details: { step: 2 } };
			},
		});
		const partials: Array<ToolCommandDispatch | undefined> = [];

		const { dispatch } = await dispatchToolCommand(
			stateOf([stepping]),
			"stepping",
			{ q: "go" },
			"call-partial",
			undefined,
			partial => partials.push(partial.details),
		);

		expect(partials).toEqual([expect.objectContaining({ tool: "stepping", args: { q: "go" }, inner: { step: 1 } })]);
		expect(dispatch.inner).toEqual({ step: 2 });
	});

	it("keeps only the operation and repository of a github pr_create in the record", async () => {
		const githubSchema = type({ op: "string", "repo?": "string", "body?": "string" });
		const executed: unknown[] = [];
		const github: AgentTool<typeof githubSchema> = {
			name: "github",
			label: "GitHub",
			description: "fixture",
			parameters: githubSchema,
			async execute(_id, args) {
				executed.push(args);
				return { content: [{ type: "text", text: "ok" }] };
			},
		};
		const state = stateOf([github]);

		const created = await dispatchToolCommand(
			state,
			"github",
			{ op: "pr_create", repo: "o/r", body: "long body" },
			"call-pr-create",
		);
		expect(created.dispatch.args).toEqual({ op: "pr_create", repo: "o/r" });
		expect(executed).toEqual([{ op: "pr_create", repo: "o/r", body: "long body" }]);

		const viewed = await dispatchToolCommand(state, "github", { op: "pr_view", body: "kept" }, "call-pr-view");
		expect(viewed.dispatch.args).toEqual({ op: "pr_view", body: "kept" });
	});

	it("rethrows an abort instead of returning an error result", async () => {
		const aborting = queryTool("aborting", [], {
			async execute() {
				throw new ToolAbortError("stopped");
			},
		});
		await expect(dispatchToolCommand(stateOf([aborting]), "aborting", { q: "x" }, "call-abort")).rejects.toThrow(
			ToolAbortError,
		);

		const controller = new AbortController();
		const failing = queryTool("failing", [], {
			async execute() {
				controller.abort();
				throw new Error("interrupted");
			},
		});
		await expect(
			dispatchToolCommand(stateOf([failing]), "failing", { q: "x" }, "call-aborted-signal", controller.signal),
		).rejects.toThrow("interrupted");
	});

	it("refuses an eval-bridge call of a tool that must run directly", async () => {
		const executed: unknown[] = [];
		const state = stateOf([queryTool("checkpoint", executed)]);

		const bridged = await withEvalBridgeToolCall(state, () =>
			dispatchToolCommand(state, "checkpoint", { q: "x" }, "call-bridged"),
		);
		expect(bridged.result.isError).toBe(true);
		expect(bridged.dispatch.exitCode).toBe(1);
		expect(executed).toEqual([]);

		const direct = await dispatchToolCommand(state, "checkpoint", { q: "x" }, "call-direct");
		expect(direct.result.isError).toBeUndefined();
		expect(executed).toEqual([{ q: "x" }]);
	});
});

describe("toolCommandCallName", () => {
	it("names the tool command a bash call's line starts with", () => {
		expect(toolCommandCallName({ name: "bash", arguments: { command: "github pr_view --number 12" } })).toBe(
			"github",
		);
		expect(toolCommandCallName({ name: "bash", arguments: { command: '  resolve "looks right"' } })).toBe("resolve");
		expect(toolCommandCallName({ name: "bash", arguments: { command: "ast_edit|cat" } })).toBe("ast_edit");
	});

	it("returns undefined for other tools, shell-reserved words and malformed calls", () => {
		expect(toolCommandCallName({ name: "eval", arguments: { command: "github pr_view" } })).toBeUndefined();
		expect(toolCommandCallName({ name: "bash", arguments: { command: "echo github" } })).toBeUndefined();
		expect(toolCommandCallName({ name: "bash", arguments: { command: "" } })).toBeUndefined();
		expect(toolCommandCallName({ name: "bash", arguments: { command: 42 } })).toBeUndefined();
		expect(toolCommandCallName({ name: "bash", arguments: {} })).toBeUndefined();
		expect(toolCommandCallName({ name: "bash" })).toBeUndefined();
	});
});

describe("toolCommandDispatches", () => {
	const first: ToolCommandDispatch = { tool: "github", mode: "execute", exitCode: 0, args: { op: "pr_view" } };
	const second: ToolCommandDispatch = { tool: "ast_edit", mode: "help", exitCode: 0 };

	it("returns a bash result's records in invocation order", () => {
		expect(toolCommandDispatches("bash", { content: [], details: { toolCommands: [first, second] } })).toEqual([
			first,
			second,
		]);
	});

	it("returns nothing for other tools", () => {
		expect(toolCommandDispatches("write", { content: [], details: { toolCommands: [first] } })).toEqual([]);
	});

	it("drops malformed details and records", () => {
		expect(toolCommandDispatches("bash", undefined)).toEqual([]);
		expect(toolCommandDispatches("bash", "text")).toEqual([]);
		expect(toolCommandDispatches("bash", { content: [] })).toEqual([]);
		expect(toolCommandDispatches("bash", { details: { toolCommands: first } })).toEqual([]);
		expect(
			toolCommandDispatches("bash", {
				details: {
					toolCommands: [
						first,
						{ mode: "execute", exitCode: 0 },
						{ tool: "x", mode: "run", exitCode: 0 },
						{ tool: "x", mode: "execute", exitCode: "0" },
						{ tool: "x", mode: "execute", exitCode: 0, args: "op" },
						null,
					],
				},
			}),
		).toEqual([first]);
	});
});
