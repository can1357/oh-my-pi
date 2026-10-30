import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentEvent, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Process } from "@oh-my-pi/pi-natives";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { isRecord, ptree, readLines, removeWithRetries } from "@oh-my-pi/pi-utils";

const device = "mcp__stub_regression_announce";
const deviceUri = `xd://${device}`;
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

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// Both modes enter main.ts -> createAgentSession -> runRpcMode. An SDK-only
// fixture would miss a lost MCP manager at that launch boundary.
describe("CLI RPC MCP discovery", () => {
	for (const mode of ["rpc", "rpc-ui"] as const) {
		test(`${mode}: mounted MCP survives session switches; user denylist prevents spawn until restart restores it`, async () => {
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
							mode,
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
						expect(state.dumpTools?.map(tool => tool.name)).toEqual(expect.arrayContaining(["read", "write"]));
						expect(state.dumpTools?.some(tool => tool.name === device)).toBe(false);
						const listing = toolResult(await client.promptAndWait("read_uri xd://"), "read", { path: "xd://" });
						if (phase === "disabled") {
							expect(listing).not.toContain(device);
							const events = await client.promptAndWait(`write_uri ${deviceUri} {}`);
							const error = toolResult(events, "write", { path: deviceUri, content: "{}" });
							expect(events.find(event => event.type === "tool_execution_end")).toMatchObject({ isError: true });
							expect(error).toContain(`No such tool: ${deviceUri}`);
							expect(await auditEntries(audit)).toEqual([]);
						} else {
							expect(listing).toContain(device);
							const docs = toolResult(await client.promptAndWait(`read_uri ${deviceUri}`), "read", {
								path: deviceUri,
							});
							expect(docs).toContain("Return an independently audited invocation marker.");
							const invoke = async () => {
								const before = (await auditEntries(audit)).filter(
									entry => entry.method === "tools/call",
								).length;
								const events = await client.promptAndWait(`write_uri ${deviceUri} {}`);
								expect(toolResult(events, "write", { path: deviceUri, content: "{}" })).toContain(
									"rpc-mcp-invoked",
								);
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
						const spawns = (await auditEntries(audit)).filter(entry => entry.event === "spawn");
						expect(spawns).toHaveLength(phase === "disabled" ? 0 : 1);
						for (const spawn of spawns) {
							if (typeof spawn.pid !== "number") throw new Error("Missing MCP PID");
							expect(isAlive(spawn.pid), `MCP peer ${spawn.pid} survived RPC shutdown`).toBe(false);
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
	}
});
