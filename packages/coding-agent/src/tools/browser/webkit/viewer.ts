/**
 * The window process of omp's WebKit host: the engine's `ABView`, which
 * shows the blocks the host presents to it in windows (macOS). The host itself
 * never has a window; a tab gets one when its block is presented to this
 * process's Mach service, and loses it when the presentation stops. The
 * viewer is told about a block on its stdin and reports on its stdout, one
 * JSON object a line: what the user did in a window, as the host's `input`
 * steps, and windows that went away. It exits when its stdin closes, so it
 * never outlives omp.
 */
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { isRecord, logger, readLines } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";
import type { TernInputStep } from "../tern/keys";

/** How long a viewer may take to check in its Mach service and say so. */
const READY_TIMEOUT_MS = 5_000;

/** What a viewer reports to the host object that started it. */
export interface WebKitViewerEvents {
	/** The user's mouse, wheel and keys in `block`'s window, as steps of the host's `input` op. */
	input(block: number, events: TernInputStep[]): void;
	/** `block`'s window is gone: the user closed it (`byUser`), or the host stopped presenting the block. */
	closed(block: number, byUser: boolean): void;
	/** The viewer process ended; every window went with it. */
	exited(): void;
}

/** One running viewer process and the Mach service it takes presented blocks on. */
export class WebKitViewer {
	/** The Mach bootstrap service name a `present` op targets. */
	readonly mach: string;
	readonly #child: Subprocess<"pipe", "pipe", "pipe">;

	private constructor(child: Subprocess<"pipe", "pipe", "pipe">, mach: string) {
		this.#child = child;
		this.mach = mach;
	}

	/**
	 * Start `executable` and wait until its service is checked in. Throws a
	 * {@link ToolError} when it does not start or does not report its service.
	 */
	static async launch(executable: string, events: WebKitViewerEvents): Promise<WebKitViewer> {
		let child: Subprocess<"pipe", "pipe", "pipe">;
		try {
			child = Bun.spawn([executable], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		} catch (error) {
			throw new ToolError(`The WebKit browser's window program did not start: ${String(error)}`);
		}
		// Windows nobody closed must not hold omp open; the viewer exits with omp's end of its stdin.
		child.unref();
		const ready = Promise.withResolvers<string>();
		const decoder = new TextDecoder();
		void (async () => {
			try {
				for await (const line of readLines(child.stdout)) {
					let message: unknown;
					try {
						message = JSON.parse(decoder.decode(line));
					} catch {
						continue;
					}
					if (!isRecord(message)) continue;
					if (isRecord(message.ready) && typeof message.ready.mach === "string") ready.resolve(message.ready.mach);
					else if (isRecord(message.input) && typeof message.input.block === "number") {
						if (Array.isArray(message.input.events)) {
							events.input(message.input.block, message.input.events as TernInputStep[]);
						}
					} else if (isRecord(message.closed) && typeof message.closed.block === "number") {
						events.closed(message.closed.block, true);
					} else if (isRecord(message.ended) && typeof message.ended.block === "number") {
						events.closed(message.ended.block, false);
					}
				}
			} catch (error) {
				logger.debug("WebKit viewer output closed", { pid: child.pid, error: String(error) });
			}
		})();
		void (async () => {
			try {
				for await (const line of readLines(child.stderr)) {
					logger.debug("WebKit viewer stderr", { pid: child.pid, line: decoder.decode(line) });
				}
			} catch (error) {
				logger.debug("WebKit viewer stderr closed", { pid: child.pid, error: String(error) });
			}
		})();
		void child.exited.then(() => {
			ready.reject(new ToolError("The WebKit browser's window program exited before it was ready."));
			events.exited();
		});
		const timer = setTimeout(
			() => ready.reject(new ToolError("The WebKit browser's window program did not become ready.")),
			READY_TIMEOUT_MS,
		);
		try {
			return new WebKitViewer(child, await ready.promise);
		} catch (error) {
			child.kill();
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}

	#send(command: object): void {
		try {
			this.#child.stdin.write(`${JSON.stringify(command)}\n`);
			void Promise.resolve(this.#child.stdin.flush()).catch(() => undefined);
		} catch (error) {
			logger.debug("WebKit viewer input closed", { pid: this.#child.pid, error: String(error) });
		}
	}

	/**
	 * Name `block`'s window before the block is presented. The viewer sizes
	 * the window for a block at scale 1, which is what omp's tabs are opened
	 * at (a tab's `deviceScaleFactor` only scales its captures).
	 */
	show(block: number, title: string): void {
		this.#send({ show: { block, title } });
	}

	/** Close `block`'s window. */
	hide(block: number): void {
		this.#send({ hide: { block } });
	}

	/** Stop the viewer: close its stdin, which closes every window and ends the process. */
	close(): void {
		try {
			void Promise.resolve(this.#child.stdin.end()).catch(() => undefined);
		} catch (error) {
			logger.debug("Failed to close the WebKit viewer's input", { pid: this.#child.pid, error: String(error) });
		}
	}
}
