(() => {
	"use strict";

	const rawText = globalThis.__v8_text;
	const rawDisplay = globalThis.__v8_display;
	const rawCallTool = globalThis.__v8_call_tool;
	const rawUrlRead = globalThis.__v8_url_read;
	const rawUrlWrite = globalThis.__v8_url_write;
	const rawSetFinalExpr = globalThis.__v8_set_final_expr;

	delete globalThis.__v8_text;
	delete globalThis.__v8_display;
	delete globalThis.__v8_call_tool;
	delete globalThis.__v8_url_read;
	delete globalThis.__v8_url_write;
	delete globalThis.__v8_set_final_expr;

	delete globalThis.WebAssembly;

	const guardBufferConstructor = (OrigCtor, label) => {
		if (typeof OrigCtor !== "function") return OrigCtor;
		const Guarded = new Proxy(OrigCtor, {
			construct(target, args, newTarget) {
				if (args.length > 1 && args[1] !== undefined) {
					throw new RangeError(`${label} options (resizable/growable buffers) are not supported in V8 sandbox`);
				}
				return Reflect.construct(target, [args[0]], newTarget === Guarded ? target : newTarget);
			},
		});
		try {
			Object.defineProperty(Guarded, Symbol.species, { get: () => Guarded, configurable: false });
		} catch {
			// Ignore if non-configurable.
		}
		if (OrigCtor.prototype) {
			Object.defineProperty(OrigCtor.prototype, "constructor", {
				value: Guarded,
				writable: false,
				configurable: false,
			});
		}
		return Guarded;
	};

	if (typeof globalThis.ArrayBuffer === "function") {
		const OrigArrayBuffer = globalThis.ArrayBuffer;
		if (OrigArrayBuffer.prototype && "resize" in OrigArrayBuffer.prototype) {
			delete OrigArrayBuffer.prototype.resize;
		}
		globalThis.ArrayBuffer = guardBufferConstructor(OrigArrayBuffer, "ArrayBuffer");
	}
	if (typeof globalThis.SharedArrayBuffer === "function") {
		const OrigSharedArrayBuffer = globalThis.SharedArrayBuffer;
		if (OrigSharedArrayBuffer.prototype && "grow" in OrigSharedArrayBuffer.prototype) {
			delete OrigSharedArrayBuffer.prototype.grow;
		}
		globalThis.SharedArrayBuffer = guardBufferConstructor(OrigSharedArrayBuffer, "SharedArrayBuffer");
	}

	const isNil = value => value === undefined || value === null;
	const isPlainObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

	const positionalOptions = (name, args, keys, example) => {
		for (let index = keys.length; index < args.length; index++) {
			if (!isNil(args[index])) {
				throw new TypeError(
					`${name}() accepts at most ${keys.length} positional optional args; got ${args.length}. Pass ${name}(..., ${example}) for named options.`,
				);
			}
		}
		const options = {};
		for (let index = 0; index < keys.length && index < args.length; index++) {
			const value = args[index];
			if (!isNil(value)) options[keys[index]] = value;
		}
		return options;
	};

	const optionsArg = (name, value, rest, keys, example) => {
		if (isNil(value)) return positionalOptions(name, [value, ...rest], keys, example);
		if (isPlainObject(value)) {
			if (rest.some(arg => !isNil(arg))) {
				throw new TypeError(
					`${name}() takes either a single trailing options object like ${example} or positional optional args; do not mix both forms.`,
				);
			}
			return value;
		}
		if (typeof value === "object") {
			const kind = Array.isArray(value) ? "an array" : (value.constructor?.name ?? "object");
			throw new TypeError(
				`${name}() options must be a plain object like ${example}, null/undefined, or positional optional args, not ${kind}.`,
			);
		}
		return positionalOptions(name, [value, ...rest], keys, example);
	};

	const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	const BASE64_LOOKUP = new Int16Array(128).fill(-1);
	for (let i = 0; i < BASE64_ALPHABET.length; i++) {
		BASE64_LOOKUP[BASE64_ALPHABET.charCodeAt(i)] = i;
	}

	const encodeBase64Bytes = bytes => {
		let out = "";
		for (let i = 0; i < bytes.length; i += 3) {
			const b0 = bytes[i];
			const has1 = i + 1 < bytes.length;
			const has2 = i + 2 < bytes.length;
			const b1 = has1 ? bytes[i + 1] : 0;
			const b2 = has2 ? bytes[i + 2] : 0;
			const n = (b0 << 16) | (b1 << 8) | b2;
			out += BASE64_ALPHABET[(n >> 18) & 63];
			out += BASE64_ALPHABET[(n >> 12) & 63];
			out += has1 ? BASE64_ALPHABET[(n >> 6) & 63] : "=";
			out += has2 ? BASE64_ALPHABET[n & 63] : "=";
		}
		return out;
	};

	const decodeBase64Bytes = input => {
		const cleaned = String(input).replace(/[\t\n\f\r ]+/g, "");
		if (cleaned.length % 4 === 1) {
			const err = new Error("The string to be decoded is not correctly encoded.");
			err.name = "InvalidCharacterError";
			throw err;
		}
		const padLen = cleaned.endsWith("==") ? 2 : cleaned.endsWith("=") ? 1 : 0;
		const bodyLen = cleaned.length - padLen;
		const out = new Uint8Array(Math.floor((cleaned.length * 3) / 4) - padLen);
		let outIdx = 0;
		for (let i = 0; i < cleaned.length; i += 4) {
			const c0 = cleaned.charCodeAt(i);
			const c1 = cleaned.charCodeAt(i + 1);
			const v0 = c0 < 128 ? BASE64_LOOKUP[c0] : -1;
			const v1 = c1 < 128 ? BASE64_LOOKUP[c1] : -1;
			if (v0 < 0 || v1 < 0) {
				const err = new Error("The string to be decoded is not correctly encoded.");
				err.name = "InvalidCharacterError";
				throw err;
			}
			const c2 = i + 2 < bodyLen ? cleaned.charCodeAt(i + 2) : -1;
			const c3 = i + 3 < bodyLen ? cleaned.charCodeAt(i + 3) : -1;
			const v2 = c2 === -1 ? 0 : c2 < 128 ? BASE64_LOOKUP[c2] : -1;
			const v3 = c3 === -1 ? 0 : c3 < 128 ? BASE64_LOOKUP[c3] : -1;
			if (v2 < 0 || v3 < 0) {
				const err = new Error("The string to be decoded is not correctly encoded.");
				err.name = "InvalidCharacterError";
				throw err;
			}
			const n = (v0 << 18) | (v1 << 12) | (v2 << 6) | v3;
			out[outIdx++] = (n >> 16) & 0xff;
			if (c2 !== -1) out[outIdx++] = (n >> 8) & 0xff;
			if (c3 !== -1) out[outIdx++] = n & 0xff;
		}
		return out;
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
		return encodeBase64Bytes(bytes);
	};

	const atob = encoded => {
		const bytes = decodeBase64Bytes(encoded);
		let out = "";
		for (let i = 0; i < bytes.length; i++) {
			out += String.fromCharCode(bytes[i]);
		}
		return out;
	};

	class TextEncoder {
		get encoding() {
			return "utf-8";
		}

		encode(input = "") {
			const str = String(input);
			const out = [];
			for (let i = 0; i < str.length; i++) {
				let cp = str.charCodeAt(i);
				if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < str.length) {
					const low = str.charCodeAt(i + 1);
					if (low >= 0xdc00 && low <= 0xdfff) {
						cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
						i++;
					} else {
						cp = 0xfffd;
					}
				} else if (cp >= 0xd800 && cp <= 0xdfff) {
					cp = 0xfffd;
				}
				if (cp <= 0x7f) {
					out.push(cp);
				} else if (cp <= 0x7ff) {
					out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
				} else if (cp <= 0xffff) {
					out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
				} else {
					out.push(
						0xf0 | (cp >> 18),
						0x80 | ((cp >> 12) & 0x3f),
						0x80 | ((cp >> 6) & 0x3f),
						0x80 | (cp & 0x3f),
					);
				}
			}
			return new Uint8Array(out);
		}

		encodeInto(source, destination) {
			if (!(destination instanceof Uint8Array)) {
				throw new TypeError("TextEncoder.encodeInto() destination must be a Uint8Array");
			}
			const str = String(source);
			let read = 0;
			let written = 0;
			for (let i = 0; i < str.length; i++) {
				const code = str.charCodeAt(i);
				let cp = code;
				let units = 1;
				if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
					const low = str.charCodeAt(i + 1);
					if (low >= 0xdc00 && low <= 0xdfff) {
						cp = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
						units = 2;
					} else {
						cp = 0xfffd;
					}
				} else if (code >= 0xd800 && code <= 0xdfff) {
					cp = 0xfffd;
				}
				const need = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
				if (written + need > destination.length) break;
				if (need === 1) {
					destination[written++] = cp;
				} else if (need === 2) {
					destination[written++] = 0xc0 | (cp >> 6);
					destination[written++] = 0x80 | (cp & 0x3f);
				} else if (need === 3) {
					destination[written++] = 0xe0 | (cp >> 12);
					destination[written++] = 0x80 | ((cp >> 6) & 0x3f);
					destination[written++] = 0x80 | (cp & 0x3f);
				} else {
					destination[written++] = 0xf0 | (cp >> 18);
					destination[written++] = 0x80 | ((cp >> 12) & 0x3f);
					destination[written++] = 0x80 | ((cp >> 6) & 0x3f);
					destination[written++] = 0x80 | (cp & 0x3f);
				}
				read += units;
				if (units === 2) i++;
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
			let bytes;
			if (input instanceof ArrayBuffer) {
				bytes = new Uint8Array(input);
			} else if (ArrayBuffer.isView(input)) {
				bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
			} else {
				throw new TypeError("TextDecoder.decode() expects an ArrayBuffer or ArrayBufferView");
			}
			let i = 0;
			if (!this.ignoreBOM && bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
				i = 3;
			}
			let out = "";
			const fail = () => {
				if (this.fatal) throw new TypeError("The encoded data was not valid.");
				out += "\ufffd";
			};
			while (i < bytes.length) {
				const b0 = bytes[i++];
				if (b0 <= 0x7f) {
					out += String.fromCharCode(b0);
				} else if (b0 >= 0xc2 && b0 <= 0xdf) {
					if (i >= bytes.length || (bytes[i] & 0xc0) !== 0x80) {
						fail();
						continue;
					}
					const b1 = bytes[i++];
					out += String.fromCharCode(((b0 & 0x1f) << 6) | (b1 & 0x3f));
				} else if (b0 >= 0xe0 && b0 <= 0xef) {
					if (i + 1 >= bytes.length) {
						fail();
						i = bytes.length;
						continue;
					}
					const b1 = bytes[i];
					const b2 = bytes[i + 1];
					const valid =
						(b1 & 0xc0) === 0x80 &&
						(b2 & 0xc0) === 0x80 &&
						!(b0 === 0xe0 && b1 < 0xa0) &&
						!(b0 === 0xed && b1 >= 0xa0);
					if (!valid) {
						fail();
						continue;
					}
					i += 2;
					out += String.fromCharCode(((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f));
				} else if (b0 >= 0xf0 && b0 <= 0xf4) {
					if (i + 2 >= bytes.length) {
						fail();
						i = bytes.length;
						continue;
					}
					const b1 = bytes[i];
					const b2 = bytes[i + 1];
					const b3 = bytes[i + 2];
					const valid =
						(b1 & 0xc0) === 0x80 &&
						(b2 & 0xc0) === 0x80 &&
						(b3 & 0xc0) === 0x80 &&
						!(b0 === 0xf0 && b1 < 0x90) &&
						!(b0 === 0xf4 && b1 > 0x8f);
					if (!valid) {
						fail();
						continue;
					}
					i += 3;
					const cp = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
					out += String.fromCodePoint(cp);
				} else {
					fail();
				}
			}
			return out;
		}
	}

	const BASE64_STRICT_RE = /^[A-Za-z0-9+/]+={0,2}$/;
	const JSON_VIEW_MIN_CHARS = 80;
	const JSON_TEXT_VIEW_MAX_CHARS = 32 * 1024;
	const JSON_TEXT_START = /^\s*[[{]/;

	const coerceImageBase64 = data => {
		if (typeof data === "string") {
			const trimmed = data.trim();
			if (trimmed.length === 0 || trimmed.length % 4 !== 0 || !BASE64_STRICT_RE.test(trimmed)) return null;
			return trimmed;
		}
		if (data instanceof Uint8Array) return encodeBase64Bytes(data);
		if (data instanceof ArrayBuffer) return encodeBase64Bytes(new Uint8Array(data));
		if (ArrayBuffer.isView(data)) return encodeBase64Bytes(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
		if (Array.isArray(data) && data.every(n => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 255)) {
			return encodeBase64Bytes(Uint8Array.from(data));
		}
		return null;
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
			if (depth >= 6) {
				if (Array.isArray(value)) return `[Array(${value.length})]`;
				return `[Object]`;
			}
			if (Array.isArray(value)) {
				if (value.length === 0) return "[]";
				const items = value.slice(0, 100).map(item => inspectValue(item, depth + 1, seen));
				if (value.length > 100) items.push(`... ${value.length - 100} more items`);
				const single = `[ ${items.join(", ")} ]`;
				if (single.length <= 120 && !single.includes("\n")) return single;
				const indent = "  ".repeat(depth + 1);
				const closeIndent = "  ".repeat(depth);
				return `[\n${items.map(item => `${indent}${item}`).join(",\n")}\n${closeIndent}]`;
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
			if (value instanceof ArrayBuffer) {
				return `ArrayBuffer { byteLength: ${value.byteLength} }`;
			}
			const keys = Object.keys(value);
			if (keys.length === 0) return "{}";
			const entries = keys.slice(0, 100).map(k => `${/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k)}: ${inspectValue(value[k], depth + 1, seen)}`);
			if (keys.length > 100) entries.push(`... ${keys.length - 100} more keys`);
			const single = `{ ${entries.join(", ")} }`;
			if (single.length <= 120 && !single.includes("\n")) return single;
			const indent = "  ".repeat(depth + 1);
			const closeIndent = "  ".repeat(depth);
			return `{\n${entries.map(entry => `${indent}${entry}`).join(",\n")}\n${closeIndent}}`;
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
		const rows = entries.map(([idx, row]) => {
			if (hasPrimitives && colSet.size === 0) {
				return [idx, inspectValue(row, 1)];
			}
			return [
				idx,
				...cols.map(col => {
					if (row !== null && typeof row === "object" && Object.hasOwn(row, col)) {
						return inspectValue(row[col], 1);
					}
					return "";
				}),
			];
		});
		const widths = heads.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
		const border = (l, m, r) => `${l}${widths.map(w => "─".repeat(w + 2)).join(m)}${r}`;
		const renderRow = cells => `│ ${cells.map((c, i) => c.padEnd(widths[i])).join(" │ ")} │`;
		const lines = [
			border("┌", "┬", "┐"),
			renderRow(heads),
			border("├", "┼", "┤"),
			...rows.map(renderRow),
			border("└", "┴", "┘"),
		];
		const buffer = `${lines.join("\n")}\n`;
		rawText(buffer);
		const viewCols = heads.map((head, i) => {
			const column = { head: head === "(index)" ? "" : head };
			let saw = false;
			let numeric = true;
			for (const row of rows) {
				const cell = row[i];
				if (cell === "") continue;
				saw = true;
				if (!NUMERIC_CELL_RE.test(cell)) {
					numeric = false;
					break;
				}
			}
			if (saw && numeric) column.numeric = true;
			return column;
		});
		rawDisplay({ type: "view", text: buffer, view: { kind: "table", columns: viewCols, rows } });
	};

	const consoleTimers = new Map();
	const consoleCounts = new Map();
	const consoleBridge = {
		log: (...args) => logConsoleArgs("log", args),
		info: (...args) => logConsoleArgs("info", args),
		warn: (...args) => logConsoleArgs("warn", args),
		error: (...args) => logConsoleArgs("error", args),
		debug: (...args) => logConsoleArgs("debug", args),
		table: (data, columns) => formatTable(data, columns),
		dir: value => logConsoleArgs("log", [value]),
		dirxml: (...args) => logConsoleArgs("log", args),
		trace: (...args) => {
			const stack = (new Error().stack ?? "").split("\n").slice(2).join("\n");
			logConsoleArgs("log", [args.length > 0 ? `Trace: ${args.map(a => inspectValue(a, 0)).join(" ")}` : "Trace", `\n${stack}`]);
		},
		assert: (condition, ...args) => {
			if (condition) return;
			if (args.length > 0) logConsoleArgs("error", ["Assertion failed:", ...args]);
			else logConsoleArgs("error", ["Assertion failed"]);
		},
		group: (...args) => {
			if (args.length > 0) logConsoleArgs("log", args);
		},
		groupCollapsed: (...args) => {
			if (args.length > 0) logConsoleArgs("log", args);
		},
		groupEnd: () => {},
		time: label => {
			consoleTimers.set(String(label ?? "default"), Date.now());
		},
		timeLog: (label, ...args) => {
			const key = String(label ?? "default");
			const start = consoleTimers.get(key);
			if (start === undefined) {
				logConsoleArgs("warn", [`Timer '${key}' does not exist`]);
				return;
			}
			logConsoleArgs("log", [`${key}: ${Date.now() - start}ms`, ...args]);
		},
		timeEnd: label => {
			const key = String(label ?? "default");
			const start = consoleTimers.get(key);
			if (start === undefined) {
				logConsoleArgs("warn", [`Timer '${key}' does not exist`]);
				return;
			}
			consoleTimers.delete(key);
			logConsoleArgs("log", [`${key}: ${Date.now() - start}ms`]);
		},
		count: label => {
			const key = String(label ?? "default");
			const next = (consoleCounts.get(key) ?? 0) + 1;
			consoleCounts.set(key, next);
			logConsoleArgs("log", [`${key}: ${next}`]);
		},
		countReset: label => {
			consoleCounts.delete(String(label ?? "default"));
		},
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
		const options = optionsArg("read", opts, rest, ["offset", "limit"], "{ offset, limit }");
		return await rawUrlRead(String(path), options);
	};

	const write = async (path, data) => {
		if (typeof data === "string") {
			return await rawUrlWrite(String(path), data, "utf8");
		}
		if (data instanceof ArrayBuffer) {
			return await rawUrlWrite(String(path), encodeBase64Bytes(new Uint8Array(data)), "base64");
		}
		if (ArrayBuffer.isView(data)) {
			const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
			return await rawUrlWrite(String(path), encodeBase64Bytes(bytes), "base64");
		}
		throw new TypeError("write() expects string, ArrayBuffer, or ArrayBufferView data");
	};

	const tool = new Proxy(Object.create(null), {
		get(_target, prop) {
			if (typeof prop !== "string" || prop === "then" || prop === "toJSON") return undefined;
			return async args => await rawCallTool(prop, args ?? {});
		},
	});

	globalThis.console = consoleBridge;
	globalThis.print = consoleBridge.log;
	globalThis.log = log;
	globalThis.phase = phase;
	globalThis.env = env;
	globalThis.read = read;
	globalThis.write = write;
	globalThis.tool = tool;
	globalThis.btoa = btoa;
	globalThis.atob = atob;
	globalThis.TextEncoder = TextEncoder;
	globalThis.TextDecoder = TextDecoder;
	globalThis.__omp_set_final_expr__ = value => {
		rawSetFinalExpr(value);
	};
	globalThis.__omp_emit_final_expr__ = value => {
		if (value !== undefined) consoleBridge.log(value);
	};
})();
