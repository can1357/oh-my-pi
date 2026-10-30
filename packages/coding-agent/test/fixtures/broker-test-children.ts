/**
 * Run by auth-broker-test-children.test.ts as a direct `bun test`, started without the
 * test-runtime marker, the way a developer's `bun test` starts. It starts an omp RPC child
 * and an omp ACP child the way tests do and completes each protocol's startup. Each child
 * gets its own home and agent dir but keeps the auth broker the environment names, so the
 * parent can count the requests that reached that broker.
 */
import { expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { readLines, TempDir } from "@oh-my-pi/pi-utils";

const cliPath = path.join(import.meta.dir, "..", "..", "src", "cli.ts");

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
