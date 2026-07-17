import { describe, expect, it } from "bun:test";
import type { ConsentRecord } from "@pk-nerdsaver-ai/pi-context-policy";
import { type GopkClipAnalysis, type GopkClipIngestionPolicy, ingestGopkClip, SqliteActivityLedger } from "../src";

const consent: ConsentRecord = {
	userId: "user-1",
	deviceId: "device-1",
	identityVerified: true,
	enabled: true,
	scope: "device",
	remoteStorageEnabled: false,
	policyVersion: "context-retention/v1",
};

const policy: GopkClipIngestionPolicy = {
	enabled: true,
	allowedApplicationIds: [],
	deniedApplicationIds: [],
	maximumRawClipRetentionMs: 10 * 60_000,
};

function analysis(localPointer: string): GopkClipAnalysis {
	return {
		clipId: "clip-1",
		window: { startedAt: "2026-07-13T14:00:00.000Z", endedAt: "2026-07-13T14:05:00.000Z" },
		application: { id: "code", category: "editor" },
		redaction: { status: "redacted", completedAt: "2026-07-13T14:05:30.000Z" },
		activityCategory: "coding",
		confidence: "medium",
		confidenceReason: "test",
		clipHash: "sha256:clip",
		localPointer,
	};
}

function ingest(localPointer: string) {
	const ledger = new SqliteActivityLedger(":memory:");
	try {
		return ingestGopkClip({
			capture: { userId: "user-1", deviceId: "device-1", sessionId: "session-1" },
			consent,
			policy,
			analysis: analysis(localPointer),
			ingestedAt: "2026-07-13T14:06:00.000Z",
			ledger,
		});
	} finally {
		ledger.close();
	}
}

describe("isLocalPointer via ingestGopkClip", () => {
	it("accepts a POSIX absolute path", () => {
		expect(ingest("/home/user/captures/clip-1.json").status).toBe("stored");
	});

	it("accepts a Windows drive path and a file:// URI", () => {
		expect(ingest("C:\\captures\\clip-1.json").status).toBe("stored");
		expect(ingest("file:///home/user/captures/clip-1.json").status).toBe("stored");
	});

	it("rejects a UNC-style double-slash path", () => {
		const result = ingest("//attacker-host/share/clip-1.json");
		expect(result.status).toBe("rejected");
		if (result.status === "rejected") expect(result.reason).toBe("clip evidence pointer must remain local");
	});

	it("rejects a relative path", () => {
		expect(ingest("captures/clip-1.json").status).toBe("rejected");
	});
});
