import { vi } from "bun:test";
import {
	ProcessIo,
	ProcessTerminal,
	type ProcessTerminalOptions,
	type TerminalHost,
	type TerminalIoSink,
} from "@oh-my-pi/pi-tui/terminal";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";

/** Construction-time choices for {@link fakeProcessTty}. */
export interface FakeTtyOptions {
	/** Keep the bun-test headless suppression on instead of opting out of it. */
	headless?: boolean;
	/** Fake `process.platform` for the duration of the test. */
	platform?: NodeJS.Platform;
}

/** A faked interactive TTY standing in for a process terminal's stdio, recording what reaches it. */
export interface FakeTty {
	/** Decoded output chunks, in write order. */
	readonly writes: string[];
	/** Signals the process sent itself (`process.kill`), in order. */
	readonly signals: Array<string | number | undefined>;
	/** Everything recorded since the last {@link clear}, concatenated. */
	output(): string;
	/** Forget the writes recorded so far. */
	clear(): void;
	/** The process port of a {@link ProcessTerminal} on this TTY. */
	io(): ProcessIo;
	/** A {@link ProcessTerminal} on this TTY. */
	terminal(options?: ProcessTerminalOptions): ProcessTerminal;
	/** Report `bytes` as the output backlog the terminal has not read; lowering it reports a drain. */
	setBacklog(bytes: number): void;
	/** Deliver raw stdin bytes the way a terminal read does. */
	type(data: string): void;
	/** End stdin, as a terminal host does when its pane disappears. */
	endInput(): void;
	/** Fail the output, as a revoked terminal descriptor does on write. */
	failOutput(err: Error): void;
	/** Restore every faked property and spy, and the previous headless default. */
	dispose(): void;
}

/** A host that ignores every engine event. */
export const NOOP_HOST: TerminalHost = { input() {}, paste() {}, render() {}, resize() {} };

/** A {@link TerminalHost} recording the events a terminal routes to it. */
export interface RecordingHost extends TerminalHost {
	readonly inputs: string[];
	/** Paste events: the text and the Enter that shared its read. */
	readonly pastes: Array<[text: string, enter: string | undefined]>;
	readonly renders: number;
	readonly disconnects: number;
}

/** Record host events; `onDisconnect` is what the app wires as its disconnect teardown. */
export function recordingHost(onDisconnect?: () => void): RecordingHost {
	const inputs: string[] = [];
	const pastes: Array<[text: string, enter: string | undefined]> = [];
	let renders = 0;
	let disconnects = 0;
	return {
		inputs,
		pastes,
		get renders() {
			return renders;
		},
		get disconnects() {
			return disconnects;
		},
		input: data => {
			inputs.push(data);
		},
		paste: (text, enter) => {
			pastes.push([text, enter]);
		},
		render: () => {
			renders++;
		},
		resize: () => {},
		disconnect: () => {
			disconnects++;
			onDisconnect?.();
		},
	};
}

const utf8Decoder = new TextDecoder();

/** Shared state of a {@link FakeTty} and its ports. */
interface FakeTtyState {
	readonly writes: string[];
	readonly ports: Set<FakeProcessIo>;
	backlog: number;
}

/**
 * The real process port with its stdio swapped for a capture port: the engine
 * captures its output (recorded by the fake TTY) and typed input reaches it
 * through the sink, so the `ProcessTerminal` glue — headless gating, geometry
 * from `process.stdout`, disconnect teardown and hangup, active-terminal
 * ownership — runs without the engine taking the test runner's stdin or
 * stdout. The engine's own stdio (raw mode, reader, writer) is covered by the
 * `term::stdin` and `term::pump` PTY tests in pi-natives.
 */
class FakeProcessIo extends ProcessIo {
	#sink: TerminalIoSink | undefined;

	constructor(readonly tty: FakeTtyState) {
		super();
	}

	override get processStdio(): boolean {
		return false;
	}

	override get backlog(): number {
		return this.tty.backlog;
	}

	get sink(): TerminalIoSink | undefined {
		return this.#sink;
	}

	override open(sink: TerminalIoSink): void {
		this.#sink = sink;
		this.tty.ports.add(this);
		super.open(sink);
	}

	override write(chunks: readonly Uint8Array[]): void {
		// The real port drops what a headless engine captured.
		if (this.headless) return;
		for (const chunk of chunks) this.tty.writes.push(utf8Decoder.decode(chunk));
	}

	override close(): void {
		this.#sink = undefined;
		this.tty.ports.delete(this);
		super.close();
	}
}

/**
 * Fake an interactive TTY for real `ProcessTerminal`s: they run their
 * non-headless path (capability probes, input handling, disconnect hangup)
 * with the engine's output recorded and stdin bytes injected. Make terminals
 * with {@link FakeTty.terminal}, and call {@link FakeTty.dispose} in
 * `afterEach`, after stopping every terminal the test started.
 */
export function fakeProcessTty(options: FakeTtyOptions = {}): FakeTty {
	const previousHeadless = setTerminalHeadless(options.headless ?? false);
	const descriptors: Array<[object, string, PropertyDescriptor | undefined]> = [
		[process.stdin, "isTTY", Object.getOwnPropertyDescriptor(process.stdin, "isTTY")],
		[process.stdout, "isTTY", Object.getOwnPropertyDescriptor(process.stdout, "isTTY")],
		[process, "platform", Object.getOwnPropertyDescriptor(process, "platform")],
	];
	const state: FakeTtyState = { writes: [], ports: new Set(), backlog: 0 };
	const signals: Array<string | number | undefined> = [];

	// The engine's terminal facts see an interactive TTY on both ends.
	Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	if (options.platform !== undefined) {
		Object.defineProperty(process, "platform", { value: options.platform, configurable: true });
	}
	const spies: Array<{ mockRestore(): void }> = [
		vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
			signals.push(signal);
			return true;
		}),
	];
	const io = (): ProcessIo => new FakeProcessIo(state);
	const sinks = (): TerminalIoSink[] => [...state.ports].flatMap(port => (port.sink === undefined ? [] : [port.sink]));

	return {
		writes: state.writes,
		signals,
		output: () => state.writes.join(""),
		clear: () => {
			state.writes.length = 0;
		},
		io,
		terminal: terminalOptions => new ProcessTerminal(terminalOptions, io()),
		setBacklog: bytes => {
			const previous = state.backlog;
			state.backlog = bytes;
			if (bytes < previous) for (const sink of sinks()) sink.drained();
		},
		type: data => {
			const bytes = Buffer.from(data);
			for (const sink of sinks()) sink.input(bytes);
		},
		endInput: () => {
			for (const sink of sinks()) sink.disconnected("stdin ended");
		},
		failOutput: err => {
			for (const sink of sinks()) sink.disconnected("stdout failed", err);
		},
		dispose: () => {
			for (const spy of spies) spy.mockRestore();
			for (const [target, key, descriptor] of descriptors) {
				if (descriptor) Object.defineProperty(target, key, descriptor);
				else Reflect.deleteProperty(target, key);
			}
			setTerminalHeadless(previousHeadless);
		},
	};
}
