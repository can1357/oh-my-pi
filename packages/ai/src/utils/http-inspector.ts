import * as path from "node:path";
import { getLogsDir, isBunTestRuntime } from "@oh-my-pi/pi-utils";
import * as AIError from "../error/flags";
import { formatErrorMessageWithRetryAfter } from "./retry-after.js";

export type RawHttpRequestDump = {
	provider: string;
	api: string;
	model: string;
	method?: string;
	url?: string;
	headers?: Record<string, string>;
	body?: unknown;
};

export type CapturedHttpErrorResponse = {
	status: number;
	headers?: Headers;
	bodyText?: string;
	bodyJson?: unknown;
};

/**
 * Matches any header name whose value carries a credential, so a persisted dump
 * never leaks one. A substring match — not a hand-maintained allow-list — so
 * provider-specific auth headers (`x-goog-api-key`, `x-amz-security-token`, …)
 * are redacted without enumerating every provider's spelling; the fixed list it
 * replaced silently leaked any auth header it did not name. Redacting a benign
 * header that happens to match is harmless: dumps exist to diagnose the request
 * body, not its transport headers.
 */
const SENSITIVE_HEADER_PATTERN = /key|token|secret|auth|credential|cookie/i;

/**
 * Build the JSON persisted for a rejected request. Request fields stay at the
 * top level (so existing dump parsers still read `body`); the provider's error
 * is added under `errorResponse` so a failed request is diagnosable from the
 * dump file rather than the request alone.
 */
export function buildHttp400DumpPayload(
	dump: RawHttpRequestDump,
	error: unknown,
	message: string,
): RawHttpRequestDump & { errorResponse: { status: number | undefined; message: string } } {
	return {
		...sanitizeDump(dump),
		errorResponse: { status: AIError.status(error), message },
	};
}

/** HTTP statuses whose rejected request we persist for post-hoc diagnosis: the
 *  request-content rejections that wedge a session. 400 (bad request) and 413
 *  (payload too large — an oversized image / snapcompact frame payload that 413s
 *  and empties the turn). Auth (401/403), not-found (404), rate limits and 5xx
 *  are excluded: 429/5xx are retried, so persisting them here would write one
 *  dump per attempt. */
export function shouldDumpRejectedRequest(error: unknown): boolean {
	const status = AIError.status(error);
	return status === 400 || status === 413;
}

export async function appendRawHttpRequestDumpFor400(
	message: string,
	error: unknown,
	dump: RawHttpRequestDump | undefined,
): Promise<string> {
	// Never persist dumps under the test runner: providers exercise the 400 path
	if (!dump || isBunTestRuntime() || !shouldDumpRejectedRequest(error)) {
		return message;
	}

	const payload = buildHttp400DumpPayload(dump, error, message);
	const fileName = `${Date.now()}-${Bun.hash(JSON.stringify(payload)).toString(36)}.json`;
	const filePath = path.join(getLogsDir(), "http-400-requests", fileName);

	try {
		await Bun.write(filePath, `${JSON.stringify(payload, null, 2)}\n`);
		return `${message}\nraw-http-request=${filePath}`;
	} catch (writeError) {
		const writeMessage = writeError instanceof Error ? writeError.message : String(writeError);
		return `${message}\nraw-http-request-save-failed=${writeMessage}`;
	}
}

export async function finalizeErrorMessage(
	error: unknown,
	rawRequestDump: RawHttpRequestDump | undefined,
	capturedErrorResponse?: CapturedHttpErrorResponse,
): Promise<string> {
	let message = formatErrorMessageWithRetryAfter(error, capturedErrorResponse?.headers);
	const capturedMessage = formatCapturedHttpError(capturedErrorResponse);
	if (capturedMessage) {
		if (/\bstatus code\s*\(no body\)/i.test(message)) {
			message = `${capturedErrorResponse?.status ?? "HTTP"} status code: ${capturedMessage}`;
		} else if (!message.includes(capturedMessage)) {
			message = `${message}\n${capturedMessage}`;
		}
	}
	return appendRawHttpRequestDumpFor400(message, error, rawRequestDump);
}

/**
 * Rewrite error message for GitHub Copilot request failures.
 * Must run AFTER finalizeErrorMessage since it replaces the message entirely.
 *
 * 401 = token invalid/expired → credential removal is safe, prompt re-login.
 * 403 = token valid but access denied (plan, model policy, org restriction) →
 *       do NOT reuse the auth-failed string (which triggers credential removal).
 * 400 is left verbatim: GitHub's body names the cause (`model_not_supported`,
 *       `model_not_available_for_integrator` with its `Available models` list)
 *       and a rewrite only hides it.
 */
export function rewriteCopilotError(errorMessage: string, error: unknown, provider: string): string {
	if (provider !== "github-copilot") return errorMessage;
	const status = AIError.status(error);
	if (status === 401) {
		return `GitHub Copilot authentication failed (HTTP 401). Your token may have been revoked. Please re-login with /login github-copilot`;
	}
	if (status === 403) {
		return `GitHub Copilot access denied (HTTP 403). Your token is valid but the account may not have access to this model or feature. Check your Copilot plan or model policy settings. Business organizations can also restrict which clients may call the API: omp sends Copilot-Integration-Id copilot-chat by default (COPILOT_INTEGRATION_ID overrides it) and retries a denied default-identity request once as the Copilot CLI (copilot-developer-cli). If both identities are denied, ask your org admin to allow one of them; if you pinned an identity, try the other.`;
	}
	return errorMessage;
}

const CLINE_PASS_NOT_SUBSCRIBED_PATTERN =
	/not subscribed to required model plan|no access to clinepass subscription models/i;
const CLINE_PASS_ORG_ACCOUNT_PATTERN = /organization accounts cannot use individual model inference subscriptions/i;
const CLINE_PASS_MODEL_NOT_FOUND_PATTERN = /model not found/i;

/**
 * Rewrite error messages for ClinePass request failures. Gated to the
 * cline-pass provider: the "model not found" marker is too generic to match
 * for other hosts.
 *
 * not-subscribed (400) = the key is valid but the account has no ClinePass
 *        subscription; free-tier models remain usable on the same key.
 * org restriction (400) = organization accounts cannot use individual
 *        inference subscriptions; a personal-account key is required.
 * model-not-found (400) = roster rotation removed the model since selection;
 *        the fix is reselection, not retry. (Quota windows — "clinepass
 *        limit", "free limit reached on model" — are classified upstream in
 *        error/rate-limit and need no rewrite.)
 * surface-gate (403) = the model is restricted to Cline's official clients.
 *        Requests carry the mirrored CLI identity headers, so reaching this
 *        means Cline's gate policy changed; the classifier exempts it from
 *        credential rotation (sibling keys fail identically).
 */
export function rewriteClinePassError(errorMessage: string, provider: string): string {
	if (provider !== "cline-pass") return errorMessage;
	if (CLINE_PASS_NOT_SUBSCRIBED_PATTERN.test(errorMessage)) {
		return 'This model requires a ClinePass subscription. Free-tier models (marked "(free)" in the picker) work with any Cline account.';
	}
	if (CLINE_PASS_ORG_ACCOUNT_PATTERN.test(errorMessage)) {
		return "ClinePass is unavailable for organization accounts: individual inference subscriptions are personal-plan only. Log in with a personal Cline API key.";
	}
	if (AIError.isClinePassSurfaceGateMessage(errorMessage)) {
		return "Cline restricts this model to its official product surfaces and the mirrored CLI client identity was not accepted. Pick another model with /model and report the regression — the header mirror may need updating.";
	}
	if (CLINE_PASS_MODEL_NOT_FOUND_PATTERN.test(errorMessage)) {
		return "Cline removed this model from the roster since it was selected. Pick another with /model — the roster refreshes automatically while your API key is configured.";
	}
	return errorMessage;
}

function sanitizeDump(dump: RawHttpRequestDump): RawHttpRequestDump {
	return {
		...dump,
		url: redactUrlQuery(dump.url),
		headers: redactHeaders(dump.headers),
	};
}

/**
 * Strips a persisted dump's query string entirely rather than picking sensitive
 * params by name: a configurable `baseUrl` (e.g. Bedrock's gateway routing) can
 * carry an arbitrary query-based credential the way `SENSITIVE_HEADER_PATTERN`
 * matches arbitrary header names, and dumps exist to diagnose the request body,
 * not the query.
 */
function redactUrlQuery(url: string | undefined): string | undefined {
	if (!url) return url;
	try {
		const parsed = new URL(url);
		if (!parsed.search) return url;
		parsed.search = "";
		return `${parsed.toString()}[redacted-query]`;
	} catch {
		return url;
	}
}

function redactHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!headers) {
		return undefined;
	}

	const redacted: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (SENSITIVE_HEADER_PATTERN.test(key)) {
			redacted[key] = "[redacted]";
			continue;
		}
		redacted[key] = value;
	}
	return redacted;
}

function formatCapturedHttpError(captured: CapturedHttpErrorResponse | undefined): string | undefined {
	if (!captured) return undefined;
	const bodyText = captured.bodyText?.trim();
	if (!bodyText) return undefined;
	const payload = parseCapturedErrorPayload(captured);
	if (!payload) return bodyText;

	const errorPayload = getObjectProperty(payload, "error") ?? payload;
	// {"error": "string"} — the error value is a plain string, not a nested object.
	// Fall back to it when the structured fields ("message", etc.) are absent.
	const stringError = errorPayload === payload ? getStringProperty(payload, "error") : undefined;
	const message =
		getStringProperty(errorPayload, "message") ?? getStringProperty(payload, "message") ?? stringError ?? bodyText;
	const extras = [
		getStringProperty(errorPayload, "type") ?? getStringProperty(payload, "type"),
		getStringProperty(errorPayload, "param") ?? getStringProperty(payload, "param"),
		getStringProperty(errorPayload, "code") ?? getStringProperty(payload, "code"),
	]
		.filter(Boolean)
		.map((value, index) => {
			if (index === 0) return `type=${value}`;
			if (index === 1) return `param=${value}`;
			return `code=${value}`;
		});
	return extras.length > 0 ? `${message} (${extras.join(" ")})` : message;
}

function parseCapturedErrorPayload(captured: CapturedHttpErrorResponse): Record<string, unknown> | undefined {
	if (isObject(captured.bodyJson)) {
		return captured.bodyJson;
	}
	if (!captured.bodyText) return undefined;
	try {
		const parsed = JSON.parse(captured.bodyText);
		return isObject(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function getObjectProperty(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
	const property = value[key];
	return isObject(property) ? property : undefined;
}

function getStringProperty(value: Record<string, unknown>, key: string): string | undefined {
	const property = value[key];
	return typeof property === "string" && property.trim().length > 0 ? property : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
