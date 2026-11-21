import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentEvent, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Process } from "@oh-my-pi/pi-natives";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { isRecord, ptree, readLines, removeWithRetries } from "@oh-my-pi/pi-utils";
import { isAlive, waitFor } from "./fixtures/daemon-harness";

const toolCommand = "mcp__stub_regression_announce";
const cli = path.join(import.meta.dir, "../src/cli.ts");
const peer = path.join(import.meta.dir, "fixtures/rpc-mcp-server.ts");
const fakeModel = path.join(import.meta.dir, "rpc-wire/fake-openai-server.ts");

function toolResult(events: AgentEvent[], toolName: string, args: Record<string, unknown>): string {
	// Inspect this prompt's actual execution, never assistant text or persisted history.
	const starts = events.filter(event => event.type === "tool_execution_start");
	expect(starts).toHaveLength(1);
	expect(starts[0]).toMatchObject({ toolName, args });
	const ends = events.filter(event => event.type === "tool_execution_end");
	expect(ends).toHaveLength(1);
	const end = ends[0];
	if (!end || end.type !== "tool_execution_end") throw new Error("Missing tool execution result");
	expect(end.toolCallId).toBe(starts[0]?.toolCallId);
	expect(end.toolName).toBe(toolName);
	const result: AgentToolResult<unknown> = end.result;
	return result.content
		.filter(part => part.type === "text")
		.map(part => part.text)
		.join("\n");
}

async function auditEntries(audit: string): Promise<Record<string, unknown>[]> {
	const entries: unknown[] = Bun.JSONL.parse(await Bun.file(audit).text());
	return entries.map(entry => {
		if (!isRecord(entry)) throw new Error("Invalid MCP audit entry");
		return entry;
	});
}

// rpc-ui enters main.ts -> createAgentSession -> runRpcMode. An SDK-only
// fixture would miss a lost MCP manager at that launch boundary.
describe("CLI RPC MCP discovery", () => {
	test("rpc-ui: mounted MCP survives session switches; user denylist prevents spawn until restart restores it", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-mcp-"));
		const home = path.join(root, "home");
		const agentDir = path.join(home, ".omp/agent");
		const project = path.join(root, "project");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.mkdir(project);
		// Do not inherit API keys, profiles, provider overrides or external-tool configs.
		const env = {
			PATH: `${path.dirname(process.execPath)}${path.delimiter}${Bun.env.PATH ?? ""}`,
			HOME: home,
			USERPROFILE: home,
			XDG_CONFIG_HOME: path.join(home, ".config"),
			PI_CONFIG_DIR: ".omp",
			PI_CODING_AGENT_DIR: agentDir,
			PI_NO_TITLE: "1",
			// Wait for the stub at startup: a server the MCP host has never seen is
			// probed before it serves, which outlasts the default startup window.
			OMP_MCP_STARTUP_TIMEOUT_MS: "0",
			// The stub ignores end-of-input (see the fixture), so each stop, the era
			// probe's included, waits out the step before SIGTERM: keep that short.
			OMP_MCP_SHUTDOWN_STEP_MS: "10",
		};
		using model = ptree.spawn([process.execPath, fakeModel, agentDir], {
			cwd: project,
			env,
			stdin: "pipe",
			detached: true,
			timeout: 120_000,
		});
		try {
			let ready = "";
			for await (const line of readLines(model.stdout, AbortSignal.timeout(10_000))) {
				ready = new TextDecoder().decode(line);
				break;
			}
			expect(ready, model.peekStderr()).toMatch(/^READY \d+/);
			// The denied launch runs first: the restored launch then proves the same
			// command does spawn once the denylist is lifted, that nothing from the
			// denied run sticks across restart, and that the mount survives switches.
			for (const phase of ["disabled", "restored"] as const) {
				const audit = path.join(root, `${phase}.jsonl`);
				await Bun.write(audit, "");
				await Bun.write(
					path.join(agentDir, "mcp.json"),
					JSON.stringify({
						mcpServers: { stub: { command: process.execPath, args: [peer, audit] } },
						// Deny must win even when the user also explicitly force-enables it.
						...(phase === "disabled" ? { disabledServers: ["stub"], enabledServers: ["stub"] } : {}),
					}),
				);
				using child = ptree.spawn(
					[
						process.execPath,
						cli,
						"--mode",
						"rpc-ui",
						"--model",
						"fake/fake-model",
						"--no-extensions",
						"--no-skills",
						"--no-rules",
						"--no-lsp",
						"--no-prewalk",
					],
					{ cwd: project, env, stdin: "pipe", detached: true, timeout: 60_000 },
				);
				let observingEof = false;
				using client = new RpcClient({
					spawn: () => ({
						stdin: child.stdin,
						stdout: child.stdout,
						exited: child.exited,
						peekStderr: () => child.peekStderr(),
						kill: (reason, graceMs) => {
							// RpcClient reaps on stdout EOF. That must not rescue a CLI
							// which exited without terminating its owned MCP peer.
							if (!observingEof) child.kill(reason, graceMs);
						},
					}),
				});
				try {
					await client.start();
					const state = await client.getState();
					expect(state.dumpTools?.map(tool => tool.name)).toEqual(
						expect.arrayContaining(["read", "write", "bash"]),
					);
					expect(state.dumpTools?.some(tool => tool.name === toolCommand)).toBe(false);
					const invokeCommand = `${toolCommand} -j '{}'`;
					if (phase === "disabled") {
						const events = await client.promptAndWait(`run_command ${invokeCommand}`);
						expect(toolResult(events, "bash", { command: invokeCommand })).not.toContain("rpc-mcp-invoked");
						expect(events.find(event => event.type === "tool_execution_end")).toMatchObject({ isError: true });
						expect(await auditEntries(audit)).toEqual([]);
					} else {
						// Deferred discovery may land after the first turn starts: wait until the command is mounted.
						const probe = `type ${toolCommand}`;
						for (let attempt = 0; attempt < 20; attempt++) {
							const seen = toolResult(await client.promptAndWait(`run_command ${probe}`), "bash", {
								command: probe,
							});
							if (!seen.includes("not found")) break;
						}
						const help = toolResult(await client.promptAndWait(`run_command ${toolCommand} --help`), "bash", {
							command: `${toolCommand} --help`,
						});
						expect(help).toContain("Return an independently audited invocation marker.");
						const invoke = async () => {
							const before = (await auditEntries(audit)).filter(entry => entry.method === "tools/call").length;
							const events = await client.promptAndWait(`run_command ${invokeCommand}`);
							expect(toolResult(events, "bash", { command: invokeCommand })).toContain("rpc-mcp-invoked");
							expect(events.find(event => event.type === "tool_execution_end")).toMatchObject({
								isError: false,
							});
							const calls = (await auditEntries(audit)).filter(entry => entry.method === "tools/call");
							expect(calls).toHaveLength(before + 1);
							expect(calls.at(-1)).toMatchObject({ params: { name: "regression_announce", arguments: {} } });
						};
						await invoke();
						const original = (await client.getState()).sessionFile;
						if (!original) throw new Error("Expected persisted RPC session");
						expect(await client.openSession(path.join(root, "other-sessions"))).toMatchObject({
							cancelled: false,
						});
						expect((await client.getState()).sessionFile).not.toBe(original);
						await invoke();
						expect(await client.switchSession(original)).toEqual({ cancelled: false });
						expect((await client.getState()).sessionFile).toBe(original);
						await invoke();
					}
					// Observe natural server teardown before allowing any client tree kill.
					observingEof = true;
					child.stdin.end();
					child.attachTimeout(10_000);
					expect(await child.exited).toBe(0);
					const entries = await auditEntries(audit);
					const spawns = entries.filter(entry => entry.event === "spawn");
					if (phase === "disabled") {
						expect(spawns).toHaveLength(0);
					} else {
						// The host launches the stub to probe it and again to serve. Every
						// invocation, across both session switches, reached that one server.
						const firstCall = entries.findIndex(entry => entry.method === "tools/call");
						const lastSpawn = entries.findLastIndex(entry => entry.event === "spawn");
						expect(lastSpawn).toBeGreaterThanOrEqual(0);
						expect(firstCall).toBeGreaterThan(lastSpawn);
					}
					for (const spawn of spawns) {
						if (typeof spawn.pid !== "number") throw new Error("Missing MCP PID");
						const pid = spawn.pid;
						// The MCP host owns the peer and stops it once the exiting session lets
						// go: shortly after the CLI is gone, with no event this test could await.
						await waitFor(() => !isAlive(pid), `MCP peer ${pid} to stop after RPC shutdown`, 5_000);
					}
				} finally {
					observingEof = false;
					try {
						await client.stop();
					} finally {
						child.kill(undefined, 0);
						await child.exited.catch(() => {});
						// An already-exited CLI may have lost its process-tree handle.
						// Audit-owned peer PIDs remain available for bounded fallback cleanup.
						for (const entry of await auditEntries(audit)) {
							if (entry.event === "spawn" && typeof entry.pid === "number") {
								await Process.fromPid(entry.pid)?.terminate({ gracefulMs: 0 });
							}
						}
					}
				}
			}
		} finally {
			model.stdin.end();
			model.kill();
			await model.exited.catch(() => {});
			await removeWithRetries(root);
		}
	}, 120_000);
});
