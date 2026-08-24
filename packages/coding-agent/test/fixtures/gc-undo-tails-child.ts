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

// Interposition for mtime-restore race coverage: mutate the journal (or
// its ownership) between a prune's publish and the gc pass's restore
// decision, exactly where a concurrent manager would land.
if (process.env.GC_TEST_INTERPOSE === "change" || process.env.GC_TEST_INTERPOSE === "owner") {
	const original = SessionManager.prototype.pruneUserUndoTails;
	SessionManager.prototype.pruneUserUndoTails = async function (this: SessionManager, ...args) {
		const counts = await original.apply(this, args);
		const file = this.getSessionFile()!;
		if (process.env.GC_TEST_INTERPOSE === "change") {
			fs.appendFileSync(file, `${JSON.stringify({ type: "title", v: 1, title: "" })}\n`);
		} else {
			// A third-party owner: a live process that is not the gc child
			// itself (its own claim is legitimate during the prune). The
			// spawning test runner's pid is alive for the child's whole run.
			fs.writeFileSync(`${file}.owner`, `${process.env.GC_TEST_PARENT_PID!}\n`);
		}
		return counts;
	} as typeof original;
}

// Extra passes for ordering coverage (comma-separated): the combined run
// must prune undo tails BEFORE archive moves journals out of the active
// tree and BEFORE blob GC records tail-only references.
if (process.env.GC_TEST_INTERPOSE === "preopen-change") {
	const original = SessionManager.open;
	SessionManager.open = async function (this: unknown, ...args) {
		fs.appendFileSync(args[0], `${JSON.stringify({ type: "title", v: 1, title: "" })}\n`);
		return original.apply(this, args);
	} as typeof original;
}

const extra = (process.env.GC_TEST_EXTRA ?? "").split(",").filter(Boolean);
// Hold-open mode with the append writer actually open: the child owns the
// journal's file lock, so a moveTo in another process must refuse.
if (process.env.GC_TEST_MODE === "hold-writer") {
	const manager = await SessionManager.open(process.env.GC_TEST_SESSION_FILE!, undefined, undefined, {
		suppressBreadcrumb: true,
	});
	manager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "held" }],
		timestamp: Date.now(),
	} as never);
	// Marker file instead of stdout: the test polls for it without waiting
	// on a pipe this never-exiting child would hold open.
	fs.writeFileSync(`${process.env.GC_TEST_SESSION_FILE!}.held`, `${process.pid}\n`);
	console.log(`GC_TEST_HELD ${process.pid}`);
	const { promise } = Promise.withResolvers<never>();
	await promise;
	await manager.close();
}

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
