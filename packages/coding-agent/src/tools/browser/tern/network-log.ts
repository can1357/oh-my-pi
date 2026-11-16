/**
 * The Tern tab's request log: fetch/XHR records the page-world capture script
 * reports, plus navigation responses from Tern's `response` events, bounded
 * like the Chromium log. Bodies of fetch/XHR responses stay in the page until
 * asked for; navigation bodies are not observable.
 *
 * A server that lists `network` in its welcome (omp's WebKit host) reports
 * every resource load itself, as `request` / `response` / `requestFinished` /
 * `requestFailed` events. Those are then the log's only source for loads that
 * reach the network: of what a capture script reports, only the requests it
 * answered itself (a fulfilling or aborting route, offline emulation) are
 * recorded, since the engine never saw them. Natively observed loads have no
 * body store and no request body size; their response body size is the
 * Content-Length the response declared, unknown without one.
 */
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import {
	buildHarEntry,
	buildHarLog,
	cloneRouteOptions,
	globToRegExp,
	type HarContentPolicy,
	matchesRequest,
	type NetworkPattern,
	type NetworkRequestDetail,
	type NetworkRequestRecord,
	type NetworkRequestsOptions,
	type NetworkResponseBody,
	type NetworkRouteDescription,
	type NetworkRouteOptions,
	normalizeLimit,
	normalizeRouteOptions,
	REQUEST_LOG_LIMIT,
	routeFulfills,
	routeResponse,
	samePattern,
	toPublicRecord,
	validatePattern,
} from "../network";
import type { TernRouteRule } from "./page-capture";

/** One logged request; `pageId` addresses its body in the page that made it. */
export interface TernRequestEntry extends NetworkRequestRecord {
	/** The capture script's id (`<document>:<n>`), absent for navigations and natively observed loads. */
	pageId?: string;
	/** The server's id of a natively observed load (unique per block). */
	nativeId?: number;
	/** Frame path of the document that made it (null: the main frame). */
	frame?: string | null;
	/** Order in which its response (or failure) arrived; absent while in flight. */
	settledSeq?: number;
	/** Response status text. */
	statusText?: string;
	/** Whether a route answered it. */
	routed?: boolean;
}

interface StoredRoute {
	pattern: NetworkPattern;
	rule: TernRouteRule;
	options: NetworkRouteOptions;
}

/** Loads a request's captured body from the page (null when the page no longer has it). */
export type TernBodyLoader = (entry: TernRequestEntry) => Promise<NetworkResponseBody | null>;

/** Header names lower-cased (values of names differing only in case are joined). */
function headerRecord(value: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (!value || typeof value !== "object") return out;
	const record = value as Record<string, unknown>;
	for (const key in record) {
		const name = key.toLowerCase();
		const text = String(record[key]);
		out[name] = out[name] === undefined ? text : `${out[name]}, ${text}`;
	}
	return out;
}

/** Puppeteer resource types by the request's `Sec-Fetch-Dest`. */
const TYPE_BY_FETCH_DEST: Record<string, string> = {
	document: "document",
	iframe: "subdocument",
	frame: "subdocument",
	style: "stylesheet",
	script: "script",
	image: "image",
	font: "font",
	audio: "media",
	video: "media",
	track: "texttrack",
	manifest: "manifest",
	empty: "fetch",
};

/**
 * The Puppeteer resource type of a natively observed load. The engine names
 * none: the main document is known, the rest is read off the request's
 * `Sec-Fetch-Dest`, else off the response's MIME type. WebKit sends
 * `Sec-Fetch-Dest` to potentially trustworthy origins only; to the others
 * (plain http off this machine) it marks a frame's document request with
 * `Upgrade-Insecure-Requests` instead, so only such a request is a
 * `subdocument`, and an HTML answer to any other request (an API that answers
 * `text/html`) is `fetch`. `fetch` also stands for XHR, which the engine does
 * not tell apart.
 */
function nativeResourceType(main: boolean, requestHeaders: Record<string, string>, mime: string | undefined): string {
	if (main) return "document";
	const byDest = TYPE_BY_FETCH_DEST[requestHeaders["sec-fetch-dest"] ?? ""];
	if (byDest) return byDest;
	if (requestHeaders["upgrade-insecure-requests"] === "1") return "subdocument";
	const type = mime?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	if (type === "text/html" || type === "application/xhtml+xml") return "fetch";
	if (type === "text/css") return "stylesheet";
	if (type.endsWith("javascript") || type.endsWith("ecmascript")) return "script";
	if (type.startsWith("image/")) return "image";
	if (type.startsWith("font/") || type.includes("font-")) return "font";
	if (type.startsWith("audio/") || type.startsWith("video/")) return "media";
	if (type === "application/json" || type.endsWith("+json")) return "fetch";
	return "other";
}

/** Capture-script requests remembered until their answer says whether the engine saw them, at most this many. */
const HELD_PAGE_REQUESTS = 512;

/** Resource types the page-world capture can route. */
const ROUTABLE_TYPES: Record<string, true> = { fetch: true, xhr: true };

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Request log, routes and HAR recording of one Tern tab. */
export class TernNetworkLog {
	/** The backend's display name in errors (`Tern`, `WebKit`). */
	readonly #product: string;
	readonly #records: TernRequestEntry[] = [];
	readonly #byPageId = new Map<string, TernRequestEntry>();
	/** Whether the server reports loads itself ({@link ingestNative}). */
	readonly #native: boolean;
	readonly #byNativeId = new Map<number, TernRequestEntry>();
	/** Natively observed loads still running, by server id. */
	readonly #nativeInflight = new Set<number>();
	/** Capture-script `request` messages whose answer has not arrived, by page id (native servers only). */
	readonly #heldPageRequests = new Map<string, Record<string, unknown>>();
	readonly #routes: StoredRoute[] = [];
	#nextSeq = 1;
	#settled = 0;
	#har: { content: HarContentPolicy; startSeq: number } | undefined;

	/** `native`: the server lists `network`, so its events, not a capture script, are the log's source. */
	constructor(product: string, native = false) {
		this.#product = product;
		this.#native = native;
	}

	/** Natively observed loads that have neither finished nor failed. */
	get inflight(): number {
		return this.#nativeInflight.size;
	}

	/**
	 * Forget which native loads are running: a new document replaced the one
	 * that made them, or the server dropped events (their ends may be among them).
	 */
	forgetInflight(): void {
		this.#nativeInflight.clear();
	}

	/** Sequence the next record gets (a cursor for "requests after now"). */
	get cursor(): number {
		return this.#nextSeq;
	}

	/** How many responses/failures arrived so far (a cursor for "responses after now"). */
	get settleCursor(): number {
		return this.#settled;
	}

	/**
	 * Record a capture-script network message (`kind` = request/response/requestfailed).
	 * Returns whether it entered the log: on a native server only a request the
	 * capture answered itself (`local`) does, once that answer arrives.
	 */
	ingestPageMessage(message: Record<string, unknown>): boolean {
		if (!this.#native) {
			this.#recordPageMessage(message);
			return true;
		}
		const id = typeof message.id === "string" ? message.id : undefined;
		if (!id) return false;
		if (message.kind === "request") {
			this.#heldPageRequests.set(id, message);
			if (this.#heldPageRequests.size > HELD_PAGE_REQUESTS) {
				this.#heldPageRequests.delete(this.#heldPageRequests.keys().next().value!);
			}
			return false;
		}
		const request = this.#heldPageRequests.get(id);
		this.#heldPageRequests.delete(id);
		if (!request || message.local !== true) return false;
		this.#recordPageMessage(request);
		this.#recordPageMessage(message);
		return true;
	}

	/**
	 * Record one native network event (`request`, `response` with an `id`,
	 * `requestFinished`, `requestFailed`) of a server that lists `network`.
	 * Returns the record when the event is its failure.
	 */
	ingestNative(event: Record<string, unknown>): TernRequestEntry | undefined {
		const id = num(event.id);
		if (id === undefined) return undefined;
		const ts = num(event.ts) ?? Date.now();
		// A load whose `request` event was lost to the server's event ring still gets a record. The engine
		// reports no request bodies: their sizes stay unknown.
		const entryFor = (): TernRequestEntry =>
			this.#byNativeId.get(id) ??
			this.#push({
				nativeId: id,
				ts,
				method: "GET",
				url: typeof event.url === "string" ? event.url : "",
				resourceType: nativeResourceType(event.main === true, {}, undefined),
				requestHeaders: {},
				sizes: {},
			});
		switch (event.type) {
			case "request": {
				const headers = headerRecord(event.headers);
				const method = typeof event.method === "string" ? event.method.toUpperCase() : "GET";
				const url = typeof event.url === "string" ? event.url : "";
				const known = this.#byNativeId.get(id);
				if (known) {
					// The same load asking again: a redirect.
					known.url = url;
					known.method = method;
					known.requestHeaders = headers;
				} else {
					this.#push({
						nativeId: id,
						ts,
						method,
						url,
						resourceType: nativeResourceType(event.main === true, headers, undefined),
						requestHeaders: headers,
						sizes: {},
					});
				}
				this.#nativeInflight.add(id);
				return undefined;
			}
			case "response": {
				const entry = entryFor();
				const headers = headerRecord(event.headers);
				const mime = typeof event.mime === "string" && event.mime ? event.mime : undefined;
				if (mime && !headers["content-type"]) headers["content-type"] = mime;
				entry.status = num(event.status) ?? 0;
				entry.ok = entry.status >= 200 && entry.status < 300;
				entry.responseHeaders = headers;
				if (typeof event.url === "string" && event.url) entry.url = event.url;
				if (entry.resourceType === "other" || event.main === true) {
					entry.resourceType = nativeResourceType(event.main === true, entry.requestHeaders, mime);
				}
				entry.settledSeq ??= ++this.#settled;
				return undefined;
			}
			case "requestFinished": {
				const entry = this.#byNativeId.get(id);
				this.#nativeInflight.delete(id);
				if (!entry) return undefined;
				// The length the response declared (Content-Length), which the engine also gives as 0 for one that
				// declared none: that size stays unknown.
				const length = num(event.length);
				if (length !== undefined && (length > 0 || entry.responseHeaders?.["content-length"] !== undefined)) {
					entry.sizes.responseBody = length;
				}
				// Only a server that stamps its events gives a duration: omp reads them in batches.
				if (num(event.ts) !== undefined) entry.durationMs = Math.max(0, ts - entry.ts);
				return undefined;
			}
			case "requestFailed": {
				const entry = entryFor();
				this.#nativeInflight.delete(id);
				entry.failureText = typeof event.error === "string" && event.error ? event.error : "request failed";
				entry.settledSeq ??= ++this.#settled;
				return entry;
			}
		}
		return undefined;
	}

	#recordPageMessage(message: Record<string, unknown>): void {
		const id = typeof message.id === "string" ? message.id : undefined;
		const ts = num(message.ts) ?? Date.now();
		switch (message.kind) {
			case "request": {
				if (!id) return;
				this.#push({
					pageId: id,
					frame: typeof message.frame === "string" ? message.frame : null,
					ts,
					method: typeof message.method === "string" ? message.method : "GET",
					url: typeof message.url === "string" ? message.url : "",
					resourceType: typeof message.resourceType === "string" ? message.resourceType : "fetch",
					requestHeaders: headerRecord(message.headers),
					sizes: { requestBody: num(message.bodySize) ?? 0 },
				});
				return;
			}
			case "response": {
				const entry = id ? this.#byPageId.get(id) : undefined;
				if (!entry) return;
				entry.status = num(message.status);
				entry.ok = entry.status !== undefined && entry.status >= 200 && entry.status < 300;
				entry.statusText = typeof message.statusText === "string" ? message.statusText : "";
				entry.responseHeaders = headerRecord(message.headers);
				entry.durationMs = num(message.durationMs);
				entry.routed = message.routed === true;
				entry.settledSeq = ++this.#settled;
				if (typeof message.url === "string" && message.url) entry.url = message.url;
				const length = Number(entry.responseHeaders["content-length"]);
				if (Number.isFinite(length) && length >= 0) entry.sizes.responseBody = length;
				return;
			}
			case "requestfailed": {
				const entry = id ? this.#byPageId.get(id) : undefined;
				if (entry) {
					entry.failureText = typeof message.error === "string" ? message.error : "request failed";
					entry.durationMs = num(message.durationMs);
					entry.settledSeq = ++this.#settled;
					return;
				}
				// A subresource the page saw fail (img/script/link error event).
				this.#push({
					ts,
					method: "GET",
					url: typeof message.url === "string" ? message.url : "",
					resourceType: typeof message.resourceType === "string" ? message.resourceType : "other",
					requestHeaders: {},
					sizes: { requestBody: 0 },
					failureText: typeof message.error === "string" ? message.error : "request failed",
					settledSeq: ++this.#settled,
				});
				return;
			}
		}
	}

	/** Record a navigation response Tern reported (`main`: the main frame's document). */
	ingestNavigationResponse(event: Record<string, unknown>): TernRequestEntry {
		const status = num(event.status) ?? 0;
		const headers = headerRecord(event.headers);
		const mime = typeof event.mime === "string" ? event.mime : undefined;
		if (mime && !headers["content-type"]) headers["content-type"] = mime;
		return this.#push({
			ts: Date.now(),
			method: "GET",
			url: typeof event.url === "string" ? event.url : "",
			resourceType: event.main === false ? "subdocument" : "document",
			requestHeaders: {},
			status,
			ok: status >= 200 && status < 300,
			responseHeaders: headers,
			sizes: { requestBody: 0 },
			settledSeq: ++this.#settled,
		});
	}

	/** Record a navigation Tern's allowlist blocked. */
	ingestBlocked(url: string): void {
		this.#push({
			ts: Date.now(),
			method: "GET",
			url,
			resourceType: "document",
			requestHeaders: {},
			sizes: { requestBody: 0 },
			failureText: "blocked by allowed_domains",
			settledSeq: ++this.#settled,
		});
	}

	/** Records whose response (or failure) arrived after `settleCursor`, in arrival order. */
	settledAfter(settleCursor: number): TernRequestEntry[] {
		return this.#records
			.filter(record => record.settledSeq !== undefined && record.settledSeq > settleCursor)
			.sort((left, right) => left.settledSeq! - right.settledSeq!);
	}

	/** Query the log like `BrowserNetworkManager.requests`. */
	requests(options: NetworkRequestsOptions = {}): NetworkRequestRecord[] {
		const limit = normalizeLimit(options.limit);
		let records = this.#records.filter(record => matchesRequest(record, options));
		if (limit !== undefined) records = records.slice(-limit);
		const result = records.map(toPublicRecord);
		if (options.clear) this.clear();
		return result;
	}

	/** One record with its body, loaded from the page on demand. */
	async request(id: string | number, loadBody: TernBodyLoader): Promise<NetworkRequestDetail> {
		const key = typeof id === "number" ? `request-${id}` : String(id);
		const record = this.#records.find(candidate => candidate.id === key);
		if (!record) throw new ToolError(`Unknown browser request id ${JSON.stringify(id)}`);
		const detail: NetworkRequestDetail = toPublicRecord(record);
		const body = await loadBody(record);
		if (body) {
			detail.body = body.value;
			detail.contentType = body.contentType;
			detail.bodyTruncated = body.truncated || undefined;
			if (record.sizes.responseBody === undefined) record.sizes.responseBody = body.bytes;
		}
		return detail;
	}

	/** Forget every record. */
	clear(): void {
		this.#records.length = 0;
		this.#byPageId.clear();
		this.#byNativeId.clear();
	}

	/** Begin a HAR recording of subsequent records. */
	harStart(content: HarContentPolicy = "none"): void {
		if (content !== "none" && content !== "text" && content !== "all") {
			throw new ToolError('tab.harStart() content must be "text", "all", or "none"');
		}
		if (this.#har) throw new ToolError("A HAR recording is already active on this tab");
		this.#har = { content, startSeq: this.#nextSeq };
	}

	/** Finish the HAR recording and return the HAR document. */
	async harStop(loadBody: TernBodyLoader): Promise<object> {
		const session = this.#har;
		if (!session) throw new ToolError("No HAR recording is active on this tab");
		this.#har = undefined;
		const entries: Record<string, unknown>[] = [];
		for (const record of this.#records) {
			if (record.seq < session.startSeq) continue;
			const body = session.content === "none" ? undefined : ((await loadBody(record)) ?? undefined);
			entries.push(buildHarEntry(record, body, session.content, record.statusText ?? record.failureText ?? ""));
		}
		return buildHarLog(entries);
	}

	/** Register a persistent route (applied by the page to fetch/XHR). */
	route(pattern: NetworkPattern, options: NetworkRouteOptions = {}): void {
		validatePattern(pattern, "tab.route");
		const normalized = normalizeRouteOptions(options);
		const regex = typeof pattern === "string" ? globToRegExp(pattern) : pattern;
		const types = normalized.resourceType === undefined ? undefined : [normalized.resourceType].flat();
		const unroutable = types?.filter(type => !ROUTABLE_TYPES[type]) ?? [];
		if (unroutable.length > 0) {
			throw new ToolError(
				`tab.route() is not supported on the ${this.#product} browser backend for resourceType ${unroutable.join(", ")}: only the page's fetch and xhr requests can be routed`,
			);
		}
		const rule: TernRouteRule = {
			source: regex.source,
			flags: regex.flags.replace(/[gy]/g, ""),
			...(types ? { resourceTypes: types } : {}),
			...(normalized.abort ? { abort: true } : {}),
			...(normalized.delay ? { delay: normalized.delay } : {}),
			...(routeFulfills(normalized) ? { fulfill: routeResponse(normalized) } : {}),
		};
		this.#routes.push({ pattern, rule, options: normalized });
	}

	/** Remove matching routes, or all of them. */
	unroute(pattern?: NetworkPattern): void {
		if (pattern !== undefined) validatePattern(pattern, "tab.unroute");
		if (pattern === undefined) {
			this.#routes.length = 0;
			return;
		}
		for (let index = this.#routes.length - 1; index >= 0; index--) {
			if (samePattern(this.#routes[index]!.pattern, pattern)) this.#routes.splice(index, 1);
		}
	}

	/** JSON-safe route descriptions. */
	routes(): NetworkRouteDescription[] {
		return this.#routes.map(route => ({
			pattern:
				typeof route.pattern === "string"
					? route.pattern
					: { source: route.pattern.source, flags: route.pattern.flags },
			options: cloneRouteOptions(route.options),
		}));
	}

	/** Routes as the capture script applies them. */
	rules(): TernRouteRule[] {
		return this.#routes.map(route => route.rule);
	}

	#push(entry: Omit<TernRequestEntry, "id" | "seq">): TernRequestEntry {
		const seq = this.#nextSeq++;
		const record: TernRequestEntry = { ...entry, id: `request-${seq}`, seq };
		this.#records.push(record);
		if (record.pageId) this.#byPageId.set(record.pageId, record);
		if (record.nativeId !== undefined) this.#byNativeId.set(record.nativeId, record);
		while (this.#records.length > REQUEST_LOG_LIMIT) {
			const removed = this.#records.shift();
			if (removed?.pageId) this.#byPageId.delete(removed.pageId);
			if (removed?.nativeId !== undefined) this.#byNativeId.delete(removed.nativeId);
		}
		return record;
	}
}
