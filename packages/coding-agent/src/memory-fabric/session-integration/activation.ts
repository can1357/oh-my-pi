/**
 * Memory Fabric — activation.
 *
 * Everything shipped so far is inert: classes that must be constructed and
 * wired before they do anything. That is deliberate, but it leaves one question
 * unanswered — who constructs them, and when? This module is the answer, and it
 * is the only place in the fabric that reads the environment.
 *
 * The contract is narrow on purpose:
 *
 *   - **Off by default.** With `OMP_MEMORY_FABRIC` unset, {@link
 *     activateMemoryFabric} returns `null` and constructs nothing at all — no
 *     bus, no engine, no listeners. A session that never sets the flag pays
 *     exactly one string comparison for the whole subsystem.
 *   - **Unknown means off.** A typo in the flag disables memory rather than
 *     silently selecting a rung nobody asked for.
 *   - **Acting requires a backend.** `active` without a {@link
 *     GuardianRetrievalPort} is a misconfiguration, not a licence to inject
 *     empty context, so it is downgraded to `observe` and the downgrade is
 *     reported on the runtime rather than hidden.
 *
 * The returned runtime owns two buses that are easy to confuse, so they are
 * named rather than merged: the *guardian* bus carries the rich events the
 * decision engine scores, and the *lifecycle* bus carries the session-shaped
 * events the bridge publishes. The guardian participant is what translates
 * between them.
 *
 * Nothing here is re-exported from `memory-fabric/index.ts`, and this module
 * still does not install itself into a session — a call site must ask for it.
 */

import type { GuardianConfig, GuardianMemoryRecord, GuardianMode } from "../guardian/decision-engine";
import { SessionEventBus as GuardianEventBus } from "../guardian/event-bus";
import type {
	GuardianComposedContext,
	GuardianReporter,
	GuardianRetrievalPort,
	GuardianRuntime,
	GuardianScope,
} from "../guardian/integration";
import { initializeGuardian } from "../guardian/integration";
import { MemorySessionBridge } from "./bridge";
import { createSessionMemoryParticipant } from "./create-participant";
import { InProcessSessionEventBus } from "./event-bus";
import type { ToolResultDescriber, TurnDescriber } from "./guardian-participant";
import type { MemorySessionScope } from "./types";

/** The environment variable that decides whether memory runs, and how far. */
export const MEMORY_FABRIC_ENV_VAR = "OMP_MEMORY_FABRIC";

/**
 * How much the fabric is allowed to do.
 *
 *  - `off`     — nothing is constructed.
 *  - `observe` — events are scored and recorded; context is never altered.
 *  - `active`  — decisions are carried out, including injecting context.
 */
export type MemoryFabricStage = "off" | "observe" | "active";

/** Stages in which the fabric is running at all. */
export type LiveMemoryFabricStage = Exclude<MemoryFabricStage, "off">;

const OFF_VALUES: ReadonlySet<string> = new Set(["", "0", "off", "false", "no"]);
const OBSERVE_VALUES: ReadonlySet<string> = new Set(["1", "on", "true", "yes", "observe"]);

const STAGE_MODES: Record<LiveMemoryFabricStage, GuardianMode> = {
	observe: "observe",
	active: "active",
};

/**
 * Read the requested stage from an environment.
 *
 * Pure, and exported separately so a call site can decide whether to build the
 * dependencies at all before paying for them.
 */
export function readMemoryFabricStage(env: Record<string, string | undefined> = process.env): MemoryFabricStage {
	const raw = env[MEMORY_FABRIC_ENV_VAR];
	if (raw === undefined) return "off";

	const value = raw.trim().toLowerCase();
	if (OFF_VALUES.has(value)) return "off";
	if (OBSERVE_VALUES.has(value)) return "observe";
	if (value === "active") return "active";

	// Anything unrecognised is a typo, and a typo must not enable memory.
	return "off";
}

export interface MemoryFabricActivationOptions {
	/** Identifies the session the fabric is being attached to. */
	scope: MemorySessionScope;
	/** Defaults to `process.env`. */
	env?: Record<string, string | undefined>;
	/** Overrides the environment entirely. Intended for tests and for `--flags`. */
	stage?: MemoryFabricStage;
	/** The retrieval backend. Without one, `active` is downgraded to `observe`. */
	port?: GuardianRetrievalPort;
	/** Where the guardian says what it did. Defaults to silence. */
	reporter?: GuardianReporter;
	/** Guardian tuning. `mode` is ignored: the stage decides it. */
	guardianConfig?: Partial<GuardianConfig>;
	/** Supplies the messages a `before-model` guardian event needs. */
	describeTurn?: TurnDescriber;
	/** Supplies the result a `tool-result` guardian event needs. */
	describeToolResult?: ToolResultDescriber;
	/** Budget for interactive hooks. */
	normalDeadlineMs?: number;
	/** Budget for checkpoint hooks. */
	checkpointDeadlineMs?: number;
	/** When false, hook failures re-raise instead of degrading. */
	failOpen?: boolean;
	/** Injectable clock, for deterministic tests. */
	now?: () => number;
	/** Injectable id source, for deterministic tests. */
	newId?: () => string;
}

export interface MemoryFabricRuntime {
	/** The stage actually running, after any downgrade. */
	stage: LiveMemoryFabricStage;
	/** The stage that was asked for, which may differ from {@link stage}. */
	requestedStage: LiveMemoryFabricStage;
	/** Set when the requested stage could not be honoured, with the reason. */
	downgradeReason?: string;
	/** What a session calls at the boundaries of a turn. */
	bridge: MemorySessionBridge;
	/** The decision engine and the integration acting on its decisions. */
	guardian: GuardianRuntime;
	/** Carries the session-shaped events the bridge publishes. */
	lifecycleBus: InProcessSessionEventBus;
	/** Carries the rich events the decision engine scores. */
	guardianBus: GuardianEventBus;
	/** Detach everything. Idempotent. */
	dispose(): void;
}

/**
 * A backend that knows nothing.
 *
 * Retrieval is not part of this change, so `observe` needs something that
 * satisfies the port without pretending to have memories. Every method returns
 * the empty answer, which is exactly what "measure, alter nothing" requires.
 */
export function createInertRetrievalPort(): GuardianRetrievalPort {
	return {
		async retrieve(): Promise<GuardianMemoryRecord[]> {
			return [];
		},
		async getWorkingState(): Promise<null> {
			return null;
		},
		async composeContext(): Promise<GuardianComposedContext> {
			return { text: "", recordIds: [], tokenCount: 0 };
		},
	};
}

function toGuardianScope(scope: MemorySessionScope): GuardianScope {
	const guardianScope: GuardianScope = { projectId: scope.projectId, sessionId: scope.sessionId };
	if (scope.worktreeId !== undefined) guardianScope.worktreeId = scope.worktreeId;
	if (scope.branchId !== undefined) guardianScope.branchId = scope.branchId;
	return guardianScope;
}

/**
 * Construct and wire the fabric, or return `null` when it is switched off.
 *
 * The caller owns the result and must {@link MemoryFabricRuntime.dispose} it
 * when the session ends; the guardian holds bus subscriptions that would
 * otherwise outlive the session that created them.
 */
export function activateMemoryFabric(options: MemoryFabricActivationOptions): MemoryFabricRuntime | null {
	const requested = options.stage ?? readMemoryFabricStage(options.env);
	if (requested === "off") return null;

	let stage: LiveMemoryFabricStage = requested;
	let downgradeReason: string | undefined;
	if (stage === "active" && !options.port) {
		stage = "observe";
		downgradeReason = "no retrieval port was supplied, so there is nothing to inject";
	}

	const guardianBus = new GuardianEventBus();
	const guardian = initializeGuardian(
		guardianBus,
		{
			scope: toGuardianScope(options.scope),
			port: options.port ?? createInertRetrievalPort(),
			...(options.reporter ? { reporter: options.reporter } : {}),
		},
		{ ...options.guardianConfig, enabled: true, mode: STAGE_MODES[stage] },
	);

	const participant = createSessionMemoryParticipant({
		guardian: {
			bus: guardianBus,
			injections: guardian.integration,
			...(options.port ? { port: options.port } : {}),
			...(options.describeTurn ? { describeTurn: options.describeTurn } : {}),
			...(options.describeToolResult ? { describeToolResult: options.describeToolResult } : {}),
		},
	});

	const lifecycleBus = new InProcessSessionEventBus();
	const bridge = new MemorySessionBridge({
		scope: options.scope,
		eventBus: lifecycleBus,
		participant,
		...(options.normalDeadlineMs !== undefined ? { normalDeadlineMs: options.normalDeadlineMs } : {}),
		...(options.checkpointDeadlineMs !== undefined ? { checkpointDeadlineMs: options.checkpointDeadlineMs } : {}),
		...(options.failOpen !== undefined ? { failOpen: options.failOpen } : {}),
		...(options.now ? { now: options.now } : {}),
		...(options.newId ? { newId: options.newId } : {}),
	});

	const runtime: MemoryFabricRuntime = {
		stage,
		requestedStage: requested,
		bridge,
		guardian,
		lifecycleBus,
		guardianBus,
		dispose(): void {
			guardian.dispose();
		},
	};
	if (downgradeReason !== undefined) runtime.downgradeReason = downgradeReason;
	return runtime;
}
