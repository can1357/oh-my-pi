import type { UsageResetCredit, UsageResetCredits } from "../usage";
import type { FetchImpl } from "../types";
import { isRecord } from "../utils";
import {
	buildClaudeOAuthHeaders,
	claudeApiUrl,
	claudeOAuthBaseUrl,
	claudeOAuthBaseUrls,
	DEFAULT_CLAUDE_OAUTH_BASE_URL,
} from "./claude-api";

const CEDAR_PROGRAM = "cedar_ember";
const JUNIPER_PROGRAM = "juniper_tide";
const ENDPOINT_ABSENT_STATUSES: Record<number, true> = { 404: true, 405: true, 410: true, 501: true };
const CEDAR_GRANT_ID = /^[a-z0-9_-]{1,40}$/;
const REDEEM_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ORGANIZATION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const WINDOW_ID = /^[a-z0-9_-]{1,80}$/;

const CLAUDE_RESET_WINDOW_IDS: Readonly<Record<string, string>> = {
	five_hour: "anthropic:5h",
	seven_day: "anthropic:7d",
	seven_day_opus: "anthropic:7d:opus",
	seven_day_sonnet: "anthropic:7d:sonnet",
};

/** OAuth credential and transport used for an account's Claude reset operations. */
export interface ClaudeResetAuth {
	accessToken: string;
	orgId?: string;
	baseUrl?: string;
	fetch: FetchImpl;
	signal?: AbortSignal;
}

/** Live reset eligibility plus the exact organization and host used for redemption. */
export interface ClaudeResetCreditList extends UsageResetCredits {
	credits: UsageResetCredit[];
	orgId?: string;
	/** OAuth API base that answered discovery; pass back as consume `baseUrl`. */
	baseUrl?: string;
}

/** Confirmed reset outcome; transport uncertainty never reports a successful spend. */
export interface ClaudeResetConsumeResult {
	ok: boolean;
	code: string;
	status: number;
	cleared?: string[];
	reason?: string;
	raw?: unknown;
}

interface CedarGrant {
	id: string;
	label?: string;
	remainingCount: number;
	grantedAt?: string;
	expiresAt?: string;
	clears: string[];
	paused: boolean;
	usableNow: boolean;
	requiresLimit: boolean;
	usedFractions: Record<string, number>;
	blocking: string[];
}

interface CedarStatus {
	eligible: boolean;
	reason?: string;
	grants: CedarGrant[];
	nextGrantId?: string;
	cooldownUntil?: string;
}

interface JuniperStatus {
	eligible: boolean;
	reason?: string;
	arm?: "control" | "reset";
	available: boolean;
	nextAvailableAt?: string;
	weeklyResetsAt?: string;
}

type ParsedStatus<T> = { ok: true; status: T | null } | { ok: false };
type Discovery<T> = { kind: "answered"; status: T | null; baseUrl: string } | { kind: "failed" };

function optionalString(value: unknown): string | undefined | null {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string" || !value.trim()) return null;
	return value.trim();
}

function optionalIsoTimestamp(value: unknown): string | undefined | null {
	const stringValue = optionalString(value);
	if (stringValue === null || stringValue === undefined) return stringValue;
	const timestamp = Date.parse(stringValue);
	return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizeWindowId(value: unknown): string | null {
	if (typeof value !== "string" || !WINDOW_ID.test(value)) return null;
	return CLAUDE_RESET_WINDOW_IDS[value] ?? `anthropic:reset:${value}`;
}

function normalizeWindowList(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const normalized: string[] = [];
	for (const item of value) {
		const id = normalizeWindowId(item);
		if (!id) return null;
		if (!normalized.includes(id)) normalized.push(id);
	}
	return normalized;
}

function normalizeUsedFractions(value: unknown): Record<string, number> | null {
	if (value === undefined) return {};
	if (!isRecord(value)) return null;
	const normalized: Record<string, number> = {};
	for (const rawId in value) {
		const percent = value[rawId];
		const id = normalizeWindowId(rawId);
		if (!id || typeof percent !== "number" || !Number.isInteger(percent) || percent < 0 || percent > 100) {
			return null;
		}
		normalized[id] = percent / 100;
	}
	return normalized;
}

function parseCedarGrant(value: unknown): CedarGrant | null {
	if (!isRecord(value) || typeof value.id !== "string" || !CEDAR_GRANT_ID.test(value.id)) return null;
	if (typeof value.resets_left !== "number" || !Number.isInteger(value.resets_left) || value.resets_left < 0) {
		return null;
	}
	if (
		value.resets_total !== undefined &&
		(typeof value.resets_total !== "number" || !Number.isInteger(value.resets_total) || value.resets_total < 0)
	) {
		return null;
	}
	const label =
		value.label === undefined || value.label === null
			? undefined
			: typeof value.label === "string"
				? value.label.trim()
				: null;
	const grantedAt = optionalIsoTimestamp(value.starts_at);
	const expiresAt = optionalIsoTimestamp(value.ends_at);
	const clears = normalizeWindowList(value.clears);
	const blocking = normalizeWindowList(value.blocking);
	const usedFractions = normalizeUsedFractions(value.percent_used);
	if (label === null || grantedAt === null || expiresAt === null || !clears || !blocking || !usedFractions)
		return null;
	if (value.paused !== undefined && typeof value.paused !== "boolean") return null;
	if (value.usable_now !== undefined && typeof value.usable_now !== "boolean") return null;
	if (value.use_requires_limit !== undefined && typeof value.use_requires_limit !== "boolean") return null;
	return {
		id: value.id,
		...(label ? { label } : {}),
		remainingCount: value.resets_left,
		...(grantedAt ? { grantedAt } : {}),
		...(expiresAt ? { expiresAt } : {}),
		clears,
		paused: value.paused ?? false,
		usableNow: value.usable_now ?? false,
		requiresLimit: value.use_requires_limit ?? true,
		usedFractions,
		blocking,
	};
}

function parseCedarStatus(value: unknown): ParsedStatus<CedarStatus> {
	if (value === undefined || value === null) return { ok: true, status: null };
	if (!isRecord(value) || typeof value.eligible !== "boolean") return { ok: false };
	const reason = optionalString(value.ineligible_reason);
	const cooldownUntil = optionalIsoTimestamp(value.cooldown_until);
	if (reason === null || cooldownUntil === null) return { ok: false };
	if (value.at_limit !== undefined && typeof value.at_limit !== "boolean") return { ok: false };
	if (value.exhausted !== undefined && !normalizeWindowList(value.exhausted)) return { ok: false };
	if (value.grants !== undefined && !Array.isArray(value.grants)) return { ok: false };
	const grants: CedarGrant[] = [];
	for (const rawGrant of value.grants ?? []) {
		const grant = parseCedarGrant(rawGrant);
		if (!grant) return { ok: false };
		grants.push(grant);
	}
	const rawNextGrantId = value.next_grant_id;
	if (
		rawNextGrantId !== undefined &&
		rawNextGrantId !== null &&
		(typeof rawNextGrantId !== "string" || !CEDAR_GRANT_ID.test(rawNextGrantId))
	) {
		return { ok: false };
	}
	const nextGrantId =
		typeof rawNextGrantId === "string" && grants.some(grant => grant.id === rawNextGrantId)
			? rawNextGrantId
			: undefined;
	return {
		ok: true,
		status: {
			eligible: value.eligible,
			...(reason ? { reason } : {}),
			grants,
			...(nextGrantId ? { nextGrantId } : {}),
			...(cooldownUntil ? { cooldownUntil } : {}),
		},
	};
}

function parseJuniperStatus(value: unknown): ParsedStatus<JuniperStatus> {
	if (value === undefined || value === null) return { ok: true, status: null };
	if (!isRecord(value) || typeof value.eligible !== "boolean") return { ok: false };
	const reason = optionalString(value.ineligible_reason);
	const nextAvailableAt = optionalIsoTimestamp(value.next_available_at);
	const weeklyResetsAt = optionalIsoTimestamp(value.weekly_resets_at);
	if (reason === null || nextAvailableAt === null || weeklyResetsAt === null) return { ok: false };
	if (value.available !== undefined && typeof value.available !== "boolean") return { ok: false };
	if (value.arm !== undefined && value.arm !== null && value.arm !== "control" && value.arm !== "reset") {
		return { ok: false };
	}
	if (
		value.resets_per_week !== undefined &&
		(typeof value.resets_per_week !== "number" ||
			!Number.isInteger(value.resets_per_week) ||
			value.resets_per_week < 0)
	) {
		return { ok: false };
	}
	return {
		ok: true,
		status: {
			eligible: value.eligible,
			...(reason ? { reason } : {}),
			...(value.arm === "control" || value.arm === "reset" ? { arm: value.arm } : {}),
			available: value.available ?? false,
			...(nextAvailableAt ? { nextAvailableAt } : {}),
			...(weeklyResetsAt ? { weeklyResetsAt } : {}),
		},
	};
}

function isUsageEnvelope(payload: Record<string, unknown>): boolean {
	return (
		"five_hour" in payload ||
		"seven_day" in payload ||
		"limits" in payload ||
		"extra_usage" in payload ||
		"spend" in payload
	);
}

async function discoverStatus<T>(
	auth: ClaudeResetAuth,
	query: string,
	field: string,
	parse: (value: unknown) => ParsedStatus<T>,
): Promise<Discovery<T>> {
	const candidates = claudeOAuthBaseUrls(auth.baseUrl);
	for (const baseUrl of candidates) {
		if (auth.signal?.aborted) return { kind: "failed" };
		let response: Response;
		try {
			response = await auth.fetch(`${baseUrl}/usage?${query}`, {
				headers: buildClaudeOAuthHeaders(auth.accessToken),
				signal: auth.signal ?? AbortSignal.timeout(5_000),
			});
		} catch {
			return { kind: "failed" };
		}
		if (!response.ok) {
			const canFallback =
				ENDPOINT_ABSENT_STATUSES[response.status] === true && baseUrl !== DEFAULT_CLAUDE_OAUTH_BASE_URL;
			if (canFallback) continue;
			return { kind: "failed" };
		}
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			return { kind: "failed" };
		}
		if (!isRecord(payload)) return { kind: "failed" };
		if (field in payload) {
			const parsed = parse(payload[field]);
			return parsed.ok ? { kind: "answered", status: parsed.status, baseUrl } : { kind: "failed" };
		}
		if (isUsageEnvelope(payload)) return { kind: "answered", status: null, baseUrl };
		const canFallback = baseUrl !== DEFAULT_CLAUDE_OAUTH_BASE_URL;
		if (!canFallback) return { kind: "failed" };
	}
	return { kind: "failed" };
}

function normalizeCedarList(status: CedarStatus, orgId?: string, baseUrl?: string): ClaudeResetCreditList {
	const now = Date.now();
	const cooldownActive = status.cooldownUntil !== undefined && Date.parse(status.cooldownUntil) > now;
	let availableCount = 0;
	let selectedCredit: UsageResetCredit | undefined;
	const credits = status.grants.map<UsageResetCredit>(grant => {
		const expired = grant.expiresAt !== undefined && Date.parse(grant.expiresAt) <= now;
		const selected = grant.id === status.nextGrantId;
		const usable =
			status.eligible &&
			selected &&
			grant.usableNow &&
			!grant.paused &&
			!expired &&
			!cooldownActive &&
			grant.remainingCount > 0;
		const creditStatus = expired
			? "expired"
			: grant.remainingCount === 0
				? "redeemed"
				: grant.paused
					? "paused"
					: usable
						? "available"
						: "unavailable";
		if (!expired && grant.remainingCount > 0) availableCount += grant.remainingCount;
		const credit: UsageResetCredit = {
			id: grant.id,
			title: grant.label || "Claude limit reset",
			program: CEDAR_PROGRAM,
			remainingCount: grant.remainingCount,
			usable,
			requiresLimit: grant.requiresLimit,
			clears: grant.clears,
			blocking: grant.blocking,
			usedFractions: grant.usedFractions,
			...(grant.grantedAt ? { grantedAt: grant.grantedAt } : {}),
			...(grant.expiresAt ? { expiresAt: grant.expiresAt } : {}),
			status: creditStatus,
		};
		if (selected) selectedCredit = credit;
		return credit;
	});
	return {
		availableCount,
		redeemableCount: selectedCredit?.usable ? (selectedCredit.remainingCount ?? 0) : 0,
		...(status.nextGrantId && status.eligible ? { nextCreditId: status.nextGrantId } : {}),
		eligible: status.eligible,
		...(status.reason ? { reason: status.reason } : cooldownActive ? { reason: "cooldown" } : {}),
		...(status.cooldownUntil ? { cooldownUntil: status.cooldownUntil } : {}),
		credits,
		...(orgId ? { orgId } : {}),
		...(baseUrl ? { baseUrl } : {}),
	};
}

function normalizeJuniperList(status: JuniperStatus, orgId?: string, baseUrl?: string): ClaudeResetCreditList {
	const eligible = status.eligible && status.arm === "reset";
	const usable = eligible && status.available;
	const offered = status.arm === "reset";
	const reason =
		status.reason ??
		(!status.eligible
			? "ineligible"
			: status.arm !== "reset"
				? "control"
				: !status.available
					? "unavailable"
					: undefined);
	const credits: UsageResetCredit[] = offered
		? [
				{
					id: JUNIPER_PROGRAM,
					title: "Claude session limit reset",
					program: JUNIPER_PROGRAM,
					remainingCount: usable ? 1 : 0,
					usable,
					requiresLimit: true,
					clears: ["anthropic:5h"],
					blocking: [],
					usedFractions: {},
					...(status.weeklyResetsAt ? { expiresAt: status.weeklyResetsAt } : {}),
					status: usable ? "available" : "unavailable",
				},
			]
		: [];
	return {
		availableCount: usable ? 1 : 0,
		redeemableCount: usable ? 1 : 0,
		...(eligible ? { nextCreditId: JUNIPER_PROGRAM } : {}),
		eligible,
		...(reason ? { reason } : {}),
		...(!usable && status.nextAvailableAt ? { cooldownUntil: status.nextAvailableAt } : {}),
		credits,
		...(orgId ? { orgId } : {}),
		...(baseUrl ? { baseUrl } : {}),
	};
}

interface OrganizationResolution {
	orgId?: string;
	status: number;
	code?: "auth_error" | "organization_unavailable";
	raw?: unknown;
}

async function resolveOrganization(auth: ClaudeResetAuth): Promise<OrganizationResolution> {
	const configured = auth.orgId?.trim();
	if (configured && ORGANIZATION_ID.test(configured)) return { orgId: configured, status: 0 };
	if (configured) return { status: 0, code: "organization_unavailable" };
	let response: Response;
	try {
		response = await auth.fetch(`${claudeOAuthBaseUrl(auth.baseUrl)}/profile`, {
			headers: buildClaudeOAuthHeaders(auth.accessToken),
			signal: auth.signal ?? AbortSignal.timeout(5_000),
		});
	} catch {
		return { status: 0, code: "organization_unavailable" };
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		payload = undefined;
	}
	if (!response.ok) {
		return {
			status: response.status,
			code: response.status === 401 || response.status === 403 ? "auth_error" : "organization_unavailable",
			...(payload !== undefined ? { raw: payload } : {}),
		};
	}
	if (!isRecord(payload)) return { status: response.status, code: "organization_unavailable", raw: payload };
	const organization = isRecord(payload.organization) ? payload.organization : undefined;
	const candidate =
		(typeof organization?.uuid === "string" ? organization.uuid : undefined) ??
		(typeof payload.organization_uuid === "string" ? payload.organization_uuid : undefined);
	const orgId = candidate?.trim();
	if (!orgId || !ORGANIZATION_ID.test(orgId)) {
		return { status: response.status, code: "organization_unavailable", raw: payload };
	}
	return { orgId, status: response.status };
}

async function withResolvedOrganization(
	list: ClaudeResetCreditList,
	auth: ClaudeResetAuth,
): Promise<ClaudeResetCreditList> {
	if (list.orgId || list.credits.length === 0) return list;
	const resolution = await resolveOrganization({ ...auth, baseUrl: list.baseUrl ?? auth.baseUrl });
	return resolution.orgId ? { ...list, orgId: resolution.orgId } : list;
}

/**
 * Reuse program blocks when a normal usage response actually includes them.
 * A lone non-redeemable Cedar block is inconclusive because Juniper requires
 * the separate at-wall read, so callers must still perform discovery.
 *
 * @internal
 */
export function parseClaudeResetCreditsFromUsagePayload(
	payload: unknown,
	orgId?: string,
	baseUrl?: string,
): ClaudeResetCreditList | null {
	if (!isRecord(payload) || !Object.hasOwn(payload, CEDAR_PROGRAM)) return null;
	const parsedCedar = parseCedarStatus(payload[CEDAR_PROGRAM]);
	if (!parsedCedar.ok) return null;
	const normalizedOrgId = orgId?.trim();
	const safeOrgId = normalizedOrgId && ORGANIZATION_ID.test(normalizedOrgId) ? normalizedOrgId : undefined;
	const cedarList = parsedCedar.status ? normalizeCedarList(parsedCedar.status, safeOrgId, baseUrl) : undefined;
	if (cedarList && (cedarList.availableCount > 0 || cedarList.nextCreditId)) return cedarList;
	if (!Object.hasOwn(payload, JUNIPER_PROGRAM)) return null;
	const parsedJuniper = parseJuniperStatus(payload[JUNIPER_PROGRAM]);
	if (!parsedJuniper.ok) return null;
	if (parsedJuniper.status) return normalizeJuniperList(parsedJuniper.status, safeOrgId, baseUrl);
	if (cedarList) return cedarList;
	return {
		availableCount: 0,
		redeemableCount: 0,
		eligible: false,
		credits: [],
		...(safeOrgId ? { orgId: safeOrgId } : {}),
		...(baseUrl ? { baseUrl } : {}),
	};
}

/**
 * Discover Claude's saved Cedar grant first, then its Juniper session reset.
 * `null` means discovery failed; a zero-count object is an authoritative answer.
 */
export async function listClaudeResetCredits(auth: ClaudeResetAuth): Promise<ClaudeResetCreditList | null> {
	const explicitOrgId = auth.orgId?.trim();
	const orgId = explicitOrgId && ORGANIZATION_ID.test(explicitOrgId) ? explicitOrgId : undefined;
	const cedar = await discoverStatus(auth, "cedar_ember=1&skip_spend=1", CEDAR_PROGRAM, parseCedarStatus);
	if (cedar.kind === "failed") return null;
	let cedarList: ClaudeResetCreditList | undefined;
	if (cedar.status) {
		cedarList = normalizeCedarList(cedar.status, orgId, cedar.baseUrl);
		if (cedarList.availableCount > 0 || cedarList.nextCreditId) {
			return withResolvedOrganization(cedarList, auth);
		}
	}

	const juniper = await discoverStatus(auth, "at_wall=1&skip_spend=1", JUNIPER_PROGRAM, parseJuniperStatus);
	if (juniper.kind === "answered" && juniper.status) {
		return withResolvedOrganization(normalizeJuniperList(juniper.status, orgId, juniper.baseUrl), auth);
	}
	if (cedarList && juniper.kind === "answered") return cedarList;
	if (juniper.kind === "answered") {
		return {
			availableCount: 0,
			redeemableCount: 0,
			eligible: false,
			credits: [],
			...(orgId ? { orgId } : {}),
			baseUrl: juniper.baseUrl,
		};
	}
	return null;
}

function normalizeConsumeCode(result: string): string {
	if (result === "already_used") return "already_redeemed";
	if (result === "not_limited") return "nothing_to_reset";
	return result;
}

/** Spend exactly the server-selected Claude reset. Mutation requests are never retried. */
export async function consumeClaudeResetCredit(
	auth: ClaudeResetAuth & { credit: UsageResetCredit; redeemRequestId?: string },
): Promise<ClaudeResetConsumeResult> {
	const program = auth.credit.program;
	if (program !== CEDAR_PROGRAM && program !== JUNIPER_PROGRAM) {
		return { ok: false, code: "unknown_program", status: 0 };
	}
	const expiresAtMs = auth.credit.expiresAt === undefined ? undefined : Date.parse(auth.credit.expiresAt);
	if (
		auth.credit.usable !== true ||
		typeof auth.credit.remainingCount !== "number" ||
		!Number.isInteger(auth.credit.remainingCount) ||
		auth.credit.remainingCount <= 0 ||
		(expiresAtMs !== undefined && (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()))
	) {
		return { ok: false, code: "unavailable", status: 0, reason: "credit_not_usable" };
	}
	if (
		(program === CEDAR_PROGRAM && !CEDAR_GRANT_ID.test(auth.credit.id)) ||
		(program === JUNIPER_PROGRAM && auth.credit.id !== JUNIPER_PROGRAM)
	) {
		return { ok: false, code: "invalid_credit", status: 0 };
	}
	const requestId = program === CEDAR_PROGRAM ? (auth.redeemRequestId ?? crypto.randomUUID()) : undefined;
	if (requestId !== undefined && !REDEEM_REQUEST_ID.test(requestId)) {
		return { ok: false, code: "invalid_request", status: 0 };
	}
	if (auth.baseUrl?.trim()) {
		try {
			new URL(auth.baseUrl);
		} catch {
			return { ok: false, code: "invalid_base_url", status: 0 };
		}
	}
	const organization = await resolveOrganization(auth);
	if (!organization.orgId) {
		return {
			ok: false,
			code: organization.code ?? "organization_unavailable",
			status: organization.status,
			...(organization.raw !== undefined ? { raw: organization.raw } : {}),
		};
	}
	const body =
		program === CEDAR_PROGRAM
			? { program: CEDAR_PROGRAM, grant_id: auth.credit.id, request_id: requestId }
			: { program: JUNIPER_PROGRAM };
	let response: Response;
	try {
		response = await auth.fetch(
			claudeApiUrl(auth.baseUrl, `/api/organizations/${encodeURIComponent(organization.orgId)}/reset_rate_limits`),
			{
				method: "POST",
				headers: buildClaudeOAuthHeaders(auth.accessToken),
				body: JSON.stringify(body),
				signal: auth.signal ?? AbortSignal.timeout(25_000),
			},
		);
	} catch (error) {
		return { ok: false, code: "network_error", status: 0, raw: error };
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		payload = undefined;
	}
	if (!response.ok) {
		const code =
			response.status === 401 || response.status === 403
				? "auth_error"
				: response.status === 429
					? "rate_limited"
					: `http_${response.status}`;
		return {
			ok: false,
			code,
			status: response.status,
			...(payload !== undefined ? { raw: payload } : {}),
		};
	}
	if (!isRecord(payload) || typeof payload.result !== "string" || !payload.result.trim()) {
		return {
			ok: false,
			code: "malformed_response",
			status: response.status,
			...(payload !== undefined ? { raw: payload } : {}),
		};
	}
	const reason = optionalString(payload.reason);
	if (reason === null) {
		return { ok: false, code: "malformed_response", status: response.status, raw: payload };
	}
	let cleared: string[] | undefined;
	if (payload.cleared !== undefined) {
		const normalized = normalizeWindowList(payload.cleared);
		if (!normalized) {
			return { ok: false, code: "malformed_response", status: response.status, raw: payload };
		}
		cleared = normalized;
	} else if (payload.result === "reset") {
		cleared = program === JUNIPER_PROGRAM ? ["anthropic:5h"] : auth.credit.clears;
	}
	const code = normalizeConsumeCode(payload.result.trim());
	return {
		ok: response.ok && payload.result === "reset",
		code,
		status: response.status,
		...(cleared ? { cleared } : {}),
		...(reason ? { reason } : {}),
		raw: payload,
	};
}
