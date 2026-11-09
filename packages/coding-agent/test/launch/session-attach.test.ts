import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tryAcquireSessionLease } from "../../src/session/session-storage";
import {
	decideRpcSessionAttach,
	decideSessionAttach,
	probeSessionAttach,
	type SessionAttachProbe,
	type SessionAttachRefusalCode,
} from "../../src/launch/session-attach";
import { AttachFixture, metadataFor, sessionIdFor, TERMINAL } from "./session-attach-fixture";

const liveWithTerminal: SessionAttachProbe = {
	status: "live",
	sessionId: "s",
	terminal: { protocolVersion: 1, projectDir: "/p", name: "n", id: "g" },
};
const liveWithoutTerminal: SessionAttachProbe = { status: "live", sessionId: "s" };
const unreachable: SessionAttachProbe = { status: "unreachable", sessionId: "s", endpoint: "/fixture/s.sock" };
const unknown: SessionAttachProbe = { status: "unknown", sessionId: "s", reason: "EACCES: permission denied" };
const absentHeld: SessionAttachProbe = { status: "absent", sessionId: "s", leaseHeld: true };
const absentUnknown: SessionAttachProbe = { status: "absent", sessionId: "s", leaseHeld: null };
const absentFree: SessionAttachProbe = { status: "absent", sessionId: "s", leaseHeld: false };

const refusals: Array<[SessionAttachProbe, SessionAttachRefusalCode]> = [
	[unreachable, "owner-unreachable"],
	[liveWithoutTerminal, "terminal-unavailable"],
	[absentHeld, "owner-busy"],
	[absentUnknown, "ownership-unknown"],
	[unknown, "ownership-unknown"],
];

describe("decideSessionAttach", () => {
	it.each(refusals)("refuses unsafe owner state %#", (probe, code) => {
		expect(decideSessionAttach(probe)).toEqual({ kind: "refuse", code });
	});

	it("attaches a live owner that publishes broker terminal coordinates", () => {
		expect(decideSessionAttach(liveWithTerminal)).toEqual({
			kind: "attach",
			terminal: { protocolVersion: 1, projectDir: "/p", name: "n", id: "g" },
		});
	});

	it("treats an unknown probe outcome as a refusal, never as absence", () => {
		const decision = decideSessionAttach(unknown);
		expect(decision.kind).toBe("refuse");
		expect(decision).not.toEqual({ kind: "cold", sessionId: "s" });
	});

	it("permits a cold open only for an absent publication with a demonstrably free lease", () => {
		const probes: SessionAttachProbe[] = [
			liveWithTerminal,
			liveWithoutTerminal,
			unreachable,
			unknown,
			absentHeld,
			absentUnknown,
			absentFree,
		];
		const cold = probes.map(decideSessionAttach).filter(decision => decision.kind === "cold");
		expect(cold).toEqual([{ kind: "cold", sessionId: "s" }]);
	});
});

describe("decideRpcSessionAttach", () => {
	it("attaches a live socket even when the publication carries no terminal", () => {
		expect(decideRpcSessionAttach(liveWithTerminal)).toEqual({ kind: "attach" });
		expect(decideRpcSessionAttach(liveWithoutTerminal)).toEqual({ kind: "attach" });
	});

	it("refuses unsafe owners and opens only a free absent target cold", () => {
		expect(decideRpcSessionAttach(unreachable)).toEqual({ kind: "refuse", code: "owner-unreachable" });
		expect(decideRpcSessionAttach(unknown)).toEqual({ kind: "refuse", code: "ownership-unknown" });
		expect(decideRpcSessionAttach(absentHeld)).toEqual({ kind: "refuse", code: "owner-busy" });
		expect(decideRpcSessionAttach(absentUnknown)).toEqual({ kind: "refuse", code: "ownership-unknown" });
		expect(decideRpcSessionAttach(absentFree)).toEqual({ kind: "cold", sessionId: "s" });
	});
});

let fixture: AttachFixture | undefined;

afterEach(async () => {
	await fixture?.close();
	fixture = undefined;
});

describe("probeSessionAttach", () => {
	it("resolves a live owner and its terminal coordinates read-only", async () => {
		fixture = new AttachFixture();
		const sessionId = sessionIdFor();
		fixture.writeSession(sessionId);
		await fixture.startOwner(sessionId, { terminal: TERMINAL });
		const before = fixture.snapshot();

		const probe = await probeSessionAttach(sessionId, { endpointDir: fixture.runDir, timeoutMs: 4_000 });

		expect(probe).toEqual({ status: "live", sessionId, terminal: TERMINAL });
		expect(decideSessionAttach(probe)).toEqual({ kind: "attach", terminal: TERMINAL });
		expect(fixture.snapshot()).toEqual(before);
	});

	it("reports a live owner without terminal coordinates as not attachable", async () => {
		fixture = new AttachFixture();
		const sessionId = sessionIdFor();
		await fixture.startOwner(sessionId);

		const probe = await probeSessionAttach(sessionId, { endpointDir: fixture.runDir, timeoutMs: 4_000 });

		expect(probe.status).toBe("live");
		expect(probe).not.toHaveProperty("terminal");
		expect(decideSessionAttach(probe)).toEqual({ kind: "refuse", code: "terminal-unavailable" });
	});

	it("ignores malformed terminal coordinates on an otherwise live owner", async () => {
		fixture = new AttachFixture();
		const sessionId = sessionIdFor();
		await fixture.startOwner(sessionId);
		fixture.writeSidecar(sessionId, {
			...metadataFor(sessionId),
			terminal: { protocolVersion: 2, projectDir: 7, name: "", id: null },
		});

		const probe = await probeSessionAttach(sessionId, { endpointDir: fixture.runDir, timeoutMs: 4_000 });

		expect(probe.status).toBe("live");
		expect(probe).not.toHaveProperty("terminal");
		expect(decideSessionAttach(probe)).toEqual({ kind: "refuse", code: "terminal-unavailable" });
	});

	it("refuses a socket that answers with another session identity", async () => {
		fixture = new AttachFixture();
		const sessionId = sessionIdFor();
		fixture.writeSession(sessionId);
		await fixture.startOwner(sessionId, { terminal: TERMINAL, reportedSessionId: "someone-else" });
		const before = fixture.snapshot();

		const probe = await probeSessionAttach(sessionId, { endpointDir: fixture.runDir, timeoutMs: 4_000 });

		expect(probe).toEqual({ status: "unreachable", sessionId, endpoint: fixture.endpointFor(sessionId) });
		expect(decideSessionAttach(probe)).toEqual({ kind: "refuse", code: "owner-unreachable" });
		expect(fixture.snapshot()).toEqual(before);
	});

	it("refuses a stale sidecar whose socket is gone without touching the artifacts", async () => {
		fixture = new AttachFixture();
		const sessionId = sessionIdFor();
		fixture.writeSession(sessionId);
		const sidecar = fixture.writeSidecar(sessionId, metadataFor(sessionId, TERMINAL));
		const before = fixture.snapshot();

		const probe = await probeSessionAttach(sessionId, { endpointDir: fixture.runDir, timeoutMs: 4_000 });

		expect(probe).toEqual({ status: "unreachable", sessionId, endpoint: fixture.endpointFor(sessionId) });
		expect(decideSessionAttach(probe)).toEqual({ kind: "refuse", code: "owner-unreachable" });
		expect(fixture.snapshot()).toEqual(before);
		expect(fs.readFileSync(sidecar, "utf8")).toContain(sessionId);
	});

	it("refuses a socket file that exists but never answers", async () => {
		fixture = new AttachFixture();
		const sessionId = sessionIdFor();
		fixture.writeSession(sessionId);
		await fixture.startSilentEndpoint(sessionId);
		const before = fixture.snapshot();

		const probe = await probeSessionAttach(sessionId, { endpointDir: fixture.runDir, timeoutMs: 200 });

		expect(probe).toEqual({ status: "unreachable", sessionId, endpoint: fixture.endpointFor(sessionId) });
		expect(decideSessionAttach(probe)).toEqual({ kind: "refuse", code: "owner-unreachable" });
		expect(fixture.snapshot()).toEqual(before);
	});

	it("refuses an endpoint path that nothing can connect to", async () => {
		fixture = new AttachFixture();
		const sessionId = sessionIdFor();
		fixture.writeSidecar(sessionId, metadataFor(sessionId, TERMINAL));
		fs.writeFileSync(fixture.endpointFor(sessionId), "", { mode: 0o600 });

		const probe = await probeSessionAttach(sessionId, { endpointDir: fixture.runDir, timeoutMs: 200 });

		expect(probe.status).toBe("unreachable");
		expect(decideSessionAttach(probe)).toEqual({ kind: "refuse", code: "owner-unreachable" });
	});

	it("refuses malformed discovery metadata without opening anything", async () => {
		fixture = new AttachFixture();
		const sessionId = sessionIdFor();
		fixture.writeSession(sessionId);
		fixture.writeSidecar(sessionId, "{not json");
		const before = fixture.snapshot();

		const probe = await probeSessionAttach(sessionId, { endpointDir: fixture.runDir, timeoutMs: 200 });

		expect(probe.status).toBe("unreachable");
		expect(decideSessionAttach(probe)).toEqual({ kind: "refuse", code: "owner-unreachable" });
		expect(fixture.snapshot()).toEqual(before);
	});

	it("refuses discovery metadata that names another session", async () => {
		fixture = new AttachFixture();
		const sessionId = sessionIdFor();
		fixture.writeSidecar(sessionId, metadataFor("another-session", TERMINAL));

		const probe = await probeSessionAttach(sessionId, { endpointDir: fixture.runDir, timeoutMs: 200 });

		expect(probe.status).toBe("unreachable");
		expect(decideSessionAttach(probe)).toEqual({ kind: "refuse", code: "owner-unreachable" });
	});

	it("permits a cold open only when no publication exists and the lease is free", async () => {
		fixture = new AttachFixture();
		const sessionId = sessionIdFor();
		fixture.writeSession(sessionId);

		const probe = await probeSessionAttach(sessionId, { endpointDir: fixture.runDir, timeoutMs: 200 });

		expect(probe).toEqual({ status: "absent", sessionId, leaseHeld: false });
		expect(decideSessionAttach(probe)).toEqual({ kind: "cold", sessionId });
	});

	it("refuses an absent publication while another process holds the lease", async () => {
		fixture = new AttachFixture();
		const sessionId = sessionIdFor();
		const lease = tryAcquireSessionLease(sessionId);
		expect(lease).not.toBeNull();
		try {
			const probe = await probeSessionAttach(sessionId, { endpointDir: fixture.runDir, timeoutMs: 200 });
			expect(probe).toEqual({ status: "absent", sessionId, leaseHeld: true });
			expect(decideSessionAttach(probe)).toEqual({ kind: "refuse", code: "owner-busy" });
		} finally {
			lease?.release();
		}
	});

	it("does not create the endpoint directory while probing", async () => {
		fixture = new AttachFixture();
		const sessionId = sessionIdFor();
		const missingRunDir = path.join(fixture.temp.path(), "never-created");

		const probe = await probeSessionAttach(sessionId, { endpointDir: missingRunDir, timeoutMs: 200 });

		expect(probe).toEqual({ status: "absent", sessionId, leaseHeld: false });
		expect(fs.existsSync(missingRunDir)).toBe(false);
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"reports an unreadable publication as unknown rather than absent",
		async () => {
			fixture = new AttachFixture();
			const sessionId = sessionIdFor();
			fixture.writeSidecar(sessionId, metadataFor(sessionId, TERMINAL));
			fs.chmodSync(fixture.runDir, 0o000);
			try {
				const probe = await probeSessionAttach(sessionId, { endpointDir: fixture.runDir, timeoutMs: 200 });
				expect(probe.status).toBe("unknown");
				expect(decideSessionAttach(probe)).toEqual({ kind: "refuse", code: "ownership-unknown" });
			} finally {
				fs.chmodSync(fixture.runDir, 0o700);
			}
		},
	);
});
