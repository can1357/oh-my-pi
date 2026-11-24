/**
 * Scope benchmark tasks: one directory per task under `tasks/`, holding the user prompt
 * (`prompt.md`), the expectations (`task.json`), and the fixture workspace (`repo/`) every
 * run starts from. An optional `hidden/` tree is laid over the workspace after the agent stops,
 * before `verify` runs: checks the agent never sees. The fixture's suites stay out of this
 * package's `bun test` via `bunfig.toml`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Outcome checks run against the workspace after the agent stops. */
export interface VerifySpec {
	/** Workspace file → regexes its final text MUST match. */
	files?: Record<string, string[]>;
	/** Regexes no workspace file may match afterwards. */
	absent?: string[];
	/** Commands that MUST exit 0 (and print `stdout`, a regex, when given). `cwd` is workspace-relative. */
	commands?: Array<{ argv: string[]; cwd?: string; stdout?: string }>;
	/** Case-insensitive regexes the final reply MUST match. */
	answer?: string[];
}

/** `task.json`. */
interface TaskFile {
	/** The over-verification or scope temptation this task plants (report reading aid). */
	trap: string;
	/** Workspace-relative directory the agent starts in. Default `.`. */
	cwd?: string;
	/** Globs (workspace-relative) of files the request may change; `[]` = read-only. */
	scope: string[];
	/** Regexes over command segments the request warrants; any other test/build/run segment is unrequested. */
	allowedChecks: string[];
	verify: VerifySpec;
}

/** A loaded task. */
export interface ScopeTask extends Required<TaskFile> {
	id: string;
	prompt: string;
	/** Absolute path of the fixture workspace. */
	repoDir: string;
	/** Absolute path of the tree laid over the workspace before `verify`; `null` when the task has none. */
	hiddenDir: string | null;
}

/** Directory holding the built-in tasks. */
export const TASKS_DIR = path.join(import.meta.dir, "tasks");

/**
 * Loads every task under `dir`, sorted by id.
 * @throws when a task lacks `prompt.md`, `repo/`, or a well-formed `task.json`.
 */
export async function loadTasks(dir = TASKS_DIR): Promise<ScopeTask[]> {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	const ids = entries
		.filter(entry => entry.isDirectory())
		.map(entry => entry.name)
		.sort();
	return Promise.all(
		ids.map(async id => {
			const taskDir = path.join(dir, id);
			const spec: TaskFile = await Bun.file(path.join(taskDir, "task.json")).json();
			if (typeof spec.trap !== "string" || !Array.isArray(spec.scope) || !Array.isArray(spec.allowedChecks)) {
				throw new Error(`${id}/task.json needs "trap", "scope", and "allowedChecks"`);
			}
			if (typeof spec.verify !== "object" || spec.verify === null) throw new Error(`${id}/task.json needs "verify"`);
			const repoDir = path.join(taskDir, "repo");
			if (!(await fs.stat(repoDir)).isDirectory()) throw new Error(`${id}/repo is not a directory`);
			const hasHidden = (await fs.readdir(taskDir)).includes("hidden");
			return {
				id,
				trap: spec.trap,
				cwd: spec.cwd ?? ".",
				scope: spec.scope,
				allowedChecks: spec.allowedChecks,
				verify: spec.verify,
				prompt: (await Bun.file(path.join(taskDir, "prompt.md")).text()).trim(),
				repoDir,
				hiddenDir: hasHidden ? path.join(taskDir, "hidden") : null,
			};
		}),
	);
}
