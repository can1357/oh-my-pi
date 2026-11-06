/**
 * `/mcp test <name>` in RPC mode on a first-time lazy server must hand the
 * server to the session the way the TUI does: the tested server's tools
 * appear in the session and the server is seeded, instead of a passing test
 * that leaves the session without its tools (PR #9793 review, round 2).
 *
 * Drives the real CLI in RPC mode with a stand-in user whose `mcp.json`
 * declares one lazy stdio server that records every start.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentEvent, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Process } from "@oh-my-pi/pi-natives";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { isRecord, ptree, readLines, removeWithRetries } from "@oh-my-pi/pi-utils";

const device = "mcp__dormant_regression_announce";
const cli = path.join(import.meta.dir, "../src/cli.ts");
const peer = path.join(import.meta.dir, "fixtures/rpc-mcp-server.ts");
const fakeModel = path.join(import.meta.dir, "rpc-wire/fake-openai-server.ts");

/** Text the `read` tool returned for `xd://`: the devices (MCP tools) this session can call. */
function deviceListing(events: AgentEvent[]): string {
	const end = events.find(event => event.type === "tool_execution_end");
	if (!end || end.type !== "tool_execution_end") throw new Error("Missing read tool result");
	const result: AgentToolResult<unknown> = end.result;
	return result.content
		.filter(part => part.type === "text")
		.map(part => part.text)
		.join("\n");
}

async function spawnedPids(audit: string): Promise<number[]> {
	const text = await Bun.file(audit).text();
	const entries: unknown[] = Bun.JSONL.parse(text);
	return entries.flatMap(entry =>
		isRecord(entry) && entry.event === "spawn" && typeof entry.pid === "number" ? [entry.pid] : [],
	);
}

describe("RPC /mcp test on a first-time lazy server", () => {
	test("registers the tested server's tools in the session", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-mcp-test-seed-"));
		const home = path.join(root, "home");
		const agentDir = path.join(home, ".omp/agent");
		const project = path.join(root, "project");
		const audit = path.join(root, "dormant.jsonl");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.mkdir(project);
		await Bun.write(audit, "");
		await Bun.write(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { dormant: { command: process.execPath, args: [peer, audit], lazy: true } } }),
		);
		const env = {
			PATH: `${path.dirname(process.execPath)}${path.delimiter}${Bun.env.PATH ?? ""}`,
			HOME: home,
			USERPROFILE: home,
			XDG_CONFIG_HOME: path.join(home, ".config"),
			PI_CONFIG_DIR: ".omp",
			PI_CODING_AGENT_DIR: agentDir,
			PI_NO_TITLE: "1",
		};
		using model = ptree.spawn([process.execPath, fakeModel, agentDir], {
			cwd: project,
			env,
			stdin: "pipe",
			detached: true,
			timeout: 180_000,
		});
		try {
			let ready = "";
			for await (const line of readLines(model.stdout, AbortSignal.timeout(30_000))) {
				ready = new TextDecoder().decode(line);
				break;
			}
			expect(ready, model.peekStderr()).toMatch(/^READY \d+/);
			using child = ptree.spawn(
				[
					process.execPath,
					cli,
					"--mode",
					"rpc",
					"--model",
					"fake/fake-model",
					"--no-extensions",
					"--no-skills",
					"--no-rules",
					"--no-lsp",
					"--no-prewalk",
				],
				{ cwd: project, env, stdin: "pipe", detached: true, timeout: 180_000 },
			);
			using client = new RpcClient({
				spawn: () => ({
					stdin: child.stdin,
					stdout: child.stdout,
					exited: child.exited,
					peekStderr: () => child.peekStderr(),
					kill: (reason, graceMs) => child.kill(reason, graceMs),
				}),
			});
			try {
				await client.start();
				// Startup leaves a cache-less lazy server dormant and tool-less.
				expect(deviceListing(await client.promptAndWait("read_uri xd://"))).not.toContain(device);
				expect(await spawnedPids(audit)).toEqual([]);

				// A builtin answers its prompt once the command has finished.
				await client.promptAndWait("/mcp test dormant");
				expect(deviceListing(await client.promptAndWait("read_uri xd://")), child.peekStderr()).toContain(device);
				// One start for the test connection, one for the seed.
				expect(await spawnedPids(audit)).toHaveLength(2);
			} finally {
				await client.stop().catch(() => {});
				child.kill(undefined, 0);
				await child.exited.catch(() => {});
			}
		} finally {
			for (const pid of await spawnedPids(audit).catch(() => [])) {
				await Process.fromPid(pid)?.terminate({ gracefulMs: 0 });
			}
			model.stdin.end();
			model.kill();
			await model.exited.catch(() => {});
			await removeWithRetries(root);
		}
	}, 240_000);
});
