import { describe, expect, it } from "bun:test";
import { setImmediate as nextImmediate } from "node:timers/promises";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import { withTimeout } from "@oh-my-pi/pi-utils";
import type { DaemonBrokerClient } from "../../src/launch/client";
import type {
	DaemonOperation,
	DaemonRpcResult,
	DaemonTerminalExitNotification,
	DaemonTerminalNotification,
} from "../../src/launch/protocol";
import {
	runTerminalMirror,
	type TerminalMirrorInput,
	type TerminalMirrorOptions,
	type TerminalMirrorOutput,
	type TerminalMirrorResult,
	type TerminalMirrorSignal,
} from "../../src/launch/terminal-mirror";

const NAME = "mind-fixture";
const ID = "owner-generation";
const SUBSCRIPTION = "view-1";

function snapshot(): DaemonSnapshot {
	return {
		name: NAME,
		id: ID,
		state: "ready",
		createdAt: 1,
		startedAt: 2,
		restartCount: 0,
		outputBytes: 0,
		persist: true,
		detached: false,
	};
}

type Sink = (frame: DaemonTerminalNotification) => void;

interface FakeBroker {
	readonly client: DaemonBrokerClient;
	readonly operations: DaemonOperation[];
	readonly sinks: Map<string, Sink>;
	closed: boolean;
	emit(frame: DaemonTerminalNotification): void;
	waitForOperation(predicate: (operation: DaemonOperation) => boolean, message: string): Promise<DaemonOperation>;
}

function fakeBroker(options: { rejectSend?: boolean } = {}): FakeBroker {
	const operations: DaemonOperation[] = [];
	const sinks = new Map<string, Sink>();
	const waiters: Array<{ predicate: (operation: DaemonOperation) => boolean; resolve: () => void }> = [];
	const notify = (operation: DaemonOperation): void => {
		operations.push(operation);
		for (let index = waiters.length - 1; index >= 0; index--) {
			if (!waiters[index]!.predicate(operation)) continue;
			waiters.splice(index, 1)[0]!.resolve();
		}
	};
	const state = { closed: false };
	const client = {
		subscribeTerminal(subscriptionId: string, sink: Sink) {
			sinks.set(subscriptionId, sink);
			return () => {
				sinks.delete(subscriptionId);
			};
		},
		async request(operation: DaemonOperation): Promise<DaemonRpcResult> {
			notify(operation);
			if (options.rejectSend && operation.op === "send") throw new Error("stale terminal generation");
			switch (operation.op) {
				case "terminal_attach":
					return { op: "terminal_attach", daemon: snapshot(), columns: operation.columns, rows: operation.rows };
				case "terminal_resize":
					return {
						op: "terminal_resize",
						subscriptionId: operation.subscriptionId,
						name: operation.name,
						id: operation.id,
						columns: operation.columns,
						rows: operation.rows,
					};
				case "terminal_detach":
					return {
						op: "terminal_detach",
						subscriptionId: operation.subscriptionId,
						name: operation.name,
						id: operation.id,
					};
				case "terminal_ack":
					return {
						op: "terminal_ack",
						subscriptionId: operation.subscriptionId,
						name: operation.name,
						id: operation.id,
						sequence: operation.sequence,
					};
				case "send":
					return { op: "send", daemon: snapshot() };
				default:
					throw new Error(`unexpected fake broker operation ${operation.op}`);
			}
		},
		close() {
			state.closed = true;
		},
	};
	return {
		client: client as unknown as DaemonBrokerClient,
		operations,
		sinks,
		emit(frame: DaemonTerminalNotification) {
			for (const sink of sinks.values()) sink(frame);
		},
		waitForOperation(predicate, message) {
			const observed = operations.find(predicate);
			if (observed) return Promise.resolve(observed);
			const { promise, resolve } = Promise.withResolvers<void>();
			waiters.push({ predicate, resolve });
			return withTimeout(promise, 2_000, message).then(() => operations.find(predicate)!);
		},
		get closed() {
			return state.closed;
		},
	};
}

class FakeTerminal implements TerminalMirrorInput, TerminalMirrorOutput {
	readonly writes: string[] = [];
	readonly rawModes: boolean[] = [];
	restores = 0;
	pauses = 0;
	acceptWrites = true;
	#data: ((data: string) => void) | undefined;
	#resize: (() => void) | undefined;
	#signal: ((signal: TerminalMirrorSignal) => void) | undefined;
	#drain: (() => void) | undefined;

	onData = (listener: (data: string) => void): (() => void) => {
		this.#data = listener;
		return () => {
			this.#data = undefined;
		};
	};
	setRawMode(raw: boolean): void {
		this.rawModes.push(raw);
	}
	resume(): void {}
	pause(): void {
		this.pauses++;
	}
	write(data: string): boolean {
		this.writes.push(data);
		return this.acceptWrites;
	}
	onDrain = (listener: () => void): (() => void) => {
		this.#drain = listener;
		return () => {
			this.#drain = undefined;
		};
	};
	onResize = (listener: () => void): (() => void) => {
		this.#resize = listener;
		return () => {
			this.#resize = undefined;
		};
	};
	onSignal = (listener: (signal: TerminalMirrorSignal) => void): (() => void) => {
		this.#signal = listener;
		return () => {
			this.#signal = undefined;
		};
	};
	restore = (): void => {
		this.restores++;
	};
	type(data: string): void {
		this.#data?.(data);
	}
	resize(): void {
		this.#resize?.();
	}
	signal(signal: TerminalMirrorSignal): void {
		this.#signal?.(signal);
	}
	drain(): void {
		this.#drain?.();
	}
}

function startMirror(
	terminal: FakeTerminal,
	client: DaemonBrokerClient,
	overrides: Partial<TerminalMirrorOptions> = {},
): Promise<TerminalMirrorResult> {
	return runTerminalMirror({
		client,
		name: NAME,
		id: ID,
		subscriptionId: SUBSCRIPTION,
		input: terminal,
		output: terminal,
		size: () => ({ columns: 120, rows: 40 }),
		onResize: terminal.onResize,
		onSignal: terminal.onSignal,
		restore: terminal.restore,
		...overrides,
	});
}

function outputFrame(sequence: number, data: string): DaemonTerminalNotification {
	return { event: "terminal_output", subscriptionId: SUBSCRIPTION, name: NAME, id: ID, sequence, data };
}

function exitFrame(exitCode: number): DaemonTerminalExitNotification {
	return {
		event: "terminal_exit",
		subscriptionId: SUBSCRIPTION,
		name: NAME,
		id: ID,
		exitCode,
		reason: "exit",
	};
}

describe("a terminal mirror", () => {
	it("writes streamed output in order and acknowledges after each local write", async () => {
		const broker = fakeBroker();
		const terminal = new FakeTerminal();
		const running = startMirror(terminal, broker.client);
		await broker.waitForOperation(operation => operation.op === "terminal_attach", "mirror never attached");

		broker.emit(outputFrame(7, "first"));
		broker.emit(outputFrame(8, "second"));
		const acked = await broker.waitForOperation(
			operation => operation.op === "terminal_ack" && operation.sequence === 8,
			"second frame was never acknowledged",
		);
		expect(acked.op).toBe("terminal_ack");
		expect(terminal.writes.join("")).toBe("firstsecond");
		expect(
			broker.operations.flatMap(operation => (operation.op === "terminal_ack" ? [operation.sequence] : [])),
		).toEqual([7, 8]);
		expect(broker.operations.some(operation => operation.op === "stop")).toBe(false);

		broker.emit(exitFrame(0));
		expect(await running).toEqual({ detached: false, exitCode: 0, reason: "exit" });
		expect(terminal.rawModes.at(-1)).toBe(false);
		expect(broker.closed).toBe(true);
		expect(broker.operations.some(operation => operation.op === "terminal_detach")).toBe(false);
	});

	it("replays buffered first frames before live output without reattaching", async () => {
		const broker = fakeBroker();
		const terminal = new FakeTerminal();
		const running = startMirror(terminal, broker.client, {
			alreadyAttached: true,
			initialFrames: [outputFrame(1, "first"), outputFrame(2, "second")],
		});
		await broker.waitForOperation(
			operation => operation.op === "terminal_ack" && operation.sequence === 2,
			"buffered frames were never acknowledged",
		);
		expect(broker.operations.some(operation => operation.op === "terminal_attach")).toBe(false);
		expect(terminal.writes.join("")).toBe("firstsecond");

		broker.emit(outputFrame(3, "third"));
		await broker.waitForOperation(
			operation => operation.op === "terminal_ack" && operation.sequence === 3,
			"live frame after replay was never acknowledged",
		);
		expect(terminal.writes.join("")).toBe("firstsecondthird");

		broker.emit(exitFrame(0));
		expect(await running).toEqual({ detached: false, exitCode: 0, reason: "exit" });
	});

	it("clamps invalid local sizes before attaching and resizing", async () => {
		const broker = fakeBroker();
		const terminal = new FakeTerminal();
		let columns = 0;
		let rows = -1;
		const running = startMirror(terminal, broker.client, {
			size: () => ({ columns, rows }),
		});
		const attached = await broker.waitForOperation(
			operation => operation.op === "terminal_attach",
			"mirror never attached",
		);
		expect(attached).toMatchObject({ columns: 120, rows: 40 });

		columns = Number.NaN;
		rows = 0;
		terminal.resize();
		const resized = await broker.waitForOperation(
			operation => operation.op === "terminal_resize",
			"resize was never forwarded",
		);
		expect(resized).toMatchObject({ columns: 120, rows: 40 });

		broker.emit(exitFrame(0));
		expect(await running).toEqual({ detached: false, exitCode: 0, reason: "exit" });
	});

	it("waits for a local drain before acknowledging a backpressured write", async () => {
		const broker = fakeBroker();
		const terminal = new FakeTerminal();
		terminal.acceptWrites = false;
		const running = startMirror(terminal, broker.client);
		await broker.waitForOperation(operation => operation.op === "terminal_attach", "mirror never attached");

		broker.emit(outputFrame(9, "blocked"));
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(terminal.writes).toEqual(["blocked"]);
		expect(broker.operations.some(operation => operation.op === "terminal_ack")).toBe(false);

		terminal.acceptWrites = true;
		terminal.drain();
		await broker.waitForOperation(
			operation => operation.op === "terminal_ack" && operation.sequence === 9,
			"drained frame was never acknowledged",
		);

		broker.emit(exitFrame(0));
		expect(await running).toEqual({ detached: false, exitCode: 0, reason: "exit" });
	});

	it("does not replay input or resize received before a strict refresh completes", async () => {
		const broker = fakeBroker();
		const terminal = new FakeTerminal();
		const refreshing = Promise.withResolvers<void>();
		const refresh = Promise.withResolvers<void>();
		const running = startMirror(terminal, broker.client, {
			inputAfterRefresh: true,
			refresh: () => {
				refreshing.resolve();
				return refresh.promise;
			},
		});
		await refreshing.promise;
		terminal.type("must not replay");
		terminal.resize();
		expect(broker.operations.map(operation => operation.op)).toEqual(["terminal_attach"]);
		refresh.resolve();
		await nextImmediate();
		terminal.type("explicit input");
		terminal.resize();
		expect(broker.operations.filter(operation => operation.op === "send")).toEqual([
			{ op: "send", name: NAME, id: ID, data: "explicit input" },
		]);
		expect(broker.operations.filter(operation => operation.op === "terminal_resize")).toHaveLength(1);
		terminal.signal("SIGHUP");
		expect(await running).toEqual({ detached: true });
	});

	it("admits input before showing a strict attach repaint and only acknowledges visible output", async () => {
		const broker = fakeBroker();
		const terminal = new FakeTerminal();
		const refreshing = Promise.withResolvers<void>();
		const refresh = Promise.withResolvers<void>();
		terminal.write = data => {
			terminal.writes.push(data);
			terminal.type("typed on paint");
			return true;
		};
		const running = startMirror(terminal, broker.client, {
			inputAfterRefresh: true,
			refresh: () => {
				refreshing.resolve();
				return refresh.promise;
			},
		});
		try {
			await refreshing.promise;
			broker.emit(outputFrame(1, "owner repaint"));
			await nextImmediate();
			expect(terminal.writes).toEqual([]);
			expect(broker.operations.some(operation => operation.op === "terminal_ack")).toBe(false);
			refresh.resolve();
			await broker.waitForOperation(operation => operation.op === "send", "input on first paint was lost");
			expect(broker.operations.find(operation => operation.op === "send")).toMatchObject({
				name: NAME,
				id: ID,
				data: "typed on paint",
			});
			await broker.waitForOperation(
				operation => operation.op === "terminal_ack" && operation.sequence === 1,
				"visible repaint was never acknowledged",
			);
			expect(terminal.writes).toEqual(["owner repaint"]);
		} finally {
			refresh.resolve();
			terminal.signal("SIGHUP");
			await running;
		}
	});

	it("forwards raw input unchanged, resizes the owner, and detaches on a local hangup", async () => {
		const broker = fakeBroker();
		const terminal = new FakeTerminal();
		const running = startMirror(terminal, broker.client);
		await broker.waitForOperation(operation => operation.op === "terminal_attach", "mirror never attached");

		terminal.type("\u0003λ");
		const sent = await broker.waitForOperation(operation => operation.op === "send", "input was never forwarded");
		expect(sent).toEqual({ op: "send", name: NAME, id: ID, data: "\u0003λ" });

		terminal.resize();
		const resized = await broker.waitForOperation(
			operation => operation.op === "terminal_resize",
			"resize was never forwarded",
		);
		expect(resized).toEqual({
			op: "terminal_resize",
			subscriptionId: SUBSCRIPTION,
			name: NAME,
			id: ID,
			columns: 120,
			rows: 40,
		});

		terminal.signal("SIGHUP");
		expect(await running).toEqual({ detached: true });
		expect(broker.operations.find(operation => operation.op === "terminal_detach")).toEqual({
			op: "terminal_detach",
			subscriptionId: SUBSCRIPTION,
			name: NAME,
			id: ID,
		});
		expect(terminal.rawModes).toEqual([true, false]);
		expect(terminal.restores).toBe(1);
		expect(terminal.pauses).toBe(1);
		expect(broker.closed).toBe(true);
		expect(broker.operations.some(operation => operation.op === "stop")).toBe(false);
	});

	it("detaches only itself when its renderer refresh fails", async () => {
		const broker = fakeBroker();
		const terminal = new FakeTerminal();
		const order: string[] = [];
		const running = startMirror(terminal, broker.client, {
			refresh: async () => {
				order.push("refresh");
				throw new Error("refresh refused");
			},
		});
		await expect(running).rejects.toThrow("refresh refused");
		expect(order).toEqual(["refresh"]);
		expect(broker.operations[0]?.op).toBe("terminal_attach");
		expect(broker.operations.filter(operation => operation.op === "terminal_detach")).toHaveLength(1);
		expect(broker.operations.some(operation => operation.op === "stop")).toBe(false);
		expect(broker.closed).toBe(true);
	});

	it("detaches once when repeated local signals arrive together", async () => {
		const broker = fakeBroker();
		const terminal = new FakeTerminal();
		const running = startMirror(terminal, broker.client);
		await broker.waitForOperation(operation => operation.op === "terminal_attach", "mirror never attached");

		terminal.signal("SIGTERM");
		terminal.signal("SIGHUP");
		expect(await running).toEqual({ detached: true });
		expect(broker.operations.filter(operation => operation.op === "terminal_detach")).toHaveLength(1);
		expect(terminal.rawModes).toEqual([true, false]);
		expect(terminal.restores).toBe(1);
		expect(terminal.pauses).toBe(1);
	});

	it("detaches this mirror when the owner rejects forwarded input", async () => {
		const broker = fakeBroker({ rejectSend: true });
		const terminal = new FakeTerminal();
		const running = startMirror(terminal, broker.client);
		await broker.waitForOperation(operation => operation.op === "terminal_attach", "mirror never attached");

		terminal.type("x");
		expect(await running).toEqual({ detached: true });
		expect(broker.operations.filter(operation => operation.op === "terminal_detach")).toHaveLength(1);
		expect(terminal.rawModes.at(-1)).toBe(false);
		expect(broker.closed).toBe(true);
	});
});
