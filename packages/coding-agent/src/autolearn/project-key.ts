import * as fs from "node:fs";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { resolveEquivalentPath } from "@oh-my-pi/pi-utils";

/** Only a registration in the primary checkout can grant access to its store. */
export function resolveManagedSkillsProjectRoot(cwd: string): string {
	const current = resolveEquivalentPath(cwd);
	const repo = vcs.repo(current);
	if (!repo) return current;
	const checkout = resolveEquivalentPath(repo.root());
	const git = repo.asGit();
	if (!git) return checkout;
	const { gitDir, commonDir } = git.info();
	if (gitDir === commonDir) return checkout;

	try {
		// Derive the candidate from the physical metadata location, not the claimed primary root.
		const metadata = fs.realpathSync(gitDir);
		const worktrees = path.dirname(metadata);
		const common = path.dirname(worktrees);
		if (path.basename(worktrees) !== "worktrees" || path.basename(common) !== ".git") return checkout;
		if (fs.realpathSync(commonDir) !== common) return checkout;

		const backlinkFile = path.join(metadata, "gitdir");
		if (!fs.lstatSync(backlinkFile).isFile()) return checkout;
		if (!fs.lstatSync(path.join(checkout, ".git")).isFile()) return checkout;
		const backlink = path.resolve(metadata, fs.readFileSync(backlinkFile, "utf8").trimEnd());
		// Resolve the directory, not the final .git entry: another checkout can link its .git file.
		if (path.basename(backlink) !== ".git" || fs.realpathSync(path.dirname(backlink)) !== checkout) return checkout;
		return path.dirname(common);
	} catch {
		// Missing, inaccessible, or stale registration: keep the checkout isolated.
		return checkout;
	}
}

/** Encode a canonical native path as one directory name. Only the readable prefix is lossy. */
export function encodeManagedSkillsProjectKey(projectRoot: string): string {
	const readable = projectRoot
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(-80);
	return `${readable || "project"}-${Bun.SHA256.hash(projectRoot, "hex").slice(0, 12)}`;
}
