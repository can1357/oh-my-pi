import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { expandAtImports } from "../discovery/at-imports";
import { BUILTIN_TOOL_NAMES, normalizeToolNames } from "../tools/builtin-names";
import { collectConfigCandidates } from "./watchdog";

/**
 * One advisor declared in a `WATCHDOG.yml` file. `model` is a model selector
 * with an optional `:level` thinking suffix (e.g. `x-ai/grok-code-fast:high`),
 * resolved exactly like any other model override; `tools` is a subset of
 * `BUILTIN_TOOL_NAMES` — any built-in name, including mutating tools such as
 * `edit`/`write`/`bash` (the advisor is a full agent). Omitted falls back to
 * the default `read`/`grep`/`glob` subset (plus `recall` when the active
 * memory backend provides it); an explicit empty list grants no
 * tools. `instructions` is the advisor's specialization, appended to the shared
 * baseline.
 */
export interface AdvisorConfig {
	/** Canonical namespace/id after discovery; a local ID in an editable YAML definition. */
	id?: string;
	ref?: never;
	name: string;
	model?: string;
	tools?: string[];
	/** Exact session agent names (case-insensitive, trimmed). Omitted matches all; [] matches none. */
	agents?: string[];
	instructions?: string;
	/** Per-advisor on/off toggle (default `true`). When `false`, the advisor
	 *  stays in the roster but its runtime is never built — it shows `○` in
	 *  the status line and `/advisor status` rather than disappearing. */
	enabled?: boolean;
	/**
	 * Per-advisor maximum non-blocker advice notes accepted per advisor prompt
	 * update (default `4`). Blockers are exempt from the budget.
	 */
	maxNotesPerUpdate?: number;
}

export type AgentWatchdog = (Omit<AdvisorConfig, "name" | "agents"> & { id: string; name?: string }) | { ref: string };

export interface WatchdogReference {
	ref: string;
	agents?: string[];
	enabled?: boolean;
	id?: never;
	name?: never;
	model?: never;
	tools?: never;
	instructions?: never;
	maxNotesPerUpdate?: never;
}

export type WatchdogRosterEntry = AdvisorConfig | WatchdogReference;

function normalizeWatchdogId(value: string): string {
	const id = value.trim().toLowerCase();
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
		throw new Error(`Invalid watchdog ID "${value}": expected a safe hyphenated slug`);
	}
	return id;
}

function normalizeWatchdogRef(value: string): string {
	const reference = value.trim();
	const separator = reference.lastIndexOf("/");
	if (separator < 1) throw new Error(`Invalid watchdog reference "${value}": expected namespace/id`);
	const namespace = reference.slice(0, separator).trim().toLowerCase();
	if (!namespace) throw new Error(`Invalid watchdog reference "${value}": expected namespace/id`);
	return `${namespace}/${normalizeWatchdogId(reference.slice(separator + 1))}`;
}

function validateReference(value: Record<string, unknown>, allowed: readonly string[]): void {
	if (typeof value.ref !== "string") throw new Error("Watchdog reference must be a string");
	normalizeWatchdogRef(value.ref);
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) throw new Error(`Watchdog reference "${value.ref}" cannot contain "${key}"`);
	}
}

export class AgentWatchdogConfigError extends Error {
	override name = "AgentWatchdogConfigError";
}

/** Parse agent frontmatter without losing the distinction between absent and explicitly empty. */
export function parseAgentWatchdogs(value: unknown): AgentWatchdog[] | undefined {
	try {
		return parseAgentWatchdogEntries(value);
	} catch (error) {
		throw new AgentWatchdogConfigError(error instanceof Error ? error.message : String(error), { cause: error });
	}
}

function parseAgentWatchdogEntries(value: unknown): AgentWatchdog[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error("Agent watchdogs must be an array");
	const ids = new Set<string>();
	return value.map((entry, index) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			throw new Error(`Agent watchdogs[${index}] must be a definition or reference`);
		}
		if ("ref" in entry) {
			validateReference(entry, ["ref"]);
			return { ref: normalizeWatchdogRef(entry.ref) };
		}
		if (typeof entry.id !== "string") throw new Error(`Agent watchdogs[${index}] requires an id`);
		const id = normalizeWatchdogId(entry.id);
		if (ids.has(id)) throw new Error(`Duplicate agent watchdog ID "${id}"`);
		ids.add(id);
		for (const key of Object.keys(entry)) {
			if (!["id", "name", "model", "tools", "instructions", "enabled", "maxNotesPerUpdate"].includes(key)) {
				throw new Error(`Agent watchdog "${id}" has unsupported field "${key}"`);
			}
		}
		const result = advisorEntrySchema({ ...entry, id, name: entry.name ?? id });
		if (result instanceof type.errors) throw new Error(`Agent watchdog "${id}": ${result.summary}`);
		return { ...result, id };
	});
}

export interface AdvisorDiscoveryOptions {
	agentName?: string;
	agentDefinitions?: readonly { name: string; filePath?: string; watchdogs?: AgentWatchdog[] }[];
}

/**
 * Runtime health of a single advisor, surfaced in stats and the status line.
 * - `running` — actively processing primary turns
 * - `paused` — user-toggled off via per-advisor switch (runtime disposed)
 * - `quota_exhausted` — provider returned a quota/rate-limit error; the
 *   runtime auto-retries after a cooldown so it can resume without user action
 * - `error` — repeated transient failures; backlog dropped to prevent stall
 * - `no_model` — no model resolved for this advisor's role/explicit model
 */
export type AdvisorRuntimeStatus = "running" | "paused" | "quota_exhausted" | "error" | "no_model";

/**
 * The result of walking the `WATCHDOG.yml`/`WATCHDOG.yaml` search path: the
 * deduped advisor roster plus the concatenated top-level `instructions` baseline
 * that is prepended (alongside `WATCHDOG.md`) to every advisor.
 */
export interface DiscoveredAdvisors {
	advisors: AdvisorConfig[];
	sharedInstructions: string | undefined;
	sharedMaxNotesPerUpdate?: number;
	explicitSelection?: boolean;
	hasConfiguredRoster?: boolean;
}

const advisorEntrySchema = type({
	name: "string",
	"id?": "string",
	"model?": "string",
	"tools?": "string[]",
	"agents?": "string[]",
	"instructions?": "string",
	"enabled?": "boolean",
	"maxNotesPerUpdate?": "number",
});

const watchdogReferenceSchema = type({
	ref: "string",
	"agents?": "string[]",
	"enabled?": "boolean",
});

const watchdogYamlSchema = type({
	"instructions?": "string",
	"maxNotesPerUpdate?": "number",
	"advisors?": advisorEntrySchema.or(watchdogReferenceSchema).array(),
});

/**
 * Normalize an advisor name into a filesystem-/id-safe slug used for its
 * transcript filename and session id: lowercase, non-alphanumerics collapsed to
 * `-`, leading/trailing `-` trimmed. Falls back to `"advisor"` when nothing
 * survives; callers dedupe collisions.
 */
export function slugifyAdvisorName(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "advisor";
}

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADVISOR_PROVIDER_SESSION_KEY_SEPARATOR = "\u0000";

/**
 * Returns a stable provider-facing UUIDv7 for one advisor within one primary session.
 *
 * Codex treats `session_id`/`conversation_id` as a UUID-shaped routing identity,
 * so advisor labels such as `-advisor` stay local-only.
 */
export function getOrCreateAdvisorProviderSessionId(
	ids: Map<string, string>,
	primarySessionId: string | undefined,
	slug: string,
	randomSessionId: () => string = () => Bun.randomUUIDv7(),
): string | undefined {
	if (!primarySessionId) return undefined;
	const key = `${primarySessionId}${ADVISOR_PROVIDER_SESSION_KEY_SEPARATOR}${slug}`;
	const existing = ids.get(key);
	if (existing) return existing;

	const next = randomSessionId();
	if (!UUID_V7_PATTERN.test(next)) {
		throw new Error("Advisor provider session id generator returned a non-UUIDv7 value");
	}
	ids.set(key, next);
	return next;
}

/** Built tool names, for validating an advisor's `tools` list. */
const KNOWN_TOOL_NAMES = new Set<string>(BUILTIN_TOOL_NAMES);

/**
 * Keep only valid tool names from an advisor's `tools` list, dropping unknowns
 * with a warning. The advisor is a full agent, so any built tool may be granted;
 * the runtime further filters to what's actually available this session.
 * `undefined` means "use the default subset" (read/grep/glob); only an explicit
 * raw empty list means "no tools".
 */
function filterAdvisorTools(tools: string[] | undefined, sourcePath: string): string[] | undefined {
	if (tools === undefined) return undefined;
	if (tools.length === 0) return [];
	// Normalize legacy aliases (search→grep, find→glob) and dedupe before validating.
	const filtered = normalizeToolNames(tools).filter(name => {
		if (KNOWN_TOOL_NAMES.has(name)) return true;
		logger.warn("Advisor config: dropping unknown tool", { path: sourcePath, tool: name });
		return false;
	});
	return filtered.length > 0 ? filtered : undefined;
}

/** Resolve definitions first, then assignments, so references never depend on declaration order. */
export async function discoverAdvisorConfigs(
	cwd: string,
	agentDir?: string,
	options: AdvisorDiscoveryOptions = {},
): Promise<DiscoveredAdvisors> {
	const items = await collectConfigCandidates(cwd, agentDir, ["WATCHDOG.yml", "WATCHDOG.yaml"]);
	const definitions = new Map<string, { entry: AdvisorConfig; source: string }>();
	const assignments = new Map<string, { entry: WatchdogRosterEntry; source: string }>();
	const sharedParts: string[] = [];
	let sharedMaxNotesPerUpdate: number | undefined;
	const materialize = async (entry: AdvisorConfig, id: string, source: string): Promise<AdvisorConfig> => ({
		...entry,
		id,
		model: entry.model?.trim() || undefined,
		tools: filterAdvisorTools(entry.tools, source),
		instructions: entry.instructions?.trim()
			? (await expandAtImports(entry.instructions, source)).trim() || undefined
			: undefined,
		maxNotesPerUpdate:
			typeof entry.maxNotesPerUpdate === "number" &&
			Number.isFinite(entry.maxNotesPerUpdate) &&
			entry.maxNotesPerUpdate >= 1
				? Math.trunc(entry.maxNotesPerUpdate)
				: undefined,
	});
	for (const item of items) {
		let parsed: unknown;
		try {
			parsed = YAML.parse(item.content);
		} catch (err) {
			logger.warn("Advisor config: failed to parse YAML", { path: item.path, error: String(err) });
			continue;
		}
		validateRosterReferences(parsed, item.path);
		const result = watchdogYamlSchema(parsed);
		if (result instanceof type.errors) {
			logger.warn("Advisor config: invalid schema", { path: item.path, error: result.summary });
			continue;
		}
		if (result.instructions?.trim()) {
			const expanded = (await expandAtImports(result.instructions, item.path)).trim();
			if (expanded) sharedParts.push(expanded);
		}
		if (
			typeof result.maxNotesPerUpdate === "number" &&
			Number.isFinite(result.maxNotesPerUpdate) &&
			result.maxNotesPerUpdate >= 1
		) {
			sharedMaxNotesPerUpdate = Math.trunc(result.maxNotesPerUpdate);
		}
		const localIds = new Set<string>();
		for (const entry of result.advisors ?? []) {
			if ("ref" in entry) {
				assignments.set(normalizeWatchdogRef(entry.ref), { entry, source: item.path });
				continue;
			}
			const id = `global/${entry.id === undefined ? slugifyAdvisorName(entry.name) : normalizeWatchdogId(entry.id)}`;
			if (localIds.has(id)) throw new Error(`${item.path}: duplicate watchdog ID "${id}"`);
			localIds.add(id);
			definitions.set(id, { entry, source: item.path });
			assignments.set(id, { entry: { ref: id, agents: entry.agents, enabled: entry.enabled }, source: item.path });
		}
	}
	let selected: AgentWatchdog[] | undefined;
	let selectedNamespace: string | undefined;
	let selectedSource = "Agent watchdogs";
	for (const agent of options.agentDefinitions ?? []) {
		const watchdogs = parseAgentWatchdogs(agent.watchdogs);
		if (watchdogs === undefined) continue;
		const namespace = agent.name.trim().toLowerCase();
		if (namespace === "global") throw new Error('Agent watchdog namespace "global" is reserved');
		if (agent.name.trim().toLowerCase() === options.agentName?.trim().toLowerCase()) {
			selected = watchdogs;
			selectedNamespace = namespace;
			selectedSource = agent.filePath ?? `Agent "${agent.name}"`;
		}
		for (const entry of watchdogs) {
			if (entry.ref !== undefined) continue;
			const id = `${namespace}/${entry.id}`;
			if (definitions.has(id)) throw new Error(`Duplicate watchdog ID "${id}"`);
			definitions.set(id, {
				entry: { ...entry, name: entry.name ?? entry.id },
				source: agent.filePath ?? path.join(cwd, "AGENT.md"),
			});
		}
	}
	const resolved = new Map<string, AdvisorConfig>();
	const resolve = async (id: string, source: string): Promise<AdvisorConfig> => {
		const cached = resolved.get(id);
		if (cached) return cached;
		const definition = definitions.get(id);
		if (!definition) throw new Error(`${source}: Unknown watchdog reference "${id}"`);
		return materialize(definition.entry, id, definition.source);
	};
	if (selected !== undefined) {
		for (const entry of selected) {
			const id = entry.ref !== undefined ? entry.ref : `${selectedNamespace}/${entry.id}`;
			if (resolved.has(id)) continue;
			// Explicit selection replaces global assignments and their agent selectors.
			resolved.set(id, { ...(await resolve(id, selectedSource)), agents: undefined });
		}
	} else {
		const agentName = options.agentName?.trim().toLowerCase();
		for (const [id, { entry: assignment, source }] of assignments) {
			if (
				agentName !== undefined &&
				assignment.agents !== undefined &&
				!assignment.agents.some(name => name.trim().toLowerCase() === agentName)
			)
				continue;
			if (assignment.enabled === false && !definitions.has(id)) continue;
			const definition = await resolve(id, source);
			resolved.set(id, {
				...definition,
				agents: assignment.agents,
				enabled: assignment.enabled ?? definition.enabled,
			});
		}
	}
	return {
		advisors: [...resolved.values()],
		sharedInstructions: sharedParts.length > 0 ? sharedParts.join("\n\n") : undefined,
		sharedMaxNotesPerUpdate,
		explicitSelection: selected !== undefined,
		hasConfiguredRoster: assignments.size > 0,
	};
}

function validateRosterReferences(value: unknown, source: string): void {
	if (!value || typeof value !== "object" || !("advisors" in value) || !Array.isArray(value.advisors)) return;
	for (const entry of value.advisors) {
		if (!entry || typeof entry !== "object") continue;
		try {
			if ("ref" in entry) {
				validateReference(entry, ["ref", "agents", "enabled"]);
				const result = watchdogReferenceSchema(entry);
				if (result instanceof type.errors) throw new Error(result.summary);
			} else if ("id" in entry) {
				if (typeof entry.id !== "string") throw new Error("Watchdog ID must be a string");
				normalizeWatchdogId(entry.id);
			}
		} catch (err) {
			throw new Error(`${source}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

/** Which level a `WATCHDOG.yml` lives at: the project root or the user agent dir. */
export type AdvisorConfigScope = "project" | "user";

/**
 * The editable contents of a single `WATCHDOG.yml` file: the shared top-level
 * `instructions` plus the advisor roster. Unlike {@link DiscoveredAdvisors}, this
 * is one file's raw view (no cross-level merge, no `@import` expansion) so the
 * config editor round-trips exactly what the user wrote.
 */
export interface WatchdogConfigDoc {
	instructions?: string;
	maxNotesPerUpdate?: number;
	advisors: WatchdogRosterEntry[];
}

/**
 * Resolve the `WATCHDOG.yml` path for a scope: `project` → `<projectDir>/WATCHDOG.yml`
 * (discovered by the project-level walk), `user` → `<agentDir>/WATCHDOG.yml` (the
 * user-level candidate).
 */
export function advisorConfigFilePath(
	scope: AdvisorConfigScope,
	dirs: { projectDir: string; agentDir: string },
): string {
	return path.join(scope === "user" ? dirs.agentDir : dirs.projectDir, "WATCHDOG.yml");
}

/**
 * Resolve which `WATCHDOG.{yml,yaml}` to edit for a scope: prefer the canonical
 * `.yml`, but when only a `.yaml` exists for that scope, edit it in place so an
 * existing `.yaml` user isn't shown a blank editor and left with two files at the
 * same precedence. Falls back to `.yml` when neither exists.
 */
export async function resolveAdvisorConfigEditPath(
	scope: AdvisorConfigScope,
	dirs: { projectDir: string; agentDir: string },
): Promise<string> {
	const dir = scope === "user" ? dirs.agentDir : dirs.projectDir;
	const yml = path.join(dir, "WATCHDOG.yml");
	const yaml = path.join(dir, "WATCHDOG.yaml");
	if (!(await Bun.file(yml).exists()) && (await Bun.file(yaml).exists())) return yaml;
	return yml;
}

/**
 * Load one `WATCHDOG.yml` file for editing — raw, un-merged, un-expanded. Missing,
 * unparseable, or legacy schema-invalid files yield an empty doc. Invalid IDs and
 * reference declarations throw so editing cannot silently erase those selections.
 */
export async function loadWatchdogConfigFile(filePath: string): Promise<WatchdogConfigDoc> {
	let text: string;
	try {
		text = await Bun.file(filePath).text();
	} catch (err) {
		if (!isEnoent(err))
			logger.warn("Advisor config: failed to read for edit", { path: filePath, error: String(err) });
		return { advisors: [] };
	}
	let parsed: unknown;
	try {
		parsed = YAML.parse(text);
	} catch (err) {
		logger.warn("Advisor config: failed to parse for edit", { path: filePath, error: String(err) });
		return { advisors: [] };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { advisors: [] };
	validateRosterReferences(parsed, filePath);
	const result = watchdogYamlSchema(parsed);
	if (result instanceof type.errors) {
		logger.warn("Advisor config: invalid schema for edit", { path: filePath, error: result.summary });
		return { advisors: [] };
	}
	const advisors = (result.advisors ?? []).map((a): WatchdogRosterEntry => {
		if ("ref" in a) return { ...a };
		if (a.id !== undefined) normalizeWatchdogId(a.id);
		const advisor: AdvisorConfig = { name: a.name };
		if (a.id !== undefined) advisor.id = a.id;
		if (a.model?.trim()) advisor.model = a.model;
		if (a.tools !== undefined) advisor.tools = [...a.tools];
		if (a.agents !== undefined) advisor.agents = [...a.agents];
		if (a.instructions?.trim()) advisor.instructions = a.instructions;
		if (a.enabled !== undefined) advisor.enabled = a.enabled;
		if (typeof a.maxNotesPerUpdate === "number" && Number.isFinite(a.maxNotesPerUpdate) && a.maxNotesPerUpdate >= 1) {
			advisor.maxNotesPerUpdate = Math.trunc(a.maxNotesPerUpdate);
		}
		return advisor;
	});
	const doc: WatchdogConfigDoc = { advisors };
	if (result.instructions?.trim()) doc.instructions = result.instructions;
	if (
		typeof result.maxNotesPerUpdate === "number" &&
		Number.isFinite(result.maxNotesPerUpdate) &&
		result.maxNotesPerUpdate >= 1
	) {
		doc.maxNotesPerUpdate = Math.trunc(result.maxNotesPerUpdate);
	}
	return doc;
}

/**
 * Serialize an editable doc back to canonical, hand-editable `WATCHDOG.yml`.
 * Multiline instruction fields use literal block scalars while scalar quoting
 * delegates to Bun's YAML encoder. Round-trips through {@link loadWatchdogConfigFile}.
 * Returns `""` for an empty doc.
 */

function appendYamlString(lines: string[], indent: string, key: string, value: string): void {
	const hasSignificantLeadingWhitespace = value.split("\n").some(line => /^[ \t]/.test(line));
	if (!value.includes("\n") || hasSignificantLeadingWhitespace) {
		lines.push(`${indent}${key}: ${YAML.stringify(value)}`);
		return;
	}
	const normalized = value.replaceAll("\r\n", "\n");
	let trailingNewlines = 0;
	for (let index = normalized.length - 1; index >= 0 && normalized[index] === "\n"; index--) {
		trailingNewlines++;
	}
	const chomp = trailingNewlines === 0 ? "|2-" : trailingNewlines === 1 ? "|2" : "|2+";
	const body = trailingNewlines === 0 ? normalized : normalized.slice(0, -trailingNewlines);
	lines.push(`${indent}${key}: ${chomp}`);
	for (const line of body.split("\n")) {
		lines.push(`${indent}  ${line}`);
	}
	for (let index = 1; index < trailingNewlines; index++) {
		lines.push(`${indent}  `);
	}
}

export function serializeWatchdogConfig(doc: WatchdogConfigDoc): string {
	const lines: string[] = [];
	if (doc.instructions?.trim()) appendYamlString(lines, "", "instructions", doc.instructions);
	if (
		typeof doc.maxNotesPerUpdate === "number" &&
		Number.isFinite(doc.maxNotesPerUpdate) &&
		doc.maxNotesPerUpdate >= 1
	) {
		lines.push(`maxNotesPerUpdate: ${Math.trunc(doc.maxNotesPerUpdate)}`);
	}
	if (doc.advisors.length > 0) {
		lines.push("advisors:");
		for (const advisor of doc.advisors) {
			if (advisor.ref !== undefined) {
				validateReference(advisor as unknown as Record<string, unknown>, ["ref", "agents", "enabled"]);
				lines.push(`  - ref: ${YAML.stringify(advisor.ref)}`);
			} else {
				lines.push(`  - name: ${YAML.stringify(advisor.name)}`);
				if (advisor.id !== undefined) {
					normalizeWatchdogId(advisor.id);
					lines.push(`    id: ${YAML.stringify(advisor.id)}`);
				}
			}
			if (advisor.model?.trim()) lines.push(`    model: ${YAML.stringify(advisor.model)}`);
			if (advisor.agents !== undefined) {
				if (advisor.agents.length === 0) {
					lines.push("    agents: []");
				} else {
					lines.push("    agents:");
					for (const agent of advisor.agents) {
						lines.push(`      - ${YAML.stringify(agent)}`);
					}
				}
			}
			if (advisor.tools !== undefined) {
				if (advisor.tools.length === 0) {
					lines.push("    tools: []");
				} else {
					lines.push("    tools:");
					for (const tool of advisor.tools) {
						lines.push(`      - ${YAML.stringify(tool)}`);
					}
				}
			}
			if (advisor.instructions?.trim()) {
				appendYamlString(lines, "    ", "instructions", advisor.instructions);
			}
			if (advisor.enabled !== undefined) lines.push(`    enabled: ${advisor.enabled}`);
			if (
				typeof advisor.maxNotesPerUpdate === "number" &&
				Number.isFinite(advisor.maxNotesPerUpdate) &&
				advisor.maxNotesPerUpdate >= 1
			) {
				lines.push(`    maxNotesPerUpdate: ${Math.trunc(advisor.maxNotesPerUpdate)}`);
			}
		}
	}
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/**
 * Write an editable doc to `WATCHDOG.yml`. An empty doc removes the file so
 * discovery falls back to the legacy single-advisor path rather than leaving an
 * empty config behind.
 */
export async function saveWatchdogConfigFile(filePath: string, doc: WatchdogConfigDoc): Promise<void> {
	const content = serializeWatchdogConfig(doc);
	if (!content.trim()) {
		try {
			await fs.rm(filePath, { force: true });
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
		return;
	}
	await Bun.write(filePath, content);
}
