import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentEvent, AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { type BlockState, handleServerMessage, type ToolCallState } from "@oh-my-pi/pi-ai/providers/cursor";
import { buildPiLsResult, piTruncation } from "@oh-my-pi/pi-ai/providers/cursor/exec-modern";
import type { AssistantMessage } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import {
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	DeleteArgsSchema,
	ExecServerMessageSchema,
	McpArgsSchema,
	ReadArgsSchema,
	ShellArgsSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, fromBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CursorExecHandlers } from "@oh-my-pi/pi-coding-agent/cursor";
import {
	bridgeToolMap,
	createBridgeEditTool,
	createBridgeGrepFactory,
	cursorMcpPrefersReplaceEdit,
	normalizeCursorReplaceArgs,
} from "@oh-my-pi/pi-coding-agent/cursor-bridge-tools";

import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { BUILTIN_TOOLS, GrepTool, ReadTool, type Tool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import type { TruncationMeta } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { AdviseTool } from "../src/advisor/advise-tool";

function createTestSession(cwd: string, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

/**
 * An `ExtensionRunner` that intercepts nothing but records that it ran.
 *
 * The bridge's per-call tools must carry the same wrapper as registry tools;
 * seeing a name arrive here proves the wrapper is present, since an unwrapped
 * tool never announces.
 */
function passthroughRunner(seen: string[] = []): ExtensionRunner {
	return {
		hasHandlers: () => true,
		consumeToolCallEmitted: () => false,
		emitToolCall: async (event: { toolName: string }) => {
			seen.push(event.toolName);
			return undefined;
		},
		emitToolResult: async () => undefined,
	} as unknown as ExtensionRunner;
}

describe("CursorExecHandlers.grep bridge", () => {
	let cwd: string;
	let searchTool: GrepTool;
	let handlers: CursorExecHandlers;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-exec-test-"));
		await Bun.write(path.join(cwd, "sample.txt"), "Hello World\nhello world\n");
		searchTool = new GrepTool(createTestSession(cwd));
		handlers = new CursorExecHandlers({
			cwd,
			tools: new Map([["grep", searchTool as any]]),
		});
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	it("maps caseInsensitive parameter correctly through the grep bridge", async () => {
		// 1. By default/omitted caseInsensitive, should be case-sensitive (match count 1 for "hello")
		const defaultResult = await handlers.grep({
			toolCallId: "call-1",
			path: cwd,
			pattern: "hello",
		} as any);
		expect((defaultResult.details as { matchCount?: number } | undefined)?.matchCount).toBe(1);

		// 2. If caseInsensitive: true, should be case-insensitive (match count 2 for "hello")
		const insensitiveResult = await handlers.grep({
			toolCallId: "call-2",
			path: cwd,
			pattern: "hello",
			caseInsensitive: true,
		} as any);
		expect((insensitiveResult.details as { matchCount?: number } | undefined)?.matchCount).toBe(2);

		// 3. If caseInsensitive: false, should be case-sensitive (match count 1 for "hello")
		const sensitiveResult = await handlers.grep({
			toolCallId: "call-3",
			path: cwd,
			pattern: "hello",
			caseInsensitive: false,
		} as any);
		expect((sensitiveResult.details as { matchCount?: number } | undefined)?.matchCount).toBe(1);
	});

	it("honors pi_grep's requested match limit against real files", async () => {
		// The frame's `limit` caps total surfaced matches. The model-facing schema
		// has no such parameter, so without a per-call tool the cap is dropped and
		// the search returns everything it found.
		await Bun.write(path.join(cwd, "many.txt"), Array.from({ length: 10 }, (_, i) => `needle ${i}`).join("\n"));
		const scopedHandlers = new CursorExecHandlers({
			cwd,
			tools: new Map<string, Tool>([["grep", searchTool]]),
			createGrepTool: options => new GrepTool(createTestSession(cwd), options),
		});

		const capped = await scopedHandlers.piGrep({
			toolCallId: "c1",
			args: { pattern: "needle", path: cwd, limit: 3 },
		} as never);
		expect((capped.details as { matchCount?: number } | undefined)?.matchCount).toBe(3);

		const uncapped = await scopedHandlers.piGrep({
			toolCallId: "c2",
			args: { pattern: "needle", path: cwd },
		} as never);
		expect((uncapped.details as { matchCount?: number } | undefined)?.matchCount).toBe(10);
	});

	it("honors pi_grep's requested context width against real files", async () => {
		// `context` has no schema parameter either: the width is read from
		// settings fixed at tool construction, so the frame's value only lands
		// through a per-call instance.
		await Bun.write(path.join(cwd, "ctx.txt"), "before line\nneedle here\nafter line\n");
		const scopedHandlers = new CursorExecHandlers({
			cwd,
			tools: new Map<string, Tool>([["grep", searchTool]]),
			createGrepTool: options => new GrepTool(createTestSession(cwd), options),
		});

		const noContext = await scopedHandlers.piGrep({
			toolCallId: "c1",
			args: { pattern: "needle here", path: path.join(cwd, "ctx.txt"), context: 0 },
		} as never);
		const noContextText = noContext.content.map(c => (c.type === "text" ? c.text : "")).join("");
		expect(noContextText).not.toContain("before line");
		expect(noContextText).not.toContain("after line");

		const withContext = await scopedHandlers.piGrep({
			toolCallId: "c2",
			args: { pattern: "needle here", path: path.join(cwd, "ctx.txt"), context: 1 },
		} as never);
		const withContextText = withContext.content.map(c => (c.type === "text" ? c.text : "")).join("");
		expect(withContextText).toContain("before line");
		expect(withContextText).toContain("after line");
	});

	it("satisfies a pi_grep limit that spans more files than one page", async () => {
		// The local tool windows results to the first 20 files and tells the
		// caller to paginate with `skip`. `PiGrepExecArgs` has no `skip` field,
		// so a frame asking for 100 matches across 25 one-match files would get
		// 20, no `match_limit_reached`, and advice it cannot act on — output
		// silently short of what it asked for and labelled complete.
		const spread = path.join(cwd, "spread");
		await fs.mkdir(spread, { recursive: true });
		await Promise.all(
			Array.from({ length: 25 }, (_, i) => Bun.write(path.join(spread, `f${i}.txt`), "needle here\n")),
		);
		const scopedHandlers = new CursorExecHandlers({
			cwd,
			tools: new Map<string, Tool>([["grep", searchTool]]),
			createGrepTool: options => new GrepTool(createTestSession(cwd), options),
		});

		const wide = await scopedHandlers.piGrep({
			toolCallId: "c1",
			args: { pattern: "needle", path: spread, limit: 100 },
		} as never);
		const details = wide.details as { matchCount?: number; fileLimitReached?: number } | undefined;
		expect(details?.matchCount).toBe(25);
		// Nothing was clipped, so no pagination advice the frame cannot follow.
		expect(details?.fileLimitReached).toBeUndefined();

		// The cap still binds when the matches really do exceed it, and says so:
		// `match_limit_reached` is the frame's only signal that output was cut,
		// and one match per file makes the boundary sharp — a cap of 24 over 25
		// files is clipped, a cap of 25 is complete. Reading only `cap` files
		// cannot tell those apart.
		const capped = await scopedHandlers.piGrep({
			toolCallId: "c2",
			args: { pattern: "needle", path: spread, limit: 24 },
		} as never);
		const cappedDetails = capped.details as { matchCount?: number; perFileLimitReached?: number } | undefined;
		expect(cappedDetails?.matchCount).toBe(24);
		expect(cappedDetails?.perFileLimitReached).toBe(24);

		// Exactly at the cap is complete, not clipped.
		const exact = await scopedHandlers.piGrep({
			toolCallId: "c3",
			args: { pattern: "needle", path: spread, limit: 25 },
		} as never);
		const exactDetails = exact.details as { matchCount?: number; perFileLimitReached?: number } | undefined;
		expect(exactDetails?.matchCount).toBe(25);
		expect(exactDetails?.perFileLimitReached).toBeUndefined();
	});
});

describe("pi_bash truncation reaches the wire from a real BashTool result", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-pibash-trunc-"));
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	it("translates the metadata BashTool actually emits, not a hand-built shape", async () => {
		// Producer/consumer contract. `piTruncation` lives in `pi-ai`, which
		// cannot import `BashTool`, so every test there must hand-build the
		// details bag — and a bag built from the same assumption as the code
		// stays green when `BashTool`'s real shape moves. This runs the actual
		// tool and feeds its actual output to the actual translator.
		const bash = new BashTool(createTestSession(cwd));
		const result = await bash.execute("t1", { command: "seq 1 200000" });

		// Guard the assumption the bridge encodes: Bash files truncation under
		// `details.meta.truncation`, and that record carries no `truncated`
		// flag. If either moves, this fails here rather than silently sending
		// clipped output to Cursor with no truncation notice.
		// `TruncationMeta` is the producer's own type: if a field this bridge
		// reads is renamed or dropped, this stops compiling.
		const details = result.details as { truncation?: unknown; meta?: { truncation?: TruncationMeta } };
		expect(details.truncation).toBeUndefined();
		expect(details.meta?.truncation).toBeDefined();
		expect(details.meta?.truncation).not.toHaveProperty("truncated");

		const wire = piTruncation({
			role: "toolResult",
			toolCallId: "t1",
			toolName: "bash",
			content: result.content,
			isError: false,
			timestamp: Date.now(),
			details: result.details,
		});

		expect(wire?.truncated).toBe(true);
		expect(wire?.totalLines).toBe(details.meta?.truncation?.totalLines);
		expect(wire?.outputBytes).toBe(details.meta?.truncation?.outputBytes);
		expect(wire?.truncatedBy).toBe(details.meta?.truncation?.truncatedBy);
	});

	it("reports the entry cap ReadTool actually records for a large listing", async () => {
		// Same producer/consumer contract for the listing cap. `glob` records it
		// twice — a flat `details.resultLimitReached` and the structured meta —
		// but `read`, which serves `pi_ls`, records it only through `OutputMeta`.
		// Reading just the flat field dropped `entry_limit_reached` for every
		// real listing, so Cursor got clipped output with no signal it was cut.
		//
		// The root listing is uncapped; the depth-2 tree caps each child
		// directory, so the entries have to sit one level down to trip it.
		const listing = path.join(cwd, "many");
		const child = path.join(listing, "child");
		await fs.mkdir(child, { recursive: true });
		await Promise.all(Array.from({ length: 40 }, (_, i) => Bun.write(path.join(child, `f${i}.txt`), "x")));
		const read = new ReadTool(createTestSession(cwd));
		const result = await read.execute("l1", { path: listing });

		// Guard the assumption the bridge encodes: the cap lives in the nested
		// meta and nowhere flat. If the producer's shape moves, this fails here
		// rather than silently sending a clipped listing as if it were whole.
		const details = result.details as {
			resultLimitReached?: number;
			meta?: { limits?: { resultLimit?: { reached: number } } };
		};
		expect(details.resultLimitReached).toBeUndefined();
		expect(details.meta?.limits?.resultLimit?.reached).toBeGreaterThan(0);

		const wire = buildPiLsResult({
			role: "toolResult",
			toolCallId: "l1",
			toolName: "read",
			content: result.content,
			isError: false,
			timestamp: Date.now(),
			details: result.details,
		});
		if (wire.result.case !== "success") throw new Error(`expected success, got ${wire.result.case}`);
		expect(wire.result.value.entryLimitReached).toBeGreaterThan(0);
	});

	it("sends no truncation summary for output that fit", async () => {
		const bash = new BashTool(createTestSession(cwd));
		const result = await bash.execute("t2", { command: "echo hi" });
		const wire = piTruncation({
			role: "toolResult",
			toolCallId: "t2",
			toolName: "bash",
			content: result.content,
			isError: false,
			timestamp: Date.now(),
			details: result.details,
		});
		expect(wire).toBeUndefined();
	});
});

describe("bridge tool resolution beyond the model-facing registry", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-bridge-resolve-"));
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	it("edits a real file from a pi_edit frame when `edit` is withheld from the model", async () => {
		// A restricted roster omits `edit`. Native `pi_edit` still arrives, so
		// the bridge must reach a real replace-mode tool through
		// `getEditReplaceTool` — otherwise every modern edit answers
		// `Tool "edit" not available` and the file is untouched.
		// (Not the `getTool` fallback: that resolver also serves the agent
		// loop's unadvertised calls, so it stays device-only.)

		const target = path.join(cwd, "sample.txt");
		await Bun.write(target, "alpha\nbeta\n");
		// Build it exactly as the session does. Both bridge callsites go through
		// this factory, so a regression in it — the wrong mode, a missing
		// approval wrapper — fails here rather than passing against a
		// hand-constructed stand-in.
		const editTool = createBridgeEditTool(createTestSession(cwd), passthroughRunner());

		const withheld = new CursorExecHandlers({
			cwd,
			tools: new Map<string, Tool>(),
			getEditReplaceTool: () => editTool,
		});
		const result = await withheld.piEdit({
			toolCallId: "e1",
			args: { path: target, edits: [{ oldText: "beta", newText: "gamma" }] },
		} as never);

		expect(result.isError).toBeFalsy();
		expect(await Bun.file(target).text()).toBe("alpha\ngamma\n");
	});

	it("reports the failure instead of editing when no edit tool is reachable", async () => {
		const target = path.join(cwd, "sample.txt");
		await Bun.write(target, "alpha\nbeta\n");
		const unreachable = new CursorExecHandlers({ cwd, tools: new Map<string, Tool>() });
		const result = await unreachable.piEdit({
			toolCallId: "e2",
			args: { path: target, edits: [{ oldText: "beta", newText: "gamma" }] },
		} as never);

		expect(result.isError).toBe(true);
		expect(await Bun.file(target).text()).toBe("alpha\nbeta\n");
	});

	it("substitutes a replace-mode edit into a granted advisor tool map", async () => {
		// The advisor roster hands the bridge the instances it built for the
		// advisor's own loop — default `hashline` mode, whose schema is a single
		// `input` string. A `pi_edit` frame's `old_string`/`new_string` args fail
		// substitution the advisor path applies before constructing handlers.
		const target = path.join(cwd, "sample.txt");
		await Bun.write(target, "alpha\nbeta\n");
		const session = createTestSession(cwd);
		const advisorEdit = new EditTool(session);
		expect(advisorEdit.mode).not.toBe("replace");
		const granted = new Map<string, Tool>([["edit", advisorEdit]]);

		const bridged = bridgeToolMap(granted, () => createBridgeEditTool(session, passthroughRunner()));
		const handlers = new CursorExecHandlers({ cwd, tools: bridged });
		const result = await handlers.piEdit({
			toolCallId: "e3",
			args: { path: target, edits: [{ oldText: "beta", newText: "gamma" }] },
		} as never);

		expect(result.isError).toBeFalsy();
		expect(await Bun.file(target).text()).toBe("alpha\ngamma\n");
		// The advisor's own loop must keep the exact instance it was handed.
		expect(granted.get("edit")).toBe(advisorEdit);
	});

	it("runs the replace-mode instance even when the registry still holds another mode", async () => {
		// Hashline `edit` stays advertised as MCP. `executeTool` prefers the map
		// over the `getTool` fallback, so without an explicit replace-mode
		// accessor every native `pi_edit` fails validation against the hashline
		// schema.

		const target = path.join(cwd, "sample.txt");
		await Bun.write(target, "alpha\nbeta\n");
		const session = createTestSession(cwd);
		const configuredEdit = new EditTool(session);
		expect(configuredEdit.mode).not.toBe("replace");

		const handlers = new CursorExecHandlers({
			cwd,
			tools: new Map<string, Tool>([["edit", configuredEdit]]),
			getEditReplaceTool: () => createBridgeEditTool(session, passthroughRunner()),
		});
		const result = await handlers.piEdit({
			toolCallId: "e5",
			args: { path: target, edits: [{ oldText: "beta", newText: "gamma" }] },
		} as never);

		expect(result.isError).toBeFalsy();
		expect(await Bun.file(target).text()).toBe("alpha\ngamma\n");
	});

	it("still refuses a pi_edit frame when the session granted no edit tool", async () => {
		// The accessor carries the grant: a restricted roster returns undefined
		// from it, and no other resolution path may substitute a mutating tool
		// (issue #5680). Building the instance provider-independently must not
		// weaken that.
		const target = path.join(cwd, "sample.txt");
		await Bun.write(target, "alpha\nbeta\n");
		const handlers = new CursorExecHandlers({
			cwd,
			tools: new Map<string, Tool>(),
			getEditReplaceTool: () => undefined,
		});
		const result = await handlers.piEdit({
			toolCallId: "e6",
			args: { path: target, edits: [{ oldText: "beta", newText: "gamma" }] },
		} as never);

		expect(result.isError).toBe(true);
		expect(await Bun.file(target).text()).toBe("alpha\nbeta\n");
	});

	it("leaves an ungranted tool map without an edit tool", async () => {
		// The bridge tool is constructed, not looked up, so substituting for a
		// roster that was never granted `edit` would hand a read-only advisor a
		// mutating tool (issue #5680). The frame must fail instead.
		const target = path.join(cwd, "sample.txt");
		await Bun.write(target, "alpha\nbeta\n");
		const session = createTestSession(cwd);
		let built = 0;
		const withheld = bridgeToolMap(new Map<string, Tool>(), () => {
			built++;
			return createBridgeEditTool(session, passthroughRunner());
		});
		expect(withheld.has("edit")).toBe(false);
		expect(built).toBe(0);

		const handlers = new CursorExecHandlers({ cwd, tools: withheld });
		const result = await handlers.piEdit({
			toolCallId: "e4",
			args: { path: target, edits: [{ oldText: "beta", newText: "gamma" }] },
		} as never);

		expect(result.isError).toBe(true);
		expect(await Bun.file(target).text()).toBe("alpha\nbeta\n");
	});

	it("refuses a scoped pi_grep when no grep tool was granted", async () => {
		// The factory builds a fresh tool and `executeTool` prefers that override
		// over the registry, so a session that withheld `grep` must not install
		// one — otherwise a frame carrying `context`/`limit` searches anyway.
		await Bun.write(path.join(cwd, "hit.txt"), "needle\n");
		const denied = new CursorExecHandlers({ cwd, tools: new Map<string, Tool>() });
		const result = await denied.piGrep({
			toolCallId: "g0",
			args: { pattern: "needle", path: cwd, limit: 5 },
		} as never);

		expect(result.isError).toBe(true);
		expect(result.content.map(c => (c.type === "text" ? c.text : "")).join("")).toContain("not available");
	});

	it("denies a native pi_edit frame the user's policy blocks", async () => {
		// The bridge's `edit` is wrapped, but `ExtensionToolWrapper` reads the
		// approval mode and per-tool policies only from the execute-time
		// context — with none it resolves as `yolo` with empty policies and the
		// frame edits the file regardless of what the user configured.
		const target = path.join(cwd, "denied.txt");
		await Bun.write(target, "alpha\nbeta\n");
		const settings = Settings.isolated({ "tools.approval": { edit: "deny" } });
		const session = createTestSession(cwd, { settings });
		const handlers = new CursorExecHandlers({
			cwd,
			tools: bridgeToolMap(new Map<string, Tool>([["edit", new EditTool(session)]]), () =>
				createBridgeEditTool(session, passthroughRunner()),
			),
			getToolContext: () => ({ settings }) as AgentToolContext,
		});

		const result = await handlers.piEdit({
			toolCallId: "e5",
			args: { path: target, edits: [{ oldText: "beta", newText: "gamma" }] },
		} as never);

		expect(result.isError).toBe(true);
		expect(await Bun.file(target).text()).toBe("alpha\nbeta\n");
	});

	it("denies a scoped pi_grep frame the user's policy blocks", async () => {
		// Same gate on the other bridge-only tool: the per-call `grep` the
		// factory builds for a frame carrying `context`/`limit` must answer to
		// `tools.approval.grep` like every registry call.
		await Bun.write(path.join(cwd, "hit.txt"), "needle\n");
		const settings = Settings.isolated({ "tools.approval": { grep: "deny" } });
		const session = createTestSession(cwd, { settings });
		const handlers = new CursorExecHandlers({
			cwd,
			tools: new Map<string, Tool>(),
			createGrepTool: createBridgeGrepFactory(session, passthroughRunner()),
			getToolContext: () => ({ settings }) as AgentToolContext,
		});

		const result = await handlers.piGrep({
			toolCallId: "g2",
			args: { pattern: "needle", path: cwd, context: 1, limit: 5 },
		} as never);

		expect(result.isError).toBe(true);
		expect(result.content.map(c => (c.type === "text" ? c.text : "")).join("")).toContain("blocked by user policy");
	});

	it("wraps the per-call grep the real bridge factory builds", async () => {
		// The reviewed bypass was in the factory the session hands the bridge,
		// not in the bridge: a raw `new GrepTool(...)` there skips the approval
		// gate every registry tool goes through. Exercise the shared factory
		// both callsites use, so a regression in it fails here.
		await Bun.write(path.join(cwd, "hit.txt"), "needle\n");
		const intercepted: string[] = [];
		const factory = createBridgeGrepFactory(createTestSession(cwd), passthroughRunner(intercepted));
		const built = factory({ context: 0, totalMatchLimit: 5 });
		expect(built).toBeInstanceOf(ExtensionToolWrapper);

		const handlers = new CursorExecHandlers({
			cwd,
			tools: new Map<string, Tool>(),
			createGrepTool: factory,
		});
		const result = await handlers.piGrep({
			toolCallId: "g1",
			args: { pattern: "needle", path: cwd, limit: 5 },
		} as never);

		// The wrapper ran (its extension hook fired) and the frame's cap still
		// reached the underlying tool.
		expect(intercepted).toEqual(["grep"]);
		expect((result.details as { matchCount?: number } | undefined)?.matchCount).toBe(1);
	});

	it("denies a pi_write frame the user's policy blocks when the tool came from the caller's map", async () => {
		// The advisor hands the bridge its own tool map. Those instances are run
		// directly by `piWrite`/`piBash`, so an unwrapped one executes whatever
		// the frame asks regardless of `tools.approval.<tool>` — supplying
		// `getToolContext` alone does not gate anything, because the gate lives
		// in `ExtensionToolWrapper`, not in the bridge.
		const settings = Settings.isolated({ "tools.approval": { write: "deny" } });
		const session = createTestSession(cwd, { settings });
		const writeTool = await BUILTIN_TOOLS.write(session);
		if (!writeTool) throw new Error("expected a write tool");
		const handlers = new CursorExecHandlers({
			cwd,
			tools: new Map<string, Tool>([["write", new ExtensionToolWrapper(writeTool, passthroughRunner())]]),
			getToolContext: () => ({ settings }) as AgentToolContext,
		});

		const target = path.join(cwd, "denied-write.txt");
		const result = await handlers.piWrite({
			toolCallId: "w1",
			args: { path: target, content: "written" },
		} as never);

		expect(result.isError).toBe(true);
		expect(await Bun.file(target).exists()).toBe(false);
	});
});

describe("Cursor MCP StrReplace fallback", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-mcp-strreplace-"));
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	it("projects CLI and Pi replacement fields onto replace kwargs", () => {
		expect(
			normalizeCursorReplaceArgs({ path: "/tmp/n.txt", old_text: "a", new_text: "b", replaceAll: true }),
		).toEqual({ path: "/tmp/n.txt", old_string: "a", new_string: "b", replace_all: true });
		expect(normalizeCursorReplaceArgs({ path: "/tmp/n.txt", input: "[n]" })).toEqual({
			path: "/tmp/n.txt",
			input: "[n]",
		});
	});

	it("routes injected CLI names and replace-shaped edit onto the bridge", () => {
		expect(cursorMcpPrefersReplaceEdit("StrReplace", { path: "a", old_string: "x", new_string: "y" })).toBe(true);
		expect(cursorMcpPrefersReplaceEdit("Edit", { path: "a", old_text: "x", new_text: "y" })).toBe(true);
		expect(cursorMcpPrefersReplaceEdit("edit", { path: "a", old_string: "x", new_string: "y" })).toBe(true);
		expect(cursorMcpPrefersReplaceEdit("edit", { input: "[a#0000]\nPUT 1.=1:\n+x\n" })).toBe(false);
		expect(cursorMcpPrefersReplaceEdit("write", { path: "a", old_string: "x", new_string: "y" })).toBe(false);
	});

	it("edits a file when the server-injected StrReplace name arrives as MCP", async () => {
		const target = path.join(cwd, "note.txt");
		await Bun.write(target, "alpha\nbeta\n");
		const session = createTestSession(cwd);
		const handlers = new CursorExecHandlers({
			cwd,
			tools: new Map<string, Tool>([["edit", new EditTool(session)]]),
			getEditReplaceTool: () => createBridgeEditTool(session, passthroughRunner()),
		});

		const result = await handlers.mcp({
			name: "StrReplace",
			providerIdentifier: "cursor",
			toolName: "StrReplace",
			toolCallId: "sr1",
			args: { path: target, old_string: "beta", new_string: "gamma" },
			rawArgs: {},
		});

		expect(await Bun.file(target).text()).toBe("alpha\ngamma\n");
		expect(result.content.map(part => (part.type === "text" ? part.text : "")).join("")).not.toMatch(
			/not found|not available/i,
		);
	});

	it("runs replace-mode when advertised hashline edit is called with old_string", async () => {
		const target = path.join(cwd, "note.txt");
		await Bun.write(target, "alpha\nbeta\n");
		const session = createTestSession(cwd);
		const hashline = new EditTool(session);
		expect(hashline.mode).not.toBe("replace");
		const handlers = new CursorExecHandlers({
			cwd,
			tools: new Map<string, Tool>([["edit", hashline]]),
			getEditReplaceTool: () => createBridgeEditTool(session, passthroughRunner()),
		});

		const result = await handlers.mcp({
			name: "edit",
			providerIdentifier: "pi-agent",
			toolName: "edit",
			toolCallId: "e-mix",
			args: { path: target, old_text: "beta", new_text: "gamma" },
			rawArgs: {},
		});

		expect(await Bun.file(target).text()).toBe("alpha\ngamma\n");
		expect(result.content.map(part => (part.type === "text" ? part.text : "")).join("")).not.toMatch(
			/not found|not available/i,
		);
	});

	it("does not run replace-mode for a hashline edit payload", async () => {
		const session = createTestSession(cwd);
		let replaceBuilt = 0;
		const handlers = new CursorExecHandlers({
			cwd,
			tools: new Map<string, Tool>([["edit", new EditTool(session)]]),
			getEditReplaceTool: () => {
				replaceBuilt++;
				return createBridgeEditTool(session, passthroughRunner());
			},
		});

		await handlers.mcp({
			name: "edit",
			providerIdentifier: "pi-agent",
			toolName: "edit",
			toolCallId: "e-hl",
			args: { input: "[missing.txt]\nPUT 1.=1:\n+x\n" },
			rawArgs: {},
		});

		expect(replaceBuilt).toBe(0);
	});

	it("still 404s StrReplace when edit was not granted", async () => {
		const target = path.join(cwd, "note.txt");
		await Bun.write(target, "alpha\nbeta\n");
		const handlers = new CursorExecHandlers({
			cwd,
			tools: new Map<string, Tool>(),
			getEditReplaceTool: () => undefined,
		});

		const result = await handlers.mcp({
			name: "StrReplace",
			providerIdentifier: "cursor",
			toolName: "StrReplace",
			toolCallId: "sr-deny",
			args: { path: target, old_string: "beta", new_string: "gamma" },
			rawArgs: {},
		});

		expect(result.isError).toBe(true);
		expect(await Bun.file(target).text()).toBe("alpha\nbeta\n");
	});
});

describe("pi_bash timeout presence", () => {
	let cwd: string;
	let handlers: CursorExecHandlers;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-pibash-timeout-"));
		const bash: Tool = new BashTool(createTestSession(cwd));
		handlers = new CursorExecHandlers({ cwd, tools: new Map<string, Tool>([["bash", bash]]) });
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	it("disables the deadline for an explicit zero instead of applying the default", async () => {
		// `timeout` is `optional int32` and `bash` documents `0` as "disables
		// the command deadline". Folding a supplied `0` into `undefined` applies
		// the 300s default, killing the long-running command that asked not to
		// be killed.
		const disabled = await handlers.piBash({
			toolCallId: "b1",
			args: { command: "echo hi", timeout: 0 },
		} as never);
		const disabledDetails = disabled.details as { timeoutDisabled?: boolean; timeoutSeconds?: number };
		expect(disabledDetails.timeoutDisabled).toBe(true);
		expect(disabledDetails.timeoutSeconds).toBeUndefined();

		const defaulted = await handlers.piBash({
			toolCallId: "b2",
			args: { command: "echo hi" },
		} as never);
		const defaultedDetails = defaulted.details as { timeoutDisabled?: boolean; timeoutSeconds?: number };
		expect(defaultedDetails.timeoutDisabled).toBeUndefined();
		expect(defaultedDetails.timeoutSeconds).toBeGreaterThan(0);
	});

	it("passes a positive timeout through", async () => {
		const result = await handlers.piBash({
			toolCallId: "b3",
			args: { command: "echo hi", timeout: 42 },
		} as never);
		expect((result.details as { timeoutSeconds?: number }).timeoutSeconds).toBe(42);
	});

	it("falls back to the default for a negative timeout", async () => {
		// A negative has no local meaning. Passed through, `bash` clamps it to
		// its 1s floor — a command that dies almost immediately. Dropping it to
		// the default is the only sane reading, so assert the default rather
		// than merely "positive", which the clamp also satisfies.
		const negative = await handlers.piBash({
			toolCallId: "b4",
			args: { command: "echo hi", timeout: -5 },
		} as never);
		const omitted = await handlers.piBash({
			toolCallId: "b5",
			args: { command: "echo hi" },
		} as never);
		const negativeDetails = negative.details as { timeoutDisabled?: boolean; timeoutSeconds?: number };
		expect(negativeDetails.timeoutDisabled).toBeUndefined();
		expect(negativeDetails.timeoutSeconds).toBe((omitted.details as { timeoutSeconds?: number }).timeoutSeconds);
	});
});

describe("CursorExecHandlers error results", () => {
	const rewrittenErrorTool = (name: string): AgentTool => ({
		name,
		label: name,
		description: "returns a rewritten tool failure",
		parameters: type({}),
		execute: async () => ({
			content: [{ type: "text", text: "Enriched recovery guidance" }],
			details: { enriched: true },
			isError: true,
		}),
	});

	it("propagates returned isError through the standard exec bridge", async () => {
		const events: AgentEvent[] = [];
		const handlers = new CursorExecHandlers({
			cwd: ".",
			tools: new Map([["read", rewrittenErrorTool("read")]]),
			emitEvent: event => events.push(event),
		});

		const result = await handlers.read(create(ReadArgsSchema, { toolCallId: "call-read", path: "ignored" }));
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: "Enriched recovery guidance" }]);
		const end = events.find(event => event.type === "tool_execution_end");
		expect(end?.isError).toBe(true);
	});

	it("propagates returned isError through the shell stream bridge", async () => {
		const events: AgentEvent[] = [];
		const stdout: string[] = [];
		const handlers = new CursorExecHandlers({
			cwd: ".",
			tools: new Map([["bash", rewrittenErrorTool("bash")]]),
			emitEvent: event => events.push(event),
		});

		const result = await handlers.shellStream(
			create(ShellArgsSchema, { toolCallId: "call-shell", command: "ignored" }),
			{
				onStdout: data => stdout.push(data),
				onStderr: () => {},
			},
		);
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: "Enriched recovery guidance" }]);
		expect(stdout).toEqual(["Enriched recovery guidance"]);
		const end = events.find(event => event.type === "tool_execution_end");
		expect(end?.isError).toBe(true);
	});

	it("omits unset optional kwargs from shellStream start events and execute args", async () => {
		// shellStream bypasses executeTool(), so omitUndefinedArgs must be
		// applied here directly — otherwise absent cwd/timeout become
		// present-undefined and ArkType rejects the bash call.
		const events: AgentEvent[] = [];
		const executeArgs: Record<string, unknown>[] = [];
		const bashSchema = type({ command: "string", "cwd?": "string", "timeout?": "number" });
		const bashTool: AgentTool<typeof bashSchema> = {
			name: "bash",
			label: "bash",
			description: "records args",
			parameters: bashSchema,
			execute: async (_id, args) => {
				executeArgs.push({ ...args });
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		const handlers = new CursorExecHandlers({
			cwd: ".",
			tools: new Map([["bash", bashTool]]),
			emitEvent: event => events.push(event),
		});

		await handlers.shellStream(
			create(ShellArgsSchema, {
				toolCallId: "call-shell-omit",
				command: "echo hi",
				// Proto string defaults to ""; the bridge maps that to undefined.
				workingDirectory: "",
			}),
			{ onStdout: () => {}, onStderr: () => {} },
		);

		const start = events.find(event => event.type === "tool_execution_start");
		expect(start?.type).toBe("tool_execution_start");
		if (start?.type !== "tool_execution_start") throw new Error("expected tool_execution_start");
		expect(start.args).toEqual({ command: "echo hi" });
		expect(Object.hasOwn(start.args, "cwd")).toBe(false);
		expect(Object.hasOwn(start.args, "timeout")).toBe(false);
		expect(executeArgs).toHaveLength(1);
		expect(executeArgs[0]).toEqual({ command: "echo hi" });
		expect(Object.hasOwn(executeArgs[0]!, "cwd")).toBe(false);
		expect(Object.hasOwn(executeArgs[0]!, "timeout")).toBe(false);

		executeArgs.length = 0;
		events.length = 0;
		await handlers.shellStream(
			create(ShellArgsSchema, {
				toolCallId: "call-shell-keep",
				command: "pwd",
				workingDirectory: "/tmp",
				timeout: 12,
			}),
			{ onStdout: () => {}, onStderr: () => {} },
		);
		const keepStart = events.find(event => event.type === "tool_execution_start");
		expect(keepStart?.type).toBe("tool_execution_start");
		if (keepStart?.type !== "tool_execution_start") throw new Error("expected tool_execution_start");
		expect(keepStart.args).toEqual({ command: "pwd", cwd: "/tmp", timeout: 12 });
		expect(executeArgs[0]).toEqual({ command: "pwd", cwd: "/tmp", timeout: 12 });
	});
});

describe("CursorExecHandlers mounted tool bridge", () => {
	it("executes MCP tools resolved from the xd:// registry", async () => {
		const mountedTool: AgentTool = {
			name: "mcp__fixture_report",
			label: "Fixture Report",
			description: "reports a fixture result",
			parameters: type({}),
			async execute() {
				return { content: [{ type: "text", text: "reported" }], details: {} };
			},
		};
		const handlers = new CursorExecHandlers({
			cwd: ".",
			tools: new Map([[mountedTool.name, mountedTool]]),
			getExecutableTool: name => (name === mountedTool.name ? mountedTool : undefined),
		});

		const result = await handlers.mcp({
			name: mountedTool.name,
			providerIdentifier: "pi-agent",
			toolName: mountedTool.name,
			toolCallId: "call-mounted",
			args: {},
			rawArgs: {},
		});

		expect(result.isError).toBe(false);
		expect(result.content).toEqual([{ type: "text", text: "reported" }]);
	});

	it("routes wrapped mounted devices through the approval gate", async () => {
		let executed = false;
		const device: AgentTool = {
			name: "ast_edit",
			label: "AST Edit",
			description: "structural edit device",
			parameters: type({}),
			async execute() {
				executed = true;
				return { content: [{ type: "text", text: "edited" }], details: {} };
			},
		};
		// The deny path throws inside resolveApproval before any handler runs;
		// the stub only needs the loop-emission marker probe the wrapper always
		// consults first.
		const wrapped = new ExtensionToolWrapper(device, {
			consumeToolCallEmitted: () => false,
		} as unknown as ExtensionRunner);
		const settings = Settings.isolated({ "tools.approval": { ast_edit: "deny" } });
		const handlers = new CursorExecHandlers({
			cwd: ".",
			// The canonical map contains the undecorated mounted tool. The execution
			// override must win or Cursor bypasses the approval gate.
			tools: new Map([[device.name, device]]),
			getExecutableTool: name => (name === device.name ? (wrapped as unknown as AgentTool) : undefined),
			getToolContext: () => ({ settings }) as AgentToolContext,
		});

		const result = await handlers.mcp({
			name: device.name,
			providerIdentifier: "pi-agent",
			toolName: device.name,
			toolCallId: "call-denied",
			args: {},
			rawArgs: {},
		});

		expect(result.isError).toBe(true);
		expect(executed).toBe(false);
		expect(result.content.find(block => block.type === "text")?.text).toContain("blocked by user policy");
	});

	it("lists resources from the session's live MCP servers", async () => {
		// The provider used to answer an empty catalog unconditionally, hiding
		// resources the session holds live connections to. Every entry must
		// carry the server name, since that is how Cursor addresses the read.
		const handlers = new CursorExecHandlers({
			cwd: ".",
			tools: new Map(),
			mcpResources: {
				serverNames: () => ["docs", "issues"],
				getServerResources: async name =>
					name === "docs"
						? { resources: [{ uri: "docs://readme", name: "README", mimeType: "text/markdown" }] }
						: { resources: [{ uri: "issues://open" }] },
				readServerResource: async () => undefined,
			},
		});

		expect(await handlers.listMcpResources({})).toEqual([
			{ uri: "docs://readme", name: "README", description: undefined, mimeType: "text/markdown", server: "docs" },
			{ uri: "issues://open", name: undefined, description: undefined, mimeType: undefined, server: "issues" },
		]);
		// A server filter narrows to that server alone.
		expect((await handlers.listMcpResources({ server: "issues" })).map(r => r.uri)).toEqual(["issues://open"]);
	});

	it("waits for a server's catalog instead of reporting it empty", async () => {
		// A server registers its tools before its resource catalog finishes
		// loading. A frame landing in that window must not read the empty cache
		// and answer "this server advertises nothing" - that is a lie the model
		// cannot distinguish from the truth, and it will not ask again.
		// The load is gated on a promise this test resolves, so "did the listing
		// wait" is answered by the gate rather than by a duration.
		const discovery = Promise.withResolvers<void>();
		let loaded = false;
		const handlers = new CursorExecHandlers({
			cwd: ".",
			tools: new Map(),
			mcpResources: {
				serverNames: () => ["slow"],
				getServerResources: async () => {
					await discovery.promise;
					loaded = true;
					return { resources: [{ uri: "slow://ready" }] };
				},
				readServerResource: async () => undefined,
			},
		});

		const listing = handlers.listMcpResources({});
		// Nothing can have been reported yet: the catalog has not arrived.
		expect(loaded).toBe(false);
		discovery.resolve();
		expect((await listing).map(r => r.uri)).toEqual(["slow://ready"]);
		expect(loaded).toBe(true);
	});

	it("labels a mixed-content read with the mime type of the part it sends", async () => {
		// An image blob followed by a text note: the wire carries one payload,
		// and its mime type has to describe that payload rather than whichever
		// item happened to come first, or the model is told plain text is a PNG.
		const handlers = new CursorExecHandlers({
			cwd: ".",
			tools: new Map(),
			mcpResources: {
				serverNames: () => ["files"],
				getServerResources: async () => undefined,
				readServerResource: async (_name, uri) => ({
					contents: [
						{ uri, mimeType: "image/png", blob: Buffer.from("PNG-BYTES").toString("base64") },
						{ uri, mimeType: "text/plain", text: "a note about the image" },
					],
				}),
			},
		});

		const read = await handlers.readMcpResource({ server: "files", uri: "files://mixed" });
		expect(read?.text).toBe("a note about the image");
		expect(read?.mimeType).toBe("text/plain");
	});

	it("reads a resource and decodes a blob payload into wire bytes", async () => {
		// MCP hands back a list of content items with base64 blobs; the wire
		// carries one text or one byte payload.
		const handlers = new CursorExecHandlers({
			cwd: ".",
			tools: new Map(),
			mcpResources: {
				serverNames: () => ["files"],
				getServerResources: async () => undefined,
				readServerResource: async (name, uri) =>
					name === "files" && uri === "files://logo"
						? { contents: [{ uri, mimeType: "image/png", blob: Buffer.from("PNG").toString("base64") }] }
						: undefined,
			},
		});

		const read = await handlers.readMcpResource({ server: "files", uri: "files://logo" });
		expect(read?.mimeType).toBe("image/png");
		expect(read?.blob && Buffer.from(read.blob).toString()).toBe("PNG");
		// An unknown uri is genuinely not found, not an error.
		expect(await handlers.readMcpResource({ server: "files", uri: "files://missing" })).toBeNull();
	});

	it("writes a download to the workspace path and returns no content", async () => {
		// The frame's `download_path` means "put it on disk, don't hand me the
		// bytes". Reporting success without creating the file leaves the model
		// pointing at nothing.
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-mcp-download-"));
		try {
			const handlers = new CursorExecHandlers({
				cwd: workspace,
				tools: new Map(),
				mcpResources: {
					serverNames: () => ["files"],
					getServerResources: async () => undefined,
					readServerResource: async (_name, uri) => ({
						contents: [{ uri, mimeType: "image/png", blob: Buffer.from("PNG-BYTES").toString("base64") }],
					}),
				},
			});

			const read = await handlers.readMcpResource({
				server: "files",
				uri: "files://logo",
				downloadPath: "assets/logo.png",
			});

			expect(read?.downloadPath).toBe("assets/logo.png");
			// No content: that is the whole point of the download mode.
			expect(read?.text).toBeUndefined();
			expect(read?.blob).toBeUndefined();
			// The file is really there, decoded from base64, under the workspace.
			expect(await Bun.file(path.join(workspace, "assets/logo.png")).text()).toBe("PNG-BYTES");
		} finally {
			await removeWithRetries(workspace);
		}
	});

	it("refuses a download path that escapes the workspace", async () => {
		// `download_path` is workspace-relative by contract, but it comes from
		// the server and the generic resolver honors absolute paths and `..` —
		// correct for a path a user typed, a write-anywhere primitive for one a
		// remote peer supplied.
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-mcp-escape-"));
		const outside = path.join(workspace, "outside.txt");
		try {
			const inner = path.join(workspace, "ws");
			await fs.mkdir(inner);
			const handlers = new CursorExecHandlers({
				cwd: inner,
				tools: new Map(),
				mcpResources: {
					serverNames: () => ["files"],
					getServerResources: async () => undefined,
					readServerResource: async (_name, uri) => ({ contents: [{ uri, text: "payload" }] }),
				},
			});

			for (const escapePath of ["../outside.txt", outside, "nested/../../outside.txt"]) {
				await expect(
					handlers.readMcpResource({ server: "files", uri: "files://x", downloadPath: escapePath }),
				).rejects.toThrow(/outside the workspace/);
			}
			// Nothing was written on any of those attempts.
			expect(await Bun.file(outside).exists()).toBe(false);
		} finally {
			await removeWithRetries(workspace);
		}
	});

	it("refuses a download path that escapes through a symlink", async () => {
		// A lexical check is not containment. `out/config` is relative and
		// `..`-free, but with `ws/out` linked outside the workspace the write
		// lands wherever the link points — as does a write to a dangling link,
		// including one that only reaches outside through a second hop.
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-mcp-symlink-"));
		try {
			const inner = path.join(workspace, "ws");
			const outside = path.join(workspace, "outside");
			await fs.mkdir(inner);
			await fs.mkdir(outside);
			await fs.symlink(outside, path.join(inner, "out"));
			await fs.symlink(path.join(outside, "dangling.txt"), path.join(inner, "link.txt"));
			// A link whose target already exists: the write would overwrite the
			// real file out there rather than create anything new.
			await Bun.write(path.join(outside, "existing.txt"), "original");
			await fs.symlink(path.join(outside, "existing.txt"), path.join(inner, "existing.txt"));
			// Two hops: the first link stays inside, so resolving one level reads
			// as contained while the write still follows the chain out.
			await fs.symlink(path.join(inner, "second.txt"), path.join(inner, "chain.txt"));
			await fs.symlink(path.join(outside, "chained.txt"), path.join(inner, "second.txt"));
			const handlers = new CursorExecHandlers({
				cwd: inner,
				tools: new Map(),
				mcpResources: {
					serverNames: () => ["files"],
					getServerResources: async () => undefined,
					readServerResource: async (_name, uri) => ({ contents: [{ uri, text: "payload" }] }),
				},
			});

			for (const escapePath of [
				"out/config",
				"out/deep/nested.txt",
				"link.txt",
				"existing.txt",
				"chain.txt",
				"second.txt",
			]) {
				await expect(
					handlers.readMcpResource({ server: "files", uri: "files://x", downloadPath: escapePath }),
				).rejects.toThrow(/outside the workspace/);
			}
			expect(await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: outside }))).toEqual(["existing.txt"]);
			expect(await Bun.file(path.join(outside, "existing.txt")).text()).toBe("original");

			// A real workspace path still downloads: the guard resolves links, it
			// does not refuse every path whose parents do not exist yet.
			await handlers.readMcpResource({ server: "files", uri: "files://x", downloadPath: "deep/new/file.txt" });
			expect(await Bun.file(path.join(inner, "deep/new/file.txt")).text()).toBe("payload");
		} finally {
			await removeWithRetries(workspace);
		}
	});

	it("overwrites an existing download target in place", async () => {
		// The download open is `O_NOFOLLOW`, which also drops the plain
		// `Bun.write` path — so the ordinary case has to keep working: a
		// re-download truncates the previous file rather than failing or
		// appending to it.
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-mcp-rewrite-"));
		try {
			let payload = "a much longer first payload";
			const handlers = new CursorExecHandlers({
				cwd: workspace,
				tools: new Map(),
				mcpResources: {
					serverNames: () => ["files"],
					getServerResources: async () => undefined,
					readServerResource: async (_name, uri) => ({ contents: [{ uri, text: payload }] }),
				},
			});

			await handlers.readMcpResource({ server: "files", uri: "files://x", downloadPath: "out/doc.txt" });
			payload = "second";
			await handlers.readMcpResource({ server: "files", uri: "files://x", downloadPath: "out/doc.txt" });

			expect(await Bun.file(path.join(workspace, "out/doc.txt")).text()).toBe("second");
		} finally {
			await removeWithRetries(workspace);
		}
	});

	it("refuses a download onto a hard link that shares its inode outside", async () => {
		// A hard link is a regular file that lives inside the workspace and
		// passes both containment and `O_NOFOLLOW`, yet writing through it
		// overwrites every other name for the same inode — including one out of
		// reach. Only the link count on the opened file reveals it.
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-mcp-hardlink-"));
		try {
			const inner = path.join(workspace, "ws");
			const outside = path.join(workspace, "outside");
			await fs.mkdir(inner);
			await fs.mkdir(outside);
			const victim = path.join(outside, "secret.txt");
			await Bun.write(victim, "SECRET");
			await fs.link(victim, path.join(inner, "innocent.txt"));
			const handlers = new CursorExecHandlers({
				cwd: inner,
				tools: new Map(),
				mcpResources: {
					serverNames: () => ["files"],
					getServerResources: async () => undefined,
					readServerResource: async (_name, uri) => ({ contents: [{ uri, text: "payload" }] }),
				},
			});

			await expect(
				handlers.readMcpResource({ server: "files", uri: "files://x", downloadPath: "innocent.txt" }),
			).rejects.toThrow(/hard links/);
			expect(await Bun.file(victim).text()).toBe("SECRET");
		} finally {
			await removeWithRetries(workspace);
		}
	});

	it("refuses a download onto a FIFO instead of blocking on it", async () => {
		// A write-only open of a FIFO blocks until a reader attaches, and
		// `download_path` comes from the server — so a named pipe planted (or
		// simply present) in the workspace hung the turn forever, with the
		// non-regular-file guard sitting unreachable behind the open. The refusal
		// has to come from the open itself, which is what `O_NONBLOCK` buys.
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-mcp-fifo-"));
		try {
			const fifo = path.join(workspace, "pipe");
			const mkfifo = Bun.spawn(["mkfifo", fifo]);
			if ((await mkfifo.exited) !== 0) throw new Error("mkfifo failed");
			const handlers = new CursorExecHandlers({
				cwd: workspace,
				tools: new Map(),
				mcpResources: {
					serverNames: () => ["files"],
					getServerResources: async () => undefined,
					readServerResource: async (_name, uri) => ({ contents: [{ uri, text: "payload" }] }),
				},
			});

			await expect(
				handlers.readMcpResource({ server: "files", uri: "files://x", downloadPath: "pipe" }),
			).rejects.toThrow(/special file|non-regular file/);
		} finally {
			await removeWithRetries(workspace);
		}
		// A regression does not fail this assertion — it never reaches it, because
		// the open never returns. The timeout IS the detector, raised off the 5s
		// default only so a slow runner cannot claim the same verdict.
	}, 20_000);

	it("refuses a download when the session withheld file mutation or policy denies it", async () => {
		// Download mode creates and overwrites workspace files without going
		// through a registry tool, so nothing else enforces the session's
		// mutation rules — the same hole the native `delete` frame had. A
		// channel that was never granted a file-writing tool, and a `write` tier
		// the user denied, must both stop it before the read, so a refused
		// download does not even fetch the resource.
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-mcp-grant-"));
		try {
			let reads = 0;
			const mcpResources = {
				serverNames: () => ["files"],
				getServerResources: async () => undefined,
				readServerResource: async (_name: string, uri: string) => {
					reads++;
					return { contents: [{ uri, text: "payload" }] };
				},
			};

			const ungranted = new CursorExecHandlers({
				cwd: workspace,
				tools: new Map(),
				allowDirectFileMutation: false,
				mcpResources,
			});
			await expect(
				ungranted.readMcpResource({ server: "files", uri: "files://x", downloadPath: "out.txt" }),
			).rejects.toThrow(/not available/);

			const denied = new CursorExecHandlers({
				cwd: workspace,
				tools: new Map(),
				mcpResources,
				getToolContext: () =>
					({ settings: Settings.isolated({ "tools.approval": { write: "deny" } }) }) as AgentToolContext,
			});
			await expect(
				denied.readMcpResource({ server: "files", uri: "files://x", downloadPath: "out.txt" }),
			).rejects.toThrow(/blocked by user policy/);

			expect(reads).toBe(0);
			expect(await Bun.file(path.join(workspace, "out.txt")).exists()).toBe(false);

			// A read without `download_path` mutates nothing, so it is unaffected.
			const read = await ungranted.readMcpResource({ server: "files", uri: "files://x" });
			expect(read?.text).toBe("payload");
			expect(reads).toBe(1);
		} finally {
			await removeWithRetries(workspace);
		}
	});

	it("answers nothing when the session has no MCP manager", async () => {
		// A host without MCP must still answer truthfully rather than throwing:
		// an empty catalog and `not_found` are the honest responses.
		const handlers = new CursorExecHandlers({ cwd: ".", tools: new Map() });
		expect(await handlers.listMcpResources({})).toEqual([]);
		expect(await handlers.readMcpResource({ server: "docs", uri: "docs://x" })).toBeNull();
	});
});

function cursorAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "cursor-agent",
		provider: "cursor",
		model: "gpt-5.6-sol-medium",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function newBlockState(): BlockState {
	let textBlock: BlockState["currentTextBlock"] = null;
	let thinkingBlock: BlockState["currentThinkingBlock"] = null;
	let toolCall: ToolCallState | null = null;
	return {
		get currentTextBlock() {
			return textBlock;
		},
		get currentThinkingBlock() {
			return thinkingBlock;
		},
		get currentToolCall() {
			return toolCall;
		},
		firstTokenTime: undefined,
		openToolCalls: new Map<string, ToolCallState>(),
		resolvedMcpToolCallIds: new Set<string>(),
		setTextBlock: b => {
			textBlock = b;
		},
		setThinkingBlock: b => {
			thinkingBlock = b;
		},
		setToolCall: t => {
			toolCall = t;
		},
		setFirstTokenTime: () => {},
	};
}

// Regression for issue #5680: the advisor's own tools run through the same
// Cursor exec bridge the primary agent uses. Without a bridge wired into the
// advisor Agent, the server's `mcpArgs` dispatch for `advise` comes back
// `toolNotFound` and no advice is ever routed. This drives the real provider
// dispatch to prove a bridge built over the advisor's tool set executes the
// `advise` MCP call and returns a success frame.
describe("CursorExecHandlers advise routing (issue #5680)", () => {
	function adviseServerMessage(note: string) {
		return create(AgentServerMessageSchema, {
			message: {
				case: "execServerMessage",
				value: create(ExecServerMessageSchema, {
					id: 1,
					execId: "exec-advise-1",
					message: {
						case: "mcpArgs",
						value: create(McpArgsSchema, {
							name: "advise",
							toolName: "advise",
							toolCallId: "call-advise-1",
							providerIdentifier: "pi-agent",
							args: { note: new TextEncoder().encode(JSON.stringify(note)) },
						}),
					},
				}),
			},
		});
	}

	function decodeMcpResultCase(chunk: unknown): string | undefined {
		const buf = chunk as Buffer;
		const client = fromBinary(AgentClientMessageSchema, buf.subarray(5));
		if (client.message.case !== "execClientMessage") return undefined;
		const exec = client.message.value;
		return exec.message.case === "mcpResult" ? exec.message.value.result.case : undefined;
	}

	it("executes the advise MCP call through the bridge and routes the note", async () => {
		const advised: Array<{ note: string; severity?: string }> = [];
		const adviseTool = new AdviseTool((note, severity) => advised.push({ note, severity }));
		const handlers = new CursorExecHandlers({
			cwd: ".",
			tools: new Map([["advise", adviseTool as unknown as AgentTool]]),
		});

		const output = cursorAssistantMessage();
		const stream = new AssistantMessageEventStream();
		const state = newBlockState();
		const written: unknown[] = [];
		const h2Request = {
			write: (chunk: unknown) => {
				written.push(chunk);
				return true;
			},
		} as unknown as Parameters<typeof handleServerMessage>[5];

		await handleServerMessage(
			adviseServerMessage("Consider the empty-input edge case"),
			output,
			stream,
			state,
			new Map(),
			h2Request,
			handlers,
			undefined,
			{ sawTokenDelta: false },
			[],
		);

		expect(advised).toEqual([{ note: "Consider the empty-input edge case", severity: undefined }]);
		expect(written.length).toBe(1);
		expect(decodeMcpResultCase(written[0])).toBe("success");
	});

	it("returns toolNotFound when no bridge is wired (the unfixed advisor path)", async () => {
		const output = cursorAssistantMessage();
		const stream = new AssistantMessageEventStream();
		const state = newBlockState();
		const written: unknown[] = [];
		const h2Request = {
			write: (chunk: unknown) => {
				written.push(chunk);
				return true;
			},
		} as unknown as Parameters<typeof handleServerMessage>[5];

		await handleServerMessage(
			adviseServerMessage("never delivered"),
			output,
			stream,
			state,
			new Map(),
			h2Request,
			undefined,
			undefined,
			{ sawTokenDelta: false },
			[],
		);

		expect(written.length).toBe(1);
		expect(decodeMcpResultCase(written[0])).toBe("toolNotFound");
	});
});

// Regression for the #5686 review: Cursor's native `delete` frame removes files
// directly (bypassing the tool map), so a read-only advisor that was granted no
// mutating tool must not be able to delete workspace files.
describe("CursorExecHandlers native delete gating (issue #5680)", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-delete-test-"));
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	it("rejects native delete and preserves the file when allowDirectFileMutation is false", async () => {
		const target = path.join(cwd, "victim.txt");
		await Bun.write(target, "keep me");
		const handlers = new CursorExecHandlers({
			cwd,
			tools: new Map(),
			allowDirectFileMutation: false,
		});

		const result = await handlers.delete(create(DeleteArgsSchema, { toolCallId: "call-del", path: target }));

		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: 'Tool "delete" not available' }]);
		expect(await Bun.file(target).exists()).toBe(true);
	});

	it("performs native delete when allowDirectFileMutation is true", async () => {
		const target = path.join(cwd, "victim.txt");
		await Bun.write(target, "remove me");
		const handlers = new CursorExecHandlers({
			cwd,
			tools: new Map(),
			allowDirectFileMutation: true,
		});

		const result = await handlers.delete(create(DeleteArgsSchema, { toolCallId: "call-del", path: target }));

		expect(result.isError).toBe(false);
		expect(await Bun.file(target).exists()).toBe(false);
	});

	it("rechecks a live mutation grant after runtime tool activation", async () => {
		const target = path.join(cwd, "victim.txt");
		await Bun.write(target, "remove after upgrade");
		let mutationGranted = false;
		const handlers = new CursorExecHandlers({
			cwd,
			tools: new Map(),
			allowDirectFileMutation: () => mutationGranted,
		});

		const denied = await handlers.delete(create(DeleteArgsSchema, { toolCallId: "call-del-denied", path: target }));
		expect(denied.isError).toBe(true);
		expect(await Bun.file(target).exists()).toBe(true);

		mutationGranted = true;
		const allowed = await handlers.delete(create(DeleteArgsSchema, { toolCallId: "call-del-allowed", path: target }));
		expect(allowed.isError).toBe(false);
		expect(await Bun.file(target).exists()).toBe(false);
	});

	it("resolves native deletes through the live cwd resolver", async () => {
		const movedCwd = path.join(cwd, "moved");
		await fs.mkdir(movedCwd);
		const originalTarget = path.join(cwd, "obsolete.txt");
		const movedTarget = path.join(movedCwd, "obsolete.txt");
		await Bun.write(originalTarget, "preserve me");
		await Bun.write(movedTarget, "remove me");
		let currentCwd = cwd;
		const handlers = new CursorExecHandlers({
			cwd,
			getCwd: () => currentCwd,
			tools: new Map(),
			allowDirectFileMutation: true,
		});

		currentCwd = movedCwd;
		const result = await handlers.delete(create(DeleteArgsSchema, { toolCallId: "call-del", path: "obsolete.txt" }));

		expect(result.isError).toBe(false);
		expect(await Bun.file(originalTarget).exists()).toBe(true);
		expect(await Bun.file(movedTarget).exists()).toBe(false);
	});

	it("refuses a native delete the user's policy blocks", async () => {
		// `allowDirectFileMutation` answers "was a mutating tool granted", not "does
		// policy allow this call". The frame removes the file with `fs.rmSync`
		// instead of running a registry tool, so no approval wrapper sits in
		// front of it — a configured `deny` still lost the file.
		const target = path.join(cwd, "protected.txt");
		await Bun.write(target, "keep me\n");
		const settings = Settings.isolated({ "tools.approval": { delete: "deny" } });
		const handlers = new CursorExecHandlers({
			cwd,
			tools: new Map(),
			allowDirectFileMutation: true,
			getToolContext: () => ({ settings }) as AgentToolContext,
		});

		const result = await handlers.delete(
			create(DeleteArgsSchema, { toolCallId: "call-deny", path: "protected.txt" }),
		);

		expect(result.isError).toBe(true);
		expect(await Bun.file(target).exists()).toBe(true);
	});

	it("refuses a native delete in always-ask mode, which has no prompt channel", async () => {
		// The exec channel cannot raise an interactive approval, so a mode that
		// demands one must fail closed rather than silently auto-approving.
		const target = path.join(cwd, "asked.txt");
		await Bun.write(target, "keep me\n");
		const settings = Settings.isolated({ "tools.approvalMode": "always-ask" });
		const handlers = new CursorExecHandlers({
			cwd,
			tools: new Map(),
			allowDirectFileMutation: true,
			getToolContext: () => ({ settings }) as AgentToolContext,
		});

		const result = await handlers.delete(create(DeleteArgsSchema, { toolCallId: "call-ask", path: "asked.txt" }));

		expect(result.isError).toBe(true);
		expect(await Bun.file(target).exists()).toBe(true);
	});
});

// A `smart_mode_approval_only` frame asks whether an MCP call would be allowed,
// ahead of the call itself. The verdict has to come from the same policy that
// gates execution — without running the tool to find out.
describe("CursorExecHandlers MCP approval preflight", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-preflight-test-"));
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	function mcpHandlers(settings: Settings): { handlers: CursorExecHandlers; executed: () => number } {
		let executed = 0;
		const tool: AgentTool = {
			name: "mcp__ops__deploy",
			label: "deploy",
			description: "",
			parameters: type({}),
			execute: async () => {
				executed += 1;
				return { content: [{ type: "text", text: "ran" }] };
			},
		} as unknown as AgentTool;
		const handlers = new CursorExecHandlers({
			cwd,
			tools: new Map([[tool.name, tool]]),
			getToolContext: () => ({ settings }) as AgentToolContext,
		});
		return { handlers, executed: () => executed };
	}

	const call = {
		name: "mcp__ops__deploy",
		toolName: "mcp__ops__deploy",
		toolCallId: "c1",
		providerIdentifier: "ops",
		args: {},
		rawArgs: {},
	};

	it("approves a call the policy allows, without running it", async () => {
		const { handlers, executed } = mcpHandlers(Settings.isolated({ "tools.approvalMode": "yolo" }));

		expect(await handlers.mcpApprovalPreflight(call)).toBe(true);
		// Approval is the answer; the invocation is a separate frame.
		expect(executed()).toBe(0);
	});

	it("refuses a call the user's policy denies", async () => {
		const { handlers, executed } = mcpHandlers(
			Settings.isolated({ "tools.approvalMode": "yolo", "tools.approval": { mcp__ops__deploy: "deny" } }),
		);

		// Approving here would launder the deny into a server-side blessing.
		expect(await handlers.mcpApprovalPreflight(call)).toBe(false);
		expect(executed()).toBe(0);
	});

	it("refuses when the policy demands a prompt this frame cannot raise", async () => {
		const { handlers } = mcpHandlers(Settings.isolated({ "tools.approvalMode": "always-ask" }));

		// The user is asked for real when the call arrives; answering yes on
		// their behalf pre-authorizes something they never saw.
		expect(await handlers.mcpApprovalPreflight(call)).toBe(false);
	});

	it("refuses a tool the session does not have", async () => {
		const { handlers } = mcpHandlers(Settings.isolated({ "tools.approvalMode": "yolo" }));

		expect(
			await handlers.mcpApprovalPreflight({ ...call, name: "mcp__ops__absent", toolName: "mcp__ops__absent" }),
		).toBe(false);
	});
});

// The Pi frames (`ExecServerMessage` 45-51) are a separate wire family from the
// legacy `read`/`shell`/`grep` args, with different field names and different
// semantics. Each bridge handler therefore performs a real translation, and a
// wrong one silently searches the wrong thing instead of failing.
describe("CursorExecHandlers Pi frame translation", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-pi-test-"));
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	/** Captures the args one local tool was invoked with. */
	function recordingHandlers(toolName: string): { handlers: CursorExecHandlers; calls: unknown[] } {
		const calls: unknown[] = [];
		const tool: AgentTool = {
			name: toolName,
			label: toolName,
			description: "records its args",
			parameters: type({}),
			execute: async (_toolCallId: string, params: unknown) => {
				calls.push(params);
				return { content: [{ type: "text" as const, text: "ok" }] };
			},
		};
		const handlers = new CursorExecHandlers({ cwd, tools: new Map([[toolName, tool]]) });
		return { handlers, calls };
	}

	it("inverts pi_grep's ignore_case into the local tool's case-sensitivity flag", async () => {
		// `ignore_case` and `case` are opposites. Passing the frame's value
		// straight through would flip every search's matching.
		const { handlers, calls } = recordingHandlers("grep");

		await handlers.piGrep({ toolCallId: "c1", args: { pattern: "x", ignoreCase: true } } as never);
		await handlers.piGrep({ toolCallId: "c2", args: { pattern: "x", ignoreCase: false } } as never);

		expect(calls).toEqual([
			{ pattern: "x", path: ".", case: false },
			// Case-sensitive is the local default, so `false` maps to unset —
			// the key is omitted rather than written as `case: undefined`.
			{ pattern: "x", path: "." },
		]);
	});

	it("folds pi_grep's separate glob onto the local tool's single path spec", async () => {
		const { handlers, calls } = recordingHandlers("grep");

		await handlers.piGrep({ toolCallId: "c1", args: { pattern: "x", path: "src", glob: "**/*.ts" } } as never);
		await handlers.piGrep({ toolCallId: "c2", args: { pattern: "x", glob: "**/*.ts" } } as never);
		await handlers.piGrep({ toolCallId: "c3", args: { pattern: "x", path: ".", glob: "**/*.ts" } } as never);
		await handlers.piGrep({ toolCallId: "c4", args: { pattern: "x", path: "src", glob: "/abs/**/*.ts" } } as never);

		expect((calls[0] as { path: string }).path).toBe("src/**/*.ts");
		// An absent or "." path leaves the glob standing alone: a "./"-prefixed
		// spec is a needlessly different path expression for the same scope.
		expect((calls[1] as { path: string }).path).toBe("**/*.ts");
		expect((calls[2] as { path: string }).path).toBe("**/*.ts");
		// An absolute glob ignores the frame's path entirely.
		expect((calls[3] as { path: string }).path).toBe("/abs/**/*.ts");
	});

	it("composes pi_read's offset/limit onto the path as the read tool's range selector", async () => {
		// `read` takes no range kwargs, so a dropped offset/limit silently returns
		// the whole file. `offset` is a 1-indexed start and `limit` a line count,
		// which is exactly the `:N+K` selector — `raw`, since a plain range pads
		// with context lines the frame never asked for.
		const { handlers, calls } = recordingHandlers("read");

		await handlers.piRead({ toolCallId: "c1", args: { path: "a.ts", offset: 5, limit: 20 } } as never);
		await handlers.piRead({ toolCallId: "c2", args: { path: "a.ts", offset: 5 } } as never);
		await handlers.piRead({ toolCallId: "c3", args: { path: "a.ts", limit: 20 } } as never);
		await handlers.piRead({ toolCallId: "c4", args: { path: "a.ts" } } as never);
		// `optional int32`: a present 0 offset is not "unset". The reference
		// clamps it to the first line rather than falling back to no range.
		await handlers.piRead({ toolCallId: "c5", args: { path: "a.ts", offset: 0, limit: 20 } } as never);

		expect(calls).toEqual([
			{ path: "a.ts:raw:5+20" },
			{ path: "a.ts:raw:5-" },
			{ path: "a.ts:raw:1+20" },
			{ path: "a.ts" },
			{ path: "a.ts:raw:1+20" },
		]);
	});

	it("answers a present pi_read limit of zero with empty output instead of the whole file", async () => {
		// `limit: 0` is present, not unset: the reference slices zero lines. No
		// `read` selector expresses an empty range, so treating it as unset would
		// return the entire file — the opposite of what was asked.
		const { handlers, calls } = recordingHandlers("read");

		const result = await handlers.piRead({ toolCallId: "c1", args: { path: "a.ts", limit: 0 } } as never);

		expect(calls).toEqual([]);
		expect(result.isError).toBe(false);
		expect(result.content).toEqual([{ type: "text", text: "" }]);
	});

	it("composes the legacy read frame's offset/limit the same way pi_read does", async () => {
		// Modern Cursor builds paginate the legacy `read` frame too. Dropping the
		// range returns the whole file for every page, so a model walking a large
		// file never advances past the first window.
		const { handlers, calls } = recordingHandlers("read");

		await handlers.read({ toolCallId: "c1", path: "a.ts", offset: 5, limit: 20 } as never);
		await handlers.read({ toolCallId: "c2", path: "a.ts" } as never);

		expect(calls).toEqual([{ path: "a.ts:raw:5+20" }, { path: "a.ts" }]);
	});

	it("forwards the legacy grep frame's offset as the local tool's file skip", async () => {
		// `grep` paginates by file and reports "use skip=N for the next page" in
		// that same unit. An unforwarded offset re-runs the identical search, so
		// every page after the first repeats page one.
		const { handlers, calls } = recordingHandlers("grep");

		await handlers.grep({ toolCallId: "c1", pattern: "x", path: "src", offset: 20 } as never);
		await handlers.grep({ toolCallId: "c2", pattern: "x", path: "src" } as never);
		// A present 0 is "start at the beginning", which is the unset search.
		await handlers.grep({ toolCallId: "c3", pattern: "x", path: "src", offset: 0 } as never);

		expect(calls.map(call => (call as { skip?: number }).skip)).toEqual([20, undefined, undefined]);
	});

	it("returns exactly the lines a pi_read range asked for", async () => {
		// Producer/consumer contract against the real `ReadTool`: a plain `:N+K`
		// selector deliberately pads with one leading and three trailing context
		// lines, so offset 5/limit 20 would hand Cursor lines 4-27 for a request
		// that named 5-24. The frame has no way to tell the padding apart from
		// content it asked for.
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-piread-range-"));
		try {
			await Bun.write(
				path.join(cwd, "n.txt"),
				`${Array.from({ length: 40 }, (_, i) => `line${i + 1}`).join("\n")}\n`,
			);
			const handlers = new CursorExecHandlers({
				cwd,
				tools: new Map<string, Tool>([["read", new ReadTool(createTestSession(cwd))]]),
			});

			const result = await handlers.piRead({
				toolCallId: "c1",
				args: { path: "n.txt", offset: 5, limit: 20 },
			} as never);
			const text = result.content
				.filter(part => part.type === "text")
				.map(part => (part as { text: string }).text)
				.join("");

			expect(text.trimEnd().split("\n")).toEqual(Array.from({ length: 20 }, (_, i) => `line${i + 5}`));
		} finally {
			await removeWithRetries(cwd);
		}
	});

	it("escapes pi_grep's pattern when the frame asks for a literal search", async () => {
		// The local tool is regex-only, so an unescaped literal turns regex
		// metacharacters into operators and matches the wrong lines.
		const { handlers, calls } = recordingHandlers("grep");

		await handlers.piGrep({ toolCallId: "c1", args: { pattern: "a.b(c)", literal: true } } as never);
		await handlers.piGrep({ toolCallId: "c2", args: { pattern: "a.b(c)" } } as never);

		expect((calls[0] as { pattern: string }).pattern).toBe("a\\.b\\(c\\)");
		expect((calls[1] as { pattern: string }).pattern).toBe("a.b(c)");
	});

	it("routes pi_find to glob, not grep, joining its pattern onto the path", async () => {
		// `pi_find` searches filenames. Routing it to `grep` would search file
		// contents for the glob text and return nothing.
		const { handlers, calls } = recordingHandlers("glob");

		await handlers.piFind({ toolCallId: "c1", args: { pattern: "*.ts", path: "src", limit: 10 } } as never);
		await handlers.piFind({ toolCallId: "c2", args: { pattern: "*.ts", limit: 0 } } as never);
		await handlers.piFind({ toolCallId: "c3", args: { pattern: "*.ts" } } as never);

		expect(calls).toEqual([
			{ path: "src/*.ts", limit: 10 },
			// `optional int32`: a present 0 is clamped to 1 (as the reference
			// does), not silently widened to the tool's default.
			{ path: "*.ts", limit: 1 },
			// Genuinely unset leaves the local tool's own default in place.
			{ path: "*.ts", limit: undefined },
		]);
	});

	it("renames pi_edit's camelCase replacements to the local tool's snake_case pairs", async () => {
		const { handlers, calls } = recordingHandlers("edit");

		await handlers.piEdit({
			toolCallId: "c1",
			args: { path: "a.ts", edits: [{ oldText: "before", newText: "after" }] },
		} as never);

		expect(calls[0]).toEqual({ path: "a.ts", old_string: "before", new_string: "after" });
	});

	it("sends a multi-replacement pi_edit frame as one batched tool call", async () => {
		// One frame must stay one tool lifecycle: looping per replacement would
		// emit duplicate start/end events under the same toolCallId and return
		// only the last replacement's diff. Multi-replacement frames therefore
		// ride the internal `edits` batch form, in frame order.
		const { handlers, calls } = recordingHandlers("edit");

		await handlers.piEdit({
			toolCallId: "c1",
			args: {
				path: "a.ts",
				edits: [
					{ oldText: "one", newText: "ONE" },
					{ oldText: "two", newText: "TWO" },
				],
			},
		} as never);

		expect(calls).toEqual([
			{
				path: "a.ts",
				edits: [
					{ old_string: "one", new_string: "ONE" },
					{ old_string: "two", new_string: "TWO" },
				],
			},
		]);
	});

	it("lists directories for pi_ls through read, defaulting an empty path to cwd", async () => {
		const { handlers, calls } = recordingHandlers("read");

		await handlers.piLs({ toolCallId: "c1", args: { path: "" } } as never);

		expect(calls[0]).toEqual({ path: "." });
	});
});
