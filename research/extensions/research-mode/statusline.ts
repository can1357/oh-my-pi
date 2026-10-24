/**
 * Statusline hint for the research harness: active project + title/abstract
 * screening progress, read read-only from the project's review.db.
 *
 * Pure helpers only — no omp runtime imports — so `bun test` can exercise them
 * without a session.
 */
import { Database } from "bun:sqlite";
import * as os from "node:os";
import * as path from "node:path";

/** Statusline key this extension owns (`ctx.ui.setStatus`). */
export const STATUS_KEY = "research";

/** Root of the harness state written by setup.sh and the review scripts. */
export const STATE_DIR = path.join(os.homedir(), ".research-harness");

/** Title/abstract screening progress of one project's review.db. */
export interface ScreeningCounts {
	/** Records carrying a title/abstract verdict (`records.ta_verdict`). */
	screened: number;
	/** Records imported into the review store. */
	total: number;
}

export interface ResearchHintState {
	/** Slug in `~/.research-harness/active-project`, or null when none is set. */
	activeProject: string | null;
	/** Null when the project has no readable review.db — the hint degrades. */
	counts: ScreeningCounts | null;
}

const NO_PROJECT_HINT = "type /help to see what this harness can do";

/** One statusline string, degrading part by part as state goes missing. */
export function buildResearchHint(state: ResearchHintState): string {
	if (!state.activeProject) return NO_PROJECT_HINT;
	const parts = [`active: ${state.activeProject}`];
	if (state.counts) parts.push(`${state.counts.screened}/${state.counts.total} screened`);
	parts.push("type /help for commands");
	return parts.join(" · ");
}

/**
 * Read screening progress from a review.db. Read-only open: a missing,
 * unreadable, or corrupt file yields null instead of throwing, and nothing is
 * ever created or written.
 */
export function readScreeningCounts(dbPath: string): ScreeningCounts | null {
	let db: Database | undefined;
	try {
		db = new Database(dbPath, { readonly: true });
		const row = db
			.query<{ screened: number; total: number }, []>(
				"SELECT COUNT(ta_verdict) AS screened, COUNT(*) AS total FROM records",
			)
			.get();
		return row ? { screened: row.screened, total: row.total } : null;
	} catch {
		return null;
	} finally {
		db?.close();
	}
}

/** Slug of the active project, or null when the marker file is absent/empty. */
export async function readActiveProject(stateDir: string = STATE_DIR): Promise<string | null> {
	try {
		const slug = (await Bun.file(path.join(stateDir, "active-project")).text()).trim();
		return slug.length > 0 ? slug : null;
	} catch {
		return null;
	}
}

/** Everything the hint needs, with every read failure collapsing to null. */
export async function readResearchState(stateDir: string = STATE_DIR): Promise<ResearchHintState> {
	const activeProject = await readActiveProject(stateDir);
	if (!activeProject) return { activeProject: null, counts: null };
	return {
		activeProject,
		counts: readScreeningCounts(path.join(stateDir, "projects", activeProject, "review.db")),
	};
}
