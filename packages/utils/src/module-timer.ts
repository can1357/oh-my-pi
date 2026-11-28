/**
 * Opt-in Bun development preload. Observe only the synchronous source read and
 * the module's top-level evaluation (wall time, including top-level await).
 * The unobserved gap between them is not a measurement of parsing or waiting.
 * Modules that never reach the final marker do not produce completed events.
 * Only ESM TS/TSX/MTS sources under this workspace's package src directories
 * are intercepted;
 * extensions, dependencies, declaration assets and CJS are left to Bun. After
 * startup the hook still serves matching files (Bun cannot remove just one
 * plugin), but no longer instruments them or retains observations.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { plugin } from "bun";
import { moduleLoadBuffer, STOP_MODULE_LOAD_TIMING, timingModeIncludes } from "./timing-buffer";

const BODY_START = Symbol.for("omp.moduleBodyStart");
const BODY_END = Symbol.for("omp.moduleBodyEnd");

// Only inspect the prologue. In particular, a marker before a directive makes
// it an ordinary string expression, and JSX pragmas must stay at the head.
const HASHBANG = /^\uFEFF?(?:#![^\r\n\u2028\u2029]*)?/y;
const TRIVIA = /(?:\s+|\/\/[^\r\n\u2028\u2029]*|\/\*[\s\S]*?\*\/)*/y;
const STRING = /(?:"(?:[^"\\\r\n]|\\(?:\r\n|[\s\S]))*"|'(?:[^'\\\r\n]|\\(?:\r\n|[\s\S]))*')/y;
const STATEMENT_START = /(?:["']|(?!(?:as|satisfies|in|instanceof)\b)[A-Za-z_$])/y;

function bodyOffset(source: string): number | undefined {
	HASHBANG.lastIndex = 0;
	HASHBANG.test(source);
	let pos = HASHBANG.lastIndex;
	while (true) {
		TRIVIA.lastIndex = pos;
		TRIVIA.test(source);
		pos = TRIVIA.lastIndex;
		STRING.lastIndex = pos;
		if (!STRING.test(source)) return pos;
		TRIVIA.lastIndex = STRING.lastIndex;
		TRIVIA.test(source);
		pos = TRIVIA.lastIndex;
		if (source[pos] === ";") {
			pos++;
			continue;
		}
		if (pos === source.length) return pos;
		// Without a semicolon, never split a possible continuation of the
		// string expression (e.g. "text" followed by a newline and .trim()).
		STATEMENT_START.lastIndex = pos;
		if (!STATEMENT_START.test(source)) return undefined;
	}
}

if (timingModeIncludes("modules") || timingModeIncludes("full")) {
	const buffer = moduleLoadBuffer();
	// Runtime onLoad cannot fall through to native CJS detection. Restrict its
	// filter to our ESM package sources rather than intercepting arbitrary TS.
	const packages = RegExp.escape(resolve(import.meta.dir, "../.."));
	const filter = new RegExp(
		String.raw`^${packages}(?!.*[/\\]node_modules[/\\])(?!.*\.d\.m?ts$)[/\\][^/\\]+[/\\]src[/\\].*\.(?:ts|tsx|mts)$`,
	);
	let active = true;
	let nextId = 0;
	const bodyStarts = new Map<number, number>();
	const store = globalThis as unknown as {
		[STOP_MODULE_LOAD_TIMING](): void;
		[BODY_START](id: number): void;
		[BODY_END](id: number, path: string, readStart: number, readEnd: number): void;
	};
	store[STOP_MODULE_LOAD_TIMING] = () => {
		active = false;
		bodyStarts.clear();
		buffer.length = 0;
	};
	store[BODY_START] = id => {
		if (active) bodyStarts.set(id, performance.now());
	};
	store[BODY_END] = (id, path, readStart, readEnd) => {
		const bodyEnd = performance.now();
		const bodyStart = bodyStarts.get(id);
		if (bodyStart === undefined) return;
		bodyStarts.delete(id);
		buffer.push({ path, readStart, readEnd, bodyStart, bodyEnd });
	};

	plugin({
		name: "pi-module-load-timer",
		setup(build) {
			// Async onLoad would make the intercepted modules impossible to require().
			build.onLoad({ filter }, ({ path, loader }) => {
				if (!active) return { contents: readFileSync(path, "utf8"), loader };
				const readStart = performance.now();
				const source = readFileSync(path, "utf8");
				const readEnd = performance.now();
				const offset = bodyOffset(source);
				if (offset === undefined) return { contents: source, loader };
				const id = nextId++;
				const start = `;globalThis[Symbol.for("omp.moduleBodyStart")](${id});`;
				const end = `\n;globalThis[Symbol.for("omp.moduleBodyEnd")](${id},${JSON.stringify(path)},${readStart},${readEnd});`;
				// A newline also terminates a trailing shebang or line comment at EOF.
				const prefix = offset === source.length ? "\n" : "";
				return {
					contents: `${source.slice(0, offset)}${prefix}${start}${source.slice(offset)}${end}`,
					loader,
				};
			});
		},
	});
}
