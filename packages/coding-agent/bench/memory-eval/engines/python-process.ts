/** JSON-lines client for the harness's Python helper processes (the Mnemosyne engine and the embedding server). */
import { readJsonl, toError } from "@oh-my-pi/pi-utils";
import { envWithout } from "../env";

const STDERR_TAIL_CHARS = 4000;
const EXIT_GRACE_MS = 5000;
/** After stdout EOF, how long the exit code and the rest of stderr may take to arrive for the error message. */
const EOF_GRACE_MS = 1000;

interface WireResponse {
	id: number;
	result?: unknown;
	error?: string;
}

/** One Python process. The first failure (error response, bad output, exit, EOF) rejects the pending call and every later call. */
export class PythonProcess {
	readonly #label: string;
	readonly #proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
	readonly #pending = new Map<number, PromiseWithResolvers<unknown>>();
	readonly #done: Promise<void>;
	#nextId = 1;
	#failure: Error | undefined;
	#stderrTail = "";

	constructor(label: string, python: string, script: string, env: Record<string, string | undefined>) {
		this.#label = label;
		// PYTHONPATH, PYTHONHOME and the like could import other code than the pinned venv while versions still match.
		this.#proc = Bun.spawn([python, script], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: envWithout("PYTHON", env),
		});
		this.#done = this.#pump(this.#collectStderr());
	}

	/** The first failure, if any. Callers whose errors a library swallows check this to fail loudly. */
	get failure(): Error | undefined {
		return this.#failure;
	}

	async call(op: string, params: object = {}): Promise<unknown> {
		if (this.#failure) throw this.#failure;
		const id = this.#nextId++;
		const waiter = Promise.withResolvers<unknown>();
		this.#pending.set(id, waiter);
		try {
			this.#proc.stdin.write(`${JSON.stringify({ id, op, params })}\n`);
			await this.#proc.stdin.flush();
		} catch (err) {
			// A broken pipe means the process is gone: wait for the pump to attach its exit code and stderr.
			await this.#done;
			this.#fail(toError(err));
		}
		return waiter.promise;
	}

	/** Ends stdin so the script exits, killing it if it does not within the grace period. */
	async shutdown(): Promise<void> {
		const killer = setTimeout(() => this.#proc.kill(), EXIT_GRACE_MS);
		try {
			await this.#proc.stdin.end();
		} catch {
			// The process already exited.
		}
		try {
			// The pump stops waiting at stdout EOF, so wait for the exit itself.
			await this.#done;
			await this.#proc.exited;
		} finally {
			clearTimeout(killer);
		}
	}

	#fail(error: Error): void {
		this.#failure ??= error;
		for (const waiter of this.#pending.values()) waiter.reject(this.#failure);
		this.#pending.clear();
	}

	#settle(response: WireResponse): void {
		if (response.error !== undefined) return this.#fail(new Error(response.error));
		const waiter = this.#pending.get(response.id);
		if (!waiter) return this.#fail(new Error(`${this.#label} answered unknown request ${response.id}`));
		this.#pending.delete(response.id);
		waiter.resolve(response.result);
	}

	async #collectStderr(): Promise<void> {
		const decoder = new TextDecoder();
		for await (const chunk of this.#proc.stderr) {
			this.#stderrTail = (this.#stderrTail + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL_CHARS);
		}
	}

	async #pump(stderrDone: Promise<void>): Promise<void> {
		try {
			for await (const response of readJsonl<WireResponse>(this.#proc.stdout)) this.#settle(response);
			// No response can come after stdout EOF: fail now, waiting only briefly for the exit code and stderr.
			const grace = Promise.withResolvers<string>();
			// Unref'd: a normal exit must not hold the harness open for the rest of the grace period.
			setTimeout(grace.resolve, EOF_GRACE_MS, "closed stdout").unref();
			const exit = await Promise.race([
				Promise.all([stderrDone, this.#proc.exited]).then(([, code]) => `exited with code ${code}`),
				grace.promise,
			]);
			this.#fail(new Error(`${this.#label} ${exit}: ${this.#stderrTail.trim()}`));
		} catch (err) {
			// A line that is not JSON ends the stream, and the first failure stands.
			this.#fail(
				err instanceof SyntaxError
					? new Error(`${this.#label} wrote a non-protocol line: ${err.message}`)
					: toError(err),
			);
		}
	}
}
