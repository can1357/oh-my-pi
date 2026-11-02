/**
 * A `lazy: true` MCP server starts on its first tool call, not before. In a
 * spawned omp that reads the user's MCP config, startup, the `xd://` listing
 * and the device's docs come from the tool catalog cached by an earlier
 * connect; neither the server's command nor its `!command` secret runs until
 * the model calls the tool, and then each runs exactly once.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import { isRecord, ptree, readJsonl, readLines, removeWithRetries } from "@oh-my-pi/pi-utils";

const device = "mcp__stub_regression_announce";
const deviceUri = `xd://${device}`;
const cli = path.join(import.meta.dir, "../src/cli.ts");
const peer = path.join(import.meta.dir, "fixtures/rpc-mcp-server.ts");
const fakeModel = path.join(import.meta.dir, "rpc-wire/fake-openai-server.ts");

type Frame = Record<string, unknown>;

async function auditEntries(audit: string): Promise<Frame[]> {
	const entries: unknown[] = Bun.JSONL.parse(await Bun.file(audit).text());
	return entries.map(entry => {
		if (!isRecord(entry)) throw new Error("Invalid MCP audit entry");
		return entry;
	});
}

async function spawnedPids(audit: string): Promise<number[]> {
	return (await auditEntries(audit)).flatMap(entry =>
		entry.event === "spawn" && typeof entry.pid === "number" ? [entry.pid] : [],
	);
}

/** How many times the server's `!command` secret ran (one line per run). */
async function secretRuns(log: string): Promise<number> {
	return (await Bun.file(log).text()).split("\n").filter(line => line === "resolved").length;
}

/** The single tool call a prompt made, and its result text. */
function toolResult(
	events: Frame[],
	toolName: string,
	args: Record<string, unknown>,
): { text: string; isError: unknown } {
	const starts = events.filter(event => event.type === "tool_execution_start");
	expect(starts).toHaveLength(1);
	expect(starts[0]).toMatchObject({ toolName, args });
	const ends = events.filter(event => event.type === "tool_execution_end");
	expect(ends).toHaveLength(1);
	const end = ends[0]!;
	expect(end.toolCallId).toBe(starts[0]!.toolCallId);
	const content = isRecord(end.result) && Array.isArray(end.result.content) ? end.result.content : [];
	const text = content
		.flatMap(part => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []))
		.join("\n");
	return { text, isError: end.isError };
}

/** Raw JSONL RPC over one spawned omp: one stdout reader for the whole session. */
function rpcSession(child: ptree.ChildProcess<"pipe">) {
	const frames = readJsonl<unknown>(child.stdout)[Symbol.asyncIterator]();
	const send = (frame: Frame): void => {
		child.stdin.write(`${JSON.stringify(frame)}\n`);
		child.stdin.flush();
	};
	const next = async (waitingFor: string): Promise<Frame> => {
		for (;;) {
			const read = await frames.next();
			if (read.done) throw new Error(`omp exited before ${waitingFor}: ${child.peekStderr()}`);
			if (isRecord(read.value)) return read.value;
		}
	};
	return {
		/** Send a command and return its response data. */
		async request(frame: Frame): Promise<Frame> {
			send(frame);
			for (;;) {
				const message = await next(`answering ${String(frame.type)}`);
				if (message.type === "response" && message.id === frame.id) {
					expect(message.success, child.peekStderr()).toBe(true);
					return isRecord(message.data) ? message.data : {};
				}
			}
		},
		/** Send a prompt and return the events it caused, up to its own `prompt_result`. */
		async prompt(id: string, message: string): Promise<Frame[]> {
			send({ id, type: "prompt", message });
			const events: Frame[] = [];
			for (;;) {
				const frame = await next(`completing prompt ${id}`);
				if (frame.type === "response" && frame.id === id) {
					expect(frame.success, child.peekStderr()).toBe(true);
					continue;
				}
				if (frame.type === "prompt_result" && frame.id === id) {
					expect(frame.status, JSON.stringify(frame.error)).toBe("completed");
					return events;
				}
				events.push(frame);
			}
		},
	};
}

describe("spawned omp and a lazy MCP server", () => {
	test("the command and its secret run on the first tool call, not at startup or listing", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-lazy-cli-"));
		// The stand-in user: their home and their agent dir, with one MCP server.
		const home = path.join(root, "home");
		const agentDir = path.join(home, ".omp/agent");
		const project = path.join(root, "project");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.mkdir(project);
		const audit = path.join(root, "audit.jsonl");
		const secretLog = path.join(root, "secret.log");
		const stub = {
			command: process.execPath,
			args: [peer, audit],
			env: { LAZY_TOKEN: `!echo resolved >> '${secretLog}'; printf token` },
		};
		const env = {
			PATH: `${path.dirname(process.execPath)}${path.delimiter}${Bun.env.PATH ?? ""}`,
			HOME: home,
			USERPROFILE: home,
			XDG_CONFIG_HOME: path.join(home, ".config"),
			PI_CONFIG_DIR: ".omp",
			PI_CODING_AGENT_DIR: agentDir,
			PI_NO_TITLE: "1",
			// Startup waits for every MCP handshake, so a started server has
			// recorded its spawn before the session answers get_state.
			OMP_MCP_STARTUP_TIMEOUT_MS: "0",
		};
		const launch = () =>
			ptree.spawn(
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
				{ cwd: project, env, stdin: "pipe", detached: true, timeout: 240_000 },
			);
		const reapStubs = async () => {
			for (const pid of await spawnedPids(audit)) {
				await Process.fromPid(pid)?.terminate({ gracefulMs: 0 });
			}
		};
		using model = ptree.spawn([process.execPath, fakeModel, agentDir], {
			cwd: project,
			env,
			stdin: "pipe",
			detached: true,
			timeout: 600_000,
		});
		try {
			let ready = "";
			for await (const line of readLines(model.stdout, AbortSignal.timeout(60_000))) {
				ready = new TextDecoder().decode(line);
				break;
			}
			expect(ready, model.peekStderr()).toMatch(/^READY \d+/);

			// Seed the tool cache the way a user's cache gets seeded: one eager
			// session connects the server, which also proves this command does
			// launch when nothing holds it back. `lazy` is not part of the
			// server's cache identity, so the lazy session below reads this entry.
			await Bun.write(audit, "");
			await Bun.write(secretLog, "");
			await Bun.write(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { stub } }));
			{
				using seed = launch();
				try {
					await rpcSession(seed).request({ id: "seed-state", type: "get_state" });
					expect(await spawnedPids(audit)).toHaveLength(1);
					expect(await secretRuns(secretLog)).toBe(1);
					seed.stdin.end();
					seed.attachTimeout(120_000);
					await seed.exited.catch(() => {});
				} finally {
					seed.kill(undefined, 0);
					await seed.exited.catch(() => {});
					await reapStubs();
				}
			}

			await Bun.write(audit, "");
			await Bun.write(secretLog, "");
			await Bun.write(
				path.join(agentDir, "mcp.json"),
				JSON.stringify({ mcpServers: { stub: { ...stub, lazy: true } } }),
			);
			using child = launch();
			const rpc = rpcSession(child);
			try {
				// Answered once the session exists: MCP startup has run by now.
				await rpc.request({ id: "state", type: "get_state" });
				expect(await spawnedPids(audit)).toEqual([]);
				expect(await secretRuns(secretLog)).toBe(0);

				// The cached catalog is registered: the device is listed and documented.
				const listing = toolResult(await rpc.prompt("list", "read_uri xd://"), "read", { path: "xd://" });
				expect(listing.text).toContain(device);
				const docs = toolResult(await rpc.prompt("docs", `read_uri ${deviceUri}`), "read", { path: deviceUri });
				expect(docs.text).toContain("Return an independently audited invocation marker.");
				expect(await spawnedPids(audit)).toEqual([]);
				expect(await secretRuns(secretLog)).toBe(0);

				// The first call starts the server once and reaches its tool.
				const call = toolResult(await rpc.prompt("call", `write_uri ${deviceUri} {}`), "write", {
					path: deviceUri,
					content: "{}",
				});
				expect(call.text).toContain("rpc-mcp-invoked");
				expect(call.isError).toBe(false);
				expect(await spawnedPids(audit)).toHaveLength(1);
				expect(await secretRuns(secretLog)).toBe(1);
				const calls = (await auditEntries(audit)).filter(entry => entry.method === "tools/call");
				expect(calls).toHaveLength(1);
				expect(calls[0]).toMatchObject({ params: { name: "regression_announce", arguments: {} } });
			} finally {
				child.stdin.end();
				child.kill(undefined, 0);
				await child.exited.catch(() => {});
				await reapStubs();
			}
		} finally {
			model.stdin.end();
			model.kill();
			await model.exited.catch(() => {});
			await removeWithRetries(root);
		}
	}, 600_000);
});
