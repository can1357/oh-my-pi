/**
 * A session whose transcripts live only in a SQL table — `session.storage:
 * sql`, or a tree migrated into one — is resumed in a later process.
 *
 * The reads below walked the local filesystem instead of the storage that
 * holds the session, so the resumed session could not see its own subagents,
 * `/seance` could not find a session the table held by its id or its path,
 * and the resume picker could not rename it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { resolveResumeTarget } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { computeDefaultSessionDir } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import {
	defaultSessionStorage,
	setDefaultSessionStorage,
	type SessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { resolveSeanceSource } from "@oh-my-pi/pi-coding-agent/task/seance";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";

/** A current-version transcript: header, one user turn, one assistant reply. */
function transcript(headerId: string, cwd: string, user: string, assistant: string): string {
	const timestamp = "2026-10-29T00:00:00.000Z";
	return `${[
		{ type: "session", version: 3, id: headerId, timestamp, cwd },
		{
			type: "message",
			id: "m1",
			parentId: null,
			timestamp,
			message: { role: "user", content: user, timestamp: 1 },
		},
		{
			type: "message",
			id: "m2",
			parentId: "m1",
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "text", text: assistant }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test-model",
				usage: {},
				stopReason: "stop",
				timestamp: 2,
			},
		},
	]
		.map(entry => JSON.stringify(entry))
		.join("\n")}\n`;
}

function toolSessionFor(cwd: string, sessionFile: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => sessionFile.slice(0, -".jsonl".length),
		settings: Settings.isolated(),
	} as unknown as ToolSession;
}

describe("a session resumed from SQL session storage", () => {
	let previousStorage: SessionStorage;

	beforeEach(() => {
		previousStorage = defaultSessionStorage();
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
	});

	afterEach(() => {
		setDefaultSessionStorage(previousStorage);
		InternalUrlRouter.resetForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("reads its subagents' transcripts through history://", async () => {
		using tempDir = TempDir.createSync("@omp-sql-history-");
		const cwd = tempDir.join("project");
		const database = `sqlite://${tempDir.join("sessions.db")}`;
		const rootFile = tempDir.join("sessions/--project--/2026-10-29T00-00-00-000Z_01a1854c.jsonl");
		const childFile = path.join(rootFile.slice(0, -".jsonl".length), "InfraOtherPkgs.jsonl");

		// The session as a migrated one looks: both transcripts are rows, and
		// nothing of this session is on the filesystem.
		const written = await SqlSessionStorage.create({ client: new SQL(database) });
		await written.writeText(rootFile, transcript("01a1854c", cwd, "root turn", "root reply"));
		await written.writeText(childFile, transcript("child-session", cwd, "child brief", "child reply"));
		await written.drain();

		// A later process opens the same table and resumes the root session.
		setDefaultSessionStorage(await SqlSessionStorage.create({ client: new SQL(database) }));
		AgentRegistry.global().register({
			id: "Main",
			displayName: "main",
			kind: "main",
			session: null,
			sessionFile: rootFile,
			status: "idle",
		});
		const context = { session: toolSessionFor(cwd, rootFile), sessionFile: rootFile };
		const router = InternalUrlRouter.instance();

		const index = await router.resolve("history://", context);
		expect(index.content).toMatch(/\| InfraOtherPkgs \| parked \| sub \| Main \|/);

		const resource = await router.resolve("history://InfraOtherPkgs", context);
		expect(resource.content).toContain("# InfraOtherPkgs (parked)");
		expect(resource.content).toContain("child brief");
		expect(resource.content).toContain("child reply");
	});

	it("is found by the first characters of its id", async () => {
		using tempDir = TempDir.createSync("@omp-sql-resume-");
		const cwd = tempDir.join("project");
		const database = `sqlite://${tempDir.join("sessions.db")}`;
		const storage = await SqlSessionStorage.create({ client: new SQL(database) });
		setDefaultSessionStorage(storage);

		const id = "01a1880d-aaaa-7000-9000-000000000001";
		const sessionDir = computeDefaultSessionDir(cwd, storage);
		const sessionFile = path.join(sessionDir, `2026-10-29T00-00-00-000Z_${id}.jsonl`);
		await storage.writeText(sessionFile, transcript(id, cwd, "only in the table", "stored reply"));
		await storage.drain();

		const target = await resolveResumeTarget(id.slice(0, 8), cwd, sessionDir);

		expect([target?.session.id, target?.session.path]).toEqual([id, sessionFile]);
	});

	it("is found by /seance by its id prefix and by its path", async () => {
		using tempDir = TempDir.createSync("@omp-sql-seance-");
		const cwd = tempDir.join("project");
		const database = `sqlite://${tempDir.join("sessions.db")}`;
		const storage = await SqlSessionStorage.create({ client: new SQL(database) });
		setDefaultSessionStorage(storage);

		const id = "01a1880d-bbbb-7000-9000-000000000002";
		const sessionDir = computeDefaultSessionDir(cwd, storage);
		const sessionFile = path.join(sessionDir, `2026-10-29T00-00-00-000Z_${id}.jsonl`);
		await storage.writeText(sessionFile, transcript(id, cwd, "only in the table", "stored reply"));
		await storage.drain();

		const byId = await resolveSeanceSource(id.slice(0, 8), { cwd, sessionDirHint: sessionDir });
		const byPath = await resolveSeanceSource(sessionFile, { cwd });

		expect([byId.id, byId.file, byPath.id, byPath.file]).toEqual([id, sessionFile, id, sessionFile]);
	});

	it("is renamed from the resume picker and keeps the title in the table", async () => {
		using tempDir = TempDir.createSync("@omp-sql-rename-");
		const cwd = tempDir.join("project");
		const database = `sqlite://${tempDir.join("sessions.db")}`;
		const storage = await SqlSessionStorage.create({ client: new SQL(database) });
		setDefaultSessionStorage(storage);

		const id = "01a1880d-cccc-7000-9000-000000000003";
		const sessionDir = computeDefaultSessionDir(cwd, storage);
		const sessionFile = path.join(sessionDir, `2026-10-29T00-00-00-000Z_${id}.jsonl`);
		await storage.writeText(sessionFile, transcript(id, cwd, "only in the table", "stored reply"));
		await storage.drain();

		const renamed = await SessionManager.renameSessionTitle(sessionFile, "Renamed in the table", { cwd });
		await storage.drain();
		// A second store over the same database reads what the first one wrote.
		const reopened = await SessionManager.open(
			sessionFile,
			undefined,
			await SqlSessionStorage.create({ client: new SQL(database) }),
			{ suppressBreadcrumb: true },
		);
		const persisted = reopened.getSessionName();
		await reopened.close();

		expect([renamed, persisted]).toEqual(["Renamed in the table", "Renamed in the table"]);
	});
});
