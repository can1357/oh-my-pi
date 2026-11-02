import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSessionManager } from "@oh-my-pi/pi-coding-agent/main";
import { closeSessionIndex } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	lastSessionTransfer,
	markSessionMoved,
	SESSION_TRANSFER_MESSAGE_TYPE,
} from "@oh-my-pi/pi-coding-agent/session/session-transfer";
import { getConfigRootDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { makeAssistantMessage } from "./session-manager/helpers";

describe("resuming a session that moved away", () => {
	let root: string;
	let cwd: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

	beforeEach(async () => {
		root = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-session-moved-resume-"));
		cwd = path.join(root, "project");
		fs.mkdirSync(cwd, { recursive: true });
		setAgentDir(path.join(root, "agent"));
	});

	afterEach(async () => {
		closeSessionIndex();
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(path.join(getConfigRootDir(), "agent"));
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await fsp.rm(root, { recursive: true, force: true });
	});

	async function movedSession(): Promise<{ file: string; id: string }> {
		const session = SessionManager.create(cwd);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		const file = session.getSessionFile();
		const id = session.getSessionId();
		if (!file) throw new Error("session has no file");
		await session.close();
		await markSessionMoved(file, "cloud");
		return { file, id };
	}

	it("forks the stale copy with a visible notice instead of continuing it", async () => {
		const { file, id } = await movedSession();
		const staleBefore = await Bun.file(file).text();

		const manager = await createSessionManager(parseArgs(["--resume", file]), cwd, Settings.isolated({}));
		if (!manager) throw new Error("no session manager");
		const forkFile = manager.getSessionFile();
		await manager.close();

		expect(forkFile).toBeDefined();
		expect(forkFile).not.toBe(file);
		expect(manager.getHeader()?.parentSession).toBe(id);
		const notice = manager.getEntries().at(-1);
		expect(notice?.type).toBe("custom_message");
		if (notice?.type !== "custom_message") throw new Error("expected a transfer notice");
		expect(notice.customType).toBe(SESSION_TRANSFER_MESSAGE_TYPE);
		expect(notice.display).toBe(true);
		expect(notice.details).toEqual({ kind: "forked", source: file, to: "cloud" });
		// The stale copy is left exactly as it was.
		expect(await Bun.file(file).text()).toBe(staleBefore);
		expect(lastSessionTransfer(await loadEntriesFromFile(file))?.kind).toBe("departed");
	});

	it("resumes the fork itself without forking again", async () => {
		const { file } = await movedSession();
		const first = await createSessionManager(parseArgs(["--resume", file]), cwd, Settings.isolated({}));
		const forkFile = first?.getSessionFile();
		await first?.close();
		if (!forkFile) throw new Error("no fork");

		const again = await createSessionManager(parseArgs(["--resume", forkFile]), cwd, Settings.isolated({}));
		expect(again?.getSessionFile()).toBe(forkFile);
		await again?.close();
	});
});
