/** Benchmark fixtures modeled on real omp tool-parameter schemas. */
import type { Def } from "./ir";

export interface Fixture {
	name: string;
	def: Def;
	valid: unknown[];
	invalid: unknown[];
	/** The schema must produce output without mutating input. */
	expect?: { input: unknown; output: unknown }[];
}

export const FIXTURES: Fixture[] = [
	{
		name: "flat-small",
		def: { path: "string", "offset?": "number.integer >= 1", "limit?": "number.integer" },
		valid: [{ path: "src/foo.ts" }, { path: "a", offset: 5, limit: 100 }],
		invalid: [{ offset: 1 }, { path: "a", offset: 0.5 }, { path: 7 }],
	},
	{
		name: "enum-union",
		def: {
			op: "'start' | 'stop' | 'restart' | 'send' | 'wait' | 'logs'",
			"timeout?": "0 < number <= 3600",
			"pty?": "boolean",
		},
		valid: [{ op: "start" }, { op: "logs", timeout: 30, pty: true }],
		invalid: [{ op: "reboot" }, { op: "wait", timeout: 0 }, { op: "send", pty: 1 }],
	},
	{
		name: "nested-arrays",
		def: {
			context: "string",
			tasks: [
				{
					"name?": "1 <= string <= 32",
					"agent?": "string",
					task: "string",
					"schemaMode?": "'permissive' | 'strict'",
				},
				"[]",
			] as Def,
		},
		valid: [
			{ context: "goal", tasks: [{ task: "do it" }] },
			{ context: "c", tasks: [{ name: "A", agent: "scout", task: "x", schemaMode: "strict" }, { task: "y" }] },
		],
		invalid: [
			{ context: "c", tasks: [{ task: 5 }] },
			{ context: "c", tasks: [{ name: "", task: "x" }] },
			{ context: "c", tasks: "nope" },
			{ tasks: [] },
		],
	},
	{
		name: "strict-defaults",
		def: {
			"+": "reject",
			action: "'list' | 'get' | 'put'",
			key: "string",
			count: "number.integer = 10",
			"tags?": "string[]",
		},
		valid: [
			{ action: "get", key: "k" },
			{ action: "put", key: "k", count: 3, tags: ["a", "b"] },
		],
		invalid: [
			{ action: "get", key: "k", extra: 1 },
			{ action: "get", key: "k", count: 1.5 },
			{ action: "get", key: "k", tags: ["a", 2] },
		],
		expect: [
			{ input: { action: "get", key: "k" }, output: { action: "get", key: "k", count: 10 } },
			{ input: { action: "put", key: "k", count: 3 }, output: { action: "put", key: "k", count: 3 } },
		],
	},
	{
		name: "delete-extras",
		def: { "+": "delete", name: "string", "level?": "'low' | 'high'" },
		valid: [{ name: "x" }, { name: "x", junk: 1, more: "y" }, { name: "x", level: "low" }],
		invalid: [{ name: 1 }, { name: "x", level: "mid" }],
		expect: [
			{ input: { name: "x", junk: 1, more: "y" }, output: { name: "x" } },
			{ input: { name: "x", level: "high", z: null }, output: { name: "x", level: "high" } },
		],
	},
	{
		name: "record-mixed",
		def: {
			env: { "[string]": "string" },
			"args?": "(string | number)[]",
			"mode?": "'a' | 'b' | 'c'",
			"verbose?": "boolean | 'auto'",
		},
		valid: [{ env: {} }, { env: { A: "1", B: "2" }, args: ["x", 3], mode: "b", verbose: "auto" }],
		invalid: [{ env: { A: 1 } }, { env: {}, args: [true] }, { env: {}, verbose: "always" }],
	},
	{
		name: "deep-message",
		def: {
			role: "'user' | 'assistant' | 'system'",
			content: [
				{ type: "'text' | 'image'", "text?": "string", "data?": "string", "cache?": "boolean" },
				"[]",
			] as Def,
			"stop?": "'end' | 'tool' | 'length' | null",
			"usage?": { input: "number >= 0", output: "number >= 0" },
		},
		valid: [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "a" },
					{ type: "image", data: "b64", cache: true },
				],
				stop: null,
				usage: { input: 10, output: 20 },
			},
		],
		invalid: [
			{ role: "bot", content: [] },
			{ role: "user", content: [{ type: "video" }] },
			{ role: "user", content: [{ type: "text" }], usage: { input: -1, output: 0 } },
		],
	},
];

/** Generate unique fixed-shape schemas plus matching validation probes. */
export function generateUniqueDefs(count: number): { def: Def; valid: unknown; invalid: unknown }[] {
	const out: { def: Def; valid: unknown; invalid: unknown }[] = [];
	for (let i = 0; i < count; i++) {
		const ka = `alpha_${i}`;
		const kb = `beta_${i}`;
		const kc = `gamma_${i}`;
		const lit1 = `mode_${i}`;
		const lit2 = `alt_${i}`;
		const def: Def = {
			[ka]: "string",
			[`${kb}?`]: `number.integer >= ${i % 7}`,
			[kc]: `'${lit1}' | '${lit2}'`,
			nested: { flag: "boolean", items: "string[]" },
		};
		out.push({
			def,
			valid: { [ka]: "x", [kb]: (i % 7) + 1, [kc]: lit1, nested: { flag: true, items: ["a"] } },
			invalid: { [ka]: "x", [kc]: "nope", nested: { flag: true, items: [] } },
		});
	}
	return out;
}
