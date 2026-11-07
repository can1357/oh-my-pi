import * as fs from "node:fs";
import * as path from "node:path";
import { getProviderCooldownsPath, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { withFileLockSync } from "@oh-my-pi/pi-utils/file-lock";

export const PROVIDER_EXHAUSTION_COOLDOWN_MS = 60 * 60 * 1_000;
const PROBE_MIN_MS = 5 * 60 * 1_000;
const PROBE_LEASE_MS = 60 * 1_000;
export type ProviderUnavailableClass = "quota" | "balance" | "entitlement" | "auth" | "discovery";

export interface ProviderFailureEvidence {
	status?: number;
	type?: string;
	code?: string;
	discoveryFailure?: boolean;
	/** A JSON response body, never human-readable error prose. */
	body?: unknown;
	/** Only a catalog-confirmed model miss is an account entitlement failure. */
	catalogModel?: boolean;
	resetAt?: number;
	credentialVersion?: string;
}

export interface ProviderExhaustionRecord {
	provider: string;
	class: ProviderUnavailableClass;
	reason: string;
	recordedAt: number;
	until: number;
	firstSeen: number;
	lastSeen: number;
	failedCallCount: number;
	status?: number;
	type?: string;
	code?: string;
	resetAt?: number;
	credentialVersion?: string;
	revision: string;
	nextProbeAt: number;
	probeAttempts: number;
	leaseOwner?: string;
	leaseUntil?: number;
}

export interface ProviderExhaustionExclusion {
	provider: string;
	reason: string;
	until: number;
}

export interface ProviderAvailabilityTransition {
	id: string;
	provider: string;
	available: boolean;
	class: ProviderUnavailableClass;
	since: number;
	failedCallCount: number;
}

const listeners = new Set<(transition: ProviderAvailabilityTransition) => void>();

/** Signals that durable transitions are ready; consumers atomically claim the queue. */
export function subscribeProviderTransitions(
	listener: (transition: ProviderAvailabilityTransition) => void,
): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function transitionFor(record: ProviderExhaustionRecord, available: boolean): ProviderAvailabilityTransition {
	return {
		id: `${record.revision}:${available}`,
		provider: record.provider,
		available,
		class: record.class,
		since: record.firstSeen,
		failedCallCount: record.failedCallCount,
	};
}

function notify(record: ProviderExhaustionRecord, available: boolean): void {
	const transition = transitionFor(record, available);
	for (const listener of listeners) {
		try {
			listener(transition);
		} catch (error) {
			logger.warn("Provider transition notice failed", { provider: record.provider, error: String(error) });
		}
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function structuredEvidence(evidence: ProviderFailureEvidence): ProviderFailureEvidence {
	let body = evidence.body;
	if (typeof body === "string") {
		try {
			body = JSON.parse(body);
		} catch {
			body = undefined;
		}
	}
	const envelope = asRecord(body);
	const error = asRecord(envelope?.error) ?? envelope;
	return {
		...evidence,
		status: evidence.status ?? (typeof envelope?.status === "number" ? envelope.status : undefined),
		type: evidence.type ?? (typeof error?.type === "string" ? error.type : undefined),
		code:
			evidence.code ??
			(typeof error?.code === "string" ? error.code : typeof error?.param === "string" ? error.param : undefined),
	};
}

/** Billing and auth decisions use machine fields; prose never changes availability. */
export function classifyProviderFailure(evidence: ProviderFailureEvidence): ProviderUnavailableClass | undefined {
	const { status, type, code, catalogModel, discoveryFailure } = structuredEvidence(evidence);
	if (discoveryFailure) return "discovery";
	const fields = [type?.toLowerCase(), code?.toLowerCase()];
	if (
		fields.some(
			value => value === "billing_error" || value === "billing_not_configured" || value === "subscription_required",
		)
	) {
		return "entitlement";
	}
	if (status === 404 && catalogModel) return "entitlement";
	if (
		fields.some(
			value =>
				value === "insufficient_balance_error" ||
				value === "insufficient_balance" ||
				value === "insufficient_funds" ||
				value === "credits_exhausted",
		)
	) {
		return "balance";
	}
	if (
		status === 401 ||
		fields.some(
			value =>
				value === "invalid_grant" ||
				value === "invalid_api_key" ||
				value === "missing_api_key" ||
				value === "authentication_error",
		)
	)
		return "auth";
	if (
		fields.some(
			value =>
				value === "personal-team-blocked:spending-limit" ||
				value === "insufficient_quota" ||
				value === "quota_exceeded" ||
				value === "usage_limit_reached" ||
				value === "resource_exhausted",
		)
	) {
		return "quota";
	}
	// Absent an explicit entitlement code, HTTP payment-required is a balance failure.
	if (status === 402) return "balance";
	return undefined;
}

interface ProviderStateDocument {
	providers: Map<string, ProviderExhaustionRecord>;
	transitions: ProviderAvailabilityTransition[];
}

let cached: { file: string; mtimeMs: number; size: number; inode: number; document: ProviderStateDocument } | undefined;

function readDocument(fresh = false): ProviderStateDocument {
	const document: ProviderStateDocument = { providers: new Map(), transitions: [] };
	const records = document.providers;
	let parsed: unknown;
	try {
		const file = getProviderCooldownsPath();
		const stat = fs.statSync(file);
		if (
			!fresh &&
			cached?.file === file &&
			cached.mtimeMs === stat.mtimeMs &&
			cached.size === stat.size &&
			cached.inode === stat.ino
		) {
			return cached.document;
		}
		parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		cached = { file, mtimeMs: stat.mtimeMs, size: stat.size, inode: stat.ino, document };
	} catch (error) {
		cached = undefined;
		if (!isEnoent(error)) logger.warn("Cannot read provider availability", { error: String(error) });
		return document;
	}
	const envelope = asRecord(parsed);
	if (Array.isArray(envelope?.transitions)) {
		document.transitions = envelope.transitions.filter((value): value is ProviderAvailabilityTransition => {
			const event = asRecord(value);
			return (
				typeof event?.id === "string" && typeof event.provider === "string" && typeof event.available === "boolean"
			);
		});
	}
	const providers = Array.isArray(parsed) ? parsed : envelope?.providers;
	if (!Array.isArray(providers)) return document;
	for (const entry of providers) {
		const value = asRecord(entry);
		if (!value || typeof value.provider !== "string" || typeof value.until !== "number") continue;
		const firstSeen = typeof value.firstSeen === "number" ? value.firstSeen : Number(value.recordedAt ?? 0);
		const classification = value.class;
		const stateClass =
			classification === "quota" ||
			classification === "balance" ||
			classification === "entitlement" ||
			classification === "auth" ||
			classification === "discovery"
				? classification
				: "quota";
		const record = entry as ProviderExhaustionRecord;
		records.set(value.provider.toLowerCase(), {
			...record,
			class: stateClass,
			firstSeen,
			lastSeen: typeof value.lastSeen === "number" ? value.lastSeen : firstSeen,
			failedCallCount: typeof value.failedCallCount === "number" ? value.failedCallCount : 1,
			revision: typeof value.revision === "string" ? value.revision : `legacy-${firstSeen}`,
			nextProbeAt: typeof value.nextProbeAt === "number" ? value.nextProbeAt : value.until,
			probeAttempts: typeof value.probeAttempts === "number" ? value.probeAttempts : 0,
			// Legacy fixed timers are probe deadlines, never authoritative quota resets.
			resetAt: record.resetAt,
			reason: `provider unavailable (${stateClass})`,
		});
	}
	return document;
}

function readPersisted(): Map<string, ProviderExhaustionRecord> {
	return readDocument().providers;
}

function writePersisted(document: ProviderStateDocument): void {
	cached = undefined;
	const file = getProviderCooldownsPath();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
	fs.writeFileSync(
		temporary,
		JSON.stringify({ providers: [...document.providers.values()], transitions: document.transitions }, null, "\t"),
	);
	fs.renameSync(temporary, file);
}

function mutate<T>(
	operation: (records: Map<string, ProviderExhaustionRecord>, transitions: ProviderAvailabilityTransition[]) => T,
): T {
	return withFileLockSync(getProviderCooldownsPath(), () => {
		const document = readDocument(true);
		const previous = new Map(document.providers);
		const result = operation(document.providers, document.transitions);
		for (const [key, record] of document.providers) {
			if (!previous.has(key)) document.transitions.push(transitionFor(record, false));
		}
		for (const [key, record] of previous) {
			if (!document.providers.has(key)) document.transitions.push(transitionFor(record, true));
		}
		writePersisted(document);
		return result;
	});
}

/** Atomically claim pending notices once across processes, including startup transitions. */
export function claimProviderTransitions(): ProviderAvailabilityTransition[] {
	if (readDocument().transitions.length === 0) return [];
	return mutate((_records, transitions) => transitions.splice(0));
}

/** Returns false for transient or unclassified errors. Failed probes do not count as calls. */
export function recordProviderFailure(provider: string, evidence: ProviderFailureEvidence, now = Date.now()): boolean {
	try {
		return persistProviderFailure(provider, evidence, now);
	} catch (error) {
		logger.warn("Cannot persist provider availability", { provider, error: String(error) });
		return false;
	}
}

function persistProviderFailure(provider: string, evidence: ProviderFailureEvidence, now: number): boolean {
	const normalized = structuredEvidence(evidence);
	const classification = classifyProviderFailure(normalized);
	if (!classification) return false;
	const transition = mutate(records => {
		const key = provider.toLowerCase();
		const previous = records.get(key);
		const changed = previous === undefined;
		const record: ProviderExhaustionRecord = {
			provider,
			class: classification,
			reason: `provider unavailable (${classification})`,
			recordedAt: now,
			firstSeen: changed ? now : previous.firstSeen,
			lastSeen: now,
			failedCallCount: (previous?.failedCallCount ?? 0) + 1,
			status: normalized.status,
			type: normalized.type,
			code: normalized.code,
			resetAt:
				classification === "quota" || classification === "balance" || classification === "entitlement"
					? (normalized.resetAt ?? (previous?.class === classification ? previous.resetAt : undefined))
					: undefined,
			credentialVersion: normalized.credentialVersion ?? previous?.credentialVersion,
			revision: crypto.randomUUID(),
			nextProbeAt: classification === "quota" ? (normalized.resetAt ?? now + PROBE_MIN_MS) : now + PROBE_MIN_MS,
			probeAttempts: 0,
			until:
				classification === "balance" || classification === "entitlement"
					? now + PROBE_MIN_MS
					: (normalized.resetAt ?? now + PROVIDER_EXHAUSTION_COOLDOWN_MS),
		};
		records.set(key, record);
		return changed ? record : undefined;
	});
	if (transition) notify(transition, false);
	return true;
}

/** Legacy entry point; reason is diagnostic-only and never classified as prose. */
export function coolDownExhaustedProvider(
	provider: string,
	options?: ProviderFailureEvidence & { now?: number; reason?: string },
): void {
	recordProviderFailure(
		provider,
		{ ...options, body: options?.body ?? options?.reason, status: options?.status ?? 402 },
		options?.now,
	);
}

export function providerExhaustionRecord(provider: string, now = Date.now()): ProviderExhaustionRecord | undefined {
	const record = readPersisted().get(provider.toLowerCase());
	// Billing/entitlement timers schedule probes; elapsed time is no evidence
	// that the account can serve work again. Only quota has a timed reset.
	if (!record || record.class !== "quota") return record;
	if ((record.resetAt ?? record.recordedAt + PROVIDER_EXHAUSTION_COOLDOWN_MS) > now) return record;
	const cleared = mutate(records => {
		const current = records.get(provider.toLowerCase());
		if (current?.revision !== record.revision) return undefined;
		records.delete(provider.toLowerCase());
		return current;
	});
	if (cleared) notify(cleared, true);
	return cleared ? undefined : readPersisted().get(provider.toLowerCase());
}

export function isProviderExhausted(provider: string, now = Date.now()): boolean {
	return providerExhaustionRecord(provider, now) !== undefined;
}

export function providerExhaustionExclusion(provider: string): ProviderExhaustionExclusion | undefined {
	const record = providerExhaustionRecord(provider);
	return record ? { provider, reason: record.reason, until: record.until } : undefined;
}

export function isProviderExhaustionError(status: number | undefined, message: string | undefined): boolean {
	return classifyProviderFailure({ status, body: message }) !== undefined;
}

/** Re-login/credential replacement is the sole automatic auth recovery signal. */
export function clearProviderAuthOnCredentialChange(provider: string, credentialVersion: string): void {
	const observed = readPersisted().get(provider.toLowerCase());
	if (observed?.class !== "auth" || observed.credentialVersion === credentialVersion) return;
	const cleared = mutate(records => {
		const record = records.get(provider.toLowerCase());
		if (record?.class !== "auth" || record.credentialVersion === credentialVersion) return undefined;
		records.delete(provider.toLowerCase());
		return record;
	});
	if (cleared) notify(cleared, true);
}

/** Raw shared records, including timers that have not yet been revisited. */
export function listProviderCooldowns(): ProviderExhaustionRecord[] {
	return [...readPersisted().values()];
}

/** Revision check also invalidates any outstanding probe's lease. */
export function clearProviderCooldown(provider: string, revision?: string): boolean {
	const observed = readPersisted().get(provider.toLowerCase());
	if (!observed || (revision !== undefined && observed.revision !== revision)) return false;
	const cleared = mutate(records => {
		const current = records.get(provider.toLowerCase());
		if (current?.revision !== observed.revision || current.leaseOwner !== observed.leaseOwner) return undefined;
		records.delete(provider.toLowerCase());
		return current;
	});
	if (cleared) notify(cleared, true);
	return cleared !== undefined;
}

/** A successful inference proves billing/entitlement recovery, never catalog or auth recovery. */
export function recordProviderSuccess(provider: string): void {
	try {
		const observed = readPersisted().get(provider.toLowerCase());
		if (!observed || observed.class === "auth" || observed.class === "discovery") return;
		clearProviderCooldown(provider, observed.revision);
	} catch (error) {
		logger.warn("Cannot persist provider recovery", { provider, error: String(error) });
	}
}

export interface ProviderProbeOptions {
	now?: number;
	owner?: string;
	force?: boolean;
	provider?: string;
	onResult?: (provider: string, result: "available" | "unavailable" | "leased" | "stale" | "auth") => void;
}

export interface ProviderProbeResult {
	available: boolean;
	credentialVersion?: string;
}

/**
 * One leased probe per provider across all processes. Lease expiry permits a
 * crashed owner to be replaced; owner + revision comparison rejects stale success.
 */
export async function probeUnavailableProviders(
	probe: (record: ProviderExhaustionRecord) => Promise<ProviderProbeResult>,
	options: ProviderProbeOptions = {},
): Promise<void> {
	const now = options.now ?? Date.now();
	const owner = options.owner ?? `${process.pid}:${crypto.randomUUID()}`;
	for (const snapshot of readPersisted().values()) {
		if (options.provider && snapshot.provider.toLowerCase() !== options.provider.toLowerCase()) continue;
		if (!options.force && snapshot.class === "quota" && snapshot.resetAt !== undefined) {
			providerExhaustionRecord(snapshot.provider, now);
			continue;
		}
		if (snapshot.class === "auth") {
			options.onResult?.(snapshot.provider, "auth");
			continue;
		}
		if (!options.force && snapshot.nextProbeAt > now) continue;
		const leased = mutate(records => {
			const current = records.get(snapshot.provider.toLowerCase());
			if (!current || (!options.force && current.nextProbeAt > now) || (current.leaseUntil ?? 0) > now)
				return undefined;
			current.leaseOwner = owner;
			current.leaseUntil = now + PROBE_LEASE_MS;
			return { ...current };
		});
		if (!leased) {
			options.onResult?.(snapshot.provider, "leased");
			continue;
		}
		let result: ProviderProbeResult;
		try {
			result = await probe(leased);
		} catch {
			result = { available: false };
		}
		let applied = false;
		const cleared = mutate(records => {
			const key = leased.provider.toLowerCase();
			const current = records.get(key);
			if (current?.revision !== leased.revision || current.leaseOwner !== owner) return undefined;
			applied = true;
			if (result.available) {
				records.delete(key);
				return current;
			}
			current.probeAttempts += 1;
			current.nextProbeAt =
				now + Math.min(PROVIDER_EXHAUSTION_COOLDOWN_MS, PROBE_MIN_MS * 2 ** current.probeAttempts);
			current.until = current.class === "quota" ? (current.resetAt ?? current.nextProbeAt) : current.nextProbeAt;
			delete current.leaseOwner;
			delete current.leaseUntil;
			return undefined;
		});
		if (cleared) notify(cleared, true);
		options.onResult?.(leased.provider, applied ? (cleared ? "available" : "unavailable") : "stale");
	}
}
