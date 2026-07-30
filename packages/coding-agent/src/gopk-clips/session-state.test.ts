import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteActivityLedger } from "@pk-nerdsaver-ai/pi-activity-journal";
import { createGopkClipsHost, type GopkClipsHostState, parseDerivative } from "./session-state";

// The host's job is drain-validate-ingest-delete plus retention, so these tests
// drive it against a real temp capture root and a real on-disk ledger, then
// read journal rows and the filesystem back to prove consumption semantics:
// good files ingested and removed, bad files quarantined, replays deduped, and
// expired raw clips purged.

const quiet = { warn() {}, info() {} };

function isoAt(offsetMs: number): string {
	return new Date(Date.now() + offsetMs).toISOString();
}

describe("gopk-clips handoff host", () => {
	let captureRoot: string;
	let handoffDir: string;
	let ledgerPath: string;
	let host: GopkClipsHostState | undefined;

	beforeEach(async () => {
		captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gopk-host-"));
		handoffDir = path.join(captureRoot, "journal-handoff");
		ledgerPath = path.join(captureRoot, "test-ledger.sqlite");
		await fs.mkdir(handoffDir, { recursive: true });
	});

	afterEach(async () => {
		await host?.dispose();
		host = undefined;
		await fs.rm(captureRoot, { recursive: true, force: true });
	});

	function makeHost(
		capturePolicyProvider = (): { enabled: boolean; ocrEnabled: boolean } => ({
			enabled: true,
			ocrEnabled: true,
		}),
	): GopkClipsHostState {
		host = createGopkClipsHost(
			// Hour-long intervals: only the startup pass and explicit *Once calls run.
			{
				captureRoot,
				capturePolicyProvider,
				pollIntervalMs: 3_600_000,
				cleanupIntervalMs: 3_600_000,
				ledgerPath,
			},
			quiet,
		);
		return host;
	}

	/** A shape-valid derivative whose pointers really exist under the capture root. */
	async function writeDerivative(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		const manifestPath = path.join(captureRoot, "manifests", "clip-1.json");
		await fs.mkdir(path.dirname(manifestPath), { recursive: true });
		await fs.writeFile(manifestPath, "{}", "utf8");
		const startedAt = isoAt(-60 * 60_000);
		const endedAt = isoAt(-60 * 60_000 + 30_000);
		const derivative: Record<string, unknown> = {
			clipId: "clip-1",
			sessionId: "capture-session-1",
			window: { startedAt, endedAt },
			appIdentity: { processName: "code" },
			sanitizedDigest: "edited main.rs",
			sanitizationAttestation: { status: "sanitized", completedAt: endedAt, sanitizerVersion: "gopk-sanitizer-v1" },
			clipHash: "hash-1",
			localManifestPointer: manifestPath,
			...overrides,
		};
		await fs.writeFile(path.join(handoffDir, "clip-1.json"), JSON.stringify(derivative), "utf8");
		return derivative;
	}

	it("ingests a valid derivative, attributes it to the capture session, and consumes the file", async () => {
		await writeDerivative({ ocrSnippet: "edited main.rs" });
		const state = makeHost();
		await state.pollOnce();

		const inspector = new SqliteActivityLedger(ledgerPath);
		const rows = inspector.list();
		inspector.close();
		expect(rows.length).toBe(1);
		expect(rows[0]?.sourceEventId).toBe("capture-session-1:clip-1");
		expect(rows[0]?.ocrSnippet).toBe("edited main.rs");
		expect(await fs.readdir(handoffDir)).toEqual([]);
	});

	it("rechecks current consent and consumes queued OCR without persistence after revocation", async () => {
		await writeDerivative({ ocrSnippet: "must not persist after revocation" });
		let capturePolicy = { enabled: true, ocrEnabled: true };
		const state = makeHost(() => capturePolicy);

		// Revocation happens after host creation but synchronously before its
		// scheduled startup pass can consume the already-queued derivative.
		capturePolicy = { enabled: true, ocrEnabled: false };
		await state.pollOnce();

		const inspector = new SqliteActivityLedger(ledgerPath);
		expect(inspector.list()).toEqual([]);
		inspector.close();
		expect(await fs.readdir(handoffDir)).toEqual([]);
	});

	it("dedupes a replayed handoff file instead of double-recording", async () => {
		await writeDerivative();
		const state = makeHost();
		await state.pollOnce();
		await writeDerivative(); // same clip re-delivered after a "crash"
		await state.pollOnce();

		const inspector = new SqliteActivityLedger(ledgerPath);
		expect(inspector.list().length).toBe(1);
		inspector.close();
	});

	it("replaces unparseable and shape-invalid files with scrubbed diagnostics", async () => {
		await fs.writeFile(path.join(handoffDir, "garbage.json"), "not json", "utf8");
		await fs.writeFile(path.join(handoffDir, "empty.json"), "{}", "utf8");
		const state = makeHost();
		await state.pollOnce();

		const entries = (await fs.readdir(handoffDir)).sort();
		expect(entries).toEqual(["empty.json.rejected", "garbage.json.rejected"]);
		for (const entry of entries) {
			const diagnostic = await fs.readFile(path.join(handoffDir, entry), "utf8");
			expect(diagnostic).toContain('"reason":"invalid handoff"');
			expect(diagnostic).not.toContain("not json");
		}
		const inspector = new SqliteActivityLedger(ledgerPath);
		expect(inspector.list().length).toBe(0);
		inspector.close();
	});

	it("consumes but does not record a derivative the sink rejects (denied application)", async () => {
		await writeDerivative({ appIdentity: { processName: "1password" } });
		const state = makeHost();
		await state.pollOnce();

		const inspector = new SqliteActivityLedger(ledgerPath);
		expect(inspector.list().length).toBe(0);
		inspector.close();
		expect(await fs.readdir(handoffDir)).toEqual([]);
	});

	it("purges an expired raw clip on the retention pass", async () => {
		const rawPath = path.join(captureRoot, "raw", "clip-1.webm");
		await fs.mkdir(path.dirname(rawPath), { recursive: true });
		await fs.writeFile(rawPath, "raw-bytes", "utf8");
		// Expires 5 minutes after the (hour-old) window — within the 10-minute
		// retention policy, and already in the past.
		const state = makeHost();
		await state.pollOnce(); // finish the empty startup poll and cleanup
		await writeDerivative({ rawClip: { localPointer: rawPath, expiresAt: isoAt(-55 * 60_000) } });
		await state.pollOnce();
		expect(await fs.exists(rawPath)).toBe(true);
		await state.cleanupOnce();

		expect(await fs.exists(rawPath)).toBe(false);
		const inspector = new SqliteActivityLedger(ledgerPath);
		const rows = inspector.list();
		inspector.close();
		expect(rows.length).toBe(1); // evidence row survives; only raw media is purged
	});
});

describe("parseDerivative", () => {
	it("rejects attestation statuses other than 'sanitized'", () => {
		expect(
			parseDerivative(
				JSON.stringify({
					clipId: "c",
					sessionId: "s",
					window: { startedAt: "a", endedAt: "b" },
					appIdentity: { processName: "code" },
					sanitizedDigest: "",
					sanitizationAttestation: { status: "pending", completedAt: "t", sanitizerVersion: "v" },
					clipHash: "h",
					localManifestPointer: "/x",
				}),
			),
		).toBeUndefined();
	});

	it("accepts old handoffs without an OCR snippet", () => {
		const derivative = parseDerivative(
			JSON.stringify({
				clipId: "c",
				sessionId: "s",
				window: { startedAt: "a", endedAt: "b" },
				appIdentity: { processName: "code" },
				sanitizedDigest: "",
				sanitizationAttestation: { status: "sanitized", completedAt: "t", sanitizerVersion: "v" },
				clipHash: "h",
				localManifestPointer: "/x",
			}),
		);
		expect(derivative).toBeDefined();
		expect(derivative?.ocrSnippet).toBeUndefined();
	});

	it("accepts a non-empty OCR snippet at the 280-character limit", () => {
		const ocrSnippet = "x".repeat(280);
		const derivative = parseDerivative(
			JSON.stringify({
				clipId: "c",
				sessionId: "s",
				window: { startedAt: "a", endedAt: "b" },
				appIdentity: { processName: "code" },
				sanitizedDigest: "",
				ocrSnippet,
				sanitizationAttestation: { status: "sanitized", completedAt: "t", sanitizerVersion: "v" },
				clipHash: "h",
				localManifestPointer: "/x",
			}),
		);
		expect(derivative?.ocrSnippet).toBe(ocrSnippet);
	});

	it.each(["", 123, "x".repeat(281)])(
		"drops invalid optional OCR snippet %# without quarantining the derivative",
		ocrSnippet => {
			const handoff = {
				clipId: "c",
				sessionId: "s",
				window: { startedAt: "a", endedAt: "b" },
				appIdentity: { processName: "code" },
				sanitizedDigest: "",
				ocrSnippet,
				sanitizationAttestation: { status: "sanitized", completedAt: "t", sanitizerVersion: "v" },
				clipHash: "h",
				localManifestPointer: "/x",
			};
			const derivative = parseDerivative(JSON.stringify(handoff));
			expect(derivative).toBeDefined();
			expect(derivative?.ocrSnippet).toBeUndefined();
		},
	);
});
