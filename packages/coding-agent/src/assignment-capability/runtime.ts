import { stableJson } from "./canonical-json";
import type {
	AssignmentCapabilityBinding,
	AssignmentCapabilityLaunchOptions,
	AssignmentCapabilityNotice,
	AssignmentCapabilityRecord,
	AssignmentCapabilityScope,
	AssignmentCompletionResult,
	AssignmentExecuteInput,
	AssignmentExecuteResult,
} from "./types";
import { ASSIGNMENT_CAPABILITY_SCHEMA } from "./types";

const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 5_000;
const SAFE_CODE = /^[A-Z0-9_.-]{1,80}$/i;
const MAX_RECONCILIATION_RESERVE_MS = 2_000;
const MIN_RECONCILIATION_RESERVE_MS = 250;
const TERMINATION_GRACE_MS = 50;
const MIN_GATEWAY_ATTEMPT_MS = TERMINATION_GRACE_MS * 2 + 1;

type JsonRecord = Record<string, unknown>;

interface PreparedAssignmentExecuteInput extends AssignmentExecuteInput {
	readonly deadline: string;
	readonly operationDigest: string;
}

interface PreparedAssignmentCompletionInput {
	readonly toolCall: string;
	readonly deadline: string;
	readonly operationDigest: string;
}

class GatewayAmbiguityError extends Error {
	constructor(code: string) {
		super(denial(code).message);
	}
}

function object(value: unknown): JsonRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Assignment capability denied: invalid authorization response");
	}
	return value as JsonRecord;
}

function requireClosed(value: unknown, fields: readonly string[]): JsonRecord {
	const result = object(value);
	const keys = Object.keys(result);
	if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) {
		throw new Error("Assignment capability denied: invalid authorization response");
	}
	return result;
}

function requireString(record: JsonRecord, field: string): string {
	const value = record[field];
	if (typeof value !== "string" || value.length === 0) {
		throw new Error("Assignment capability denied: invalid authorization response");
	}
	return value;
}

function requireNumber(record: JsonRecord, field: string): number {
	const value = record[field];
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error("Assignment capability denied: invalid authorization response");
	}
	return value;
}

function encodeFrame(value: unknown): Uint8Array {
	const payload = new TextEncoder().encode(JSON.stringify(value));
	if (payload.byteLength > MAX_FRAME_BYTES)
		throw new Error("Assignment capability denied: authorization request is too large");
	const frame = new Uint8Array(4 + payload.byteLength);
	new DataView(frame.buffer).setUint32(0, payload.byteLength, true);
	frame.set(payload, 4);
	return frame;
}

class GatewayOutputOverflowError extends Error {}

interface BoundedStreamRead {
	readonly promise: Promise<string>;
	cancel(): void;
}

function readBoundedGatewayStream(stream: ReadableStream<Uint8Array>, capture: boolean): BoundedStreamRead {
	const reader = stream.getReader();
	let settled = false;
	const chunks: Uint8Array[] = [];
	const promise = (async () => {
		let bytes = 0;
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				if (bytes + value.byteLength > MAX_FRAME_BYTES) throw new GatewayOutputOverflowError();
				bytes += value.byteLength;
				if (capture) chunks.push(value);
			}
			if (!capture) return "";
			const output = new Uint8Array(bytes);
			let offset = 0;
			for (const chunk of chunks) {
				output.set(chunk, offset);
				offset += chunk.byteLength;
			}
			return new TextDecoder().decode(output);
		} finally {
			settled = true;
			reader.releaseLock();
		}
	})();
	return {
		promise,
		cancel: () => {
			if (settled) return;
			try {
				void reader.cancel().catch(() => undefined);
			} catch {
				// The stream settled between the state check and cancellation.
			}
		},
	};
}

function deadlineTimer(deadlineMillis: number): {
	readonly promise: Promise<void>;
	cancel(): void;
} {
	const { promise, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, Math.max(0, deadlineMillis - Date.now()));
	return { promise, cancel: () => clearTimeout(timer) };
}

async function waitForProcessExit(exitPromise: Promise<number>, deadlineMillis: number): Promise<boolean> {
	if (Date.now() >= deadlineMillis) return false;
	const timer = deadlineTimer(deadlineMillis);
	try {
		return await Promise.race([exitPromise.then(() => true), timer.promise.then(() => false)]);
	} finally {
		timer.cancel();
	}
}

async function terminateGatewayProcess(
	process: Bun.Subprocess,
	exitPromise: Promise<number>,
	deadlineMillis: number,
): Promise<void> {
	if (process.exitCode !== null) return;
	try {
		process.kill("SIGTERM");
	} catch {
		// The process exited between the exit-code check and the signal.
	}
	const gracefulDeadline = Math.min(deadlineMillis, Date.now() + TERMINATION_GRACE_MS);
	if (await waitForProcessExit(exitPromise, gracefulDeadline)) return;
	try {
		process.kill("SIGKILL");
	} catch {
		// The process exited between the grace period and escalation.
	}
	await waitForProcessExit(exitPromise, Math.min(deadlineMillis, Date.now() + TERMINATION_GRACE_MS));
}

function denial(code?: unknown): Error {
	return new Error(
		typeof code === "string" && SAFE_CODE.test(code)
			? `Assignment capability denied (${code})`
			: "Assignment capability denied",
	);
}

export async function callAssignmentGateway(
	argv: readonly string[],
	request: Readonly<JsonRecord>,
	deadlineMillis: number,
): Promise<unknown> {
	const remaining = deadlineMillis - Date.now();
	if (!Number.isFinite(remaining) || remaining <= 0) throw denial("GATEWAY_TIMEOUT");
	const reconciliationReserve = Math.min(
		MAX_RECONCILIATION_RESERVE_MS,
		Math.max(MIN_RECONCILIATION_RESERVE_MS, Math.floor(remaining / 4)),
	);
	const firstAttemptTimeout = Math.max(1, remaining - reconciliationReserve);
	if (firstAttemptTimeout < MIN_GATEWAY_ATTEMPT_MS) {
		return callAssignmentGatewayOnce(argv, request, deadlineMillis - Date.now());
	}
	try {
		return await callAssignmentGatewayOnce(argv, request, firstAttemptTimeout);
	} catch (error) {
		if (!(error instanceof GatewayAmbiguityError)) throw error;
		// Re-submit only after an ambiguous transport outcome, reserving deadline
		// budget before the first spawn. Go reconciles this exact requestId.
		return callAssignmentGatewayOnce(argv, request, deadlineMillis - Date.now());
	}
}

async function callAssignmentGatewayOnce(
	argv: readonly string[],
	request: Readonly<JsonRecord>,
	timeoutMs: number,
): Promise<unknown> {
	if (!Number.isFinite(timeoutMs) || timeoutMs < MIN_GATEWAY_ATTEMPT_MS) throw denial("GATEWAY_TIMEOUT");
	const attemptDeadline = Date.now() + timeoutMs;
	const ioDeadline = attemptDeadline - TERMINATION_GRACE_MS * 2;
	const process = Bun.spawn([...argv], {
		cwd: "/",
		env: { PATH: Bun.env.PATH ?? "" },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = readBoundedGatewayStream(process.stdout as ReadableStream<Uint8Array>, true);
	const stderr = readBoundedGatewayStream(process.stderr as ReadableStream<Uint8Array>, false);
	const exitPromise = process.exited;
	const completed = Promise.all([exitPromise, stdout.promise, stderr.promise]);
	const timeout = deadlineTimer(ioDeadline);
	let output: string;
	try {
		process.stdin.write(JSON.stringify(request));
		process.stdin.end();
		const outcome = await Promise.race([
			completed.then(([exitCode, stdoutText]) => ({
				kind: "complete" as const,
				exitCode,
				stdout: stdoutText,
			})),
			timeout.promise.then(() => ({ kind: "timeout" as const })),
		]);
		if (outcome.kind === "timeout") throw new GatewayAmbiguityError("GATEWAY_TIMEOUT");
		if (outcome.exitCode !== 0) throw new GatewayAmbiguityError("GATEWAY_UNAVAILABLE");
		output = outcome.stdout;
	} catch (error) {
		stdout.cancel();
		stderr.cancel();
		try {
			process.stdin.end();
		} catch {
			// The subprocess may already have closed its input pipe.
		}
		await terminateGatewayProcess(process, exitPromise, attemptDeadline);
		if (error instanceof GatewayOutputOverflowError) {
			throw new GatewayAmbiguityError("GATEWAY_UNAVAILABLE");
		}
		throw error;
	} finally {
		timeout.cancel();
	}
	let decoded: JsonRecord;
	try {
		decoded = object(JSON.parse(output));
	} catch {
		throw new GatewayAmbiguityError("GATEWAY_INVALID_RESPONSE");
	}
	let envelope: JsonRecord;
	try {
		envelope =
			decoded.ok === true
				? requireClosed(decoded, ["schema", "requestId", "ok", "operation", "result"])
				: requireClosed(decoded, ["schema", "requestId", "ok", "operation", "error"]);
		if (
			envelope.schema !== ASSIGNMENT_CAPABILITY_SCHEMA ||
			envelope.requestId !== request.requestId ||
			envelope.operation !== request.operation
		) {
			throw new Error("invalid gateway response identity");
		}
	} catch {
		throw new GatewayAmbiguityError("GATEWAY_INVALID_RESPONSE");
	}
	if (envelope.ok !== true) {
		const gatewayError = requireClosed(envelope.error, ["code", "message", "retryable"]);
		if (gatewayError.retryable === true) throw new GatewayAmbiguityError(requireString(gatewayError, "code"));
		throw denial(gatewayError.code);
	}
	return envelope.result;
}
function validateCapability(value: unknown): AssignmentCapabilityRecord {
	const fields = [
		"schema",
		"capability",
		"generation",
		"thread",
		"participant",
		"session",
		"leaseGeneration",
		"delivery",
		"resource",
		"assignment",
		"preparationDigest",
		"scopes",
		"authorityProvenance",
		"issuedAt",
		"expiresAt",
		"renewalDeadline",
		"maxOperationDurationMillis",
		"revocationGeneration",
		"herdrBinding",
		"herdrGeneration",
		"herdrProofKeyDigest",
		"controllerPolicyDigest",
	] as const;
	const capability = requireClosed(value, fields);
	if (capability.schema !== ASSIGNMENT_CAPABILITY_SCHEMA) {
		throw new Error("Assignment capability denied: unsupported capability schema");
	}
	const validated = capability;
	for (const field of [
		"capability",
		"thread",
		"participant",
		"session",
		"delivery",
		"resource",
		"assignment",
		"preparationDigest",
		"authorityProvenance",
		"issuedAt",
		"expiresAt",
		"renewalDeadline",
		"herdrBinding",
		"herdrProofKeyDigest",
		"controllerPolicyDigest",
	] as const) {
		requireString(validated, field);
	}
	for (const field of ["generation", "leaseGeneration", "maxOperationDurationMillis", "herdrGeneration"] as const) {
		const numeric = requireNumber(validated, field);
		if (!Number.isSafeInteger(numeric) || numeric <= 0) {
			throw new Error("Assignment capability denied: invalid authorization response");
		}
	}
	const revocationGeneration = requireNumber(validated, "revocationGeneration");
	const issuedAt = Date.parse(validated.issuedAt as string);
	const expiresAt = Date.parse(validated.expiresAt as string);
	const renewalDeadline = Date.parse(validated.renewalDeadline as string);
	if (
		!Number.isSafeInteger(revocationGeneration) ||
		revocationGeneration < 0 ||
		!Number.isFinite(issuedAt) ||
		!Number.isFinite(expiresAt) ||
		!Number.isFinite(renewalDeadline) ||
		issuedAt >= renewalDeadline ||
		renewalDeadline > expiresAt ||
		!Array.isArray(validated.scopes) ||
		!validated.scopes.includes("assignment.execution.request") ||
		validated.scopes.some(
			scope =>
				scope !== "assignment.execution.request" &&
				scope !== "assignment.complete" &&
				scope !== "assignment.revoke",
		)
	) {
		throw new Error("Assignment capability denied: invalid authorization response");
	}
	return validated as unknown as AssignmentCapabilityRecord;
}

function validateBinding(value: unknown, expected: AssignmentCapabilityLaunchOptions): AssignmentCapabilityBinding {
	const binding = requireClosed(value, [
		"schema",
		"requestId",
		"operation",
		"binding",
		"generation",
		"workspace",
		"pane",
		"session",
		"holderSecret",
		"herdrProofKey",
		"observedAt",
	]);
	if (
		binding.schema !== ASSIGNMENT_CAPABILITY_SCHEMA ||
		binding.operation !== "capability.session.bind" ||
		binding.pane !== expected.pane ||
		binding.session !== expected.session
	) {
		throw new Error("Assignment capability denied: Herdr binding mismatch");
	}
	return {
		binding: requireString(binding, "binding"),
		generation: requireNumber(binding, "generation"),
		workspace: requireString(binding, "workspace"),
		pane: requireString(binding, "pane"),
		session: requireString(binding, "session"),
		holderSecret: requireString(binding, "holderSecret"),
		herdrProofKey: requireString(binding, "herdrProofKey"),
		observedAt: requireString(binding, "observedAt"),
	};
}

interface PendingFrame {
	readonly resolve: (value: JsonRecord) => void;
	readonly reject: (error: Error) => void;
	readonly timer: Timer;
}

class HerdrCapabilityClient {
	readonly #pending = new Map<string, PendingFrame>();
	readonly #options: Readonly<AssignmentCapabilityLaunchOptions>;
	#socket?: Bun.Socket<undefined>;
	#buffer = new Uint8Array(0);
	#notice?: AssignmentCapabilityNotice;
	#binding?: AssignmentCapabilityBinding;
	#closed = false;

	constructor(options: AssignmentCapabilityLaunchOptions) {
		this.#options = Object.freeze({
			...options,
			juizGatewayArgv: Object.freeze([...options.juizGatewayArgv]),
		}) as Readonly<AssignmentCapabilityLaunchOptions>;
	}

	get binding(): AssignmentCapabilityBinding | undefined {
		return this.#binding;
	}

	async connect(): Promise<void> {
		let settled = false;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const unavailable = (): void => {
			if (settled) return;
			settled = true;
			reject(new Error("Assignment capability denied: Herdr unavailable"));
		};
		const timer = setTimeout(unavailable, CONNECT_TIMEOUT_MS);
		void Bun.connect({
			unix: this.#options.herdrSocketPath,
			socket: {
				open: socket => {
					if (settled) {
						socket.end();
						return;
					}
					this.#socket = socket;
					settled = true;
					resolve();
				},
				data: (_socket, data) => this.#receive(new Uint8Array(data)),
				close: () => this.#failAll(new Error("Assignment capability denied: Herdr connection closed")),
				error: (_socket, error) => {
					unavailable();
					this.#failAll(error instanceof Error ? error : new Error(String(error)));
				},
			},
		}).catch(unavailable);
		try {
			await promise;
		} finally {
			clearTimeout(timer);
		}
		const requestId = crypto.randomUUID();
		const response = await this.#request({
			schema: ASSIGNMENT_CAPABILITY_SCHEMA,
			requestId,
			operation: "capability.session.bind",
			pane: this.#options.pane,
			session: this.#options.session,
			clientNonce: crypto.randomUUID(),
		});
		this.#binding = validateBinding(response, this.#options);
	}

	close(): void {
		this.#closed = true;
		this.#socket?.end();
		this.#failAll(new Error("Assignment capability denied: session closed"));
		this.#notice = undefined;
		this.#binding = undefined;
	}

	activeNotice(): AssignmentCapabilityNotice {
		const notice = this.#notice;
		if (!this.#binding || !notice || this.#closed) throw denial("CAPABILITY_UNAVAILABLE");
		return notice;
	}

	clearNotice(capability: string): void {
		if (this.#notice?.capability.capability === capability) this.#notice = undefined;
	}

	async prove(
		input: PreparedAssignmentExecuteInput | PreparedAssignmentCompletionInput,
		expectedNotice: AssignmentCapabilityNotice,
		scope: AssignmentCapabilityScope,
	): Promise<{ readonly notice: AssignmentCapabilityNotice; readonly holderProof: unknown }> {
		const binding = this.#binding;
		const notice = this.#notice;
		if (!binding || !notice || notice !== expectedNotice || this.#closed) throw denial("CAPABILITY_UNAVAILABLE");
		const capability = notice.capability;
		if (
			capability.session !== binding.session ||
			capability.delivery !== notice.delivery ||
			capability.herdrBinding !== binding.binding ||
			capability.herdrGeneration !== binding.generation ||
			!capability.scopes.includes(scope) ||
			capability.revocationGeneration !== 0 ||
			Date.parse(capability.expiresAt) <= Date.now() ||
			Date.parse(capability.renewalDeadline) <= Date.now()
		) {
			throw denial("CAPABILITY_INVALID");
		}
		const response = await this.#request({
			schema: ASSIGNMENT_CAPABILITY_SCHEMA,
			requestId: crypto.randomUUID(),
			operation: "capability.session.prove",
			holderSecret: binding.holderSecret,
			binding: binding.binding,
			generation: binding.generation,
			capability: capability.capability,
			toolCall: input.toolCall,
			operationDigest: input.operationDigest,
			deadline: input.deadline,
		});
		const proof = requireClosed(response, [
			"schema",
			"requestId",
			"operation",
			"holderProof",
			"herdrProofKey",
			"deadline",
		]);
		if (
			proof.schema !== ASSIGNMENT_CAPABILITY_SCHEMA ||
			proof.operation !== "capability.session.prove" ||
			proof.herdrProofKey !== binding.herdrProofKey ||
			Date.parse(requireString(proof, "deadline")) !== Date.parse(input.deadline)
		) {
			throw denial("PROOF_INVALID");
		}
		return { notice, holderProof: proof.holderProof };
	}

	async #request(request: JsonRecord): Promise<JsonRecord> {
		const socket = this.#socket;
		const requestId = requireString(request, "requestId");
		if (!socket || this.#closed) throw denial("HERDR_UNAVAILABLE");
		const { promise, resolve, reject } = Promise.withResolvers<JsonRecord>();
		const timer = setTimeout(() => {
			this.#pending.delete(requestId);
			reject(denial("HERDR_TIMEOUT"));
		}, CONNECT_TIMEOUT_MS);
		this.#pending.set(requestId, { resolve, reject, timer });
		socket.write(encodeFrame(request));
		return promise;
	}

	#receive(chunk: Uint8Array): void {
		const joined = new Uint8Array(this.#buffer.byteLength + chunk.byteLength);
		joined.set(this.#buffer);
		joined.set(chunk, this.#buffer.byteLength);
		this.#buffer = joined;
		while (this.#buffer.byteLength >= 4) {
			const length = new DataView(this.#buffer.buffer, this.#buffer.byteOffset, 4).getUint32(0, true);
			if (length > MAX_FRAME_BYTES) {
				this.close();
				return;
			}
			if (this.#buffer.byteLength < 4 + length) return;
			const payload = this.#buffer.slice(4, 4 + length);
			this.#buffer = this.#buffer.slice(4 + length);
			let frame: JsonRecord;
			try {
				frame = object(JSON.parse(new TextDecoder().decode(payload)));
			} catch {
				this.close();
				return;
			}
			this.#dispatch(frame);
		}
	}

	#dispatch(frame: JsonRecord): void {
		if (frame.schema !== ASSIGNMENT_CAPABILITY_SCHEMA) {
			this.close();
			return;
		}
		if (frame.type === "capability.notice") {
			try {
				const pushed = requireClosed(frame, [
					"schema",
					"type",
					"requestId",
					"delivery",
					"capability",
					"capabilityToken",
				]);
				const notice = {
					delivery: requireString(pushed, "delivery"),
					capability: validateCapability(pushed.capability),
					capabilityToken: requireString(pushed, "capabilityToken"),
				};
				const binding = this.#binding;
				if (
					!binding ||
					notice.capability.delivery !== notice.delivery ||
					notice.capability.session !== binding.session ||
					notice.capability.herdrBinding !== binding.binding ||
					notice.capability.herdrGeneration !== binding.generation
				) {
					return;
				}
				this.#notice = notice;
				this.#socket?.write(
					encodeFrame({
						schema: ASSIGNMENT_CAPABILITY_SCHEMA,
						requestId: pushed.requestId,
						operation: "capability.notice.accept",
						delivery: notice.delivery,
						capability: notice.capability.capability,
						binding: binding.binding,
						generation: binding.generation,
					}),
				);
			} catch {
				this.close();
			}
			return;
		}
		const requestId = typeof frame.requestId === "string" ? frame.requestId : undefined;
		if (!requestId) {
			this.close();
			return;
		}
		const pending = this.#pending.get(requestId);
		if (!pending) return;
		this.#pending.delete(requestId);
		clearTimeout(pending.timer);
		if (frame.error !== undefined) {
			const error = object(frame.error);
			pending.reject(denial(error.code));
			return;
		}
		pending.resolve(frame);
	}

	#failAll(_error: Error): void {
		this.#socket = undefined;
		this.#notice = undefined;
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(denial("HERDR_UNAVAILABLE"));
		}
		this.#pending.clear();
	}
}

export class AssignmentCapabilityRuntime {
	readonly #options: Readonly<AssignmentCapabilityLaunchOptions>;
	readonly #herdr: HerdrCapabilityClient;

	private constructor(options: AssignmentCapabilityLaunchOptions) {
		this.#options = Object.freeze({
			...options,
			juizGatewayArgv: Object.freeze([...options.juizGatewayArgv]),
		}) as Readonly<AssignmentCapabilityLaunchOptions>;
		this.#herdr = new HerdrCapabilityClient(this.#options);
	}

	static async create(options: AssignmentCapabilityLaunchOptions): Promise<AssignmentCapabilityRuntime> {
		if (
			options.schema !== ASSIGNMENT_CAPABILITY_SCHEMA ||
			!options.herdrSocketPath ||
			!options.pane ||
			!options.session ||
			options.juizGatewayArgv.length === 0 ||
			options.juizGatewayArgv.some(arg => typeof arg !== "string" || arg.length === 0)
		) {
			throw new Error("Invalid assignment capability launch options");
		}
		const runtime = new AssignmentCapabilityRuntime(options);
		try {
			await runtime.#herdr.connect();
		} catch {
			// Eligibility is immutable, while authorization is live. A failed bind leaves
			// reads available and every mutation fail-closed for this session.
		}
		return runtime;
	}

	close(): void {
		this.#herdr.close();
	}

	async digest(value: unknown): Promise<string> {
		const wireValue = JSON.stringify(value);
		if (wireValue === undefined) throw denial("EFFECTIVE_ARGS_INVALID");
		const bytes = new TextEncoder().encode(stableJson(JSON.parse(wireValue)));
		return `sha256:${Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex")}`;
	}

	async execute(input: AssignmentExecuteInput): Promise<AssignmentExecuteResult> {
		const notice = this.#herdr.activeNotice();
		const now = Date.now();
		const expiresAt = Date.parse(notice.capability.expiresAt);
		const renewalDeadline = Date.parse(notice.capability.renewalDeadline);
		const operationCeiling = now + notice.capability.maxOperationDurationMillis;
		const deadlineMillis = Math.min(expiresAt, renewalDeadline, operationCeiling);
		if (!Number.isFinite(deadlineMillis) || deadlineMillis <= now) throw denial("CAPABILITY_INVALID");
		const deadline = new Date(deadlineMillis).toISOString();
		const operationDigest = await this.digest({
			schema: ASSIGNMENT_CAPABILITY_SCHEMA,
			toolCall: input.toolCall,
			tool: input.tool,
			tier: input.tier,
			effectiveArgsDigest: input.effectiveArgsDigest,
			deadline,
		});
		const prepared: PreparedAssignmentExecuteInput = { ...input, deadline, operationDigest };
		const proof = await this.#herdr.prove(prepared, notice, "assignment.execution.request");
		const requestId = crypto.randomUUID();
		const request = {
			schema: ASSIGNMENT_CAPABILITY_SCHEMA,
			requestId,
			operation: "attempt.execute",
			capabilityToken: proof.notice.capabilityToken,
			holderProof: proof.holderProof,
			toolCall: input.toolCall,
			tool: input.tool,
			tier: input.tier,
			effectiveArgs: input.effectiveArgs,
			effectiveArgsDigest: input.effectiveArgsDigest,
			operationDigest,
			deadline,
		};
		const response = await callAssignmentGateway(this.#options.juizGatewayArgv, request, deadlineMillis);
		const result = requireClosed(response, ["toolResult", "receipt"]);
		requireClosed(result.receipt, [
			"attempt",
			"launchDigest",
			"disposition",
			"checkpointDigest",
			"promotion",
			"cleanup",
			"fenceGeneration",
			"fencePhase",
			"reconciliation",
		]);
		const sensitive = [
			proof.notice.capabilityToken,
			this.#herdr.binding?.holderSecret,
			this.#herdr.binding?.binding,
			this.#herdr.binding?.herdrProofKey,
		].filter((value): value is string => typeof value === "string" && value.length > 0);
		const serializedToolResult = JSON.stringify(result.toolResult);
		if (sensitive.some(value => serializedToolResult.includes(value))) {
			throw denial("GATEWAY_SECRET_LEAK");
		}
		return result as unknown as AssignmentExecuteResult;
	}

	async complete(toolCall: string): Promise<AssignmentCompletionResult> {
		const notice = this.#herdr.activeNotice();
		const now = Date.now();
		const expiresAt = Date.parse(notice.capability.expiresAt);
		const renewalDeadline = Date.parse(notice.capability.renewalDeadline);
		const operationCeiling = now + notice.capability.maxOperationDurationMillis;
		const deadlineMillis = Math.min(expiresAt, renewalDeadline, operationCeiling);
		if (!Number.isFinite(deadlineMillis) || deadlineMillis <= now) throw denial("CAPABILITY_INVALID");
		const deadline = new Date(deadlineMillis).toISOString();
		const operation = "assignment.complete";
		const reason = "completed";
		const operationDigest = await this.digest({
			schema: ASSIGNMENT_CAPABILITY_SCHEMA,
			operation,
			toolCall,
			reason,
			deadline,
		});
		const prepared: PreparedAssignmentCompletionInput = { toolCall, deadline, operationDigest };
		const proof = await this.#herdr.prove(prepared, notice, "assignment.complete");
		const requestId = crypto.randomUUID();
		const response = await callAssignmentGateway(
			this.#options.juizGatewayArgv,
			{
				schema: ASSIGNMENT_CAPABILITY_SCHEMA,
				requestId,
				operation,
				capabilityToken: proof.notice.capabilityToken,
				holderProof: proof.holderProof,
				toolCall,
				operationDigest,
				deadline,
				reason,
			},
			deadlineMillis,
		);
		const result = requireClosed(response, ["toolResult", "completion"]);
		const completion = requireClosed(result.completion, [
			"capability",
			"generation",
			"revocationGeneration",
			"state",
			"assignmentState",
			"denialProofDigest",
			"requestAttempt",
		]);
		if (
			completion.capability !== notice.capability.capability ||
			completion.generation !== notice.capability.generation ||
			completion.state !== "revoked" ||
			completion.assignmentState !== "completed-unlanded" ||
			completion.requestAttempt !== requestId
		) {
			throw denial("GATEWAY_INVALID_RESPONSE");
		}
		for (const field of ["denialProofDigest", "requestAttempt"] as const) requireString(completion, field);
		for (const field of ["generation", "revocationGeneration"] as const) requireNumber(completion, field);
		const sensitive = [
			notice.capabilityToken,
			this.#herdr.binding?.holderSecret,
			this.#herdr.binding?.herdrProofKey,
		].filter((value): value is string => typeof value === "string" && value.length > 0);
		if (sensitive.some(value => JSON.stringify(result.toolResult).includes(value)))
			throw denial("GATEWAY_SECRET_LEAK");
		this.#herdr.clearNotice(notice.capability.capability);
		return result as unknown as AssignmentCompletionResult;
	}
}
