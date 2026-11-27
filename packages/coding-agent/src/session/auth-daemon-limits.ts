import { classifyCredentialRotationFailure } from "@oh-my-pi/pi-ai/auth/rotation";
import {
	type CredentialRotation,
	type CredentialRotationFailure,
	type InvalidateCredentialMatchingOptions,
	type LimitsApi,
	type MarkServiceTierUnavailableOptions,
	type MarkUsageLimitOptions,
	type RotateCredentialOptions,
	SERVICE_TIER_BLOCK_MS,
	type UsageLimitMarkResult,
} from "@oh-my-pi/pi-ai/auth-storage";
import type { ServiceTier } from "@oh-my-pi/pi-ai/types";
import { raceWithSignal } from "@oh-my-pi/pi-ai/utils/abort";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { AuthDaemonRequestHandler } from "../daemon/modules/auth";
import { isAuthDaemonCredentialId } from "./auth-daemon-contract";
import type { AuthDaemonLink } from "./auth-daemon-link";
import type { AuthDaemonLease } from "./auth-daemon-owner";
import { lookupAuthDaemonOAuthResolution, supportedAuthDaemonProvider } from "./auth-daemon-reads";

const POOL_UNAVAILABLE =
	"All accounts allowed by the session OAuth account pool are unusable due to organization policy.";
const TARGET_FIELDS = ["provider", "sessionId", "credentialId", "recoveryHandle"] as const;
const TIER_FIELDS = ["provider", "sessionId", "serviceTier", "modelId"] as const;
const MARK_REACHED_FIELDS = [...TARGET_FIELDS, "modelId", "retryAfterMs", "providerTimed"] as const;
const ROTATE_FIELDS = [...TARGET_FIELDS, "modelId", "failure", "waitForSibling"] as const;
const MARK_TIER_FIELDS = [...TIER_FIELDS, "retryAfterMs", "credentialId"] as const;
const QUOTA_TIMES = [
	"retryAtMs",
	"blockedUntilMs",
	"requestedBlockedUntilMs",
	"priorBlockedUntilMs",
	"reportResetAtMs",
] as const;
const QUOTA_REPLY_FIELDS = ["switched", "priorBlockedUntilTimed", ...QUOTA_TIMES] as const;

function invalid(): never {
	throw new Error("Invalid daemon auth limits data");
}

function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
	if (!isRecord(value)) return invalid();
	for (const key in value) if (!allowed.includes(key)) return invalid();
	return value;
}

function identifier(value: unknown): string | undefined {
	if (value === undefined || (typeof value === "string" && value.length > 0 && !value.includes("\0"))) return value;
	return invalid();
}

function id(value: unknown): number | undefined {
	if (value === undefined || isAuthDaemonCredentialId(value)) return value;
	return invalid();
}

function optionalBoolean(value: unknown): boolean | undefined {
	if (value === undefined || typeof value === "boolean") return value;
	return invalid();
}

function boolean(value: unknown): boolean {
	return optionalBoolean(value) ?? invalid();
}

// Keep cooldowns representable as JS and SQLite deadlines, including a provider's explicit zero.
const MAX_DEADLINE_MS = 8_640_000_000_000_000;
function milliseconds(value: unknown): number | undefined {
	if (
		value === undefined ||
		(typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_DEADLINE_MS)
	) {
		return value;
	}
	return invalid();
}

function cooldown(value: unknown): number | undefined {
	const ms = milliseconds(value);
	return ms === undefined || ms + Date.now() <= MAX_DEADLINE_MS ? ms : invalid();
}

function parseFailure(value: unknown): CredentialRotationFailure {
	const data = fields(value, ["kind", "retryAfterMs"]);
	const { kind, retryAfterMs } = data;
	switch (kind) {
		case "usage-limit":
			return { kind, retryAfterMs: cooldown(retryAfterMs) };
		case "mismatched-model":
		case "model-policy":
		case "organization-policy":
		case "account-policy":
		case "invalidated-oauth":
		case "auth":
			if (Object.hasOwn(data, "retryAfterMs")) return invalid();
			return { kind };
		default:
			return invalid();
	}
}

interface Scope {
	provider: string;
	rawSessionId: string | undefined;
	sessionId: string | undefined;
}

function parseScope(lease: AuthDaemonLease, params: Record<string, unknown>): Scope {
	const provider = params.provider;
	if (!supportedAuthDaemonProvider(provider)) return invalid();
	const rawSessionId = identifier(params.sessionId);
	return { provider, rawSessionId, sessionId: lease.sessionId(rawSessionId, provider) };
}

function permit(lease: AuthDaemonLease, { provider, sessionId }: Scope, credentialId: number): void {
	if (sessionId !== undefined && lease.storage.sessions.permits(provider, sessionId, credentialId) !== true) {
		throw new Error("Daemon auth credential is outside the session account pool");
	}
}

function resolution(lease: AuthDaemonLease, scope: Scope, value: unknown) {
	if (value === undefined) return undefined;
	if (
		typeof value !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
	) {
		return invalid();
	}
	const selected = lookupAuthDaemonOAuthResolution(lease, value, scope.provider, scope.rawSessionId);
	if (!selected) throw new Error("Invalid daemon auth resolution handle");
	return selected;
}

async function target(lease: AuthDaemonLease, scope: Scope, params: Record<string, unknown>) {
	const selected = resolution(lease, scope, params.recoveryHandle);
	const requested = id(params.credentialId);
	if (selected && requested !== undefined && selected.credentialId !== requested) return invalid();
	if (!selected && scope.sessionId === undefined) return undefined;
	await lease.storage.credentials.poll();
	const credentialId =
		selected?.credentialId ??
		requested ??
		lease.storage.sessions.sticky?.(scope.provider, scope.sessionId)?.credentialId;
	if (credentialId === undefined) return undefined;
	permit(lease, scope, credentialId);
	const row = lease.storage.credentials.list(scope.provider).find(row => row.id === credentialId);
	if (!row || (selected && row.credential.type !== "oauth")) return undefined;
	return { credentialId, credentialType: row.credential.type, rejectedOAuthAccess: selected?.rejectedAccessToken };
}

function quotaResult(value: unknown): UsageLimitMarkResult {
	const data = fields(value, QUOTA_REPLY_FIELDS);
	const result: UsageLimitMarkResult = { switched: boolean(data.switched) };
	for (const key of QUOTA_TIMES) {
		const ms = milliseconds(data[key]);
		if (ms !== undefined) result[key] = ms;
	}
	const timed = optionalBoolean(data.priorBlockedUntilTimed);
	if (timed !== undefined) result.priorBlockedUntilTimed = timed;
	return result;
}

async function markReached(lease: AuthDaemonLease, value: unknown): Promise<UsageLimitMarkResult> {
	const params = fields(value, MARK_REACHED_FIELDS);
	const scope = parseScope(lease, params);
	const modelId = identifier(params.modelId);
	const retryAfterMs = cooldown(params.retryAfterMs);
	const providerTimed = optionalBoolean(params.providerTimed);
	const selected = await target(lease, scope, params);
	if (!selected) return { switched: false };
	return quotaResult(
		await lease.storage.limits.markReached(scope.provider, scope.sessionId, {
			credentialId: selected.credentialId,
			modelId,
			retryAfterMs,
			providerTimed,
		}),
	);
}

async function rotate(lease: AuthDaemonLease, value: unknown): Promise<CredentialRotation> {
	const params = fields(value, ROTATE_FIELDS);
	const scope = parseScope(lease, params);
	const modelId = identifier(params.modelId);
	const failure = parseFailure(params.failure);
	const waitForSibling = optionalBoolean(params.waitForSibling);
	if (failure.kind === "organization-policy" && scope.provider !== "anthropic") return invalid();
	const selected = await target(lease, scope, params);
	if (failure.kind === "mismatched-model" || (failure.kind === "model-policy" && modelId === undefined)) {
		return { switched: false };
	}
	if (failure.kind === "auth" || failure.kind === "invalidated-oauth") {
		if (
			!selected ||
			(selected.credentialType === "oauth" && selected.rejectedOAuthAccess === undefined) ||
			(failure.kind === "invalidated-oauth" && selected.credentialType !== "oauth")
		) {
			return { switched: false };
		}
	} else if (
		!selected &&
		(scope.sessionId === undefined ||
			params.credentialId !== undefined ||
			params.recoveryHandle !== undefined ||
			failure.kind === "usage-limit")
	) {
		return { switched: false };
	}
	const result = await lease.storage.limits.rotate(scope.provider, scope.sessionId, {
		failure,
		modelId,
		waitForSibling,
		credentialId: selected?.credentialId,
		rejectedOAuthAccess: selected?.rejectedOAuthAccess,
	});
	return {
		switched: result.switched,
		afterSiblingWait: result.afterSiblingWait,
		// The engine's explanation includes provider-supplied OAuth identities. Only expose the fixed reason.
		poolUnavailableReason: result.poolUnavailableReason === undefined ? undefined : POOL_UNAVAILABLE,
	};
}

function tier(value: unknown): ServiceTier {
	switch (value) {
		case "auto":
		case "default":
		case "flex":
		case "scale":
		case "priority":
		case "ultrafast":
			return value;
		default:
			return invalid();
	}
}

async function markTier(
	lease: AuthDaemonLease,
	value: unknown,
): Promise<{ kind: "local" } | { kind: "stored"; recorded: boolean }> {
	const params = fields(value, MARK_TIER_FIELDS);
	const scope = parseScope(lease, params);
	const serviceTier = tier(params.serviceTier);
	const modelId = identifier(params.modelId) ?? invalid();
	const retryAfterMs = cooldown(params.retryAfterMs);
	const credentialId = id(params.credentialId);
	if (credentialId === undefined) return { kind: "local" };
	if (scope.sessionId === undefined) return invalid();
	await lease.storage.credentials.poll();
	permit(lease, scope, credentialId);
	const recorded = await lease.storage.limits.markServiceTierUnavailable(scope.provider, {
		credentialId,
		serviceTier,
		modelId,
		retryAfterMs,
		sessionId: scope.sessionId,
	});
	return { kind: "stored", recorded };
}

async function rearm(lease: AuthDaemonLease, value: unknown): Promise<true> {
	const params = fields(value, TIER_FIELDS);
	const { provider, sessionId } = parseScope(lease, params);
	const serviceTier = tier(params.serviceTier);
	const modelId = identifier(params.modelId) ?? invalid();
	if (sessionId === undefined) return invalid();
	await lease.storage.limits.rearmServiceTier(provider, serviceTier, modelId, sessionId);
	return true;
}

async function invalidate(lease: AuthDaemonLease, value: unknown): Promise<boolean> {
	const params = fields(value, ["provider", "sessionId", "recoveryHandle"]);
	const scope = parseScope(lease, params);
	const selected = resolution(lease, scope, params.recoveryHandle) ?? invalid();
	await lease.storage.credentials.poll();
	permit(lease, scope, selected.credentialId);
	return lease.storage.limits.invalidateMatching(scope.provider, selected.rejectedAccessToken, {
		credentialId: selected.credentialId,
		sessionId: scope.sessionId,
	});
}

export const authDaemonLimitHandlers: ReadonlyMap<string, AuthDaemonRequestHandler> = new Map<
	string,
	AuthDaemonRequestHandler
>([
	["limits-mark-reached", markReached],
	["limits-rotate", rotate],
	["limits-mark-service-tier", markTier],
	["limits-rearm", rearm],
	["limits-invalidate", invalidate],
]);

export interface AuthDaemonLimitsOptions {
	link: Pick<AuthDaemonLink, "request">;
	beforeRequest?<T>(run: () => T | Promise<T>): Promise<T>;
	resolutionHandle(provider: string, sessionId: string | undefined, apiKey: string): string | undefined;
	currentSessionId?(): string | undefined;
}

/** Caller-owned limits facade: only opaque issuer handles and classified failure data cross IPC. */
export class AuthDaemonLimits implements LimitsApi {
	readonly #localTierRefusals = new Map<string, number>();
	readonly #options: AuthDaemonLimitsOptions;

	constructor(options: AuthDaemonLimitsOptions) {
		this.#options = options;
	}

	#request(method: string, params: object | (() => object | undefined), signal?: AbortSignal): Promise<unknown> {
		const run = async () => {
			signal?.throwIfAborted();
			const input = typeof params === "function" ? params() : params;
			if (input !== undefined) return this.#options.link.request(method, input, signal);
		};
		return raceWithSignal(this.#options.beforeRequest ? this.#options.beforeRequest(run) : run(), signal);
	}

	#target(provider: string, sessionId: string | undefined, credentialId?: number, apiKey?: string) {
		const recoveryHandle =
			apiKey === undefined ? undefined : this.#options.resolutionHandle(provider, sessionId, apiKey);
		if (apiKey !== undefined && recoveryHandle === undefined && credentialId === undefined) return undefined;
		return { provider, sessionId, credentialId, recoveryHandle };
	}

	async markReached(
		provider: string,
		sessionId: string | undefined,
		options?: MarkUsageLimitOptions,
	): Promise<UsageLimitMarkResult> {
		const { retryAfterMs, providerTimed, modelId, credentialId, apiKey, signal } = options ?? {};
		signal?.throwIfAborted();
		const result = await this.#request(
			"limits-mark-reached",
			() => {
				const target = this.#target(provider, sessionId, credentialId, apiKey);
				return target && { ...target, retryAfterMs, providerTimed, modelId };
			},
			signal,
		);
		return result === undefined ? { switched: false } : quotaResult(result);
	}

	async rotate(
		provider: string,
		sessionId: string | undefined,
		options?: RotateCredentialOptions,
	): Promise<CredentialRotation> {
		const { error, baseUrl, modelId, credentialId, apiKey, signal, waitForSibling } = options ?? {};
		signal?.throwIfAborted();
		const failure = classifyCredentialRotationFailure(provider, error, modelId, baseUrl);
		const result = await this.#request(
			"limits-rotate",
			() => {
				const target = this.#target(provider, sessionId, credentialId, apiKey);
				return target && { ...target, modelId, failure, waitForSibling };
			},
			signal,
		);
		if (result === undefined) return { switched: false };
		const reply = fields(result, ["switched", "afterSiblingWait", "poolUnavailableReason"]);
		const reason = reply.poolUnavailableReason;
		if (reason !== undefined && reason !== POOL_UNAVAILABLE) return invalid();
		const rotation: CredentialRotation = { switched: boolean(reply.switched) };
		const waited = optionalBoolean(reply.afterSiblingWait);
		if (waited !== undefined) rotation.afterSiblingWait = waited;
		if (reason !== undefined) rotation.poolUnavailableReason = reason;
		return rotation;
	}

	async markServiceTierUnavailable(provider: string, options: MarkServiceTierUnavailableOptions): Promise<boolean> {
		const { serviceTier, modelId, retryAfterMs, credentialId } = options;
		const sessionId = options.sessionId ?? this.#options.currentSessionId?.();
		const raw = await this.#request("limits-mark-service-tier", {
			provider,
			sessionId,
			serviceTier,
			modelId,
			retryAfterMs,
			credentialId,
		});
		const reply = fields(raw, ["kind", "recorded"]);
		if (reply.kind === "stored" && credentialId !== undefined) return boolean(reply.recorded);
		if (reply.kind !== "local" || credentialId !== undefined || Object.hasOwn(reply, "recorded")) return invalid();
		if (this.localServiceTierRefused(provider, serviceTier, modelId)) return false;
		this.#localTierRefusals.set(
			this.#tierKey(provider, serviceTier, modelId),
			Date.now() + (retryAfterMs ?? SERVICE_TIER_BLOCK_MS),
		);
		return true;
	}

	async rearmServiceTier(
		provider: string,
		serviceTier: ServiceTier,
		modelId: string,
		sessionId = this.#options.currentSessionId?.(),
	): Promise<void> {
		if ((await this.#request("limits-rearm", { provider, sessionId, serviceTier, modelId })) !== true)
			return invalid();
		this.#localTierRefusals.delete(this.#tierKey(provider, serviceTier, modelId));
	}

	async invalidateMatching(
		provider: string,
		apiKey: string,
		options?: InvalidateCredentialMatchingOptions,
	): Promise<boolean> {
		const { sessionId, signal } = options ?? {};
		signal?.throwIfAborted();
		const reply = await this.#request(
			"limits-invalidate",
			() => {
				const recoveryHandle = this.#options.resolutionHandle(provider, sessionId, apiKey);
				if (recoveryHandle !== undefined) return { provider, sessionId, recoveryHandle };
			},
			signal,
		);
		return reply === undefined ? false : boolean(reply);
	}

	localServiceTierRefused(
		provider: string,
		serviceTier: ServiceTier | undefined,
		modelId: string | undefined,
	): boolean {
		if (serviceTier === undefined || modelId === undefined) return false;
		const key = this.#tierKey(provider, serviceTier, modelId);
		const until = this.#localTierRefusals.get(key);
		if (until === undefined) return false;
		if (until > Date.now()) return true;
		this.#localTierRefusals.delete(key);
		return false;
	}

	#tierKey(provider: string, serviceTier: ServiceTier, modelId: string): string {
		return `${provider}\0${serviceTier}\0${modelId}`;
	}
}
