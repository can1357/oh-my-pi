/**
 * `omp project` registry mutations.
 *
 * The registered path is a project ROOT (`enable` deliberately stores the repo
 * root so every machine agrees on it), but the command is run from wherever the
 * user happens to be. Every action therefore has to resolve the CONTAINING
 * registered project rather than demand an exact path match — which is what
 * `omp project list` already does when it marks the current directory.
 */

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runProjectCommand } from "@oh-my-pi/pi-coding-agent/cli/project-cli";
import {
	getProjectsConfigPath,
	loadProjects,
	ProjectsConfigFile,
	saveProjects,
} from "@oh-my-pi/pi-coding-agent/config/projects-config";
import { invalidateProjectScope } from "@oh-my-pi/pi-coding-agent/state-broker/project-scope";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

// A throwaway agent dir for this file. `runProjectCommand` persists through
// `saveProjects()`'s no-arg default and resolves through `resolveProject`,
// neither of which has an injection seam, so the process-wide agent dir must
// point here. Restored in `afterEach` so this file never redirects a later one.
const AGENT_DIR = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-projcli-agent-")));
const SAVED_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

const cleanupRoots: string[] = [];
const spies: Array<{ mockRestore: () => void }> = [];

function makeWorkspace(): string {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-projcli-ws-")));
	cleanupRoots.push(root);
	return root;
}

beforeEach(() => {
	setAgentDir(AGENT_DIR);
	fs.rmSync(getProjectsConfigPath(AGENT_DIR), { force: true });
	ProjectsConfigFile.invalidate();
	invalidateProjectScope();
	// The command reports to stdout/stderr; keep the suite output clean without
	// silencing it process-wide.
	spies.push(spyOn(process.stdout, "write").mockReturnValue(true));
	spies.push(spyOn(process.stderr, "write").mockReturnValue(true));
});

afterEach(async () => {
	for (const spy of spies.splice(0)) spy.mockRestore();
	fs.rmSync(getProjectsConfigPath(AGENT_DIR), { force: true });
	ProjectsConfigFile.invalidate();
	invalidateProjectScope();
	for (const root of cleanupRoots.splice(0)) await removeWithRetries(root);
	if (SAVED_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = SAVED_AGENT_DIR;
	__resetDirsFromEnvForTests();
});

/** A registered project root plus a nested directory well inside it. */
function registerFoo(): { root: string; nested: string } {
	const ws = makeWorkspace();
	const root = path.join(ws, "foo");
	const nested = path.join(root, "packages", "bar");
	fs.mkdirSync(nested, { recursive: true });
	saveProjects([{ id: "proj:foo", path: root, sync: true }], AGENT_DIR);
	ProjectsConfigFile.invalidate();
	invalidateProjectScope();
	return { root, nested };
}

test("disable from a nested directory disables the containing project", async () => {
	const { nested } = registerFoo();

	await runProjectCommand({ action: "disable", target: nested, flags: {} });

	expect(loadProjects(AGENT_DIR).map(e => ({ id: e.id, sync: e.sync }))).toEqual([{ id: "proj:foo", sync: false }]);
});

test("rm from a nested directory removes the containing project", async () => {
	const { nested } = registerFoo();

	await runProjectCommand({ action: "rm", target: nested, flags: {} });

	expect(loadProjects(AGENT_DIR)).toEqual([]);
});

/**
 * Re-enabling from a subdirectory must reuse the registered id rather than fall
 * through to git derivation: a project registered with an explicit `--id`, or
 * one whose remote has since gone away, has no derivable id and the command
 * failed outright. The stored path must stay the ROOT, or the nested directory
 * becomes the project and every peer's mapping silently disagrees.
 */
test("enable from a nested directory reuses the containing project's id and root", async () => {
	const { root, nested } = registerFoo();
	await runProjectCommand({ action: "disable", target: root, flags: {} });

	await runProjectCommand({ action: "enable", target: nested, flags: {} });

	const entries = loadProjects(AGENT_DIR);
	expect(entries).toHaveLength(1);
	expect(entries[0]).toMatchObject({ id: "proj:foo", path: root, sync: true });
});

/**
 * The containing-project fallback must not swallow a genuine miss: a directory
 * under no registered project still has nothing to disable.
 */
test("disable outside any registered project still reports nothing to disable", async () => {
	registerFoo();
	const unrelated = makeWorkspace();

	await expect(runProjectCommand({ action: "disable", target: unrelated, flags: {} })).rejects.toThrow(
		/No project registered/,
	);
});
