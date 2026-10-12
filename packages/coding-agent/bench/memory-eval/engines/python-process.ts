/** JSON-lines client for the harness's Python helper processes (the Mnemosyne engine and the embedding server). */
import { readLines } from "@oh-my-pi/pi-utils";

const STDERR_TAIL_CHARS = 4000;
const EXIT_GRACE_MS = 5000;

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
		this.#proc = Bun.spawn([python, script], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
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
			this.#fail(err instanceof Error ? err : new Error(String(err)));
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
			await this.#done;
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
		const decoder = new TextDecoder();
		try {
			for await (const bytes of readLines(this.#proc.stdout)) {
				const line = decoder.decode(bytes);
				if (line.trim() === "") continue;
				let response: WireResponse;
				try {
					response = JSON.parse(line);
				} catch {
					this.#fail(new Error(`${this.#label} wrote a non-protocol line: ${line.slice(0, 200)}`));
					continue;
				}
				this.#settle(response);
			}
			await stderrDone;
			const code = await this.#proc.exited;
			this.#fail(new Error(`${this.#label} exited with code ${code}: ${this.#stderrTail.trim()}`));
		} catch (err) {
			this.#fail(err instanceof Error ? err : new Error(String(err)));
		}
	}
}
