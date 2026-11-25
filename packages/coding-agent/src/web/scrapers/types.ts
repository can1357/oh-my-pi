/**
 * Shared types and utilities for web-fetch handlers
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { scheduler } from "node:timers/promises";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { ptree, untilAborted } from "@oh-my-pi/pi-utils";
import { readBoundedBody } from "@oh-my-pi/pi-utils/bounded-json";
import { decodeEntities } from "@oh-my-pi/pi-utils/dom/parser";
import type TurndownService from "@oh-my-pi/pi-utils/turndown";

import type { ModelRegistry } from "../../config/model-registry";
import { settings as globalSettings, isSettingsInitialized, Settings } from "../../config/settings";
import type { AgentStorageApi } from "../../session/agent-storage";
import { canonicalHost } from "../../sandbox/policy";
import { ToolAbortError } from "../../tools/tool-errors";
import { decodeBody } from "../response-body";

export { formatNumber } from "@oh-my-pi/pi-utils";

export interface RenderResult {
	url: string;
	finalUrl: string;
	contentType: string;
	method: string;
	content: string;
	fetchedAt: string;
	/** True when the response body was cut mid-stream at {@link MAX_BYTES}. */
	truncated: boolean;
	notes: string[];
}

/**
 * Site-specific URL renderer: returns `null` for URLs it does not own.
 * `modelRegistry` is the session's, for handlers that read through a model (X via Grok).
 * `settings` is the session's; direct callers without one resolve via {@link handlerSettings}.
 */
export type SpecialHandler = (
	url: string,
	timeout: number,
	signal?: AbortSignal,
	storage?: AgentStorageApi | null,
	modelRegistry?: ModelRegistry,
	settings?: Settings,
) => Promise<RenderResult | null>;

/**
 * Direct-call fallback for {@link SpecialHandler} implementations that read settings:
 * returns the session's `settings` when supplied, otherwise global settings (if initialized)
 * or isolated defaults.
 */
export function handlerSettings(settings?: Settings): Settings {
	return settings ?? (isSettingsInitialized() ? globalSettings : Settings.isolated());
}

/** Network read bound for a fetched body; the only size limit on rendered URL content. */
export const MAX_BYTES = 50 * 1024 * 1024;

/** User agents a fetch tries in turn while the site refuses the previous one ({@link BLOCKED_STATUSES}). */
export const USER_AGENTS = [
	"curl/8.0",
	"Mozilla/5.0 (compatible; TextBot/1.0)",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
];

/**
 * Statuses sites answer a user agent they refuse with (999 is LinkedIn's), whatever the body
 * says: a bare nginx "403 Forbidden" page, SEC's "Undeclared Automated Tool" page or a 429
 * keyed on the agent all serve the page to the next user agent.
 */
export const BLOCKED_STATUSES = new Set([403, 429, 503, 999]);

/** A challenge interstitial carries no content (Reddit's is about 8 KB); a larger page is no wall. */
const CHALLENGE_PAGE_MAX_CHARS = 64 * 1024;

/**
 * True when a page small enough to be an interstitial holds an `<input name="js_challenge">` field
 * outside `<template>`. Bun's HTMLRewriter tokenizes the page as a browser does, so a form quoted in
 * a comment, script, raw-text element or attribute is no field. A field gets an attribute named with
 * a fresh nonce, which the page cannot already carry; a tag cut off by the end of the page is
 * written back as text, so its mark never reaches the output.
 */
function hasChallengeForm(html: string): boolean {
	if (html.length > CHALLENGE_PAGE_MAX_CHARS) return false;
	const mark = `data-omp-challenge-${crypto.randomUUID()}`;
	const output = new HTMLRewriter()
		.on("input[name]", {
			element(input) {
				if (decodeEntities(input.getAttribute("name") ?? "") === "js_challenge") input.setAttribute(mark, "");
			},
		})
		.on("template input[name]", {
			element(input) {
				input.removeAttribute(mark);
			},
		})
		.transform(html);
	return output.includes(mark);
}

/**
 * Name the bot protection whose challenge or block page an HTML response is. A 2xx page counts
 * only from Cloudflare's header or a live challenge form, since an article can quote any marker
 * as text; vendor markers in the body count on an error status.
 */
function botWallOf(response: Response, contentType: string, content: string): string | undefined {
	if (!contentType.includes("html")) return undefined;
	if (response.headers.get("cf-mitigated") === "challenge") return "Cloudflare";
	if (hasChallengeForm(content)) return "JavaScript challenge";
	if (response.ok) return undefined;
	if (content.includes("_cf_chl_opt")) return "Cloudflare";
	if (content.includes("captcha-delivery.com")) return "DataDome";
	if (content.includes("px-captcha")) return "PerimeterX";
	if (content.includes("blocked by network security")) return "network security block";
	return undefined;
}

/**
 * Collapse blank-line runs and trim. Never shortens content: URL reads page the preview
 * themselves, and selectors, artifacts, and URL search must see the whole body.
 */
export function finalizeOutput(content: string): string {
	return content.replace(/\n{3,}/g, "\n\n").trim();
}

export interface LoadPageOptions {
	timeout?: number;
	headers?: Record<string, string>;
	method?: string;
	body?: string;
	maxBytes?: number;
	signal?: AbortSignal;
	/**
	 * Return true to skip reading the response body for this content type
	 * (lowercased mime, no params). The caller is expected to re-fetch the
	 * payload as binary; this avoids streaming + decoding huge binaries twice.
	 */
	skipBodyForContentType?: (contentType: string) => boolean;
}

export interface LoadPageResult {
	content: string;
	contentType: string;
	finalUrl: string;
	ok: boolean;
	status?: number;
	/** True when the body was cut mid-stream at maxBytes. */
	truncated?: boolean;
	/** Last transport-level error message when ok is false. */
	error?: string;
	/** True when the body read was skipped via skipBodyForContentType. */
	bodySkipped?: boolean;
	/**
	 * Bot protection that answered with its challenge or block page instead of the page. Such a
	 * response is never `ok`, whatever its status, so a caller checking `ok` does not take it as content.
	 */
	blockedBy?: string;
}

/**
 * Asked about each host a request in its scope is about to contact, in {@link canonicalHost} form
 * (punycode, lowercase, no port, no IPv6 brackets); throws to refuse the host, or a {@link HostUndecided}
 * when it could not decide.
 */
export type RequestHostGuard = (host: string) => Promise<void> | void;

/** The guard's verdict on a host: `undefined` admits, `{ denial }` refuses, `{ failure }` could not decide. */
type HostVerdict = { denial: unknown } | { failure: Error } | undefined;

interface RequestHostScope {
	readonly guard: RequestHostGuard;
	/** The guard's verdict per host, asked once; a `failure` is dropped, so the next request asks again. */
	readonly decisions: Map<string, Promise<HostVerdict>>;
	/** Notes on what the scope skipped: refused optional requests and host-side tools that fetch on their own. */
	readonly skipped: string[];
	/** Inside {@link primaryRequest}: a refused host fails the read instead of being skipped. */
	readonly primary: boolean;
}

const requestHostScopes = new AsyncLocalStorage<RequestHostScope>();

/**
 * Runs `run` with `guard` asked about every host the requests inside it contact through {@link loadPage},
 * `fetchBinary`, {@link fetchWithHostGuard} and {@link guardedFetch}: the first request's host and each redirect's,
 * the call's own hosts included. A refused host fails a {@link primaryRequest} and skips any other request,
 * with a note in `skipped`. Without a guard, `run` runs as is.
 */
export async function withRequestHostGuard<T>(
	guard: RequestHostGuard | undefined,
	run: () => Promise<T>,
): Promise<{ result: T; skipped: string[] }> {
	if (!guard) return { result: await run(), skipped: [] };
	const scope: RequestHostScope = { guard, decisions: new Map(), skipped: [], primary: false };
	return { result: await requestHostScopes.run(scope, run), skipped: scope.skipped };
}

/** Runs `run` as the read's primary chain: a host the guard refuses there fails the read with its denial. */
export function primaryRequest<T>(run: () => Promise<T>): Promise<T> {
	const scope = requestHostScopes.getStore();
	return scope ? requestHostScopes.run({ ...scope, primary: true }, run) : run();
}

/**
 * True while a guard is in scope, with a note that `name` was skipped: a host-side tool that fetches on its
 * own (trafilatura, lynx) would contact hosts the guard never sees, so it does not run.
 */
export function hostProcessSkipped(name: string): boolean {
	const scope = requestHostScopes.getStore();
	if (!scope) return false;
	addSkippedNote(scope, `Skipped ${name}: it fetches outside the sandbox's network policy`);
	return true;
}

function addSkippedNote(scope: RequestHostScope, note: string): void {
	if (!scope.skipped.includes(note)) scope.skipped.push(note);
}

/** A request to a host the guard refused, never sent. {@link rethrowOnPrimary} turns it into the read's failure. */
export class HostRefusal extends Error {
	constructor(
		readonly host: string,
		readonly denial: unknown,
	) {
		super(`${host} is not allowed by the sandbox's network policy`);
		this.name = "HostRefusal";
	}
}

/**
 * Thrown by a {@link RequestHostGuard} that could not decide a host (its name did not resolve, the read was
 * cancelled): not a refusal. The request fails with `failure` as a transport error does, unrecorded, and the
 * next request to the host asks again.
 */
export class HostUndecided extends Error {
	constructor(readonly failure: Error) {
		super(failure.message, { cause: failure });
		this.name = "HostUndecided";
	}
}

/** Throws the guard's denial when `refusal` happened on the primary chain; an optional request just failed. */
export function rethrowOnPrimary(refusal: HostRefusal): void {
	if (requestHostScopes.getStore()?.primary) throw refusal.denial;
}

/** The host of `url` as the sandbox compares hosts; `undefined` for a URL that does not parse. */
export function requestHost(url: string | URL): string | undefined {
	try {
		return canonicalHost(new URL(url).hostname);
	} catch {
		return undefined;
	}
}

/**
 * Waits for the guard's verdict on the host of `url`, shared by every request to it, at most until `signal`
 * (the request's own limit) aborts: the request then fails as a transport error, and the shared decision
 * runs on within the read's limit.
 */
async function admitHost(scope: RequestHostScope, url: URL, signal?: AbortSignal | null): Promise<void> {
	const host = requestHost(url) ?? url.hostname;
	let decision = scope.decisions.get(host);
	if (!decision) {
		decision = (async (): Promise<HostVerdict> => {
			try {
				await scope.guard(host);
				return undefined;
			} catch (error) {
				return error instanceof HostUndecided ? { failure: error.failure } : { denial: error };
			}
		})();
		scope.decisions.set(host, decision);
		// A failure is not cached: it is dropped when it settles, even when every request gave up waiting.
		const settled = decision;
		void settled.then(verdict => {
			if (verdict && "failure" in verdict && scope.decisions.get(host) === settled) scope.decisions.delete(host);
		});
	}
	// The decision never rejects: a rejection is `signal` aborting.
	const verdict = await untilAborted(signal, decision).catch((error: unknown) => {
		throw new Error(`checking ${host} timed out`, { cause: error });
	});
	if (!verdict) return;
	if ("failure" in verdict) throw verdict.failure;
	if (!scope.primary)
		addSkippedNote(scope, `Skipped requests to ${host}: not allowed by the sandbox's network policy`);
	throw new HostRefusal(host, verdict.denial);
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Redirects `fetch` follows before it gives up. */
const MAX_REDIRECTS = 20;
const CROSS_ORIGIN_STRIPPED_HEADERS = ["authorization", "cookie", "proxy-authorization"];

/**
 * `fetchImpl(url, init)` with the guard of the surrounding {@link withRequestHostGuard} asked about the host of
 * the request and of each redirect before it is contacted. With no guard in scope this is a plain fetch,
 * redirects followed by the runtime. With one, redirects are followed here with `fetch`'s own rules (a 301/302
 * POST and a 303 become a GET without body, a cross-origin hop drops credentials, 20 hops at most), and a
 * refused host rejects with a {@link HostRefusal}.
 */
export async function fetchWithHostGuard(
	url: string,
	init: RequestInit,
	fetchImpl: FetchImpl = fetch,
): Promise<{ response: Response; finalUrl: string }> {
	const scope = requestHostScopes.getStore();
	if (!scope) {
		const response = await fetchImpl(url, init);
		return { response, finalUrl: response.url };
	}
	let current = new URL(url);
	await admitHost(scope, current, init.signal);
	if (init.redirect === "manual" || init.redirect === "error") {
		return { response: await fetchImpl(current.href, init), finalUrl: current.href };
	}
	let method = init.method;
	let body = init.body;
	let headers = new Headers(init.headers);
	for (let hops = 0; ; hops++) {
		const response = await fetchImpl(current.href, { ...init, method, body, headers, redirect: "manual" });
		const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get("location") : null;
		if (location === null) return { response, finalUrl: current.href };
		void response.body?.cancel().catch(() => {});
		if (hops >= MAX_REDIRECTS) throw new TypeError("Too many redirects");
		const next = new URL(location, current);
		if (next.protocol !== "http:" && next.protocol !== "https:") {
			throw new TypeError(`Redirect to a ${next.protocol} URL is not followed`);
		}
		await admitHost(scope, next, init.signal);
		const verb = (method ?? "GET").toUpperCase();
		if (
			((response.status === 301 || response.status === 302) && verb === "POST") ||
			(response.status === 303 && verb !== "GET" && verb !== "HEAD")
		) {
			method = "GET";
			body = undefined;
			headers = new Headers(headers);
			headers.delete("content-type");
		}
		if (next.origin !== current.origin) {
			headers = new Headers(headers);
			for (const name of CROSS_ORIGIN_STRIPPED_HEADERS) headers.delete(name);
		}
		current = next;
	}
}

/** `fetchImpl` whose requests inside a {@link withRequestHostGuard} scope go through {@link fetchWithHostGuard}. */
export function guardedFetch(fetchImpl: FetchImpl = fetch): FetchImpl {
	return async (input, init) => {
		if (!requestHostScopes.getStore()) return fetchImpl(input, init);
		if (!(input instanceof Request)) return (await fetchWithHostGuard(String(input), init ?? {}, fetchImpl)).response;
		const requestInit: RequestInit = {
			method: input.method,
			headers: input.headers,
			body: input.body,
			signal: input.signal,
			redirect: input.redirect,
			...init,
		};
		return (await fetchWithHostGuard(input.url, requestInit, fetchImpl)).response;
	};
}

const RETRY_AFTER_MAX_MS = 10_000;

/** Parse a Retry-After header (seconds or HTTP-date) into a bounded delay. */
function parseRetryAfterMs(value: string | null): number {
	if (!value) return 1_000;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return Math.min(Math.max(seconds, 0) * 1000, RETRY_AFTER_MAX_MS);
	const date = Date.parse(value);
	if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), RETRY_AFTER_MAX_MS);
	return 1_000;
}

/**
 * Fetch a page with timeout and size limit
 */
export async function loadPage(url: string, options: LoadPageOptions = {}): Promise<LoadPageResult> {
	const { timeout = 20, headers = {}, maxBytes = MAX_BYTES, signal, method = "GET", body } = options;

	let lastError: string | undefined;
	let lastBlockedResponse: LoadPageResult | undefined;
	let retried429 = false;
	// Header names are case-insensitive, so a caller's header replaces ours whatever its spelling.
	const callerHeaders = new Headers(headers);
	// A caller's own User-Agent replaces every rotated one, so a refusal of it is final; a
	// transport error still retries.
	const rotates = !callerHeaders.has("user-agent");
	for (let attempt = 0; attempt < USER_AGENTS.length; attempt++) {
		if (signal?.aborted) {
			throw new ToolAbortError();
		}

		const userAgent = USER_AGENTS[attempt];
		const requestSignal = ptree.combineSignals(signal, timeout * 1000);

		try {
			const requestHeaders = new Headers({
				"User-Agent": userAgent,
				Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.5",
				"Accept-Encoding": "identity", // Cloudflare Markdown-for-Agents returns corrupted bytes when compression is negotiated
			});
			for (const [name, value] of callerHeaders) requestHeaders.set(name, value);
			const requestInit: RequestInit = {
				signal: requestSignal,
				method,
				headers: requestHeaders,
				redirect: "follow",
			};

			if (body !== undefined) {
				requestInit.body = body;
			}

			const { response, finalUrl } = await fetchWithHostGuard(url, requestInit);

			const rawContentType = response.headers.get("content-type") ?? "";
			const contentType = rawContentType.split(";")[0]?.trim().toLowerCase() ?? "";

			const lastAgent = !rotates || attempt === USER_AGENTS.length - 1;
			if (!lastAgent && BLOCKED_STATUSES.has(response.status)) {
				void response.body?.cancel().catch(() => {});
				// A refusal whose header names its wall is kept in case later agents fare no better; its
				// body is not read, so rotation costs what it did. A 2xx challenge kept later wins.
				const headerWall = lastBlockedResponse ? undefined : botWallOf(response, contentType, "");
				if (headerWall) {
					lastBlockedResponse = {
						content: "",
						contentType,
						finalUrl,
						ok: false,
						status: response.status,
						blockedBy: headerWall,
					};
				}
				continue;
			}

			if (response.status === 429 && !retried429) {
				// Rate limited under the last user agent: retry it once, honoring a bounded
				// Retry-After. The wait observes the caller's signal so an Esc during the backoff
				// does not stall for up to the full delay.
				retried429 = true;
				const delayMs = parseRetryAfterMs(response.headers.get("retry-after"));
				void response.body?.cancel().catch(() => {});
				try {
					await scheduler.wait(delayMs, { signal });
				} catch {
					throw new ToolAbortError();
				}
				attempt--; // Reuse the same user agent for the retry.
				continue;
			}

			if (response.ok && options.skipBodyForContentType?.(contentType)) {
				void response.body?.cancel().catch(() => {});
				return { content: "", contentType, finalUrl, ok: true, status: response.status, bodySkipped: true };
			}

			const responseBody = await readBoundedBody(response, maxBytes);
			if (!responseBody) {
				// Once a wall is known, an error under another agent only means trying the next one.
				if (!response.ok && lastBlockedResponse) {
					if (!lastAgent) continue;
					return lastBlockedResponse;
				}
				// A successful response can still be bodyless (HTTP 204, or a null
				// body stream): keep the transport's own success verdict instead of
				// rewriting it, so the caller's status handling (a 204 is a valid
				// empty read, not a failed fetch) runs on the real outcome.
				return { content: "", contentType, finalUrl, ok: response.ok, status: response.status };
			}

			const content = decodeBody(responseBody.bytes, rawContentType);
			const blockedBy = botWallOf(response, contentType, content);
			const result: LoadPageResult = {
				content,
				contentType,
				finalUrl,
				ok: response.ok && !blockedBy,
				status: response.status,
				truncated: responseBody.truncated,
				blockedBy,
			};
			if (blockedBy && !lastAgent) {
				// A 2xx challenge outranks a refusal's wall: remote readers can still get past it.
				if (!lastBlockedResponse || response.ok) lastBlockedResponse = result;
				continue;
			}
			// The last agent's error yields to a saved wall, unless both are walls and the saved one is a refusal.
			if (!response.ok && lastBlockedResponse && (!blockedBy || (lastBlockedResponse.status ?? 0) < 300)) {
				if (!lastAgent) continue;
				return lastBlockedResponse;
			}
			return result;
		} catch (error) {
			if (error instanceof HostRefusal) {
				rethrowOnPrimary(error);
				return { content: "", contentType: "", finalUrl: url, ok: false, error: error.message };
			}
			if (signal?.aborted) {
				throw new ToolAbortError();
			}
			lastError = error instanceof Error ? error.message : String(error);
			if (attempt === USER_AGENTS.length - 1) {
				return lastBlockedResponse ?? { content: "", contentType: "", finalUrl: url, ok: false, error: lastError };
			}
		}
	}

	return { content: "", contentType: "", finalUrl: url, ok: false, error: lastError };
}

/** Module-level Turndown instance — built lazily on first use. */
let turndownPromise: Promise<TurndownService> | undefined;

function getTurndown(): Promise<TurndownService> {
	turndownPromise ||= initTurndown();
	return turndownPromise;
}

async function initTurndown(): Promise<TurndownService> {
	// Lazy import keeps turndown/turndown-plugin-gfm off the startup graph.
	const { createTurndown } = await import("../../utils/turndown");
	return createTurndown();
}

/**
 * Convert HTML to markdown using Turndown with GFM support.
 * Strips script/style tags before conversion.
 */
export async function htmlToBasicMarkdown(html: string): Promise<string> {
	const cleaned = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
	const turndown = await getTurndown();
	return turndown.turndown(cleaned).trim();
}

/**
 * Build a RenderResult from markdown content. Calls finalizeOutput internally.
 */
export function buildResult(
	md: string,
	opts: {
		url: string;
		finalUrl?: string;
		method: string;
		fetchedAt: string;
		notes?: string[];
		contentType?: string;
		/** Pass the source `LoadPageResult.truncated` when `md` embeds a fetched body verbatim. */
		truncated?: boolean;
	},
): RenderResult {
	return {
		url: opts.url,
		finalUrl: opts.finalUrl ?? opts.url,
		contentType: opts.contentType ?? "text/markdown",
		method: opts.method,
		content: finalizeOutput(md),
		fetchedAt: opts.fetchedAt,
		truncated: opts.truncated ?? false,
		notes: opts.notes ?? [],
	};
}

/**
 * Format a date value as YYYY-MM-DD. Returns empty string on invalid input.
 */
export function formatIsoDate(value?: string | number | Date): string {
	if (value == null) return "";
	if (typeof value === "string") {
		const datePrefix = value.match(/^\d{4}-\d{2}-\d{2}/);
		if (datePrefix) return datePrefix[0];
	}
	try {
		return new Date(value).toISOString().split("T")[0];
	} catch {
		return "";
	}
}

/**
 * Decode common HTML entities.
 */
export function decodeHtmlEntities(text: string): string {
	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#0?39;/g, "'")
		.replace(/&#x27;/g, "'")
		.replace(/&#x2F;/g, "/")
		.replace(/&nbsp;/g, " ");
}

/**
 * Format seconds into HH:MM:SS or MM:SS.
 */
export function formatMediaDuration(totalSeconds: number): string {
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const secs = Math.floor(totalSeconds % 60);
	if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
	return `${minutes}:${String(secs).padStart(2, "0")}`;
}

/**
 * Extract localized text, preferring en-US/en.
 */
export type LocalizedText = string | Record<string, string | null> | null | undefined;

export function getLocalizedText(value: LocalizedText, defaultLocale?: string): string | undefined {
	if (value == null) return undefined;
	if (typeof value === "string") return value;
	if (defaultLocale && value[defaultLocale]) return value[defaultLocale];
	return (
		value["en-US"] ?? value.en_US ?? value.en ?? Object.values(value).find(v => typeof v === "string") ?? undefined
	);
}

/**
 * Check if content looks like HTML by inspecting the leading tag.
 */
export function looksLikeHtml(content: string): boolean {
	// Only the leading tag matters; lowercase a short prefix instead of the whole body.
	const trimmed = content.trimStart().slice(0, 16).toLowerCase();
	return (
		trimmed.startsWith("<!doctype") ||
		trimmed.startsWith("<html") ||
		trimmed.startsWith("<head") ||
		trimmed.startsWith("<body")
	);
}
