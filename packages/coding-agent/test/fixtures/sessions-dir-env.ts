/**
 * Child process for `test/session/sessions-dir-env.test.ts`. It starts with the
 * environment the test hands it, so the default agent directory and
 * `OMP_SESSIONS_DIR` resolve at module load, as they do for a real omp launch.
 *
 * argv: <resultFile> sessions <cwd>... | <resultFile> gc <cwd> | <resultFile> resolve <otherAgentDir> <value>...
 *     | <resultFile> image <cwd> <fill> | <resultFile> lifetime <cwd> <laterValue>
 *     | <resultFile> append <sessionFile> | <resultFile> trace <sessionFile>
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { classifyAgentType, extractFolderFromPath } from "@oh-my-pi/omp-stats/parser";
import { buildSessionTrace, listSessionSummaries } from "@oh-my-pi/omp-stats/trace";
import {
	getAgentDbPath,
	getAgentDir,
	getBlobsDir,
	getHistoryDbPath,
	getModelDbPath,
	getSessionsDir,
	refreshDirsFromEnv,
} from "@oh-my-pi/pi-utils";
import { runGcCommand } from "../../src/cli/gc-cli";
import { findSessionFiles } from "../../src/session/session-listing";
import { SessionManager } from "../../src/session/session-manager";
import { makeAssistantMessage } from "../session-manager/helpers";

const [resultFile, mode, ...args] = process.argv.slice(2);

type UserContent = string | Array<{ type: "image"; data: string; mimeType: string }>;

async function answeredSession(cwd: string, content: UserContent = `work in ${cwd}`) {
	const session = SessionManager.create(cwd);
	session.appendMessage({ role: "user", content, timestamp: Date.now() });
	session.appendMessage(makeAssistantMessage());
	await session.flush();
	const record = {
		cwd,
		id: session.getSessionId(),
		file: session.getSessionFile(),
		artifactsDir: session.getArtifactsDir(),
	};
	await session.close();
	return record;
}

if (mode === "sessions") {
	const sessions = [];
	for (const cwd of args) sessions.push(await answeredSession(cwd));
	const picker: Record<string, string[]> = {};
	for (const cwd of args) picker[cwd] = (await SessionManager.listForPicker(cwd)).map(session => session.id);
	const all = (await SessionManager.listAllForPicker()).map(session => session.id);
	// `omp --resume <id>` looks a session up by id under the sessions root.
	const resumeById: Record<string, string[]> = {};
	// `omp stats` attributes each transcript to a project folder and an agent type.
	const stats: Record<string, { folder: string; agentType: string }> = {};
	for (const { id, file } of sessions) {
		resumeById[id] = await findSessionFiles(id);
		if (file) stats[id] = { folder: extractFolderFromPath(file), agentType: classifyAgentType(file) };
	}
	const stores = {
		sessions: getSessionsDir(),
		agentDb: getAgentDbPath(),
		historyDb: getHistoryDbPath(),
		modelsDb: getModelDbPath(),
		blobs: getBlobsDir(),
	};
	await Bun.write(resultFile, JSON.stringify({ sessions, picker, all, resumeById, stats, stores }));
} else if (mode === "gc") {
	const session = await answeredSession(args[0]);
	if (!session.file) throw new Error("the session was not persisted");
	const cold = new Date(Date.now() - 90 * 86_400_000);
	await fs.utimes(session.file, cold, cold);
	const result = await runGcCommand({
		flags: { archive: true, apply: true, coldArchiveAfterDays: 30, retainNewestGlobal: 0, retainNewestPerCwd: 0 },
	});
	await Bun.write(resultFile, JSON.stringify({ session, archive: result.archive }));
} else if (mode === "resolve") {
	// The resolver reads `OMP_SESSIONS_DIR` when it is built: at module load and
	// again after omp applies its `.env` files. Rebuild it to try each spelling.
	const [otherAgentDir, ...values] = args;
	const rows = values.map(value => {
		process.env.OMP_SESSIONS_DIR = value;
		refreshDirsFromEnv();
		return {
			value,
			// Most callers: SessionManager, the picker, resume by id, stats.
			implicit: getSessionsDir(),
			// `omp gc --agent-dir`, `SessionManager.getDefaultSessionDir(cwd, agentDir)`, the SDK's `agentDir`.
			explicitDefault: getSessionsDir(getAgentDir()),
			explicitOther: getSessionsDir(otherAgentDir),
		};
	});
	await Bun.write(resultFile, JSON.stringify({ agentDir: getAgentDir(), rows }));
} else if (mode === "image") {
	// A session whose image lands in the shared blob store, then a later
	// image-free one, so the terminal's record of its last session (when the
	// test runner has a terminal) names the later one. `fill` makes each
	// image, and so each blob, distinct. Blobs are aged past gc's write grace.
	const [cwd, fill] = args;
	const data = Buffer.alloc(1500, Number(fill)).toString("base64");
	const session = await answeredSession(cwd, [{ type: "image", data, mimeType: "image/png" }]);
	await answeredSession(cwd);
	if (!session.file) throw new Error("the session was not persisted");
	const hash = (await Bun.file(session.file).text()).match(/blob:sha256:([a-f0-9]{64})/)?.[1];
	if (!hash) throw new Error("the image was not stored as a blob");
	const old = new Date(Date.now() - 3 * 86_400_000);
	for (const name of await fs.readdir(getBlobsDir())) await fs.utimes(path.join(getBlobsDir(), name), old, old);
	await Bun.write(resultFile, JSON.stringify({ session, blob: path.join(getBlobsDir(), hash) }));
} else if (mode === "lifetime") {
	// The variable changes while the process runs, as an SDK host or a test can change it.
	const [cwd, laterValue] = args;
	const before = await answeredSession(cwd);
	process.env.OMP_SESSIONS_DIR = laterValue;
	const after = await answeredSession(cwd);
	await Bun.write(resultFile, JSON.stringify({ before, after, sessionsDir: getSessionsDir() }));
} else if (mode === "append") {
	// What `--resume <path>` and `--continue` do with a transcript in a previous root: append to it in place.
	const [file] = args;
	const session = await SessionManager.open(file);
	session.appendMessage({ role: "user", content: "continued", timestamp: Date.now() });
	session.appendMessage(makeAssistantMessage());
	await session.flush();
	await session.close();
	await Bun.write(resultFile, JSON.stringify({ file: session.getSessionFile() }));
} else if (mode === "trace") {
	// The dashboard's Traces list and its trace view for one transcript.
	const [file] = args;
	const summaries = (await listSessionSummaries()).map(summary => summary.file);
	let trace: string;
	try {
		trace = (await buildSessionTrace(file)).file;
	} catch (error) {
		trace = `error: ${error instanceof Error ? error.message : String(error)}`;
	}
	await Bun.write(resultFile, JSON.stringify({ summaries, trace }));
} else {
	throw new Error(`unknown mode: ${mode}`);
}
