import type { BunPlugin } from "bun";

/** Assets below this size stay object literals; the JSON.parse detour only pays off for large payloads. */
const DEFAULT_MIN_BYTES = 256 * 1024;

/**
 * Embed large JSON assets as `JSON.parse("<text>")` instead of object literals.
 *
 * JavaScriptCore parses a JSON string several times faster than equivalent
 * object-literal source: `models.json` (11 MB) cost ~100 ms of every npm-bundle
 * launch as a literal versus ~17 ms via `JSON.parse`, and as bytecode a literal
 * that size compiles to one property store per field. Only default imports are
 * supported (`import MODELS from "./models.json"`); a named import of a large
 * asset fails the build loudly instead of silently reading `undefined`.
 */
export function createJsonParsePlugin(minBytes: number = DEFAULT_MIN_BYTES): BunPlugin {
	return {
		name: "omp-json-parse-embed",
		target: "bun",
		setup(build) {
			build.onLoad({ filter: /\.json$/ }, async ({ path }) => {
				const file = Bun.file(path);
				if (file.size < minBytes) return undefined;
				const text = await file.text();
				JSON.parse(text);
				return { contents: `export default JSON.parse(${JSON.stringify(text)});`, loader: "js" };
			});
		},
	};
}
