/**
 * The ownership checker rejects each form of an unowned or uncancelled model request. Each case adds
 * one file to a small fixture tree (a coding agent depending on pi-ai and pi-agent-core) and runs the
 * real checker over it. The attack cases are the forms the round-ten, twelve and fourteen reviews
 * found it accepting (round fourteen's 19 kept as the reviewer wrote them), and the forms earlier
 * rounds found; the control cases pin what a correct declaration looks like, so the attacks cannot
 * pass by the fixture being broken.
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

/** pi-ai's gate, as the fixture's transport package defines it. */
const GATE_MODULE = [
	"export function gatedFetch(fetchImpl?: typeof fetch): typeof fetch {",
	"\t// model-request: none — the fixture gate's own delegate; each send through it is declared where the gate is called.",
	"\tconst send = fetchImpl ?? fetch;",
	"\treturn ((input: string, init?: RequestInit) => send(input, init)) as typeof fetch;",
	"}",
].join("\n");

/** The prelude of a round-fourteen reviewer attack: an owner whose signal has already aborted. */
const R14_PRELUDE = 'const url = "https://localhost:1";\nconst owner = new AbortController();\nowner.abort();\n';
const R14_DECLARED = "// model-request: session — claims the aborted owner signal.\n";

/** One round-fourteen attack, as its reviewer wrote it, in the attack file. */
function r14(name: string, source: string): { name: string; files: Record<string, string>; passes: boolean } {
	return {
		name: `round 14: ${name}`,
		files: { "coding-agent/src/zz.ts": `${R14_PRELUDE}${source}\nexport {};\n` },
		passes: false,
	};
}

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
		name: "options built by a helper, with the signal restated at the call",
		files: {
			"coding-agent/src/ok.ts": `${IMPORT}declare function prepare<T>(o: T): T;\nexport function go(m: unknown, c: unknown, owner: AbortController) {\n\t// model-request: session — the fixture session's signal.\n\treturn completeSimple(m, c, { ...prepare({ retries: 2 }), signal: owner.signal });\n}\n`,
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
	{
		name: "an undeclared call",
		files: { "coding-agent/src/zz.ts": `${IMPORT}completeSimple(m, c, {});\n` },
		passes: false,
	},
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
		files: {
			"coding-agent/src/zz.ts": `${IMPORT}(completeSimple as unknown as (...args: unknown[]) => unknown)(m, c, {});\n`,
		},
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
		files: {
			"coding-agent/src/zz.ts": 'const ai = await import("@oh-my-pi/pi-ai");\nai.completeSimple(m, c, {});\n',
		},
		passes: false,
	},
	{
		name: "a computed member of that namespace",
		files: {
			"coding-agent/src/zz.ts":
				'const ai = await import("@oh-my-pi/pi-ai");\nconst key = "completeSimple";\nai[key](m, c, {});\n',
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
	// Round twelve's shapes: a cancellation lost to a later write, a getter, a spread or a helper's body,
	// and network requests reached through an alias, a computed key or a node module.
	...(
		[
			["a computed key that overwrites the signal", '{ signal: owner.signal, ["signal"]: undefined }'],
			["a getter that returns undefined", "{ get signal() { return undefined; } }"],
			["a signal that is a method", "{ signal() { return owner.signal; } }"],
			["a later key the walk cannot resolve", "{ signal: owner.signal, [dynamicKey]: undefined }"],
			["a helper whose body discards the signal", "discard({ signal: owner.signal })"],
			["an argument spread with no options", "...[]"],
		] as const
	).map(([name, options]) => ({
		name,
		files: {
			"coding-agent/src/zz.ts": `${IMPORT}function discard(o: object) {\n\treturn { ...o, signal: undefined };\n}\nexport function go(owner: AbortController, dynamicKey: string) {\n\t// model-request: session — claims a signal.\n\treturn completeSimple(m, c, ${options});\n}\n`,
		},
		passes: false,
	})),
	{
		name: "a property read of an object whose property is undefined",
		files: {
			"coding-agent/src/zz.ts": `${IMPORT}const options = { signal: undefined };\n// model-request: session — claims a signal.\ncompleteSimple(m, c, { signal: options.signal });\n`,
		},
		passes: false,
	},
	{
		name: "a signal reassigned to undefined",
		files: {
			"coding-agent/src/zz.ts": `${IMPORT}export function go(owner: AbortController) {\n\tlet signal: AbortSignal | undefined = owner.signal;\n\tsignal = undefined;\n\t// model-request: session — claims a signal.\n\treturn completeSimple(m, c, { signal });\n}\n`,
		},
		passes: false,
	},
	{
		name: "options whose signal is overwritten after they are built",
		files: {
			"coding-agent/src/zz.ts": `${IMPORT}export function go(owner: AbortController) {\n\tconst options: { signal?: AbortSignal } = { signal: owner.signal };\n\toptions.signal = undefined;\n\t// model-request: session — claims a signal.\n\treturn completeSimple(m, c, options);\n}\n`,
		},
		passes: false,
	},
	{
		name: "options whose signal is deleted after they are built",
		files: {
			"coding-agent/src/zz.ts": `${IMPORT}export function go(owner: AbortController) {\n\tconst options: { signal?: AbortSignal } = { signal: owner.signal };\n\tdelete options.signal;\n\t// model-request: session — claims a signal.\n\treturn completeSimple(m, c, options);\n}\n`,
		},
		passes: false,
	},
	{
		name: "an argument spread whose options carry an undefined signal",
		files: {
			"coding-agent/src/zz.ts": `${IMPORT}// model-request: session — claims a signal.\ncompleteSimple(m, c, ...[{ signal: undefined }]);\n`,
		},
		passes: false,
	},
	{
		name: "arguments spread from a local tuple with no signal",
		files: {
			"coding-agent/src/zz.ts": `export function go(url: string) {\n\tconst args: [string, RequestInit] = [url, {}];\n\t// model-request: session — claims a signal.\n\treturn fetch(...args);\n}\n`,
		},
		passes: false,
	},
	{
		name: "arguments spread from a value the walk cannot see",
		files: {
			"coding-agent/src/zz.ts": `export function go(args: [string, RequestInit]) {\n\t// model-request: session — claims a signal.\n\treturn fetch(...args);\n}\n`,
		},
		passes: false,
	},
	{
		name: "fetch through a local alias of the global object",
		files: { "coding-agent/src/zz.ts": 'const g = globalThis;\ng.fetch("https://api.test");\n' },
		passes: false,
	},
	{
		name: "fetch through a computed key held in a local",
		files: { "coding-agent/src/zz.ts": 'const key = "fetch";\nglobalThis[key]("https://api.test");\n' },
		passes: false,
	},
	{
		name: "a global read under a key the walk cannot resolve",
		files: {
			"coding-agent/src/zz.ts":
				"export function go(key: string) {\n\treturn (globalThis as Record<string, unknown>)[key];\n}\n",
		},
		passes: false,
	},
	{
		name: "fetch destructured under a computed key",
		files: { "coding-agent/src/zz.ts": 'const { ["fetch"]: send } = globalThis;\nsend("https://api.test");\n' },
		passes: false,
	},
	{
		name: "fetch read with Reflect.get",
		files: {
			"coding-agent/src/zz.ts": 'const send = Reflect.get(globalThis, "fetch");\nsend("https://api.test");\n',
		},
		passes: false,
	},
	{
		name: "a Hindsight method destructured off the client",
		files: {
			"coding-agent/src/zz.ts":
				'import { HindsightApi } from "./hindsight/client";\nconst client = new HindsightApi();\nconst { reflect } = client;\nreflect("bank", "query");\n',
		},
		passes: false,
	},
	{
		name: "a node:http request",
		files: {
			"coding-agent/src/zz.ts":
				'import http from "node:http";\nhttp.request("https://api.test", { method: "POST" }).end("{}");\n',
		},
		passes: false,
	},
	{
		name: "an HTTP/2 session",
		files: { "coding-agent/src/zz.ts": 'import { connect } from "node:http2";\nconnect("https://api.test");\n' },
		passes: false,
	},
	{
		name: "a raw TCP connection",
		files: { "coding-agent/src/zz.ts": 'import * as net from "node:net";\nnet.connect(443, "api.test");\n' },
		passes: false,
	},
	{
		name: "a session-owned request whose signal is traced through a local controller",
		files: {
			"coding-agent/src/ok.ts": `${IMPORT}export function go() {\n\tconst controller = new AbortController();\n\t// model-request: session — the fixture session's controller.\n\treturn completeSimple(m, c, { signal: controller.signal });\n}\n`,
		},
		passes: true,
	},
	{
		name: "a helper whose body keeps the signal",
		files: {
			"coding-agent/src/ok.ts": `${IMPORT}function keep(o: { signal: AbortSignal }) {\n\treturn { ...o, retries: 2 };\n}\nexport function go(owner: AbortController) {\n\t// model-request: session — the fixture session's signal.\n\treturn completeSimple(m, c, keep({ signal: owner.signal }));\n}\n`,
		},
		passes: true,
	},
	{
		name: "options from a helper, with a joined signal restated at the call",
		files: {
			"coding-agent/src/ok.ts": `${IMPORT}declare function prepare<T>(o: T): T;\nexport function go(m: unknown, c: unknown, owner: AbortController, stop: AbortController) {\n\t// model-request: session — the fixture session's signal, joined to a local stop.\n\treturn completeSimple(m, c, { ...prepare({}), signal: AbortSignal.any([owner.signal, stop.signal]) });\n}\n`,
		},
		passes: true,
	},
	{
		name: "a credentialed HTTP/2 send that asks the hold first",
		files: {
			"coding-agent/src/ok.ts":
				'import * as http2 from "node:http2";\nimport { admitNetworkSend } from "@oh-my-pi/pi-utils/request-hold-scope";\nexport async function go(url: string, apiKey: string) {\n\tconst refusal = admitNetworkSend();\n\tif (refusal) await refusal;\n\t// model-request: none — the fixture lists models, a catalog read; asks the hold above.\n\tconst client = http2.connect(url);\n\treturn client.request({ authorization: `Bearer ${apiKey}` });\n}\n',
		},
		passes: true,
	},
	{
		name: "a declared worker that sends nothing, and data imports",
		files: {
			"coding-agent/src/ok.ts":
				'import data from "./data.json";\nimport text from "./notes.txt" with { type: "text" };\nexport function go() {\n\t// model-request: none — the fixture worker renders text and sends nothing.\n\treturn new Worker(new URL("./render.ts", import.meta.url).href, { type: "module" }) && data && text;\n}\n',
			"coding-agent/src/data.json": "{}",
			"coding-agent/src/notes.txt": "notes",
		},
		passes: true,
	},
	{
		name: "fetch under a concatenated global key",
		files: { "coding-agent/src/zz.ts": 'globalThis["fet" + "ch"]("https://api.test");\n' },
		passes: false,
	},
	{
		name: "fetch under a templated global key",
		files: { "coding-agent/src/zz.ts": 'const head = "fe";\nglobalThis[`${head}tch`]("https://api.test");\n' },
		passes: false,
	},
	{
		name: "fetch under a concatenated key held in a local, behind a cast",
		files: {
			"coding-agent/src/zz.ts":
				'const name = "fet" + "ch";\nexport function go() {\n\treturn (globalThis as any)[name]("https://api.test");\n}\n',
		},
		passes: false,
	},
	{
		name: "a request inside new Function",
		files: { "coding-agent/src/zz.ts": 'new Function("return fetch")()("https://api.test");\n' },
		passes: false,
	},
	{
		name: "a request inside eval",
		files: { "coding-agent/src/zz.ts": 'eval("fetch")("https://api.test");\n' },
		passes: false,
	},
	{
		name: "a request inside a function's constructor",
		files: { "coding-agent/src/zz.ts": '(() => undefined).constructor("return fetch")()("https://api.test");\n' },
		passes: false,
	},
	{
		name: "generated code declared as session-owned",
		files: {
			"coding-agent/src/zz.ts":
				'// model-request: session — the fixture claims a signal generated code cannot take.\nnew Function("return 1")();\n',
		},
		passes: false,
	},
	{
		name: "an undeclared worker thread",
		files: { "coding-agent/src/zz.ts": 'new Worker("./payload.ts", { type: "module" });\n' },
		passes: false,
	},
	{
		name: "an undeclared node:worker_threads worker",
		files: {
			"coding-agent/src/zz.ts":
				'import { Worker as Thread } from "node:worker_threads";\nnew Thread("./payload.ts");\n',
		},
		passes: false,
	},
	{
		name: "a request in a .es6 file",
		files: { "coding-agent/src/zz.es6": 'fetch("https://api.test");\n' },
		passes: false,
	},
	{
		name: "a relative import of a file the walk does not parse",
		files: {
			"coding-agent/src/zz.ts": 'require("./payload.coffee");\n',
			"coding-agent/src/payload.coffee": 'fetch "https://api.test"\n',
		},
		passes: false,
	},
	{
		name: "an undeclared node:https request in a transport package",
		files: {
			"ai/src/zz.ts":
				'import * as https from "node:https";\nhttps.request("https://api.test", { method: "POST" }).end("{}");\n',
		},
		passes: false,
	},
	{
		name: "a transport send through the declared gate",
		files: {
			"ai/src/request-hold.ts": GATE_MODULE,
			"ai/src/providers/gated.ts": `import { gatedFetch } from "../request-hold";\nexport function streamGated(model: { baseUrl: string }, context: unknown, options?: { signal?: AbortSignal; fetch?: typeof fetch }) {\n\t// model-request: transport streamGated — the fixture provider's gated request.\n\tconst send = gatedFetch(options?.fetch);\n\treturn send(model.baseUrl, { signal: options?.signal });\n}\n`,
		},
		passes: true,
	},
	{
		name: "an undeclared send through the gate in a transport package",
		files: {
			"ai/src/request-hold.ts": GATE_MODULE,
			"ai/src/zz.ts":
				'import { gatedFetch } from "./request-hold";\ngatedFetch()("https://api.test", { method: "POST" });\n',
		},
		passes: false,
	},
	{
		name: "a session-owned send through the gate with no signal",
		files: {
			"ai/src/request-hold.ts": GATE_MODULE,
			"coding-agent/src/zz.ts":
				'import { gatedFetch } from "@oh-my-pi/pi-ai";\nexport function go() {\n\t// model-request: session — the fixture claims a session owner but passes no signal.\n\tconst send = gatedFetch();\n\treturn send("https://api.test", { method: "POST" });\n}\n',
		},
		passes: false,
	},
	// Round fourteen's first review: 19 shapes, 13 of which the round-thirteen checker accepted, 12 of
	// those sending an HTTPS request with an aborted owner. Kept as the reviewer wrote them.
	r14(
		"Object.assign over the options",
		"const opts = { signal: owner.signal };\nObject.assign(opts, { signal: undefined });\n" +
			R14_DECLARED +
			"await fetch(url, opts);",
	),
	r14(
		"a write through an alias",
		"const opts = { signal: owner.signal };\nconst alias = opts;\nalias.signal = undefined;\n" +
			R14_DECLARED +
			"await fetch(url, opts);",
	),
	r14(
		"Reflect.set on the options",
		'const opts = { signal: owner.signal };\nReflect.set(opts, "signal", undefined);\n' +
			R14_DECLARED +
			"await fetch(url, opts);",
	),
	r14(
		"Object.defineProperty on the options",
		'const opts = { signal: owner.signal };\nObject.defineProperty(opts, "signal", { value: undefined });\n' +
			R14_DECLARED +
			"await fetch(url, opts);",
	),
	r14(
		"a helper that writes its parameter",
		"function discard(x) {\n\tx.signal = undefined;\n\treturn x;\n}\nconst opts = { signal: owner.signal };\n" +
			R14_DECLARED +
			"await fetch(url, discard(opts));",
	),
	r14(
		"a helper with a branch that drops the options",
		"function prepare(x) {\n\tif (Date.now() > 0) return {};\n\treturn x;\n}\n" +
			R14_DECLARED +
			"await fetch(url, prepare({ signal: owner.signal }));",
	),
	r14("a void signal", R14_DECLARED + "await fetch(url, { signal: void owner.signal });"),
	r14("a comma signal", R14_DECLARED + "await fetch(url, { signal: (owner.signal, undefined) });"),
	r14("a logical signal", R14_DECLARED + "await fetch(url, { signal: owner.signal && undefined });"),
	r14(
		"a destructured shadow",
		"const { signal: stale } = owner;\nconst opts = { signal: undefined };\n" +
			R14_DECLARED +
			"await fetch(url, { signal: opts.signal ?? undefined });",
	),
	r14(
		"an argument array written after it was built",
		"const args = [url, { signal: owner.signal }];\nargs[1] = {};\n" + R14_DECLARED + "await fetch(...args);",
	),
	r14(
		"Object.assign building the options",
		R14_DECLARED + "await fetch(url, Object.assign({ signal: owner.signal }, { signal: undefined }));",
	),
	r14("fetch returned from a function", "function factory() {\n\treturn globalThis.fetch;\n}\nawait factory()(url);"),
	r14(
		"fetch from the global's property descriptor",
		'const f = Object.getOwnPropertyDescriptor(globalThis, "fetch").value;\nawait f(url);',
	),
	r14("Bun.fetch", "await Bun.fetch(url);"),
	r14(
		"https from process.getBuiltinModule",
		'await new Promise((resolve, reject) => {\n\tconst h = process.getBuiltinModule("node:https");\n\tconst q = h.get(url, r => {\n\t\tr.resume();\n\t\tr.on("end", resolve);\n\t});\n\tq.on("error", reject);\n});',
	),
	r14(
		"a require of a computed module name",
		'const name = "node:" + "https";\nconst https = require(name);\nhttps.request(url).end();',
	),
	r14(
		"a net.Socket constructed and connected",
		'import { Socket } from "node:net";\nnew Socket().connect(443, "localhost");',
	),
	r14(
		"fetch from Reflect's property descriptor",
		'const f = Reflect.getOwnPropertyDescriptor(globalThis, "fetch").value;\nawait f(url);',
	),
	// Round fourteen's second review: a declaration the code contradicts, and the gaps round thirteen declared.
	{
		name: "a credentialed HTTP/2 send declared not a model request",
		files: {
			"coding-agent/src/zz.ts":
				'import * as http2 from "node:http2";\nexport function go(url: string, apiKey: string) {\n\t// model-request: none — claims no model request.\n\tconst client = http2.connect(url);\n\treturn client.request({ authorization: `Bearer ${apiKey}` });\n}\n',
		},
		passes: false,
	},
	{
		name: "a fetch whose catch falls back to an ungated HTTP/2 send",
		files: {
			"coding-agent/src/zz.ts":
				'import * as http2 from "node:http2";\nfunction viaHttp2(url: string, apiKey: string) {\n\t// model-request: none — the fixture lists models, a catalog read.\n\tconst client = http2.connect(url);\n\tclient.request({ "x-api-key": apiKey }).end();\n}\nexport async function go(url: string, apiKey: string) {\n\ttry {\n\t\t// model-request: none — the fixture lists models, a catalog read.\n\t\treturn await fetch(url, { headers: { "x-api-key": apiKey } });\n\t} catch {\n\t\treturn viaHttp2(url, apiKey);\n\t}\n}\n',
		},
		passes: false,
	},
	{
		name: "a credentialed request on an HTTP/2 session already open",
		files: {
			"coding-agent/src/zz.ts":
				'import * as http2 from "node:http2";\n// model-request: none — opens the fixture session once, at load.\nconst client = http2.connect("https://api.test");\nexport function go(token: string) {\n\treturn client.request({ authorization: `Bearer ${token}` });\n}\n',
		},
		passes: false,
	},
	{
		name: "gatedFetch through a namespace import",
		files: {
			"ai/src/request-hold.ts": GATE_MODULE,
			"coding-agent/src/zz.ts":
				'import * as hold from "@oh-my-pi/pi-ai";\nhold.gatedFetch()("https://api.test", { method: "POST" });\n',
		},
		passes: false,
	},
	{
		name: "a require of a source file with no extension",
		files: {
			"coding-agent/src/zz.ts": 'require("./payload");\n',
			"coding-agent/src/payload": 'fetch("https://api.test");\n',
		},
		passes: false,
	},
	{
		name: "Bun handed on whole",
		files: { "coding-agent/src/zz.ts": 'const b = Bun;\nb.fetch("https://api.test");\n' },
		passes: false,
	},
	{
		name: "options from a helper the walk cannot read, the signal only inside it",
		files: {
			"coding-agent/src/zz.ts": `${IMPORT}declare function prepare<T>(o: T): T;\nexport function go(m: unknown, c: unknown, owner: AbortController) {\n\t// model-request: session — the fixture session's signal.\n\treturn completeSimple(m, c, prepare({ signal: owner.signal }));\n}\n`,
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
			else expect(report.problems.filter(problem => /\/zz\.[a-z0-9]+:/.test(problem))).not.toEqual([]);
		});
	}
});
