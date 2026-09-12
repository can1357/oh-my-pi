import type {
	AgentToolCall,
	AgentToolResult,
	SpeculativeChildHandle,
	SpeculativeOperationSink,
	ToolSpeculationStreamSession,
} from "@oh-my-pi/pi-agent-core";
import type { ToolSession } from "../../tools";
import { namespaceSessionId as namespaceJavaScriptSessionId } from "../js";
import { shadowPlanIfPresent, snapshotVmContext } from "../js/context-manager";
import type { RuntimeCallIdentity } from "../js/shared/runtime";
import { shadowSnapshotDigest } from "../js/shared/runtime";
import type { JsStatusEvent } from "../js/shared/types";
import { bridgeValueFromToolResult } from "../js/tool-bridge";
import { namespaceSessionId as namespacePythonSessionId } from "../py";
import { shadowPlanPythonIfPresent, snapshotPythonNamespaceIfPresent } from "../py/executor";
import { type ShadowClaimKey, ShadowClaimStore } from "./claim-store";
import { EvalArgsStreamDecoder } from "./eval-args-stream";
import { evaluateShadowExpression } from "./evaluator";
import type { ShadowOperation, ShadowPlan, ShadowValue } from "./types";

interface ClaimedChild {
	handle: SpeculativeChildHandle;
	args: Readonly<Record<string, unknown>>;
	name: string;
	operationId: string;
}

export interface EvalShadowCellOptions {
	coordinator: SpeculativeOperationSink;
	parentToolCallId: string;
	session: ToolSession;
	cwd: string;
	sessionId: string;
	kernelOwnerId?: string;
	emitStatus?: (event: JsStatusEvent) => void;
	onDiscard?: () => void;
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => [key, canonicalize(item)]),
	);
}

function fingerprint(args: unknown): string {
	const canonicalArgs =
		args && typeof args === "object" && !Array.isArray(args)
			? Object.fromEntries(Object.entries(args as Record<string, unknown>).filter(([key]) => key !== "i"))
			: args;
	return JSON.stringify(canonicalize(canonicalArgs));
}

function asArgs(value: unknown): Readonly<Record<string, unknown>> | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Readonly<Record<string, unknown>>;
}

export class EvalShadowCellSession implements ToolSpeculationStreamSession {
	readonly #options: EvalShadowCellOptions;
	readonly #decoder = new EvalArgsStreamDecoder();
	readonly #claims = new ShadowClaimStore<ClaimedChild>();
	readonly contextIndependent = true;
	readonly #admitted = new Map<string, Promise<void>>();
	/** Admission attempts that ran to settlement (returned or threw). */
	readonly #admissionSettled = new Set<string>();
	/**
	 * Operations whose speculative execution started (the coordinator
	 * admitted them). Evaluation succeeds only against committed results
	 * (see claim()), so a started execution always uses committed arguments
	 * and is never re-admitted.
	 */
	readonly #admissionExecuted = new Set<string>();
	readonly #results = new Map<string, ShadowValue>();
	readonly #runtimeOccurrences = new Map<string, number>();
	#occurrenceAssignment = Promise.resolve();
	#snapshot: Readonly<Record<string, ShadowValue | unknown>> | undefined;
	#lastPlan: { code: string; language: string; plan: ShadowPlan | null } | undefined;
	#snapshotToken: { language: string; revision: number; digest: string } | undefined;
	#closed = false;
	#updates = Promise.resolve();
	#pendingPlan: { codePrefix: string; language: string } | undefined;
	#planning = false;

	constructor(options: EvalShadowCellOptions) {
		this.#options = options;
	}

	async update(_toolCall: AgentToolCall, partialJson?: string): Promise<void> {
		if (this.#closed || partialJson === undefined) return;
		const decoded = this.#decoder.update(partialJson);
		if (decoded.kind === "snapshot" ? decoded.snapshot.restart : decoded.restart) {
			await this.discard("streamed eval argument buffer restarted");
			return;
		}
		if (decoded.kind === "disabled") {
			await this.discard(`streamed eval argument decoding disabled: ${decoded.reason}`);
			return;
		}
		if (decoded.kind !== "snapshot") return;
		if (decoded.snapshot.reset === true) {
			await this.discard("reset eval cells cannot use retained shadow state");
			return;
		}
		if (decoded.snapshot.language === undefined && !decoded.snapshot.complete) return;
		if (decoded.snapshot.reset === undefined && !decoded.snapshot.complete) return;
		// Complete snapshots always carry language (the decoder disables languageless
		// objects); an undefined language here can only be a decoder bug — withhold.
		if (decoded.snapshot.language === undefined) return;
		const language = decoded.snapshot.language;
		this.#pendingPlan = { codePrefix: decoded.snapshot.codePrefix, language };
		if (!this.#planning) {
			this.#planning = true;
			this.#updates = this.#drainPlanUpdates();
		}
	}

	async #drainPlanUpdates(): Promise<void> {
		try {
			while (!this.#closed) {
				const pending = this.#pendingPlan;
				if (!pending) return;
				this.#pendingPlan = undefined;
				await this.#plan(pending.codePrefix, pending.language).catch(() => undefined);
			}
		} finally {
			this.#planning = false;
		}
	}

	async finalize(context: { args: Readonly<Record<string, unknown>> }): Promise<void> {
		if (this.#closed) return;
		if (!this.#decoder.matchesFinal(context.args)) {
			await this.discard("final eval arguments do not match streamed shadow plan");
			return;
		}
		await this.#updates;
		// Re-project the final arguments: streamed prefixes may have admitted
		// operations that later source invalidates (e.g. a hoisted `tool` shadow
		// appended after the read streamed). matchesFinal only checks the prefix
		// relationship, so verify every admitted operation still projects from the
		// final code; anything else discards the session before the authoritative
		// cell can claim it. Physical work already started cannot be undone — this
		// bounds it to claimless candidates that can never commit.
		if (!(await this.#verifyFinalPlan(context.args))) {
			await this.discard("final eval arguments invalidate an admitted speculative operation");
		}
	}
	/**
	 * Whether the streamed plan still authorizes these final arguments. The
	 * coordinator re-checks after hook/transform reconciliation and discards
	 * the session on mismatch, so deferred work planned from replaced code
	 * never releases. Pure: safe to call any number of times.
	 */
	matchesFinalArgs(args: Readonly<Record<string, unknown>>): boolean {
		return this.#decoder.matchesFinal(args);
	}

	async #verifyFinalPlan(args: Readonly<Record<string, unknown>>): Promise<boolean> {
		const { code, language } = args as { code?: unknown; language?: unknown };
		if (typeof code !== "string" || (language !== "js" && language !== "py")) return false;
		// The streamed drain already reconciled admissions against this exact code:
		// re-projecting would plan it twice (and break the coalescing contract
		// that only the newest pending prefix is planned). Re-project only when
		// the final arguments were never streamed.
		const last = this.#lastPlan;
		const plan =
			last && last.code === code && last.language === language ? last.plan : await this.#project(code, language);
		if (!plan) return this.#admitted.size === 0;
		const plannedOperationIds = new Set(plan.operations.map(operation => operation.call.id));
		return [...this.#admitted.keys()].every(id => plannedOperationIds.has(id));
	}

	/** Revision/digest captured by the first shadow plan, if any planning ran. */
	get snapshotToken(): { language: string; revision: number; digest: string } | undefined {
		return this.#snapshotToken;
	}

	/**
	 * Re-checks the retained namespace against the planning snapshot.
	 *
	 * Retained state may change between streamed planning and dispatch (timers,
	 * background work, concurrent session users). A mismatch means admitted
	 * children were projected from stale state: the caller must discard this
	 * session and run the cell without it. Fail-closed on any error or when no
	 * retained backend answers. Known residual: the check and the later cell
	 * start are two round trips, so a mutation landing exactly between them is
	 * still caught only by claim fingerprinting — use the atomic
	 * runIfSnapshotMatches/executeIfSnapshotMatches paths where available.
	 */
	async verifySnapshotCurrent(): Promise<boolean> {
		const token = this.#snapshotToken;
		if (!token) return true;
		try {
			if (token.language === "js") {
				const snapshot = await snapshotVmContext({
					sessionKey: namespaceJavaScriptSessionId(this.#options.sessionId),
					cwd: this.#options.cwd,
					sessionId: namespaceJavaScriptSessionId(this.#options.sessionId),
				});
				if (!snapshot) return false;
				return snapshot.revision === token.revision && shadowSnapshotDigest(snapshot) === token.digest;
			}
			if (token.language === "py") {
				const snapshot = await snapshotPythonNamespaceIfPresent({
					cwd: this.#options.cwd,
					sessionId: namespacePythonSessionId(this.#options.sessionId),
					kernelOwnerId: this.#options.kernelOwnerId,
				});
				if (!snapshot) return false;
				return snapshot.revision === token.revision && snapshot.digest === token.digest;
			}
			return false;
		} catch {
			return false;
		}
	}

	commit(): void {}

	async discard(reason: string): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#pendingPlan = undefined;
		this.#claims.discard();
		try {
			if (this.#options.coordinator.discardChildren) {
				await this.#options.coordinator.discardChildren(this.#options.parentToolCallId, reason);
			} else {
				await this.#options.coordinator.close(reason);
			}
			await Promise.allSettled(this.#admitted.values());
		} finally {
			this.#options.onDiscard?.();
		}
	}

	async claim(
		name: string,
		args: unknown,
		identity: RuntimeCallIdentity,
		remainingTimeoutMs: number,
		signal?: AbortSignal,
	): Promise<AgentToolResult<unknown> | undefined> {
		const normalized = asArgs(args);
		if (!normalized || signal?.aborted) return undefined;
		const outcome = await this.#claims.claimRuntimeAsync(
			{
				siteId: identity.siteId,
				name,
				fingerprint: fingerprint(normalized),
				occurrence: identity.occurrence,
			},
			remainingTimeoutMs,
			signal,
		);
		if (!outcome || signal?.aborted) return undefined;
		const committed = await outcome.value.handle.commit(outcome.value.args);
		if (committed) this.#noteCommittedResult(outcome.value.operationId, outcome.value.name, normalized, committed);
		return committed;
	}

	/**
	 * Records a committed child result and admits dependents waiting on it.
	 *
	 * Dependent arguments must derive from the committed (visible) result, not the
	 * pre-commit physical outcome: commit policies can transform the value (e.g. a
	 * repeat-read hint appended on the third identical read), and admitting from
	 * the physical result would start speculative I/O for arguments the
	 * authoritative cell never uses. Never throws: this runs on the authoritative
	 * claim path, where a projection failure must degrade to unadmitted
	 * dependents, never to a failed cell.
	 */
	#noteCommittedResult(
		operationId: string,
		name: string,
		args: Readonly<Record<string, unknown>>,
		committed: AgentToolResult<unknown>,
	): void {
		try {
			const value = bridgeValueFromToolResult(name, args, committed);
			this.#results.set(operationId, {
				value,
				origins: [{ kind: "local_read", resource: String(args.path ?? "") }],
			});
		} catch {
			return;
		}
		const plan = this.#lastPlan?.plan;
		if (!plan) return;
		for (const operation of plan.operations) {
			if (!operation.call.dependencies.includes(operationId)) continue;
			// A started execution already uses committed arguments, and an
			// in-flight admission evaluates against them when it resumes —
			// re-admit only a settled attempt that skipped for lack of results.
			if (this.#admissionExecuted.has(operation.call.id)) continue;
			if (this.#admitted.has(operation.call.id) && !this.#admissionSettled.has(operation.call.id)) continue;
			void this.#admitOperation(operation, true).catch(() => undefined);
		}
	}

	async claimValue(
		name: string,
		args: unknown,
		identity: RuntimeCallIdentity,
		remainingTimeoutMs: number,
	): Promise<unknown | undefined> {
		const result = await this.claim(name, args, identity, remainingTimeoutMs);
		if (!result) return undefined;
		return bridgeValueFromToolResult(name, args, result, this.#options.emitStatus);
	}

	async #project(code: string, language: string): Promise<ShadowPlan | null> {
		let plan: ShadowPlan | null = null;
		if (language === "js") {
			const projected = await shadowPlanIfPresent({
				sessionKey: namespaceJavaScriptSessionId(this.#options.sessionId),
				cwd: this.#options.cwd,
				sessionId: namespaceJavaScriptSessionId(this.#options.sessionId),
				code,
			});
			if (projected) {
				this.#snapshot ??= projected.snapshot.values;
				this.#snapshotToken ??= { language, revision: projected.snapshot.revision, digest: projected.digest };
				plan = projected.plan;
			}
		} else if (language === "py") {
			const projected = await shadowPlanPythonIfPresent({
				cwd: this.#options.cwd,
				sessionId: namespacePythonSessionId(this.#options.sessionId),
				kernelOwnerId: this.#options.kernelOwnerId,
				code,
			});
			if (projected) {
				this.#snapshot ??= projected.snapshot.values;
				plan = projected;
				this.#snapshotToken ??= {
					language,
					revision: projected.snapshot.revision,
					digest: projected.snapshot.digest,
				};
			}
		}
		this.#lastPlan = { code, language, plan };
		return plan;
	}

	async #plan(code: string, language: string): Promise<void> {
		if (this.#closed || !code) return;
		const plan = await this.#project(code, language);
		if (!plan || !this.#snapshot) {
			if (this.#admitted.size > 0) await this.discard("streamed eval prefix cannot retain speculative operations");
			return;
		}
		const plannedOperationIds = new Set(plan.operations.map(operation => operation.call.id));
		if ([...this.#admitted.keys()].some(id => !plannedOperationIds.has(id))) {
			await this.discard("streamed eval prefix removed a speculative operation");
			return;
		}

		let unresolvedControlStart = Number.POSITIVE_INFINITY;
		for (const control of plan.controls ?? []) {
			if (control.kind === "conditional") {
				unresolvedControlStart = Math.min(unresolvedControlStart, control.span.start);
			}
		}
		for (const operation of plan.operations) {
			if (operation.call.controlDependencies.length > 0 || operation.call.span.start >= unresolvedControlStart) {
				continue;
			}
			this.#admitOperation(operation);
		}
	}

	async #admitOperation(operation: ShadowOperation, readmit = false): Promise<void> {
		if (!readmit && this.#admitted.has(operation.call.id)) return;
		this.#admissionSettled.delete(operation.call.id);
		const previousOccurrenceAssignment = this.#occurrenceAssignment;
		const occurrenceAssigned = Promise.withResolvers<void>();
		this.#occurrenceAssignment = occurrenceAssigned.promise;
		const admission = this.#admitWhenReady(operation, previousOccurrenceAssignment, occurrenceAssigned.resolve);
		this.#admitted.set(operation.call.id, admission);
		void admission
			.finally(() => {
				this.#admissionSettled.add(operation.call.id);
			})
			.catch(() => undefined);
	}

	async #admitWhenReady(
		operation: ShadowOperation,
		previousOccurrenceAssignment: Promise<void>,
		releaseOccurrenceAssignment: () => void,
	): Promise<void> {
		let occurrenceAssigned = false;
		const release = () => {
			if (occurrenceAssigned) return;
			occurrenceAssigned = true;
			releaseOccurrenceAssignment();
		};
		try {
			if (operation.call.controlDependencies.length > 0) return;
			await Promise.all(operation.call.dependencies.map(id => this.#admitted.get(id)));
			if (this.#closed || !this.#snapshot) return;
			let evaluated: ShadowValue;
			try {
				evaluated = evaluateShadowExpression(operation.call.args, {
					snapshot: this.#snapshot,
					results: this.#results,
				});
			} catch {
				return;
			}
			if (operation.call.name !== "read") return;
			const runtimeArgs = evaluated.value;
			const executionArgs = asArgs(runtimeArgs);
			if (!executionArgs) return;
			const tool = this.#options.session.getToolForEvalBridge?.("read");
			if (!tool) return;
			await previousOccurrenceAssignment;
			const runtimeOccurrenceKey = `${operation.call.siteId}\0${operation.call.name}`;
			const runtimeOccurrence = this.#runtimeOccurrences.get(runtimeOccurrenceKey) ?? 0;
			this.#runtimeOccurrences.set(runtimeOccurrenceKey, runtimeOccurrence + 1);
			release();
			const key: ShadowClaimKey = {
				siteId: operation.call.siteId,
				dynamicPath: operation.call.dynamicPath.join("/"),
				name: operation.call.name,
				fingerprint: fingerprint(runtimeArgs),
				occurrence: operation.call.occurrence,
			};
			const candidateId = `${this.#options.parentToolCallId}:${operation.call.id}`;
			const handle = await this.#options.coordinator.admit({
				candidateId,
				parentToolCallId: this.#options.parentToolCallId,
				dependencies: operation.call.dependencies.map(id => `${this.#options.parentToolCallId}:${id}`),
				toolCall: { type: "toolCall", id: candidateId, name: operation.call.name, arguments: executionArgs },
				tool,
				source: "eval_shadow",
			});
			if (!handle) return;
			this.#admissionExecuted.add(operation.call.id);
			this.#claims.register(key, runtimeOccurrence);
			const startedAt = performance.now();
			try {
				const outcome = await handle.outcome;
				if (outcome.kind !== "result") {
					this.#claims.miss(key);
					await handle.discard("speculative child did not produce a reusable result").catch(() => undefined);
					return;
				}
				const virtualDurationMs = performance.now() - startedAt;
				if (outcome.isError) {
					this.#claims.miss(key);
					await handle.discard("speculative child returned an error").catch(() => undefined);
					return;
				}
				// Dependent arguments are derived only from committed results (see
				// claim()): the physical outcome may still be transformed or vetoed
				// before it becomes visible, so recording it here would admit
				// dependents against bytes the authoritative cell never observes.
				this.#claims.add(key, {
					kind: "result",
					value: { handle, args: executionArgs, name: operation.call.name, operationId: operation.call.id },
					virtualDurationMs,
				});
			} catch {
				this.#claims.miss(key);
				await handle.discard("speculative child execution failed").catch(() => undefined);
			}
		} finally {
			release();
		}
	}
}
