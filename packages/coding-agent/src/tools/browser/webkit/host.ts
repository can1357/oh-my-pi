/**
 * omp's WebKit host process: the ABKit engine directory's `ABHost`, started
 * with no arguments (every profile ephemeral) and driven over its standard
 * streams. Requests go to its stdin and answers come from its stdout in the
 * framing and JSON protocol of the Tern daemon (`../tern/wire.ts`), so the
 * same client and tab driver work against it; its stderr carries diagnostics
 * only. The host exits when its stdin closes, so it never outlives omp.
 *
 * The host has no window. Where the engine ships its viewer program
 * (`viewer.ts`), a tab is shown by presenting its block to the viewer and
 * hidden by stopping that: the page itself does not change, and sees a
 * visible, focused window either way.
 */
import * as path from "node:path";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { logger, readLines } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";
import { gracefulKillTreeOnce } from "../attach";
import type { TernInputStep } from "../tern/keys";
import { TernSocketClient, type TernTransport, type TernTransportEvents } from "../tern/wire";
import { WebKitViewer } from "./viewer";

/** How long a host may take to exit after its stdin closed before its process tree is killed. */
const EXIT_GRACE_MS = 2_000;
/** How long the host's last output may trail its exit (or its exit trail the end of its output). */
const DRAIN_MS = 250;

/** omp's WebKit host cannot run here: it did not start, or could not open its first tab. An open falls back to Chromium. */
export class WebKitUnavailableError extends ToolError {}

/** A host child process as the wire client's byte stream: frames to its stdin, frames from its stdout. */
class HostProcessTransport implements TernTransport {
	readonly product = "WebKit";
	readonly peer: string;
	readonly waitsForEvents = true;
	readonly #executable: string;
	#child: Subprocess<"pipe", "pipe", "pipe"> | undefined;
	#ended = false;

	constructor(executable: string) {
		this.#executable = executable;
		this.peer = `WebKit host ${executable}`;
	}

	/** The host process, once started. */
	get child(): Subprocess<"pipe", "pipe", "pipe"> | undefined {
		return this.#child;
	}

	start(events: TernTransportEvents): void {
		const child = Bun.spawn([this.#executable], {
			cwd: path.dirname(this.#executable),
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		// A host nobody closed must not hold omp open; it exits with omp's end of its stdin.
		child.unref();
		this.#child = child;
		const drained = (async () => {
			let failure: string | undefined;
			try {
				for await (const chunk of child.stdout) events.data(chunk);
			} catch (error) {
				failure = error instanceof Error ? error.message : String(error);
			}
			// Output normally ends because the process did: let its exit name the reason.
			await Promise.race([child.exited, Bun.sleep(DRAIN_MS)]);
			if (child.exitCode === null && child.signalCode === null) {
				events.close(failure ?? "the process closed its output");
			}
		})();
		void child.exited.then(async () => {
			// Answers written just before the exit are still in the pipe (which a descendant may hold open).
			await Promise.race([drained, Bun.sleep(DRAIN_MS)]);
			events.close(
				child.signalCode
					? `the process was killed by ${child.signalCode}`
					: `the process exited with code ${child.exitCode}`,
			);
		});
		void (async () => {
			const decoder = new TextDecoder();
			try {
				for await (const line of readLines(child.stderr)) {
					logger.debug("WebKit host stderr", { pid: child.pid, line: decoder.decode(line) });
				}
			} catch (error) {
				logger.debug("WebKit host stderr closed", { pid: child.pid, error: String(error) });
			}
		})();
		events.open();
	}

	write(frame: Uint8Array): void {
		const child = this.#child;
		if (!child || this.#ended) throw new Error("the host's input is closed");
		child.stdin.write(frame);
		// A broken pipe is reported by the process's exit; the flush itself must not go unhandled.
		void Promise.resolve(child.stdin.flush()).catch(() => undefined);
	}

	/** Close the host's stdin, which tells it to close every block and exit. */
	close(): void {
		if (this.#ended) return;
		this.#ended = true;
		const child = this.#child;
		if (!child) return;
		try {
			void Promise.resolve(child.stdin.end()).catch(() => undefined);
		} catch (error) {
			logger.debug("Failed to close the WebKit host's input", { pid: child.pid, error: String(error) });
		}
	}
}

/** One running WebKit host process and the protocol connection over its standard streams. */
export class WebKitHost {
	/** The connection every tab of this host opens and drives its block through. */
	readonly client: TernSocketClient;
	readonly #transport: HostProcessTransport;
	/** Stands in for the session id of tabs no session owns. */
	readonly #unownedSeed = crypto.randomUUID();
	/** The engine's viewer program, when it ships one. */
	readonly #viewerPath: string | undefined;
	/** The viewer process, started with the first window and stopped with the last. */
	#viewer: Promise<WebKitViewer> | undefined;
	/** Blocks that have a window. */
	readonly #shown = new Set<number>();
	/** What the user did in the windows and the host has not been sent yet, by block. */
	readonly #userInput = new Map<number, TernInputStep[]>();
	#forwarding = false;

	constructor(executable: string, viewerPath?: string) {
		this.#transport = new HostProcessTransport(executable);
		this.client = new TernSocketClient({ transport: this.#transport });
		this.#viewerPath = viewerPath;
	}

	/**
	 * Start `executable` and greet it. A host that cannot be started, exits, or
	 * does not answer the greeting is a {@link WebKitUnavailableError}; what was
	 * started is stopped again.
	 */
	static async launch(executable: string, viewerPath?: string): Promise<WebKitHost> {
		const host = new WebKitHost(executable, viewerPath);
		try {
			await host.client.connect();
		} catch (error) {
			await host.close();
			throw new WebKitUnavailableError(error instanceof Error ? error.message : String(error));
		}
		logger.debug("WebKit host started", { executable, pid: host.pid });
		return host;
	}

	/** The host's process id. */
	get pid(): number | undefined {
		return this.#transport.child?.pid;
	}

	/**
	 * The `identity` op's noise seed for tabs of session `sessionId`: the same
	 * for every tab of a session (so a page reading a canvas twice, or in two
	 * tabs, sees one device) and different between sessions.
	 */
	identitySeed(sessionId: string | undefined): string {
		return Bun.hash
			.wyhash(sessionId ?? this.#unownedSeed)
			.toString(16)
			.padStart(16, "0");
	}

	/** Whether a tab of this host can have a window: the engine ships its viewer and the host presents blocks. */
	get canShow(): boolean {
		return this.#viewerPath !== undefined && this.client.supports("present");
	}

	/** Whether `block` has a window now. */
	isShown(block: number): boolean {
		return this.#shown.has(block);
	}

	/**
	 * Put `block` in a window titled `title`. Showing a shown block renames
	 * its window. Throws a {@link ToolError} when this engine cannot show
	 * windows or the viewer does not start.
	 */
	async show(block: number, title: string): Promise<void> {
		const viewerPath = this.#viewerPath;
		if (viewerPath === undefined || !this.canShow) {
			throw new ToolError("omp's WebKit browser cannot show a window here: its engine ships no viewer.");
		}
		this.#viewer ??= WebKitViewer.launch(viewerPath, {
			input: (source, events) => this.#userInputFrom(source, events),
			closed: (source, byUser) => void this.#windowClosed(source, byUser),
			exited: () => {
				this.#viewer = undefined;
				this.#shown.clear();
				this.#userInput.clear();
			},
		});
		let viewer: WebKitViewer;
		try {
			viewer = await this.#viewer;
		} catch (error) {
			this.#viewer = undefined;
			throw error;
		}
		viewer.show(block, title);
		await this.client.request({ op: "present", block, to: { mach: viewer.mach } });
		this.#shown.add(block);
	}

	/** Take `block`'s window away; the page goes on unseen. The viewer process ends with its last window. */
	async hide(block: number): Promise<void> {
		if (!this.#shown.delete(block)) return;
		this.#userInput.delete(block);
		// A block that closed meanwhile has nothing left to stop.
		await this.client.request({ op: "present", block, to: null }).catch(() => undefined);
		const viewer = await this.#viewer?.catch(() => undefined);
		viewer?.hide(block);
		this.#stopViewerWhenUnused();
	}

	/** A window went away on its own: the user closed it, or its block's presentation ended (the tab closed). */
	async #windowClosed(block: number, byUser: boolean): Promise<void> {
		if (byUser) {
			await this.hide(block);
			return;
		}
		this.#shown.delete(block);
		this.#userInput.delete(block);
		this.#stopViewerWhenUnused();
	}

	#stopViewerWhenUnused(): void {
		if (this.#shown.size > 0 || !this.#viewer) return;
		const viewer = this.#viewer;
		this.#viewer = undefined;
		void viewer.then(
			running => running.close(),
			() => undefined,
		);
	}

	/** Queue what the user did in `block`'s window; a run of pointer moves keeps only where it ended. */
	#userInputFrom(block: number, events: TernInputStep[]): void {
		if (!this.#shown.has(block)) return;
		const queued = this.#userInput.get(block) ?? [];
		for (const event of events) {
			const last = queued.at(-1);
			if (
				event.type === "mouse" &&
				event.action === "move" &&
				last?.type === "mouse" &&
				last.action === "move" &&
				last.button === event.button
			) {
				queued[queued.length - 1] = event;
			} else {
				queued.push(event);
			}
		}
		this.#userInput.set(block, queued);
		void this.#forwardUserInput();
	}

	/** Send the queued input to the host, one call at a time so steps keep their order. */
	async #forwardUserInput(): Promise<void> {
		if (this.#forwarding) return;
		this.#forwarding = true;
		try {
			for (;;) {
				const next = this.#userInput.entries().next();
				if (next.done) return;
				const [block, events] = next.value;
				this.#userInput.delete(block);
				try {
					await this.client.request({ op: "input", block, events });
				} catch (error) {
					// A key the host cannot play, or a block that closed under the pointer: the user's next input goes on.
					logger.debug("WebKit host did not take the window's input", { block, error: String(error) });
				}
			}
		} finally {
			this.#forwarding = false;
		}
	}

	/** Stop the host: close its stdin, and kill its process tree when it has not exited promptly. */
	async close(): Promise<void> {
		const viewer = this.#viewer;
		this.#viewer = undefined;
		this.#shown.clear();
		void viewer?.then(
			running => running.close(),
			() => undefined,
		);
		this.client.close();
		const child = this.#transport.child;
		if (!child) return;
		const grace = Promise.withResolvers<boolean>();
		const timer = setTimeout(() => grace.resolve(false), EXIT_GRACE_MS);
		const exited = await Promise.race([child.exited.then(() => true), grace.promise]);
		clearTimeout(timer);
		if (exited) return;
		logger.debug("WebKit host did not exit after its input closed; killing it", { pid: child.pid });
		await gracefulKillTreeOnce(child.pid);
	}
}
