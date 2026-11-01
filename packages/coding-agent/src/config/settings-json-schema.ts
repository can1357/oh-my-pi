/**
 * JSON Schema (draft 2020-12) for `config.yml`, derived from the settings registry.
 *
 * Every known settings group is closed (`additionalProperties: false`) and keys are offered nested
 * only, never as flat dotted paths. The top level stays open so unknown keys and a `$schema` string
 * load without schema errors. Values are checked against the declared type, enum values and array
 * item vocabularies; record values (`modelRoles`, …) are accepted as any object.
 */
import type { TJsonSchema } from "@oh-my-pi/pi-ai";
import { keyHintPlatform, setKeyHintPlatform } from "@oh-my-pi/pi-tui/app-keybindings";
import { activeSymbolTheme, setActiveSymbolTheme } from "@oh-my-pi/pi-tui/theme/active-symbols";
import { orderedSettings } from "./all-settings";
import type { AnySetting } from "./registry";

/** Published location of the schema: the asset attached to every GitHub release. */
export const SETTINGS_JSON_SCHEMA_ID =
	"https://github.com/can1357/oh-my-pi/releases/latest/download/omp-config.schema.json";

/** Path keys of a path-scoped array entry (`config/settings.ts` resolves them). */
const PATH_SCOPE_KEYS = ["path", "paths", "pathPrefix", "pathPrefixes"] as const;

/**
 * Pre-migration shapes `config/settings.ts` still rewrites on load (`#migrateRawSettings` and
 * `migrateNestedLeafRename`), keyed by dotted path. Keep in sync with those migrations: each shape is
 * accepted beside the current one and marked deprecated, so a not-yet-migrated file shows no errors.
 */
const LEGACY_SHAPES: Record<string, TJsonSchema> = {
	doubleEscapeAction: { type: "string", enum: ["branch"] },
	theme: { type: "string" },
	"task.eager": { type: "boolean" },
	"todo.eager": { type: "boolean" },
	"features.unexpectedStopDetection": { type: "boolean" },
	"isolation.backend": { type: "string", enum: ["worktree", "fuse-overlay", "fuse-projfs"] },
	"edit.mode": { type: "string", enum: ["atom", "vim"] },
	"snapcompact.systemPrompt": { type: "boolean" },
	inlineToolDescriptors: { type: "boolean" },
	"find.enabled": { type: "boolean" },
	"spelling.autocomplete": { type: "boolean" },
	"statusLine.leftSegments": { type: "array", contains: { type: "string", enum: ["plan_mode"] } },
	"statusLine.rightSegments": { type: "array", contains: { type: "string", enum: ["plan_mode"] } },
	"codexResets.autoRedeem": { type: "boolean" },
	"memory.backend": { type: "string", enum: ["mnemosyne"] },
	"dev.autoqa": { type: "object" },
	"todo.reminders": { type: "object" },
};

/**
 * Keys inside known groups that the same migrations drop, mapped to the setting that takes over
 * their value (`null`: ignored). Listed so a not-yet-migrated file shows no errors.
 */
const REMOVED_KEYS: Record<string, string | null> = {
	"task.simple": null,
	"task.isolation.mode": "task.isolation.enabled",
	"task.completionProbeMs": "task.completionProbe",
	"compaction.strategy": "compaction.methodOrder",
	"compaction.remoteEnabled": "compaction.methodOrder",
	"providers.parallelFetch": null,
	"providers.webSearch": "modelRoles.web",
	"providers.webSearchOrder": "modelRoles.web",
	"providers.webSearchExclude": "modelRoles.web",
	"providers.webSearchGeminiModel": "modelRoles.web",
	"providers.image": "modelRoles.image",
	"providers.imageOrder": "modelRoles.image",
	"providers.tts": "modelRoles.speech",
	"providers.judgmentProvider": "modelRoles.judge",
	"providers.autoThinkingModel": "modelRoles.judge",
	"providers.unexpectedStopModel": "modelRoles.judge",
	"providers.tinyModel": "modelRoles.tiny",
	"providers.memoryModel": "modelRoles.memory",
	"tts.localModel": null,
	"stt.modelName": "modelRoles.dictation",
	"hindsight.dynamicBankId": "hindsight.scoping",
	"hindsight.agentName": "hindsight.bankId",
	"hindsight.mentalModelRefreshIntervalMs": null,
	"power.preventIdleSleep": "power.sleepPrevention",
	"power.preventSystemSleep": "power.sleepPrevention",
	"power.declareUserActive": "power.sleepPrevention",
	"power.preventDisplaySleep": "power.sleepPrevention",
	"advisor.subagents": "task.agentAdvisor",
	"tools.discoveryMode": null,
	"tools.essentialOverride": null,
	"mcp.discoveryMode": null,
	"mcp.discoveryDefaultServers": null,
	"exa.enableSearch": "exa.enabled",
	"exa.enableResearcher": null,
	"exa.enableWebsets": null,
	"computer.backend": null,
};

/** One dotted-path segment: its path, the setting declared at it, and the settings nested below it. */
interface SettingsNode {
	path: string;
	setting?: AnySetting;
	children: Map<string, SettingsNode>;
}

/**
 * Builds the schema for `settings` (every registered setting by default), in their order.
 *
 * Descriptions render key hints with the Linux labels and the ascii symbol preset whatever the
 * host platform or active theme, so the output is identical everywhere; both are restored on return.
 */
export function buildSettingsJsonSchema(settings: readonly AnySetting[] = orderedSettings()): TJsonSchema {
	const previousPlatform = keyHintPlatform();
	const previousTheme = activeSymbolTheme();
	setKeyHintPlatform("linux");
	setActiveSymbolTheme(undefined);
	try {
		const root: SettingsNode = { path: "", children: new Map() };
		for (const setting of settings) {
			let node = root;
			for (const segment of setting.segments) {
				let child = node.children.get(segment);
				if (!child) {
					child = { path: node.path ? `${node.path}.${segment}` : segment, children: new Map() };
					node.children.set(segment, child);
				}
				node = child;
			}
			node.setting = setting;
		}
		return {
			$schema: "https://json-schema.org/draft/2020-12/schema",
			$id: SETTINGS_JSON_SCHEMA_ID,
			title: "OMP configuration",
			description: "Schema for config.yml (global, project, and --config overlays) of the OMP coding agent.",
			type: "object",
			properties: {
				$schema: { type: "string", description: "URI of the JSON Schema that validates this file." },
				...childSchemas(root),
			},
			additionalProperties: true,
		};
	} finally {
		setKeyHintPlatform(previousPlatform === process.platform ? undefined : previousPlatform);
		setActiveSymbolTheme(previousTheme);
	}
}

/** {@link buildSettingsJsonSchema} as written to `omp-config.schema.json`: tab-indented, newline-terminated. */
export function renderSettingsJsonSchema(settings?: readonly AnySetting[]): string {
	return `${JSON.stringify(buildSettingsJsonSchema(settings), null, "\t")}\n`;
}

function childSchemas(node: SettingsNode): Record<string, TJsonSchema> {
	const properties: Record<string, TJsonSchema> = {};
	for (const [segment, child] of node.children) properties[segment] = nodeSchema(child);
	if (node.path) {
		for (const [path, replacement] of Object.entries(REMOVED_KEYS)) {
			const segment = path.slice(node.path.length + 1);
			if (!path.startsWith(`${node.path}.`) || segment.includes(".") || segment in properties) continue;
			properties[segment] = {
				description: replacement
					? `Deprecated: migrated to \`${replacement}\` on load.`
					: "Deprecated: ignored on load.",
				deprecated: true,
			};
		}
	}
	return properties;
}

function nodeSchema(node: SettingsNode): TJsonSchema {
	const branches = currentShapes(node);
	const legacy = LEGACY_SHAPES[node.path];
	const deprecated = legacy ? [{ ...legacy, deprecated: true }] : [];
	if (branches.length > 1) return { anyOf: [...branches, ...deprecated] };
	if (!legacy) return branches[0];
	// The description and default stay on the outer node, where editors read them.
	const { description, default: defaultValue, ...shape } = branches[0];
	const schema: TJsonSchema = {};
	if (description) schema.description = description;
	schema.anyOf = [shape, ...deprecated];
	if (defaultValue !== undefined) schema.default = defaultValue;
	return schema;
}

/** The value shapes the node accepts today: its setting's, its group's, or both. */
function currentShapes(node: SettingsNode): [TJsonSchema, ...TJsonSchema[]] {
	if (node.children.size === 0 && node.setting) return [settingSchema(node.setting)];
	const group: TJsonSchema = { type: "object", properties: childSchemas(node), additionalProperties: false };
	// A prefix that is both a setting and a group accepts the setting's own value shape as well.
	return node.setting ? [settingSchema(node.setting), group] : [group];
}

function settingSchema(setting: AnySetting): TJsonSchema {
	const definition = setting.definition;
	const schema: TJsonSchema = {};
	const description = setting.ui?.description;
	if (description) schema.description = description;
	switch (definition.type) {
		case "boolean":
		case "string":
		case "number":
			schema.type = definition.type;
			break;
		case "enum":
			schema.type = "string";
			schema.enum = definition.values;
			break;
		case "array": {
			schema.type = "array";
			const entry: TJsonSchema | undefined = definition.items
				? { type: "string", enum: definition.items.values }
				: definition.pathScoped
					? { type: "string" }
					: undefined;
			if (definition.pathScoped && entry) {
				schema.items = { anyOf: [entry, pathScopedEntrySchema(entry, definition.pathScoped.valuesKey)] };
			} else if (entry) {
				schema.items = entry;
			}
			break;
		}
		case "record":
			schema.type = "object";
			schema.additionalProperties = true;
			break;
	}
	if (!setting.isCredential && definition.default !== undefined) schema.default = definition.default;
	return schema;
}

/** `{ path(s)/pathPrefix(es), values | items | <valuesKey> }`: values for working directories under the paths. */
function pathScopedEntrySchema(entry: TJsonSchema, valuesKey: string): TJsonSchema {
	const paths = oneOrMany({ type: "string" });
	const values = oneOrMany(entry);
	const properties: Record<string, TJsonSchema> = {};
	for (const key of PATH_SCOPE_KEYS) properties[key] = paths;
	for (const key of ["values", "items", valuesKey]) properties[key] = values;
	return {
		type: "object",
		properties,
		additionalProperties: false,
		anyOf: PATH_SCOPE_KEYS.map(key => ({ required: [key] })),
	};
}

function oneOrMany(schema: TJsonSchema): TJsonSchema {
	return { anyOf: [schema, { type: "array", items: schema }] };
}
