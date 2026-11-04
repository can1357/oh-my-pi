import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { IpcConnection } from "@oh-my-pi/pi-natives";
import { readLines } from "@oh-my-pi/pi-utils";

import { isRecord } from "@oh-my-pi/pi-utils/type-guards";

const PACKAGE_ROOT = path.resolve(import.meta.dir, "../..");
const OWNER_PATH = path.join(import.meta.dir, "owner-process.ts");
const CLI_PATH = path.join(PACKAGE_ROOT, "src/cli.ts");
const AGENT_ID = "AgentSmoke";
const OWNER_TIMEOUT_MS = 15_000;
const CLI_TIMEOUT_MS = 30_000;
const liveChildren: { kill(signal?: NodeJS.Signals): void; exited: Promise<number> }[] = [];
const liveTerminals: Bun.Terminal[] = [];
const cleanupDirs: string[] = [];

const MetadataShape = type({
	"+": "delete",
	version: "1",
	ownerSessionId: "string",
	endpoint: "string",
	token: "string",
});
const ErrorFrameShape = type({ type: '"error"', code: "string", message: "string" });

interface CapturedOutput {
	text(): string;
	done: Promise<void>;
}

interface OwnerProcess {
	child: Bun.Subprocess<"pipe", "pipe", "pipe">;
	lines: AsyncIterator<Uint8Array>;
	decoder: TextDecoder;
	ready: Record<string, unknown>;
	stderr: CapturedOutput;
}
function capture(stream: ReadableStream<Uint8Array>): CapturedOutput {
	let text = "";
	const done = (async () => {
		const decoder = new TextDecoder();
		for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
		text += decoder.decode();
	})();
	return { text: () => text, done };
}

async function nextMessage(lines: AsyncIterator<Uint8Array>, decoder: TextDecoder): Promise<Record<string, unknown>> {
	const line = await lines.next();
	if (line.done) throw new Error("owner fixture exited before replying");
	const message: unknown = JSON.parse(decoder.decode(line.value));
	if (!isRecord(message)) throw new Error("owner fixture returned a non-object message");
	return message;
}

async function startOwner(home: string, ownerSessionId: string, cwd?: string): Promise<OwnerProcess> {
	const child = Bun.spawn([process.execPath, OWNER_PATH], {
		cwd: PACKAGE_ROOT,
		env: { ...cliEnv(home), OMP_ATTACH_OWNER_ID: ownerSessionId, OMP_ATTACH_AGENT_ID: AGENT_ID, OMP_ATTACH_CWD: cwd },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	liveChildren.push(child);
	const lines = readLines(child.stdout, AbortSignal.timeout(OWNER_TIMEOUT_MS));
	const stderr = capture(child.stderr);
	const decoder = new TextDecoder();
	const ready = await nextMessage(lines, decoder);
	expect(ready).toMatchObject({ type: "ready", ownerSessionId, agentId: AGENT_ID });
	return { child, lines, decoder, ready, stderr };
}

async function ownerMessage(owner: OwnerProcess, command: string): Promise<Record<string, unknown>> {
	owner.child.stdin.write(`${command}\n`);
	await owner.child.stdin.flush();
	return nextMessage(owner.lines, owner.decoder);
}

async function temporaryHome(): Promise<string> {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agent-attach-"));
	cleanupDirs.push(home);
	return home;
}

function cliEnv(home: string): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {
		PATH: process.env.PATH,
		HOME: home,
		TMPDIR: process.env.TMPDIR,
		TMP: process.env.TMP,
		TEMP: process.env.TEMP,
		LANG: process.env.LANG,
		LC_ALL: process.env.LC_ALL,
		TERM: process.env.TERM ?? "xterm-256color",
		XDG_CONFIG_HOME: home,
		XDG_DATA_HOME: home,
		NO_COLOR: "1",
	};
	return env;
}

function spawnPtyCli(home: string, args: string[]) {
	if (process.platform === "win32") throw new Error("Bun's PTY runner is unavailable on Windows");
	let output = "";
	const decoder = new TextDecoder();
	const terminal = new Bun.Terminal({
		cols: 120,
		rows: 40,
		data(_terminal, data) {
			output += decoder.decode(data, { stream: true });
		},
	});
	liveTerminals.push(terminal);
	const child = Bun.spawn([process.execPath, CLI_PATH, ...args], {
		cwd: PACKAGE_ROOT,
		env: cliEnv(home),
		terminal,
	});
	liveChildren.push(child);
	const stdout: CapturedOutput = {
		text: () => output,
		done: child.exited.then(() => {
			terminal.close();
			output += decoder.decode();
		}),
	};
	return {
		child,
		stdout,
		async waitFor(text: string, timeoutMs = CLI_TIMEOUT_MS): Promise<void> {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				if (Bun.stripANSI(stdout.text()).includes(text)) return;
				await Bun.sleep(25);
			}
			throw new Error(
				`PTY output did not contain ${JSON.stringify(text)}: ${Bun.stripANSI(stdout.text()).slice(-4000)}`,
			);
		},
		write(text: string) {
			terminal.write(text);
		},
	};
}

async function waitForOwnerState(
	owner: OwnerProcess,
	condition: (state: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
	const deadline = Date.now() + OWNER_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const state = await ownerMessage(owner, "state");
		if (condition(state)) return state;
		await Bun.sleep(50);
	}
	throw new Error("owner state did not reach the expected attachment transition");
}

afterEach(async () => {
	for (const child of liveChildren.splice(0)) {
		try {
			child.kill("SIGKILL");
			await child.exited;
		} catch {
			// Already exited.
		}
	}
	for (const terminal of liveTerminals.splice(0)) terminal.close();
	while (cleanupDirs.length > 0) {
		const dir = cleanupDirs.pop();
		if (dir) await fs.rm(dir, { recursive: true, force: true });
	}
});

describe("agent attach (socket and real CLI PTY)", () => {
	it("authenticates, scopes exact owners, steers and aborts the child, then detaches without ending it", async () => {
		const home = await temporaryHome();
		const owners = [
			await startOwner(home, "owner-one"),
			await startOwner(home, "owner-two", "/tmp/attach\tcwd\ninjected\x1b[31mred\x1b[0m"),
		];
		const readyTwo = owners[1]!.ready;
		expect(readyTwo.available).toEqual({
			id: AGENT_ID,
			ownerSessionId: "owner-two",
			generation: 7,
			argv: ["agent", "attach", AGENT_ID, "--owner", "owner-two"],
		});
		expect(JSON.stringify(readyTwo)).not.toContain("token");

		const attachDir = path.join(home, ".omp", "run", "agent-attach");
		if (process.platform !== "win32") expect((await fs.stat(attachDir)).mode & 0o777).toBe(0o700);
		const metadataFiles = (await fs.readdir(attachDir)).filter(file => file.endsWith(".json"));
		expect(metadataFiles).toHaveLength(2);
		const metadataPath = path.join(attachDir, metadataFiles[0]!);
		if (process.platform !== "win32") expect((await fs.stat(metadataPath)).mode & 0o777).toBe(0o600);
		const metadataValue: unknown = JSON.parse(await fs.readFile(metadataPath, "utf8"));
		const metadata = MetadataShape.assert(metadataValue);
		const badConnection = await IpcConnection.connect(metadata.endpoint, { framing: "lines", timeoutMs: 2_000 });
		const denied = Promise.withResolvers<string>();
		badConnection.start(
			line => denied.resolve(line),
			() => {},
		);
		badConnection.send(
			JSON.stringify({
				v: 1,
				op: "lookup",
				token: "wrong-token",
				ownerSessionId: metadata.ownerSessionId,
				agentId: AGENT_ID,
			}),
		);
		const denialText = await Promise.race([
			denied.promise,
			Bun.sleep(3_000).then(() => Promise.reject(new Error("auth timed out"))),
		]);
		const denialValue: unknown = JSON.parse(denialText);
		const deniedFrame = ErrorFrameShape.assert(denialValue);
		expect(deniedFrame.code).toBe("unauthorized");
		badConnection.destroy();
		const targetOwner = owners.find(owner => owner.ready.ownerSessionId === metadata.ownerSessionId);
		if (!targetOwner) throw new Error("metadata referred to an unknown owner");
		const untouched = await ownerMessage(targetOwner, "state");
		expect(untouched.snapshotCalls).toBe(0);
		if (process.platform === "win32") {
			for (const owner of owners) {
				owner.child.stdin.write("close\n");
				await owner.child.stdin.flush();
			}
			await Promise.all(owners.map(owner => owner.child.exited));
			await Promise.all(owners.map(owner => owner.stderr.done));
			expect(owners.map(owner => owner.stderr.text())).toEqual(["", ""]);
			return;
		}

		const ambiguous = spawnPtyCli(home, ["agent", "attach", AGENT_ID]);
		const ambiguousCode = await ambiguous.child.exited;
		await ambiguous.stdout.done;
		expect(ambiguousCode).toBe(1);
		expect(Bun.stripANSI(ambiguous.stdout.text())).toContain("More than one live subagent matches");
		expect(Bun.stripANSI(ambiguous.stdout.text())).toContain("owner-one, owner-two");

		const attached = spawnPtyCli(home, ["agent", "attach", AGENT_ID, "--owner", "owner-two"]);
		await attached.waitFor("Attached");
		await attached.waitFor("attach transcript fixture");
		await attached.waitFor("/tmp/attach cwd injectedred");
		const steeringText = "steer from second process";
		await attached.write(`${steeringText}\r`);
		const steeredState = await waitForOwnerState(
			owners[1]!,
			state => Array.isArray(state.steered) && state.steered.includes(steeringText),
		);
		expect(steeredState.status).toBe("running");
		await attached.write("\x03");
		const abortedState = await waitForOwnerState(owners[1]!, state => state.aborted === true);
		expect(abortedState.status).toBe("running");
		await ownerMessage(owners[1]!, "clear-aborted");
		await attached.write("\x04");
		const detachedCode = await attached.child.exited;
		await attached.stdout.done;
		expect(detachedCode).toBe(0);
		const stillLive = await ownerMessage(owners[1]!, "state");
		expect(stillLive.aborted).toBe(false);

		await ownerMessage(owners[1]!, "idle");
		const idleAttach = spawnPtyCli(home, ["agent", "attach", AGENT_ID, "--owner", "owner-two"]);
		await idleAttach.waitFor("Attached");
		const idleSteeringText = "steer while idle";
		await idleAttach.write(`${idleSteeringText}\r`);
		const idleState = await waitForOwnerState(
			owners[1]!,
			state => Array.isArray(state.steered) && state.steered.includes(idleSteeringText),
		);
		expect(idleState.status).toBe("idle");
		await idleAttach.write("\x04");
		const idleDetachedCode = await idleAttach.child.exited;
		await idleAttach.stdout.done;
		expect(idleDetachedCode).toBe(0);
		const stillIdle = await ownerMessage(owners[1]!, "state");
		expect(stillIdle.status).toBe("idle");
		expect(stillIdle.aborted).toBe(false);
		await ownerMessage(owners[1]!, "running");
		expect(stillLive.status).toBe("running");

		const ending = spawnPtyCli(home, ["agent", "attach", AGENT_ID, "--owner", "owner-two"]);
		await ending.waitFor("Attached");
		await ownerMessage(owners[1]!, "end");
		const endedCode = await ending.child.exited;
		await ending.stdout.done;
		expect(endedCode).toBe(1);
		expect(Bun.stripANSI(ending.stdout.text())).toContain("connection to subagent AgentSmoke ended");
		const unrelatedOwner = await ownerMessage(owners[0]!, "state");
		expect(unrelatedOwner.status).toBe("running");

		for (const owner of owners) {
			owner.child.stdin.write("close\n");
			await owner.child.stdin.flush();
		}
		await Promise.all(owners.map(owner => owner.child.exited));
		await Promise.all(owners.map(owner => owner.stderr.done));
		expect(owners.map(owner => owner.stderr.text())).toEqual(["", ""]);
	}, 90_000);
});
