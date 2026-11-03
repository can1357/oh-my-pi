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
import { RpcClient } from "../src/modes/rpc/rpc-client";
import { setNoMcpEnvForTest } from "./helpers/no-mcp-env";

const cli = path.join(import.meta.dir, "../src/cli.ts");
const peer = path.join(import.meta.dir, "fixtures/rpc-mcp-server.ts");
const fakeModel = path.join(import.meta.dir, "rpc-wire/fake-openai-server.ts");
const sessionProbe = path.join(import.meta.dir, "fixtures/no-mcp-session-probe.ts");

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
	/** File the server's `!command` env value creates if omp ever resolves it. */
	commandMarker: string;
	env: Record<string, string>;
}

/**
 * The stand-in user: their home and their agent dir, with one MCP server whose
 * env carries a `!command` value. `noMcpEnv` undefined leaves `PI_NO_MCP` out
 * of the environment altogether.
 */
async function standInUser(noMcpEnv: string | undefined): Promise<StandInUser> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-no-mcp-"));
	const home = path.join(root, "home");
	const agentDir = path.join(home, ".omp/agent");
	const project = path.join(root, "project");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(project);
	const audit = path.join(root, "audit.jsonl");
	const commandMarker = path.join(root, "command-ran");
	await Bun.write(audit, "");
	await Bun.write(
		path.join(agentDir, "mcp.json"),
		JSON.stringify({
			mcpServers: {
				stub: {
					command: process.execPath,
					args: [peer, audit],
					env: { STUB_TOKEN: `!printf token; printf ran > '${commandMarker}'` },
				},
			},
		}),
	);
	const env: Record<string, string> = {
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
	};
	if (noMcpEnv !== undefined) env.PI_NO_MCP = noMcpEnv;
	return { root, agentDir, project, audit, commandMarker, env };
}

async function stopStartedServers(audit: string): Promise<void> {
	for (const pid of await spawnedPids(audit)) {
		await Process.fromPid(pid)?.terminate({ gracefulMs: 0 });
	}
}

const RPC_ARGS = [
	"--model",
	"fake/fake-model",
	"--no-extensions",
	"--no-skills",
	"--no-rules",
	"--no-lsp",
	"--no-prewalk",
];

/** Run `body` while the stand-in user's fake model server is up. */
async function withFakeModel(user: StandInUser, body: () => Promise<void>): Promise<void> {
	using model = ptree.spawn([process.execPath, fakeModel, user.agentDir], {
		cwd: user.project,
		env: user.env,
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
		await body();
	} finally {
		model.stdin.end();
		model.kill();
		await model.exited.catch(() => {});
	}
}

type RpcRequest = (frame: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** Run `body` against an `omp --mode rpc` the stand-in user started with `args`. */
async function withRpcOmp(
	user: StandInUser,
	args: readonly string[],
	body: (request: RpcRequest) => Promise<void>,
): Promise<void> {
	using child = ptree.spawn([process.execPath, cli, "--mode", "rpc", ...RPC_ARGS, ...args], {
		cwd: user.project,
		env: user.env,
		stdin: "pipe",
		detached: true,
		timeout: 180_000,
	});
	// One reader for the whole session: a `for await` that returns early would close it.
	const responses = readJsonl<unknown>(child.stdout)[Symbol.asyncIterator]();
	const request: RpcRequest = async frame => {
		child.stdin.write(`${JSON.stringify(frame)}\n`);
		child.stdin.flush();
		for (;;) {
			const next = await responses.next();
			if (next.done) throw new Error(`omp exited before answering ${String(frame.type)}: ${child.peekStderr()}`);
			const message = next.value;
			if (isRecord(message) && message.type === "response" && message.id === frame.id) {
				expect(message.success, child.peekStderr()).toBe(true);
				return isRecord(message.data) ? message.data : {};
			}
		}
	};
	try {
		await body(request);
	} finally {
		child.stdin.end();
		child.kill(undefined, 0);
		await child.exited.catch(() => {});
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
				const user = await standInUser(row.noMcpEnv);
				try {
					await withFakeModel(user, () =>
						withRpcOmp(user, row.args, async request => {
							// Answered once the session exists: MCP startup has run by now.
							await request({ id: "state", type: "get_state" });
							expect(await spawnedPids(user.audit)).toHaveLength(row.starts ? 1 : 0);
							// What omp starts (a shell here, an omp it re-enters elsewhere) carries the choice.
							const shell = await request({
								id: "shell",
								type: "bash",
								command: 'printf "<%s>" "$PI_NO_MCP"',
							});
							expect(shell.output).toContain(row.starts ? "<>" : "<1>");
						}),
					);
				} finally {
					await stopStartedServers(user.audit);
					await removeWithRetries(user.root);
				}
			},
			240_000,
		);
	}

	test("--no-mcp reaches a shell, and the omp it runs, when the project .env sets PI_NO_MCP=0", async () => {
		// The launch environment has no PI_NO_MCP at all, so the project's .env value is
		// the only one a child shell would otherwise see.
		const user = await standInUser(undefined);
		await Bun.write(path.join(user.project, ".env"), "PI_NO_MCP=0\n");
		try {
			await withFakeModel(user, () =>
				withRpcOmp(user, ["--no-mcp"], async request => {
					await request({ id: "state", type: "get_state" });
					expect(await spawnedPids(user.audit)).toHaveLength(0);
					const shell = await request({ id: "shell", type: "bash", command: 'printf "<%s>" "$PI_NO_MCP"' });
					expect(shell.output).toContain("<1>");
					const nested = await request({
						id: "nested",
						type: "bash",
						command: `"${process.execPath}" "${cli}" read mcp://stub/x`,
					});
					expect(await spawnedPids(user.audit), String(nested.output)).toHaveLength(0);
					expect(nested.output).toContain("No MCP manager available");
				}),
			);
		} finally {
			await stopStartedServers(user.audit);
			await removeWithRetries(user.root);
		}
	}, 240_000);

	test("an RpcClient with noMcp starts none of them", async () => {
		const user = await standInUser("");
		try {
			await withFakeModel(user, async () => {
				const client = new RpcClient({
					command: [process.execPath, cli],
					cwd: user.project,
					env: user.env,
					args: RPC_ARGS,
					noMcp: true,
				});
				try {
					await client.start();
					await client.getState();
					expect(await spawnedPids(user.audit)).toHaveLength(0);
				} finally {
					await client.stop();
				}
			});
		} finally {
			await stopStartedServers(user.audit);
			await removeWithRetries(user.root);
		}
	}, 240_000);

	// Round-5 review: an `env` the host passes (here a snapshot with
	// `PI_NO_MCP=""`) turned MCP back on for the child while the host had it off.
	test('an RpcClient whose env says PI_NO_MCP="" starts none of them while its host has MCP off', async () => {
		const user = await standInUser("");
		setNoMcpEnvForTest("1");
		try {
			await withFakeModel(user, async () => {
				const client = new RpcClient({
					command: [process.execPath, cli],
					cwd: user.project,
					env: user.env,
					args: RPC_ARGS,
				});
				try {
					await client.start();
					await client.getState();
					expect(await spawnedPids(user.audit)).toHaveLength(0);
				} finally {
					await client.stop();
				}
			});
		} finally {
			await stopStartedServers(user.audit);
			await removeWithRetries(user.root);
		}
	}, 240_000);
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

describe("`--no-mcp` placement before non-launch commands", () => {
	for (const args of [
		["--no-mcp", "read", "mcp://stub/x"],
		["read", "--no-mcp", "mcp://stub/x"],
	] as const) {
		test(`${args.join(" ")} starts none of the user's servers`, async () => {
			const { root, project, audit, env } = await standInUser("");
			try {
				const result = await ptree.exec([process.execPath, cli, ...args], {
					cwd: project,
					env,
					detached: true,
					timeout: 180_000,
					allowNonZero: true,
				});
				expect(await spawnedPids(audit), result.stderr).toHaveLength(0);
				expect(result.stderr).not.toContain("Unknown option");
				expect(result.stderr).toContain("No MCP manager available");
			} finally {
				await stopStartedServers(audit);
				await removeWithRetries(root);
			}
		}, 240_000);
	}

	// Both need a terminal past their parser; an unknown flag fails before that check.
	for (const [command, refusal] of [
		["join", "requires an interactive terminal"],
		["setup", "requires an interactive TTY"],
	] as const) {
		test(`${command} accepts --no-mcp after its name`, async () => {
			const { root, project, env } = await standInUser("");
			try {
				const args = command === "join" ? [command, "--no-mcp", "relay.example/abc#key"] : [command, "--no-mcp"];
				const result = await ptree.exec([process.execPath, cli, ...args], {
					cwd: project,
					env,
					detached: true,
					timeout: 180_000,
					allowNonZero: true,
				});
				expect(result.stderr).not.toContain("Unknown option");
				expect(result.stderr).toContain(refusal);
			} finally {
				await removeWithRetries(root);
			}
		}, 240_000);
	}
});

type AcpReply = { result?: unknown; error?: unknown; updates: string };
type AcpCall = (method: string, params: Record<string, unknown>) => Promise<AcpReply>;

/** Run `body` against an `omp --mode acp` the stand-in user started with `args`. */
async function withAcpOmp(user: StandInUser, args: readonly string[], body: (call: AcpCall) => Promise<void>) {
	using child = ptree.spawn([process.execPath, cli, "--mode", "acp", ...RPC_ARGS, ...args], {
		cwd: user.project,
		env: user.env,
		stdin: "pipe",
		detached: true,
		timeout: 180_000,
	});
	const frames = readJsonl<unknown>(child.stdout)[Symbol.asyncIterator]();
	let nextId = 1;
	const call: AcpCall = async (method, params) => {
		const id = nextId++;
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		child.stdin.flush();
		let updates = "";
		for (;;) {
			const next = await frames.next();
			if (next.done) throw new Error(`omp exited before answering ${method}: ${child.peekStderr()}`);
			const frame = next.value;
			if (!isRecord(frame)) continue;
			if (frame.id === id && ("result" in frame || "error" in frame)) {
				return { result: frame.result, error: frame.error, updates };
			}
			// What a slash command reports reaches the client as session updates.
			if (frame.method === "session/update") updates += JSON.stringify(frame.params);
		}
	};
	try {
		await body(call);
	} finally {
		child.stdin.end();
		child.kill(undefined, 0);
		await child.exited.catch(() => {});
	}
}

describe("ACP and MCP servers while MCP is disabled", () => {
	for (const row of [
		{ name: "--no-mcp", args: ["--no-mcp"], noMcpEnv: "" },
		{ name: "PI_NO_MCP=1", args: [], noMcpEnv: "1" },
	] as const) {
		test(`under ${row.name}, client-declared servers and /mcp test, resources and prompts start none`, async () => {
			const user = await standInUser(row.noMcpEnv);
			try {
				await withFakeModel(user, () =>
					withAcpOmp(user, row.args, async call => {
						const init = await call("initialize", {
							protocolVersion: 1,
							clientCapabilities: {},
							clientInfo: { name: "no-mcp-test", version: "1" },
						});
						expect(init.error).toBeUndefined();
						const created = await call("session/new", {
							cwd: user.project,
							mcpServers: [
								{ name: "client-stub", command: process.execPath, args: [peer, user.audit], env: [] },
							],
						});
						expect(created.error).toBeUndefined();
						expect(await spawnedPids(user.audit)).toHaveLength(0);
						const sessionId = isRecord(created.result) ? created.result.sessionId : undefined;
						for (const command of ["/mcp test stub", "/mcp resources", "/mcp prompts"]) {
							const reply = await call("session/prompt", {
								sessionId,
								prompt: [{ type: "text", text: command }],
							});
							expect(reply.error, command).toBeUndefined();
							expect(await spawnedPids(user.audit), command).toHaveLength(0);
							expect(reply.updates, command).toContain("MCP is disabled");
						}
						// The configured server's `!command` env value never ran.
						expect(await Bun.file(user.commandMarker).exists()).toBe(false);
					}),
				);
			} finally {
				await stopStartedServers(user.audit);
				await removeWithRetries(user.root);
			}
		}, 240_000);
	}
});

describe("in-process MCP starts and the MCP policy they inherit", () => {
	for (const row of [
		{ mode: "revive", what: "a revived persisted subagent", noMcpEnv: "", starts: true },
		{ mode: "revive", what: "a revived persisted subagent", noMcpEnv: "1", starts: false },
		{
			mode: "revive-parent-off",
			what: "a subagent revived under a parent running with MCP off",
			noMcpEnv: "",
			starts: false,
		},
		{ mode: "discover", what: "the SDK's discoverMCPServers", noMcpEnv: "", starts: true },
		{ mode: "discover", what: "the SDK's discoverMCPServers", noMcpEnv: "1", starts: false },
	] as const) {
		test(`with PI_NO_MCP=${JSON.stringify(row.noMcpEnv)}, ${row.what} ${row.starts ? "starts" : "starts none of"} the user's servers`, async () => {
			const user = await standInUser(row.noMcpEnv);
			try {
				const result = await ptree.exec([process.execPath, sessionProbe, row.mode, user.project], {
					cwd: user.project,
					env: user.env,
					detached: true,
					timeout: 180_000,
					allowNonZero: true,
				});
				expect(result.exitCode, result.stderr).toBe(0);
				expect(await spawnedPids(user.audit), result.stderr).toHaveLength(row.starts ? 1 : 0);
				expect(await Bun.file(user.commandMarker).exists()).toBe(row.starts);
			} finally {
				await stopStartedServers(user.audit);
				await removeWithRetries(user.root);
			}
		}, 240_000);
	}
});
