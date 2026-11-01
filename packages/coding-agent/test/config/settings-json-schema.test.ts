import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { TJsonSchema } from "@oh-my-pi/pi-ai";
import { isJsonSchemaValueValid, validateJsonSchemaValue } from "@oh-my-pi/pi-ai/utils/schema";
import { orderedSettings } from "@oh-my-pi/pi-coding-agent/config/all-settings";
import { type AnySetting, Setting, type SettingDefinition } from "@oh-my-pi/pi-coding-agent/config/registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSettingsJsonSchema } from "@oh-my-pi/pi-coding-agent/config/settings-json-schema";
import { formatKeyHint, keyHintPlatform, setKeyHintPlatform } from "@oh-my-pi/pi-tui/app-keybindings";
import { activeSymbolTheme, setActiveSymbolTheme } from "@oh-my-pi/pi-tui/theme/active-symbols";
import { loadTheme } from "@oh-my-pi/pi-tui/theme/loader";
import type { Theme } from "@oh-my-pi/pi-tui/theme/theme-class";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import { generateConfigSchemaArtifacts } from "../../scripts/gen-config-schema";
import committedSchema from "../../src/config/omp-config.schema.json" with { type: "json" };

function setting(definition: SettingDefinition): AnySetting {
	return new Setting(definition);
}

const ui = (description: string) => ({ tab: "appearance", label: "Fixture", description }) as const;

const fixture: readonly AnySetting[] = [
	setting({ id: "mode", type: "enum", values: ["a", "b"], default: "a", ui: ui("Mode") }),
	setting({
		id: "segments",
		type: "array",
		default: ["x"],
		items: { values: ["x", "y"], label: "segment" },
	}),
	setting({ id: "enabledThings", type: "array", default: [], pathScoped: { valuesKey: "things" } }),
	setting({ id: "roles", type: "record", default: {} }),
	setting({ id: "group.nested.flag", type: "boolean", default: true }),
	setting({ id: "group.token", type: "string", default: "secret-default", credential: true }),
];

/** `value` as a schema object; throws on anything else so an unexpected node fails the test. */
function schemaNode(value: unknown, at: string): TJsonSchema {
	if (!isRecord(value)) throw new Error(`expected a schema object at ${at}, got ${JSON.stringify(value)}`);
	return value;
}

/** The entries of `schema.properties` (empty when absent). */
function schemaProperties(schema: TJsonSchema): Record<string, TJsonSchema> {
	if (schema.properties === undefined) return {};
	const properties: Record<string, TJsonSchema> = {};
	for (const [key, child] of Object.entries(schemaNode(schema.properties, "properties"))) {
		properties[key] = schemaNode(child, `properties.${key}`);
	}
	return properties;
}

/** The branches of `schema.anyOf` (empty when absent). */
function schemaBranches(schema: TJsonSchema): TJsonSchema[] {
	if (schema.anyOf === undefined) return [];
	if (!Array.isArray(schema.anyOf)) throw new Error(`expected an anyOf array, got ${JSON.stringify(schema.anyOf)}`);
	return schema.anyOf.map((branch, index) => schemaNode(branch, `anyOf[${index}]`));
}

/** `schema.items` or `schema.contains` (undefined when absent). */
function subschema(schema: TJsonSchema, keyword: "items" | "contains"): TJsonSchema | undefined {
	return schema[keyword] === undefined ? undefined : schemaNode(schema[keyword], keyword);
}

function property(schema: TJsonSchema, ...segments: string[]): TJsonSchema {
	let node = schema;
	for (const segment of segments) {
		const next = schemaProperties(node)[segment];
		if (!next) throw new Error(`missing property ${segments.join(".")}`);
		node = next;
	}
	return node;
}

const hintedSetting = (description: () => string): AnySetting =>
	setting({
		id: "hinted",
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			label: "Hinted",
			get description() {
				return description();
			},
		},
	});

describe("settings JSON schema", () => {
	let initialSymbolTheme: Theme | undefined;
	beforeEach(() => {
		initialSymbolTheme = activeSymbolTheme();
	});
	afterEach(() => {
		setKeyHintPlatform(undefined);
		setActiveSymbolTheme(initialSymbolTheme);
	});

	it("committed omp-config.schema.json matches a fresh `bun run gen:config-schema`", async () => {
		for (const [file, contents] of generateConfigSchemaArtifacts()) {
			expect(await Bun.file(file).text(), file).toBe(contents);
		}
	});

	it("maps setting kinds to value schemas", () => {
		const schema = buildSettingsJsonSchema(fixture);

		expect(property(schema, "mode")).toEqual({ description: "Mode", type: "string", enum: ["a", "b"], default: "a" });
		expect(property(schema, "segments")).toEqual({
			type: "array",
			items: { type: "string", enum: ["x", "y"] },
			default: ["x"],
		});
		expect(property(schema, "roles")).toEqual({ type: "object", additionalProperties: true, default: {} });
	});

	it("accepts strings and path-scoped objects in path-scoped arrays", () => {
		const items = subschema(property(buildSettingsJsonSchema(fixture), "enabledThings"), "items");
		const [plain, scoped] = items ? schemaBranches(items) : [];

		expect(plain).toEqual({ type: "string" });
		expect(scoped?.additionalProperties).toBe(false);
		for (const key of ["path", "paths", "pathPrefix", "pathPrefixes", "values", "items", "things"]) {
			expect(scoped?.properties, key).toHaveProperty(key);
		}
		expect(schemaProperties(scoped ?? {}).things).toEqual({
			anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
		});
		expect(scoped?.anyOf).toEqual([
			{ required: ["path"] },
			{ required: ["paths"] },
			{ required: ["pathPrefix"] },
			{ required: ["pathPrefixes"] },
		]);
	});

	it("nests dotted ids in closed groups under an open top level", () => {
		const schema = buildSettingsJsonSchema(fixture);

		expect(schema.additionalProperties).toBe(true);
		expect(property(schema, "$schema").type).toBe("string");
		expect(schemaProperties(schema)["group.nested.flag"]).toBeUndefined();
		const group = property(schema, "group");
		expect(group.additionalProperties).toBe(false);
		expect(property(group, "nested").additionalProperties).toBe(false);
		expect(property(group, "nested", "flag")).toEqual({ type: "boolean", default: true });
	});

	it("never emits a credential's default", () => {
		expect(property(buildSettingsJsonSchema(fixture), "group", "token")).toEqual({ type: "string" });
	});

	it("accepts either the value or the nested group at a prefix that is also a setting", () => {
		const schema = buildSettingsJsonSchema([
			setting({ id: "tool", type: "boolean", default: false }),
			setting({ id: "tool.limit", type: "number", default: 3 }),
		]);

		expect(property(schema, "tool")).toEqual({
			anyOf: [
				{ type: "boolean", default: false },
				{
					type: "object",
					properties: { limit: { type: "number", default: 3 } },
					additionalProperties: false,
				},
			],
		});
	});

	it("renders key hints the same on every host platform and restores the platform", () => {
		const hinted = [
			setting({
				id: "hinted",
				type: "boolean",
				default: false,
				ui: {
					tab: "appearance",
					label: "Hinted",
					get description() {
						return `Press ${formatKeyHint("ctrl+c")}`;
					},
				},
			}),
		];

		setKeyHintPlatform("darwin");
		const onMac = buildSettingsJsonSchema(hinted);
		expect(keyHintPlatform()).toBe("darwin");
		setKeyHintPlatform("win32");
		const onWindows = buildSettingsJsonSchema(hinted);
		expect(keyHintPlatform()).toBe("win32");

		expect(onMac).toEqual(onWindows);
		expect(property(onMac, "hinted").description).toBe("Press Ctrl+C");
	});

	it("renders symbols with the ascii preset whatever theme is active, and restores the theme", async () => {
		const hinted = [hintedSetting(() => `Press ${formatKeyHint("shift+tab")}`)];
		setActiveSymbolTheme(undefined);
		const asciiHint = formatKeyHint("shift+tab");
		const ascii = buildSettingsJsonSchema(hinted);
		const unicode = await loadTheme("dark", { symbolPresetOverride: "unicode" });
		setActiveSymbolTheme(unicode);
		expect(formatKeyHint("shift+tab")).not.toBe(asciiHint);

		expect(buildSettingsJsonSchema(hinted)).toEqual(ascii);
		expect(activeSymbolTheme()).toBe(unicode);
	});

	it("restores the key-hint platform and symbol theme when a description throws", async () => {
		const unicode = await loadTheme("dark", { symbolPresetOverride: "unicode" });
		setActiveSymbolTheme(unicode);
		setKeyHintPlatform("darwin");
		const failing = [
			hintedSetting(() => {
				throw new Error("description failed");
			}),
		];

		expect(() => buildSettingsJsonSchema(failing)).toThrow("description failed");
		expect(keyHintPlatform()).toBe("darwin");
		expect(activeSymbolTheme()).toBe(unicode);
	});
});

/** `{ a: { b: value } }` for the dotted path `a.b`; entries merge into one document. */
function nest(entries: Record<string, unknown>): Record<string, unknown> {
	const doc: Record<string, unknown> = {};
	for (const [dotted, value] of Object.entries(entries)) {
		const segments = dotted.split(".");
		let node = doc;
		for (const segment of segments.slice(0, -1)) {
			node[segment] ??= {};
			node = node[segment] as Record<string, unknown>;
		}
		node[segments.at(-1) as string] = value;
	}
	return doc;
}

/** Dotted paths of every node the schema marks deprecated (a removed key or a legacy-shape branch). */
function deprecatedPaths(schema: TJsonSchema, prefix = ""): string[] {
	const paths: string[] = [];
	const branches = schemaBranches(schema);
	if (prefix && (schema.deprecated || branches.some(branch => branch.deprecated))) paths.push(prefix);
	for (const [key, child] of Object.entries(schemaProperties(schema))) {
		paths.push(...deprecatedPaths(child, prefix ? `${prefix}.${key}` : key));
	}
	for (const branch of branches) {
		if (branch.deprecated) continue;
		for (const [key, child] of Object.entries(schemaProperties(branch))) {
			paths.push(...deprecatedPaths(child, `${prefix}.${key}`));
		}
	}
	return paths;
}

/** The schema with every deprecated property and branch removed: the current shapes only. */
function withoutDeprecated(schema: TJsonSchema): TJsonSchema {
	const result: TJsonSchema = { ...schema };
	if (schema.properties) {
		const properties: Record<string, TJsonSchema> = {};
		for (const [key, child] of Object.entries(schemaProperties(schema))) {
			if (!child.deprecated) properties[key] = withoutDeprecated(child);
		}
		result.properties = properties;
	}
	if (schema.anyOf) {
		result.anyOf = schemaBranches(schema)
			.filter(branch => !branch.deprecated)
			.map(withoutDeprecated);
	}
	const items = subschema(schema, "items");
	if (items) result.items = withoutDeprecated(items);
	return result;
}

/** One sample per legacy shape the loader migrates (`#migrateRawSettings` in `config/settings.ts`). */
const LEGACY_SAMPLES: Record<string, unknown> = {
	doubleEscapeAction: "branch",
	theme: "dark",
	"task.eager": true,
	"task.simple": true,
	"task.isolation.mode": "worktree",
	"task.completionProbeMs": 500,
	"todo.eager": false,
	"todo.reminders": { max: 3 },
	"features.unexpectedStopDetection": true,
	"isolation.backend": "fuse-overlay",
	"edit.mode": "atom",
	"snapcompact.systemPrompt": true,
	inlineToolDescriptors: true,
	"find.enabled": false,
	"spelling.autocomplete": true,
	"statusLine.leftSegments": ["plan_mode", "model"],
	"statusLine.rightSegments": ["plan_mode"],
	"codexResets.autoRedeem": false,
	"memory.backend": "mnemosyne",
	"dev.autoqa": { consent: "granted" },
	"compaction.strategy": "handoff",
	"compaction.remoteEnabled": false,
	"providers.parallelFetch": true,
	"providers.webSearch": "auto",
	"providers.webSearchOrder": [],
	"providers.webSearchExclude": [],
	"providers.webSearchGeminiModel": "",
	"providers.image": "auto",
	"providers.imageOrder": [],
	"providers.tts": "auto",
	"providers.judgmentProvider": "auto",
	"providers.autoThinkingModel": "online",
	"providers.unexpectedStopModel": "online",
	"providers.tinyModel": "online",
	"providers.memoryModel": "online",
	"tts.localModel": "kokoro",
	"stt.modelName": "custom",
	"hindsight.dynamicBankId": true,
	"hindsight.agentName": "omp",
	"hindsight.mentalModelRefreshIntervalMs": 60000,
	"power.preventIdleSleep": true,
	"power.preventSystemSleep": false,
	"power.declareUserActive": false,
	"power.preventDisplaySleep": false,
	"advisor.subagents": false,
	"tools.discoveryMode": "bm25",
	"tools.essentialOverride": [],
	"mcp.discoveryMode": "bm25",
	"mcp.discoveryDefaultServers": [],
	"exa.enableSearch": true,
	"exa.enableResearcher": true,
	"exa.enableWebsets": false,
	"computer.backend": "native",
	queueMode: "all",
	lastChangelogVersion: "18.0.0",
	collapseChangelog: true,
	inspect_image: { timeoutMs: 30000 },
	mnemosyne: {},
	search: { enabled: true },
	readHashLines: true,
	serviceTier: "priority",
	serviceTierSubagent: "openai-only",
	serviceTierAdvisor: "default",
	fastModeScope: "all",
};

/** Every keyword the builder emits; each is either validated by the in-tree validator or an annotation. */
const EMITTED_KEYWORDS = new Set([
	"$schema",
	"$id",
	"title",
	"description",
	"default",
	"deprecated",
	"type",
	"enum",
	"items",
	"contains",
	"properties",
	"additionalProperties",
	"required",
	"anyOf",
]);

/** Keywords used anywhere in `schema` (property names under `properties` are not keywords). */
function keywordsOf(schema: TJsonSchema): string[] {
	const keywords = Object.keys(schema);
	const children = [
		...Object.values(schemaProperties(schema)),
		...schemaBranches(schema),
		subschema(schema, "items"),
		subschema(schema, "contains"),
	];
	for (const child of children) if (child) keywords.push(...keywordsOf(child));
	return keywords;
}

/** Fails with the validator's issues; `anyOf` may report issues from rejected branches on success. */
function expectValid(schema: TJsonSchema, value: unknown, label = ""): void {
	const result = validateJsonSchemaValue(schema, value);
	expect(result.success, `${label} ${JSON.stringify(result.issues)}`).toBe(true);
}

describe("settings JSON schema under the in-tree validator", () => {
	const schema: TJsonSchema = committedSchema;
	// The current shapes with a closed top level, so a retired top-level key is rejected too.
	const currentShapes: TJsonSchema = { ...withoutDeprecated(schema), additionalProperties: false };

	it("uses only the keywords the builder is known to emit", () => {
		expect([...new Set(keywordsOf(schema))].filter(keyword => !EMITTED_KEYWORDS.has(keyword))).toEqual([]);
	});

	it("accepts every registered non-credential default at its own path", () => {
		const rejected = orderedSettings()
			.filter(entry => !entry.isCredential && entry.definition.default !== undefined)
			.filter(
				entry => !isJsonSchemaValueValid(schema, nest({ [entry.segments.join(".")]: entry.definition.default })),
			)
			.map(entry => entry.segments.join("."));

		expect(rejected).toEqual([]);
	});

	it("accepts a hand-written config with path-scoped entries, records, $schema, and unknown top-level keys", () => {
		const config = {
			$schema: "https://github.com/can1357/oh-my-pi/releases/latest/download/omp-config.schema.json",
			defaultThinkingLevel: "medium",
			compaction: { enabled: false },
			theme: { dark: "titanium" },
			statusLine: { leftSegments: ["model", "path"], segmentOptions: { model: { showThinking: true } } },
			modelRoles: { default: "anthropic/claude-opus-5-5", smol: "anthropic/claude-haiku-5-5" },
			enabledModels: ["anthropic/*", { pathPrefix: "~/work", values: ["openai/*"] }],
			myPluginSetting: { anything: 1 },
		};

		expectValid(schema, config);
	});

	it("rejects a misspelled key inside a known group", () => {
		const result = validateJsonSchemaValue(schema, { compaction: { enabeld: false } });

		expect(result.success).toBe(false);
		expect(result.issues).toContainEqual(
			expect.objectContaining({ keyword: "additionalProperties", path: ["compaction", "enabeld"] }),
		);
	});

	it("accepts each legacy shape the loader migrates only through a deprecated branch", () => {
		expect(deprecatedPaths(schema).sort()).toEqual(Object.keys(LEGACY_SAMPLES).sort());

		for (const [key, value] of Object.entries(LEGACY_SAMPLES)) {
			const doc = nest({ [key]: value });
			expectValid(schema, doc, key);
			expect(isJsonSchemaValueValid(currentShapes, doc), key).toBe(false);
		}
	});

	it("accepts a retired status-line segment only beside known segments", () => {
		const segments = (leftSegments: string[]) => ({ statusLine: { leftSegments } });

		expect(isJsonSchemaValueValid(schema, segments(["plan_mode", "modle"]))).toBe(false);
		expectValid(schema, segments(["plan_mode", "mode"]));
		expect(isJsonSchemaValueValid(currentShapes, segments(["plan_mode", "mode"]))).toBe(false);
	});

	it("loads the legacy shapes into a config the current shapes accept", async () => {
		await using tempDir = TempDir.createSync("@pi-config-schema-legacy-");
		const agentDir = tempDir.join("agent");
		await Bun.write(path.join(agentDir, "config.yml"), JSON.stringify(nest(LEGACY_SAMPLES)));
		// Capability discovery also reads user-level files under the home directory and PI_CONFIG_FILES overlays.
		const originalHome = process.env.HOME;
		const originalConfigFiles = process.env.PI_CONFIG_FILES;
		process.env.HOME = tempDir.path();
		delete process.env.PI_CONFIG_FILES;
		vi.spyOn(os, "homedir").mockReturnValue(tempDir.path());
		try {
			const settings = await Settings.loadReadOnly({ agentDir, cwd: tempDir.join("project") });

			expectValid(currentShapes, settings.getGlobalSettings());
		} finally {
			vi.restoreAllMocks();
			if (originalHome === undefined) delete process.env.HOME;
			else process.env.HOME = originalHome;
			if (originalConfigFiles === undefined) delete process.env.PI_CONFIG_FILES;
			else process.env.PI_CONFIG_FILES = originalConfigFiles;
		}
	});
});
