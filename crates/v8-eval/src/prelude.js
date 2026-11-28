"use strict";

(({
	text: rawText,
	display: rawDisplay,
	callTool: rawCallTool,
	urlRead: rawUrlRead,
	urlWrite: rawUrlWrite,
	setFinalExpr: rawSetFinalExpr,
	utf8Encode: rawUtf8Encode,
	utf8Decode: rawUtf8Decode,
}) => {
	delete globalThis.WebAssembly;

	const ReflectConstruct = Reflect.construct;
	const ObjectDefineProperty = Object.defineProperty;
	const guardBufferConstructor = (OrigCtor, label) => {
		const Guarded = new Proxy(OrigCtor, {
			construct(target, args, newTarget) {
				if (args.length > 1 && args[1] !== undefined) {
					throw new RangeError(`${label} options (resizable/growable buffers) are not supported in V8 sandbox`);
				}
				return ReflectConstruct(target, [args[0]], newTarget === Guarded ? target : newTarget);
			},
		});
		try {
			ObjectDefineProperty(Guarded, Symbol.species, { get: () => Guarded, configurable: false });
		} catch {
			// Ignore if non-configurable.
		}
		if (OrigCtor.prototype) {
			ObjectDefineProperty(OrigCtor.prototype, "constructor", {
				value: Guarded,
				writable: false,
				configurable: false,
			});
		}
		return Guarded;
	};

	for (const [name, method] of [
		["ArrayBuffer", "resize"],
		["SharedArrayBuffer", "grow"],
	]) {
		const Orig = globalThis[name];
		if (typeof Orig !== "function") continue;
		if (Orig.prototype && method in Orig.prototype) delete Orig.prototype[method];
		globalThis[name] = guardBufferConstructor(Orig, name);
	}

	const isNil = value => value === undefined || value === null;
	const isPlainObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

	const toUint8Array = data => {
		if (data instanceof Uint8Array) return data;
		if (data instanceof ArrayBuffer) return new Uint8Array(data);
		if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
		return null;
	};

	const validateReadInt = (val, min) => {
		if (isNil(val)) return undefined;
		if (typeof val !== "number" || !Number.isInteger(val) || val < min) {
			throw new TypeError("read() options offset (>= 1) and limit (>= 0) must be integers");
		}
		return val;
	};

	const parseReadOptions = (value, rest) => {
		if (isPlainObject(value)) {
			if (rest.some(arg => !isNil(arg))) {
				throw new TypeError(
					"read() takes either a single trailing options object like { offset, limit } or positional optional args; do not mix both forms.",
				);
			}
			return [validateReadInt(value.offset, 1), validateReadInt(value.limit, 0)];
		}
		if (!isNil(value) && typeof value === "object") {
			const kind = Array.isArray(value) ? "an array" : (value.constructor?.name ?? "object");
			throw new TypeError(
				`read() options must be a plain object like { offset, limit }, null/undefined, or positional optional args, not ${kind}.`,
			);
		}
		const args = [value, ...rest];
		for (let i = 2; i < args.length; i++) {
			if (!isNil(args[i])) {
				throw new TypeError(
					`read() accepts at most 2 positional optional args; got ${args.length}. Pass read(..., { offset, limit }) for named options.`,
				);
			}
		}
		return [validateReadInt(args[0], 1), validateReadInt(args[1], 0)];
	};

	const btoa = data => {
		const str = String(data);
		const bytes = new Uint8Array(str.length);
		for (let i = 0; i < str.length; i++) {
			const code = str.charCodeAt(i);
			if (code > 0xff) {
				throw new RangeError("The string to be encoded contains characters outside of the Latin1 range.");
			}
			bytes[i] = code;
		}
		return bytes.toBase64();
	};

	const atob = encoded => {
		let bytes;
		try {
			bytes = Uint8Array.fromBase64(String(encoded), { lastChunkHandling: "loose" });
		} catch {
			const err = new Error("The string to be decoded is not correctly encoded.");
			err.name = "InvalidCharacterError";
			throw err;
		}
		let out = "";
		for (let i = 0; i < bytes.length; i += 8192) {
			out += String.fromCharCode(...bytes.subarray(i, i + 8192));
		}
		return out;
	};

	class TextEncoder {
		get encoding() {
			return "utf-8";
		}

		encode(input = "") {
			return rawUtf8Encode(String(input));
		}

		encodeInto(source, destination) {
			if (!(destination instanceof Uint8Array)) {
				throw new TypeError("TextEncoder.encodeInto() destination must be a Uint8Array");
			}
			const str = String(source);
			const full = rawUtf8Encode(str);
			if (full.length <= destination.length) {
				destination.set(full);
				return { read: str.length, written: full.length };
			}
			let read = 0;
			let written = 0;
			for (const ch of str) {
				const bytes = rawUtf8Encode(ch);
				if (written + bytes.length > destination.length) break;
				destination.set(bytes, written);
				written += bytes.length;
				read += ch.length;
			}
			return { read, written };
		}
	}

	class TextDecoder {
		constructor(label = "utf-8", options = {}) {
			const norm = String(label).trim().toLowerCase();
			if (norm !== "utf-8" && norm !== "utf8" && norm !== "unicode-1-1-utf-8") {
				throw new RangeError(`TextDecoder in V8 sandbox only supports utf-8 (got ${label})`);
			}
			this.encoding = "utf-8";
			this.fatal = Boolean(options?.fatal);
			this.ignoreBOM = Boolean(options?.ignoreBOM);
		}

		decode(input) {
			if (input === undefined) return "";
			const bytes = toUint8Array(input);
			if (!bytes) throw new TypeError("TextDecoder.decode() expects an ArrayBuffer or ArrayBufferView");
			return rawUtf8Decode(bytes, this.fatal, this.ignoreBOM);
		}
	}

	const BASE64_STRICT_RE = /^[A-Za-z0-9+/]+={0,2}$/;
	const JSON_VIEW_MIN_CHARS = 80;
	const JSON_TEXT_VIEW_MAX_CHARS = 32 * 1024;
	const JSON_TEXT_START = /^\s*[[{]/;

	const coerceImageBase64 = data => {
		if (typeof data === "string") {
			const trimmed = data.trim();
			return trimmed.length > 0 && trimmed.length % 4 === 0 && BASE64_STRICT_RE.test(trimmed) ? trimmed : null;
		}
		const bytes = toUint8Array(data);
		if (bytes) return bytes.toBase64();
		if (Array.isArray(data) && data.every(n => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 255)) {
			return Uint8Array.from(data).toBase64();
		}
		return null;
	};

	const formatBlock = (open, close, items, depth) => {
		const single = `${open} ${items.join(", ")} ${close}`;
		if (single.length <= 120 && !single.includes("\n")) return single;
		const indent = "  ".repeat(depth + 1);
		const closeIndent = "  ".repeat(depth);
		return `${open}\n${items.map(item => `${indent}${item}`).join(",\n")}\n${closeIndent}${close}`;
	};

	const inspectValue = (value, depth = 0, seen = new WeakSet()) => {
		if (value === null) return "null";
		if (value === undefined) return "undefined";
		const kind = typeof value;
		if (kind === "boolean" || kind === "number") return String(value);
		if (kind === "bigint") return `${value}n`;
		if (kind === "symbol") return value.toString();
		if (kind === "function") return `[Function: ${value.name || "anonymous"}]`;
		if (kind === "string") return depth === 0 ? value : JSON.stringify(value);
		if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
		if (value instanceof RegExp) return value.toString();
		if (value instanceof Date) return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
		if (seen.has(value)) return "[Circular]";
		seen.add(value);
		try {
			if (depth >= 6) return Array.isArray(value) ? `[Array(${value.length})]` : "[Object]";
			if (Array.isArray(value)) {
				if (value.length === 0) return "[]";
				const items = value.slice(0, 100).map(item => inspectValue(item, depth + 1, seen));
				if (value.length > 100) items.push(`... ${value.length - 100} more items`);
				return formatBlock("[", "]", items, depth);
			}
			if (value instanceof Map) {
				const entries = [];
				for (const [k, v] of value) {
					entries.push(`${inspectValue(k, depth + 1, seen)} => ${inspectValue(v, depth + 1, seen)}`);
					if (entries.length >= 100) break;
				}
				return `Map(${value.size}) { ${entries.join(", ")} }`;
			}
			if (value instanceof Set) {
				const entries = [];
				for (const v of value) {
					entries.push(inspectValue(v, depth + 1, seen));
					if (entries.length >= 100) break;
				}
				return `Set(${value.size}) { ${entries.join(", ")} }`;
			}
			if (ArrayBuffer.isView(value)) {
				const name = value.constructor?.name ?? "TypedArray";
				const preview = Array.from(value.subarray ? value.subarray(0, 32) : []).join(", ");
				return `${name}(${value.length ?? value.byteLength}) [ ${preview}${value.length > 32 ? ", ..." : ""} ]`;
			}
			if (value instanceof ArrayBuffer) return `ArrayBuffer { byteLength: ${value.byteLength} }`;
			const keys = Object.keys(value);
			if (keys.length === 0) return "{}";
			const entries = keys
				.slice(0, 100)
				.map(k => `${/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k)}: ${inspectValue(value[k], depth + 1, seen)}`);
			if (keys.length > 100) entries.push(`... ${keys.length - 100} more keys`);
			return formatBlock("{", "}", entries, depth);
		} finally {
			seen.delete(value);
		}
	};

	const isPlainStructure = value => {
		if (Array.isArray(value)) return true;
		const proto = Object.getPrototypeOf(value);
		return proto === Object.prototype || proto === null;
	};

	const toJsonValue = value => {
		try {
			const serialized = JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
			return serialized === undefined ? undefined : JSON.parse(serialized);
		} catch {
			return undefined;
		}
	};

	const jsonTextView = text => {
		if (text.length <= JSON_VIEW_MIN_CHARS && !text.includes("\n")) return undefined;
		if (text.length > JSON_TEXT_VIEW_MAX_CHARS || !JSON_TEXT_START.test(text)) return undefined;
		try {
			return { type: "view", text, view: { kind: "json", value: JSON.parse(text) } };
		} catch {
			return undefined;
		}
	};

	const formatConsoleArg = arg => {
		if (typeof arg === "string") {
			const output = jsonTextView(arg);
			return output ? { text: arg, output } : { text: arg };
		}
		if (isPlainObject(arg) && arg.type === "image" && typeof arg.mimeType === "string") {
			const data = coerceImageBase64(arg.data);
			if (data !== null) {
				const output = { type: "image", data, mimeType: arg.mimeType };
				if (typeof arg.label === "string") output.label = arg.label;
				return { text: `<image ${arg.mimeType}>`, output };
			}
		}
		const text = inspectValue(arg, 1);
		if (
			arg !== null &&
			typeof arg === "object" &&
			isPlainStructure(arg) &&
			(text.length > JSON_VIEW_MIN_CHARS || text.includes("\n"))
		) {
			const value = toJsonValue(arg);
			if (value !== undefined) return { text, output: { type: "view", text, view: { kind: "json", value } } };
		}
		return { text };
	};

	const logConsoleArgs = (level, args) => {
		const pieces = args.map(formatConsoleArg);
		const prefix = level === "error" ? "[error] " : level === "warn" ? "[warn] " : "";
		const text = `${prefix}${pieces.map(piece => piece.text).join(" ")}`;
		rawText(text.endsWith("\n") ? text : `${text}\n`);
		for (const piece of pieces) {
			if (piece.output) rawDisplay(piece.output);
		}
	};

	const NUMERIC_CELL_RE = /^[-+]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?|\d+n|Infinity)$|^NaN$/;

	const formatTable = (data, columnsFilter) => {
		if (data === null || typeof data !== "object") {
			logConsoleArgs("log", [data]);
			return;
		}
		const entries = Array.isArray(data) ? data.map((v, i) => [String(i), v]) : Object.entries(data);
		if (entries.length === 0) {
			rawText("(empty)\n");
			return;
		}
		const colSet = new Set();
		let hasPrimitives = false;
		for (const [, row] of entries) {
			if (row !== null && typeof row === "object" && !Array.isArray(row)) {
				for (const k of Object.keys(row)) colSet.add(k);
			} else if (Array.isArray(row)) {
				for (let i = 0; i < row.length; i++) colSet.add(String(i));
			} else {
				hasPrimitives = true;
			}
		}
		const cols = Array.isArray(columnsFilter)
			? columnsFilter.map(String)
			: hasPrimitives && colSet.size === 0
				? ["Values"]
				: [...colSet];
		const heads = ["(index)", ...cols];
		const rows = entries.map(([idx, row]) =>
			hasPrimitives && colSet.size === 0
				? [idx, inspectValue(row, 1)]
				: [idx, ...cols.map(col => (row !== null && typeof row === "object" && Object.hasOwn(row, col) ? inspectValue(row[col], 1) : ""))],
		);
		const widths = heads.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
		const border = (l, m, r) => `${l}${widths.map(w => "─".repeat(w + 2)).join(m)}${r}`;
		const renderRow = cells => `│ ${cells.map((c, i) => c.padEnd(widths[i])).join(" │ ")} │`;
		const buffer = `${[border("┌", "┬", "┐"), renderRow(heads), border("├", "┼", "┤"), ...rows.map(renderRow), border("└", "┴", "┘")].join("\n")}\n`;
		rawText(buffer);
		const viewCols = heads.map((head, i) => {
			const column = { head: head === "(index)" ? "" : head };
			const nonEmpty = rows.map(r => r[i]).filter(Boolean);
			if (nonEmpty.length > 0 && nonEmpty.every(cell => NUMERIC_CELL_RE.test(cell))) column.numeric = true;
			return column;
		});
		rawDisplay({ type: "view", text: buffer, view: { kind: "table", columns: viewCols, rows } });
	};

	const consoleTimers = new Map();
	const consoleCounts = new Map();
	const logLine = (...args) => logConsoleArgs("log", args);
	const logGroup = (...args) => {
		if (args.length > 0) logConsoleArgs("log", args);
	};
	const reportTimer = (label, remove, extra) => {
		const key = String(label ?? "default");
		const start = consoleTimers.get(key);
		if (start === undefined) {
			logConsoleArgs("warn", [`Timer '${key}' does not exist`]);
			return;
		}
		if (remove) consoleTimers.delete(key);
		logConsoleArgs("log", [`${key}: ${Date.now() - start}ms`, ...extra]);
	};

	const consoleBridge = {
		log: logLine,
		info: logLine,
		debug: logLine,
		dirxml: logLine,
		warn: (...args) => logConsoleArgs("warn", args),
		error: (...args) => logConsoleArgs("error", args),
		table: formatTable,
		dir: value => logConsoleArgs("log", [value]),
		trace: (...args) => {
			const stack = (new Error().stack ?? "").split("\n").slice(2).join("\n");
			logConsoleArgs("log", [args.length > 0 ? `Trace: ${args.map(a => inspectValue(a, 0)).join(" ")}` : "Trace", `\n${stack}`]);
		},
		assert: (condition, ...args) => {
			if (!condition) logConsoleArgs("error", args.length > 0 ? ["Assertion failed:", ...args] : ["Assertion failed"]);
		},
		group: logGroup,
		groupCollapsed: logGroup,
		groupEnd: () => {},
		time: label => consoleTimers.set(String(label ?? "default"), Date.now()),
		timeLog: (label, ...args) => reportTimer(label, false, args),
		timeEnd: label => reportTimer(label, true, []),
		count: label => {
			const key = String(label ?? "default");
			const next = (consoleCounts.get(key) ?? 0) + 1;
			consoleCounts.set(key, next);
			logConsoleArgs("log", [`${key}: ${next}`]);
		},
		countReset: label => consoleCounts.delete(String(label ?? "default")),
	};

	const log = message => rawDisplay({ type: "status", event: { op: "log", message: String(message) } });

	const phase = title => {
		globalThis.__omp_phase__ = String(title);
		rawDisplay({ type: "status", event: { op: "phase", title: String(title) } });
	};

	const envStore = new Map();
	function env(key, value) {
		if (key === undefined) return Object.fromEntries(envStore);
		const name = String(key);
		if (value === undefined && arguments.length < 2) return envStore.get(name);
		if (value === undefined || value === null) {
			envStore.delete(name);
			return undefined;
		}
		const text = String(value);
		envStore.set(name, text);
		return text;
	}

	const read = async (path, opts, ...rest) => {
		const [offset, limit] = parseReadOptions(opts, rest);
		return await rawUrlRead(String(path), offset, limit);
	};

	const write = async (path, data) => {
		if (typeof data === "string") return await rawUrlWrite(String(path), data, "utf8");
		const bytes = toUint8Array(data);
		if (bytes) return await rawUrlWrite(String(path), bytes.toBase64(), "base64");
		throw new TypeError("write() expects string, ArrayBuffer, or ArrayBufferView data");
	};

	const tool = new Proxy(Object.create(null), {
		get(_target, prop) {
			if (typeof prop !== "string" || prop === "then" || prop === "toJSON") return undefined;
			return async args => await rawCallTool(prop, args ?? {});
		},
	});

	Object.assign(globalThis, {
		console: consoleBridge,
		print: logLine,
		log,
		phase,
		env,
		read,
		write,
		tool,
		btoa,
		atob,
		TextEncoder,
		TextDecoder,
		__omp_set_final_expr__: rawSetFinalExpr,
	});

	// Warm up V8 PRNG and stack-trace symbolization before OS sandbox drops FS access.
	void Math.random();
	void new Error().stack;

	return value => {
		if (value !== undefined) logLine(value);
	};
})
