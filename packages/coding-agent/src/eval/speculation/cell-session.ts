import { type } from "@oh-my-pi/omptype";
import type {
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	SpeculativeChildHandle,
	SpeculativeOperationSink,
	ToolSpeculationEffect,
	ToolSpeculationStreamSession,
} from "@oh-my-pi/pi-agent-core";
import type { ToolSession } from "../../tools";
import {
	executePreparedEvalCompletion,
	type PreparedEvalCompletion,
	prepareEvalCompletion,
} from "../completion-bridge";
import { namespaceSessionId as namespaceJavaScriptSessionId } from "../js";
import { shadowPlanIfPresent } from "../js/context-manager";
import type { RuntimeCallIdentity } from "../js/shared/runtime";
import type { JsStatusEvent } from "../js/shared/types";
import { bridgeValueFromToolResult } from "../js/tool-bridge";
import { namespaceSessionId as namespacePythonSessionId } from "../py";
import { shadowPlanPythonIfPresent } from "../py/executor";
import { type ShadowClaimKey, ShadowClaimStore } from "./claim-store";
import { EvalArgsStreamDecoder } from "./eval-args-stream";
import { completionEgressIsSafe, evaluateShadowExpression } from "./evaluator";
import type { ShadowOperation, ShadowOrigin, ShadowPlan, ShadowValue } from "./types";

const completionParameters = type({ "[string]": "unknown" });

interface ClaimedChild {
	handle: SpeculativeChildHandle;
	args: Readonly<Record<string, unknown>>;
	name: string;
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

function completionArgs(value: unknown): Readonly<Record<string, unknown>> | undefined {
	if (Array.isArray(value)) {
		const [prompt, options] = value;
		const optionArgs = options === undefined ? {} : asArgs(options);
		if (!optionArgs) return undefined;
		return { prompt, ...optionArgs };
	}
	return { prompt: value };
}

function childOrigin(
	name: string,
	args: Readonly<Record<string, unknown>>,
	prepared?: PreparedEvalCompletion,
): ShadowOrigin {
	if (name === "read") return { kind: "local_read", resource: String(args.path ?? "") };
	return {
		kind: "model_completion",
		provider: prepared?.model.provider ?? "",
		authority: prepared ? new URL(prepared.model.baseUrl).origin : "",
	};
}

function effectOrigins(origins: readonly ShadowOrigin[]) {
	return origins.map(origin => {
		switch (origin.kind) {
			case "provider_literal":
			case "persistent_state":
				return { kind: origin.kind } as const;
			case "local_read":
				return { kind: "local_read", resource: origin.resource } as const;
			case "remote_read":
				return { kind: "remote_read", authority: origin.authority } as const;
			case "model_completion":
				return { kind: "model_completion", provider: origin.provider, authority: origin.authority } as const;
		}
		throw new Error(`Unsupported shadow origin: ${String(origin)}`);
	});
}

function completionTool(
	prepared: PreparedEvalCompletion,
	origins: readonly ShadowOrigin[],
	session: ToolSession,
): AgentTool {
	const effect: ToolSpeculationEffect = {
		kind: "model_completion",
		provider: prepared.model.provider,
		model: prepared.model.id,
		baseUrl: new URL(prepared.model.baseUrl).origin,
		egress: [{ authority: new URL(prepared.model.baseUrl).origin, origins: effectOrigins(origins) }],
	};
	return {
		name: "completion",
		label: "Completion",
		description: "Runs one nested completion.",
		parameters: completionParameters,
		speculation: {
			finalized: {
				assess: () => ({ eligible: true, effect }),
				async execute(_context, signal) {
					const result = await executePreparedEvalCompletion(prepared, { session, signal });
					return {
						kind: "result",
						result: { content: [{ type: "text", text: result.text }], details: result.details },
						isError: false,
					};
				},
			},
		},
		async execute(_toolCallId, _args, signal) {
			const result = await executePreparedEvalCompletion(prepared, { session, signal });
			return { content: [{ type: "text", text: result.text }], details: result.details };
		},
	};
}

export class EvalShadowCellSession implements ToolSpeculationStreamSession {
	readonly #options: EvalShadowCellOptions;
	readonly #decoder = new EvalArgsStreamDecoder();
	readonly #claims = new ShadowClaimStore<ClaimedChild>();
	readonly contextIndependent = true;
	readonly #admitted = new Map<string, Promise<void>>();
	readonly #results = new Map<string, ShadowValue>();
	readonly #runtimeOccurrences = new Map<string, number>();
	#occurrenceAssignment = Promise.resolve();
	#snapshot: Readonly<Record<string, ShadowValue | unknown>> | undefined;
	#language: string | undefined;
	#closed = false;
	#updates = Promise.resolve();

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
		if (decoded.kind !== "snapshot") return;
		this.#language = decoded.snapshot.language ?? "js";
		this.#updates = this.#updates
			.then(() => this.#plan(decoded.snapshot.codePrefix, this.#language as string))
			.catch(() => undefined);
	}

	async finalize(context: { args: Readonly<Record<string, unknown>> }): Promise<void> {
		if (this.#closed) return;
		if (!this.#decoder.matchesFinal(context.args)) {
			await this.discard("final eval arguments do not match streamed shadow plan");
			return;
		}
		await this.#updates;
	}

	commit(): void {}

	async discard(reason: string): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#claims.discard();
		try {
			await this.#options.coordinator.close(reason);
			await Promise.allSettled([...this.#admitted.values()]);
		} finally {
			this.#options.onDiscard?.();
		}
	}

	async claim(
		name: string,
		args: unknown,
		identity: RuntimeCallIdentity,
		remainingTimeoutMs: number,
	): Promise<AgentToolResult<unknown> | undefined> {
		const normalized = asArgs(args);
		if (!normalized) return undefined;
		const outcome = await this.#claims.claimRuntimeAsync(
			{
				siteId: identity.siteId,
				name,
				fingerprint: fingerprint(normalized),
				occurrence: identity.occurrence,
			},
			remainingTimeoutMs,
		);
		if (!outcome) return undefined;
		return await outcome.value.handle.commit(outcome.value.args);
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

	async #plan(code: string, language: string): Promise<void> {
		if (this.#closed || !code) return;
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
			}
		}
		if (!plan || !this.#snapshot) return;
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
			if (this.#admitted.has(operation.call.id)) continue;
			const previousOccurrenceAssignment = this.#occurrenceAssignment;
			const occurrenceAssigned = Promise.withResolvers<void>();
			this.#occurrenceAssignment = occurrenceAssigned.promise;
			const admission = this.#admitWhenReady(operation, previousOccurrenceAssignment, occurrenceAssigned.resolve);
			this.#admitted.set(operation.call.id, admission);
		}
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
			const runtimeArgs = operation.call.name === "completion" ? completionArgs(evaluated.value) : evaluated.value;
			if (runtimeArgs === undefined) return;
			let executionArgs: Readonly<Record<string, unknown>> | undefined;
			let tool: AgentTool | undefined;
			let prepared: PreparedEvalCompletion | undefined;
			if (operation.call.name === "read") {
				executionArgs = asArgs(runtimeArgs);
				if (!executionArgs) return;
				tool = this.#options.session.getToolForEvalBridge?.("read");
			} else {
				try {
					prepared = await prepareEvalCompletion(runtimeArgs, { session: this.#options.session });
					const authority = new URL(prepared.model.baseUrl).origin;
					if (!completionEgressIsSafe(evaluated, prepared.model.provider, authority)) return;
					tool = completionTool(prepared, evaluated.origins, this.#options.session);
					executionArgs = asArgs(runtimeArgs);
					if (!executionArgs) return;
				} catch {
					return;
				}
			}
			if (!tool || !executionArgs) return;
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
			const handle = await this.#options.coordinator.admit({
				candidateId: `${this.#options.parentToolCallId}:${operation.call.id}`,
				parentToolCallId: this.#options.parentToolCallId,
				dependencies: operation.call.dependencies.map(id => `${this.#options.parentToolCallId}:${id}`),
				toolCall: { type: "toolCall", id: operation.call.id, name: operation.call.name, arguments: executionArgs },
				tool,
				source: "eval_shadow",
			});
			if (!handle) return;
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
				const value = bridgeValueFromToolResult(operation.call.name, runtimeArgs, outcome.result);
				this.#results.set(operation.call.id, {
					value,
					origins: [childOrigin(operation.call.name, executionArgs, prepared)],
				});
				this.#claims.add(key, {
					kind: "result",
					value: { handle, args: executionArgs, name: operation.call.name },
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
