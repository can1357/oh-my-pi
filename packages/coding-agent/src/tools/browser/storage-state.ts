import * as os from "node:os";
import * as path from "node:path";

import { isRecord, untilAborted } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { Cookie, CookieParam, Page } from "puppeteer-core";
import { resolveToCwd } from "../path-utils";
import { throwIfAborted } from "../tool-errors";

/** Web Storage area exposed by the browser helpers. */
export type StorageKind = "local" | "session";

/** Cookie fields returned by tab.cookies() and persisted in storage state files. */
export interface BrowserCookie {
	/** Cookie name. */
	name: string;
	/** Cookie value. */
	value: string;
	/** Cookie domain. */
	domain: string;
	/** Cookie path. */
	path: string;
	/** Expiration time in Unix seconds, or -1 for a session cookie. */
	expires: number;
	/** Whether JavaScript is denied access to the cookie. */
	httpOnly: boolean;
	/** Whether the cookie is limited to secure transports. */
	secure: boolean;
	/** Effective SameSite policy. */
	sameSite: "Strict" | "Lax" | "None";
}

/** Cookie accepted by tab.setCookies(). */
export interface BrowserCookieInput {
	/** Cookie name. */
	name: string;
	/** Cookie value. */
	value: string;
	/** Cookie domain override. */
	domain?: string;
	/** Cookie path override. */
	path?: string;
	/** URL used to infer domain, path, and scheme. */
	url?: string;
	/** Expiration time in Unix seconds. */
	expires?: number;
	/** Deny JavaScript access to the cookie. */
	httpOnly?: boolean;
	/** Limit the cookie to secure transports. */
	secure?: boolean;
	/** Cookie SameSite policy. */
	sameSite?: "Strict" | "Lax" | "None";
}

/** Default domain or URL applied to imported cookie header entries. */
export interface CookieScope {
	/** Default domain for imported cookie pairs. */
	domain?: string;
	/** Default URL for imported cookie pairs. */
	url?: string;
}

/** Cookie lookup options. */
export interface CookieQueryOptions {
	/** URLs whose matching cookies should be returned. */
	urls?: string[];
}

/** Cookie deletion options. */
export interface ClearCookiesOptions {
	/** Cookie names to delete; omission deletes every current-page cookie. */
	names?: string[];
}

/** One origin's Web Storage entries in an omp storage state file. */
export interface StorageStateOrigin {
	/** Serialized origin. */
	origin: string;
	/** Local Storage pairs for the origin. */
	localStorage: Array<{ name: string; value: string }>;
	/** Session Storage pairs for the origin. */
	sessionStorage?: Array<{ name: string; value: string }>;
}

/** Playwright-compatible browser state with sessionStorage as an omp extension. */
export interface BrowserStorageState {
	/** Serialized browser cookies. */
	cookies: BrowserCookie[];
	/** Serialized per-origin Web Storage. */
	origins: StorageStateOrigin[];
}

/** Summary of origins restored or skipped by tab.loadState(). */
export interface LoadStateResult {
	/** Origins whose Web Storage was restored. */
	loadedOrigins: string[];
	/** Origins skipped because safe hidden navigation was unavailable or failed. */
	skippedOrigins: string[];
}

interface LoadStateOptions {
	allowOtherOrigins: boolean;
	navigationTimeoutMs: number;
	signal?: AbortSignal;
}

interface BrowserStorageArea {
	readonly length: number;
	key(index: number): string | null;
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	clear(): void;
}

const COOKIE_PARSE_ERROR = "tab.setCookies() received malformed cookie input";
const COOKIE_SET_ERROR = "tab.setCookies() could not set the supplied cookies";
const STORAGE_STATE_ERROR = "tab.loadState() received an invalid browser state file";
const COOKIE_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function cookieView(cookie: Cookie): BrowserCookie {
	return {
		name: cookie.name,
		value: cookie.value,
		domain: cookie.domain,
		path: cookie.path,
		expires: cookie.expires,
		httpOnly: cookie.httpOnly ?? false,
		secure: cookie.secure,
		sameSite:
			cookie.sameSite === "Strict" || cookie.sameSite === "Lax" || cookie.sameSite === "None"
				? cookie.sameSite
				: "Lax",
	};
}

function isScope(value: unknown): value is CookieScope {
	if (!isRecord(value) || "name" in value || "value" in value) return false;
	return Object.keys(value).every(key => key === "domain" || key === "url");
}

function parseCookieObject(value: unknown): BrowserCookieInput {
	if (!isRecord(value) || typeof value.name !== "string" || typeof value.value !== "string") {
		throw new ToolError(COOKIE_PARSE_ERROR);
	}
	if (!COOKIE_NAME_RE.test(value.name)) throw new ToolError(COOKIE_PARSE_ERROR);
	const cookie: BrowserCookieInput = { name: value.name, value: value.value };
	for (const key of ["domain", "path", "url"] as const) {
		const field = value[key];
		if (field !== undefined && typeof field !== "string") throw new ToolError(COOKIE_PARSE_ERROR);
		if (field !== undefined) cookie[key] = field;
	}
	for (const key of ["httpOnly", "secure"] as const) {
		const field = value[key];
		if (field !== undefined && typeof field !== "boolean") throw new ToolError(COOKIE_PARSE_ERROR);
		if (field !== undefined) cookie[key] = field;
	}
	if (value.expires !== undefined) {
		if (typeof value.expires !== "number" || !Number.isFinite(value.expires)) throw new ToolError(COOKIE_PARSE_ERROR);
		cookie.expires = value.expires;
	}
	if (value.sameSite !== undefined) {
		if (value.sameSite !== "Strict" && value.sameSite !== "Lax" && value.sameSite !== "None") {
			throw new ToolError(COOKIE_PARSE_ERROR);
		}
		cookie.sameSite = value.sameSite;
	}
	return cookie;
}

function parseCookieHeader(header: string): BrowserCookieInput[] {
	const parts = header.split(";");
	if (parts.length === 0) throw new ToolError(COOKIE_PARSE_ERROR);
	const cookies: BrowserCookieInput[] = [];
	for (const part of parts) {
		const separator = part.indexOf("=");
		if (separator <= 0) throw new ToolError(COOKIE_PARSE_ERROR);
		const name = part.slice(0, separator).trim();
		const value = part.slice(separator + 1).trim();
		if (!COOKIE_NAME_RE.test(name)) throw new ToolError(COOKIE_PARSE_ERROR);
		cookies.push({ name, value });
	}
	return cookies;
}

function extractCurlCookieHeaders(source: string): string[] {
	const headers: string[] = [];
	const pattern = /(?:^|\s)(?:-H|--header)\s+(?:'([^']*)'|"([^"]*)"|([^\s]+))/gi;
	for (const match of source.matchAll(pattern)) {
		const header = match[1] ?? match[2] ?? match[3] ?? "";
		const separator = header.indexOf(":");
		if (separator < 0 || header.slice(0, separator).trim().toLowerCase() !== "cookie") continue;
		headers.push(header.slice(separator + 1).trim());
	}
	return headers;
}

function parseCookieString(source: string): BrowserCookieInput[] {
	const trimmed = source.trim();
	if (!trimmed) throw new ToolError(COOKIE_PARSE_ERROR);
	if (trimmed.startsWith("[")) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			throw new ToolError(COOKIE_PARSE_ERROR);
		}
		if (!Array.isArray(parsed) || parsed.length === 0) throw new ToolError(COOKIE_PARSE_ERROR);
		return parsed.map(parseCookieObject);
	}
	const curlHeaders = extractCurlCookieHeaders(trimmed);
	if (curlHeaders.length > 0) return curlHeaders.flatMap(parseCookieHeader);
	return parseCookieHeader(trimmed.replace(/^cookie\s*:\s*/i, ""));
}

function normalizeCookieArguments(args: unknown[]): CookieParam[] {
	if (args.length === 0) throw new ToolError(COOKIE_PARSE_ERROR);
	const items = [...args];
	const trailing = items.at(-1);
	const scope = isScope(trailing) ? (items.pop() as CookieScope) : undefined;
	if (items.length === 0) throw new ToolError(COOKIE_PARSE_ERROR);
	const parsed = items.flatMap(item =>
		typeof item === "string" ? parseCookieString(item) : [parseCookieObject(item)],
	);
	return parsed.map(cookie => ({ ...scope, ...cookie }));
}

function storageValue(value: unknown): string {
	if (typeof value === "string") return value;
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(value);
	} catch {
		throw new ToolError("tab.setStorage() could not serialize a supplied value");
	}
	if (serialized === undefined) throw new ToolError("tab.setStorage() could not serialize a supplied value");
	return serialized;
}

function storageEntries(value: unknown): Array<[string, string]> {
	if (!isRecord(value)) throw new ToolError("tab.setStorage() expects a key/value object");
	const entries: Array<[string, string]> = [];
	for (const key in value) {
		if (Object.hasOwn(value, key)) entries.push([key, storageValue(value[key])]);
	}
	return entries;
}

function assertStorageKind(kind: string): asserts kind is StorageKind {
	if (kind !== "local" && kind !== "session") {
		throw new ToolError('Storage kind must be "local" or "session"');
	}
}

async function readOriginStorage(page: Page, signal?: AbortSignal): Promise<StorageStateOrigin | null> {
	return await untilAborted(signal, () =>
		page.evaluate(() => {
			const scope = globalThis as unknown as {
				location: { origin: string };
				localStorage: BrowserStorageArea;
				sessionStorage: BrowserStorageArea;
			};
			if (scope.location.origin === "null") return null;
			const entries = (store: BrowserStorageArea): Array<{ name: string; value: string }> => {
				const result: Array<{ name: string; value: string }> = [];
				for (let index = 0; index < store.length; index++) {
					const name = store.key(index);
					if (name !== null) result.push({ name, value: store.getItem(name) ?? "" });
				}
				return result;
			};
			return {
				origin: scope.location.origin,
				localStorage: entries(scope.localStorage),
				sessionStorage: entries(scope.sessionStorage),
			};
		}),
	);
}

async function restoreOriginStorage(page: Page, origin: StorageStateOrigin, signal?: AbortSignal): Promise<void> {
	await untilAborted(signal, () =>
		page.evaluate(state => {
			const scope = globalThis as unknown as {
				localStorage: BrowserStorageArea;
				sessionStorage: BrowserStorageArea;
			};
			scope.localStorage.clear();
			for (const entry of state.localStorage) scope.localStorage.setItem(entry.name, entry.value);
			scope.sessionStorage.clear();
			for (const entry of state.sessionStorage ?? []) scope.sessionStorage.setItem(entry.name, entry.value);
		}, origin),
	);
}

function parseStorageEntries(value: unknown): Array<{ name: string; value: string }> {
	if (!Array.isArray(value)) throw new ToolError(STORAGE_STATE_ERROR);
	return value.map(entry => {
		if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.value !== "string") {
			throw new ToolError(STORAGE_STATE_ERROR);
		}
		return { name: entry.name, value: entry.value };
	});
}

function parseStorageState(value: unknown): BrowserStorageState {
	if (!isRecord(value) || !Array.isArray(value.cookies) || !Array.isArray(value.origins)) {
		throw new ToolError(STORAGE_STATE_ERROR);
	}
	const cookies = value.cookies.map(cookie => {
		const parsed = parseCookieObject(cookie);
		if (!parsed.domain || !parsed.path || parsed.expires === undefined) throw new ToolError(STORAGE_STATE_ERROR);
		return {
			...parsed,
			domain: parsed.domain,
			path: parsed.path,
			expires: parsed.expires,
			httpOnly: parsed.httpOnly ?? false,
			secure: parsed.secure ?? false,
			sameSite: parsed.sameSite ?? "Lax",
		};
	});
	const origins = value.origins.map(entry => {
		if (!isRecord(entry) || typeof entry.origin !== "string") throw new ToolError(STORAGE_STATE_ERROR);
		try {
			const url = new URL(entry.origin);
			if (url.origin !== entry.origin) throw new ToolError(STORAGE_STATE_ERROR);
		} catch {
			throw new ToolError(STORAGE_STATE_ERROR);
		}
		return {
			origin: entry.origin,
			localStorage: parseStorageEntries(entry.localStorage),
			...(entry.sessionStorage === undefined ? {} : { sessionStorage: parseStorageEntries(entry.sessionStorage) }),
		};
	});
	return { cookies, origins };
}

/** Read cookies visible to the current page or the supplied URLs. */
export async function readCookies(
	page: Page,
	options: CookieQueryOptions = {},
	signal?: AbortSignal,
): Promise<BrowserCookie[]> {
	if (!Array.isArray(options.urls) && options.urls !== undefined) {
		throw new ToolError("tab.cookies() expects urls to be an array");
	}
	const cookies = await untilAborted(signal, () => page.cookies(...(options.urls ?? [])));
	return cookies.map(cookieView);
}

/** Parse and install cookie objects, raw Cookie headers, cURL dumps, or JSON arrays. */
export async function setPageCookies(page: Page, args: unknown[], signal?: AbortSignal): Promise<void> {
	let cookies: CookieParam[];
	try {
		cookies = normalizeCookieArguments(args);
	} catch (error) {
		if (error instanceof ToolError) throw error;
		throw new ToolError(COOKIE_PARSE_ERROR);
	}
	try {
		await untilAborted(signal, () => page.setCookie(...cookies));
	} catch {
		throwIfAborted(signal);
		throw new ToolError(COOKIE_SET_ERROR);
	}
}

/** Delete all current-page cookies or only cookies with selected names. */
export async function clearPageCookies(
	page: Page,
	options: ClearCookiesOptions = {},
	signal?: AbortSignal,
): Promise<void> {
	if (!Array.isArray(options.names) && options.names !== undefined) {
		throw new ToolError("tab.clearCookies() expects names to be an array");
	}
	const wanted = options.names ? new Set(options.names) : undefined;
	const cookies = await untilAborted(signal, () => page.cookies());
	const matching = cookies.filter(cookie => !wanted || wanted.has(cookie.name));
	if (matching.length === 0) return;
	await untilAborted(signal, () =>
		page.deleteCookie(...matching.map(cookie => ({ name: cookie.name, domain: cookie.domain, path: cookie.path }))),
	);
}

/** Read all Web Storage pairs or one selected value from the current origin. */
export async function readStorage(
	page: Page,
	kind: string,
	options: { key?: string } = {},
	signal?: AbortSignal,
): Promise<Record<string, string> | string | null> {
	assertStorageKind(kind);
	if (options.key !== undefined && typeof options.key !== "string") {
		throw new ToolError("tab.storage() expects key to be a string");
	}
	return await untilAborted(signal, () =>
		page.evaluate(
			(area, key) => {
				const scope = globalThis as unknown as {
					localStorage: BrowserStorageArea;
					sessionStorage: BrowserStorageArea;
				};
				const store = area === "local" ? scope.localStorage : scope.sessionStorage;
				if (key !== undefined) return store.getItem(key);
				const result: Record<string, string> = {};
				for (let index = 0; index < store.length; index++) {
					const name = store.key(index);
					if (name !== null) result[name] = store.getItem(name) ?? "";
				}
				return result;
			},
			kind,
			options.key,
		),
	);
}

/** Set one Web Storage pair or a map of pairs on the current origin. */
export async function setPageStorage(
	page: Page,
	kind: string,
	keyOrEntries: unknown,
	value: unknown,
	signal?: AbortSignal,
): Promise<void> {
	assertStorageKind(kind);
	const entries =
		typeof keyOrEntries === "string"
			? ([[keyOrEntries, storageValue(value)]] as Array<[string, string]>)
			: storageEntries(keyOrEntries);
	await untilAborted(signal, () =>
		page.evaluate(
			(area, pairs) => {
				const scope = globalThis as unknown as {
					localStorage: BrowserStorageArea;
					sessionStorage: BrowserStorageArea;
				};
				const store = area === "local" ? scope.localStorage : scope.sessionStorage;
				for (const [key, entry] of pairs) store.setItem(key, entry);
			},
			kind,
			entries,
		),
	);
}

/** Clear one Web Storage area on the current origin. */
export async function clearPageStorage(page: Page, kind: string, signal?: AbortSignal): Promise<void> {
	assertStorageKind(kind);
	await untilAborted(signal, () =>
		page.evaluate(area => {
			const scope = globalThis as unknown as {
				localStorage: BrowserStorageArea;
				sessionStorage: BrowserStorageArea;
			};
			(area === "local" ? scope.localStorage : scope.sessionStorage).clear();
		}, kind),
	);
}

/** Save cookies and current-origin Web Storage to a Playwright-compatible state file. */
export async function saveStorageState(
	page: Page,
	name: string,
	requestedPath: string | undefined,
	cwd: string,
	signal?: AbortSignal,
): Promise<string> {
	const safeName = name.replace(/[^A-Za-z0-9._-]/g, "_");
	const fileName = safeName === "." || safeName === ".." ? "_" : safeName || "main";
	const destination = requestedPath
		? resolveToCwd(requestedPath, cwd)
		: path.join(os.homedir(), ".omp", "browser-state", `${fileName}.json`);
	const [browserCookies, origin] = await Promise.all([
		untilAborted(signal, () => page.browserContext().cookies()),
		readOriginStorage(page, signal),
	]);
	const state: BrowserStorageState = { cookies: browserCookies.map(cookieView), origins: origin ? [origin] : [] };
	await untilAborted(signal, () => Bun.write(destination, `${JSON.stringify(state, null, 2)}\n`));
	return destination;
}

/** Restore cookies and Web Storage from a saved browser state file. */
export async function loadStorageState(
	page: Page,
	requestedPath: string,
	cwd: string,
	options: LoadStateOptions,
): Promise<LoadStateResult> {
	if (typeof requestedPath !== "string" || requestedPath.length === 0) throw new ToolError(STORAGE_STATE_ERROR);
	const source = resolveToCwd(requestedPath, cwd);
	let state: BrowserStorageState;
	try {
		const text = await untilAborted(options.signal, () => Bun.file(source).text());
		state = parseStorageState(JSON.parse(text) as unknown);
	} catch (error) {
		throwIfAborted(options.signal);
		if (error instanceof ToolError) throw error;
		throw new ToolError(STORAGE_STATE_ERROR);
	}
	if (state.cookies.length > 0) {
		try {
			await untilAborted(options.signal, () => page.browserContext().setCookie(...state.cookies));
		} catch {
			throwIfAborted(options.signal);
			throw new ToolError("tab.loadState() could not restore cookies from the browser state file");
		}
	}
	const currentOrigin = await untilAborted(options.signal, () =>
		page.evaluate(() => {
			const scope = globalThis as unknown as { location: { origin: string } };
			return scope.location.origin;
		}),
	);
	const loadedOrigins: string[] = [];
	const skippedOrigins: string[] = [];
	for (const origin of state.origins) {
		if (origin.origin === currentOrigin) {
			await restoreOriginStorage(page, origin, options.signal);
			loadedOrigins.push(origin.origin);
			continue;
		}
		if (!options.allowOtherOrigins || (origin.sessionStorage?.length ?? 0) > 0) {
			// Closing a temporary page discards its sessionStorage, so only localStorage-only
			// origins can be restored without disturbing the caller's current page.
			skippedOrigins.push(origin.origin);
			continue;
		}
		let temporary: Page | undefined;
		try {
			temporary = await untilAborted(options.signal, () => page.browserContext().newPage());
			await untilAborted(options.signal, () =>
				temporary!.goto(`${origin.origin}/`, {
					waitUntil: "domcontentloaded",
					timeout: options.navigationTimeoutMs,
				}),
			);
			const navigatedOrigin = await untilAborted(options.signal, () =>
				temporary!.evaluate(() => {
					const scope = globalThis as unknown as { location: { origin: string } };
					return scope.location.origin;
				}),
			);
			if (navigatedOrigin !== origin.origin) throw new ToolError("Browser state origin redirected");
			await restoreOriginStorage(temporary, origin, options.signal);
			loadedOrigins.push(origin.origin);
		} catch {
			throwIfAborted(options.signal);
			skippedOrigins.push(origin.origin);
		} finally {
			await temporary?.close().catch(() => undefined);
		}
	}
	return { loadedOrigins, skippedOrigins };
}
