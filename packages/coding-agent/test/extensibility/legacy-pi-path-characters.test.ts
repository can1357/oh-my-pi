/**
 * An extension under a directory whose path holds characters that mean
 * something in a URL (`#` a fragment, `%` an escape, a space, `'`) loads and
 * reloads with the specifier form the loader uses: the raw filesystem path plus
 * a `?mtime=<n>` tag. These tests pin that form, so a later change of it shows
 * here: a `file://` URL keeps `#` and `%` working but serves a stale module on
 * reload, since Bun ignores the query of a `file://` specifier.
 *
 * Each extension has an entry, a relative import, a package `#alias/*` import
 * and an extension-local bare dependency, and every one of them is edited
 * between the two loads.
 */
import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadLegacyPiModule } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const roots: string[] = [];

afterAll(async () => {
	for (const root of roots) {
		await removeWithRetries(root);
	}
});

/** A plain directory, then one per character; `%41` would decode to `A`. */
const CHARACTER_DIRS: readonly (readonly [label: string, dirname: string])[] = [
	["plain", "plain"],
	["#", "h#x"],
	["%", "p%41x"],
	["a space", "s x"],
	["'", "a'x"],
];

interface Loaded {
	entry: string;
	relative: string;
	alias: string;
	bare: string;
}

const files = (version: string): Record<string, string> => ({
	"package.json": JSON.stringify({
		name: "path-characters-ext",
		version: "1.0.0",
		type: "module",
		imports: { "#lib/*": "./lib/*.ts" },
	}),
	"index.ts": [
		'import { relative } from "./helper.ts";',
		'import { alias } from "#lib/alias";',
		'import { bare } from "localdep";',
		"export { relative, alias, bare };",
		`export const entry = ${JSON.stringify(`entry-${version}`)};`,
		"export default function (pi) { void pi; }",
	].join("\n"),
	"helper.ts": `export const relative = ${JSON.stringify(`relative-${version}`)};\n`,
	"lib/alias.ts": `export const alias = ${JSON.stringify(`alias-${version}`)};\n`,
	"node_modules/localdep/package.json": JSON.stringify({
		name: "localdep",
		version: "1.0.0",
		type: "module",
		main: "index.js",
	}),
	"node_modules/localdep/index.js": 'export { bare } from "./helper.js";\n',
	"node_modules/localdep/helper.js": `export const bare = ${JSON.stringify(`bare-${version}`)};\n`,
});

/** Write the files, each with an mtime later than any it had. */
async function writeExtension(dir: string, version: string): Promise<void> {
	for (const [rel, content] of Object.entries(files(version))) {
		const abs = path.join(dir, rel);
		await fs.mkdir(path.dirname(abs), { recursive: true });
		const before = await fs.stat(abs).catch(() => null);
		await fs.writeFile(abs, content, "utf8");
		if (before) {
			const bumped = new Date(Math.ceil(before.mtimeMs) + 2_000);
			await fs.utimes(abs, bumped, bumped);
		}
	}
}

function pick(loaded: unknown): Loaded {
	const { entry, relative, alias, bare } = loaded as Loaded;
	return { entry, relative, alias, bare };
}

const expected = (version: string): Loaded => ({
	entry: `entry-${version}`,
	relative: `relative-${version}`,
	alias: `alias-${version}`,
	bare: `bare-${version}`,
});

describe("an extension under a directory whose path holds", () => {
	for (const [label, dirname] of CHARACTER_DIRS) {
		it(`${label} loads, and a same-process reload picks up every edited module`, async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-legacy-path-chars-"));
			roots.push(root);
			const dir = path.join(root, dirname, "ext");
			await writeExtension(dir, "v1");
			const entry = path.join(dir, "index.ts");

			expect(pick(await loadLegacyPiModule(entry))).toEqual(expected("v1"));

			await writeExtension(dir, "v2");
			expect(pick(await loadLegacyPiModule(entry))).toEqual(expected("v2"));
		});
	}
});
