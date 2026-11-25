/**
 * An MCP server started inside the OS sandbox, behind the {@link ManagedChild}
 * surface the host drives every subprocess upstream through.
 *
 * Such a server only ever lives in the session's in-process host
 * (`mcpHostAccess` routes it there), so it never crosses a daemon re-exec:
 * {@link ContainedManagedChild.state} refuses, and pausing holds output back
 * here instead of in the pipes.
 */
import { settleWithin } from "@oh-my-pi/pi-utils";
import { OUTPUT_DRAIN_GRACE_MS, OutputChannel } from "../../daemon/children";
import type { ChildExit, ManagedChild, ManagedChildState } from "../../daemon/module";
import { spawnContainedCommand } from "../../sandbox/command";
import type { SandboxRuntime } from "../../sandbox/runtime";
import type { SandboxChild } from "../../sandbox/types";
import type { McpStdioSpec } from "./contract";

/** Start the server of `spec`, already resolved to `argv`, contained by `sandbox`. */
export async function spawnContainedServer(
	sandbox: SandboxRuntime,
	spec: McpStdioSpec,
	argv: string[],
): Promise<ManagedChild> {
	const child = await spawnContainedCommand(sandbox, {
		argv,
		cwd: spec.cwd,
		what: "MCP stdio command",
		env: spec.env,
		network: spec.sandboxNetwork,
	});
	return new ContainedManagedChild(child);
}

/** One output stream of a contained child, held back while paused. */
class HeldOutput {
	readonly channel = new OutputChannel();
	#held: Uint8Array[] | undefined;

	push(chunk: Uint8Array): void {
		if (this.#held) this.#held.push(chunk);
		else this.channel.push(chunk);
	}

	pause(): void {
		this.#held ??= [];
	}

	resume(): void {
		const held = this.#held;
		this.#held = undefined;
		for (const chunk of held ?? []) this.channel.push(chunk);
	}
}

async function pump(stream: ReadableStream<Uint8Array>, output: HeldOutput): Promise<void> {
	try {
		for await (const chunk of stream) output.push(chunk);
	} catch {
		// The stream broke with the child; whatever arrived was delivered.
	}
}

class ContainedManagedChild implements ManagedChild {
	readonly pid: number;
	readonly exited: Promise<ChildExit>;
	readonly #child: SandboxChild;
	readonly #stdout = new HeldOutput();
	readonly #stderr = new HeldOutput();
	#done = false;
	#inputClosed = false;

	constructor(child: SandboxChild) {
		this.#child = child;
		this.pid = child.pid;
		const pumps = Promise.all([pump(child.stdout, this.#stdout), pump(child.stderr, this.#stderr)]);
		this.exited = (async (): Promise<ChildExit> => {
			const exitCode = await child.exited;
			// Output written right before exit may still be in flight; a descendant holding the pipes open must not hold the exit.
			await settleWithin(pumps, OUTPUT_DRAIN_GRACE_MS);
			this.#done = true;
			this.closeInput();
			return { exitCode };
		})();
	}

	write(data: string | Uint8Array): boolean {
		if (this.#done || this.#inputClosed) return false;
		this.#child.stdin.write(data);
		this.#child.stdin.flush();
		return true;
	}

	drained(): Promise<void> {
		return Promise.resolve();
	}

	closeInput(): void {
		if (this.#inputClosed) return;
		this.#inputClosed = true;
		try {
			this.#child.stdin.end();
		} catch {
			// Already closed with the child.
		}
	}

	onStdout(sink: (chunk: Uint8Array) => void): void {
		this.#stdout.channel.attach(sink);
	}

	onStderr(sink: (chunk: Uint8Array) => void): void {
		this.#stderr.channel.attach(sink);
	}

	/** No signal crosses the sandbox: any `kill` ends the whole contained tree. */
	kill(): void {
		if (this.#done) return;
		this.#child.kill();
	}

	async pauseOutput(): Promise<void> {
		this.#stdout.pause();
		this.#stderr.pause();
	}

	resumeOutput(): void {
		this.#stdout.resume();
		this.#stderr.resume();
	}

	state(): ManagedChildState {
		throw new Error("A contained MCP server cannot be handed across a daemon re-exec");
	}
}
