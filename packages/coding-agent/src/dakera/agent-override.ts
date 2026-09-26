/**
 * Per-repo agent-id override for the Dakera backend.
 *
 * `per-project` scoping derives the agent id from the repository name, which
 * splits one logical agent across every repo of a multi-repo setup (billing,
 * payments, … all wanted one `aeza-dev`). Project settings cannot fix that:
 * `.omp/config.yml` is read only from the exact cwd, so launching from a
 * subfolder or a linked worktree never sees the repo root's file.
 *
 * So the override walks up from the working directory to the repository root
 * (worktree root via `repo().root()`, which stays inside the checkout) and
 * takes the nearest `.omp/config.yml` with a `dakera.agentId` string. Keys
 * above the root are ignored: two sibling checkouts of different repos must
 * not read each other's overrides, and a repo checked out inside another
 * repo's directory is its own scope.
 *
 * The override replaces the whole id (prefix included): the file names the
 * agent, `agentIdPrefix` stays a launcher-level concern for the derived
 * scheme only.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

/** Read `dakera.agentId` from `<dir>/.omp/config.yml`, or `undefined`. */
async function readAgentIdOverride(dir: string): Promise<string | undefined> {
	const configPath = path.join(dir, ".omp", "config.yml");
	let content: string;
	try {
		content = await Bun.file(configPath).text();
	} catch {
		return undefined; // absent or unreadable: keep walking
	}
	try {
		const data = YAML.parse(content);
		if (!isRecord(data)) return undefined;
		const agentId = isRecord(data.dakera) ? data.dakera.agentId : undefined;
		if (typeof agentId !== "string" || !agentId.trim()) return undefined;
		return agentId.trim();
	} catch (error) {
		logger.warn(`Dakera: failed to parse ${configPath}; ignoring override.`, { error: String(error) });
		return undefined;
	}
}

/**
 * Nearest `dakera.agentId` override at or above `directory`, stopping at the
 * repository root. `undefined` when no repo or no override applies.
 *
 * `repo().root()` can return a differently-spelled path than the cwd chain
 * (e.g. `/var` vs `/private/var` on macOS, or symlinked checkouts), so both
 * sides go through `fs.promises.realpath` before comparison.
 *
 * A linked worktree stops at its own root, and the repo root's override file
 * — untracked, so not checked out into the worktree — would be missed. The
 * main checkout (`primaryRoot()`, same logical repo) is therefore consulted
 * as the last candidate: same repo, same agent.
 */
export async function resolveDakeraAgentIdOverride(directory: string): Promise<string | undefined> {
	if (!directory || !path.isAbsolute(directory)) return undefined;
	const repo = vcs.repo(directory);
	if (!repo) return undefined;
	let root: string;
	try {
		root = await fs.promises.realpath(repo.root());
	} catch {
		return undefined;
	}
	let current: string;
	try {
		current = await fs.promises.realpath(directory);
	} catch {
		current = path.resolve(directory);
	}
	while (true) {
		const override = await readAgentIdOverride(current);
		if (override) return override;
		if (current === root) break;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
	try {
		const primary = await fs.promises.realpath(repo.primaryRoot());
		return primary === root ? undefined : await readAgentIdOverride(primary);
	} catch {
		return undefined;
	}
}
