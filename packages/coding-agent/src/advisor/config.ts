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
	name: string;
	model?: string;
	tools?: string[];
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
	/**
	 * Human-readable config problems collected during the walk: unparseable
	 * files and dropped entries. Surfaced as one aggregated session warning so
	 * a broken roster entry never fails silently.
	 */
	warnings: string[];
}

const advisorEntrySchema = type({
	name: "string",
	"model?": "string",
	"tools?": "string[]",
	"instructions?": "string",
	"enabled?": "boolean",
	"maxNotesPerUpdate?": "number",
});

type AdvisorYamlEntry = typeof advisorEntrySchema.infer;

/**
 * Validate one parsed `WATCHDOG.yml` document per entry instead of as a whole:
 * a single malformed advisor drops out with a warning naming it, while the
 * healthy entries still load. Also reports non-string `instructions` and a
 * non-list `advisors` key — both previously failed the whole file silently.
 */
function parseWatchdogDoc(
	doc: Record<string, unknown>,
	path: string,
): {
	instructions: string | undefined;
	entries: AdvisorYamlEntry[];
	sharedMaxNotesPerUpdate: number | undefined;
	warnings: string[];
} {
	const warnings: string[] = [];
	const rawInstructions = doc.instructions;
	const instructions = typeof rawInstructions === "string" ? rawInstructions : undefined;
	if (rawInstructions !== undefined && instructions === undefined) {
		warnings.push(`${path}: instructions must be a string — ignored`);
	}
	const rawMaxNotes = doc.maxNotesPerUpdate;
	const sharedMaxNotesPerUpdate =
		typeof rawMaxNotes === "number" && Number.isFinite(rawMaxNotes) && rawMaxNotes >= 1
			? Math.trunc(rawMaxNotes)
			: undefined;
	const rawAdvisors = doc.advisors;
	if (rawAdvisors !== undefined && !Array.isArray(rawAdvisors)) {
		warnings.push(`${path}: advisors must be a list — ignored`);
	}
	const entries: AdvisorYamlEntry[] = [];
	for (const [index, rawEntry] of (Array.isArray(rawAdvisors) ? rawAdvisors : []).entries()) {
		const result = advisorEntrySchema(rawEntry);
		if (result instanceof type.errors) {
			const rawName =
				rawEntry && typeof rawEntry === "object" ? (rawEntry as Record<string, unknown>).name : undefined;
			const label = typeof rawName === "string" && rawName.trim() ? `"${rawName}"` : `#${index + 1}`;
			warnings.push(`${path}: advisor ${label} dropped — ${result.summary}`);
			continue;
		}
		entries.push(result);
	}
	return { instructions, entries, sharedMaxNotesPerUpdate, warnings };
}

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

/**
 * Discover advisor configs from `WATCHDOG.yml`/`WATCHDOG.yaml` files on the same
 * user + project search path as `WATCHDOG.md`. Advisors are keyed by slug; a
 * more-specific file (project leaf > project ancestor > user) replaces an earlier
 * entry with the same slug. Top-level `instructions` across all files concatenate
 * into the shared baseline. A malformed file is logged and skipped — never
 * thrown — so a bad project config can't kill the session.
 */
export async function discoverAdvisorConfigs(cwd: string, agentDir?: string): Promise<DiscoveredAdvisors> {
	const items = await collectConfigCandidates(cwd, agentDir, ["WATCHDOG.yml", "WATCHDOG.yaml"]);
	const advisors = new Map<string, AdvisorConfig>();
	const sharedParts: string[] = [];
	let sharedMaxNotesPerUpdate: number | undefined;
	const warnings: string[] = [];
	const warn = (message: string, context?: Record<string, unknown>): void => {
		warnings.push(message);
		logger.warn("Advisor config", { ...context, error: message });
	};

	for (const item of items) {
		let parsed: unknown;
		try {
			parsed = YAML.parse(item.content);
		} catch (err) {
			warn(`${item.path}: failed to parse YAML (${String(err)}) — file skipped`, { path: item.path });
			continue;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			warn(`${item.path}: expected a YAML mapping — file skipped`, { path: item.path });
			continue;
		}
		const {
			instructions,
			entries,
			sharedMaxNotesPerUpdate: docSharedMaxNotes,
			warnings: docWarnings,
		} = parseWatchdogDoc(parsed as Record<string, unknown>, item.path);
		for (const message of docWarnings) warn(message, { path: item.path });

		if (instructions?.trim()) {
			const expanded = (await expandAtImports(instructions, item.path)).trim();
			if (expanded) sharedParts.push(expanded);
		}

		if (docSharedMaxNotes !== undefined) sharedMaxNotesPerUpdate = docSharedMaxNotes;

		for (const entry of entries) {
			const slug = slugifyAdvisorName(entry.name);
			const entryInstructions = entry.instructions?.trim()
				? (await expandAtImports(entry.instructions, item.path)).trim() || undefined
				: undefined;
			advisors.set(slug, {
				name: entry.name,
				model: entry.model?.trim() || undefined,
				tools: filterAdvisorTools(entry.tools, item.path),
				maxNotesPerUpdate:
					typeof entry.maxNotesPerUpdate === "number" &&
					Number.isFinite(entry.maxNotesPerUpdate) &&
					entry.maxNotesPerUpdate >= 1
						? Math.trunc(entry.maxNotesPerUpdate)
						: undefined,
				enabled: entry.enabled,
				instructions: entryInstructions,
			});
		}
	}

	return {
		advisors: [...advisors.values()],
		sharedInstructions: sharedParts.length > 0 ? sharedParts.join("\n\n") : undefined,
		sharedMaxNotesPerUpdate,
		warnings,
	};
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
	advisors: AdvisorConfig[];
	/** Per-entry problems found while loading (dropped entries). Shown when the file becomes active in the editor. */
	warnings?: string[];
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
 * Load one `WATCHDOG.yml` file for editing — raw, un-merged, un-expanded. Missing
 * or unparseable files yield an empty doc (never throws) so the editor opens
 * cleanly on a fresh or broken file. Validation is per entry, matching
 * discovery: malformed entries drop out of `advisors` and land in `warnings`
 * instead of blanking the whole editor.
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
		return { advisors: [], warnings: [`${filePath}: failed to parse YAML (${String(err)})`] };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		// Parity with discovery: a non-mapping document is reported, not silently blanked.
		const message = `${filePath}: expected a YAML mapping — file skipped`;
		logger.warn("Advisor config", { path: filePath, error: message });
		return { advisors: [], warnings: [message] };
	}
	const { instructions, entries, sharedMaxNotesPerUpdate, warnings } = parseWatchdogDoc(
		parsed as Record<string, unknown>,
		filePath,
	);
	for (const message of warnings) logger.warn("Advisor config", { path: filePath, error: message });
	const advisors = entries.map(a => {
		const advisor: AdvisorConfig = { name: a.name };
		if (a.model?.trim()) advisor.model = a.model;
		if (a.tools !== undefined) advisor.tools = [...a.tools];
		if (a.instructions?.trim()) advisor.instructions = a.instructions;
		if (a.enabled !== undefined) advisor.enabled = a.enabled;
		if (typeof a.maxNotesPerUpdate === "number" && Number.isFinite(a.maxNotesPerUpdate) && a.maxNotesPerUpdate >= 1) {
			advisor.maxNotesPerUpdate = Math.trunc(a.maxNotesPerUpdate);
		}
		return advisor;
	});
	const doc: WatchdogConfigDoc = { advisors };
	if (instructions?.trim()) doc.instructions = instructions;
	if (sharedMaxNotesPerUpdate !== undefined) doc.maxNotesPerUpdate = sharedMaxNotesPerUpdate;
	if (warnings.length > 0) doc.warnings = warnings;
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
			lines.push(`  - name: ${YAML.stringify(advisor.name)}`);
			if (advisor.model?.trim()) lines.push(`    model: ${YAML.stringify(advisor.model)}`);
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
