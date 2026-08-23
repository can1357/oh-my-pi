/**
 * Child fixture for the `omp gc --undo-tails` CLI tests.
 *
 * Runs as a separate process with PI_CODING_AGENT_DIR and a terminal id set
 * by the spawning test, so the global dirs singleton resolves inside the
 * test's temp tree at module-load time and any unsuppressed breadcrumb write
 * would land where the test can see it. Static top-level imports only (repo
 * convention); the spawn env is in place before this module loads.
 */
import * as fs from "node:fs";
import { getTerminalSessionsDir } from "@oh-my-pi/pi-utils";
import { runGcCommand } from "../../src/cli/gc-cli";
import { SessionManager } from "../../src/session/session-manager";

const agentDir = process.env.GC_TEST_AGENT_DIR!;
const apply = process.env.GC_TEST_APPLY === "1";

// Hold-open mode: open a session and stay alive so the parent can exercise
// cross-process ownership (gc preflight/publish vs a live foreign manager).
if (process.env.GC_TEST_MODE === "hold-open") {
	const manager = await SessionManager.open(process.env.GC_TEST_SESSION_FILE!, undefined, undefined, {
		suppressBreadcrumb: true,
	});
	console.log(`GC_TEST_HELD ${process.pid}`);
	const { promise } = Promise.withResolvers<never>();
	await promise;
	await manager.close();
}

// Extra passes for ordering coverage (comma-separated): the combined run
// must prune undo tails BEFORE archive moves journals out of the active
// tree and BEFORE blob GC records tail-only references.
const extra = (process.env.GC_TEST_EXTRA ?? "").split(",").filter(Boolean);
const result = await runGcCommand({
	flags: {
		apply,
		undoTails: true,
		agentDir,
		keepUndoTails: Number(process.env.GC_TEST_KEEP ?? "1"),
		blobs: extra.includes("blobs"),
		archive: extra.includes("archive"),
	},
});

const bcDir = getTerminalSessionsDir(agentDir);
let breadcrumb = "ABSENT";
if (fs.existsSync(bcDir)) {
	const files = fs.readdirSync(bcDir);
	breadcrumb =
		files.length === 0
			? "EMPTY-DIR"
			: files.map(name => `${name}=${fs.readFileSync(`${bcDir}/${name}`, "utf8").replace(/\n/g, "|")}`).join(";");
}

console.log(
	"GC_TEST_RESULT " +
		JSON.stringify({
			skippedLive: result.undoTails?.skippedLive ?? 0,
			markersPruned: result.undoTails?.markersPruned ?? 0,
			entriesRemoved: result.undoTails?.entriesRemoved ?? 0,
			errors: result.undoTails?.errors?.length ?? 0,
			archived: result.archive?.archived ?? 0,
			blobsDeleted: result.blobs?.deleted ?? 0,
		}),
);
console.log(`GC_TEST_BREADCRUMB ${breadcrumb}`);
