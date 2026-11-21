#!/usr/bin/env bun
import { type ClaudeTraceCommandArgs, runClaudeTraceCommand } from "../packages/coding-agent/src/cli/claude-trace-cli";

const HELP = `Usage: bun scripts/claude-trace.ts [options]

Runs Claude Code in a headless PTY behind a local HTTPS proxy, sends "hi", and
prints the first /v1/messages request/response headers and bodies.

Options:
  --command <cmd>          Command to run in the virtual TUI (default: claude)
  --message <text>         Message to send (default: hi)
  --cwd <path>             Working directory for the Claude process
  --host <host>            Proxy bind host (default: 127.0.0.1)
  --port <port>            Proxy bind port (default: 8080; use 0 for random)
  --timeout <ms>           Overall timeout in milliseconds (default: 120000)
  --input-delay <ms>       Delay before sending input (default: 3000)
  --json                   Print JSON instead of Markdown-ish text
  --upstream-insecure      Disable TLS verification for the upstream server
  -h, --help               Show this help
`;

function readOptionValue(argv: readonly string[], index: number, name: string): { value: string; nextIndex: number } {
	const inlinePrefix = `${name}=`;
	const current = argv[index] ?? "";
	if (current.startsWith(inlinePrefix)) return { value: current.slice(inlinePrefix.length), nextIndex: index };
	const value = argv[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
	return { value, nextIndex: index + 1 };
}

function parseIntegerOption(value: string, name: string): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
	return parsed;
}

export function parseClaudeTraceScriptArgs(argv: readonly string[]): ClaudeTraceCommandArgs | "help" {
	const args: ClaudeTraceCommandArgs = {};
	for (let i = 0; i < argv.length; i++) {
		const item = argv[i] ?? "";
		if (item === "-h" || item === "--help") return "help";
		if (item === "--json") {
			args.json = true;
			continue;
		}
		if (item === "--upstream-insecure") {
			args.upstreamTlsRejectUnauthorized = false;
			continue;
		}
		if (item === "--command" || item.startsWith("--command=")) {
			const parsed = readOptionValue(argv, i, "--command");
			args.command = parsed.value;
			i = parsed.nextIndex;
			continue;
		}
		if (item === "--message" || item.startsWith("--message=")) {
			const parsed = readOptionValue(argv, i, "--message");
			args.message = parsed.value;
			i = parsed.nextIndex;
			continue;
		}
		if (item === "--cwd" || item.startsWith("--cwd=")) {
			const parsed = readOptionValue(argv, i, "--cwd");
			args.cwd = parsed.value;
			i = parsed.nextIndex;
			continue;
		}
		if (item === "--host" || item.startsWith("--host=")) {
			const parsed = readOptionValue(argv, i, "--host");
			args.host = parsed.value;
			i = parsed.nextIndex;
			continue;
		}
		if (item === "--port" || item.startsWith("--port=")) {
			const parsed = readOptionValue(argv, i, "--port");
			args.port = parseIntegerOption(parsed.value, "--port");
			i = parsed.nextIndex;
			continue;
		}
		if (item === "--timeout" || item.startsWith("--timeout=")) {
			const parsed = readOptionValue(argv, i, "--timeout");
			args.timeoutMs = parseIntegerOption(parsed.value, "--timeout");
			i = parsed.nextIndex;
			continue;
		}
		if (item === "--input-delay" || item.startsWith("--input-delay=")) {
			const parsed = readOptionValue(argv, i, "--input-delay");
			args.inputDelayMs = parseIntegerOption(parsed.value, "--input-delay");
			i = parsed.nextIndex;
			continue;
		}
		throw new Error(`Unknown option: ${item}`);
	}
	return args;
}

export async function runClaudeTraceScript(argv: readonly string[] = Bun.argv.slice(2)): Promise<void> {
	const parsed = parseClaudeTraceScriptArgs(argv);
	if (parsed === "help") {
		process.stdout.write(HELP);
		return;
	}
	await runClaudeTraceCommand(parsed);
}

if (import.meta.main) {
	try {
		await runClaudeTraceScript();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`${message}\n`);
		process.exitCode = 1;
	}
}
