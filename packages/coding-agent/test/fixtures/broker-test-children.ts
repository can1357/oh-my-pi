/**
 * Run by auth-broker-test-children.test.ts as a direct `bun test`, started without the
 * test-runtime marker, the way a developer's `bun test` starts. It starts an omp RPC child
 * and an omp ACP child the way tests do and completes each protocol's startup. Each child
 * gets its own home and agent dir but keeps the auth broker the environment names, so the
 * parent can count the requests that reached that broker. It also runs credential discovery
 * in a child that a native shell, a native terminal and a Worker each start with the
 * environment it inherits, which the parent has already given a home of its own.
 */
import { expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { PtySession, Shell } from "@oh-my-pi/pi-natives";
import { readLines, TempDir } from "@oh-my-pi/pi-utils";

const cliPath = path.join(import.meta.dir, "..", "..", "src", "cli.ts");
const discoveryChild = path.join(import.meta.dir, "broker-discovery-child.ts");

/** What broker-discovery-child.ts reports as a test child: it read no broker credential. */
const TEST_CHILD_DISCOVERY = { exitCode: 0, report: { testRuntime: true, brokerKey: null } };

function discoveryResult(exitCode: number | undefined, output: string): { exitCode?: number; report: unknown } {
	const line = output.split(/\r?\n/).find(entry => entry.startsWith("DISCOVERY "));
	return { exitCode, report: line === undefined ? output : JSON.parse(line.slice("DISCOVERY ".length)) };
}

async function nativeDiscovery(
	start: (onChunk: (error: Error | null, chunk: string) => void) => Promise<{ exitCode?: number }>,
): Promise<{ exitCode?: number; report: unknown }> {
	let output = "";
	const { exitCode } = await start((error, chunk) => {
		if (error) throw error;
		output += chunk;
	});
	return discoveryResult(exitCode, output);
}

function isolatedEnv(dir: TempDir): Record<string, string> {
	fs.mkdirSync(dir.join("home"));
	fs.mkdirSync(dir.join("agent"));
	return {
		HOME: dir.join("home"),
		USERPROFILE: dir.join("home"),
		PI_CODING_AGENT_DIR: dir.join("agent"),
		PI_NO_TITLE: "1",
	};
}

it("starts an RPC child and reads its state", async () => {
	using dir = TempDir.createSync("@omp-broker-rpc-child-");
	const client = new RpcClient({
		cliPath,
		cwd: dir.path(),
		env: isolatedEnv(dir),
		provider: "openai",
		model: "gpt-4o-mini",
		args: ["--no-session", "--no-extensions"],
	});
	try {
		await client.start();
		expect(await client.getState()).toMatchObject({ model: expect.objectContaining({ id: "gpt-4o-mini" }) });
	} finally {
		await client.stop();
	}
}, 30_000);

it("starts an ACP child and opens a session", async () => {
	using dir = TempDir.createSync("@omp-broker-acp-child-");
	const env = isolatedEnv(dir);
	await Bun.write(dir.join("agent", "config.yml"), "defaultModel: openai/gpt-4o-mini\n");
	const child = Bun.spawn([process.execPath, cliPath, "acp", "--no-extensions"], {
		cwd: dir.path(),
		env: { ...process.env, ...env },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const stderr = new Response(child.stderr).text();
	const lines = readLines(child.stdout, AbortSignal.timeout(25_000));
	const decoder = new TextDecoder();
	const call = async (id: number, method: string, params: object): Promise<Record<string, unknown>> => {
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		await child.stdin.flush();
		for (;;) {
			const line = await lines.next();
			if (line.done) throw new Error(`ACP child exited: ${await stderr}`);
			const frame: Record<string, unknown> = JSON.parse(decoder.decode(line.value));
			if (frame.id === id) return frame;
		}
	};
	try {
		const initialized = await call(1, "initialize", {
			protocolVersion: 1,
			clientCapabilities: { auth: { terminal: true } },
		});
		expect(initialized.error).toBeUndefined();
		const session = await call(2, "session/new", { cwd: dir.path(), mcpServers: [] });
		expect(session).toMatchObject({ result: { sessionId: expect.any(String) } });
	} finally {
		child.stdin.end();
		child.kill("SIGKILL");
		await child.exited;
	}
}, 30_000);

it("runs credential discovery in a child of a native shell", async () => {
	const command = [process.execPath, discoveryChild].map(word => `'${word.replaceAll("'", `'\\''`)}'`).join(" ");
	const result = await nativeDiscovery(onChunk => new Shell().run({ command, timeoutMs: 25_000 }, onChunk));
	expect(result).toEqual(TEST_CHILD_DISCOVERY);
}, 30_000);

it("runs credential discovery in a child of a native terminal", async () => {
	const result = await nativeDiscovery(onChunk =>
		new PtySession().startArgv({ application: process.execPath, args: [discoveryChild], timeoutMs: 25_000 }, onChunk),
	);
	expect(result).toEqual(TEST_CHILD_DISCOVERY);
}, 30_000);

it("runs credential discovery in a child a Worker spawns", async () => {
	const worker = new Worker(new URL("./broker-discovery-worker.ts", import.meta.url));
	const done = Promise.withResolvers<{ output: string; exitCode: number }>();
	worker.onmessage = event => done.resolve(event.data);
	worker.onerror = event => done.reject(new Error(event.message));
	try {
		const { output, exitCode } = await done.promise;
		expect(discoveryResult(exitCode, output)).toEqual(TEST_CHILD_DISCOVERY);
	} finally {
		worker.terminate();
	}
}, 30_000);
