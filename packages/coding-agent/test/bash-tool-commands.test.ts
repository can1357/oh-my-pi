/**
 * Mounted tools as bare commands of the bash tool's embedded engine, end to end
 * through `BashTool.execute` (and the eval `sh()` bridge): output, dispatch
 * records, images, precedence over the session's functions and aliases, and the
 * runners that never see tool commands (pty, client terminals).
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { JsStatusEvent } from "@oh-my-pi/pi-coding-agent/eval/js/shared/types";
import { runEvalShell } from "@oh-my-pi/pi-coding-agent/eval/shell-bridge";
import { releaseShellSessions } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import type { ClientBridge, ClientBridgeTerminalHandle } from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import type { Tool, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { resolveToolCommand, type ToolCommandState } from "@oh-my-pi/pi-coding-agent/tools/tool-commands";
import { convertImageToPng } from "@oh-my-pi/pi-tui/png-conversion";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

const flagSchema = type({ flag: "string" });

let cwd: string;

beforeEach(async () => {
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bash-tool-commands-"));
});

afterEach(async () => {
	releaseShellSessions(cwd);
	await fs.rm(cwd, { recursive: true, force: true });
});

/** Tool printing `<name>:<flag>`, recording every argument object it ran with. */
function flagTool(name: string, executed: unknown[] = []): AgentTool<typeof flagSchema> {
	return {
		name,
		label: name,
		description: `Fixture tool command ${name}.`,
		parameters: flagSchema,
		async execute(_id, args) {
			executed.push(args);
			return { content: [{ type: "text", text: `${name}:${args.flag}` }] };
		},
	};
}

function bashSession(tools: readonly Tool[], overrides: Partial<ToolSession> = {}): ToolSession {
	const toolCommands: ToolCommandState = {
		tools: new Map(tools.map(tool => [tool.name, tool])),
		mountedNames: new Set(tools.map(tool => tool.name)),
		builtInNames: new Set(),
		isActive: () => false,
		resolve: name => resolveToolCommand(toolCommands, name),
	};
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionId: () => cwd,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "bash.autoBackground.enabled": false }),
		toolCommands,
		isToolActive: name => name === "bash",
		...overrides,
	};
}

async function run(tool: BashTool, command: string) {
	const result = await tool.execute("bash-tool-commands", { command });
	const text = result.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
	return { result, text };
}

describe.skipIf(process.platform === "win32")("tool commands in the bash tool", () => {
	it("runs a mounted tool and records one dispatch", async () => {
		const executed: unknown[] = [];
		const { result, text } = await run(new BashTool(bashSession([flagTool("fake", executed)])), "fake --flag v");

		expect(text).toContain("fake:v");
		expect(executed).toEqual([{ flag: "v" }]);
		expect(result.details?.toolCommands).toEqual([
			expect.objectContaining({ tool: "fake", mode: "execute", exitCode: 0, args: { flag: "v" } }),
		]);
	});

	it("records two tools of one line in invocation order", async () => {
		const tool = new BashTool(bashSession([flagTool("fake"), flagTool("other")]));
		const { result, text } = await run(tool, "fake --flag a; other --flag b");

		expect(text.indexOf("fake:a")).toBeGreaterThanOrEqual(0);
		expect(text.indexOf("other:b")).toBeGreaterThan(text.indexOf("fake:a"));
		expect(result.details?.toolCommands?.map(dispatch => dispatch.tool)).toEqual(["fake", "other"]);
	});

	it("pipes a tool's stdout into the next command", async () => {
		const { text } = await run(new BashTool(bashSession([flagTool("fake")])), "fake --flag piped | tr a-z A-Z");
		expect(text).toContain("FAKE:PIPED");
	});

	it("prints a tool's usage for --help without executing it", async () => {
		const executed: unknown[] = [];
		const { result, text } = await run(new BashTool(bashSession([flagTool("fake", executed)])), "fake --help");

		expect(text).toContain("--flag");
		expect(executed).toEqual([]);
		expect(result.details?.toolCommands).toEqual([
			expect.objectContaining({ tool: "fake", mode: "help", exitCode: 0 }),
		]);
	});

	it("attaches a tool's image to the bash result and saves it to a linked file", async () => {
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

		const { result, text } = await run(new BashTool(bashSession([snap])), "snap");
		const saved = /^Image saved: (.+)$/mu.exec(text)?.[1];
		try {
			expect(text).toContain("captured");
			expect(text).not.toContain("\x1b_G");
			expect(result.content.filter(block => block.type === "image")).toEqual([
				expect.objectContaining({ type: "image", mimeType: "image/png", data: image.data }),
			]);
			expect(saved).toBeDefined();
			expect(await Bun.file(saved ?? "").exists()).toBe(true);
		} finally {
			if (saved) await fs.rm(saved, { force: true });
		}
	});

	it("runs the tool, not a shell function of the same name from an earlier call", async () => {
		const executed: unknown[] = [];
		const tool = new BashTool(bashSession([flagTool("fake", executed)]));

		await run(tool, "fake() { echo from-function; }");
		expect((await run(tool, "declare -f fake")).text).toContain("from-function");
		const { text } = await run(tool, "fake --flag v");

		expect(text).toContain("fake:v");
		expect(text).not.toContain("from-function");
		expect(executed).toEqual([{ flag: "v" }]);
	});

	it("runs the tool, not an alias of the same name from an earlier call", async () => {
		const executed: unknown[] = [];
		const tool = new BashTool(bashSession([flagTool("fake", executed)]));

		await run(tool, "shopt -s expand_aliases; alias fake='echo from-alias'");
		expect((await run(tool, "alias fake")).text).toContain("from-alias");
		const { text } = await run(tool, "fake --flag v");

		expect(text).toContain("fake:v");
		expect(text).not.toContain("from-alias");
		expect(executed).toEqual([{ flag: "v" }]);
	});

	it("refuses pty for a line naming a tool command before running anything", async () => {
		const executed: unknown[] = [];
		const tool = new BashTool(bashSession([flagTool("fake", executed)]));
		const marker = path.join(cwd, "ran");

		await expect(
			tool.execute("bash-tool-commands-pty", { command: `touch '${marker}' && fake --flag v`, pty: true }),
		).rejects.toThrow(ToolError);

		expect(executed).toEqual([]);
		expect(await Bun.file(marker).exists()).toBe(false);
	});

	it("keeps a tool-command line on the embedded engine when the client advertises a terminal", async () => {
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-tool-commands",
			waitForExit: async () => ({ exitCode: 0, signal: null }),
			currentOutput: async () => ({ output: "from-client-terminal\n", truncated: false }),
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};
		const createTerminal = spyOn(bridge, "createTerminal");
		// The client route resolves the configured shell; any existing file stands in for it.
		const shellPath = path.join(cwd, "bash");
		await Bun.write(shellPath, "");
		const tool = new BashTool(
			bashSession([flagTool("fake")], {
				settings: Settings.isolated({ "bash.autoBackground.enabled": false, shellPath }),
				getClientBridge: () => bridge,
			}),
		);

		// Control: a plain line does go to the client terminal.
		expect((await run(tool, "echo plain")).text).toContain("from-client-terminal");
		expect(createTerminal).toHaveBeenCalledTimes(1);

		const { text } = await run(tool, "fake --flag v");
		expect(text).toContain("fake:v");
		expect(createTerminal).toHaveBeenCalledTimes(1);
	});
});

describe.skipIf(process.platform === "win32")("tool commands in eval sh()", () => {
	it("runs a mounted tool and reports it under its tool name", async () => {
		const executed: unknown[] = [];
		const statuses: JsStatusEvent[] = [];

		const result = await runEvalShell(
			{ command: "fake --flag v" },
			{ session: bashSession([flagTool("fake", executed)]), emitStatus: event => statuses.push(event) },
		);

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("fake:v");
		expect(executed).toEqual([{ flag: "v" }]);
		expect(statuses).toContainEqual(expect.objectContaining({ op: "fake", mode: "execute", code: 0 }));
	});
});
