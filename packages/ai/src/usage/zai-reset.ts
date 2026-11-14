/**
 * Z.AI coding-plan "reset opportunity" client.
 *
 * GLM Coding Plan accounts can claim a quota-window reset *opportunity* and
 * bank it as an offer that expires (~2h server-side) until it is *used* to
 * reset the matching window. zcode's desktop app drives these three control
 * plane routes, reverse-engineered and live-verified 2026-11-13:
 *
 *   GET  /api/v1/coding-plan/reset/status        → banked offers + last use
 *   POST /api/v1/coding-plan/reset/opportunity   → claim one reset
 *        body: { idempotency_key } (server rejects non-UUID keys)
 *   POST /api/v1/coding-plan/reset/use           → spend one banked offer
 *        body: { idempotency_key, reset_type: "FIVE_HOUR" | "WEEK" }
 *
 * Every call carries BOTH durable login JWTs (`Authorization` is the zcode
 * control-plane token, `X-Bigmodel-Authorization` the MaaS OAuth token);
 * minted API keys are rejected with 401 on these routes. Envelope is
 * `{code, msg, data}` with success `code === 0` (200 also accepted); the
 * 3301 refusal (`granted: false` + `next_try_at`) is a normal outcome, not an
 * error. All timestamps in `data` are epoch ms except `server_time` (seconds).
 *
 * Thin, dependency-light functions so the reset-credit API
 * (./auth/resets.ts) and the usage fetcher (./zai.ts) share one wire contract.
 */
import { toNumber } from "@oh-my-pi/pi-catalog/utils";
import { $pickenv, USER_AGENT } from "@oh-my-pi/pi-utils";
import type { UsageResetCredit, UsageResetCreditDetail, UsageResetCredits } from "../usage";
import type { FetchImpl } from "../types";
import { isRecord } from "../utils";

const DEFAULT_BASE_URL = "https://zcode.z.ai";
const STATUS_PATH = "/api/v1/coding-plan/reset/status";
const OPPORTUNITY_PATH = "/api/v1/coding-plan/reset/opportunity";
const USE_PATH = "/api/v1/coding-plan/reset/use";
/** Z.AI caps idempotency keys at 64 chars and rejects non-UUID values with `code: 3001`. */
const IDEMPOTENCY_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Business code for "no reset grant right now, try again at `data.next_try_at`". */
const NOT_GRANTED_CODE = 3301;
const REQUEST_TIMEOUT_MS = 15_000;
const ZAI_RESET_PROGRAM = "zai-coding-plan";
/**
 * Limit ids a reset clears, exactly as {@link buildZaiWindow} in `./zai.ts`
 * builds them: `unit: 3, number: 5` → the 5-hour token window, `unit: 6` → the
 * weekly one. Kept as local constants because the window builder derives them
 * from raw quota rows, not from this client.
 */
const CLEARED_LIMITS: Readonly<Record<ZaiResetType, string>> = {
	FIVE_HOUR: "zai:tokens:5h",
	WEEK: "zai:tokens:1w",
};

/** Which quota window a banked reset clears when spent. */
export type ZaiResetType = "FIVE_HOUR" | "WEEK";

/** The two durable login JWTs every coding-plan reset call must carry. */
export interface ZaiResetAuth {
	zcodeJwt: string;
	zaiOauthJwt: string;
}

/** One banked reset offer. Perishable: it can no longer be spent after `expireAtMs`. */
export interface ZaiResetOffer {
	expireAtMs: number;
}

/** Live coding-plan reset state for one account. */
export interface ZaiResetStatus {
	availableFiveHourResets: ZaiResetOffer[];
	availableWeekResets: ZaiResetOffer[];
	latestFiveHourUsedAtMs?: number;
	latestWeekUsedAtMs?: number;
	hasUnreadHistory: boolean;
	/** Server clock (converted from epoch seconds), for expiry sanity checks. */
	serverTimeMs?: number;
}

/**
 * Opportunity claim outcome. `ok: true` means the request completed and the
 * server answered (granted or politely refused with a `nextTryAtMs`); `ok:
 * false` failures carry a `code`: `"throttled"` (HTTP 429), `"http_<status>"`,
 * `"invalid_response"`, or `"business_<code>"` for other business refusals
 * (e.g. `"business_3001"` — the idempotency key was rejected as malformed).
 */
export type ZaiResetOpportunityOutcome =
	| { ok: true; granted: true }
	| { ok: true; granted: false; nextTryAtMs: number }
	| { ok: false; code: string; reason?: string };

/**
 * Spend outcome. `ok: true, code: "reset"` means a window was reset; a
 * business refusal that the offer is gone maps to `no_credit` — any other
 * refusal comes back as `"business_<code>"`, unexpected HTTP as
 * `"http_<status>"`, and an unusable body as `"invalid_response"`.
 */
export interface ZaiResetUseOutcome {
	ok: boolean;
	code: string;
	reason?: string;
}

/** Shared transport options; `fetchImpl` defaults to the global fetch. */
interface ZaiResetOptions {
	fetchImpl?: FetchImpl;
	signal?: AbortSignal;
}

function resolveBaseUrl(): string {
	const base = $pickenv("ZAI_RESET_BASE_URL") ?? DEFAULT_BASE_URL;
	return base.endsWith("/") ? base.slice(0, -1) : base;
}

function buildHeaders(auth: ZaiResetAuth, json: boolean): Record<string, string> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${auth.zcodeJwt}`,
		"X-Bigmodel-Authorization": `Bearer ${auth.zaiOauthJwt}`,
		"Bigmodel-Target-Type": "PERSONAL",
		"User-Agent": USER_AGENT,
	};
	if (json) headers["Content-Type"] = "application/json";
	return headers;
}

/** Epoch value in ms. Z.AI sends ms for offer/history fields, seconds for server_time. */
function epochMs(value: unknown): number | undefined {
	const parsed = toNumber(value);
	if (parsed === undefined || !Number.isFinite(parsed) || parsed <= 0) return undefined;
	// Everything on this API is >1e12 in ms and <1e12 in seconds until year 33658.
	return parsed > 1_000_000_000_000 ? parsed : parsed * 1000;
}

function requireIdempotencyKey(idempotencyKey: string): string {
	if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
		throw new Error("Z.AI reset idempotency keys must be UUIDs (crypto.randomUUID())");
	}
	return idempotencyKey;
}

function parseOffers(value: unknown): ZaiResetOffer[] {
	if (!Array.isArray(value)) return [];
	const offers: ZaiResetOffer[] = [];
	for (const item of value) {
		if (!isRecord(item)) continue;
		const expireAt = epochMs(item.expire_at);
		if (expireAt === undefined) continue;
		offers.push({ expireAtMs: expireAt });
	}
	return offers;
}

function parseStatus(data: unknown): ZaiResetStatus | null {
	if (!isRecord(data)) return null;
	// Both offer arrays must be present: a missing array means the payload
	// shape changed and treating it as "no resets" would silently hide offers.
	if (!Array.isArray(data.available_five_hour_resets) || !Array.isArray(data.available_week_resets)) return null;
	const fiveHourUsed = isRecord(data.latest_five_hour_reset_history)
		? epochMs(data.latest_five_hour_reset_history.used_at)
		: undefined;
	const weekUsed = isRecord(data.latest_week_reset_history)
		? epochMs(data.latest_week_reset_history.used_at)
		: undefined;
	return {
		availableFiveHourResets: parseOffers(data.available_five_hour_resets),
		availableWeekResets: parseOffers(data.available_week_resets),
		...(fiveHourUsed !== undefined ? { latestFiveHourUsedAtMs: fiveHourUsed } : {}),
		...(weekUsed !== undefined ? { latestWeekUsedAtMs: weekUsed } : {}),
		hasUnreadHistory: data.has_unread_history === true,
		...(epochMs(data.server_time) !== undefined ? { serverTimeMs: epochMs(data.server_time) } : {}),
	};
}

interface ZaiResetReply {
	httpOk: boolean;
	status: number;
	/** Non-`undefined` when the body parsed and carried a business code. */
	envelope?: { code: number; msg?: string; data: unknown };
}

async function readReply(response: Response): Promise<ZaiResetReply> {
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		body = undefined;
	}
	let envelope: ZaiResetReply["envelope"];
	if (isRecord(body) && body.code !== undefined) {
		const code = toNumber(body.code);
		if (code !== undefined) {
			envelope = {
				code,
				...(typeof body.msg === "string" ? { msg: body.msg } : {}),
				data: body.data,
			};
		}
	}
	return { httpOk: response.ok, status: response.status, envelope };
}

function failure(
	code: string,
	reply: ZaiResetReply,
	fallbackReason: string,
): { ok: false; code: string; reason?: string } {
	const reason = reply.envelope?.msg ?? (reply.status > 0 ? `HTTP ${reply.status}` : fallbackReason);
	return { ok: false, code, reason };
}

/** Outcome of {@link listZaiResetStatus}. */
export type ZaiResetListOutcome = { ok: true; status: ZaiResetStatus } | { ok: false; code: "unauthorized" | "failed" };

/**
 * List an account's live reset offers and last-use history. HTTP 401/403 map
 * to `unauthorized` — the durable login JWTs were rejected, so the account
 * needs a fresh sign-in; every other transport, HTTP, or parse failure maps
 * to `failed`. Both stay distinct from a successful empty listing so callers
 * never mistake "cannot read" for "no resets".
 */
export async function listZaiResetStatus(auth: ZaiResetAuth, options?: ZaiResetOptions): Promise<ZaiResetListOutcome> {
	const fetchImpl = options?.fetchImpl ?? fetch;
	try {
		const response = await fetchImpl(`${resolveBaseUrl()}${STATUS_PATH}`, {
			headers: buildHeaders(auth, false),
			signal: options?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (response.status === 401 || response.status === 403) return { ok: false, code: "unauthorized" };
		if (!response.ok) return { ok: false, code: "failed" };
		const body: unknown = await response.json();
		if (isRecord(body) && body.code !== undefined && body.code !== 0 && body.code !== 200) {
			return { ok: false, code: "failed" };
		}
		const status = parseStatus(isRecord(body) ? body.data : undefined);
		return status ? { ok: true, status } : { ok: false, code: "failed" };
	} catch {
		return { ok: false, code: "failed" };
	}
}

/**
 * Claim one coding-plan reset opportunity. `idempotencyKey` must be a UUID;
 * the server rejects other shapes with business code 3001. A 3301 refusal is
 * a normal `ok: true, granted: false` outcome carrying the server-stated
 * earliest retry (epoch ms); a 429 surfaces as `code: "throttled"`.
 */
export async function requestZaiResetOpportunity(
	auth: ZaiResetAuth,
	options: ZaiResetOptions & { idempotencyKey: string },
): Promise<ZaiResetOpportunityOutcome> {
	requireIdempotencyKey(options.idempotencyKey);
	const fetchImpl = options.fetchImpl ?? fetch;
	let reply: ZaiResetReply;
	try {
		const response = await fetchImpl(`${resolveBaseUrl()}${OPPORTUNITY_PATH}`, {
			method: "POST",
			headers: buildHeaders(auth, true),
			body: JSON.stringify({ idempotency_key: options.idempotencyKey }),
			signal: options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		reply = await readReply(response);
	} catch (error) {
		return { ok: false, code: "invalid_response", reason: String(error) };
	}
	if (reply.status === 429) return failure("throttled", reply, "throttled");
	const envelope = reply.envelope;
	const data = isRecord(envelope?.data) ? envelope?.data : undefined;
	if (envelope && envelope.code !== 0 && envelope.code !== 200) {
		if (envelope.code === NOT_GRANTED_CODE) {
			const nextTryAtMs = epochMs(data?.next_try_at);
			if (nextTryAtMs !== undefined) return { ok: true, granted: false, nextTryAtMs };
		}
		return failure(`business_${envelope.code}`, reply, "request failed");
	}
	if (!reply.httpOk) return failure(`http_${reply.status}`, reply, "request failed");
	if (data?.granted === true) return { ok: true, granted: true };
	if (data?.granted === false) {
		const nextTryAtMs = epochMs(data.next_try_at);
		if (nextTryAtMs !== undefined) return { ok: true, granted: false, nextTryAtMs };
	}
	return failure("invalid_response", reply, "unrecognized response body");
}

/**
 * Spend one banked reset offer. Reuse the SAME `idempotencyKey` (UUID) when
 * retrying a lost response: the spend is idempotent, so it cannot double-reset.
 * The request names no offer id — the server chooses which banked offer of
 * `reset_type` to spend. `ok: true, code: "reset"` means the window was reset.
 */
export async function useZaiReset(
	auth: ZaiResetAuth,
	options: ZaiResetOptions & { idempotencyKey: string; resetType: ZaiResetType },
): Promise<ZaiResetUseOutcome> {
	requireIdempotencyKey(options.idempotencyKey);
	const fetchImpl = options.fetchImpl ?? fetch;
	let reply: ZaiResetReply;
	try {
		const response = await fetchImpl(`${resolveBaseUrl()}${USE_PATH}`, {
			method: "POST",
			headers: buildHeaders(auth, true),
			body: JSON.stringify({
				idempotency_key: options.idempotencyKey,
				reset_type: options.resetType,
			}),
			signal: options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		reply = await readReply(response);
	} catch (error) {
		return { ok: false, code: "invalid_response", reason: String(error) };
	}
	const envelope = reply.envelope;
	const data = isRecord(envelope?.data) ? envelope?.data : undefined;
	if (envelope && envelope.code !== 0 && envelope.code !== 200) {
		return failure(`business_${envelope.code}`, reply, "request failed");
	}
	if (!reply.httpOk) return failure(`http_${reply.status}`, reply, "request failed");
	if (data?.used === true) return { ok: true, code: "reset" };
	if (data?.used === false) return { ok: false, code: "no_credit", reason: "the banked reset was no longer usable" };
	return failure("invalid_response", reply, "unrecognized response body");
}

const CREDIT_ID_PREFIXES: Readonly<Record<ZaiResetType, string>> = {
	FIVE_HOUR: "five_hour",
	WEEK: "week",
};

/** Stable credit id for one banked offer: `five_hour:<expireAtMs>` / `week:<expireAtMs>`. */
export function zaiResetCreditId(type: ZaiResetType, expireAtMs: number): string {
	return `${CREDIT_ID_PREFIXES[type]}:${expireAtMs}`;
}

/** Inverse of {@link zaiResetCreditId}; `undefined` for ids from any other reset program. */
export function zaiResetTypeFromCreditId(creditId: string): ZaiResetType | undefined {
	const separator = creditId.indexOf(":");
	if (separator <= 0) return undefined;
	const expiry = Number(creditId.slice(separator + 1));
	if (!Number.isInteger(expiry) || expiry <= 0) return undefined;
	const prefix = creditId.slice(0, separator);
	if (prefix === CREDIT_ID_PREFIXES.FIVE_HOUR) return "FIVE_HOUR";
	if (prefix === CREDIT_ID_PREFIXES.WEEK) return "WEEK";
	return undefined;
}

/**
 * Convert a live status into normalized usage-reset credits. Offers that
 * already expired at `nowMs` are dropped, the rest are listed soonest-expiring
 * first (perishable credits keep the most value when spent in expiry order).
 */
export function zaiResetStatusToCredits(status: ZaiResetStatus, nowMs: number): UsageResetCredit[] {
	const credits: UsageResetCredit[] = [];
	const add = (type: ZaiResetType, offers: readonly ZaiResetOffer[]): void => {
		for (const offer of offers) {
			if (offer.expireAtMs <= nowMs) continue;
			credits.push({
				id: zaiResetCreditId(type, offer.expireAtMs),
				title: type === "FIVE_HOUR" ? "Z.AI 5-hour reset" : "Z.AI weekly reset",
				program: ZAI_RESET_PROGRAM,
				remainingCount: 1,
				usable: true,
				status: "available",
				expiresAt: new Date(offer.expireAtMs).toISOString(),
				clears: [CLEARED_LIMITS[type]],
			});
		}
	};
	add("FIVE_HOUR", status.availableFiveHourResets);
	add("WEEK", status.availableWeekResets);
	credits.sort((left, right) => Date.parse(left.expiresAt ?? "") - Date.parse(right.expiresAt ?? ""));
	return credits;
}

/**
 * Account-level reset inventory (normalized credits + counts) for a live
 * status. The soonest-expiring credit is pinned as `nextCreditId` so generic
 * "spend the selected credit" paths redeem the perishable offer first.
 */
export function zaiResetStatusToInventory(status: ZaiResetStatus, nowMs: number): UsageResetCredits {
	const credits = zaiResetStatusToCredits(status, nowMs);
	return {
		availableCount: credits.length,
		redeemableCount: credits.length,
		eligible: true,
		credits,
		...(credits[0] ? { nextCreditId: credits[0].id } : {}),
	};
}

/**
 * The offer `/usage reset` spends on a Z.AI account. Z.AI spends exactly the
 * offer a target names, so name the available one that expires first.
 */
export function zaiResetUsageCredit<T extends UsageResetCreditDetail>(
	credits: readonly T[],
	nowMs = Date.now(),
): T | undefined {
	let soonest: T | undefined;
	let soonestMs = Number.POSITIVE_INFINITY;
	for (const credit of credits) {
		if ((credit.status ?? "available") !== "available" || credit.usable === false || !credit.expiresAt) continue;
		const expiresAtMs = Date.parse(credit.expiresAt);
		if (expiresAtMs > nowMs && expiresAtMs < soonestMs) {
			soonest = credit;
			soonestMs = expiresAtMs;
		}
	}
	return soonest;
}
