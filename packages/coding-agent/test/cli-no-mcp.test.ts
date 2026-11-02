/**
 * A test, an SDK host or any tool that spawns omp runs it as the user who
 * started that process, so the child reads that user's MCP servers and starts
 * them. `--no-mcp` (or `PI_NO_MCP=1`, its inherited form) is the documented
 * way to say "start none of them", and every process the omp starts inherits
 * it, so an omp re-entered from there keeps it too.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import { isRecord, ptree, readJsonl, readLines, removeWithRetries } from "@oh-my-pi/pi-utils";

const cli = path.join(import.meta.dir, "../src/cli.ts");
const peer = path.join(import.meta.dir, "fixtures/rpc-mcp-server.ts");
const fakeModel = path.join(import.meta.dir, "rpc-wire/fake-openai-server.ts");

async function spawnedPids(audit: string): Promise<number[]> {
	const entries: unknown[] = Bun.JSONL.parse(await Bun.file(audit).text());
	return entries.flatMap(entry =>
		isRecord(entry) && entry.event === "spawn" && typeof entry.pid === "number" ? [entry.pid] : [],
	);
}

interface StandInUser {
	root: string;
	agentDir: string;
	project: string;
	/** JSONL the user's one MCP server appends a `spawn` record to each time it starts. */
	audit: string;
	env: Record<string, string>;
}

/** The stand-in user: their home and their agent dir, with one MCP server. */
async function standInUser(noMcpEnv: string): Promise<StandInUser> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-no-mcp-"));
	const home = path.join(root, "home");
	const agentDir = path.join(home, ".omp/agent");
	const project = path.join(root, "project");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(project);
	const audit = path.join(root, "audit.jsonl");
	await Bun.write(audit, "");
	await Bun.write(
		path.join(agentDir, "mcp.json"),
		JSON.stringify({ mcpServers: { stub: { command: process.execPath, args: [peer, audit] } } }),
	);
	const env = {
		PATH: `${path.dirname(process.execPath)}${path.delimiter}${Bun.env.PATH ?? ""}`,
		HOME: home,
		USERPROFILE: home,
		XDG_CONFIG_HOME: path.join(home, ".config"),
		PI_CONFIG_DIR: ".omp",
		PI_CODING_AGENT_DIR: agentDir,
		PI_NO_TITLE: "1",
		// Startup waits for every MCP handshake, so a started server has
		// recorded its spawn before omp answers.
		OMP_MCP_STARTUP_TIMEOUT_MS: "0",
		PI_NO_MCP: noMcpEnv,
	};
	return { root, agentDir, project, audit, env };
}

async function stopStartedServers(audit: string): Promise<void> {
	for (const pid of await spawnedPids(audit)) {
		await Process.fromPid(pid)?.terminate({ gracefulMs: 0 });
	}
}

const cases = [
	{ name: "a plain spawned omp starts the user's servers", args: [], noMcpEnv: "", starts: true },
	{ name: "--no-mcp starts none of them", args: ["--no-mcp"], noMcpEnv: "", starts: false },
	{ name: "PI_NO_MCP=1 starts none of them", args: [], noMcpEnv: "1", starts: false },
] as const;

describe("spawned omp and the user's MCP servers", () => {
	for (const row of cases) {
		test(
			row.name,
			async () => {
				const { root, agentDir, project, audit, env } = await standInUser(row.noMcpEnv);
				using model = ptree.spawn([process.execPath, fakeModel, agentDir], {
					cwd: project,
					env,
					stdin: "pipe",
					detached: true,
					timeout: 240_000,
				});
				try {
					let ready = "";
					for await (const line of readLines(model.stdout, AbortSignal.timeout(60_000))) {
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
							...row.args,
						],
						{ cwd: project, env, stdin: "pipe", detached: true, timeout: 180_000 },
					);
					// One reader for the whole session: a `for await` that returns early would close it.
					const responses = readJsonl<unknown>(child.stdout)[Symbol.asyncIterator]();
					const request = async (frame: Record<string, unknown>): Promise<Record<string, unknown>> => {
						child.stdin.write(`${JSON.stringify(frame)}\n`);
						child.stdin.flush();
						for (;;) {
							const next = await responses.next();
							if (next.done)
								throw new Error(`omp exited before answering ${String(frame.type)}: ${child.peekStderr()}`);
							const message = next.value;
							if (isRecord(message) && message.type === "response" && message.id === frame.id) {
								expect(message.success, child.peekStderr()).toBe(true);
								return isRecord(message.data) ? message.data : {};
							}
						}
					};
					try {
						// Answered once the session exists: MCP startup has run by now.
						await request({ id: "state", type: "get_state" });
						expect(await spawnedPids(audit)).toHaveLength(row.starts ? 1 : 0);
						// What omp starts (a shell here, an omp it re-enters elsewhere) carries the choice.
						const shell = await request({ id: "shell", type: "bash", command: 'printf "<%s>" "$PI_NO_MCP"' });
						expect(shell.output).toContain(row.starts ? "<>" : "<1>");
					} finally {
						child.stdin.end();
						child.kill(undefined, 0);
						await child.exited.catch(() => {});
						await stopStartedServers(audit);
					}
				} finally {
					model.stdin.end();
					model.kill();
					await model.exited.catch(() => {});
					await removeWithRetries(root);
				}
			},
			240_000,
		);
	}
});

const readCases = [
	{ name: "a plain `omp read` that reaches MCP starts the user's servers", noMcpEnv: "", starts: true },
	{ name: "PI_NO_MCP=1 makes `omp read` start none of them", noMcpEnv: "1", starts: false },
] as const;

describe("omp read and the user's MCP servers", () => {
	for (const row of readCases) {
		test(
			row.name,
			async () => {
				const { root, project, audit, env } = await standInUser(row.noMcpEnv);
				try {
					// `mcp://` reaches MCP. The stub has no such resource, so a started stub
					// answers "no server has it"; with none started there is no manager to ask.
					const result = await ptree.exec([process.execPath, cli, "read", "mcp://stub/x"], {
						cwd: project,
						env,
						detached: true,
						timeout: 180_000,
						allowNonZero: true,
					});
					expect(await spawnedPids(audit), result.stderr).toHaveLength(row.starts ? 1 : 0);
					expect(result.stderr).toContain(
						row.starts ? 'No MCP server has resource "stub/x"' : "No MCP manager available",
					);
				} finally {
					await stopStartedServers(audit);
					await removeWithRetries(root);
				}
			},
			240_000,
		);
	}
});
