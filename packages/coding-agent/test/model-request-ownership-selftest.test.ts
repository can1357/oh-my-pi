/**
 * The ownership checker rejects each form of an unowned or uncancelled model request. Each case adds
 * one file to a small fixture tree (a coding agent depending on pi-ai and pi-agent-core) and runs the
 * real checker over it. The attack cases are the forms round-ten reviews found it accepting, and the
 * forms earlier rounds found; the control cases pin what a correct declaration looks like, so the
 * attacks cannot pass by the fixture being broken.
 *
 * What it cannot catch, by design: a cancellation that is present but the wrong one (a fresh,
 * unrelated controller). The request-count disposal tests cover that.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { checkModelRequestOwnership } from "./helpers/model-request-ownership";

/** The fixture every case starts from: three packages, each with what the checker needs to find. */
const BASE: Readonly<Record<string, string>> = {
	"coding-agent/package.json": JSON.stringify({
		name: "@oh-my-pi/pi-coding-agent",
		dependencies: { "@oh-my-pi/pi-ai": "workspace:*", "@oh-my-pi/pi-agent-core": "workspace:*" },
	}),
	"coding-agent/src/hindsight/client.ts": [
		"export class HindsightApi {",
		"\tasync recall(bank: string, query: string, options?: { signal?: AbortSignal }) { return this.#request(options?.signal); }",
		"\tasync reflect(bank: string, query: string, options?: { signal?: AbortSignal }) { return this.#request(options?.signal); }",
		"\tasync retain(bank: string, text: string, options?: { signal?: AbortSignal }) { return this.#request(options?.signal); }",
		"\tasync retainBatch(bank: string, items: unknown[], options?: { signal?: AbortSignal }) { return this.#request(options?.signal); }",
		"\tasync #request(signal?: AbortSignal) {",
		"\t\t// model-request: transport HindsightApi — the fixture's Hindsight request.",
		'\t\treturn fetch("https://hindsight.test", { signal });',
		"\t}",
		"}",
	].join("\n"),
	"ai/package.json": JSON.stringify({ name: "@oh-my-pi/pi-ai" }),
	"ai/src/providers/openai-responses.ts": [
		"export function streamOpenAIResponses(model: { baseUrl: string }, context: unknown, options?: { signal?: AbortSignal }) {",
		"\t// model-request: transport streamOpenAIResponses — the fixture provider's request.",
		"\treturn fetch(model.baseUrl, { signal: options?.signal });",
		"}",
	].join("\n"),
	"agent/package.json": JSON.stringify({ name: "@oh-my-pi/pi-agent-core" }),
};

const IMPORT = 'import { completeSimple } from "@oh-my-pi/pi-ai";\n';

/** Each case: the files it adds, and whether the checker must pass (a control) or fail (an attack). */
const CASES: ReadonlyArray<{ name: string; files: Readonly<Record<string, string>>; passes: boolean }> = [
	// Controls.
	{ name: "the fixture alone", files: {}, passes: true },
	{
		name: "a declared request with its owner's signal",
		files: {
			"coding-agent/src/ok.ts": `${IMPORT}export function go(m: unknown, c: unknown, owner: AbortController) {\n\t// model-request: session — the fixture session's signal.\n\treturn completeSimple(m, c, { signal: owner.signal });\n}\n`,
		},
		passes: true,
	},
	{
		name: "options built by a helper that is given the signal",
		files: {
			"coding-agent/src/ok.ts": `${IMPORT}declare function prepare<T>(o: T): T;\nexport function go(m: unknown, c: unknown, owner: AbortController) {\n\t// model-request: session — the fixture session's signal.\n\treturn completeSimple(m, c, prepare({ signal: owner.signal }));\n}\n`,
		},
		passes: true,
	},
	{
		name: "a network call that is not a model request, declared",
		files: {
			"coding-agent/src/ok.ts": `export function go() {\n\t// model-request: none — a web page, not a model request.\n\treturn fetch("https://example.test");\n}\n`,
		},
		passes: true,
	},
	{
		name: "a session-owned socket that its signal's abort listener closes",
		files: {
			"coding-agent/src/ok.ts": `export function go(signal: AbortSignal) {\n\t// model-request: session — the fixture session's socket, closed on its signal.\n\tconst socket = new WebSocket("wss://example.test");\n\tsignal.addEventListener("abort", () => socket.close(), { once: true });\n\treturn socket;\n}\n`,
		},
		passes: true,
	},
	{
		name: "a session-owned socket nothing closes",
		files: {
			"coding-agent/src/zz.ts": `export function go(signal: AbortSignal) {\n\t// model-request: session — claims the session owns it.\n\tconst socket = new WebSocket("wss://example.test");\n\treturn { socket, signal };\n}\n`,
		},
		passes: false,
	},
	// Attacks: an undeclared request, in every form the walk must see.
	{ name: "an undeclared call", files: { "coding-agent/src/zz.ts": `${IMPORT}completeSimple(m, c, {});\n` }, passes: false },
	{
		name: "an undeclared call in an .mts file",
		files: { "coding-agent/src/zz.mts": `${IMPORT}completeSimple(m, c, {});\n` },
		passes: false,
	},
	{
		name: "an undeclared call outside src/ (a script)",
		files: { "coding-agent/scripts/zz.ts": `${IMPORT}completeSimple(m, c, {});\n` },
		passes: false,
	},
	{
		name: "through a TypeScript cast",
		files: { "coding-agent/src/zz.ts": `${IMPORT}(completeSimple as unknown as (...args: unknown[]) => unknown)(m, c, {});\n` },
		passes: false,
	},
	{
		name: "handed on as a value",
		files: { "coding-agent/src/zz.ts": `${IMPORT}invoke(completeSimple, m, c);\n` },
		passes: false,
	},
	{
		name: "through a lookup table",
		files: { "coding-agent/src/zz.ts": `${IMPORT}const table = { run: completeSimple };\ntable.run(m, c, {});\n` },
		passes: false,
	},
	{
		name: "a namespace of a dynamic import",
		files: { "coding-agent/src/zz.ts": 'const ai = await import("@oh-my-pi/pi-ai");\nai.completeSimple(m, c, {});\n' },
		passes: false,
	},
	{
		name: "a computed member of that namespace",
		files: {
			"coding-agent/src/zz.ts": 'const ai = await import("@oh-my-pi/pi-ai");\nconst key = "completeSimple";\nai[key](m, c, {});\n',
		},
		passes: false,
	},
	{
		name: "destructured from a dynamic import",
		files: {
			"coding-agent/src/zz.ts": 'const { completeSimple: cs } = await import("@oh-my-pi/pi-ai");\ncs(m, c, {});\n',
		},
		passes: false,
	},
	{
		name: "a dynamic import whose specifier is computed",
		files: {
			"coding-agent/src/zz.ts":
				'const part = "pi-ai";\nconst ai = await import(`@oh-my-pi/${part}`);\nai.completeSimple(m, c, {});\n',
		},
		passes: false,
	},
	{
		name: "through a star re-export",
		files: {
			"coding-agent/src/barrel.ts": 'export * from "@oh-my-pi/pi-ai";\n',
			"coding-agent/src/zz.ts": 'import { completeSimple } from "./barrel";\ncompleteSimple(m, c, {});\n',
		},
		passes: false,
	},
	{
		name: "through a named re-export",
		files: {
			"coding-agent/src/barrel.ts": 'export { completeSimple as ask } from "@oh-my-pi/pi-ai";\n',
			"coding-agent/src/zz.ts": "import { ask } from './barrel';\nask(m, c, {});\n",
		},
		passes: false,
	},
	{
		name: "a caller helper's use, imported with single quotes",
		files: {
			"coding-agent/src/zz-helper.ts": `${IMPORT}export function helper(signal?: AbortSignal) {\n\t// model-request: caller helper(signal) — the signal its caller passes.\n\treturn completeSimple(m, c, { signal });\n}\n`,
			"coding-agent/src/zz.ts": "import { helper } from './zz-helper';\nhelper();\n",
		},
		passes: false,
	},
	{
		name: "a provider's own entry point",
		files: {
			"coding-agent/src/zz.ts":
				'import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";\nstreamOpenAIResponses(m, c, {});\n',
		},
		passes: false,
	},
	{ name: "a raw fetch", files: { "coding-agent/src/zz.ts": 'fetch("https://api.test");\n' }, passes: false },
	{
		name: "a computed global fetch",
		files: { "coding-agent/src/zz.ts": 'globalThis["fetch"]("https://api.test", { method: "POST" });\n' },
		passes: false,
	},
	{
		name: "fetch destructured from the global object",
		files: { "coding-agent/src/zz.ts": 'const { fetch: send } = globalThis;\nsend("https://api.test");\n' },
		passes: false,
	},
	{
		name: "a computed Hindsight method",
		files: {
			"coding-agent/src/zz.ts":
				'import { HindsightApi } from "./hindsight/client";\nconst client = new HindsightApi();\nclient["reflect"]("bank", "query");\n',
		},
		passes: false,
	},
	// Attacks: a declared request whose cancellation is missing on some path.
	{
		name: "an explicit undefined signal",
		files: {
			"coding-agent/src/zz.ts": `${IMPORT}// model-request: session — claims a signal.\ncompleteSimple(m, c, { signal: undefined });\n`,
		},
		passes: false,
	},
	{
		name: "a signal only in another argument",
		files: {
			"coding-agent/src/zz.ts": `${IMPORT}export function go(owner: AbortController) {\n\t// model-request: session — claims a signal.\n\treturn completeSimple(m, { signal: owner.signal }, {});\n}\n`,
		},
		passes: false,
	},
	{
		name: "a local alias of undefined",
		files: {
			"coding-agent/src/zz.ts": `${IMPORT}const signal = undefined;\n// model-request: session — claims a signal.\ncompleteSimple(m, c, { signal });\n`,
		},
		passes: false,
	},
	{
		name: "a later spread that overwrites the signal with undefined",
		files: {
			"coding-agent/src/zz.ts": `${IMPORT}export function go(owner: AbortController) {\n\tconst gone = { signal: undefined };\n\t// model-request: session — claims a signal.\n\treturn completeSimple(m, c, { signal: owner.signal, ...gone });\n}\n`,
		},
		passes: false,
	},
	{
		name: "a conditional signal with an undefined branch",
		files: {
			"coding-agent/src/zz.ts": `${IMPORT}export function go(owner: AbortController, cond: boolean) {\n\t// model-request: session — claims a signal.\n\treturn completeSimple(m, c, { signal: cond ? owner.signal : undefined });\n}\n`,
		},
		passes: false,
	},
	{
		name: "options built by a helper with an undefined signal",
		files: {
			"coding-agent/src/zz.ts": `${IMPORT}declare function prepare<T>(o: T): T;\n// model-request: session — claims a signal.\ncompleteSimple(m, c, prepare({ signal: undefined }));\n`,
		},
		passes: false,
	},
	{
		name: "options built by a helper given no signal",
		files: {
			"coding-agent/src/zz.ts": `${IMPORT}declare function prepare<T>(o: T): T;\nexport function go(options: object) {\n\t// model-request: session — claims a signal.\n\treturn completeSimple(m, c, prepare(options));\n}\n`,
		},
		passes: false,
	},
];

describe("model request ownership checker self-test", () => {
	let root: TempDir;

	beforeAll(() => {
		root = TempDir.createSync("@omp-ownership-selftest-");
	});

	afterAll(() => {
		root.removeSync();
	});

	for (const { name, files, passes } of CASES) {
		it(name, async () => {
			const dir = path.join(root.path(), name.replace(/[^a-z0-9]+/gi, "-"));
			for (const [file, text] of Object.entries({ ...BASE, ...files })) await Bun.write(path.join(dir, file), text);

			const report = await checkModelRequestOwnership(dir);

			expect(report.packageCount).toBe(3);
			if (passes) expect(report.problems).toEqual([]);
			// The problem names the attack's own file, so it fails for the attack, not for something incidental.
			else expect(report.problems.filter(problem => /\/zz\.m?ts:/.test(problem))).not.toEqual([]);
		});
	}
});
