import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import * as zod from "@oh-my-pi/omptype/zod";
import type { Tool } from "@oh-my-pi/pi-ai/types";
import { isArkSchema, toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createTools, HIDDEN_TOOLS, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { MemoryEditTool } from "@oh-my-pi/pi-coding-agent/tools/memory-edit";
import { MemoryRecallTool } from "@oh-my-pi/pi-coding-agent/tools/memory-recall";
import { MemoryReflectTool } from "@oh-my-pi/pi-coding-agent/tools/memory-reflect";
import { MemoryRetainTool } from "@oh-my-pi/pi-coding-agent/tools/memory-retain";
import { createVibeTools } from "@oh-my-pi/pi-coding-agent/tools/vibe";
import { YieldTool } from "@oh-my-pi/pi-coding-agent/tools/yield";
import { EditTool } from "../../src/edit";
import { getTaskSchema } from "../../src/task/types";
import { BashTool } from "../../src/tools/bash";
import { EDIT_MODES } from "../../src/utils/edit-mode";

/**
 * Provider-facing structural contract: `toolWireSchema` output is the
 * parameter schema every model sees on all 11 provider adapters. A `true` or
 * `{}` in a schema position means the model perceives the parameter as
 * unconstrained — the failure presents as "the model gets it wrong", never as
 * an error. Assert on boolean `true`, NOT on `{}`: `normalizeEmptySchemas`
 * rewrites `{}` to `true` before a provider sees the schema, so an
 * "expect no `{}`" assertion silently passes while the schema is erased.
 */

function createSession(overrides: Record<string, unknown> = {}): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		outputSchema: overrides["~outputSchema"],
		settings: Settings.isolated({ "tools.xdev": false, ...overrides }),
	};
}

function asTool(name: string, description: string, parameters: unknown): Tool {
	// Test fixture: real tools are class instances; only the wire-facing
	// surface (name/description/parameters) participates here.
	return { name, description, parameters } as unknown as Tool;
}

// ── erasure walk ─────────────────────────────────────────────────────────────

interface Erasure {
	tool: string;
	pointer: string;
	value: "true" | "{}";
}

// Named allow-list of legitimate unconstrained positions. Each entry must
// carry a reason; the walk fails on any erasure not listed here. A
// deliberately unconstrained parameter (z.unknown()/z.any()) honestly emits
// `properties.<name> = {}` — if a tool gains one, add it here, e.g.:
// { tool: /^mytool$/, pointer: /\/properties\/whatever$/, reason: "deliberately unconstrained" }
const ALLOWED_ERASURES: Array<{ tool: RegExp; pointer: RegExp; reason: string }> = [
	{
		// yield's user-requested `outputSchema: true` emits a description-only
		// data schema that escapes normalizeEmptySchemas; pinned to stay
		// description-only by the dedicated assertion in the yield test.
		tool: /^yield(:|$)/,
		pointer: /\/data$/,
		reason: "description-only data schema for outputSchema: true",
	},
	{
		// debug.arguments is a record of arbitrary user-supplied arguments: the
		// open value schema is the declared contract, not an erasure.
		tool: /^debug$/,
		pointer: /\/properties\/arguments\/additionalProperties$/,
		reason: "intentional open record for arbitrary debug arguments",
	},
	{
		// yield's loose outputSchema fallback types data as an open record —
		// same user-requested near-miss class as the description-only case.
		tool: /^yield(:|$)/,
		pointer: /\/data\/additionalProperties$/,
		reason: "yield's loose outputSchema fallback data record",
	},
];

const unexpectedErasures = (erasures: Erasure[]): Erasure[] =>
	erasures.filter(
		erasure => !ALLOWED_ERASURES.some(entry => entry.tool.test(erasure.tool) && entry.pointer.test(erasure.pointer)),
	);

// The complete schema-position inventory, mirroring wire.ts's own traversal
// sets (STRIP_SCHEMA_VALUE_KEYS / STRIP_SCHEMA_MAP_KEYS) so this walk covers
// exactly the positions the production wire lowering considers schema-valued.
const SCHEMA_VALUE_KEYS = new Set([
	"additionalProperties",
	"unevaluatedProperties",
	"unevaluatedItems",
	"items",
	"additionalItems",
	"contains",
	"propertyNames",
	"contentSchema",
	"if",
	"then",
	"else",
	"not",
	"anyOf",
	"oneOf",
	"allOf",
	"prefixItems",
]);
const SCHEMA_MAP_KEYS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);

function walkSchema(tool: string, pointer: string, node: unknown, erasures: Erasure[]): void {
	if (node === true) {
		erasures.push({ tool, pointer, value: "true" });
		return;
	}
	if (node === null || typeof node !== "object" || Array.isArray(node)) return;
	const obj = node as Record<string, unknown>;
	if (Object.keys(obj).length === 0) {
		erasures.push({ tool, pointer, value: "{}" });
		return;
	}
	for (const [key, value] of Object.entries(obj)) {
		const childPointer = `${pointer}/${key}`;
		// Single-subschema and array-of-subschema keywords are dispatched on
		// array-ness, exactly like wire.ts's traversal — this includes
		// object-valued `additionalProperties`, which is a record's VALUE
		// schema (bash.env, hub.env, debug.arguments, log_experiment.*).
		if (SCHEMA_VALUE_KEYS.has(key)) {
			if (Array.isArray(value)) {
				value.forEach((sub, index) => {
					walkSchema(tool, `${childPointer}/${index}`, sub, erasures);
				});
			} else {
				walkSchema(tool, childPointer, value, erasures);
			}
		} else if (SCHEMA_MAP_KEYS.has(key) && value !== null && typeof value === "object" && !Array.isArray(value)) {
			// Map positions hold per-key subschemas, so an empty map itself is
			// not an erasure.
			for (const [name, sub] of Object.entries(value as Record<string, unknown>)) {
				walkSchema(tool, `${childPointer}/${name}`, sub, erasures);
			}
		}
	}
}

function erasureMessage(erasures: Erasure[]): string {
	return erasures.map(erasure => `${erasure.tool} ${erasure.pointer} → ${erasure.value}`).join("\n");
}

/** Depth-first lookup of a property literally named `data`. */
function findDataProperty(node: unknown): Record<string, unknown> | undefined {
	if (Array.isArray(node)) {
		for (const entry of node) {
			const found = findDataProperty(entry);
			if (found !== undefined) return found;
		}
		return undefined;
	}
	if (node === null || typeof node !== "object") return undefined;
	const obj = node as Record<string, unknown>;
	for (const [key, value] of Object.entries(obj)) {
		if (key === "data" && value !== null && typeof value === "object" && !Array.isArray(value)) {
			return value as Record<string, unknown>;
		}
		const found = findDataProperty(value);
		if (found !== undefined) return found;
	}
	return undefined;
}

// ── discovered tool population ───────────────────────────────────────────────

async function discoverTools(): Promise<Tool[]> {
	const session = createSession();
	const byName = new Map<string, Tool>();
	for (const tool of await createTools(session)) byName.set(tool.name, tool);
	for (const name in HIDDEN_TOOLS) {
		const tool = await HIDDEN_TOOLS[name as keyof typeof HIDDEN_TOOLS](session);
		if (tool) byName.set(name, tool);
	}
	for (const tool of createVibeTools(session)) byName.set(tool.name, tool);
	return [...byName.values()];
}

const discoveredToolsPromise = discoverTools();

describe("discovered tool wire schemas are structurally constrained", () => {
	it("emits no unconstrained `true`/`{}` in any schema position", async () => {
		const erasures: Erasure[] = [];
		for (const tool of await discoveredToolsPromise) {
			walkSchema(tool.name, "", toolWireSchema(tool), erasures);
		}
		// Anything flagged must be a named allow-list entry (see
		// ALLOWED_ERASURES); an unlisted erasure is a real regression.
		expect(erasureMessage(unexpectedErasures(erasures))).toBe("");
		expect(unexpectedErasures(erasures)).toEqual([]);
	});

	it("never relays a degenerate fallback base for discovered tools", async () => {
		// The fallback hook fires when omptype meets a node it cannot emit
		// natively; wire.ts relays `ctx => ctx.base`, so the base IS what the
		// provider sees. A degenerate base (`{}`) is the erasure class this PR
		// exists to kill. Stepped subschemas (e.g. ask's `narrow`) also invoke
		// the hook, but relay a fully structural base — benign by design, and
		// asserted benign right here rather than silently allow-listed.
		const degenerate: string[] = [];
		let invocations = 0;
		for (const tool of await discoveredToolsPromise) {
			const params: unknown = tool.parameters;
			if (!isArkSchema(params)) continue;
			params.toJsonSchema({
				target: "draft-2020-12",
				fallback: ctx => {
					invocations++;
					const base = JSON.stringify(ctx.base);
					if (base === "{}" || base === "true") degenerate.push(tool.name);
					return ctx.base;
				},
			});
		}
		// ask's stepped narrow exercises the hook with a structural base; the
		// assertion below pins that NO invocation degrades, not that the hook
		// never fires.
		expect(degenerate).toEqual([]);
		expect(invocations).toBeGreaterThan(0);
	});
});

describe("setting- and mode-dependent tool variants stay structurally constrained", () => {
	it("covers every edit mode", () => {
		const erasures: Erasure[] = [];
		for (const mode of EDIT_MODES) {
			const tool = new EditTool(createSession(), mode);
			walkSchema(`edit:${mode}`, "", toolWireSchema(tool), erasures);
		}
		expect(erasureMessage(unexpectedErasures(erasures))).toBe("");
		expect(unexpectedErasures(erasures)).toEqual([]);
	});

	it("covers the task schema flag combinations", () => {
		const erasures: Erasure[] = [];
		const combos = [
			{ isolationEnabled: true, batchEnabled: false },
			{ isolationEnabled: false, batchEnabled: true },
			{ isolationEnabled: true, batchEnabled: true },
			{ isolationEnabled: false, batchEnabled: false, effortEnabled: true },
		];
		for (const [index, combo] of combos.entries()) {
			const parameters = getTaskSchema(combo);
			const wire = toolWireSchema(asTool(`task:combo${index}`, "task variant", parameters));
			walkSchema(`task:combo${index}`, "", wire, erasures);
		}
		expect(erasureMessage(unexpectedErasures(erasures))).toBe("");
		expect(unexpectedErasures(erasures)).toEqual([]);
	});

	it("covers the async bash variant", () => {
		const tool = new BashTool(createSession({ "async.enabled": true }));
		const erasures: Erasure[] = [];
		walkSchema("bash:async", "", toolWireSchema(tool), erasures);
		expect(erasureMessage(unexpectedErasures(erasures))).toBe("");
		expect(unexpectedErasures(erasures)).toEqual([]);
	});

	it("covers every yield outputSchema path and keeps the `true` case description-only", () => {
		// yield's outputSchema reaches the wire as a `data` property; the
		// user-requested `true` case deliberately emits an unconstrained
		// description string that escapes normalizeEmptySchemas. It must stay
		// description-only: any structural `true`/`{}` would be a real erasure.
		const outputSchemas: Array<[string, unknown]> = [
			[
				"strict",
				{ type: "object", properties: { x: { type: "string" } }, required: ["x"], additionalProperties: false },
			],
			["non-strict", { type: "object", properties: { x: { type: "string" } } }],
			["true", true],
			["invalid", { type: "definitely-not-a-type" }],
		];
		const erasures: Erasure[] = [];
		for (const [label, outputSchema] of outputSchemas) {
			const tool = new YieldTool(createSession({ "~outputSchema": outputSchema }));
			walkSchema(`yield:${label}`, "", toolWireSchema(tool), erasures);
		}
		expect(erasureMessage(unexpectedErasures(erasures))).toBe("");
		expect(unexpectedErasures(erasures)).toEqual([]);

		const trueCase = toolWireSchema(new YieldTool(createSession({ "~outputSchema": true })));
		const data = findDataProperty(trueCase);
		const dataKeys = Object.keys(data as Record<string, unknown>);
		// The `true` outputSchema case stays non-structural: a description plus
		// (after normalizeEmptySchemas) an open additionalProperties — never a
		// schema constraint the provider would enforce or misread.
		expect(dataKeys.every(key => key === "description" || key === "additionalProperties")).toBe(true);
		// additionalProperties, when present (the loose-fallback shapes), is the
		// open-record marker only — never a structural constraint.
		const additional = (data as Record<string, unknown>).additionalProperties;
		expect(additional === undefined || additional === true).toBe(true);
		expect(typeof (data as Record<string, unknown>).description).toBe("string");
	});

	it("constructs the memory tools directly and walks their schemas", () => {
		// createIf returns null without a memory backend, which would silently
		// drop these from discovery-based coverage; construct directly.
		const hindsight = createSession({ "memory.backend": "hindsight" });
		const mnemopi = createSession({ "memory.backend": "mnemopi" });
		const tools = [
			new MemoryEditTool(mnemopi),
			new MemoryRecallTool(hindsight),
			new MemoryReflectTool(hindsight),
			new MemoryRetainTool(hindsight),
		];
		const erasures: Erasure[] = [];
		for (const tool of tools) {
			walkSchema(tool.name, "", toolWireSchema(tool), erasures);
		}
		expect(erasureMessage(unexpectedErasures(erasures))).toBe("");
		expect(unexpectedErasures(erasures)).toEqual([]);
	});
});

/**
 * Registration-time surface the shipped examples touch. A Proxy answers
 * anything else with a no-op, so an example gaining an unrelated API call does
 * not turn this into a false failure — the point is to run the REAL parameter
 * definitions, not to reimplement the extension host.
 */
function stubExtensionApi(registered: Array<{ name: string; parameters: unknown }>): unknown {
	const noop = (): unknown => undefined;
	const record = (definition: { name?: string; parameters?: unknown }): void => {
		if (definition?.parameters !== undefined) {
			registered.push({ name: definition.name ?? "unnamed", parameters: definition.parameters });
		}
	};
	const surface: Record<string, unknown> = {
		zod,
		logger: new Proxy({}, { get: () => noop }),
		registerTool: record,
		registerCommand: (_name: string, definition: { parameters?: unknown }) => record(definition),
	};
	return new Proxy(surface, {
		get: (target, key) => (key in target ? target[key as string] : noop),
	});
}

/**
 * Load a shipped example and return the parameter schemas it registers.
 *
 * The specifier is assembled at runtime on purpose: a static import would pull
 * the examples into this package's typecheck, and they sit outside its tsconfig
 * with pre-existing errors. Executing them keeps the contract honest — an
 * example that starts emitting an unconstrained schema fails here, which a
 * re-declared copy of its literals could not catch.
 */
async function exampleParameters(relativePath: string): Promise<Array<{ name: string; parameters: unknown }>> {
	const examples = path.resolve(import.meta.dir, "../../examples");
	const moduleUrl = Bun.pathToFileURL(path.join(examples, relativePath)).href;
	// Dynamic import exception: a static specifier would drag the examples into
	// this package's typecheck, where they do not belong (see above).
	const loaded: { default?: unknown } = await import(moduleUrl);
	const factory = loaded.default;
	if (typeof factory !== "function") throw new Error(`${relativePath} has no default export function`);
	const registered: Array<{ name: string; parameters: unknown }> = [];
	const api = stubExtensionApi(registered);
	// Extensions register through the api; custom-tool factories return one
	// definition directly.
	const returned = (factory as (api: unknown) => unknown)(api);
	if (returned !== null && typeof returned === "object") {
		const definition = returned as { name?: string; parameters?: unknown };
		if (definition.parameters !== undefined) {
			registered.push({ name: definition.name ?? relativePath, parameters: definition.parameters });
		}
	}
	if (registered.length === 0) throw new Error(`${relativePath} registered no parameter schemas`);
	return registered;
}

describe("shipped example extension schemas are structurally constrained", () => {
	const examples = [
		"extensions/hello.ts",
		"extensions/api-demo.ts",
		"extensions/reload-runtime.ts",
		"extensions/with-deps/index.ts",
		"custom-tools/hello/index.ts",
	];

	for (const relativePath of examples) {
		it(`emits a structural schema for examples/${relativePath}`, async () => {
			const registered = await exampleParameters(relativePath);
			for (const { name, parameters } of registered) {
				const label = `${relativePath}#${name}`;
				const wire = toolWireSchema(asTool("example", label, parameters));
				const erasures: Erasure[] = [];
				walkSchema(label, "", wire, erasures);
				expect(erasureMessage(erasures)).toBe("");
				// Every example authors with `z.object`, so the wire schema must be
				// a typed object map (reload-runtime legitimately has no props).
				const json = wire as Record<string, unknown>;
				expect(json.type).toBe("object");
				expect(json.properties).toBeObject();
			}
		});
	}
});
