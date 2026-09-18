/**
 * Declarative workload specs: schema, discovery, and DAG validation.
 *
 * A workload is a YAML file describing a dependency graph of subagent steps
 * that omp executes directly — no model decides what runs next. The imperative
 * equivalent (a model writing `agent()`/`parallel()`/`pipeline()` calls in an
 * `eval` cell) already exists; this surface exists so a pipeline can be
 * committed, reviewed, diffed, and re-run identically from cron or CI.
 *
 * Loading mirrors `WATCHDOG.yml` (`src/advisor/config.ts`): Bun's built-in YAML
 * parser plus an omptype schema, with a malformed file reported rather than
 * crashing the run.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { getAgentDir, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { TASK_EFFORTS, type TaskEffort } from "@oh-my-pi/pi-tui/thinking";

/** Directory name probed at every level of the search path. */
const WORKLOAD_DIR = "workloads";
const WORKLOAD_EXTENSIONS = [".yml", ".yaml"];
/** Shared by workload names and step ids: filesystem- and reference-safe. */
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const DEFAULT_CONCURRENCY = 8;

const argSpecSchema = type({
	"required?": "boolean",
	"default?": "string",
	"description?": "string",
	"+": "delete",
});

const stepSchema = type({
	id: "string",
	"description?": "string",
	"prompt?": "string",
	"run?": "string[]",
	"agent?": "string",
	"model?": "string",
	"effort?": "string",
	"isolated?": "boolean",
	"output_schema?": "object",
	"needs?": "string[]",
	"for_each?": "string",
	"concurrency?": "number",
	"retries?": "number",
	"on_failure?": "string",
	"+": "delete",
});

const defaultsSchema = type({
	"agent?": "string",
	"model?": "string",
	"effort?": "string",
	"concurrency?": "number",
	"on_failure?": "string",
	"+": "delete",
});

const workloadYamlSchema = type({
	"version?": "number",
	name: "string",
	"description?": "string",
	"defaults?": defaultsSchema,
	"args?": { "[string]": argSpecSchema },
	steps: stepSchema.array(),
	"+": "delete",
});

/** What to do with the rest of the run when a step ends non-zero. */
export type WorkloadFailurePolicy = "abort" | "continue";

/** One declared input, filled from `--set name=value` at invocation. */
export interface WorkloadArgSpec {
	required?: boolean;
	default?: string;
	description?: string;
}

/**
 * One node of the graph, after defaults have been folded in. Exactly one of
 * `prompt` (spawn a subagent) or `run` (execute argv, no model) is set.
 */
export interface WorkloadStep {
	id: string;
	description?: string;
	prompt?: string;
	run?: string[];
	agent: string;
	model?: string;
	effort?: TaskEffort;
	isolated?: boolean;
	outputSchema?: unknown;
	needs: string[];
	forEach?: string;
	concurrency: number;
	retries: number;
	onFailure: WorkloadFailurePolicy;
}

/** A loaded, schema-valid, cycle-free workload. */
export interface WorkloadSpec {
	version: number;
	name: string;
	description?: string;
	args: Record<string, WorkloadArgSpec>;
	steps: WorkloadStep[];
	/** Execution order: each entry is a set of step ids with no dependency between them. */
	waves: string[][];
	/** Absolute path the spec was read from. */
	sourcePath: string;
}

/** A discovered workload file, before parsing. */
export interface WorkloadCandidate {
	/** Name derived from the filename, which must match the spec's own `name`. */
	name: string;
	path: string;
	level: "user" | "project";
	/** Directory distance from cwd; lower is closer, so lower wins. */
	depth: number;
}

export class WorkloadSpecError extends Error {}

/**
 * Directories probed for workload files: the user agent dir, then every
 * ancestor from `cwd` up to the repo root (or home), each at `<dir>/workloads`
 * and `<dir>/.omp/workloads`. Ordered nearest-first within the project level so
 * the closest definition of a name wins, matching `WATCHDOG.yml` discovery.
 */
function workloadSearchDirs(cwd: string, agentDir: string | undefined): { dir: string; level: "user" | "project" }[] {
	const dirs: { dir: string; level: "user" | "project" }[] = [];
	let current = path.resolve(cwd);
	let repoRoot: string | null = null;
	try {
		repoRoot = vcs.repo(current)?.root() ?? null;
	} catch (err) {
		logger.debug("Failed to resolve VCS root for workload discovery", { err: String(err) });
	}
	const stop = repoRoot ?? os.homedir();
	while (true) {
		dirs.push({ dir: path.resolve(current, ".omp", WORKLOAD_DIR), level: "project" });
		dirs.push({ dir: path.resolve(current, WORKLOAD_DIR), level: "project" });
		if (current === stop) break;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	const resolvedAgentDir = agentDir ?? getAgentDir();
	if (resolvedAgentDir) {
		dirs.push({ dir: path.resolve(resolvedAgentDir, WORKLOAD_DIR), level: "user" });
	}
	return dirs;
}

/**
 * Every readable workload file on the search path, nearest-first. A name
 * defined at several levels appears once, resolved to the closest project file
 * and only then the user file.
 */
export async function discoverWorkloads(cwd: string, agentDir?: string): Promise<WorkloadCandidate[]> {
	const byName = new Map<string, WorkloadCandidate>();
	const dirs = workloadSearchDirs(cwd, agentDir);
	for (const [index, { dir, level }] of dirs.entries()) {
		let entries: string[];
		try {
			entries = await fs.readdir(dir);
		} catch (err) {
			if (!isEnoent(err)) logger.debug("Workload dir unreadable", { dir, err: String(err) });
			continue;
		}
		for (const entry of entries) {
			const extension = path.extname(entry);
			if (!WORKLOAD_EXTENSIONS.includes(extension)) continue;
			const name = path.basename(entry, extension);
			if (byName.has(name)) continue;
			byName.set(name, { name, path: path.resolve(dir, entry), level, depth: index });
		}
	}
	return [...byName.values()];
}

/**
 * Fold `defaults` into one raw step and normalize its field names. Rejects the
 * shape errors the schema cannot express: the prompt/run exclusivity, unknown
 * effort tiers, and out-of-range numbers.
 */
function normalizeStep(
	raw: typeof stepSchema.infer,
	defaults: typeof defaultsSchema.infer | undefined,
	where: string,
): WorkloadStep {
	if (!IDENTIFIER_PATTERN.test(raw.id)) {
		throw new WorkloadSpecError(
			`${where}: step id "${raw.id}" must match ${IDENTIFIER_PATTERN.source} (lowercase, digits, "-", "_").`,
		);
	}
	const hasPrompt = raw.prompt !== undefined && raw.prompt.trim() !== "";
	const hasRun = raw.run !== undefined && raw.run.length > 0;
	if (hasPrompt === hasRun) {
		throw new WorkloadSpecError(
			`${where}: step "${raw.id}" needs exactly one of \`prompt\` (spawn a subagent) or \`run\` (execute argv); ${
				hasPrompt ? "both were set" : "neither was set"
			}.`,
		);
	}
	if (hasRun && raw.run?.some(argument => typeof argument !== "string" || argument === "")) {
		throw new WorkloadSpecError(`${where}: step "${raw.id}" has an empty \`run\` argument.`);
	}
	const providedEffort = raw.effort !== undefined ? raw.effort : defaults?.effort;
	if (providedEffort !== undefined && !(TASK_EFFORTS as readonly string[]).includes(providedEffort)) {
		throw new WorkloadSpecError(
			`${where}: step "${raw.id}" has an invalid \`effort\` value ${JSON.stringify(providedEffort)}. Use ${TASK_EFFORTS.map(value => JSON.stringify(value)).join(", ")}.`,
		);
	}
	const onFailureValue = raw.on_failure ?? defaults?.on_failure ?? "abort";
	if (onFailureValue !== "abort" && onFailureValue !== "continue") {
		throw new WorkloadSpecError(
			`${where}: step "${raw.id}" has an invalid \`on_failure\` value "${onFailureValue}". Use "abort" or "continue".`,
		);
	}
	const concurrency = raw.concurrency ?? defaults?.concurrency ?? DEFAULT_CONCURRENCY;
	if (!Number.isInteger(concurrency) || concurrency <= 0) {
		throw new WorkloadSpecError(
			`${where}: step "${raw.id}" has an invalid \`concurrency\` value ${concurrency}. Use a positive integer.`,
		);
	}
	const retries = raw.retries ?? 0;
	if (!Number.isInteger(retries) || retries < 0) {
		throw new WorkloadSpecError(
			`${where}: step "${raw.id}" has an invalid \`retries\` value ${retries}. Use a non-negative integer.`,
		);
	}
	// `for_each` is model-agnostic — fanning a checker over a file list is a
	// legitimate shell step — but a model selector and an output schema only
	// mean something for a spawn.
	if (hasRun && (raw.model !== undefined || raw.output_schema !== undefined)) {
		const offending = [
			raw.model !== undefined ? "`model`" : undefined,
			raw.output_schema !== undefined ? "`output_schema`" : undefined,
		].filter(Boolean);
		throw new WorkloadSpecError(
			`${where}: step "${raw.id}" is a \`run\` step, so ${offending.join(" / ")} does not apply. Those belong to \`prompt\` steps.`,
		);
	}
	// `defaults.model` / `defaults.effort` describe how a spawn thinks, so they
	// are folded into prompt steps only — a shell step carrying an inherited
	// model would misreport what the plan is about to do.
	const inheritedModel = hasPrompt ? (raw.model ?? defaults?.model) : undefined;
	const inheritedEffort = hasPrompt ? providedEffort : undefined;
	return {
		id: raw.id,
		...(raw.description !== undefined ? { description: raw.description } : {}),
		...(hasPrompt ? { prompt: raw.prompt } : {}),
		...(hasRun ? { run: raw.run } : {}),
		agent: raw.agent ?? defaults?.agent ?? "task",
		...(inheritedModel !== undefined ? { model: inheritedModel } : {}),
		...(inheritedEffort !== undefined ? { effort: inheritedEffort as TaskEffort } : {}),
		...(raw.isolated !== undefined ? { isolated: raw.isolated } : {}),
		...(raw.output_schema !== undefined ? { outputSchema: raw.output_schema } : {}),
		needs: raw.needs ?? [],
		...(raw.for_each !== undefined ? { forEach: raw.for_each } : {}),
		concurrency,
		retries,
		onFailure: onFailureValue,
	};
}

/**
 * Group steps into execution waves by Kahn's algorithm, so every step in a wave
 * can run concurrently. Rejects unknown `needs` ids, self-dependencies, and
 * cycles up front: a workload that cannot finish must fail before it spawns
 * anything.
 */
function planWaves(steps: WorkloadStep[], where: string): string[][] {
	const ids = new Set<string>();
	for (const step of steps) {
		if (ids.has(step.id)) throw new WorkloadSpecError(`${where}: duplicate step id "${step.id}".`);
		ids.add(step.id);
	}
	const pending = new Map<string, Set<string>>();
	for (const step of steps) {
		const unmet = new Set<string>();
		for (const need of step.needs) {
			if (need === step.id) throw new WorkloadSpecError(`${where}: step "${step.id}" depends on itself.`);
			if (!ids.has(need)) {
				throw new WorkloadSpecError(
					`${where}: step "${step.id}" needs unknown step "${need}". Known steps: ${[...ids].join(", ")}.`,
				);
			}
			unmet.add(need);
		}
		pending.set(step.id, unmet);
	}
	const waves: string[][] = [];
	const done = new Set<string>();
	while (done.size < steps.length) {
		const wave = steps.filter(
			step => !done.has(step.id) && [...(pending.get(step.id) ?? [])].every(need => done.has(need)),
		);
		if (wave.length === 0) {
			const stuck = steps.filter(step => !done.has(step.id)).map(step => step.id);
			throw new WorkloadSpecError(
				`${where}: dependency cycle among steps ${stuck.join(", ")}. Every workload must be a DAG.`,
			);
		}
		waves.push(wave.map(step => step.id));
		for (const step of wave) done.add(step.id);
	}
	return waves;
}

/** Parse and validate one workload document. `sourcePath` is used in messages. */
export function parseWorkloadSpec(content: string, sourcePath: string): WorkloadSpec {
	const where = path.basename(sourcePath);
	let document: unknown;
	try {
		document = YAML.parse(content);
	} catch (err) {
		throw new WorkloadSpecError(`${where}: not valid YAML — ${err instanceof Error ? err.message : String(err)}`);
	}
	const parsed = workloadYamlSchema(document);
	if (parsed instanceof type.errors) {
		throw new WorkloadSpecError(`${where}: invalid workload — ${parsed.summary}`);
	}
	if (!IDENTIFIER_PATTERN.test(parsed.name)) {
		throw new WorkloadSpecError(
			`${where}: workload name "${parsed.name}" must match ${IDENTIFIER_PATTERN.source} (lowercase, digits, "-", "_").`,
		);
	}
	const version = parsed.version ?? 1;
	if (version !== 1) {
		throw new WorkloadSpecError(`${where}: unsupported workload version ${version}. This omp understands version 1.`);
	}
	if (parsed.steps.length === 0) {
		throw new WorkloadSpecError(`${where}: workload has no steps.`);
	}
	const steps = parsed.steps.map(raw => normalizeStep(raw, parsed.defaults, where));
	return {
		version,
		name: parsed.name,
		...(parsed.description !== undefined ? { description: parsed.description } : {}),
		args: parsed.args ?? {},
		steps,
		waves: planWaves(steps, where),
		sourcePath: path.resolve(sourcePath),
	};
}

/**
 * Resolve a `--set k=v` list against the declared `args`, applying defaults and
 * rejecting both missing required inputs and undeclared ones — a typo in a key
 * must not silently expand to nothing at template time.
 */
export function resolveWorkloadArgs(spec: WorkloadSpec, assignments: readonly string[]): Record<string, string> {
	const provided = new Map<string, string>();
	for (const assignment of assignments) {
		const separator = assignment.indexOf("=");
		if (separator <= 0) {
			throw new WorkloadSpecError(`Invalid --set "${assignment}". Use --set name=value.`);
		}
		provided.set(assignment.slice(0, separator).trim(), assignment.slice(separator + 1));
	}
	const declared = Object.keys(spec.args);
	const undeclared = [...provided.keys()].filter(key => !declared.includes(key));
	if (undeclared.length > 0) {
		throw new WorkloadSpecError(
			`Workload "${spec.name}" does not declare ${undeclared.map(key => `\`${key}\``).join(", ")}. Declared args: ${
				declared.length > 0 ? declared.join(", ") : "none"
			}.`,
		);
	}
	const resolved: Record<string, string> = {};
	const missing: string[] = [];
	for (const [name, argSpec] of Object.entries(spec.args)) {
		const value = provided.get(name) ?? argSpec.default;
		if (value === undefined) {
			if (argSpec.required) missing.push(name);
			continue;
		}
		resolved[name] = value;
	}
	if (missing.length > 0) {
		throw new WorkloadSpecError(
			`Workload "${spec.name}" requires ${missing.map(name => `\`${name}\``).join(", ")}. Pass ${missing
				.map(name => `--set ${name}=…`)
				.join(" ")}.`,
		);
	}
	return resolved;
}

/**
 * Load a workload by name from the search path, or straight from a path when
 * the target looks like one (contains a separator or a YAML extension).
 */
export async function loadWorkload(target: string, cwd: string, agentDir?: string): Promise<WorkloadSpec> {
	const looksLikePath = target.includes(path.sep) || WORKLOAD_EXTENSIONS.includes(path.extname(target));
	if (looksLikePath) {
		const resolved = path.resolve(cwd, target);
		let content: string;
		try {
			content = await Bun.file(resolved).text();
		} catch (err) {
			throw new WorkloadSpecError(
				`Cannot read workload file ${resolved}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		return parseWorkloadSpec(content, resolved);
	}
	const candidates = await discoverWorkloads(cwd, agentDir);
	const match = candidates.find(candidate => candidate.name === target);
	if (!match) {
		throw new WorkloadSpecError(
			`Unknown workload "${target}". ${
				candidates.length > 0
					? `Available: ${candidates.map(candidate => candidate.name).join(", ")}.`
					: `Create .omp/${WORKLOAD_DIR}/${target}.yml or pass a path.`
			}`,
		);
	}
	const spec = parseWorkloadSpec(await Bun.file(match.path).text(), match.path);
	if (spec.name !== match.name) {
		throw new WorkloadSpecError(
			`${path.basename(match.path)}: workload name "${spec.name}" does not match its filename "${match.name}". They must agree so the file a name resolves to is unambiguous.`,
		);
	}
	return spec;
}
