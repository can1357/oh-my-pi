import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { decideSessionAttach, probeSessionAttach } from "../../src/launch/session-attach";
import { gateSessionTarget, type ResolvedSessionTarget } from "../../src/launch/session-attach-gate";
import { tryAcquireSessionLease } from "../../src/session/session-storage";
import { AttachFixture, metadataFor, sessionIdFor, TERMINAL } from "./session-attach-fixture";

/** A pid that has been spawned and reaped, so `kill(pid, 0)` reports ESRCH. */
async function deadOwnerPid(): Promise<number> {
	const proc = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
	await proc.exited;
	return proc.pid;
}

let fixture: AttachFixture | undefined;

afterEach(async () => {
	await fixture?.close();
	fixture = undefined;
});

/** A sidecar left by a dead publisher whose socket path still refuses connections. */
async function stalePublication(sessionId: string): Promise<void> {
	fixture!.writeSidecar(sessionId, { ...metadataFor(sessionId, TERMINAL), pid: await deadOwnerPid() });
	fs.writeFileSync(fixture!.endpointFor(sessionId), "", { mode: 0o600 });
}

/** A sidecar left by a dead publisher whose socket path has been removed. */
async function vanishedPublication(sessionId: string): Promise<void> {
	fixture!.writeSidecar(sessionId, { ...metadataFor(sessionId, TERMINAL), pid: await deadOwnerPid() });
}

function targetFor(fixture: AttachFixture, sessionId: string): ResolvedSessionTarget {
	return {
		session: {
			path: fixture.writeSession(sessionId),
			id: sessionId,
			cwd: "/fixture/project",
			created: new Date(0),
			modified: new Date(0),
			messageCount: 1,
			size: 0,
			firstMessage: "",
			allMessagesText: "",
		},
	};
}

describe("stale session endpoints", () => {
	it("reports a dead publisher on a refusing socket as absent, so the gate may resume cold", async () => {
		fixture = new AttachFixture();
		const sessionId = sessionIdFor();
		await stalePublication(sessionId);
		const target = targetFor(fixture, sessionId);

		const probe = await probeSessionAttach(sessionId, { endpointDir: fixture.runDir, timeoutMs: 500 });

		expect(probe).toEqual({ status: "absent", sessionId, leaseHeld: false });
		expect(decideSessionAttach(probe)).toEqual({ kind: "cold", sessionId });

		const gate = await gateSessionTarget(target, {
			cwd: fixture.temp.path(),
			sessionDir: fixture.sessionsDir,
			endpointDir: fixture.runDir,
		});
		try {
			expect(gate.kind).toBe("cold");
		} finally {
			if (gate.kind === "cold") gate.reservation.release();
		}
	});

	it("keeps refusing a dead publisher's refused socket while the session lease is held", async () => {
		fixture = new AttachFixture();
		const sessionId = sessionIdFor();
		await stalePublication(sessionId);
		const target = targetFor(fixture, sessionId);
		const lease = tryAcquireSessionLease(sessionId);
		expect(lease).not.toBeNull();
		try {
			const probe = await probeSessionAttach(sessionId, { endpointDir: fixture.runDir, timeoutMs: 500 });

			expect(decideSessionAttach(probe)).toEqual({ kind: "refuse", code: "owner-busy" });

			const gate = await gateSessionTarget(target, {
				cwd: fixture.temp.path(),
				sessionDir: fixture.sessionsDir,
				endpointDir: fixture.runDir,
			});
			expect(gate).toEqual({ kind: "refuse", sessionId, code: "owner-busy" });
		} finally {
			lease?.release();
		}
	});

	it("reports a dead publisher whose socket path is gone as absent, so the gate may resume cold", async () => {
		fixture = new AttachFixture();
		const sessionId = sessionIdFor();
		await vanishedPublication(sessionId);
		const target = targetFor(fixture, sessionId);
		expect(fs.existsSync(fixture.endpointFor(sessionId))).toBe(false);

		const probe = await probeSessionAttach(sessionId, { endpointDir: fixture.runDir, timeoutMs: 500 });

		expect(probe).toEqual({ status: "absent", sessionId, leaseHeld: false });
		expect(decideSessionAttach(probe)).toEqual({ kind: "cold", sessionId });

		const gate = await gateSessionTarget(target, {
			cwd: fixture.temp.path(),
			sessionDir: fixture.sessionsDir,
			endpointDir: fixture.runDir,
		});
		try {
			expect(gate.kind).toBe("cold");
		} finally {
			if (gate.kind === "cold") gate.reservation.release();
		}
	});

	it("keeps refusing a dead publisher's vanished endpoint while the session lease is held", async () => {
		fixture = new AttachFixture();
		const sessionId = sessionIdFor();
		await vanishedPublication(sessionId);
		const target = targetFor(fixture, sessionId);
		const lease = tryAcquireSessionLease(sessionId);
		expect(lease).not.toBeNull();
		try {
			const probe = await probeSessionAttach(sessionId, { endpointDir: fixture.runDir, timeoutMs: 500 });

			expect(decideSessionAttach(probe)).toEqual({ kind: "refuse", code: "owner-busy" });

			const gate = await gateSessionTarget(target, {
				cwd: fixture.temp.path(),
				sessionDir: fixture.sessionsDir,
				endpointDir: fixture.runDir,
			});
			expect(gate).toEqual({ kind: "refuse", sessionId, code: "owner-busy" });
		} finally {
			lease?.release();
		}
	});

	it("keeps refusing a refused socket whose publisher pid is alive", async () => {
		fixture = new AttachFixture();
		const sessionId = sessionIdFor();
		fixture.writeSidecar(sessionId, metadataFor(sessionId, TERMINAL));
		fs.writeFileSync(fixture.endpointFor(sessionId), "", { mode: 0o600 });
		const target = targetFor(fixture, sessionId);

		const probe = await probeSessionAttach(sessionId, { endpointDir: fixture.runDir, timeoutMs: 500 });

		expect(probe).toEqual({ status: "unreachable", sessionId, endpoint: fixture.endpointFor(sessionId) });
		expect(decideSessionAttach(probe)).toEqual({ kind: "refuse", code: "owner-unreachable" });

		const gate = await gateSessionTarget(target, {
			cwd: fixture.temp.path(),
			sessionDir: fixture.sessionsDir,
			endpointDir: fixture.runDir,
		});
		expect(gate).toEqual({ kind: "refuse", sessionId, code: "owner-unreachable" });
	});
});
