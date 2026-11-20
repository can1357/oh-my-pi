/**
 * PTY `proc` units with attached viewers, against a real daemon isolated in a
 * temp dir: resize, tunnel input decoding, exclusive attach, query-responder
 * gating while a viewer is attached, and the cleared launch environment.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { IpcConnection, ipcEndpoint } from "@oh-my-pi/pi-natives";
import { DAEMON_PROTOCOL_VERSION, type ProcSpec } from "../../src/daemon/protocol";
import { type DaemonConn, rejection, shProc, TestDaemon, until } from "../fixtures/daemon-proc-harness";

const TEST_TIMEOUT_MS = 30_000;

let daemon: TestDaemon | undefined;
const tunnels: RawTunnel[] = [];

afterEach(async () => {
	for (const tunnel of tunnels.splice(0)) tunnel.close();
	await daemon?.dispose();
	daemon = undefined;
});

async function startDaemon(
	env?: Record<string, string>,
): Promise<{ daemon: TestDaemon; conn: DaemonConn; root: string }> {
	const started = await TestDaemon.start({ env });
	daemon = started.daemon;
	return { ...started, root: started.daemon.root };
}

/** A PTY `/bin/sh -c script` spec. */
function ptyProc(script: string, cwd: string, extra: Partial<ProcSpec> = {}): ProcSpec {
	return { ...shProc(script, cwd, { pty: true }), ...extra };
}

async function outputOf(conn: DaemonConn, key: string): Promise<string> {
	const logs = await conn.request({ op: "logs", unit: key, lines: 500, head: false, follow: false, timeoutMs: 0 });
	return logs.text;
}

function occurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

/** Wait until the unit's output holds `needle` at least `count` times. */
function untilOutput(conn: DaemonConn, key: string, needle: string, count = 1): Promise<string> {
	return until(
		async () => {
			const text = await outputOf(conn, key);
			return occurrences(text, needle) >= count ? text : undefined;
		},
		`${JSON.stringify(needle)} x${count} in ${key}`,
	);
}

interface RawTunnel {
	send(data: string | Uint8Array): void;
	/** Everything the unit sent to this viewer. */
	readonly output: string;
	readonly isClosed: boolean;
	readonly closed: Promise<void>;
	close(): void;
}

/** Dial the daemon and turn the connection into a tunnel to `unit`, speaking the protocol by hand. */
async function attachRaw(d: TestDaemon, unit: string): Promise<RawTunnel> {
	const token = (await fs.readFile(path.join(d.dir, "token"), "utf8")).trim();
	const conn = await IpcConnection.connect(ipcEndpoint(d.dir, "daemon"), { framing: "lines", timeoutMs: 1_000 });
	const attached = Promise.withResolvers<void>();
	const closed = Promise.withResolvers<void>();
	const decoder = new TextDecoder();
	let output = "";
	let isClosed = false;
	let stage: "hello" | "attach" | "raw" = "hello";
	conn.start(
		line => {
			const message = JSON.parse(line) as { error?: string; ok?: boolean };
			if (stage === "hello") {
				if (typeof message.error === "string") return attached.reject(new Error(message.error));
				stage = "attach";
				conn.send(JSON.stringify({ id: "attach", op: "attach", unit }));
				return;
			}
			if (stage !== "attach") return;
			if (!message.ok) return attached.reject(new Error(message.error ?? "attach refused"));
			stage = "raw";
			conn.upgradeRaw(chunk => {
				output += decoder.decode(chunk, { stream: true });
			});
			attached.resolve();
		},
		() => {
			isClosed = true;
			attached.reject(new Error("Tunnel connection closed"));
			closed.resolve();
		},
	);
	conn.send(
		JSON.stringify({ v: DAEMON_PROTOCOL_VERSION, token, client: { pid: process.pid, build: "0.0.0-test", exe: [] } }),
	);
	await attached.promise;
	const tunnel: RawTunnel = {
		send: data => void conn.send(data),
		get output() {
			return output;
		},
		get isClosed() {
			return isClosed;
		},
		closed: closed.promise,
		close: () => conn.destroy(),
	};
	tunnels.push(tunnel);
	return tunnel;
}

const ECHO_LOOP = `stty -echo; echo ready; while IFS= read -r line; do printf 'got:%s\\n' "$line"; done`;
const READY = { log: "^ready", timeoutMs: 5_000 };

describe.skipIf(process.platform === "win32")("daemon PTY viewers", () => {
	it(
		"resize changes the PTY size the program sees and is kept in the spec; a non-PTY unit and a bad size are refused",
		async () => {
			const { conn, root } = await startDaemon();
			await conn.openProc(
				"term",
				ptyProc("while IFS= read -r line; do stty size; done", root, { cols: 90, rows: 20 }),
			);

			await conn.request({ op: "send", unit: "term", data: "x\r" });
			await untilOutput(conn, "term", "20 90");

			await conn.request({ op: "resize", unit: "term", cols: 100, rows: 30 });
			await conn.request({ op: "send", unit: "term", data: "x\r" });
			await untilOutput(conn, "term", "30 100");
			const described = await conn.request({ op: "describe", unit: "term" });
			expect(described.proc).toMatchObject({ cols: 100, rows: 30 });

			expect(await rejection(conn.request({ op: "resize", unit: "term", cols: 0, rows: 30 }))).toContain(
				"Invalid PTY size",
			);
			await conn.openProc("pipe", shProc("exec sleep 30", root));
			expect(await rejection(conn.request({ op: "resize", unit: "pipe", cols: 100, rows: 30 }))).toContain(
				"has no PTY",
			);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"a multi-byte character split across two tunnel chunks reaches the program intact",
		async () => {
			const { daemon: d, conn, root } = await startDaemon();
			await conn.openProc("utf8", ptyProc(ECHO_LOOP, root, { ready: READY }));
			const tunnel = await attachRaw(d, "utf8");

			// "aéb\r" with é (C3 A9) cut between its two bytes.
			tunnel.send(new Uint8Array([0x61, 0xc3]));
			// Real gap between writes: the two halves must reach the daemon as separate socket reads,
			// which no fake clock can force across processes.
			await Bun.sleep(100);
			tunnel.send(new Uint8Array([0xa9, 0x62, 0x0d]));

			const text = await untilOutput(conn, "utf8", "got:");
			expect(text).toContain("got:aéb");
			expect(text).not.toContain("\ufffd");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"exclusive attach drops the previous viewer at once and ignores its input; the new viewer drives the unit",
		async () => {
			const { daemon: d, conn, root } = await startDaemon();
			await conn.openProc("solo", ptyProc(ECHO_LOOP, root, { ready: READY, exclusiveAttach: true }));
			const first = await attachRaw(d, "solo");
			const second = await attachRaw(d, "solo");

			first.send("fromA\r");
			await first.closed;
			expect(first.isClosed).toBe(true);

			second.send("fromB\r");
			const text = await untilOutput(conn, "solo", "got:fromB");
			expect(text).not.toContain("got:fromA");
			await until(() => (second.output.includes("got:fromB") ? true : undefined), "output on the new viewer");
			expect(second.isClosed).toBe(false);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"terminal queries are answered by the daemon only while no viewer is attached",
		async () => {
			const { daemon: d, conn, root } = await startDaemon();
			// Each input line triggers a device-status query (CSI 5 n) and reports the reply, or `none` after 1 s.
			const script =
				"stty -icanon -echo; echo ready; while IFS= read -r cmd; do printf '\\033[5n'; " +
				'if IFS= read -r -t 1 -d n reply; then echo "reply:$(printf %s "$reply" | tail -c 2)"; else echo none; fi; done';
			await conn.openProc("probe", {
				...ptyProc(script, root, { ready: READY }),
				application: "/bin/bash",
				args: ["-c", script],
			});

			await conn.request({ op: "send", unit: "probe", data: "go\r" });
			await untilOutput(conn, "probe", "reply:[0");

			const viewer = await attachRaw(d, "probe");
			await conn.request({ op: "send", unit: "probe", data: "go\r" });
			const viewed = await untilOutput(conn, "probe", "none");
			expect(occurrences(viewed, "reply:[0")).toBe(1);
			// The viewer saw the query it is now responsible for answering.
			expect(viewer.output).toContain("\x1b[5n");

			viewer.close();
			await viewer.closed;
			// The daemon notices the closed viewer asynchronously: probe until an answer comes back,
			// each round waiting for that probe's own result line.
			let rounds = 3;
			for (let text = viewed; occurrences(text, "reply:[0") < 2;) {
				const answered = occurrences(text, "reply:[0") + occurrences(text, "none") + 1;
				await conn.request({ op: "send", unit: "probe", data: "go\r" });
				text = await until(async () => {
					const next = await outputOf(conn, "probe");
					return occurrences(next, "reply:[0") + occurrences(next, "none") >= answered ? next : undefined;
				}, "the probe's result line");
				if (--rounds === 0) expect(occurrences(text, "reply:[0")).toBe(2);
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"a clearEnv PTY unit sees only its spec's environment, not the daemon's",
		async () => {
			const { conn, root } = await startDaemon({ OMP_DAEMON_ONLY_PROBE: "leaked" });
			const script = 'echo "probe=[$OMP_DAEMON_ONLY_PROBE] term=[$TERM]"; exec sleep 30';
			const ready = { log: "^probe=", timeoutMs: 5_000 };
			await conn.openProc("clean", ptyProc(script, root, { ready, clearEnv: true }));
			await conn.openProc("inherit", ptyProc(script, root, { ready }));

			expect(await outputOf(conn, "clean")).toContain("probe=[] term=[xterm-256color]");
			expect(await outputOf(conn, "inherit")).toContain("probe=[leaked]");
		},
		TEST_TIMEOUT_MS,
	);
});
