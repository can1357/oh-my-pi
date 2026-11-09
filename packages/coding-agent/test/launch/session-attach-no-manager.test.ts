import { afterEach, describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tryAcquireSessionLease } from "../../src/session/session-storage";
import { AttachFixture, metadataFor, sessionIdFor, TERMINAL } from "./session-attach-fixture";

const sessionManagerPath = path.resolve(import.meta.dir, "../../src/session/session-manager.ts");

interface ConstructorTrap {
	constructed(): number;
	trap: unknown;
}

// Dynamic import is required: the module under test must load after the SessionManager mock is installed.
async function installConstructorTrap(): Promise<ConstructorTrap> {
	const actual = await import(sessionManagerPath);
	let constructed = 0;
	const trap = new Proxy(actual.SessionManager as unknown as new (...args: never[]) => unknown, {
		construct(target, args, newTarget) {
			constructed++;
			return Reflect.construct(target, args, newTarget);
		},
	});
	mock.module(sessionManagerPath, () => ({ ...actual, SessionManager: trap }));
	return { constructed: () => constructed, trap };
}

let fixture: AttachFixture | undefined;

afterEach(async () => {
	await fixture?.close();
	fixture = undefined;
	mock.restore();
});

describe("probeSessionAttach construction boundary", () => {
	it("traps SessionManager construction through the mocked module graph", async () => {
		const { constructed, trap } = await installConstructorTrap();
		const { SessionManager } = await import(sessionManagerPath);
		expect(SessionManager as unknown).toBe(trap);
		new (SessionManager as unknown as new (...args: unknown[]) => unknown)("/tmp", "/tmp", false, {});
		expect(constructed()).toBe(1);
	});

	it("never constructs a SessionManager on any probe path", async () => {
		const { constructed } = await installConstructorTrap();
		// Dynamic import is required: session-attach must first load under the installed trap.
		const { probeSessionAttach, decideSessionAttach } = await import("../../src/launch/session-attach");

		fixture = new AttachFixture();

		const liveId = sessionIdFor();
		await fixture.startOwner(liveId, { terminal: TERMINAL });
		const live = await probeSessionAttach(liveId, { endpointDir: fixture.runDir, timeoutMs: 4_000 });
		expect(decideSessionAttach(live).kind).toBe("attach");

		const staleId = sessionIdFor();
		await fixture.startSilentEndpoint(staleId);
		const stale = await probeSessionAttach(staleId, { endpointDir: fixture.runDir, timeoutMs: 200 });
		expect(stale.status).toBe("unreachable");
		expect(decideSessionAttach(stale)).toEqual({ kind: "refuse", code: "owner-unreachable" });

		const absentId = sessionIdFor();
		fixture.writeSession(absentId);
		const absent = await probeSessionAttach(absentId, { endpointDir: fixture.runDir, timeoutMs: 200 });
		expect(absent).toEqual({ status: "absent", sessionId: absentId, leaseHeld: false });
		expect(decideSessionAttach(absent)).toEqual({ kind: "cold", sessionId: absentId });

		const busyId = sessionIdFor();
		const lease = tryAcquireSessionLease(busyId);
		expect(lease).not.toBeNull();
		try {
			const busy = await probeSessionAttach(busyId, { endpointDir: fixture.runDir, timeoutMs: 200 });
			expect(busy).toEqual({ status: "absent", sessionId: busyId, leaseHeld: true });
			expect(decideSessionAttach(busy)).toEqual({ kind: "refuse", code: "owner-busy" });
		} finally {
			lease?.release();
		}

		expect(constructed()).toBe(0);
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"never constructs a SessionManager while reporting an unknown probe outcome",
		async () => {
			const { constructed } = await installConstructorTrap();
			// Dynamic import is required: session-attach must first load under the installed trap.
			const { probeSessionAttach, decideSessionAttach } = await import("../../src/launch/session-attach");

			fixture = new AttachFixture();
			const sessionId = sessionIdFor();
			const denied = path.join(fixture.temp.path(), "denied");
			fs.mkdirSync(denied, { mode: 0o700 });
			fixture.writeSidecar(sessionId, metadataFor(sessionId, TERMINAL));
			fs.renameSync(fixture.sidecarFor(sessionId), path.join(denied, `${sessionId}.json`));
			fs.chmodSync(denied, 0o000);
			try {
				const probe = await probeSessionAttach(sessionId, { endpointDir: denied, timeoutMs: 200 });
				expect(probe.status).toBe("unknown");
				expect(decideSessionAttach(probe)).toEqual({ kind: "refuse", code: "ownership-unknown" });
			} finally {
				fs.chmodSync(denied, 0o700);
			}
			expect(constructed()).toBe(0);
		},
	);
});
