// Integration probe — real timers are required (ts-no-test-timers exception):
// the assertions observe bytes crossing a real PTY, a real interactive child
// process and the broker's Unix socket, so fake timers cannot drive them. The
// awaited signals are file markers, mirrored output and RPC replies.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { IpcConnection } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Snowflake } from "@oh-my-pi/pi-utils/snowflake";
import type { DaemonBrokerClient } from "../../src/launch/client";
import type {
	DaemonOperation,
	DaemonRpcResult,
	DaemonTerminalExitNotification,
	DaemonTerminalOutputNotification,
} from "../../src/launch/protocol";
import { terminalSpec, withTerminalBroker } from "./terminal-fixture";

const PROBE_READY_TIMEOUT_MS = 30_000;
const DRAFT = "draft λ草";
const APPROVE_KEY = "\x11";
const CURSOR_QUERY = "\x1b[6n";
const CURSOR_REPLY = /\x1b\[\d+;\d+R/g;

type Event = Record<string, unknown>;

function readEvents(file: string): Event[] {
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter(line => line.length > 0)
		.map(line => JSON.parse(line) as Event);
}

async function waitForEvent(
	file: string,
	name: string,
	predicate: (event: Event) => boolean = () => true,
	timeoutMs = PROBE_READY_TIMEOUT_MS,
): Promise<Event> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const found = readEvents(file).find(event => event.name === name && predicate(event));
		if (found) return found;
		if (Date.now() > deadline) {
			throw new Error(
				`child never reported ${name}; saw ${fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""}`,
			);
		}
		await Bun.sleep(25);
	}
}

function occurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

interface Mirror {
	readonly subscriptionId: string;
	readonly exits: DaemonTerminalExitNotification[];
	readonly text: string;
	waitForText(marker: string, timeoutMs?: number): Promise<void>;
	off(): void;
}

function mirror(client: DaemonBrokerClient, subscriptionId: string): Mirror {
	const exits: DaemonTerminalExitNotification[] = [];
	let text = "";
	let waiters: Array<{ marker: string; resolve: () => void }> = [];
	const off = client.subscribeTerminal(subscriptionId, frame => {
		if (frame.event === "terminal_exit") {
			exits.push(frame);
			return;
		}
		text += frame.data;
		void client
			.request({
				op: "terminal_ack",
				name: frame.name,
				id: frame.id,
				subscriptionId,
				sequence: frame.sequence,
			})
			.catch(() => undefined);
		waiters = waiters.filter(waiter => {
			if (!text.includes(waiter.marker)) return true;
			waiter.resolve();
			return false;
		});
	});
	return {
		subscriptionId,
		exits,
		get text() {
			return text;
		},
		async waitForText(marker, timeoutMs = 15_000) {
			const deadline = Date.now() + timeoutMs;
			while (!text.includes(marker)) {
				if (Date.now() > deadline) {
					throw new Error(
						`mirror never showed ${JSON.stringify(marker)}; tail ${JSON.stringify(text.slice(-1500))}`,
					);
				}
				const { promise, resolve } = Promise.withResolvers<void>();
				waiters.push({ marker, resolve });
				await Promise.race([promise, Bun.sleep(50)]);
			}
		},
		off,
	};
}

class SocketPeer {
	#queue: Event[] = [];
	#wake: (() => void) | undefined;

	private constructor(private readonly conn: IpcConnection) {}

	static async connect(endpoint: string): Promise<SocketPeer> {
		const conn = await IpcConnection.connect(endpoint, { framing: "lines", timeoutMs: 5000 });
		const peer = new SocketPeer(conn);
		conn.start(
			line => {
				peer.#queue.push(JSON.parse(line) as Event);
				peer.#wake?.();
			},
			() => {},
		);
		return peer;
	}

	async next(predicate: (frame: Event) => boolean, timeoutMs = 15_000): Promise<Event> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const index = this.#queue.findIndex(predicate);
			if (index >= 0) return this.#queue.splice(index, 1)[0]!;
			if (Date.now() > deadline) throw new Error(`no frame matched; saw ${JSON.stringify(this.#queue)}`);
			const arrived = Promise.withResolvers<void>();
			this.#wake = arrived.resolve;
			await Promise.race([arrived.promise, Bun.sleep(50)]);
			this.#wake = undefined;
		}
	}

	send(frame: object): void {
		this.conn.send(JSON.stringify(frame));
	}

	close(): void {
		this.conn.destroy();
	}
}

async function attachWhenReleased(
	client: DaemonBrokerClient,
	operation: Extract<DaemonOperation, { op: "terminal_attach" }>,
	timeoutMs = 10_000,
): Promise<Extract<DaemonRpcResult, { op: "terminal_attach" }>> {
	const deadline = Date.now() + timeoutMs;
	let lastError: Error | undefined;
	while (Date.now() < deadline) {
		try {
			const result = await client.request(operation);
			if (result.op !== "terminal_attach") throw new Error("unexpected terminal_attach result");
			return result;
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			if (!lastError.message.includes("already attached")) throw lastError;
		}
		await Bun.sleep(25);
	}
	throw lastError ?? new Error("terminal attach never became available");
}

describe("a renderer refresh across a real broker PTY mirror swap", () => {
	it("keeps the draft and the pending gate while the new terminal decodes input once", async () => {
		await withTerminalBroker(async ({ client, projectDir }) => {
			using tempDir = TempDir.createSync("@omp-refresh-probe-");
			const controlDir = path.join(tempDir.path(), "control");
			const endpointDir = path.join(tempDir.path(), "endpoints");
			fs.mkdirSync(controlDir, { recursive: true });
			fs.mkdirSync(endpointDir, { recursive: true });
			const eventsFile = path.join(controlDir, "child-events.jsonl");
			const generation = `probe-${Snowflake.next()}`;
			const script = path.resolve(import.meta.dir, "../fixtures/terminal-refresh-child.ts");
			const name = `probe-${Snowflake.next()}`;
			const spec = terminalSpec(projectDir, "", {
				name,
				args: [script, controlDir, endpointDir, generation],
				env: { PI_CODING_AGENT_DIR: controlDir },
				persist: true,
				ready: { log: "PROBE_READY", timeoutMs: PROBE_READY_TIMEOUT_MS },
			});

			const first = mirror(client, `mirror-a-${Snowflake.next()}`);
			const started = await client.request({
				op: "terminal_start",
				subscriptionId: first.subscriptionId,
				spec,
				columns: 110,
				rows: 36,
			});
			if (started.op !== "terminal_start") throw new Error("terminal_start did not start a daemon");
			const daemon = started.daemon;
			const send = async (data: string): Promise<void> => {
				const result = await client.request({ op: "send", name, id: daemon.id, data });
				if (result.op !== "send") throw new Error("unexpected send result");
			};

			const ready = await waitForEvent(eventsFile, "ready");
			expect(ready.draft).toBe(DRAFT);
			const sessionId = ready.sessionId as string;
			await waitForEvent(eventsFile, "gate-open", event => event.dialogs === 2);

			const peer = await SocketPeer.connect(ready.endpoint as string);
			try {
				await peer.next(frame => frame.type === "ready");
				peer.send({ id: "before", type: "get_state" });
				expect((await peer.next(frame => frame.id === "before")).success).toBe(true);

				first.off();
				await client.request({ op: "terminal_detach", subscriptionId: first.subscriptionId, name, id: daemon.id });
				expect(readEvents(eventsFile).filter(event => event.name === "gate-settled")).toHaveLength(0);
				expect(first.exits).toHaveLength(0);

				const second = mirror(client, `mirror-b-${Snowflake.next()}`);
				await attachWhenReleased(client, {
					op: "terminal_attach",
					subscriptionId: second.subscriptionId,
					name,
					id: daemon.id,
					columns: 110,
					rows: 36,
				});

				peer.send({ type: "terminal_refresh", id: "refresh", sessionId, generation });
				expect(await peer.next(frame => frame.id === "refresh")).toMatchObject({
					type: "terminal_refreshed",
					sessionId,
					generation,
				});
				await waitForEvent(eventsFile, "refreshed", event => event.draft === DRAFT);
				await second.waitForText(DRAFT);
				await second.waitForText("Allow tool: write");

				peer.send({ id: "during", type: "get_state" });
				expect((await peer.next(frame => frame.id === "during")).success).toBe(true);

				await send("λ");
				await send("\x1b[200~paste λ\x1b[201~");
				await Bun.sleep(650);
				await send(APPROVE_KEY);

				const settled = await waitForEvent(eventsFile, "gate-settled");
				expect(settled.value).toBe("once");
				expect(settled.draft).toBe(`${DRAFT}λpaste λ`);

				const stdin = readEvents(eventsFile)
					.filter(event => event.name === "stdin")
					.map(event => String(event.data))
					.join("");
				expect(stdin).toContain("λ");
				expect(occurrences(stdin, "\x1b[200~paste λ\x1b[201~")).toBe(1);
				expect(occurrences(stdin, APPROVE_KEY)).toBe(1);
				expect(occurrences(second.text, CURSOR_QUERY)).toBe(0);
				expect(stdin.match(CURSOR_REPLY) ?? []).toHaveLength(0);
				expect(second.exits).toHaveLength(0);

				peer.send({ id: "after", type: "get_state" });
				expect((await peer.next(frame => frame.id === "after")).success).toBe(true);
				const described = await client.request({ op: "describe", name });
				if (described.op !== "describe") throw new Error("unexpected describe result");
				expect(["ready", "running"]).toContain(described.daemon.state);
				second.off();
			} finally {
				peer.close();
			}
		});
	}, 120_000);
});
