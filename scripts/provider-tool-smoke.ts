#!/usr/bin/env bun
/**
 * Live CLI read/write/bash round-trip. Uses existing omp credentials; inference may be billed.
 * bun scripts/provider-tool-smoke.ts cursor/auto [effort] [evidence-directory]
 * Retains the isolated workspace and JSON events for inspection; never prints credentials.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { AgentSessionEvent } from "../packages/coding-agent/src/session/agent-session";
import { inspectWorkflow } from "./provider-tool-smoke/evidence";
import workflow from "./provider-tool-smoke/workflow.md" with { type: "text" };

const [selector, effort, evidenceDirectory] = process.argv.slice(2);
if (!selector) throw new Error("Usage: provider-tool-smoke.ts provider/model [effort] [evidence-directory]");
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "omp-provider-smoke-"));
const evidence = path.resolve(evidenceDirectory ?? workspace);
const input = `${crypto.randomUUID()}\n`;
const challenge = `verified-${crypto.randomUUID()}`;
await Bun.write(path.join(workspace, "input.txt"), input);
await Bun.write(path.join(workspace, "challenge.sh"), `printf '%s\\n' '${challenge}'\n`);
const args = [
	process.execPath,
	path.resolve(import.meta.dir, "../packages/coding-agent/src/cli.ts"),
	"--cwd",
	workspace,
	"-p",
	"--mode",
	"json",
	"--no-session",
	"--no-title",
	"--no-extensions",
	"--no-skills",
	"--no-rules",
	"--no-lsp",
	"--no-pty",
	"--no-prewalk",
	"--tools",
	"read,write,bash",
	"--auto-approve",
	"--max-time",
	"150",
	"--model",
	selector,
];
if (effort && effort !== "default") args.push("--thinking", effort);
args.push(workflow);
const startedAt = new Date().toISOString();
const start = performance.now();
const child = Bun.spawn(args, {
	cwd: workspace,
	env: { ...process.env, PI_NO_MCP: "1" },
	stdout: "pipe",
	stderr: "pipe",
});
const timeout = setTimeout(() => child.kill("SIGKILL"), 175_000);
const [stdout, stderr, exitCode] = await Promise.all([
	new Response(child.stdout).text(),
	new Response(child.stderr).text(),
	child.exited,
]);
clearTimeout(timeout);
await Bun.write(path.join(evidence, "events.jsonl"), stdout);
await Bun.write(path.join(evidence, "stderr.txt"), stderr);
let output: string | undefined;
try {
	output = await Bun.file(path.join(workspace, "output.txt")).text();
} catch (error) {
	if (!isEnoent(error)) throw error;
}
const events = Bun.JSONL.parse(stdout) as AgentSessionEvent[];
const summary = {
	selector,
	effort: effort ?? "default",
	workspace,
	startedAt,
	elapsedMs: Math.round(performance.now() - start),
	...inspectWorkflow(events, input, output, challenge, exitCode),
};
await Bun.write(path.join(evidence, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(summary.pass ? "PROVIDER_TOOL_SMOKE_PASS" : "PROVIDER_TOOL_SMOKE_FAIL");
process.exitCode = summary.pass ? 0 : 1;
