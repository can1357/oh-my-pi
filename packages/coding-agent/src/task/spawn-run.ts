/**
 * A subagent run that holds one spawn-semaphore permit until it settles.
 *
 * The task tool starts every spawn through a `SpawnRun`: during dispatch, or
 * speculatively while the call's `tasks[]` still streams (see
 * `./speculative-launch`). The run executes detached from any owner; the
 * owner that adopts it binds its abort signal and progress/artifact sinks via
 * {@link SpawnRun.attach}, and the latest progress update replays on attach so
 * a run that advanced before adoption is not rendered as pending.
 */
import type { AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";
import { TextTap } from "../job-widgets/text-tap";
import { TOOLS_SOURCE_ID } from "../job-widgets/types";
import { TOOLS_SOURCE_LABEL } from "./widget-inputs";

/** Wall-clock stamps a spawn reports to the executor: call time and permit time. */
export interface SpawnLaunchTiming {
	invokedAt: number;
	acquiredAt: number;
}

/** Permit source bounding concurrent subagents; the task tool's session semaphore. */
export interface SpawnPermit {
	acquire(signal: AbortSignal): Promise<void>;
	release(): void;
}

/** Everything the run body needs from its `SpawnRun`. */
export interface SpawnRunBody {
	signal: AbortSignal;
	timing: SpawnLaunchTiming;
	onUpdate: AgentToolUpdateCallback<TaskToolDetails>;
	onArtifactsRetained: (cleanup: () => Promise<void>) => void;
	/** The run's {@link SpawnRun.tools} tap. */
	tools: TextTap;
}

/** Launch-time identity an adopter checks: the pre-claimed agent id and whether the run is job-detached. */
export interface SpawnIdentity {
	agentId?: string;
	detached: boolean;
}

/** Owner bindings applied when a run is adopted. */
export interface SpawnRunOwner {
	signal?: AbortSignal;
	onUpdate?: AgentToolUpdateCallback<TaskToolDetails>;
	onArtifactsRetained?: (cleanup: () => Promise<void>) => void;
}

export class SpawnRun {
	readonly #controller = new AbortController();
	#onUpdate: AgentToolUpdateCallback<TaskToolDetails> | undefined;
	#lastUpdate: AgentToolResult<TaskToolDetails> | undefined;
	#onArtifactsRetained: ((cleanup: () => Promise<void>) => void) | undefined;
	#retainedCleanup: (() => Promise<void>) | undefined;
	#discarded = false;
	/**
	 * The subagent's finished tool calls with their results, as the `tools`
	 * source of its job widget; closed once the run settles.
	 */
	readonly tools = new TextTap(TOOLS_SOURCE_ID, TOOLS_SOURCE_LABEL);
	/** Resolves once the permit is held; rejects with the acquire error when aborted first. */
	readonly started: Promise<SpawnLaunchTiming>;
	/** The run's payload; rejects only when `started` does. */
	readonly result: Promise<AgentToolResult<TaskToolDetails>>;

	/** Acquire a permit, then run `body` and release the permit when it settles. */
	constructor(
		permit: SpawnPermit,
		body: (run: SpawnRunBody) => Promise<AgentToolResult<TaskToolDetails>>,
		readonly identity: SpawnIdentity,
	) {
		const invokedAt = Date.now();
		this.started = permit.acquire(this.#controller.signal).then(() => ({ invokedAt, acquiredAt: Date.now() }));
		this.result = this.started.then(async timing => {
			try {
				return await body({
					signal: this.#controller.signal,
					timing,
					onUpdate: update => {
						this.#lastUpdate = update;
						return this.#onUpdate?.(update);
					},
					onArtifactsRetained: cleanup => {
						if (this.#onArtifactsRetained) this.#onArtifactsRetained(cleanup);
						else if (this.#discarded) void cleanup();
						else this.#retainedCleanup = cleanup;
					},
					tools: this.tools,
				});
			} finally {
				permit.release();
			}
		});
		// Close the tap once the run settles. The rejection handler also keeps an
		// unadopted run quiet: owners await `result` only after adoption, and a
		// discarded run is never awaited.
		const closeTools = () => this.tools.close();
		void this.result.then(closeTools, closeTools);
	}

	/** Bind the adopting owner: its abort cancels the run, and buffered progress/artifacts flush to it. */
	attach(owner: SpawnRunOwner): void {
		const signal = owner.signal;
		if (signal?.aborted) this.#controller.abort(signal.reason);
		else if (signal) {
			const onAbort = () => this.#controller.abort(signal.reason);
			signal.addEventListener("abort", onAbort, { once: true });
			// The owner signal can outlive the run (a session- or job-scoped signal that never
			// aborts); drop the listener once the run settles so the signal does not pin it.
			const detach = () => signal.removeEventListener("abort", onAbort);
			void this.result.then(detach, detach);
		}
		this.#onUpdate = owner.onUpdate;
		if (this.#lastUpdate) void owner.onUpdate?.(this.#lastUpdate);
		this.#onArtifactsRetained = owner.onArtifactsRetained;
		const retained = this.#retainedCleanup;
		this.#retainedCleanup = undefined;
		if (retained) {
			if (owner.onArtifactsRetained) owner.onArtifactsRetained(retained);
			else void retained();
		}
	}

	/** Abort an unadopted run and drop anything it retained; nothing ever consumes its result. */
	discard(reason: string): void {
		this.#discarded = true;
		this.#controller.abort(new Error(reason));
		const retained = this.#retainedCleanup;
		this.#retainedCleanup = undefined;
		if (retained) void retained();
	}
}
