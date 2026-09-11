import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setProcessName, TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import * as daemonClient from "../../src/launch/client";
import { createDaemonBrokerClient } from "../../src/launch/client";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonOperation,
} from "../../src/launch/protocol";
import * as terminalOutput from "../../src/launch/terminal-output";
import type { ToolSession } from "../../src/tools";
import { executeLaunch } from "../../src/tools/hub/launch";
import { shortenPath } from "../../src/tools/render-utils";

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

/** Start an in-process broker for `projectDir`, scoping its environment to the call. */
function startBroker(projectDir: string, runtimeDir: string): Promise<void> {
	const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
	const broker = startDaemonBrokerFromEnvironment();
	restoreEnv(DAEMON_PROJECT_DIR_ENV, previousProjectDir);
	restoreEnv(DAEMON_RUNTIME_DIR_ENV, previousRuntimeDir);
	restoreEnv(DAEMON_IDLE_GRACE_ENV, previousGrace);
	return broker;
}

async function withWorker(source: string, pty: boolean, run: (session: ToolSession) => Promise<void>): Promise<void> {
	using tempDir = TempDir.createSync("@omp-launch-delivery-");
	const projectDir = path.join(tempDir.path(), "project");
	const runtimeDir = path.join(tempDir.path(), "runtime");
	await fs.mkdir(projectDir);
	const scriptPath = path.join(projectDir, "worker.ts");
	await Bun.write(scriptPath, `${source}\nprocess.stdout.write("READY\\n");\n`);
	const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
	const previousTitle = process.title;
	const broker = startBroker(projectDir, runtimeDir);
	vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);
	const session = { cwd: projectDir } as ToolSession;
	try {
		await executeLaunch(session, {
			op: "start",
			name: "worker",
			application: process.execPath,
			args: [scriptPath],
			env: { BUN_BE_BUN: "1" },
			pty,
			ready: { log: "READY", timeout: 5 },
		});
		await run(session);
	} finally {
		await client.request({ op: "stop", name: "worker", timeoutMs: 2_000 }).catch(() => undefined);
		await client.request({ op: "shutdown" }).catch(() => undefined);
		client.close();
		await broker;
		setProcessName(previousTitle);
		vi.restoreAllMocks();
	}
}

describe("daemon broker log snapshots", () => {
	it("returns the cursor captured with the PTY bytes rendered in the response", async () => {
		using tempDir = TempDir.createSync("@omp-launch-cursor-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "service.ts");
		await Bun.write(
			scriptPath,
			`process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdout.write("READY\\n");
process.stdin.on("data", () => process.stdout.write("AFTER-SNAPSHOT\\n"));
`,
		);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const renderStarted = Promise.withResolvers<void>();
		const releaseRender = Promise.withResolvers<void>();
		const renderTerminalOutput = terminalOutput.renderTerminalOutput;
		vi.spyOn(terminalOutput, "renderTerminalOutput").mockImplementation(async (output, options) => {
			renderStarted.resolve();
			await releaseRender.promise;
			return renderTerminalOutput(output, options);
		});

		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);

		try {
			const started = await client.request({
				op: "start",
				spec: {
					name: "cursor",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: true,
					ready: { log: "READY", timeoutMs: 5_000 },
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			if (started.op !== "start") throw new Error("unexpected start result");
			expect(started.readyTimedOut).toBeFalse();

			const snapshotPromise = client.request({
				op: "logs",
				name: "cursor",
				lines: 20,
				head: false,
				follow: false,
				timeoutMs: 1_000,
				renderTerminalRows: true,
			} as DaemonOperation);
			await renderStarted.promise;
			await client.request({ op: "send", name: "cursor", data: "race\r" });
			const observed = await client.request({
				op: "wait",
				name: "cursor",
				for: "exit",
				pattern: "AFTER-SNAPSHOT",
				timeoutMs: 1_000,
			});
			if (observed.op !== "wait") throw new Error("unexpected wait result");
			expect(observed.timedOut).toBeFalse();
			releaseRender.resolve();

			const snapshot = await snapshotPromise;
			if (snapshot.op !== "logs") throw new Error("unexpected logs result");
			expect(snapshot.terminalRows?.join("\n")).not.toContain("AFTER-SNAPSHOT");

			const followed = await client.request({
				op: "logs",
				name: "cursor",
				lines: 20,
				head: false,
				follow: true,
				cursor: snapshot.cursor,
				timeoutMs: 1_000,
				renderTerminalRows: true,
			} as DaemonOperation);
			if (followed.op !== "logs") throw new Error("unexpected follow result");
			expect(followed.timedOut).toBeFalse();
			expect(followed.text).toContain("AFTER-SNAPSHOT");
		} finally {
			releaseRender.resolve();
			await client.request({ op: "stop", name: "cursor", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
			vi.restoreAllMocks();
		}
	}, 20_000);

	// A supervised program that probes the terminal (cursor position here) blocks
	// on the reply; nothing behind the broker's PTY answered, so it hung until its
	// own timeout. The broker now replies, and the reply bytes reach the program's
	// stdin without being echoed back into the captured log.
	it("answers terminal queries emitted by a supervised PTY", async () => {
		using tempDir = TempDir.createSync("@omp-launch-terminal-query-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "terminal-query.ts");
		await Bun.write(
			scriptPath,
			`process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
let input = "";
process.stdin.on("data", chunk => {
	input += chunk;
	const match = /\\x1b\\[(\\d+);(\\d+)R/.exec(input);
	if (!match) return;
	process.stdout.write("CPR:" + match[1] + ":" + match[2] + "\\n");
	process.exit(0);
});
process.stdout.write("READY\\x1b[6n");
`,
		);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		try {
			const started = await client.request({
				op: "start",
				spec: {
					name: "terminal-query",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: true,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			if (started.op !== "start") throw new Error("unexpected start result");

			const completed = await client.request({
				op: "wait",
				name: "terminal-query",
				for: "exit",
				timeoutMs: 2_000,
			});
			if (completed.op !== "wait") throw new Error("unexpected wait result");
			expect(completed.timedOut).toBeFalse();
			expect(completed.daemon.exitCode).toBe(0);

			const logs = await client.request({
				op: "logs",
				name: "terminal-query",
				lines: 20,
				head: false,
				follow: false,
				timeoutMs: 1_000,
			});
			if (logs.op !== "logs") throw new Error("unexpected logs result");
			expect(logs.text).toContain("CPR:1:1");
			expect(logs.text).not.toContain("\x1b[1;1R");
		} finally {
			await client.request({ op: "stop", name: "terminal-query", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);

	it("delivers a large structured result intact in either log direction", async () => {
		const response = { type: "response", payload: "x".repeat(300 * 1024), result: "RECOVERABLE-RESULT" };
		await withWorker(
			`process.stdout.write(${JSON.stringify(`${JSON.stringify(response)}\n`)});`,
			false,
			async session => {
				await executeLaunch(session, { op: "wait", name: "worker", for: "exit", timeout: 5 });
				for (const head of [true, false]) {
					const logs = await executeLaunch(session, {
						op: "logs",
						name: "worker",
						head,
						grep: "RECOVERABLE-RESULT",
					});
					const text = logs.content.find(part => part.type === "text")?.text ?? "";
					expect(JSON.parse(text.split("\n")[0])).toEqual(response);
				}
			},
		);
	}, 20_000);

	it("makes a match outside the byte window recoverable instead of implying no match", async () => {
		await withWorker(
			`process.stdout.write("OUTSIDE-WINDOW\\n" + "x".repeat(3 * 1024 * 1024) + "\\n");`,
			false,
			async session => {
				await executeLaunch(session, { op: "wait", name: "worker", for: "exit", timeout: 5 });
				const logs = await executeLaunch(session, {
					op: "logs",
					name: "worker",
					grep: "OUTSIDE-WINDOW",
				});
				const paths = logs.details?.truncatedLogPaths;
				expect(paths).toBeDefined();
				const recovered = await Promise.all(paths!.map(file => Bun.file(file).text()));
				expect(recovered.join("")).toContain("OUTSIDE-WINDOW");
				const text = logs.content.find(part => part.type === "text")?.text ?? "";
				// Model-facing text shortens $HOME; details keep the exact paths for tooling.
				expect(text).not.toContain(process.env.HOME ?? "\u0000");
				expect(paths!.every(file => text.includes(shortenPath(file)))).toBeTrue();
			},
		);
	}, 20_000);

	it.each([false, true])(
		"submits one command with the correct Enter for pty=%s",
		async pty => {
			await withWorker(
				`if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
let input = "";
process.stdin.on("data", chunk => {
	input += chunk;
	if (!input.endsWith(String.fromCharCode(${pty ? 13 : 10}))) return;
	process.stdout.write("RECEIVED:" + JSON.stringify(input) + "\\n");
	process.exit(0);
});`,
				pty,
				async session => {
					await executeLaunch(session, { op: "send", name: "worker", text: "command" });
					const completed = await executeLaunch(session, { op: "wait", name: "worker", for: "exit", timeout: 1 });
					expect(completed.details?.timedOut).toBeFalse();
					expect(completed.details?.daemon?.exitCode).toBe(0);
					const logs = await executeLaunch(session, { op: "logs", name: "worker", grep: "RECEIVED:" });
					const text = logs.content.find(part => part.type === "text")?.text ?? "";
					expect(text).toContain(`RECEIVED:${JSON.stringify(`command${pty ? "\r" : "\n"}`)}`);
				},
			);
		},
		20_000,
	);

	it("preserves raw carriage returns and submits a pipe with an explicit Enter key", async () => {
		await withWorker(
			`process.stdin.setEncoding("utf8");
let input = "";
process.stdin.on("data", chunk => {
	input += chunk;
	if (!input.endsWith("\\n")) return;
	process.stdout.write("RECEIVED:" + JSON.stringify(input) + "\\n");
	process.exit(0);
});`,
			false,
			async session => {
				await executeLaunch(session, { op: "send", name: "worker", text: "first\rsecond", enter: false });
				await executeLaunch(session, { op: "send", name: "worker", keys: ["ENTER"] });
				const completed = await executeLaunch(session, { op: "wait", name: "worker", for: "exit", timeout: 1 });
				expect(completed.details?.timedOut).toBeFalse();
				const logs = await executeLaunch(session, { op: "logs", name: "worker", grep: "RECEIVED:" });
				const text = logs.content.find(part => part.type === "text")?.text ?? "";
				expect(text).toContain(`RECEIVED:${JSON.stringify("first\rsecond\n")}`);
			},
		);
	}, 20_000);

	it("resolves the broker's key capability once per connection, not once per send", async () => {
		await withWorker(
			`process.stdin.setEncoding("utf8");
let lines = 0;
process.stdin.on("data", chunk => {
	lines += chunk.split("\\n").length - 1;
	if (lines >= 3) process.exit(0);
});`,
			false,
			async session => {
				const client = await daemonClient.daemonClientForProject(session.cwd);
				const request = vi.spyOn(client, "request");
				for (let i = 0; i < 3; i++) await executeLaunch(session, { op: "send", name: "worker", text: `line ${i}` });
				const completed = await executeLaunch(session, { op: "wait", name: "worker", for: "exit", timeout: 1 });
				expect(completed.details?.timedOut).toBeFalse();
				const ops = request.mock.calls.map(([operation]) => operation.op);
				expect(ops.filter(op => op === "ping")).toHaveLength(1);
				expect(ops.filter(op => op === "send")).toHaveLength(3);
			},
		);
	}, 20_000);
});
