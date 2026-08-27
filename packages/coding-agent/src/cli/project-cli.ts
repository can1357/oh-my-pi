/**
 * `omp project` — manage `~/.omp/agent/projects.yml`, the machine-local map from
 * a logical project id (shared across machines) to this machine's checkout path.
 *
 * Everything here mutates the registry through {@link loadProjects} /
 * {@link saveProjects} and then {@link invalidateProjectScope}s the running
 * process's cached snapshot, so a live session picks the change up without a
 * restart. Git identity is resolved here (at registration time) and never on the
 * synchronous replication path — see `state-broker/project-scope.ts`.
 */

import * as fs from "node:fs";
import { getProjectDir, resolveEquivalentPath } from "@oh-my-pi/pi-utils";
// The subcommand runner in `packages/utils/src/cli.ts` renders usage errors
// without a stack trace by `instanceof` against ITS OWN CliUsageError. The
// coding-agent-local class of the same name is only recognized by the launch
// path's `reportCliUsageError`, so a subcommand throwing that one escapes as an
// uncaught crash with a code frame.
import { CliUsageError } from "@oh-my-pi/pi-utils/cli";
import { loadProjects, type ProjectEntry, projectIdFromRemoteUrl, saveProjects } from "../config/projects-config";
import { Settings } from "../config/settings";
import { invalidateProjectScope, resolveProject } from "../state-broker/project-scope";
import { resetProjectScopedCursors } from "../state-broker/registry";
import * as git from "../utils/git";

export const PROJECT_ACTIONS = ["list", "enable", "disable", "add", "rm", "path"] as const;
export type ProjectAction = (typeof PROJECT_ACTIONS)[number];

export interface ProjectCommandArgs {
	action: ProjectAction;
	/** Second positional: a filesystem path (default cwd) or, for `path`, the new local path. */
	target?: string;
	flags: {
		id?: string;
		json?: boolean;
		/** Optional Settings overlays, mirroring other CLI commands. */
		config?: string[];
	};
}

function writeLine(line = ""): void {
	process.stdout.write(`${line}\n`);
}

/**
 * Insert or update `next`, rejecting the two shapes that make replication
 * ambiguous: the same id pointing at two different paths, and the same path
 * claimed by two different ids. Either would let remote entries land in the
 * wrong checkout, so we fail closed with an actionable message.
 */
function upsertProject(entries: ProjectEntry[], next: ProjectEntry): void {
	const nextPath = resolveEquivalentPath(next.path);

	const idClash = entries.find(e => e.id === next.id && resolveEquivalentPath(e.path) !== nextPath);
	if (idClash) {
		throw new CliUsageError(
			`Project id "${next.id}" is already registered at ${idClash.path}.\n` +
				`Repoint it with \`omp project path --id ${next.id} ${next.path}\`, or remove it first.`,
		);
	}

	const pathClash = entries.find(e => e.id !== next.id && resolveEquivalentPath(e.path) === nextPath);
	if (pathClash) {
		throw new CliUsageError(
			`${next.path} is already registered under id "${pathClash.id}".\n` +
				`Remove it first with \`omp project rm --id ${pathClash.id}\`.`,
		);
	}

	const existing = entries.find(e => e.id === next.id);
	if (existing) {
		existing.path = next.path;
		existing.sync = next.sync;
	} else {
		entries.push({ ...next });
	}
}

/**
 * Persist the registry, drop the running process's cached scope snapshot so the
 * change is visible without waiting for the TTL or a restart, and rewind the
 * project-scoped replication cursors.
 *
 * The rewind is what makes enabling a project *backfill* rather than only
 * apply going forward: both replication watermarks were advanced over data that
 * was filtered out while the project was disabled, so without it a newly
 * enabled project would silently start from "now" and never exchange the
 * history that already exists on either side.
 */
function commit(entries: readonly ProjectEntry[]): void {
	saveProjects(entries);
	invalidateProjectScope();
	resetProjectScopedCursors();
}

/** Warn (never fail) when per-project settings are inert because sync is off. */
async function warnIfSyncDisabled(cwd: string, configFiles: string[] | undefined): Promise<void> {
	try {
		const settings = await Settings.init({ cwd, configFiles });
		if (settings.get("state.sync.enabled") !== true) {
			process.stderr.write(
				"warning: state.sync.enabled is false — per-project sync settings do nothing until you turn sync on.\n",
			);
		}
	} catch {
		// Settings are advisory here; a load failure must not block registry edits.
	}
}

/** `list`: registered projects as a table, or a JSON array with `--json`. */
function runList(command: ProjectCommandArgs, cwd: string): void {
	const entries = loadProjects();
	const currentId = resolveProject(cwd)?.project.id;

	if (command.flags.json) {
		const rows = entries.map(e => ({
			id: e.id,
			path: e.path,
			sync: e.sync,
			exists: fs.existsSync(e.path),
			current: e.id === currentId,
		}));
		writeLine(JSON.stringify(rows, null, 2));
		return;
	}

	if (entries.length === 0) {
		writeLine("No projects registered. Run `omp project enable` inside a project to add one.");
		return;
	}

	const header = ["", "ID", "LOCAL PATH", "SYNC", "ON DISK"];
	const body = entries.map(e => [
		e.id === currentId ? "*" : "",
		e.id,
		e.path,
		e.sync ? "on" : "off",
		fs.existsSync(e.path) ? "yes" : "missing",
	]);
	const widths = header.map((h, i) => Math.max(h.length, ...body.map(r => r[i].length)));
	const pad = (row: string[]): string =>
		row
			.map((cell, i) => cell.padEnd(widths[i]))
			.join("  ")
			.trimEnd();
	writeLine(pad(header));
	for (const row of body) writeLine(pad(row));
	if (currentId) writeLine("\n* current directory");
}

/**
 * `enable`: register the project containing `path` (default cwd) with sync on.
 * Id resolution order: explicit `--id`, an existing entry for that path, then
 * the git origin remote (registering the REPO ROOT so both machines agree).
 */
async function runEnable(command: ProjectCommandArgs, cwd: string): Promise<void> {
	const target = resolveEquivalentPath(command.target ?? cwd);
	const entries = loadProjects();

	let id: string;
	let projectPath = target;

	if (command.flags.id) {
		id = command.flags.id;
	} else {
		const existing = entries.find(e => resolveEquivalentPath(e.path) === target);
		if (existing) {
			id = existing.id;
			projectPath = resolveEquivalentPath(existing.path);
		} else {
			// Registration-time only: `changedSince` is synchronous and must never
			// shell out, so the git-derived id is baked into the registry here.
			const root = await git.repo.root(target);
			const url = root ? await git.remote.url(root, "origin") : undefined;
			const derived = url ? projectIdFromRemoteUrl(url) : undefined;
			if (!root || !derived) {
				throw new CliUsageError(
					`Could not derive a project id for ${target}.\n` +
						"Pass `--id <name>` to name it explicitly. The id must be identical on every machine\n" +
						"that holds this project (it is what replication keys off of), e.g.\n" +
						`  omp project enable --id my-project ${command.target ?? "."}`,
				);
			}
			id = derived;
			projectPath = resolveEquivalentPath(root);
		}
	}

	upsertProject(entries, { id, path: projectPath, sync: true });
	commit(entries);

	writeLine("Enabled sync for project:");
	writeLine(`  id:   ${id}`);
	writeLine(`  path: ${projectPath}`);
	writeLine("");
	writeLine("Enable the SAME id on every other machine that holds this project:");
	writeLine(`  omp project add --id ${id} <local-path>    # declare the mapping`);
	writeLine(`  omp project enable --id ${id} <local-path> # and turn sync on`);
	await warnIfSyncDisabled(cwd, command.flags.config);
}

/** `disable`: keep the mapping but stop replicating; resumable without re-deriving the id. */
async function runDisable(command: ProjectCommandArgs, cwd: string): Promise<void> {
	const target = resolveEquivalentPath(command.target ?? cwd);
	const entries = loadProjects();
	const entry = entries.find(e => resolveEquivalentPath(e.path) === target);
	if (!entry) {
		throw new CliUsageError(`No project registered at ${target}. Nothing to disable.`);
	}
	entry.sync = false;
	commit(entries);
	writeLine(`Disabled sync for project "${entry.id}" (${entry.path}). The mapping is kept.`);
	await warnIfSyncDisabled(cwd, command.flags.config);
}

/**
 * `add`: declare an id → local-path mapping WITHOUT enabling sync. This is how a
 * second machine says "my `~/dev/foo` is machine A's project `<id>`".
 */
async function runAdd(command: ProjectCommandArgs, cwd: string): Promise<void> {
	const id = command.flags.id;
	if (!id) {
		throw new CliUsageError(
			"`omp project add` requires --id <id>.\n" +
				"Use the id printed by `omp project enable` on the machine that owns the project.",
		);
	}
	const target = resolveEquivalentPath(command.target ?? cwd);
	const entries = loadProjects();
	// Re-declaring an existing mapping is idempotent and must not silently flip an
	// already-enabled project off; preserve its current sync state.
	const existing = entries.find(e => e.id === id);
	upsertProject(entries, { id, path: target, sync: existing?.sync ?? false });
	commit(entries);
	writeLine("Registered mapping (sync off):");
	writeLine(`  id:   ${id}`);
	writeLine(`  path: ${target}`);
	writeLine(`Run \`omp project enable --id ${id}\` here to start replicating.`);
	await warnIfSyncDisabled(cwd, command.flags.config);
}

/** `rm`: drop an entry entirely, by `--id` or by path (default cwd). */
function runRemove(command: ProjectCommandArgs, cwd: string): void {
	const entries = loadProjects();
	let kept: ProjectEntry[];
	let removedLabel: string;

	if (command.flags.id) {
		kept = entries.filter(e => e.id !== command.flags.id);
		removedLabel = `id "${command.flags.id}"`;
	} else {
		const target = resolveEquivalentPath(command.target ?? cwd);
		kept = entries.filter(e => resolveEquivalentPath(e.path) !== target);
		removedLabel = target;
	}

	if (kept.length === entries.length) {
		throw new CliUsageError(`No project matched ${removedLabel}. Nothing removed.`);
	}
	commit(kept);
	writeLine(`Removed ${entries.length - kept.length} project(s) matching ${removedLabel}.`);
}

/** `path`: repoint an existing id at a different local checkout. */
function runPath(command: ProjectCommandArgs): void {
	const id = command.flags.id;
	if (!id) {
		throw new CliUsageError("`omp project path` requires --id <id> to identify the project to repoint.");
	}
	if (!command.target) {
		throw new CliUsageError(`Usage: omp project path --id ${id} <newPath>`);
	}
	const entries = loadProjects();
	const entry = entries.find(e => e.id === id);
	if (!entry) {
		throw new CliUsageError(`No project registered with id "${id}".`);
	}
	const newPath = resolveEquivalentPath(command.target);
	const clash = entries.find(e => e.id !== id && resolveEquivalentPath(e.path) === newPath);
	if (clash) {
		throw new CliUsageError(`${command.target} is already registered under id "${clash.id}".`);
	}
	entry.path = newPath;
	commit(entries);
	writeLine(`Repointed "${id}" to ${newPath}.`);
}

export async function runProjectCommand(command: ProjectCommandArgs): Promise<void> {
	const cwd = getProjectDir();
	switch (command.action) {
		case "list":
			runList(command, cwd);
			return;
		case "enable":
			await runEnable(command, cwd);
			return;
		case "disable":
			await runDisable(command, cwd);
			return;
		case "add":
			await runAdd(command, cwd);
			return;
		case "rm":
			runRemove(command, cwd);
			return;
		case "path":
			runPath(command);
			return;
	}
}
