import type { AgentSession } from "../session/agent-session";

/** What `/prune` should do with the empty branches it finds. */
export type PruneMode = "archive" | "delete";

/**
 * What `/unarchive` should bring back: everything, one branch by id, or nothing
 * at all — `list` only reports what is hidden.
 */
export type UnarchiveMode = { verb: "all" } | { verb: "list" } | { verb: "one"; targetId: string };

export function parsePruneMode(args: string): PruneMode | { error: string } {
	const verb = args.trim().toLowerCase().replace(/^--/, "");
	if (verb === "" || verb === "archive") return "archive";
	if (verb === "delete") return "delete";
	return { error: `Unknown /prune mode "${verb}". Use archive or delete.` };
}

export function parseUnarchiveMode(args: string): UnarchiveMode | { error: string } {
	const verb = args.trim().replace(/^--/, "");
	if (verb === "" || verb.toLowerCase() === "all") return { verb: "all" };
	if (verb.toLowerCase() === "list") return { verb: "list" };
	if (/\s/.test(verb)) return { error: `Unknown /unarchive argument "${verb}". Use list, all, or a branch id.` };
	return { verb: "one", targetId: verb };
}

/**
 * Run `/prune` and describe what happened. Shared by the TUI and
 * non-interactive paths so both report the same thing — the wording is the only
 * feedback distinguishing a branch that was hidden from one that was destroyed.
 */
export async function runPrune(mode: PruneMode, session: AgentSession): Promise<string> {
	switch (mode) {
		case "archive": {
			const { branches, entries } = await session.archiveEmptyBranches();
			if (branches === 0) return "No empty branches to archive.";
			const branchWord = branches === 1 ? "branch" : "branches";
			const entryWord = entries === 1 ? "entry" : "entries";
			return `Archived ${branches} empty ${branchWord} (${entries} ${entryWord} hidden, nothing deleted). Restore with /unarchive.`;
		}
		case "delete": {
			const count = await session.pruneEmptyBranches();
			return count === 0
				? "No empty branches to prune."
				: `Deleted ${count} empty branch ${count === 1 ? "entry" : "entries"}.`;
		}
	}
}

/** Run `/unarchive` and describe what happened. */
export async function runUnarchive(mode: UnarchiveMode, session: AgentSession): Promise<string> {
	switch (mode.verb) {
		case "list": {
			const roots = session.getArchivedRootIds();
			if (roots.length === 0) return "No archived branches.";
			return `Archived branches (${roots.length}):\n${roots.map(id => `  ${id}`).join("\n")}`;
		}
		case "one": {
			const count = await session.restoreArchived(mode.targetId);
			return count === 0
				? `No archived branch ${mode.targetId}. Use /unarchive list to see what is hidden.`
				: `Restored branch ${mode.targetId}.`;
		}
		case "all": {
			const count = await session.restoreArchived();
			return count === 0
				? "No archived branches to restore."
				: `Restored ${count} archived ${count === 1 ? "branch" : "branches"}.`;
		}
	}
}
