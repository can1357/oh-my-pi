import { logger } from "@oh-my-pi/pi-utils";
import type { DaemonBrokerClient } from "./client";
import {
	type DaemonTerminalExitNotification,
	type DaemonTerminalNotification,
	type DaemonTerminalOutputNotification,
	sanitizeTerminalGeometry,
} from "./protocol";

/** Raw local bytes and the local terminal modes a mirror borrows while attached. */
export interface TerminalMirrorInput {
	/** Register a listener for local terminal bytes; returns the uninstall. */
	onData(listener: (data: string) => void): () => void;
	/** Enter (`true`) or leave (`false`) raw mode; absent on a non-terminal stdin. */
	setRawMode?(raw: boolean): void;
	resume?(): void;
	pause?(): void;
}

/** The local terminal sink; `false` from `write` means wait for `onDrain`. */
export interface TerminalMirrorOutput {
	write(data: string): boolean | void;
	onDrain?(listener: () => void): () => void;
}

/** Current local viewport; the owner PTY is resized to it. */
export interface TerminalMirrorSize {
	readonly columns: number;
	readonly rows: number;
}

export type TerminalMirrorSignal = "SIGHUP" | "SIGTERM" | "SIGINT";

/** A mirror only ever returns; the owner's lifetime is not this process's to end. */
export interface TerminalMirrorResult {
	/** True when the local terminal went away and only this mirror detached. */
	readonly detached: boolean;
	readonly exitCode?: number;
	readonly reason?: string;
}

export interface TerminalMirrorOptions {
	readonly client: DaemonBrokerClient;
	readonly name: string;
	readonly id: string;
	readonly subscriptionId: string;
	readonly input?: TerminalMirrorInput;
	readonly output?: TerminalMirrorOutput;
	readonly size?: () => TerminalMirrorSize;
	/** Subscribe to local viewport changes; returns the uninstall. */
	readonly onResize?: (listener: () => void) => () => void;
	/** Subscribe to local terminal-death signals; returns the uninstall. */
	readonly onSignal?: (listener: (signal: TerminalMirrorSignal) => void) => () => void;
	/** Restore the local terminal's modes after detach. Must not touch the owner. */
	readonly restore?: () => void;
	/**
	 * Ask the owner's renderer for a full repaint once this subscription is
	 * live. A rejected refresh detaches only this mirror.
	 */
	readonly refresh?: () => Promise<void>;
	readonly inputAfterRefresh?: boolean;
	/**
	 * The subscription is already installed by `terminal_start`; skip the
	 * redundant attach that would only revalidate and resize the same PTY.
	 */
	readonly alreadyAttached?: boolean;
	/** Frames produced before this mirror replaced the boot sink, replayed in order. */
	readonly initialFrames?: readonly DaemonTerminalNotification[];
}

const LOCAL_SIGNALS: readonly TerminalMirrorSignal[] = ["SIGHUP", "SIGTERM", "SIGINT"];

function defaultInput(): TerminalMirrorInput {
	const stdin = process.stdin;
	return {
		onData(listener) {
			const wrapped = (chunk: Buffer | string): void => listener(String(chunk));
			stdin.on("data", wrapped);
			return () => {
				stdin.off("data", wrapped);
			};
		},
		setRawMode(raw) {
			if (stdin.isTTY) stdin.setRawMode(raw);
		},
		resume: () => stdin.resume(),
		pause: () => stdin.pause(),
	};
}

function defaultOutput(): TerminalMirrorOutput {
	const stdout = process.stdout;
	return {
		write: data => stdout.write(data),
		onDrain(listener) {
			stdout.on("drain", listener);
			return () => {
				stdout.off("drain", listener);
			};
		},
	};
}

function defaultSize(): TerminalMirrorSize {
	return sanitizeTerminalGeometry(process.stdout.columns, process.stdout.rows);
}

function normalizeSize(size: TerminalMirrorSize): TerminalMirrorSize {
	return sanitizeTerminalGeometry(size.columns, size.rows);
}

function defaultResize(listener: () => void): () => void {
	process.stdout.on("resize", listener);
	return () => {
		process.stdout.off("resize", listener);
	};
}

function defaultSignals(listener: (signal: TerminalMirrorSignal) => void): () => void {
	const handlers = LOCAL_SIGNALS.map(signal => {
		const handler = (): void => listener(signal);
		process.on(signal, handler);
		return { signal, handler } as const;
	});
	return () => {
		for (const { signal, handler } of handlers) process.off(signal, handler);
	};
}

async function writeAccepted(output: TerminalMirrorOutput, data: string): Promise<void> {
	let accepted: boolean | void;
	try {
		accepted = output.write(data);
	} catch (error) {
		logger.warn("Terminal mirror failed to write local output", {
			error: error instanceof Error ? error.message : String(error),
		});
		return;
	}
	if (accepted !== false) return;
	const onDrain = output.onDrain;
	if (!onDrain) return;
	const { promise, resolve } = Promise.withResolvers<void>();
	const off = onDrain(resolve);
	try {
		await promise;
	} finally {
		off();
	}
}

/**
 * Mirror one live owner PTY into this process's terminal.
 *
 * The mirror owns only its broker subscription and its local terminal: losing
 * it (a signal, a closed stdin, or SIGKILL where no cleanup runs at all) ends
 * this process, never the owner. Detach here means unsubscribe plus local
 * mode restoration; no session, socket or dispose path is reachable.
 */
export async function runTerminalMirror(options: TerminalMirrorOptions): Promise<TerminalMirrorResult> {
	const input = options.input ?? defaultInput();
	const output = options.output ?? defaultOutput();
	const size = options.size ?? defaultSize;
	const onResize = options.onResize ?? defaultResize;
	const onSignal = options.onSignal ?? defaultSignals;

	const finish = Promise.withResolvers<TerminalMirrorResult>();
	let finished = false;
	let acceptingInput = options.inputAfterRefresh !== true;
	// Keep the visible screen and input admission atomic for an exact-owner attach.
	// Unacknowledged output remains bounded by the broker's subscription byte limit.
	const pendingOutput: DaemonTerminalOutputNotification[] = [];
	let removeInput: (() => void) | undefined;
	let removeResize: (() => void) | undefined;
	let removeSignals: (() => void) | undefined;

	const releaseLocalTerminal = (): void => {
		removeInput?.();
		removeResize?.();
		removeSignals?.();
		removeInput = undefined;
		removeResize = undefined;
		removeSignals = undefined;
		try {
			input.setRawMode?.(false);
		} catch {}
		try {
			options.restore?.();
		} catch (error) {
			logger.warn("Terminal mirror failed to restore the local terminal", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		try {
			input.pause?.();
		} catch {}
	};

	const handleFrame = (frame: DaemonTerminalNotification): void => {
		if (finished) return;
		if (frame.event === "terminal_exit") {
			finishExit(frame);
			return;
		}
		if (!acceptingInput) {
			pendingOutput.push(frame);
			return;
		}
		void writeAccepted(output, frame.data).then(() => {
			if (finished) return;
			void options.client
				.request({
					op: "terminal_ack",
					subscriptionId: options.subscriptionId,
					name: options.name,
					id: options.id,
					sequence: frame.sequence,
				})
				.catch(() => undefined);
		});
	};
	const unsubscribe = options.client.subscribeTerminal(options.subscriptionId, handleFrame);

	const settle = (result: TerminalMirrorResult): void => {
		if (finished) return;
		finished = true;
		pendingOutput.length = 0;
		unsubscribe();
		releaseLocalTerminal();
		finish.resolve(result);
	};

	const finishExit = (frame: DaemonTerminalExitNotification): void => {
		options.client.close();
		settle({ detached: false, exitCode: frame.exitCode, reason: frame.reason });
	};

	let detachPromise: Promise<void> | undefined;
	const detach = (): Promise<void> => {
		if (finished) return Promise.resolve();
		if (detachPromise) return detachPromise;
		detachPromise = (async () => {
			await options.client
				.request({
					op: "terminal_detach",
					subscriptionId: options.subscriptionId,
					name: options.name,
					id: options.id,
				})
				.catch(() => undefined);
			options.client.close();
			settle({ detached: true });
		})();
		return detachPromise;
	};

	try {
		input.setRawMode?.(true);
		input.resume?.();
		const viewport = normalizeSize(size());
		removeResize = onResize(() => {
			if (finished || !acceptingInput) return;
			const current = normalizeSize(size());
			void options.client
				.request({
					op: "terminal_resize",
					subscriptionId: options.subscriptionId,
					name: options.name,
					id: options.id,
					columns: current.columns,
					rows: current.rows,
				})
				.catch(() => undefined);
		});
		removeInput = input.onData(data => {
			if (finished || !acceptingInput) return;
			void options.client.request({ op: "send", name: options.name, id: options.id, data }).catch(error => {
				if (finished) return;
				logger.warn("Terminal mirror input failed; detaching this mirror", {
					error: error instanceof Error ? error.message : String(error),
				});
				void detach();
			});
		});
		removeSignals = onSignal(signal => {
			logger.debug("Terminal mirror detaching on local signal", { signal });
			void detach();
		});

		if (!options.alreadyAttached) {
			await options.client.request({
				op: "terminal_attach",
				subscriptionId: options.subscriptionId,
				name: options.name,
				id: options.id,
				columns: viewport.columns,
				rows: viewport.rows,
			});
		}
		for (const frame of options.initialFrames ?? []) handleFrame(frame);
		if (finished) return finish.promise;
		if (options.refresh) {
			try {
				await options.refresh();
			} catch (error) {
				await detach();
				throw error;
			}
		}
		if (finished) return finish.promise;
		acceptingInput = true;
		for (const frame of pendingOutput.splice(0)) handleFrame(frame);
	} catch (error) {
		if (!finished) {
			finished = true;
			unsubscribe();
			releaseLocalTerminal();
			options.client.close();
		}
		throw error;
	}

	return finish.promise;
}
