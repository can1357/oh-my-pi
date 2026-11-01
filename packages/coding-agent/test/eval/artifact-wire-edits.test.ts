import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * The wire's guarantee is about edits to it, so it is tested on edits.
 *
 * An edit that lets a reader send something the host's parser does not hand
 * back whole must not compile: a field that is not a string, or is typed
 * `any`; a required field whose type admits `undefined`; a field named
 * `__proto__`; a second request shape for an op that already has one, even
 * one that only adds an optional field; or a request shape whose op admits
 * more than one op. If such an edit compiles, every
 * request a reader sends in that shape either reaches the host and is refused
 * as "not a request this host answers" (`artifactRequestOf` returns `null`,
 * which is exactly what the bridge turns into that refusal) or arrives with a
 * field missing. That failure exists only in an edited module, never in the
 * module as it stands, so each case below edits a copy of `artifact-wire.ts`,
 * type-checks it alone, and — where it compiles — asks the copy's own parser
 * about the request the edit lets a reader send. Either the compiler refuses
 * the edit, or the host parses that request whole.
 */

const repoRoot = path.resolve(import.meta.dir, "../../../..");
const wireSource = fs.readFileSync(path.join(import.meta.dir, "../../src/eval/artifact-wire.ts"), "utf8");
const tsgo = path.join(path.dirname(Bun.resolveSync("@typescript/native-preview/package.json", repoRoot)), "bin/tsgo");

interface WireModule {
	artifactRequestOf(value: unknown): unknown;
	settledArtifactOf(value: unknown): unknown;
}

interface Edit {
	/** What the compiler's refusal must mention, so it refuses this edit and not a copy the edit broke. */
	readonly refusal: string;
	/** Each pattern must match the module, so an edit that no longer applies fails instead of passing vacuously. */
	readonly changes: ReadonlyArray<readonly [RegExp, string]>;
	/** What a reader is allowed to send once the edit is made, and how the host reads it. */
	readonly sends: unknown;
	readonly parse: (wire: WireModule, sent: unknown) => unknown;
	/** What the host must make of it, when the edit compiles. */
	readonly expected: unknown;
}

const request = (wire: WireModule, sent: unknown) => wire.artifactRequestOf(sent);
const answer = (wire: WireModule, sent: unknown) =>
	wire.settledArtifactOf({ text: "/artifacts/0.read.log", details: sent });

const edits = {
	"a non-string field on the take request, listed in its row": {
		refusal: "attempt",
		changes: [
			[/\| \{ op: "take"; file: string \}/, '| { op: "take"; file: string; attempt: number }'],
			[/(take:[^\n]*\{ op: "required", file: "required") \}/, '$1, attempt: "required" }'],
		],
		sends: { op: "take", file: "file-1", attempt: 3 },
		parse: request,
		expected: { op: "take", file: "file-1", attempt: 3 },
	},
	"a non-string field on the answer and locate lookup, listed in both rows": {
		refusal: "attempt",
		changes: [
			[/interface ArtifactLookup \{\n/, "interface ArtifactLookup {\n\tattempt: number;\n"],
			[
				/\{ op: "required", id: "required", root: "required", token: "optional" \}/g,
				'{ op: "required", id: "required", root: "required", token: "optional", attempt: "required" }',
			],
		],
		sends: { op: "answer", id: "0", root: "/artifacts", attempt: 3 },
		parse: request,
		expected: { op: "answer", id: "0", root: "/artifacts", attempt: 3 },
	},
	"a new request variant with no parser entry": {
		refusal: "renew",
		changes: [
			[
				/\| \{ op: "release"; file: string \};/,
				'| { op: "release"; file: string }\n\t| { op: "renew"; file: string };',
			],
		],
		sends: { op: "renew", file: "file-1" },
		parse: request,
		expected: { op: "renew", file: "file-1" },
	},
	"a second request shape for take, its row unchanged": {
		refusal: "an op names exactly one request shape",
		changes: [
			[
				/\| \{ op: "take"; file: string \}/,
				'| { op: "take"; file: string }\n\t| { op: "take"; file: string; receipt: string }',
			],
		],
		sends: { op: "take", file: "file-1", receipt: "receipt-1" },
		parse: request,
		expected: { op: "take", file: "file-1", receipt: "receipt-1" },
	},
	"a required field on the take request that admits undefined, listed in its row": {
		refusal: "attempt",
		changes: [
			[/\| \{ op: "take"; file: string \}/, '| { op: "take"; file: string; attempt: string | undefined }'],
			[/(take:[^\n]*\{ op: "required", file: "required") \}/, '$1, attempt: "required" }'],
		],
		sends: { op: "take", file: "file-1", attempt: undefined },
		parse: request,
		expected: { op: "take", file: "file-1", attempt: undefined },
	},
	"a second request shape for take that adds an optional field, its row unchanged": {
		refusal: "an op names exactly one request shape",
		changes: [
			[
				/\| \{ op: "take"; file: string \}/,
				'| { op: "take"; file: string }\n\t| { op: "take"; file: string; receipt?: string }',
			],
		],
		sends: { op: "take", file: "file-1", receipt: "receipt-1" },
		parse: request,
		expected: { op: "take", file: "file-1", receipt: "receipt-1" },
	},
	"a second request shape for take with an index signature, its row unchanged": {
		refusal: "an op names exactly one request shape",
		changes: [
			[
				/\| \{ op: "take"; file: string \}/,
				'| { op: "take"; file: string }\n\t| { op: "take"; file: string; [key: string]: string }',
			],
		],
		sends: { op: "take", file: "file-1", receipt: "receipt-1" },
		parse: request,
		expected: { op: "take", file: "file-1", receipt: "receipt-1" },
	},
	"a second request shape for take built by a mapped type, its row unchanged": {
		refusal: "an op names exactly one request shape",
		changes: [
			[
				/\| \{ op: "take"; file: string \}/,
				'| { op: "take"; file: string }\n\t| ({ op: "take"; file: string } & { [K in "receipt"]?: string })',
			],
		],
		sends: { op: "take", file: "file-1", receipt: "receipt-1" },
		parse: request,
		expected: { op: "take", file: "file-1", receipt: "receipt-1" },
	},
	"a second request shape for take built by a generic, its row unchanged": {
		refusal: "an op names exactly one request shape",
		changes: [
			[/^/, "type WithReceipt<T> = T & { receipt?: string };\n"],
			[
				/\| \{ op: "take"; file: string \}/,
				'| { op: "take"; file: string }\n\t| WithReceipt<{ op: "take"; file: string }>',
			],
		],
		sends: { op: "take", file: "file-1", receipt: "receipt-1" },
		parse: request,
		expected: { op: "take", file: "file-1", receipt: "receipt-1" },
	},
	"a request shape whose op admits take and release": {
		refusal: "a request shape names exactly one op",
		changes: [
			[
				/\| \{ op: "take"; file: string \}/,
				'| { op: "take"; file: string }\n\t| { op: "take" | "release"; file: string; receipt: string }',
			],
		],
		sends: { op: "take", file: "file-1", receipt: "receipt-1" },
		parse: request,
		expected: { op: "take", file: "file-1", receipt: "receipt-1" },
	},
	"a request shape whose op is a pattern": {
		refusal: "a request op is a literal string other than __proto__",
		changes: [
			[
				/\| \{ op: "take"; file: string \}/,
				`| { op: "take"; file: string }\n\t| { op: \`take-\${string}\`; file: string }`,
			],
		],
		sends: { op: "take-now", file: "file-1" },
		parse: request,
		expected: { op: "take-now", file: "file-1" },
	},
	"a request shape whose op is __proto__, with a parser entry": {
		refusal: "a request op is a literal string other than __proto__",
		changes: [
			[
				/\| \{ op: "release"; file: string \};/,
				'| { op: "release"; file: string }\n\t| { op: "__proto__"; file: string };',
			],
			[
				/(\trelease: value => [^\n]*\n)/,
				'$1\t__proto__: value => shapeOf<RequestOf<"__proto__">>({ op: "required", file: "required" }, value),\n',
			],
		],
		// As a reader's JSON carries it.
		sends: JSON.parse('{"op":"__proto__","file":"file-1"}'),
		parse: request,
		expected: JSON.parse('{"op":"__proto__","file":"file-1"}'),
	},
	"a required symbol-keyed field on the take request, listed in its row": {
		refusal: "receipt",
		changes: [
			[/^/, 'const receipt: unique symbol = Symbol.for("receipt");\n'],
			[/\| \{ op: "take"; file: string \}/, '| { op: "take"; file: string; [receipt]: string }'],
			[/(take:[^\n]*\{ op: "required", file: "required") \}/, '$1, [receipt]: "required" }'],
		],
		sends: { op: "take", file: "file-1", [Symbol.for("receipt")]: "receipt-1" },
		// What arrives with the symbol-keyed field, which no serialization keeps.
		parse: (wire, sent) => Object.getOwnPropertySymbols(wire.artifactRequestOf(sent) ?? {}).length,
		expected: 1,
	},
	"a required field typed any on the take request, listed in its row": {
		refusal: "a wire field is never typed any",
		changes: [
			[/\| \{ op: "take"; file: string \}/, '| { op: "take"; file: string; attempt: any }'],
			[/(take:[^\n]*\{ op: "required", file: "required") \}/, '$1, attempt: "required" }'],
		],
		sends: { op: "take", file: "file-1", attempt: 3 },
		parse: request,
		expected: { op: "take", file: "file-1", attempt: 3 },
	},
	"an optional field typed any on the answer, listed in its table": {
		refusal: "a wire field is never typed any",
		changes: [
			[/export interface SettledArtifact \{\n/, "export interface SettledArtifact {\n\tattempt?: any;\n"],
			[/(const SETTLED_ARTIFACT_FIELDS: Presence<SettledArtifact> = \{\n)/, '$1\tattempt: "optional",\n'],
		],
		sends: { path: "/artifacts/0.read.log", device: "64768", inode: "12", attempt: 3 },
		parse: answer,
		expected: { path: "/artifacts/0.read.log", device: "64768", inode: "12", attempt: 3 },
	},
	"an answer field pattern, by a template-literal index signature": {
		refusal: "x-",
		changes: [
			[
				/export interface SettledArtifact \{\n/,
				`export interface SettledArtifact {\n\t[key: \`x-\${string}\`]: string;\n`,
			],
		],
		sends: { path: "/artifacts/0.read.log", device: "64768", inode: "12", "x-mount": "mount-1" },
		parse: answer,
		expected: { path: "/artifacts/0.read.log", device: "64768", inode: "12", "x-mount": "mount-1" },
	},
	"a field named __proto__ on the take request, listed in its row": {
		refusal: "__proto__",
		changes: [
			[/\| \{ op: "take"; file: string \}/, '| { op: "take"; file: string; __proto__: string }'],
			[/(take:[^\n]*\{ op: "required", file: "required") \}/, '$1, __proto__: "required" }'],
		],
		// An own `__proto__` key, as a reader's JSON carries one.
		sends: JSON.parse('{"op":"take","file":"file-1","__proto__":"proto-1"}'),
		parse: request,
		expected: JSON.parse('{"op":"take","file":"file-1","__proto__":"proto-1"}'),
	},
	"a non-string field on the answer, listed in its table": {
		refusal: "attempt",
		changes: [
			[/export interface SettledArtifact \{\n/, "export interface SettledArtifact {\n\tattempt?: number;\n"],
			[/(const SETTLED_ARTIFACT_FIELDS: Presence<SettledArtifact> = \{\n)/, '$1\tattempt: "optional",\n'],
		],
		sends: { path: "/artifacts/0.read.log", device: "64768", inode: "12", attempt: 3 },
		parse: answer,
		expected: { path: "/artifacts/0.read.log", device: "64768", inode: "12", attempt: 3 },
	},
	"a required field on the answer that admits undefined, listed in its table": {
		refusal: "mount",
		changes: [
			[
				/export interface SettledArtifact \{\n/,
				"export interface SettledArtifact {\n\tmount: string | undefined;\n",
			],
			[/(const SETTLED_ARTIFACT_FIELDS: Presence<SettledArtifact> = \{\n)/, '$1\tmount: "required",\n'],
		],
		sends: { path: "/artifacts/0.read.log", device: "64768", inode: "12", mount: undefined },
		parse: answer,
		expected: { path: "/artifacts/0.read.log", device: "64768", inode: "12", mount: undefined },
	},
} satisfies Record<string, Edit>;

/** Every request and answer the readers send today, which the unedited module must parse whole. */
const sentToday: ReadonlyArray<readonly [(wire: WireModule, sent: unknown) => unknown, Record<string, string>]> = [
	[request, { op: "answer", id: "0", root: "/artifacts", token: "root-1" }],
	[request, { op: "locate", id: "0", root: "/artifacts" }],
	[request, { op: "take", file: "file-1" }],
	[request, { op: "release", file: "file-1" }],
	[answer, { path: "/artifacts/0.read.log", device: "64768", inode: "12", file: "file-1", root: "root-1", text: "x" }],
];

function apply(edit: Edit): string {
	let source = wireSource;
	for (const [pattern, replacement] of edit.changes) {
		if (!pattern.test(source)) throw new Error(`${pattern} no longer matches artifact-wire.ts; rewrite this edit`);
		pattern.lastIndex = 0;
		source = source.replace(pattern, replacement);
	}
	return source;
}

/** Each copy's diagnostics, or `undefined` for a copy that compiled. */
const diagnostics = new Map<string, string | undefined>();
const copies = new Map<string, string>();
let tempDir: TempDir;

beforeAll(async () => {
	tempDir = TempDir.createSync("@omp-wire-edits-");
	const sources: [string, string][] = [["unedited", wireSource]];
	for (const [name, edit] of Object.entries(edits)) sources.push([name, apply(edit)]);
	for (const [index, [name, source]] of sources.entries()) {
		const file = path.join(tempDir.path(), `copy-${index}`, "artifact-wire.ts");
		fs.mkdirSync(path.dirname(file));
		fs.writeFileSync(file, source);
		copies.set(name, file);
	}
	// One compiler run for every copy: each is a module of its own with no imports.
	const relative = Array.from(copies.values(), file => path.relative(tempDir.path(), file));
	const check = Bun.spawn(
		[
			process.execPath,
			tsgo,
			"--noEmit",
			"--pretty",
			"false",
			"--strict",
			"--skipLibCheck",
			"--target",
			"es2022",
			"--module",
			"preserve",
			"--moduleResolution",
			"bundler",
			...relative,
		],
		{ cwd: tempDir.path(), stdout: "pipe", stderr: "pipe" },
	);
	const [output, errors] = await Promise.all([
		new Response(check.stdout).text(),
		new Response(check.stderr).text(),
		check.exited,
	]);
	// A diagnostic is its header line and the indented lines that elaborate it.
	const byFile = new Map<string, string[]>();
	let owner: string | undefined;
	for (const line of output.split("\n")) {
		const header = /^(.+?)\(\d+,\d+\): /.exec(line);
		if (header) owner = header[1];
		else if (!/^\s/.test(line)) owner = undefined;
		if (owner === undefined) continue;
		const lines = byFile.get(owner) ?? [];
		lines.push(line);
		byFile.set(owner, lines);
	}
	for (const [name, file] of copies)
		diagnostics.set(name, byFile.get(path.relative(tempDir.path(), file))?.join("\n"));
	// Output that names no copy is the compiler failing to run, not a verdict.
	if (check.exitCode !== 0 && Array.from(diagnostics.values()).every(found => found === undefined)) {
		throw new Error(`tsgo exited ${check.exitCode} without a diagnostic on any copy:\n${output}${errors}`);
	}
}, 120_000);

afterAll(() => {
	tempDir?.removeSync();
});

describe("artifact wire under edits", () => {
	it("compiles unedited and parses every request and answer the readers send", async () => {
		expect(diagnostics.get("unedited")).toBeUndefined();
		// Imported by path: the copy is written by this test, so no static import can name it.
		const wire = (await import(copies.get("unedited")!)) as WireModule;
		for (const [parse, sent] of sentToday) expect(parse(wire, sent)).toEqual(sent);
	});

	for (const [name, edit] of Object.entries(edits) as [string, Edit][]) {
		it(`refuses at compile time, or parses whole, ${name}`, async () => {
			const found = diagnostics.get(name);
			if (found !== undefined) {
				// Refused by the compiler, and for the edit, not for something else in the copy.
				expect(found).toContain(edit.refusal);
				return;
			}
			// It compiled, so a reader may send this; the host must not refuse it or drop the field.
			const wire = (await import(copies.get(name)!)) as WireModule;
			expect(edit.parse(wire, edit.sends)).toEqual(edit.expected);
		});
	}
});
