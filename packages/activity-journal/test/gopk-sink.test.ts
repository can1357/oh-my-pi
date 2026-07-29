import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ConsentRecord } from "@pk-nerdsaver-ai/pi-context-policy";
import {
	createConstrainedRawClipRemover,
	createGopkActivitySink,
	type GopkCapturedDerivative,
	type GopkClipIngestionPolicy,
	SqliteActivityLedger,
} from "../src";

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
	ocrEnabled: true,
	allowedApplicationIds: ["code"],
	deniedApplicationIds: ["1password"],
	maximumRawClipRetentionMs: 10 * 60_000,
};

const capture = { userId: "user-1", deviceId: "device-1", sessionId: "session-1", projectId: "omp" };

function createDerivative(localManifestPointer: string): GopkCapturedDerivative {
	return {
		clipId: "clip-1",
		sessionId: "session-1",
		window: { startedAt: "2026-07-13T14:00:00.000Z", endedAt: "2026-07-13T14:05:00.000Z" },
		appIdentity: { processName: "code" },
		sanitizedDigest: "Edited the activity journal adapter.",
		ocrSnippet: "Updated the activity journal adapter.",
		sanitizationAttestation: {
			status: "sanitized",
			completedAt: "2026-07-13T14:05:30.000Z",
			sanitizerVersion: "gopk-sanitizer-v1",
		},
		clipHash: "sha256:clip",
		keyframeHash: "sha256:keyframe",
		localManifestPointer,
	};
}

describe("gopk activity sink", () => {
	it("stores sanitized derivatives as corroborating screen evidence", async () => {
		const ledger = new SqliteActivityLedger(":memory:");
		const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "activity-journal-gopk-"));
		const manifestPath = path.join(captureRoot, "clip-1.manifest.json");
		await Bun.write(manifestPath, "{}");
		const sink = createGopkActivitySink({ ledger, consent, policy, capture, captureRoot });

		await sink(createDerivative(manifestPath));

		expect(ledger.list()).toHaveLength(1);
		expect(ledger.list()[0]).toMatchObject({
			signal: "screen_active",
			strength: "corroborating",
			application: { id: "code", category: "editor" },
		});
		expect(ledger.list()[0]?.ocrSnippet).toBe("Updated the activity journal adapter.");
		ledger.close();
		await fs.rm(captureRoot, { recursive: true, force: true });
	});

	it("re-redacts untrusted handoff text before ledger persistence", async () => {
		const ledger = new SqliteActivityLedger(":memory:");
		const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "activity-journal-gopk-"));
		const manifestPath = path.join(captureRoot, "clip-1.manifest.json");
		await Bun.write(manifestPath, "{}");
		const sink = createGopkActivitySink({ ledger, consent, policy, capture, captureRoot });
		const token = `github_pat_${"A".repeat(40)}`;

		await sink({
			...createDerivative(manifestPath),
			sanitizedDigest: `Build failed with ${token}`,
			ocrSnippet: `ERROR token ${token}`,
		});

		const [stored] = ledger.list();
		expect(stored?.redactedDigest).toContain("[REDACTED]");
		expect(stored?.ocrSnippet).toContain("[REDACTED]");
		expect(JSON.stringify(stored)).not.toContain(token);
		ledger.close();
		await fs.rm(captureRoot, { recursive: true, force: true });
	});

	it("rejects a manifest path that escapes the capture root without throwing", async () => {
		const ledger = new SqliteActivityLedger(":memory:");
		const captureRoot = path.resolve("C:\\captures");
		const sink = createGopkActivitySink({ ledger, consent, policy, capture, captureRoot });
		const escapedManifest = path.resolve(captureRoot, "..", "evil", "clip.json");

		await expect(sink(createDerivative(escapedManifest))).resolves.toBeUndefined();

		expect(ledger.list()).toEqual([]);
		ledger.close();
	});

	it("rejects OCR snippets longer than 280 characters", async () => {
		const ledger = new SqliteActivityLedger(":memory:");
		const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "activity-journal-gopk-"));
		const manifestPath = path.join(captureRoot, "clip-1.manifest.json");
		await Bun.write(manifestPath, "{}");
		const sink = createGopkActivitySink({ ledger, consent, policy, capture, captureRoot });

		await sink({ ...createDerivative(manifestPath), ocrSnippet: "x".repeat(281) });

		expect(ledger.list()).toEqual([]);
		ledger.close();
		await fs.rm(captureRoot, { recursive: true, force: true });
	});

	it("deletes raw clips inside the capture root", async () => {
		const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "activity-journal-gopk-"));
		const clipPath = path.join(captureRoot, "clip.webm");
		await Bun.write(clipPath, "raw clip");

		await createConstrainedRawClipRemover(captureRoot).remove(clipPath);

		expect(await Bun.file(clipPath).exists()).toBe(false);
		await fs.rm(captureRoot, { recursive: true, force: true });
	});

	it("refuses to delete files outside the capture root", async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "activity-journal-gopk-"));
		const captureRoot = path.join(tempRoot, "captures");
		const outsidePath = path.join(tempRoot, "outside.webm");
		await fs.mkdir(captureRoot);
		await Bun.write(outsidePath, "outside");

		await expect(createConstrainedRawClipRemover(captureRoot).remove(outsidePath)).rejects.toThrow(
			"raw clip path escapes capture root",
		);

		expect(await Bun.file(outsidePath).text()).toBe("outside");
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it("rejects derivatives without a sanitized attestation", async () => {
		const ledger = new SqliteActivityLedger(":memory:");
		const captureRoot = path.resolve("C:\\captures");
		const sink = createGopkActivitySink({ ledger, consent, policy, capture, captureRoot });
		const derivative = createDerivative(path.join(captureRoot, "clip-1.manifest.json"));

		await sink({
			...derivative,
			sanitizationAttestation: { ...derivative.sanitizationAttestation, status: "unsanitized" as never },
		});

		expect(ledger.list()).toEqual([]);
		ledger.close();
	});

	it("junction inside captureRoot cannot delete outside file", async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "activity-journal-gopk-junction-"));
		const captureRoot = path.join(tempRoot, "captures");
		const outsideRoot = path.join(tempRoot, "outside");
		const junctionPath = path.join(captureRoot, "junction");
		const outsidePath = path.join(outsideRoot, "victim.webm");
		await fs.mkdir(captureRoot);
		await fs.mkdir(outsideRoot);
		await Bun.write(outsidePath, "outside");
		await fs.symlink(outsideRoot, junctionPath, "junction");

		await expect(
			createConstrainedRawClipRemover(captureRoot).remove(path.join(junctionPath, "victim.webm")),
		).rejects.toThrow("raw clip path escapes capture root");

		expect(await Bun.file(outsidePath).text()).toBe("outside");
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it("two sessions with same clipId produce two records", async () => {
		const ledger = new SqliteActivityLedger(":memory:");
		const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "activity-journal-gopk-"));
		const manifestPath = path.join(captureRoot, "clip-1.manifest.json");
		await Bun.write(manifestPath, "{}");
		const captureA = { ...capture, sessionId: "session-a" };
		const captureB = { ...capture, sessionId: "session-b" };
		const sinkA = createGopkActivitySink({ ledger, consent, policy, capture: captureA, captureRoot });
		const sinkB = createGopkActivitySink({ ledger, consent, policy, capture: captureB, captureRoot });

		await sinkA({ ...createDerivative(manifestPath), sessionId: "session-a" });
		await sinkB({ ...createDerivative(manifestPath), sessionId: "session-b" });

		expect(ledger.list().map(record => record.id)).toEqual([
			"gopk_clips:session-a:clip-1",
			"gopk_clips:session-b:clip-1",
		]);
		ledger.close();
		await fs.rm(captureRoot, { recursive: true, force: true });
	});

	it("sink rejects session mismatch", async () => {
		const ledger = new SqliteActivityLedger(":memory:");
		const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "activity-journal-gopk-"));
		const manifestPath = path.join(captureRoot, "clip-1.manifest.json");
		await Bun.write(manifestPath, "{}");
		const sink = createGopkActivitySink({ ledger, consent, policy, capture, captureRoot });

		await sink({ ...createDerivative(manifestPath), sessionId: "other-session" });

		expect(ledger.list()).toEqual([]);
		ledger.close();
		await fs.rm(captureRoot, { recursive: true, force: true });
	});

	it("sink deletes rejected raw clips", async () => {
		const ledger = new SqliteActivityLedger(":memory:");
		const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "activity-journal-gopk-"));
		const manifestPath = path.join(captureRoot, "clip-1.manifest.json");
		const rawClipPath = path.join(captureRoot, "clip-1.webm");
		await Bun.write(manifestPath, "{}");
		await Bun.write(rawClipPath, "raw clip");
		const sink = createGopkActivitySink({
			ledger,
			consent,
			policy: { ...policy, enabled: false },
			capture,
			captureRoot,
		});

		await sink({
			...createDerivative(manifestPath),
			rawClip: { localPointer: rawClipPath, expiresAt: "2026-07-13T14:05:30.000Z" },
		});

		expect(await Bun.file(rawClipPath).exists()).toBe(false);
		ledger.close();
		await fs.rm(captureRoot, { recursive: true, force: true });
	});

	it("non-canonical timestamps are canonicalized", async () => {
		const ledger = new SqliteActivityLedger(":memory:");
		const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "activity-journal-gopk-"));
		const manifestPath = path.join(captureRoot, "clip-1.manifest.json");
		const rawClipPath = path.join(captureRoot, "clip-1.webm");
		await Bun.write(manifestPath, "{}");
		await Bun.write(rawClipPath, "raw clip");
		const sink = createGopkActivitySink({ ledger, consent, policy, capture, captureRoot });
		const derivative = createDerivative(manifestPath);

		await sink({
			...derivative,
			window: {
				startedAt: "Mon, 13 Jul 2026 14:00:00 GMT",
				endedAt: "Mon, 13 Jul 2026 14:05:00 GMT",
			},
			sanitizationAttestation: {
				...derivative.sanitizationAttestation,
				completedAt: "Mon, 13 Jul 2026 14:05:10 GMT",
			},
			rawClip: { localPointer: rawClipPath, expiresAt: "Mon, 13 Jul 2026 14:05:30 GMT" },
		});

		expect(ledger.list()[0]).toMatchObject({
			window: {
				startedAt: "2026-07-13T14:00:00.000Z",
				endedAt: "2026-07-13T14:05:00.000Z",
			},
			rawClip: { expiresAt: "2026-07-13T14:05:30.000Z" },
		});
		ledger.close();
		await fs.rm(captureRoot, { recursive: true, force: true });
	});

	it("sink rejects invalid timestamps", async () => {
		const ledger = new SqliteActivityLedger(":memory:");
		const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "activity-journal-gopk-"));
		const manifestPath = path.join(captureRoot, "clip-1.manifest.json");
		await Bun.write(manifestPath, "{}");
		const sink = createGopkActivitySink({ ledger, consent, policy, capture, captureRoot });
		const derivative = createDerivative(manifestPath);

		await sink({
			...derivative,
			sanitizationAttestation: { ...derivative.sanitizationAttestation, completedAt: "not-a-date" },
		});

		expect(ledger.list()).toEqual([]);
		ledger.close();
		await fs.rm(captureRoot, { recursive: true, force: true });
	});
});
