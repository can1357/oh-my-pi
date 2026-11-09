// Integration test — real timers are required (ts-no-test-timers exception): every assertion
// below observes bytes crossing a real PTY, a real child process, and the broker's Unix socket.
// Fake timers cannot drive the platform console host or the cross-process RPC, and the awaited
// signals are output markers and stream events, never fixed delays.
import { describe, expect, it } from "bun:test";
import { withTimeout } from "@oh-my-pi/pi-utils";
import { Snowflake } from "@oh-my-pi/pi-utils/snowflake";
import type { DaemonBrokerClient } from "../../src/launch/client";
import type {
	DaemonOperation,
	DaemonRpcResult,
	DaemonTerminalExitNotification,
	DaemonTerminalOutputNotification,
} from "../../src/launch/protocol";
import { terminalSpec, withTerminalBroker } from "./terminal-fixture";

interface TerminalCapture {
	readonly frames: DaemonTerminalOutputNotification[];
	readonly exits: DaemonTerminalExitNotification[];
	readonly text: string;
	readonly earlyText: string;
	markStartResolved(): void;
	waitForText(marker: string, timeoutMs?: number): Promise<void>;
	waitForExit(timeoutMs?: number): Promise<DaemonTerminalExitNotification>;
	off(): void;
}

function captureTerminal(
	client: DaemonBrokerClient,
	subscriptionId: string,
	options: { ack?: boolean } = {},
): TerminalCapture {
	const frames: DaemonTerminalOutputNotification[] = [];
	const exits: DaemonTerminalExitNotification[] = [];
	const textWaiters: Array<{ marker: string; resolve: () => void }> = [];
	const exitWaiters: Array<(exit: DaemonTerminalExitNotification) => void> = [];
	let text = "";
	let earlyText = "";
	let startResolved = false;
	const wakeText = (): void => {
		for (let index = textWaiters.length - 1; index >= 0; index--) {
			const waiter = textWaiters[index]!;
			if (!text.includes(waiter.marker)) continue;
			textWaiters.splice(index, 1);
			waiter.resolve();
		}
	};
	const off = client.subscribeTerminal(subscriptionId, frame => {
		if (frame.event === "terminal_exit") {
			exits.push(frame);
			for (const waiter of exitWaiters.splice(0)) waiter(frame);
			return;
		}
		frames.push(frame);
		text += frame.data;
		if (!startResolved) earlyText += frame.data;
		if (options.ack === true) {
			void client
				.request({
					op: "terminal_ack",
					name: frame.name,
					id: frame.id,
					subscriptionId,
					sequence: frame.sequence,
				})
				.catch(() => undefined);
		}
		wakeText();
	});
	return {
		frames,
		exits,
		get text() {
			return text;
		},
		get earlyText() {
			return earlyText;
		},
		markStartResolved() {
			startResolved = true;
		},
		waitForText(marker: string, timeoutMs = 5_000): Promise<void> {
			if (text.includes(marker)) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			textWaiters.push({ marker, resolve });
			return withTimeout(promise, timeoutMs, `terminal output never contained ${JSON.stringify(marker)}`);
		},
		waitForExit(timeoutMs = 5_000): Promise<DaemonTerminalExitNotification> {
			const observed = exits[0];
			if (observed) return Promise.resolve(observed);
			const { promise, resolve } = Promise.withResolvers<DaemonTerminalExitNotification>();
			exitWaiters.push(resolve);
			return withTimeout(promise, timeoutMs, "terminal subscription never reported its exit");
		},
		off,
	};
}

async function attachWhenReleased(
	client: DaemonBrokerClient,
	operation: Extract<DaemonOperation, { op: "terminal_attach" }>,
	timeoutMs = 5_000,
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
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		await promise;
	}
	throw lastError ?? new Error("terminal attach never became available");
}

describe("broker terminal streams", () => {
	it("delivers the first paint before the start response and streams fenced input", async () => {
		await withTerminalBroker(async ({ client, projectDir }) => {
			const subscriptionId = `view-${Snowflake.next()}`;
			const capture = captureTerminal(client, subscriptionId, { ack: true });
			const spec = terminalSpec(
				projectDir,
				"process.stdin.setRawMode(true);" +
					'process.stdin.setEncoding("utf8");' +
					'process.stdout.write("FIRST\\x1b[31mλ\\x1b[0m\\r\\n");' +
					'process.stdin.on("data", chunk => process.stdout.write("INPUT:" + chunk));',
				{ ready: { log: "FIRST", timeoutMs: 5_000 } },
			);
			try {
				const started = await client.request({
					op: "terminal_start",
					subscriptionId,
					spec,
					columns: 93,
					rows: 31,
				});
				capture.markStartResolved();
				if (started.op !== "terminal_start") throw new Error("unexpected terminal_start result");
				expect(capture.earlyText).toContain("FIRST\x1b[31mλ\x1b[0m");
				await expect(
					client.request({ op: "send", name: spec.name, id: "not-this-generation", data: "BAD" }),
				).rejects.toThrow(/not-this-generation/u);
				await client.request({ op: "send", name: spec.name, id: started.daemon.id, data: "q" });
				await capture.waitForText("INPUT:q");
				expect(capture.text).not.toContain("INPUT:BAD");
			} finally {
				capture.off();
			}
		});
	}, 20_000);

	it("applies and acknowledges a terminal resize", async () => {
		await withTerminalBroker(async ({ client, projectDir }) => {
			const subscriptionId = `view-${Snowflake.next()}`;
			const capture = captureTerminal(client, subscriptionId, { ack: true });
			const spec = terminalSpec(
				projectDir,
				"process.stdin.setRawMode(true);" +
					'const report = () => process.stdout.write("SIZE:" + process.stdout.columns + "x" + process.stdout.rows + "\\n");' +
					'process.stdout.on("resize", report);' +
					"report();" +
					'process.stdin.on("data", () => {});',
				{ ready: { log: "SIZE:93x31", timeoutMs: 5_000 } },
			);
			try {
				const started = await client.request({
					op: "terminal_start",
					subscriptionId,
					spec,
					columns: 93,
					rows: 31,
				});
				if (started.op !== "terminal_start") throw new Error("unexpected terminal_start result");
				const resized = await client.request({
					op: "terminal_resize",
					subscriptionId,
					name: spec.name,
					id: started.daemon.id,
					columns: 120,
					rows: 40,
				});
				expect(resized).toEqual({
					op: "terminal_resize",
					subscriptionId,
					name: spec.name,
					id: started.daemon.id,
					columns: 120,
					rows: 40,
				});
				await capture.waitForText("SIZE:120x40");
			} finally {
				capture.off();
			}
		});
	}, 20_000);

	it("keeps the child alive and re-attachable after the subscribing connection closes", async () => {
		await withTerminalBroker(async ({ client, projectDir, connect }) => {
			const subscriptionId = `view-${Snowflake.next()}`;
			const capture = captureTerminal(client, subscriptionId, { ack: true });
			const spec = terminalSpec(
				projectDir,
				"process.stdin.setRawMode(true);" +
					'process.stdin.setEncoding("utf8");' +
					"let n = 0;" +
					'setInterval(() => process.stdout.write("TICK:" + (++n) + "\\n"), 50);' +
					'process.stdout.write("READY\\n");' +
					'process.stdin.on("data", chunk => process.stdout.write("GOT:" + chunk));',
				{ ready: { log: "READY", timeoutMs: 5_000 } },
			);
			const started = await client.request({
				op: "terminal_start",
				subscriptionId,
				spec,
				columns: 80,
				rows: 24,
			});
			if (started.op !== "terminal_start") throw new Error("unexpected terminal_start result");
			if (started.daemon.pid === undefined) throw new Error("terminal child has no pid");
			capture.off();
			client.close();

			const second = await connect();
			const secondSubscription = `view-${Snowflake.next()}`;
			const secondCapture = captureTerminal(second, secondSubscription, { ack: true });
			try {
				const attached = await attachWhenReleased(second, {
					op: "terminal_attach",
					subscriptionId: secondSubscription,
					name: spec.name,
					id: started.daemon.id,
					columns: 80,
					rows: 24,
				});
				expect(attached.daemon.id).toBe(started.daemon.id);
				expect(attached.daemon.pid).toBe(started.daemon.pid);
				await secondCapture.waitForText("TICK:");
				await second.request({
					op: "send",
					name: spec.name,
					id: started.daemon.id,
					data: "z",
				});
				await secondCapture.waitForText("GOT:z");
				const listed = await second.request({ op: "list" });
				if (listed.op !== "list") throw new Error("unexpected list result");
				const live = listed.daemons.find(daemon => daemon.name === spec.name);
				expect(live?.pid).toBe(started.daemon.pid);
			} finally {
				secondCapture.off();
			}
		});
	}, 20_000);

	it("rejects input for a replaced generation without reaching the new child", async () => {
		await withTerminalBroker(async ({ client, projectDir }) => {
			const firstSubscription = `view-${Snowflake.next()}`;
			const firstCapture = captureTerminal(client, firstSubscription, { ack: true });
			const spec = terminalSpec(
				projectDir,
				"process.stdin.setRawMode(true);" +
					'process.stdin.setEncoding("utf8");' +
					'process.stdin.on("data", chunk => process.stdout.write("GOT:" + chunk));',
			);
			try {
				const first = await client.request({
					op: "terminal_start",
					subscriptionId: firstSubscription,
					spec,
					columns: 80,
					rows: 24,
				});
				if (first.op !== "terminal_start") throw new Error("unexpected terminal_start result");
				const replaced = await client.request({ op: "start", spec, replace: true });
				if (replaced.op !== "start") throw new Error("unexpected start result");
				expect(replaced.daemon.id).not.toBe(first.daemon.id);
				const secondSubscription = `view-${Snowflake.next()}`;
				const secondCapture = captureTerminal(client, secondSubscription, { ack: true });
				try {
					const attached = await client.request({
						op: "terminal_attach",
						subscriptionId: secondSubscription,
						name: spec.name,
						id: replaced.daemon.id,
						columns: 80,
						rows: 24,
					});
					expect(attached.op).toBe("terminal_attach");
					await expect(
						client.request({ op: "send", name: spec.name, id: first.daemon.id, data: "STALE" }),
					).rejects.toThrow(/generation/u);
					await client.request({
						op: "send",
						name: spec.name,
						id: replaced.daemon.id,
						data: "PING",
					});
					await secondCapture.waitForText("GOT:PING");
					expect(secondCapture.text).not.toContain("GOT:STALE");
				} finally {
					secondCapture.off();
				}
			} finally {
				firstCapture.off();
			}
		});
	}, 20_000);

	it("retires only the overflowing subscription when unacknowledged output exceeds the bound", async () => {
		await withTerminalBroker(async ({ client, projectDir, connect }) => {
			const subscriptionId = `view-${Snowflake.next()}`;
			const capture = captureTerminal(client, subscriptionId);
			const spec = terminalSpec(
				projectDir,
				"process.stdin.setRawMode(true);" +
					'process.stdin.setEncoding("utf8");' +
					"let ticks = 0;" +
					'setInterval(() => process.stdout.write("TICK:" + (++ticks) + "\\n"), 50);' +
					'process.stdout.write("READY\\n");' +
					'process.stdin.on("data", chunk => {' +
					'if (chunk.includes("go")) {' +
					"void (async () => {" +
					'const block = "x".repeat(65536);' +
					"for (let i = 0; i < 48; i++) { process.stdout.write(block); await Bun.sleep(5); }" +
					'process.stdout.write("BURST_DONE\\n");' +
					"})();" +
					"}" +
					"});",
				{ ready: { log: "READY", timeoutMs: 5_000 } },
			);
			try {
				const started = await client.request({
					op: "terminal_start",
					subscriptionId,
					spec,
					columns: 80,
					rows: 24,
				});
				if (started.op !== "terminal_start") throw new Error("unexpected terminal_start result");
				const other = await connect();
				const otherSubscription = `view-${Snowflake.next()}`;
				const otherCapture = captureTerminal(other, otherSubscription, { ack: true });
				try {
					const attached = await other.request({
						op: "terminal_attach",
						subscriptionId: otherSubscription,
						name: spec.name,
						id: started.daemon.id,
						columns: 80,
						rows: 24,
					});
					if (attached.op !== "terminal_attach") throw new Error("unexpected terminal_attach result");
					await client.request({ op: "send", name: spec.name, id: started.daemon.id, data: "go" });
					const exit = await capture.waitForExit();
					expect(exit.reason).toBe("terminal-backpressure");
					expect(exit.id).toBe(started.daemon.id);
					await otherCapture.waitForText("BURST_DONE");
					expect(otherCapture.exits).toEqual([]);
					const listed = await other.request({ op: "list" });
					if (listed.op !== "list") throw new Error("unexpected list result");
					expect(listed.daemons.find(daemon => daemon.name === spec.name)?.pid).toBe(started.daemon.pid);
				} finally {
					otherCapture.off();
				}
			} finally {
				capture.off();
			}
		});
	}, 30_000);

	it("routes terminal queries to the attached mirror and back to the broker after detach", async () => {
		await withTerminalBroker(async ({ client, projectDir }) => {
			const subscriptionId = `view-${Snowflake.next()}`;
			const capture = captureTerminal(client, subscriptionId, { ack: true });
			const spec = terminalSpec(
				projectDir,
				"process.stdin.setRawMode(true);" +
					'process.stdin.setEncoding("utf8");' +
					'let buf = "";' +
					"let probe = 0;" +
					'process.stdin.on("data", chunk => {' +
					"buf += chunk;" +
					"for (;;) {" +
					"const match = /\\x1b\\[(\\d+);(\\d+)R/.exec(buf);" +
					"if (!match) break;" +
					"buf = buf.slice(match.index + match[0].length);" +
					'process.stdout.write("REPORT:" + probe + ":" + match[1] + ";" + match[2] + "\\n");' +
					"}" +
					'if (chunk.includes("p")) {' +
					"probe += 1;" +
					'process.stdout.write("PROBE" + probe + "\\x1b[6n");' +
					"}" +
					'if (chunk.includes("s")) process.stdout.write("SYNC" + probe + "\\n");' +
					"});" +
					'process.stdout.write("PROBE0\\x1b[6n");',
				{ ready: { log: "PROBE0", timeoutMs: 5_000 } },
			);
			try {
				const started = await client.request({
					op: "terminal_start",
					subscriptionId,
					spec,
					columns: 80,
					rows: 24,
				});
				if (started.op !== "terminal_start") throw new Error("unexpected terminal_start result");
				await capture.waitForText("PROBE0");
				await client.request({
					op: "send",
					name: spec.name,
					id: started.daemon.id,
					data: "\x1b[9;7R",
				});
				await capture.waitForText("REPORT:0:9;7");
				await client.request({ op: "send", name: spec.name, id: started.daemon.id, data: "s" });
				await capture.waitForText("SYNC0");
				expect(capture.text).not.toContain("REPORT:0:1;1");

				await client.request({
					op: "terminal_detach",
					subscriptionId,
					name: spec.name,
					id: started.daemon.id,
				});
				await client.request({ op: "send", name: spec.name, id: started.daemon.id, data: "p" });
				const fallback = await client.request({
					op: "wait",
					name: spec.name,
					for: "ready",
					pattern: "REPORT:1:1;1",
					timeoutMs: 5_000,
				});
				if (fallback.op !== "wait") throw new Error("unexpected wait result");
				expect(fallback.timedOut).toBeFalse();
				expect(fallback.matched).toBe("REPORT:1:1;1");
				await client.request({ op: "send", name: spec.name, id: started.daemon.id, data: "s" });
				const sync = await client.request({
					op: "wait",
					name: spec.name,
					for: "ready",
					pattern: "SYNC1",
					timeoutMs: 5_000,
				});
				if (sync.op !== "wait") throw new Error("unexpected wait result");
				expect(sync.timedOut).toBeFalse();
			} finally {
				capture.off();
			}
		});
	}, 20_000);

	it("shares one owner while fencing subscriber operations, disconnect, detach and exit", async () => {
		await withTerminalBroker(async ({ client, projectDir, connect }) => {
			const subscriptionId = `view-${Snowflake.next()}`;
			const capture = captureTerminal(client, subscriptionId, { ack: true });
			const spec = terminalSpec(
				projectDir,
				"process.stdin.setRawMode(true);" +
					'process.stdout.write("READY\\n");' +
					'process.stdin.on("data", chunk => process.stdout.write("INPUT:" + chunk.toString() + "\\n"));',
				{ ready: { log: "READY", timeoutMs: 5_000 } },
			);
			try {
				const started = await client.request({
					op: "terminal_start",
					subscriptionId,
					spec,
					columns: 80,
					rows: 24,
				});
				if (started.op !== "terminal_start") throw new Error("unexpected terminal_start result");
				const other = await connect();
				const otherSubscription = `view-${Snowflake.next()}`;
				const otherCapture = captureTerminal(other, otherSubscription, { ack: true });
				try {
					const attached = await other.request({
						op: "terminal_attach",
						subscriptionId: otherSubscription,
						name: spec.name,
						id: started.daemon.id,
						columns: 100,
						rows: 30,
					});
					if (attached.op !== "terminal_attach") throw new Error("unexpected terminal_attach result");
					expect(attached.daemon.pid).toBe(started.daemon.pid);
					await expect(
						other.request({
							op: "terminal_attach",
							subscriptionId,
							name: spec.name,
							id: started.daemon.id,
							columns: 100,
							rows: 30,
						}),
					).rejects.toThrow("already attached");
					await expect(
						other.request({
							op: "terminal_ack",
							subscriptionId,
							name: spec.name,
							id: started.daemon.id,
							sequence: 0,
						}),
					).rejects.toThrow("another connection");
					await expect(
						other.request({
							op: "terminal_resize",
							subscriptionId,
							name: spec.name,
							id: started.daemon.id,
							columns: 1,
							rows: 1,
						}),
					).rejects.toThrow("another connection");
					await expect(
						other.request({
							op: "terminal_detach",
							subscriptionId,
							name: spec.name,
							id: started.daemon.id,
						}),
					).rejects.toThrow("another connection");
					await expect(
						other.request({
							op: "terminal_resize",
							subscriptionId: "forged",
							name: spec.name,
							id: started.daemon.id,
							columns: 1,
							rows: 1,
						}),
					).rejects.toThrow("does not own");
					await expect(
						other.request({
							op: "terminal_resize",
							subscriptionId: otherSubscription,
							name: spec.name,
							id: "stale-generation",
							columns: 1,
							rows: 1,
						}),
					).rejects.toThrow("does not own");
					await other.request({ op: "send", name: spec.name, id: started.daemon.id, data: "shared" });
					await Promise.all([capture.waitForText("INPUT:shared"), otherCapture.waitForText("INPUT:shared")]);
					other.close();
					await client.request({ op: "send", name: spec.name, id: started.daemon.id, data: "after-close" });
					await capture.waitForText("INPUT:after-close");
				} finally {
					otherCapture.off();
				}
				const third = await connect();
				const thirdSubscription = `view-${Snowflake.next()}`;
				const thirdCapture = captureTerminal(third, thirdSubscription, { ack: true });
				try {
					await third.request({
						op: "terminal_attach",
						subscriptionId: thirdSubscription,
						name: spec.name,
						id: started.daemon.id,
						columns: 90,
						rows: 25,
					});
					await client.request({
						op: "terminal_detach",
						subscriptionId,
						name: spec.name,
						id: started.daemon.id,
					});
					const detachedText = capture.text;
					await third.request({ op: "send", name: spec.name, id: started.daemon.id, data: "after-detach" });
					await thirdCapture.waitForText("INPUT:after-detach");
					expect(capture.text).toBe(detachedText);
					await client.request({
						op: "terminal_attach",
						subscriptionId,
						name: spec.name,
						id: started.daemon.id,
						columns: 80,
						rows: 24,
					});
					await third.request({ op: "stop", name: spec.name, id: started.daemon.id, timeoutMs: 2_000 });
					const exits = await Promise.all([capture.waitForExit(), thirdCapture.waitForExit()]);
					expect(exits.map(exit => exit.id)).toEqual([started.daemon.id, started.daemon.id]);
				} finally {
					thirdCapture.off();
				}
			} finally {
				capture.off();
			}
		});
	}, 30_000);

	it("reports the child exit to the attached subscriber", async () => {
		await withTerminalBroker(async ({ client, projectDir }) => {
			const subscriptionId = `view-${Snowflake.next()}`;
			const capture = captureTerminal(client, subscriptionId, { ack: true });
			const spec = terminalSpec(
				projectDir,
				"process.stdin.setRawMode(true);" +
					'process.stdout.write("BYE\\n");' +
					"setTimeout(() => process.exit(3), 50);" +
					'process.stdin.on("data", () => {});',
				{ ready: { log: "BYE", timeoutMs: 5_000 } },
			);
			try {
				const started = await client.request({
					op: "terminal_start",
					subscriptionId,
					spec,
					columns: 80,
					rows: 24,
				});
				if (started.op !== "terminal_start") throw new Error("unexpected terminal_start result");
				const exit = await capture.waitForExit();
				expect(exit.exitCode).toBe(3);
				expect(exit.id).toBe(started.daemon.id);
				const listed = await client.request({ op: "list" });
				if (listed.op !== "list") throw new Error("unexpected list result");
				const dead = listed.daemons.find(daemon => daemon.name === spec.name);
				expect(dead?.state).toBe("failed");
				expect(dead?.exitCode).toBe(3);
			} finally {
				capture.off();
			}
		});
	}, 20_000);

	it("rejects an acknowledgement beyond the sent sequence", async () => {
		await withTerminalBroker(async ({ client, projectDir }) => {
			const subscriptionId = `view-${Snowflake.next()}`;
			const capture = captureTerminal(client, subscriptionId);
			const spec = terminalSpec(
				projectDir,
				"process.stdin.setRawMode(true);" +
					'process.stdout.write("READY\\n");' +
					'process.stdin.on("data", () => {});',
				{ ready: { log: "READY", timeoutMs: 5_000 } },
			);
			try {
				const started = await client.request({
					op: "terminal_start",
					subscriptionId,
					spec,
					columns: 80,
					rows: 24,
				});
				if (started.op !== "terminal_start") throw new Error("unexpected terminal_start result");
				await capture.waitForText("READY");
				await expect(
					client.request({
						op: "terminal_ack",
						subscriptionId,
						name: spec.name,
						id: started.daemon.id,
						sequence: 10_000,
					}),
				).rejects.toThrow(/acknowledg/u);
			} finally {
				capture.off();
			}
		});
	}, 20_000);
});
