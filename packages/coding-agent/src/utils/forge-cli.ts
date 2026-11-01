import * as path from "node:path";
import { $which, untilAborted } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { REJECT_PROMPT_COMMAND } from "../exec/non-interactive-env";
import { ToolAbortError, throwIfAborted } from "../tools/tool-errors";

/**
 * Process-lifetime cache of a forge's default-repo lookup (`gh repo view`,
 * `glab repo view`) keyed by absolute cwd.
 *
 * The shared lookup is intentionally **not** bound to any caller's
 * AbortSignal. Cancelling one caller would otherwise kill the underlying
 * subprocess for every concurrent waiter on the same cwd. Each caller's
 * signal is honored at the wait point via `untilAborted` instead, so an abort
 * unwinds only that caller. Failures are not cached.
 */
export class CwdLookupMemo {
	readonly #resolved = new Map<string, string>();
	readonly #inflight = new Map<string, Promise<string>>();

	constructor(private readonly lookup: (cwd: string) => Promise<string>) {}

	get(cwd: string, signal?: AbortSignal): Promise<string> {
		const key = path.resolve(cwd);
		const ready = this.#resolved.get(key);
		if (ready) return Promise.resolve(ready);
		let pending = this.#inflight.get(key);
		if (!pending) {
			pending = this.lookup(cwd).then(value => {
				this.#resolved.set(key, value);
				return value;
			});
			const settled = () => this.#inflight.delete(key);
			void pending.then(settled, settled);
			this.#inflight.set(key, pending);
		}
		return untilAborted(signal, pending);
	}

	clear(): void {
		this.#resolved.clear();
		this.#inflight.clear();
	}
}

/** Captured result of a completed forge CLI (`gh`/`glab`) invocation. */
export interface ForgeCliResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	/** True when stdout exceeded the subprocess capture byte cap. */
	stdoutTruncated?: boolean;
}

/** Static description of a forge CLI binary and how to spawn it. */
export interface ForgeCliSpec {
	bin: string;
	displayName: string;
	/** Thrown as a `ToolError` when the binary is not on PATH. */
	installMessage: string;
	env: Record<string, string | undefined>;
	timeoutMs: number;
}

/** Env shared by every forge CLI: disables git/ssh credential and editor prompts. */
export const FORGE_NON_INTERACTIVE_ENV: Record<string, string | undefined> = {
	...process.env,
	GIT_ASKPASS: "true",
	GIT_EDITOR: "true",
	GIT_TERMINAL_PROMPT: "0",
	LC_ALL: undefined,
	LC_MESSAGES: "C",
	SSH_ASKPASS: REJECT_PROMPT_COMMAND,
};

const OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;

interface CapturedForgeText {
	text: string;
	truncated: boolean;
}

async function readCappedText(stream: ReadableStream<Uint8Array>, bin: string): Promise<CapturedForgeText> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let captured = 0;
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (captured < OUTPUT_LIMIT_BYTES) {
				const take = Math.min(value.byteLength, OUTPUT_LIMIT_BYTES - captured);
				if (take > 0) chunks.push(value.subarray(0, take));
				captured += take;
			}
		}
	} finally {
		reader.releaseLock();
	}
	const text = Buffer.concat(chunks).toString("utf8");
	const truncated = total > OUTPUT_LIMIT_BYTES;
	return { text: truncated ? `${text}\n[${bin} subprocess output truncated after 8 MiB]\n` : text, truncated };
}

/** Run a forge CLI command with bounded capture and a deadline. Does not throw on non-zero exit. */
export async function runForgeCli(
	spec: ForgeCliSpec,
	cwd: string,
	args: string[],
	signal: AbortSignal | undefined,
	trimOutput: boolean,
): Promise<ForgeCliResult> {
	throwIfAborted(signal);
	if (!$which(spec.bin)) throw new ToolError(spec.installMessage);
	const timeoutSignal = AbortSignal.timeout(spec.timeoutMs);
	const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	try {
		const child = Bun.spawn([spec.bin, ...args], {
			cwd,
			env: spec.env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
			signal: combinedSignal,
		});
		if (!(child.stdout instanceof ReadableStream) || !(child.stderr instanceof ReadableStream)) {
			throw new ToolError(`Failed to capture ${spec.displayName} output.`);
		}
		const [stdout, stderr, exitCode] = await Promise.all([
			readCappedText(child.stdout, spec.bin),
			readCappedText(child.stderr, spec.bin),
			child.exited,
		]);
		throwIfAborted(signal);
		return {
			exitCode: exitCode ?? 0,
			stdout: trimOutput ? stdout.text.trim() : stdout.text,
			stderr: trimOutput ? stderr.text.trim() : stderr.text,
			stdoutTruncated: stdout.truncated,
		};
	} catch (error) {
		if (signal?.aborted) throw new ToolAbortError();
		if (timeoutSignal.aborted) {
			throw new ToolError(`${spec.displayName} command timed out: ${spec.bin} ${args.join(" ")}`);
		}
		throw error;
	}
}
