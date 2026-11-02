/**
 * The Tern tab's request log: fetch/XHR records the page-world capture script
 * reports, plus navigation responses from Tern's `response` events, bounded
 * like the Chromium log. Bodies of fetch/XHR responses stay in the page until
 * asked for; navigation bodies are not observable.
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
	/** The capture script's id (`<document>:<n>`), absent for navigations. */
	pageId?: string;
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

/** Resource types the page-world capture can route. */
const ROUTABLE_TYPES: Record<string, true> = { fetch: true, xhr: true };

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Request log, routes and HAR recording of one Tern tab. */
export class TernNetworkLog {
	readonly #records: TernRequestEntry[] = [];
	readonly #byPageId = new Map<string, TernRequestEntry>();
	readonly #routes: StoredRoute[] = [];
	#nextSeq = 1;
	#settled = 0;
	#har: { content: HarContentPolicy; startSeq: number } | undefined;

	/** Sequence the next record gets (a cursor for "requests after now"). */
	get cursor(): number {
		return this.#nextSeq;
	}

	/** How many responses/failures arrived so far (a cursor for "responses after now"). */
	get settleCursor(): number {
		return this.#settled;
	}

	/** Record a capture-script network message (`kind` = request/response/requestfailed). */
	ingestPageMessage(message: Record<string, unknown>): void {
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
				`tab.route() is not supported on the Tern browser backend for resourceType ${unroutable.join(", ")}: only the page's fetch and xhr requests can be routed`,
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
		while (this.#records.length > REQUEST_LOG_LIMIT) {
			const removed = this.#records.shift();
			if (removed?.pageId) this.#byPageId.delete(removed.pageId);
		}
		return record;
	}
}
