/**
 * Page-world instrumentation for Tern tabs: console and uncaught-error
 * capture, a fetch/XHR observer with persistent routes, and the JS-visible
 * emulation overrides (geolocation, locale, offline) WKWebView has no native
 * switch for. It reports to omp through
 * `webkit.messageHandlers.stencil.postMessage(JSON)`; response bodies stay in
 * the page (the last 200) until omp asks for one.
 *
 * Everything here runs in the page's own world, so pages can see (and
 * tamper with) the wrappers — the price of observing page-world `fetch`.
 * Navigations and subresources (images, scripts, styles, frames) are not
 * observable or routable from page script; omp adds navigation responses
 * from Tern's `response` events.
 */

/** A persistent route as the page applies it. */
export interface TernRouteRule {
	/** URL regular expression source. */
	source: string;
	/** Its flags. */
	flags: string;
	/** Only these resource types (`fetch`, `xhr`). */
	resourceTypes?: string[];
	/** Fail matching requests. */
	abort?: boolean;
	/** Delay before answering, in ms. */
	delay?: number;
	/** Answer with this response instead of the network. */
	fulfill?: { status: number; headers?: Record<string, string>; contentType?: string; body?: string };
}

/** JS-visible emulation overrides applied in the page world. */
export interface TernPageEmulation {
	/** `navigator.geolocation` answers these coordinates. */
	geolocation?: { latitude: number; longitude: number; accuracy?: number };
	/** `navigator.language(s)` and `Intl`/`toLocale*` defaults use this locale. */
	locale?: string;
	/** `navigator.onLine` is false and fetch/XHR fail. */
	offline?: boolean;
}

/** Configuration of the page-world capture script. */
export interface TernCaptureConfig {
	/** Persistent routes, in registration order (first match wins). */
	routes: TernRouteRule[];
	/** Emulation overrides. */
	emulation: TernPageEmulation;
}

/** Name of the page-world global holding the capture state. */
export const TERN_CAPTURE_GLOBAL = "__ompTernCapture";

/**
 * Source of a page function `(config) => void` that installs the capture in
 * the current document (first call) or swaps its configuration (later
 * calls). No `eval`: page CSP never applies to it.
 */
export const TERN_CAPTURE_INSTALLER = String.raw`function (config) {
	const KEY = "__ompTernCapture";
	const existing = globalThis[KEY];
	if (existing) {
		const wasOffline = !!existing.config.emulation.offline;
		existing.config = config;
		const offline = !!config.emulation.offline;
		if (wasOffline !== offline) dispatchEvent(new Event(offline ? "offline" : "online"));
		return true;
	}
	const handler = globalThis.webkit && webkit.messageHandlers && webkit.messageHandlers.stencil;
	const post = handler ? handler.postMessage.bind(handler) : () => {};
	const doc = Math.random().toString(36).slice(2, 10);
	// This frame's index path from the top ("0", "1.0"; null for the main frame), as the page kit names frames.
	const framePath = (() => {
		const parts = [];
		try {
			for (let w = window; w !== w.parent; w = w.parent) {
				let index = -1;
				for (let i = 0; i < w.parent.length; i++) if (w.parent[i] === w) { index = i; break; }
				if (index < 0) return null;
				parts.unshift(index);
			}
		} catch { return null; }
		return parts.length ? parts.join(".") : null;
	})();
	const state = { config, doc, nextId: 1, inflight: 0, bodies: new Map(), reading: new Map(), budget: 0, window: 0, dropped: 0 };
	Object.defineProperty(globalThis, KEY, { value: state, configurable: true, enumerable: false });
	const send = message => {
		const now = Date.now();
		if (now - state.window > 1000) { state.window = now; state.budget = 0; }
		if (++state.budget > 400) { state.dropped++; return; }
		if (state.dropped) { message.dropped = state.dropped; state.dropped = 0; }
		message.omp = "tern";
		message.doc = doc;
		message.frame = framePath;
		message.ts = now;
		try { post(JSON.stringify(message)); } catch {}
	};
	const text = value => {
		try { return String(value); } catch {
			try { const json = JSON.stringify(value); if (json !== undefined) return json; } catch {}
			return Object.prototype.toString.call(value);
		}
	};
	const safe = value => {
		try {
			const json = JSON.stringify(value);
			if (json === undefined) return text(value);
			return json.length > 8192 ? json.slice(0, 8192) + "…" : JSON.parse(json);
		} catch { return text(value); }
	};
	for (const level of ["log", "info", "warn", "error", "debug"]) {
		const original = console[level];
		console[level] = function (...args) {
			send({ kind: "console", level, text: args.map(text).join(" ").slice(0, 16384), args: args.map(safe) });
			return original.apply(this, args);
		};
	}
	addEventListener("error", event => {
		if (event.target !== window && event.target && event.target.tagName) {
			const target = event.target;
			send({ kind: "requestfailed", url: String(target.src || target.href || ""), error: "resource failed to load", resourceType: String(target.tagName).toLowerCase() });
			return;
		}
		send({
			kind: "pageerror",
			text: String(event.message || event.error || "Uncaught error").slice(0, 16384),
			location: event.filename ? event.filename + ":" + event.lineno + ":" + event.colno : undefined,
			stack: event.error && event.error.stack ? String(event.error.stack).slice(0, 32768) : undefined,
		});
	}, true);
	addEventListener("unhandledrejection", event => {
		const reason = event.reason;
		send({
			kind: "pageerror",
			text: String((reason && reason.message) || reason).slice(0, 16384),
			stack: reason && reason.stack ? String(reason.stack).slice(0, 32768) : undefined,
		});
	});

	// Network: fetch and XHR observer with routes.
	const LIMIT = 1024 * 1024;
	const textual = type => {
		const base = String(type || "").split(";")[0].trim().toLowerCase();
		return base.startsWith("text/") || base.endsWith("+json") || base.endsWith("+xml") ||
			["application/json", "application/javascript", "application/xml", "application/x-www-form-urlencoded", "image/svg+xml"].includes(base);
	};
	const headerRecord = headers => {
		const out = {};
		if (headers && typeof headers.forEach === "function") headers.forEach((value, name) => { out[String(name).toLowerCase()] = String(value); });
		else if (headers && typeof headers === "object") for (const name of Object.keys(headers)) out[name.toLowerCase()] = String(headers[name]);
		return out;
	};
	const remember = (id, bytes, contentType, knownSize) => {
		const size = Math.max(bytes.byteLength, knownSize || 0);
		const capped = bytes.byteLength > LIMIT ? bytes.subarray(0, LIMIT) : bytes;
		let value;
		if (textual(contentType)) value = new TextDecoder().decode(capped);
		else {
			let binary = "";
			for (let index = 0; index < capped.length; index += 0x8000) binary += String.fromCharCode.apply(null, capped.subarray(index, index + 0x8000));
			value = { base64: btoa(binary) };
		}
		state.bodies.set(id, { value, contentType: contentType || "application/octet-stream", truncated: size > LIMIT, bytes: size, isText: textual(contentType) });
		while (state.bodies.size > 200) state.bodies.delete(state.bodies.keys().next().value);
	};
	// Read a response body incrementally, keeping at most LIMIT (+1 chunk) bytes and cancelling past it.
	const readBounded = async (id, response, contentType) => {
		const stream = response.body;
		if (!stream) { remember(id, new Uint8Array(0), contentType, 0); return; }
		const reader = stream.getReader();
		const chunks = [];
		let total = 0;
		let cut = false;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			total += value.byteLength;
			if (total > LIMIT) { cut = true; reader.cancel().catch(() => {}); break; }
		}
		const bytes = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
		const declared = Number(response.headers.get("content-length"));
		remember(id, bytes, contentType, cut && Number.isFinite(declared) ? declared : total);
	};
	const track = (id, reading) => {
		const settled = reading.catch(() => {}).finally(() => state.reading.delete(id));
		state.reading.set(id, settled);
	};
	// A captured body, awaiting a read still in progress.
	state.body = async id => {
		const reading = state.reading.get(id);
		if (reading) await reading;
		return state.bodies.get(id) || null;
	};
	const route = (url, type) => {
		for (const rule of state.config.routes) {
			if (rule.resourceTypes && !rule.resourceTypes.includes(type)) continue;
			try { if (new RegExp(rule.source, rule.flags).test(url)) return rule; } catch {}
		}
		return null;
	};
	const absolute = url => { try { return new URL(String(url), location.href).href; } catch { return String(url); } };
	const bodySize = body => {
		if (body == null) return 0;
		if (typeof body === "string") return new TextEncoder().encode(body).length;
		if (body.byteLength !== undefined) return body.byteLength;
		if (body.size !== undefined) return body.size;
		return 0;
	};
	const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
	const originalFetch = globalThis.fetch;
	if (typeof originalFetch === "function") {
		globalThis.fetch = async function (input, init) {
			// The request is built once and forwarded as is: building it consumes a body stream of \`input\`.
			const request = new Request(input, init);
			const id = doc + ":" + state.nextId++;
			const started = Date.now();
			const url = request.url;
			send({ kind: "request", id, method: request.method.toUpperCase(), url, resourceType: "fetch", headers: headerRecord(request.headers), bodySize: bodySize(init && init.body) });
			state.inflight++;
			try {
				if (state.config.emulation.offline) throw new TypeError("Load failed");
				const rule = route(url, "fetch");
				if (rule && rule.delay) await sleep(rule.delay);
				let response;
				if (rule && rule.abort) throw new TypeError("Load failed");
				if (rule && rule.fulfill) {
					const headers = new Headers(rule.fulfill.headers || {});
					if (rule.fulfill.contentType) headers.set("content-type", rule.fulfill.contentType);
					response = new Response(rule.fulfill.body == null ? null : rule.fulfill.body, { status: rule.fulfill.status, headers });
				} else {
					response = await originalFetch.call(this, request);
				}
				const headers = headerRecord(response.headers);
				track(id, readBounded(id, response.clone(), headers["content-type"]));
				send({ kind: "response", id, url: response.url || url, status: response.status, statusText: response.statusText, headers, durationMs: Date.now() - started, routed: !!rule });
				return response;
			} catch (error) {
				send({ kind: "requestfailed", id, url, error: String((error && error.message) || error), durationMs: Date.now() - started });
				throw error;
			} finally {
				state.inflight--;
			}
		};
	}
	const OriginalXHR = globalThis.XMLHttpRequest;
	if (typeof OriginalXHR === "function") {
		const open = OriginalXHR.prototype.open;
		const send0 = OriginalXHR.prototype.send;
		const setRequestHeader = OriginalXHR.prototype.setRequestHeader;
		const meta = new WeakMap();
		OriginalXHR.prototype.open = function (method, url, ...rest) {
			// Re-opening abandons the previous send without events: end its record here.
			const previous = meta.get(this);
			if (previous && previous.end) previous.end("aborted by open()");
			meta.set(this, { method: String(method || "GET").toUpperCase(), url: absolute(url), headers: {} });
			return open.call(this, method, url, ...rest);
		};
		OriginalXHR.prototype.setRequestHeader = function (name, value) {
			const info = meta.get(this);
			if (info) info.headers[String(name).toLowerCase()] = String(value);
			return setRequestHeader.call(this, name, value);
		};
		OriginalXHR.prototype.send = function (body) {
			const xhr = this;
			const info = meta.get(xhr) || { method: "GET", url: "", headers: {} };
			const id = doc + ":" + state.nextId++;
			const started = Date.now();
			send({ kind: "request", id, method: info.method, url: info.url, resourceType: "xhr", headers: info.headers, bodySize: bodySize(body) });
			state.inflight++;
			let settled = false;
			const finish = () => { if (!settled) { settled = true; state.inflight--; } };
			const rule = state.config.emulation.offline ? { abort: true } : route(info.url, "xhr");
			if (rule && (rule.abort || rule.fulfill)) {
				const fake = (name, value) => Object.defineProperty(xhr, name, { configurable: true, get: () => value });
				setTimeout(() => {
					if (rule.abort) {
						fake("readyState", 4);
						fake("status", 0);
						xhr.dispatchEvent(new Event("readystatechange"));
						xhr.dispatchEvent(new ProgressEvent("error"));
						xhr.dispatchEvent(new ProgressEvent("loadend"));
						send({ kind: "requestfailed", id, url: info.url, error: "Load failed", durationMs: Date.now() - started });
						finish();
						return;
					}
					const fulfill = rule.fulfill;
					const headers = {};
					for (const name of Object.keys(fulfill.headers || {})) headers[name.toLowerCase()] = String(fulfill.headers[name]);
					if (fulfill.contentType) headers["content-type"] = fulfill.contentType;
					const bodyText = fulfill.body == null ? "" : String(fulfill.body);
					fake("readyState", 4);
					fake("status", fulfill.status);
					fake("statusText", "");
					fake("responseURL", info.url);
					fake("responseText", bodyText);
					fake("response", xhr.responseType === "json" ? (() => { try { return JSON.parse(bodyText); } catch { return null; } })() : bodyText);
					xhr.getResponseHeader = name => headers[String(name).toLowerCase()] ?? null;
					xhr.getAllResponseHeaders = () => Object.keys(headers).map(name => name + ": " + headers[name]).join("\r\n");
					xhr.dispatchEvent(new Event("readystatechange"));
					xhr.dispatchEvent(new ProgressEvent("load"));
					xhr.dispatchEvent(new ProgressEvent("loadend"));
					send({ kind: "response", id, url: info.url, status: fulfill.status, statusText: "", headers, durationMs: Date.now() - started, routed: true });
					remember(id, new TextEncoder().encode(bodyText), headers["content-type"]);
					finish();
				}, rule.delay || 0);
				return;
			}
			const onLoadEnd = () => {
				info.end = undefined;
				if (xhr.status === 0) {
					send({ kind: "requestfailed", id, url: info.url, error: "Load failed", durationMs: Date.now() - started });
					finish();
					return;
				}
				const headers = {};
				for (const line of xhr.getAllResponseHeaders().trim().split(/[\r\n]+/)) {
					const index = line.indexOf(":");
					if (index > 0) headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
				}
				send({ kind: "response", id, url: xhr.responseURL || info.url, status: xhr.status, statusText: xhr.statusText, headers, durationMs: Date.now() - started, routed: false });
				try {
					if (xhr.responseType === "" || xhr.responseType === "text") remember(id, new TextEncoder().encode(xhr.responseText), headers["content-type"]);
					else if (xhr.responseType === "arraybuffer" && xhr.response) remember(id, new Uint8Array(xhr.response), headers["content-type"]);
					else if (xhr.responseType === "json") remember(id, new TextEncoder().encode(JSON.stringify(xhr.response)), headers["content-type"]);
				} catch {}
				finish();
			};
			info.end = reason => {
				info.end = undefined;
				xhr.removeEventListener("loadend", onLoadEnd);
				send({ kind: "requestfailed", id, url: info.url, error: reason, durationMs: Date.now() - started });
				finish();
			};
			xhr.addEventListener("loadend", onLoadEnd, { once: true });
			const run = () => send0.call(xhr, body);
			if (rule && rule.delay) setTimeout(run, rule.delay);
			else return run();
		};
	}

	// Emulation: geolocation, locale, offline.
	const emulation = () => state.config.emulation;
	const onLine = Object.getOwnPropertyDescriptor(Navigator.prototype, "onLine");
	if (onLine && onLine.get) {
		Object.defineProperty(Navigator.prototype, "onLine", { configurable: true, get() { return emulation().offline ? false : onLine.get.call(this); } });
	}
	for (const name of ["language", "languages"]) {
		const descriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, name);
		if (!descriptor || !descriptor.get) continue;
		Object.defineProperty(Navigator.prototype, name, {
			configurable: true,
			get() {
				const locale = emulation().locale;
				if (!locale) return descriptor.get.call(this);
				return name === "language" ? locale : Object.freeze([locale]);
			},
		});
	}
	const localized = locales => (locales === undefined && emulation().locale ? emulation().locale : locales);
	for (const name of ["DateTimeFormat", "NumberFormat", "Collator", "PluralRules", "RelativeTimeFormat", "ListFormat", "DisplayNames", "Segmenter"]) {
		const Original = Intl[name];
		if (typeof Original !== "function") continue;
		const Wrapped = new Proxy(Original, {
			construct(target, args, newTarget) { args[0] = localized(args[0]); return Reflect.construct(target, args, newTarget); },
			apply(target, self, args) { args[0] = localized(args[0]); return Reflect.apply(target, self, args); },
		});
		Object.defineProperty(Intl, name, { configurable: true, writable: true, value: Wrapped });
	}
	for (const [proto, names] of [[Date.prototype, ["toLocaleString", "toLocaleDateString", "toLocaleTimeString"]], [Number.prototype, ["toLocaleString"]], [String.prototype, ["localeCompare"]], [Array.prototype, ["toLocaleString"]]]) {
		for (const name of names) {
			const original = proto[name];
			const localeIndex = name === "localeCompare" ? 1 : 0;
			Object.defineProperty(proto, name, {
				configurable: true,
				writable: true,
				value: function (...args) { args[localeIndex] = localized(args[localeIndex]); return original.apply(this, args); },
			});
		}
	}
	if (globalThis.Geolocation && Geolocation.prototype) {
		const proto = Geolocation.prototype;
		const getCurrentPosition = proto.getCurrentPosition;
		const watchPosition = proto.watchPosition;
		const clearWatch = proto.clearWatch;
		const position = () => {
			const coords = emulation().geolocation;
			return {
				coords: { latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy ?? 1, altitude: null, altitudeAccuracy: null, heading: null, speed: null },
				timestamp: Date.now(),
			};
		};
		let nextWatch = 1;
		proto.getCurrentPosition = function (success, error, options) {
			if (!emulation().geolocation) return getCurrentPosition.call(this, success, error, options);
			setTimeout(() => success(position()), 0);
		};
		proto.watchPosition = function (success, error, options) {
			if (!emulation().geolocation) return watchPosition.call(this, success, error, options);
			setTimeout(() => success(position()), 0);
			return -(nextWatch++);
		};
		proto.clearWatch = function (id) {
			if (id < 0) return;
			return clearWatch.call(this, id);
		};
	}
	return true;
}`;

/** The document-start script installing the capture with `config` in every new document. */
export function ternCaptureScript(config: TernCaptureConfig): string {
	return `(${TERN_CAPTURE_INSTALLER})(${JSON.stringify(config)});`;
}
