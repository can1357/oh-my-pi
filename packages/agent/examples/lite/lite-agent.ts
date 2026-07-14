/**
 * "pi-lite": a minimal agent profile for small/weak models.
 *
 * Composes the existing Agent loop with a deliberately tiny tool surface
 * (run_bash / read_file / write_file), a ~300-token system prompt, and an
 * owned text tool-calling dialect so models with unreliable native tool
 * calling (small local models, older OSS checkpoints) still work.
 *
 * Run: bun packages/agent/examples/lite/lite-agent.ts "your task"
 */
import * as path from "node:path";
import { type Model, z } from "@pk-nerdsaver-ai/pi-ai";
import { preferredDialect } from "@pk-nerdsaver-ai/pi-catalog/identity";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { Agent, type AgentEvent, type AgentTool } from "../../src/index";
import promptText from "./prompt.md" with { type: "text" };

export interface LiteAgentOptions {
	model: Model;
	cwd?: string;
	/** Force the owned text dialect even for models with good native tool calling. */
	forceOwnedDialect?: boolean;
}

const runBashParams = z.object({
	command: z.string().describe("Shell command to run"),
});

const runBashTool: AgentTool<typeof runBashParams> = {
	name: "run_bash",
	label: "Run Bash",
	description: "Run a shell command and return its combined output.",
	parameters: runBashParams,
	execute: async (_toolCallId, params, signal, _onUpdate, context) => {
		const cwd = (context as { cwd?: string } | undefined)?.cwd ?? process.cwd();
		const proc = Bun.spawn(["bash", "-lc", params.command], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			signal,
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		const combined = [stdout, stderr].filter(part => part.length > 0).join("\n");
		if (exitCode !== 0) {
			throw new Error(`Command exited with code ${exitCode}:\n${combined}`);
		}
		return {
			content: [{ type: "text", text: combined.length > 0 ? combined : "(no output)" }],
			details: { exitCode },
		};
	},
};

const readFileParams = z.object({
	path: z.string().describe("File path, absolute or relative to the working directory"),
});

const readFileTool: AgentTool<typeof readFileParams> = {
	name: "read_file",
	label: "Read File",
	description: "Read a file's full contents as text.",
	parameters: readFileParams,
	execute: async (_toolCallId, params, _signal, _onUpdate, context) => {
		const cwd = (context as { cwd?: string } | undefined)?.cwd ?? process.cwd();
		const file = Bun.file(path.resolve(cwd, params.path));
		if (!(await file.exists())) {
			throw new Error(`File not found: ${params.path}`);
		}
		const text = await file.text();
		return {
			content: [{ type: "text", text }],
			details: { path: params.path, size: text.length },
		};
	},
};

const writeFileParams = z.object({
	path: z.string().describe("File path, absolute or relative to the working directory"),
	content: z.string().describe("Complete new file contents"),
});

const writeFileTool: AgentTool<typeof writeFileParams> = {
	name: "write_file",
	label: "Write File",
	description: "Create or completely replace a file with the given text.",
	parameters: writeFileParams,
	execute: async (_toolCallId, params, _signal, _onUpdate, context) => {
		const cwd = (context as { cwd?: string } | undefined)?.cwd ?? process.cwd();
		const target = path.resolve(cwd, params.path);
		const bytes = await Bun.write(target, params.content);
		return {
			content: [{ type: "text", text: `Wrote ${bytes} bytes to ${params.path}` }],
			details: { path: params.path, bytes },
		};
	},
};

export function createLiteAgent(options: LiteAgentOptions): Agent {
	const cwd = options.cwd ?? process.cwd();
	return new Agent({
		initialState: {
			systemPrompt: [promptText, `Working directory: ${cwd}`],
			model: options.model,
			tools: [runBashTool, readFileTool, writeFileTool],
		},
		cwd,
		getToolContext: () => ({ cwd }) as never,
		// Owned text dialect: tool calls are parsed from model text output,
		// so models with weak/absent native tool calling still work.
		dialect: options.forceOwnedDialect ? preferredDialect(options.model.id) : undefined,
	});
}

if (import.meta.main) {
	const task = process.argv.slice(2).join(" ");
	if (task.length === 0) {
		console.error('Usage: bun lite-agent.ts "your task"');
		process.exit(1);
	}
	const agent = createLiteAgent({
		model: getBundledModel("anthropic", "claude-haiku-4-5"),
	});
	agent.subscribe((event: AgentEvent) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
		if (event.type === "tool_execution_start") {
			process.stdout.write(`\n[${event.toolName}] ${JSON.stringify(event.args)}\n`);
		}
	});
	await agent.prompt(task);
	process.stdout.write("\n");
}
