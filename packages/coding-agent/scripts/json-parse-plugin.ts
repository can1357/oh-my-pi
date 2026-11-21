import type { BunPlugin } from "bun";

/** Assets below this size stay object literals. */
const DEFAULT_MIN_BYTES = 256 * 1024;

/**
 * Load large JSON from compressed assets without retaining its source in bytecode.
 *
 * JSON.parse keeps the fast JSON parser without retaining a second copy of
 * the source as a JavaScript string constant. Compression also keeps embedded
 * file pages small. Only default imports are supported (`import MODELS from
 * "./models.json"`); a named import of a large
 * asset fails the build loudly instead of silently reading `undefined`.
 */
export function createJsonParsePlugin(minBytes: number = DEFAULT_MIN_BYTES): BunPlugin {
	return {
		name: "omp-json-parse-asset",
		target: "bun",
		setup(build) {
			build.onResolve({ filter: /^omp-json-asset:/ }, ({ path }) => ({
				path: `${path.slice("omp-json-asset:".length)}.zst`,
				namespace: "omp-json-asset",
			}));
			build.onLoad({ filter: /.*/, namespace: "omp-json-asset" }, async ({ path }) => ({
				contents: Bun.zstdCompressSync(await Bun.file(path.slice(0, -4)).text()),
				loader: "file",
			}));
			build.onLoad({ filter: /\.json$/ }, async ({ path }) => {
				const file = Bun.file(path);
				if (file.size < minBytes) return undefined;
				const text = await file.text();
				JSON.parse(text);
				return {
					contents: `import * as fs from "node:fs";
import * as path from "node:path";
import asset from ${JSON.stringify(`omp-json-asset:${path}`)};
export default JSON.parse(Bun.zstdDecompressSync(fs.readFileSync(path.resolve(import.meta.dir, asset))).toString("utf8"));`,
					loader: "js",
				};
			});
		},
	};
}
