import * as fs from "node:fs/promises";
import * as path from "node:path";

import { untilAborted } from "@oh-my-pi/pi-utils";
import type { HTTPRequest, HTTPResponse, Page } from "puppeteer-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

const REQUEST_LOG_LIMIT = 200;
const RESPONSE_BODY_LIMIT_BYTES = 1024 * 1024;
const ROUTE_INTERCEPT_PRIORITY = 10;
const PASS_THROUGH_INTERCEPT_PRIORITY = 0;
const REQUEST_RECORD = Symbol("omp.browser.requestRecord");

/** URL pattern accepted by persistent tab routes and request filters. */
export type NetworkPattern = string | RegExp;

/** Response/body behavior for one persistent tab route. */
export interface NetworkRouteOptions {
	/** Abort matching requests instead of continuing or fulfilling them. */
	abort?: boolean;
	/** Limit the route to one or more Puppeteer resource types. */
	resourceType?: string | string[];
	/** HTTP status used when fulfilling the request. */
	status?: number;
	/** Response headers used when fulfilling the request. */
	headers?: Record<string, string>;
	/** Response Content-Type used when fulfilling the request. */
	contentType?: string;
	/** Response body; objects are serialized as JSON. */
	body?: string | object;
	/** Delay in milliseconds before resolving the route. */
	delay?: number;
}

/** JSON-safe description of a registered persistent route. */
export interface NetworkRouteDescription {
	/** String glob or serialized regular expression. */
	pattern: string | { source: string; flags: string };
	/** Route behavior. */
	options: NetworkRouteOptions;
}

/** Byte counts associated with one browser request. */
export interface NetworkRequestSizes {
	/** Encoded request body bytes, when present. */
	requestBody: number;
	/** Encoded response body bytes, when known. */
	responseBody?: number;
}

/** Bounded request-log record returned by tab.requests(). */
export interface NetworkRequestRecord {
	/** Stable request id accepted by tab.request(). */
	id: string;
	/** Monotonic per-tab request sequence. */
	seq: number;
	/** Request start time as Unix milliseconds. */
	ts: number;
	/** Uppercase HTTP method. */
	method: string;
	/** Requested URL. */
	url: string;
	/** Puppeteer resource type. */
	resourceType: string;
	/** HTTP response status, when a response arrived. */
	status?: number;
	/** Whether the HTTP response status was successful. */
	ok?: boolean;
	/** Network failure or policy-block reason. */
	failureText?: string;
	/** Elapsed request time in milliseconds. */
	durationMs?: number;
	/** Request headers. */
	requestHeaders: Record<string, string>;
	/** Response headers, when a response arrived. */
	responseHeaders?: Record<string, string>;
	/** Request and response byte counts. */
	sizes: NetworkRequestSizes;
}

/** Full request-log record returned by tab.request(). */
export interface NetworkRequestDetail extends NetworkRequestRecord {
	/** Lazily loaded response body as text or base64 bytes. */
	body?: string | { base64: string };
	/** MIME type used to classify the response body. */
	contentType?: string;
	/** Whether the returned body was truncated to the 1 MiB cap. */
	bodyTruncated?: boolean;
}

/** Filters accepted by tab.requests(). */
export interface NetworkRequestsOptions {
	/** URL substring or regular expression. */
	filter?: NetworkPattern;
	/** Resource type or types to include. */
	type?: string | string[];
	/** HTTP method or methods to include. */
	method?: string | string[];
	/** Exact status, status class, or inclusive status range. */
	status?: number | string;
	/** Include requests started at or after this Unix-millisecond timestamp. */
	since?: number;
	/** Clear the bounded log after returning the selected records. */
	clear?: boolean;
	/** Maximum number of newest matching records to return. */
	limit?: number;
}

/** Body capture policy for a HAR recording. */
export type HarContentPolicy = "text" | "all" | "none";

interface StoredRequest extends NetworkRequestRecord {
	request: HTTPRequest;
	response?: HTTPResponse;
	bodyPromise?: Promise<LoadedBody | undefined>;
}

interface RequestWithRecord extends HTTPRequest {
	[REQUEST_RECORD]?: StoredRequest;
}

interface LoadedBody {
	value: string | { base64: string };
	contentType: string;
	truncated: boolean;
	bytes: number;
	isText: boolean;
}

interface StoredRoute {
	pattern: NetworkPattern;
	urlPattern: RegExp;
	resourceTypes?: string[];
	fulfill?: {
		status: number;
		headers?: Record<string, string>;
		contentType?: string;
		body?: string;
	};
	options: NetworkRouteOptions;
}

interface HarSession {
	content: HarContentPolicy;
	startSeq: number;
	startedAt: number;
}

/** Persistent per-tab routing, request logging, HAR capture, and host allowlisting. */
export class BrowserNetworkManager {
	readonly #page: Page;
	readonly #allowedDomains: string[];
	readonly #routes: StoredRoute[] = [];
	readonly #records: StoredRequest[] = [];
	readonly #recordsById = new Map<string, StoredRequest>();
	#nextSeq = 1;
	#interceptionEnabled = false;
	#started = false;
	#harSession?: HarSession;

	readonly #onRequest = async (request: HTTPRequest): Promise<void> => {
		const record = this.#rememberRequest(request);
		if (!this.hasPersistentInterception()) return;
		try {
			if (!this.#isAllowed(request.url())) {
				record.failureText = "blocked by allowed_domains";
				if (!request.isInterceptResolutionHandled()) await request.abort("blockedbyclient");
				return;
			}
			const route = this.#routes.find(candidate => this.#routeMatches(candidate, request));
			if (!route) {
				if (!request.isInterceptResolutionHandled()) {
					await request.continue({}, PASS_THROUGH_INTERCEPT_PRIORITY);
				}
				return;
			}
			if (route.options.delay !== undefined && route.options.delay > 0) {
				await Bun.sleep(route.options.delay);
			}
			if (request.isInterceptResolutionHandled()) return;
			if (route.options.abort) {
				await request.abort("failed", ROUTE_INTERCEPT_PRIORITY);
				return;
			}
			if (route.fulfill) {
				await request.respond(route.fulfill, ROUTE_INTERCEPT_PRIORITY);
				return;
			}
			await request.continue({}, ROUTE_INTERCEPT_PRIORITY);
		} catch (error) {
			if (!record.failureText) record.failureText = error instanceof Error ? error.message : String(error);
			if (!request.isInterceptResolutionHandled()) {
				await request.continue({}, PASS_THROUGH_INTERCEPT_PRIORITY).catch(() => undefined);
			}
		}
	};

	readonly #onResponse = (response: HTTPResponse): void => {
		const record = (response.request() as RequestWithRecord)[REQUEST_RECORD];
		if (!record) return;
		record.response = response;
		record.status = response.status();
		record.ok = response.ok();
		record.responseHeaders = response.headers();
		const contentLength = parseContentLength(record.responseHeaders);
		if (contentLength !== undefined) record.sizes.responseBody = contentLength;
	};

	readonly #onRequestFinished = (request: HTTPRequest): void => {
		const record = (request as RequestWithRecord)[REQUEST_RECORD];
		if (!record) return;
		record.durationMs = Math.max(0, Date.now() - record.ts);
	};

	readonly #onRequestFailed = (request: HTTPRequest): void => {
		const record = (request as RequestWithRecord)[REQUEST_RECORD];
		if (!record) return;
		record.failureText ??= request.failure()?.errorText ?? "request failed";
		record.durationMs = Math.max(0, Date.now() - record.ts);
	};

	constructor(page: Page, allowedDomains: readonly string[] = []) {
		this.#page = page;
		this.#allowedDomains = normalizeAllowedDomains(allowedDomains);
	}

	/** Install request/response observers and any required interception. */
	async start(signal?: AbortSignal): Promise<void> {
		if (this.#started) return;
		this.#started = true;
		this.#page.on("request", this.#onRequest);
		this.#page.on("response", this.#onResponse);
		this.#page.on("requestfinished", this.#onRequestFinished);
		this.#page.on("requestfailed", this.#onRequestFailed);
		if (this.hasPersistentInterception()) await this.#setInterception(true, signal);
	}

	/** Remove observers and disable interception during tab teardown. */
	async close(): Promise<void> {
		if (!this.#started) return;
		this.#started = false;
		this.#page.off("request", this.#onRequest);
		this.#page.off("response", this.#onResponse);
		this.#page.off("requestfinished", this.#onRequestFinished);
		this.#page.off("requestfailed", this.#onRequestFailed);
		if (this.#interceptionEnabled && !this.#page.isClosed()) {
			await this.#page.setRequestInterception(false).catch(() => undefined);
		}
		this.#interceptionEnabled = false;
	}

	/** Whether routes or allowed domains require interception to remain enabled between runs. */
	hasPersistentInterception(): boolean {
		return this.#allowedDomains.length > 0 || this.#routes.length > 0;
	}

	/** Restore the interception state after raw page interception used by one run. */
	async restoreInterception(signal?: AbortSignal): Promise<void> {
		await this.#setInterception(this.hasPersistentInterception(), signal, true);
	}

	/** Register a persistent tab-level route. */
	async route(pattern: NetworkPattern, options: NetworkRouteOptions = {}, signal?: AbortSignal): Promise<void> {
		validatePattern(pattern, "tab.route");
		const normalized = normalizeRouteOptions(options);
		this.#routes.push({
			pattern,
			urlPattern: typeof pattern === "string" ? globToRegExp(pattern) : new RegExp(pattern.source, pattern.flags),
			resourceTypes: normalizeStringList(normalized.resourceType),
			fulfill: routeFulfills(normalized) ? routeResponse(normalized) : undefined,
			options: normalized,
		});
		try {
			await this.#setInterception(true, signal);
		} catch (error) {
			this.#routes.pop();
			throw error;
		}
	}

	/** Remove matching routes, or every route when pattern is omitted. */
	async unroute(pattern?: NetworkPattern, signal?: AbortSignal): Promise<void> {
		if (pattern !== undefined) validatePattern(pattern, "tab.unroute");
		if (pattern === undefined) {
			this.#routes.length = 0;
		} else {
			for (let index = this.#routes.length - 1; index >= 0; index--) {
				if (samePattern(this.#routes[index]!.pattern, pattern)) this.#routes.splice(index, 1);
			}
		}
		if (!this.hasPersistentInterception()) await this.#setInterception(false, signal);
	}

	/** Return JSON-safe descriptions of every registered route. */
	routes(): NetworkRouteDescription[] {
		return this.#routes.map(route => ({
			pattern:
				typeof route.pattern === "string"
					? route.pattern
					: { source: route.pattern.source, flags: route.pattern.flags },
			options: cloneRouteOptions(route.options),
		}));
	}

	/** Query the bounded request log. */
	requests(options: NetworkRequestsOptions = {}): NetworkRequestRecord[] {
		const limit = normalizeLimit(options.limit);
		let records = this.#records.filter(record => matchesRequest(record, options));
		if (limit !== undefined) records = records.slice(-limit);
		const result = records.map(toPublicRecord);
		if (options.clear) this.clearRequests();
		return result;
	}

	/** Load one request detail and its capped response body on demand. */
	async request(id: string | number, signal?: AbortSignal): Promise<NetworkRequestDetail> {
		const record = this.#recordsById.get(String(id));
		if (!record) throw new ToolError(`Unknown browser request id ${JSON.stringify(id)}`);
		const detail: NetworkRequestDetail = toPublicRecord(record);
		const loaded = await this.#loadBody(record, signal);
		if (loaded) {
			detail.body = loaded.value;
			detail.contentType = loaded.contentType;
			detail.bodyTruncated = loaded.truncated || undefined;
		}
		return detail;
	}

	/** Clear all retained request records and response handles. */
	clearRequests(): void {
		this.#records.length = 0;
		this.#recordsById.clear();
	}

	/** Begin collecting subsequent request-log entries for a HAR file. */
	harStart(content: HarContentPolicy = "none"): void {
		if (content !== "none" && content !== "text" && content !== "all") {
			throw new ToolError('tab.harStart() content must be "text", "all", or "none"');
		}
		if (this.#harSession) throw new ToolError("A HAR recording is already active on this tab");
		this.#harSession = { content, startSeq: this.#nextSeq, startedAt: Date.now() };
	}

	/** Finish the active HAR recording and write a HAR 1.2 file. */
	async harStop(destination: string, signal?: AbortSignal): Promise<string> {
		const session = this.#harSession;
		if (!session) throw new ToolError("No HAR recording is active on this tab");
		this.#harSession = undefined;
		const records = this.#records.filter(record => record.seq >= session.startSeq);
		const entries: Record<string, unknown>[] = [];
		for (const record of records) {
			entries.push(await this.#harEntry(record, session.content, signal));
		}
		const har = {
			log: {
				version: "1.2",
				creator: { name: "omp-browser", version: "1" },
				pages: [],
				entries,
			},
		};
		await untilAborted(signal, () => fs.mkdir(path.dirname(destination), { recursive: true }));
		await untilAborted(signal, () => Bun.write(destination, `${JSON.stringify(har, null, 2)}\n`));
		return destination;
	}

	/** Return the normalized hostname allowlist applied to this tab. */
	allowedDomains(): string[] {
		return [...this.#allowedDomains];
	}

	async #setInterception(enabled: boolean, signal?: AbortSignal, force = false): Promise<void> {
		if (!force && this.#interceptionEnabled === enabled) return;
		await untilAborted(signal, () => this.#page.setRequestInterception(enabled));
		this.#interceptionEnabled = enabled;
	}

	#rememberRequest(request: HTTPRequest): StoredRequest {
		const tagged = request as RequestWithRecord;
		const existing = tagged[REQUEST_RECORD];
		if (existing) return existing;
		const seq = this.#nextSeq++;
		const postData = request.postData();
		const record: StoredRequest = {
			id: `request-${seq}`,
			seq,
			ts: Date.now(),
			method: request.method().toUpperCase(),
			url: request.url(),
			resourceType: request.resourceType(),
			requestHeaders: request.headers(),
			sizes: { requestBody: postData === undefined ? 0 : Buffer.byteLength(postData) },
			request,
		};
		this.#records.push(record);
		this.#recordsById.set(record.id, record);
		tagged[REQUEST_RECORD] = record;
		while (this.#records.length > REQUEST_LOG_LIMIT) {
			const removed = this.#records.shift();
			if (removed) this.#recordsById.delete(removed.id);
		}
		return record;
	}

	#isAllowed(url: string): boolean {
		if (this.#allowedDomains.length === 0) return true;
		let hostname: string;
		try {
			const parsed = new URL(url);
			if (
				parsed.protocol !== "http:" &&
				parsed.protocol !== "https:" &&
				parsed.protocol !== "ws:" &&
				parsed.protocol !== "wss:"
			) {
				return true;
			}
			hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
		} catch {
			return false;
		}
		return this.#allowedDomains.some(pattern => domainMatches(hostname, pattern));
	}

	#routeMatches(route: StoredRoute, request: HTTPRequest): boolean {
		if (route.resourceTypes && !route.resourceTypes.includes(request.resourceType())) return false;
		route.urlPattern.lastIndex = 0;
		return route.urlPattern.test(request.url());
	}

	async #loadBody(record: StoredRequest, signal?: AbortSignal): Promise<LoadedBody | undefined> {
		if (!record.response) return undefined;
		record.bodyPromise ??= loadResponseBody(record.response);
		const loaded = await untilAborted(signal, () => record.bodyPromise!);
		if (loaded && record.sizes.responseBody === undefined) record.sizes.responseBody = loaded.bytes;
		return loaded;
	}

	async #harEntry(
		record: StoredRequest,
		contentPolicy: HarContentPolicy,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		const loaded = contentPolicy === "none" ? undefined : await this.#loadBody(record, signal);
		const requestHeaders = headersToHar(record.requestHeaders);
		const responseHeaders = headersToHar(record.responseHeaders ?? {});
		const mimeType = loaded?.contentType ?? headerValue(record.responseHeaders, "content-type") ?? "";
		const content: Record<string, unknown> = {
			size: record.sizes.responseBody ?? loaded?.bytes ?? 0,
			mimeType,
		};
		if (loaded && (contentPolicy === "all" || loaded.isText)) {
			if (typeof loaded.value === "string") content.text = loaded.value;
			else {
				content.text = loaded.value.base64;
				content.encoding = "base64";
			}
		}
		const response = record.response;
		return {
			startedDateTime: new Date(record.ts).toISOString(),
			time: record.durationMs ?? 0,
			request: {
				method: record.method,
				url: record.url,
				httpVersion: "HTTP/1.1",
				headers: requestHeaders,
				queryString: queryStringToHar(record.url),
				cookies: [],
				headersSize: -1,
				bodySize: record.sizes.requestBody,
			},
			response: {
				status: record.status ?? 0,
				statusText: response?.statusText() ?? record.failureText ?? "",
				httpVersion: "HTTP/1.1",
				headers: responseHeaders,
				cookies: [],
				content,
				redirectURL: headerValue(record.responseHeaders, "location") ?? "",
				headersSize: -1,
				bodySize: record.sizes.responseBody ?? loaded?.bytes ?? -1,
			},
			cache: {},
			timings: { blocked: 0, dns: -1, connect: -1, send: 0, wait: record.durationMs ?? 0, receive: 0, ssl: -1 },
		};
	}
}

function normalizeAllowedDomains(domains: readonly string[]): string[] {
	const normalized: string[] = [];
	for (const value of domains) {
		if (typeof value !== "string") throw new ToolError("browser.open allowed_domains must contain strings");
		const domain = value.trim().toLowerCase().replace(/\.$/, "");
		if (
			!domain ||
			domain.includes("://") ||
			domain.includes("/") ||
			(domain.includes("*") && !domain.startsWith("*."))
		) {
			throw new ToolError(`Invalid allowed_domains pattern ${JSON.stringify(value)}`);
		}
		const suffix = domain.startsWith("*.") ? domain.slice(2) : domain;
		if (!suffix || suffix.includes("*")) {
			throw new ToolError(`Invalid allowed_domains pattern ${JSON.stringify(value)}`);
		}
		if (!normalized.includes(domain)) normalized.push(domain);
	}
	return normalized;
}

function domainMatches(hostname: string, pattern: string): boolean {
	if (!pattern.startsWith("*.")) return hostname === pattern;
	const suffix = pattern.slice(2);
	return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

function normalizeRouteOptions(options: NetworkRouteOptions): NetworkRouteOptions {
	if (!options || typeof options !== "object" || Array.isArray(options)) {
		throw new ToolError("tab.route() expects an options object");
	}
	if (options.delay !== undefined && (!Number.isFinite(options.delay) || options.delay < 0)) {
		throw new ToolError("tab.route() delay must be a non-negative number");
	}
	if (
		options.status !== undefined &&
		(!Number.isInteger(options.status) || options.status < 100 || options.status > 599)
	) {
		throw new ToolError("tab.route() status must be an integer from 100 through 599");
	}
	const resourceTypes = normalizeStringList(options.resourceType);
	if (resourceTypes?.some(type => !type)) throw new ToolError("tab.route() resourceType must not be empty");
	return {
		...options,
		resourceType: resourceTypes
			? Array.isArray(options.resourceType)
				? resourceTypes
				: resourceTypes[0]
			: undefined,
		headers: options.headers ? { ...options.headers } : undefined,
	};
}

function cloneRouteOptions(options: NetworkRouteOptions): NetworkRouteOptions {
	return {
		...options,
		headers: options.headers ? { ...options.headers } : undefined,
		body: options.body && typeof options.body === "object" ? structuredClone(options.body) : options.body,
	};
}

function routeFulfills(options: NetworkRouteOptions): boolean {
	return (
		options.status !== undefined ||
		options.headers !== undefined ||
		options.contentType !== undefined ||
		options.body !== undefined
	);
}

function routeResponse(options: NetworkRouteOptions): {
	status: number;
	headers?: Record<string, string>;
	contentType?: string;
	body?: string;
} {
	let body: string | undefined;
	let contentType = options.contentType;
	if (typeof options.body === "string") body = options.body;
	else if (options.body !== undefined) {
		body = JSON.stringify(options.body);
		contentType ??= "application/json";
	}
	return {
		status: options.status ?? 200,
		headers: options.headers ? { ...options.headers } : undefined,
		contentType,
		body,
	};
}

function validatePattern(pattern: NetworkPattern, label: string): void {
	if (typeof pattern === "string") {
		if (!pattern) throw new ToolError(`${label}() pattern must not be empty`);
		return;
	}
	if (!(pattern instanceof RegExp)) throw new ToolError(`${label}() pattern must be a glob string or RegExp`);
}

function samePattern(left: NetworkPattern, right: NetworkPattern): boolean {
	if (typeof left === "string" || typeof right === "string") return left === right;
	return left.source === right.source && left.flags === right.flags;
}

function globToRegExp(glob: string): RegExp {
	let source = "^";
	for (let index = 0; index < glob.length; index++) {
		const character = glob[index]!;
		if (character === "*") {
			if (glob[index + 1] === "*") {
				source += ".*";
				index++;
			} else source += "[^/]*";
		} else source += /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
	}
	return new RegExp(`${source}$`);
}

function matchesRequest(record: NetworkRequestRecord, options: NetworkRequestsOptions): boolean {
	if (options.filter !== undefined && !requestFilterMatches(options.filter, record.url)) return false;
	const types = normalizeStringList(options.type);
	if (types && !types.includes(record.resourceType)) return false;
	const methods = normalizeStringList(options.method)?.map(method => method.toUpperCase());
	if (methods && !methods.includes(record.method)) return false;
	if (options.status !== undefined && !statusMatches(record.status, options.status)) return false;
	if (options.since !== undefined && record.ts < options.since) return false;
	return true;
}

function requestFilterMatches(filter: NetworkPattern, url: string): boolean {
	if (typeof filter === "string") return url.includes(filter);
	filter.lastIndex = 0;
	return filter.test(url);
}

function statusMatches(status: number | undefined, filter: number | string): boolean {
	if (status === undefined) return false;
	if (typeof filter === "number") return status === filter;
	const classMatch = /^(\d)xx$/i.exec(filter);
	if (classMatch) return Math.floor(status / 100) === Number(classMatch[1]);
	const rangeMatch = /^(\d{3})-(\d{3})$/.exec(filter);
	if (rangeMatch) return status >= Number(rangeMatch[1]) && status <= Number(rangeMatch[2]);
	if (/^\d{3}$/.test(filter)) return status === Number(filter);
	throw new ToolError(`Invalid tab.requests() status filter ${JSON.stringify(filter)}`);
}

function normalizeStringList(value: string | string[] | undefined): string[] | undefined {
	if (value === undefined) return undefined;
	return (Array.isArray(value) ? value : [value]).map(item => String(item));
}

function normalizeLimit(limit: number | undefined): number | undefined {
	if (limit === undefined) return undefined;
	if (!Number.isInteger(limit) || limit < 0)
		throw new ToolError("tab.requests() limit must be a non-negative integer");
	return limit;
}

function toPublicRecord(record: StoredRequest): NetworkRequestRecord {
	return {
		id: record.id,
		seq: record.seq,
		ts: record.ts,
		method: record.method,
		url: record.url,
		resourceType: record.resourceType,
		status: record.status,
		ok: record.ok,
		failureText: record.failureText,
		durationMs: record.durationMs,
		requestHeaders: { ...record.requestHeaders },
		responseHeaders: record.responseHeaders ? { ...record.responseHeaders } : undefined,
		sizes: { ...record.sizes },
	};
}

async function loadResponseBody(response: HTTPResponse): Promise<LoadedBody | undefined> {
	let buffer: Buffer;
	try {
		buffer = await response.buffer();
	} catch {
		return undefined;
	}
	const bytes = buffer.byteLength;
	const truncated = bytes > RESPONSE_BODY_LIMIT_BYTES;
	const capped = truncated ? buffer.subarray(0, RESPONSE_BODY_LIMIT_BYTES) : buffer;
	const contentType = headerValue(response.headers(), "content-type") ?? "application/octet-stream";
	const isText = isTextualContentType(contentType);
	return {
		value: isText ? capped.toString("utf8") : { base64: capped.toString("base64") },
		contentType,
		truncated,
		bytes,
		isText,
	};
}

function isTextualContentType(contentType: string): boolean {
	const type = contentType.split(";", 1)[0]!.trim().toLowerCase();
	return (
		type.startsWith("text/") ||
		type.endsWith("+json") ||
		type.endsWith("+xml") ||
		type === "application/json" ||
		type === "application/javascript" ||
		type === "application/xml" ||
		type === "application/x-www-form-urlencoded" ||
		type === "image/svg+xml"
	);
}

function parseContentLength(headers: Record<string, string>): number | undefined {
	const raw = headerValue(headers, "content-length");
	if (raw === undefined) return undefined;
	const value = Number(raw);
	return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
	if (!headers) return undefined;
	const wanted = name.toLowerCase();
	for (const key in headers) {
		if (key.toLowerCase() === wanted) return headers[key];
	}
	return undefined;
}

function headersToHar(headers: Record<string, string>): Array<{ name: string; value: string }> {
	const result: Array<{ name: string; value: string }> = [];
	for (const name in headers) result.push({ name, value: headers[name]! });
	return result;
}

function queryStringToHar(url: string): Array<{ name: string; value: string }> {
	try {
		return [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
	} catch {
		return [];
	}
}
