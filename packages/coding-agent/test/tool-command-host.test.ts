/**
 * The per-run session command handler the embedded bash engine calls for a
 * mounted tool command: names it installs, how one invocation maps to stdout,
 * stderr and an exit code, and the dispatch records it reports.
 */
import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createToolCommandHandler, toolCommandNames } from "@oh-my-pi/pi-coding-agent/exec/tool-command-host";
import type { Tool, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	resolveToolCommand,
	type ToolCommandDispatch,
	type ToolCommandState,
} from "@oh-my-pi/pi-coding-agent/tools/tool-commands";
import { TerminalGraphicsDecoder } from "@oh-my-pi/pi-coding-agent/utils/terminal-graphics";
import type { ShellCommandRequest } from "@oh-my-pi/pi-natives";
import { convertImageToPng } from "@oh-my-pi/pi-coding-agent/utils/png-conversion";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

const flagSchema = type({ flag: "string" });

/** `fake --flag <v>`: prints `fake:<v>`, fails for `bad`, and records every argument object it ran with. */
function fakeTool(
	executed: unknown[],
	overrides: Partial<AgentTool<typeof flagSchema>> = {},
): AgentTool<typeof flagSchema> {
	return {
		name: "fake",
		label: "Fake",
		description: "Fixture tool command.",
		parameters: flagSchema,
		async execute(_id, args) {
			executed.push(args);
			if (args.flag === "bad") return { content: [{ type: "text", text: "fake failed" }], isError: true };
			return { content: [{ type: "text", text: `fake:${args.flag}` }] };
		},
		...overrides,
	};
}

function commandSession(tools: readonly Tool[], overrides: Partial<ToolSession> = {}): ToolSession {
	const toolCommands: ToolCommandState = {
		tools: new Map(tools.map(tool => [tool.name, tool])),
		mountedNames: new Set(tools.map(tool => tool.name)),
		builtInNames: new Set(),
		isActive: () => false,
		resolve: name => resolveToolCommand(toolCommands, name),
	};
	return {
		cwd: os.tmpdir(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({}),
		toolCommands,
		isToolActive: name => name === "bash",
		...overrides,
	};
}

function request(name: string, argv: string[]): ShellCommandRequest {
	return { name, argv, cwd: os.tmpdir(), stdin: "" };
}

describe("toolCommandNames", () => {
	it("installs nothing without tool-command state or while bash is inactive", () => {
		const executed: unknown[] = [];
		expect(toolCommandNames(commandSession([fakeTool(executed)], { toolCommands: undefined }))).toEqual([]);
		expect(toolCommandNames(commandSession([fakeTool(executed)], { isToolActive: () => false }))).toEqual([]);
		expect(toolCommandNames(commandSession([fakeTool(executed)], { isToolActive: undefined }))).toEqual([]);
	});

	it("installs the mounted tools and the special commands while bash is active", () => {
		const names = toolCommandNames(commandSession([fakeTool([])]));
		expect(names).toEqual(expect.arrayContaining(["fake", "resolve", "reject", "propose"]));
	});
});

describe("createToolCommandHandler", () => {
	it("writes a tool's text to stdout with exit 0", async () => {
		const executed: unknown[] = [];
		const handler = createToolCommandHandler({ session: commandSession([fakeTool(executed)]), toolCallId: "call" });

		expect(await handler(request("fake", ["--flag", "v"]))).toEqual({ stdout: "fake:v\n", stderr: "", exitCode: 0 });
		expect(executed).toEqual([{ flag: "v" }]);
	});

	it("writes an error result to stderr with exit 1", async () => {
		const handler = createToolCommandHandler({ session: commandSession([fakeTool([])]), toolCallId: "call" });

		expect(await handler(request("fake", ["--flag", "bad"]))).toEqual({
			stdout: "",
			stderr: "fake failed\n",
			exitCode: 1,
		});
	});

	it("answers a usage error with exit 2 and the --help hint, without executing", async () => {
		const executed: unknown[] = [];
		const handler = createToolCommandHandler({ session: commandSession([fakeTool(executed)]), toolCallId: "call" });

		const reply = await handler(request("fake", ["--bogus", "x"]));

		expect(reply.exitCode).toBe(2);
		expect(reply.stderr).toContain("fake --help");
		expect(executed).toEqual([]);
	});

	it("prints schema-derived usage for --help without executing", async () => {
		const executed: unknown[] = [];
		const handler = createToolCommandHandler({ session: commandSession([fakeTool(executed)]), toolCallId: "call" });

		const reply = await handler(request("fake", ["--help"]));

		expect(reply.exitCode).toBe(0);
		expect(reply.stdout).toContain("--flag");
		expect(executed).toEqual([]);
	});

	it("writes an image block to stdout as a terminal graphics frame that decodes to the same image", async () => {
		const image: ImageContent = await convertImageToPng({ type: "image", mimeType: "image/png", data: PNG_1X1 });
		const snapSchema = type({});
		const snap: AgentTool<typeof snapSchema> = {
			name: "snap",
			label: "Snap",
			description: "Returns an image.",
			parameters: snapSchema,
			async execute() {
				return { content: [{ type: "text", text: "captured" }, image] };
			},
		};
		const handler = createToolCommandHandler({ session: commandSession([snap]), toolCallId: "call" });

		const reply = await handler(request("snap", []));
		const decoder = new TerminalGraphicsDecoder();
		const text = decoder.push(reply.stdout) + decoder.finish();

		expect(reply.exitCode).toBe(0);
		expect(text.trim()).toBe("captured");
		expect(await decoder.images()).toEqual([expect.objectContaining({ mimeType: "image/png", data: image.data })]);
	});

	it("reports each invocation once, in order, with its mode and exit code", async () => {
		const dispatches: Array<[ToolCommandDispatch, number]> = [];
		const handler = createToolCommandHandler({
			session: commandSession([fakeTool([])]),
			toolCallId: "call",
			onDispatch: (dispatch, index) => dispatches.push([dispatch, index]),
		});

		await handler(request("fake", ["--help"]));
		await handler(request("fake", ["--flag", "ok"]));
		await handler(request("fake", ["--flag", "bad"]));
		await handler(request("fake", ["--bogus", "x"]));

		expect(dispatches).toEqual([
			[expect.objectContaining({ tool: "fake", mode: "help", exitCode: 0 }), 0],
			[expect.objectContaining({ tool: "fake", mode: "execute", exitCode: 0, args: { flag: "ok" } }), 1],
			[expect.objectContaining({ tool: "fake", mode: "execute", exitCode: 1, args: { flag: "bad" } }), 2],
			[expect.objectContaining({ tool: "fake", mode: "execute", exitCode: 2 }), 3],
		]);
	});

	it("reports a running tool's partial details as progress records", async () => {
		const progress: Array<[ToolCommandDispatch, number]> = [];
		const stepping = fakeTool([], {
			async execute(_id, args, _signal, onUpdate) {
				onUpdate?.({ content: [{ type: "text", text: "halfway" }], details: { step: 1 } });
				return { content: [{ type: "text", text: `fake:${args.flag}` }] };
			},
		});
		const handler = createToolCommandHandler({
			session: commandSession([stepping]),
			toolCallId: "call",
			onProgress: (dispatch, index) => progress.push([dispatch, index]),
		});

		await handler(request("fake", ["--flag", "v"]));

		expect(progress).toEqual([[expect.objectContaining({ tool: "fake", inner: { step: 1 } }), 0]]);
	});

	it("fails a name that is no longer mounted with exit 1 without executing it", async () => {
		const executed: unknown[] = [];
		const session = commandSession([fakeTool(executed)]);
		const dispatches: ToolCommandDispatch[] = [];
		const handler = createToolCommandHandler({
			session,
			toolCallId: "call",
			onDispatch: dispatch => dispatches.push(dispatch),
		});
		session.toolCommands?.mountedNames.delete("fake");

		const reply = await handler(request("fake", ["--flag", "v"]));

		expect(reply.exitCode).toBe(1);
		expect(reply.stderr).not.toBe("");
		expect(executed).toEqual([]);
		expect(dispatches).toEqual([expect.objectContaining({ tool: "fake", exitCode: 1 })]);
	});

	it("runs resolve, reject and propose through the same path and records them", async () => {
		const invocations: unknown[] = [];
		const proposals: string[] = [];
		const dispatches: ToolCommandDispatch[] = [];
		const session = commandSession([], {
			peekPendingInvoker: () => async input => {
				invocations.push(input);
				return { content: [{ type: "text", text: "invoked" }] };
			},
			peekPlanProposalHandler:
				() =>
				async (title: string): Promise<AgentToolResult<unknown>> => {
					proposals.push(title);
					return { content: [{ type: "text", text: "proposed" }] };
				},
		});
		const handler = createToolCommandHandler({
			session,
			toolCallId: "call",
			onDispatch: dispatch => dispatches.push(dispatch),
		});

		const resolved = await handler(request("resolve", ["ship it"]));
		const rejected = await handler(request("reject", ["not needed"]));
		const proposed = await handler(request("propose", ["my-plan"]));

		expect([resolved.exitCode, rejected.exitCode, proposed.exitCode]).toEqual([0, 0, 0]);
		expect(resolved.stdout).toContain("invoked");
		expect(proposed.stdout).toContain("proposed");
		expect(invocations).toEqual([
			{ action: "apply", reason: "ship it" },
			{ action: "discard", reason: "not needed" },
		]);
		expect(proposals).toEqual(["my-plan"]);
		expect(dispatches).toEqual([
			expect.objectContaining({ tool: "resolve", mode: "execute", exitCode: 0 }),
			expect.objectContaining({ tool: "reject", mode: "execute", exitCode: 0 }),
			expect.objectContaining({ tool: "propose", mode: "execute", exitCode: 0 }),
		]);
	});

	it("fails a special command with nothing to act on with exit 1", async () => {
		const dispatches: ToolCommandDispatch[] = [];
		const handler = createToolCommandHandler({
			session: commandSession([]),
			toolCallId: "call",
			onDispatch: dispatch => dispatches.push(dispatch),
		});

		const reply = await handler(request("propose", ["my-plan"]));

		expect(reply.exitCode).toBe(1);
		expect(reply.stderr).not.toBe("");
		expect(dispatches).toEqual([expect.objectContaining({ tool: "propose", exitCode: 1 })]);
	});
});
