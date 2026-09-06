import { describe, expect, it } from "bun:test";
import { buildSessionData } from "@oh-my-pi/pi-coding-agent/export/html";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { assistantMsg, userMsg } from "./utilities";

function sessionWithAnEmptyBranch() {
	const session = SessionManager.inMemory();
	const idRoot = session.appendMessage(userMsg("root"));
	const idAnswered = session.appendMessage(assistantMsg("answered"));
	session.branch(idRoot);
	const idAbandoned = session.appendMessage(userMsg("abandoned prompt"));
	session.branch(idRoot);
	return { session, idRoot, idAnswered, idAbandoned };
}

describe("HTML export with archived branches", () => {
	it("leaves archived branches out of the exported snapshot", async () => {
		const { session, idAbandoned, idAnswered } = sessionWithAnEmptyBranch();
		await session.archiveEmptyBranches();

		const ids = buildSessionData(session).entries.map(e => e.id);
		expect(ids).not.toContain(idAbandoned);
		expect(ids).toContain(idAnswered);
	});

	it("includes them when the export explicitly asks for them", async () => {
		const { session, idAbandoned } = sessionWithAnEmptyBranch();
		await session.archiveEmptyBranches();

		const ids = buildSessionData(session, undefined, { includeArchived: true }).entries.map(e => e.id);
		expect(ids).toContain(idAbandoned);
	});

	it("never ships the archive bookkeeping records themselves", async () => {
		const { session } = sessionWithAnEmptyBranch();
		await session.archiveEmptyBranches();

		for (const options of [undefined, { includeArchived: true }]) {
			const types = buildSessionData(session, undefined, options).entries.map(e => e.type);
			expect(types).not.toContain("archive");
		}
	});

	it("resolves the leaf back to a visible entry when the archive record is the leaf", async () => {
		const { session, idAnswered } = sessionWithAnEmptyBranch();
		session.branch(idAnswered);
		await session.archiveEmptyBranches();
		// Appending the archive record moved the leaf onto it; the export drops that
		// record, so a naive snapshot would point at an entry it did not ship.
		expect(session.getEntry(session.getLeafId() ?? "")?.type).toBe("archive");

		const data = buildSessionData(session);
		expect(data.leafId).toBe(idAnswered);
		expect(data.entries.some(e => e.id === data.leafId)).toBe(true);
	});

	it("reparents visible turns appended after archive bookkeeping", async () => {
		const { session, idRoot } = sessionWithAnEmptyBranch();
		await session.archiveEmptyBranches();
		const continuationId = session.appendMessage(userMsg("continue from the visible branch"));

		const data = buildSessionData(session);
		const continuation = data.entries.find(entry => entry.id === continuationId);
		expect(continuation?.parentId).toBe(idRoot);
		expect(data.leafId).toBe(continuationId);
	});

	it("omits labels whose targets are archived", async () => {
		const { session, idAbandoned } = sessionWithAnEmptyBranch();
		await session.archiveEmptyBranches();
		const labelId = session.appendLabelChange(idAbandoned, "private branch label");

		const hidden = buildSessionData(session);
		expect(hidden.entries.map(entry => entry.id)).not.toContain(labelId);
		expect(JSON.stringify(hidden)).not.toContain("private branch label");

		const revealed = buildSessionData(session, undefined, { includeArchived: true });
		expect(revealed.entries.map(entry => entry.id)).toContain(labelId);
	});
});
