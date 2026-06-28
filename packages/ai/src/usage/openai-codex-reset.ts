/**
 * OpenAI Codex "saved rate limit reset" redemption client.
 *
 * OpenAI lets paid Codex accounts bank a usage-window reset and spend it on
 * demand (announced 2026-06-11). The count is surfaced on `/wham/usage` as
 * `rate_limit_reset_credits.available_count` (see `./openai-codex.ts`), but the
 * actual credit objects and the redeem action live on two dedicated routes:
 *
 *   GET  /wham/rate-limit-reset-credits           → list redeemable credits
 *   POST /wham/rate-limit-reset-credits/consume   → spend one credit
 *        body: { credit_id, redeem_request_id }
 *
 * `redeem_request_id` is a client-generated idempotency key (UUID). The consume
 * response carries a `code`: `"reset"` on success, otherwise a business reason
 * (`already_redeemed`, `no_credit`, `nothing_to_reset`).
 *
 * These are thin, dependency-light functions so both the interactive session
 * (the `/usage reset` command + auto-redeem) and any out-of-band tooling can
 * share one wire contract.
 */
import type { FetchImpl } from "../types";
import { isRecord } from "../utils";
import { normalizeCodexBaseUrl } from "./openai-codex-base-url";
import { toNumber } from "./shared";

const RESET_CREDITS_PATH = "wham/rate-limit-reset-credits";
const RESET_CREDITS_CONSUME_PATH = "wham/rate-limit-reset-credits/consume";

/** A single redeemable (or already-spent) saved reset. */
export interface CodexResetCredit {
	/** Opaque credit id, e.g. `RateLimitResetCredit_…`. Pass to {@link consumeCodexResetCredit}. */
	id: string;
	/** Backend reset family, e.g. `codex_rate_limits`. */
	resetType?: string;
	/** `available`, `redeemed`, … */
	status?: string;
	grantedAt?: string;
	expiresAt?: string;
	redeemStartedAt?: string | null;
	redeemedAt?: string | null;
	/** Human-facing card title, e.g. "One free rate limit reset". */
	title?: string;
	description?: string;
}

/** Result of listing an account's saved resets. */
export interface CodexResetCreditList {
	credits: CodexResetCredit[];
	/** Backend-reported count of credits redeemable right now. */
	availableCount: number;
}

/**
 * Consume outcome `code`. `reset` means a window was actually reset; the others
 * are no-op business outcomes the caller should surface verbatim-ish to the user.
 */
export type CodexResetConsumeCode =
	| "reset"
	| "already_redeemed"
	| "no_credit"
	| "nothing_to_reset"
	// Forward-compatible: unknown future codes pass through.
	| (string & {});

export interface CodexResetConsumeResult {
	/** `true` only when `code === "reset"` (a reset was applied). */
	ok: boolean;
	code: CodexResetConsumeCode;
	/** HTTP status of the consume call (for diagnostics). */
	status: number;
	raw?: unknown;
}

interface CodexResetAuth {
	accessToken: string;
	accountId?: string;
	/** Provider base URL override; defaults to the Codex backend. */
	baseUrl?: string;
	fetch: FetchImpl;
	signal?: AbortSignal;
}

function buildUrl(baseUrl: string | undefined, routePath: string): string {
	const base = normalizeCodexBaseUrl(baseUrl);
	const normalized = base.endsWith("/") ? base : `${base}/`;
	return `${normalized}${routePath}`;
}

function buildHeaders(auth: CodexResetAuth, json: boolean): Record<string, string> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${auth.accessToken}`,
		"User-Agent": "OpenCode-Status-Plugin/1.0",
	};
	if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;
	if (json) headers["Content-Type"] = "application/json";
	return headers;
}

function parseCredit(value: unknown): CodexResetCredit | null {
	if (!isRecord(value)) return null;
	const id = typeof value.id === "string" ? value.id : undefined;
	if (!id) return null;
	const str = (key: string): string | undefined =>
		typeof value[key] === "string" ? (value[key] as string) : undefined;
	const nullableStr = (key: string): string | null | undefined => {
		const raw = value[key];
		if (raw === null) return null;
		return typeof raw === "string" ? raw : undefined;
	};
	return {
		id,
		resetType: str("reset_type"),
		status: str("status"),
		grantedAt: str("granted_at"),
		expiresAt: str("expires_at"),
		redeemStartedAt: nullableStr("redeem_started_at"),
		redeemedAt: nullableStr("redeemed_at"),
		title: str("title"),
		description: str("description"),
	};
}

/**
 * List the account's saved rate-limit resets. Returns `null` on transport/auth
 * failure (non-2xx or thrown), letting callers treat it the same as "no data".
 */
export async function listCodexResetCredits(auth: CodexResetAuth): Promise<CodexResetCreditList | null> {
	const url = buildUrl(auth.baseUrl, RESET_CREDITS_PATH);
	let payload: unknown;
	try {
		const response = await auth.fetch(url, { headers: buildHeaders(auth, false), signal: auth.signal });
		if (!response.ok) return null;
		payload = await response.json();
	} catch {
		return null;
	}
	if (!isRecord(payload)) return null;
	const credits = Array.isArray(payload.credits)
		? payload.credits.map(parseCredit).filter((c): c is CodexResetCredit => c !== null)
		: [];
	const reported = toNumber(payload.available_count);
	const availableCount =
		reported !== undefined
			? Math.max(0, Math.trunc(reported))
			: credits.filter(c => (c.status ?? "available") === "available").length;
	return { credits, availableCount };
}

/**
 * Spend one saved reset. `redeemRequestId` is the idempotency key; one is
 * generated when omitted, so retrying with the SAME id is safe and won't
 * double-spend. The returned `code` is `"reset"` on success.
 */
export async function consumeCodexResetCredit(
	auth: CodexResetAuth & { creditId: string; redeemRequestId?: string },
): Promise<CodexResetConsumeResult> {
	const redeemRequestId = auth.redeemRequestId ?? crypto.randomUUID();
	const url = buildUrl(auth.baseUrl, RESET_CREDITS_CONSUME_PATH);
	const response = await auth.fetch(url, {
		method: "POST",
		headers: buildHeaders(auth, true),
		body: JSON.stringify({ credit_id: auth.creditId, redeem_request_id: redeemRequestId }),
		signal: auth.signal,
	});
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		body = undefined;
	}
	const code =
		isRecord(body) && typeof body.code === "string" ? body.code : response.ok ? "reset" : `http_${response.status}`;
	return { ok: code === "reset", code, status: response.status, raw: body };
}
