import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	describeSessionAttachRefusal,
	gateSessionTarget,
	resolveStartupSessionGate,
} from "../../src/launch/session-attach-gate";
import type {
	SessionAttachProbe,
	SessionAttachRefusalCode,
	SessionAttachTerminal,
} from "../../src/launch/session-attach";
import { readSessionInfo } from "../../src/session/session-listing";
import { SessionManager } from "../../src/session/session-manager";
import { FileSessionStorage, isSessionLeaseHeld } from "../../src/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { TERMINAL } from "./session-attach-fixture";

function userTurn(content: string) {
	return { role: "user" as const, content, timestamp: Date.now() };
}

async function createSession(dir: string, content: string): Promise<{ sessionId: string; sessionPath: string }> {
	const creator = SessionManager.create(dir, dir, new FileSessionStorage());
	await creator.ensureOnDisk();
	creator.appendMessage(userTurn(content));
	await creator.flush();
	const sessionPath = creator.getSessionFile();
	if (!sessionPath) throw new Error("Expected a session file");
	await creator.close();
	const session = await readSessionInfo(sessionPath);
	if (!session) throw new Error("Expected a readable session header");
	return { sessionId: session.id, sessionPath };
}

function liveProbe(observed: string[], terminal: SessionAttachTerminal = TERMINAL) {
	return async (sessionId: string): Promise<SessionAttachProbe> => {
		observed.push(sessionId);
		return { status: "live", sessionId, terminal };
	};
}

function absentProbe(observed: string[]) {
	return async (sessionId: string): Promise<SessionAttachProbe> => {
		observed.push(sessionId);
		return { status: "absent", sessionId, leaseHeld: false };
	};
}

describe("resolveStartupSessionGate", () => {
	it("probes the session a bare --resume id resolves to", async () => {
		using tempDir = TempDir.createSync("@omp-session-gate-");
		const { sessionId, sessionPath } = await createSession(tempDir.path(), "resume by id");
		const observed: string[] = [];

		const gate = await resolveStartupSessionGate({
			cwd: tempDir.path(),
			sessionDir: tempDir.path(),
			resume: sessionId,
			probe: liveProbe(observed),
		});

		expect(observed).toEqual([sessionId]);
		expect(gate.kind).toBe("attach");
		if (gate.kind !== "attach") throw new Error("expected attach");
		expect(gate.target.session.path).toBe(sessionPath);
		expect(gate.terminal).toEqual(TERMINAL);
	});

	it("probes a session named by --resume path", async () => {
		using tempDir = TempDir.createSync("@omp-session-gate-");
		const { sessionId, sessionPath } = await createSession(tempDir.path(), "resume by path");
		const observed: string[] = [];

		const gate = await resolveStartupSessionGate({
			cwd: tempDir.path(),
			sessionDir: tempDir.path(),
			resume: sessionPath,
			probe: liveProbe(observed),
		});

		expect(observed).toEqual([sessionId]);
		expect(gate.kind).toBe("attach");
		if (gate.kind !== "attach") throw new Error("expected attach");
		expect(gate.target.session.path).toBe(sessionPath);
	});

	it("probes the recent session --continue selects", async () => {
		using tempDir = TempDir.createSync("@omp-session-gate-");
		const { sessionId, sessionPath } = await createSession(tempDir.path(), "continue target");
		const observed: string[] = [];

		const gate = await resolveStartupSessionGate({
			cwd: tempDir.path(),
			sessionDir: tempDir.path(),
			continue: true,
			probe: liveProbe(observed),
		});

		expect(observed).toEqual([sessionId]);
		expect(gate.kind).toBe("attach");
		if (gate.kind !== "attach") throw new Error("expected attach");
		expect(gate.target.session.path).toBe(sessionPath);
	});

	it("probes the recent session auto-resume selects", async () => {
		using tempDir = TempDir.createSync("@omp-session-gate-");
		const cwd = tempDir.path();
		const creator = SessionManager.create(cwd);
		await creator.ensureOnDisk();
		creator.appendMessage(userTurn("auto resume target"));
		await creator.flush();
		const sessionPath = creator.getSessionFile();
		if (!sessionPath) throw new Error("Expected a session file");
		await creator.close();
		const sessionsDir = path.dirname(sessionPath);
		const observed: string[] = [];
		try {
			const gate = await resolveStartupSessionGate({
				cwd,
				autoResume: true,
				probe: liveProbe(observed),
			});

			expect(observed).toHaveLength(1);
			expect(gate.kind).toBe("attach");
			if (gate.kind !== "attach") throw new Error("expected attach");
			expect(gate.target.session.path).toBe(sessionPath);
		} finally {
			fs.rmSync(sessionsDir, { recursive: true, force: true });
		}
	});

	it("turns a cold target into a strict reservation the opener must adopt", async () => {
		using tempDir = TempDir.createSync("@omp-session-gate-");
		const { sessionId, sessionPath } = await createSession(tempDir.path(), "cold target");
		const observed: string[] = [];

		const gate = await resolveStartupSessionGate({
			cwd: tempDir.path(),
			sessionDir: tempDir.path(),
			resume: sessionId,
			probe: absentProbe(observed),
		});

		expect(observed).toEqual([sessionId, sessionId]);
		expect(gate.kind).toBe("cold");
		if (gate.kind !== "cold") throw new Error("expected cold");
		expect(gate.target.session.path).toBe(sessionPath);
		expect(gate.reservation.sessionId).toBe(sessionId);
		expect(isSessionLeaseHeld(sessionId)).toBe(true);
		gate.reservation.release();
		expect(isSessionLeaseHeld(sessionId)).toBe(false);
	});

	it("never probes a path that does not reopen an existing transcript", async () => {
		using tempDir = TempDir.createSync("@omp-session-gate-");
		const observed: string[] = [];
		const probe = liveProbe(observed);
		const shared = {
			cwd: tempDir.path(),
			sessionDir: tempDir.path(),
			probe,
		};

		expect((await resolveStartupSessionGate({ ...shared, fork: "some-session" })).kind).toBe("none");
		expect((await resolveStartupSessionGate({ ...shared, noSession: true })).kind).toBe("none");
		expect((await resolveStartupSessionGate({ ...shared, fromClaude: true })).kind).toBe("none");
		expect((await resolveStartupSessionGate({ ...shared, fromCodex: true })).kind).toBe("none");
		expect((await resolveStartupSessionGate({ ...shared, resume: true })).kind).toBe("none");
		expect((await resolveStartupSessionGate({ ...shared, autoResume: true, goal: "fresh goal" })).kind).toBe("none");
		expect(observed).toEqual([]);
	});
});

describe("gateSessionTarget (picker selection)", () => {
	async function target(dir: string, content: string) {
		const created = await createSession(dir, content);
		const session = await readSessionInfo(created.sessionPath);
		if (!session) throw new Error("Expected a readable session header");
		return { ...created, target: { session } };
	}

	it("attaches a picked target that is live", async () => {
		using tempDir = TempDir.createSync("@omp-session-gate-");
		const { sessionId, target: picked } = await target(tempDir.path(), "picked live");
		const observed: string[] = [];

		const gate = await gateSessionTarget(picked, {
			cwd: tempDir.path(),
			sessionDir: tempDir.path(),
			probe: liveProbe(observed),
		});

		expect(observed).toEqual([sessionId]);
		expect(gate).toMatchObject({ kind: "attach", terminal: TERMINAL, target: picked });
	});

	it("reserves a picked target that is cold", async () => {
		using tempDir = TempDir.createSync("@omp-session-gate-");
		const { sessionId, target: picked } = await target(tempDir.path(), "picked cold");

		const gate = await gateSessionTarget(picked, {
			cwd: tempDir.path(),
			sessionDir: tempDir.path(),
			probe: absentProbe([]),
		});

		expect(gate.kind).toBe("cold");
		if (gate.kind !== "cold") throw new Error("expected cold");
		expect(isSessionLeaseHeld(sessionId)).toBe(true);
		gate.reservation.release();
		expect(isSessionLeaseHeld(sessionId)).toBe(false);
	});

	it("refuses every non-cold probe without taking a reservation", async () => {
		using tempDir = TempDir.createSync("@omp-session-gate-");
		const { sessionId, target: picked } = await target(tempDir.path(), "picked refusal");
		const cases: Array<[SessionAttachProbe, SessionAttachRefusalCode]> = [
			[{ status: "unreachable", sessionId, endpoint: "/run/session" }, "owner-unreachable"],
			[{ status: "unknown", sessionId, reason: "unreadable publication" }, "ownership-unknown"],
			[{ status: "absent", sessionId, leaseHeld: true }, "owner-busy"],
			[{ status: "absent", sessionId, leaseHeld: null }, "ownership-unknown"],
			[{ status: "live", sessionId }, "terminal-unavailable"],
		];

		for (const [probe, code] of cases) {
			const gate = await gateSessionTarget(picked, {
				cwd: tempDir.path(),
				sessionDir: tempDir.path(),
				probe: async () => probe,
			});
			expect(gate).toEqual({ kind: "refuse", sessionId, code });
			expect(isSessionLeaseHeld(sessionId)).toBe(false);
		}
	});

	it("describes every refusal without offering a second transcript", () => {
		const codes = ["owner-unreachable", "terminal-unavailable", "owner-busy", "ownership-unknown"] as const;
		const messages = codes.map(code => describeSessionAttachRefusal("session-a", code));
		expect(new Set(messages).size).toBe(codes.length);
		for (const message of messages) {
			expect(message).toContain("session-a");
			expect(message).toContain("refusing to open a second transcript");
		}
	});
});
