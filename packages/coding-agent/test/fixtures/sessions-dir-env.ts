/**
 * Child process for `test/session/sessions-dir-env.test.ts`. It starts with the
 * environment the test hands it, so the default agent directory and
 * `OMP_SESSIONS_DIR` resolve at module load, as they do for a real omp launch.
 *
 * argv: <resultFile> sessions <cwd>... | <resultFile> gc <cwd> | <resultFile> resolve <otherAgentDir> <value>...
 */
import * as fs from "node:fs/promises";
import { classifyAgentType, extractFolderFromPath } from "@oh-my-pi/omp-stats/parser";
import {
	getAgentDbPath,
	getAgentDir,
	getBlobsDir,
	getHistoryDbPath,
	getModelDbPath,
	getSessionsDir,
} from "@oh-my-pi/pi-utils";
import { runGcCommand } from "../../src/cli/gc-cli";
import { findSessionFiles } from "../../src/session/session-listing";
import { SessionManager } from "../../src/session/session-manager";
import { makeAssistantMessage } from "../session-manager/helpers";

const [resultFile, mode, ...args] = process.argv.slice(2);

async function answeredSession(cwd: string) {
	const session = SessionManager.create(cwd);
	session.appendMessage({ role: "user", content: `work in ${cwd}`, timestamp: Date.now() });
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
	// `OMP_SESSIONS_DIR` is read on every lookup, so one process can try each spelling in turn.
	const [otherAgentDir, ...values] = args;
	const rows = values.map(value => {
		process.env.OMP_SESSIONS_DIR = value;
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
} else {
	throw new Error(`unknown mode: ${mode}`);
}
