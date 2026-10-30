import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BeamMemory } from "@oh-my-pi/pi-mnemopi/core/beam";
import {
	computeSha256,
	isDataUri,
	looksLikeBase64Blob,
	parseDataUri,
	sanitizeContent,
	scrubLiveCredentials,
	shannonEntropy,
	storeBlob,
	stripInjectedMemoryTags,
} from "@oh-my-pi/pi-mnemopi/core/content-sanitizer";

const ORIGINAL_BLOB_DIR = process.env.MNEMOPI_BLOB_DIR;

afterEach(() => {
	if (ORIGINAL_BLOB_DIR === undefined) {
		delete process.env.MNEMOPI_BLOB_DIR;
	} else {
		process.env.MNEMOPI_BLOB_DIR = ORIGINAL_BLOB_DIR;
	}
});

function useTempBlobDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "mnemopi-blobs-"));
	process.env.MNEMOPI_BLOB_DIR = join(dir, "blobs");
	return process.env.MNEMOPI_BLOB_DIR;
}

describe("content sanitizer data URI parsing", () => {
	it("detects data URI prefixes only", () => {
		expect(isDataUri("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
		expect(isDataUri("data:text/plain;base64,SGVsbG8=")).toBe(true);
		expect(isDataUri("Hello world")).toBe(false);
		expect(isDataUri("just some text")).toBe(false);
	});

	it("parses base64 data URIs with explicit and default mime types", () => {
		const pngDot = Buffer.from(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])).toString("base64");
		expect(parseDataUri(`data:image/png;base64,${pngDot}`)).toEqual([
			"image/png",
			Buffer.from(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
		]);
		expect(parseDataUri("data:;base64,SGVsbG8=")).toEqual(["application/octet-stream", Buffer.from("Hello")]);
	});

	it("rejects invalid base64 and missing schemes", () => {
		expect(parseDataUri("data:image/png;base64,!!!not-valid!!!")).toBeNull();
		expect(parseDataUri("just text")).toBeNull();
	});
});

describe("content sanitizer entropy heuristic", () => {
	it("separates uniform random-looking text from prose and repeated characters", () => {
		const uniform = "abcdefghijklmnopqrstuvwxyz0123456789+/ABCDEFGHIJKLMNOPQRSTUVWXYZ".repeat(2000);
		const prose = "hello world this is normal english text with common letters and patterns ".repeat(1000);
		const repeated = "aaaaa".repeat(10000);

		expect(shannonEntropy(uniform)).toBeGreaterThan(5.5);
		expect(shannonEntropy(prose)).toBeLessThan(5.0);
		expect(shannonEntropy(repeated)).toBeLessThan(0.1);
		expect(shannonEntropy("")).toBe(0.0);
	});

	it("flags large high-entropy base64-like payloads only", () => {
		const raw = Buffer.allocUnsafe(150_000);
		for (let i = 0; i < raw.length; i += 1) raw[i] = i & 0xff;
		const b64 = raw.toString("base64");
		const code = "def foo():\n    return 42\n".repeat(20000);

		expect(looksLikeBase64Blob(b64)).toBe(true);
		expect(looksLikeBase64Blob(code)).toBe(false);
	});
});

describe("content sanitizer blob storage", () => {
	it("stores blobs by sha256 and is idempotent", () => {
		const blobRoot = useTempBlobDir();
		const data = Buffer.from("binary blob content for testing");
		const sha = storeBlob(data);
		const path = join(blobRoot, sha.slice(0, 2), sha.slice(0, 4), sha);
		const mtime = statSync(path).mtimeMs;

		expect(sha).toHaveLength(64);
		expect(computeSha256(data)).toBe(sha);
		expect(readFileSync(path)).toEqual(data);
		expect(storeBlob(data)).toBe(sha);
		expect(statSync(path).mtimeMs).toBe(mtime);
	});
});

describe("sanitize_content", () => {
	it("extracts data URIs with metadata", () => {
		useTempBlobDir();
		const raw = Buffer.from("\x89PNG header fake binary data for test", "binary");
		const result = sanitizeContent(`data:image/png;base64,${raw.toString("base64")}`);

		expect(result[0]).toContain("Binary content extracted");
		expect(result[0]).toContain("blob://sha256/");
		expect(result[1].extraction_reason).toBe("data_uri");
		expect(result[1].mime).toBe("image/png");
		expect(result[1].original_size).toBe(raw.length);
	});

	it("extracts content above the hard cap", () => {
		useTempBlobDir();
		const [sanitized, meta] = sanitizeContent("x".repeat(1_000_001));
		expect(sanitized).toContain("Large content extracted");
		expect(meta.extraction_reason).toBe("size_cap");
	});

	it("extracts high-entropy payloads but leaves large prose untouched", () => {
		useTempBlobDir();
		const raw = Buffer.allocUnsafe(150_000);
		for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 31) & 0xff;
		const highEntropy = raw.toString("base64");
		const prose =
			"This is a normal paragraph of English text. It discusses various topics in a conversational tone. ".repeat(
				3000,
			);

		const [sanitized, meta] = sanitizeContent(highEntropy);
		expect(sanitized).toContain("Encoded content extracted");
		expect(meta.extraction_reason).toBe("high_entropy");
		expect(meta.entropy).toBeGreaterThan(5.0);
		expect(sanitizeContent(prose)).toEqual([prose, {}]);
	});
});

describe("sanitizeContent tag stripping and credential scrubbing", () => {
	it("strips injected prompt, harness (system-*, irc), and memory tags", () => {
		const text = `
Header text
<system-reminder>
Sensitive injected prompt details
</system-reminder>
<system-notice>
Internal harness notice
</system-notice>
<system-injection>
Injected block
</system-injection>
<irc from="parent">
Parent steering message
</irc>

Middle content
<memories>
Recalled memory block
</memories>

<private>
User secret notes
</private>
Tail content
`;
		const { content, stripped } = stripInjectedMemoryTags(text);
		expect(stripped).toBe(true);
		expect(content).not.toContain("<system-reminder>");
		expect(content).not.toContain("<system-notice>");
		expect(content).not.toContain("<system-injection>");
		expect(content).not.toContain("<irc");
		expect(content).not.toContain("Sensitive injected prompt details");
		expect(content).not.toContain("<memories>");
		expect(content).not.toContain("<private>");
		expect(content).toContain("Header text");
		expect(content).toContain("Middle content");
		expect(content).toContain("Tail content");

		const [sanitized, meta] = sanitizeContent(text);
		expect(meta.stripped_tags).toBe(true);
		expect(sanitized).toBe(content);
	});

	it("scrubs live credentials and tracks matched types", () => {
		const pemHeader = `-----BEGIN ${"RSA PRIVATE"} KEY-----`;
		const pemFooter = `-----END ${"RSA PRIVATE"} KEY-----`;
		const pemKey = `${pemHeader}\nMIIEowIBAAKCAQEA0Y1+exampleFakeKeyMaterialForTestingOnly...\n${pemFooter}`;
		const sample = [
			pemKey,
			`API key: ${"sk-proj"}-1234567890abcdefghijklmnopqrstuvwxyz`,
			`GitHub: ${"ghp"}_1234567890abcdefghijklmnopqrstuvwxyz1234`,
			`NPM: ${"npm"}_a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuVwXy`,
			`Google: ${"AIzaSy"}A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q`,
			`AWS: ${"ASIA"}1234567890ABCDEF`,
			`Slack: ${"xox" + "b"}-12345678-abcdefghijklmnop`,
			`GitLab: ${"glpat"}-1234567890abcdefghij`,
			`Auth: Authorization: Bearer ${"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"}`,
			`DB: https://admin:${"s3cr3tPass"}@db.internal:5432/app`,
			`Keyword: secret_aB3dEfGh1JkLmN0pQ`,
		].join("\n");

		const { content, matchedTypes } = scrubLiveCredentials(sample);
		expect(matchedTypes).toEqual([
			"pem_private_key",
			"openai_anthropic_key",
			"github_pat",
			"npm_token",
			"google_api_key",
			"aws_access_key",
			"slack_or_gitlab_token",
			"auth_bearer_basic",
			"basic_auth_url",
			"keyword_secret",
		]);
		expect(content).toContain("[REDACTED]");
		expect(content).toContain("API key: [REDACTED]");
		expect(content).toContain("GitHub: [REDACTED]");
		expect(content).toContain("NPM: [REDACTED]");
		expect(content).toContain("Google: [REDACTED]");
		expect(content).toContain("AWS: [REDACTED]");
		expect(content).toContain("Slack: [REDACTED]");
		expect(content).toContain("GitLab: [REDACTED]");
		expect(content).toContain("Auth: Authorization: Bearer [REDACTED]");
		expect(content).toContain("DB: https://admin:[REDACTED]@db.internal:5432/app");
		expect(content).toContain("Keyword: [REDACTED]");

		const [sanitized, meta] = sanitizeContent(sample);
		expect(meta.redacted_secrets).toEqual(matchedTypes);
		expect(sanitized).toBe(content);
	});

	it("preserves benign text, URLs, and documentation placeholders", () => {
		const benign = [
			"Documentation placeholder: AWS_KEY_EXAMPLE_PLACEHOLDER",
			"Example OpenAI key: sk-placeholder",
			"Config template: API_KEY=YOUR_API_KEY_HERE",
			"Public website: https://example.com/api/v1/resource",
			"Regular text discussing authentication patterns.",
		].join("\n");

		const { content: strippedText, stripped } = stripInjectedMemoryTags(benign);
		expect(stripped).toBe(false);
		expect(strippedText).toBe(benign);

		const { content: scrubbedText, matchedTypes } = scrubLiveCredentials(benign);
		expect(matchedTypes).toHaveLength(0);
		expect(scrubbedText).toBe(benign);

		const [sanitized, meta] = sanitizeContent(benign);
		expect(sanitized).toBe(benign);
		expect(meta).toEqual({});
	});

	it("strips deeply nested injected memory tags in linear time", () => {
		const depth = 4000;
		const deeplyNested = `${"Before "}${"<private>".repeat(depth)}secret${"</private>".repeat(depth)}${" After"}`;
		const startMs = performance.now();
		const deepRes = stripInjectedMemoryTags(deeplyNested);
		const elapsedMs = performance.now() - startMs;
		expect(deepRes.stripped).toBe(true);
		expect(deepRes.content).toBe("Before  After");
		expect(elapsedMs).toBeLessThan(250);
	});

	it("strips interleaved and nested tags with truncated tails", () => {
		const nested =
			"Before\n<private>outer <private>inner</private> leaked</private>\n<system-reminder>truncated tail";
		const strippedRes = stripInjectedMemoryTags(nested);
		expect(strippedRes.stripped).toBe(true);
		expect(strippedRes.content).toBe("Before");
	});

	it("redacts unclosed PEM private key blocks to [REDACTED]", () => {
		const unclosedPem = `Key:\n-----BEGIN ${"ENCRYPTED PRIVATE"} KEY-----\nMIIFDjBABgkqhkiG9w0BBQ0wMzAbBgkqhkiG9w0BBQwwDgQISecretMaterial`;
		const scrubbedPem = scrubLiveCredentials(unclosedPem);
		expect(scrubbedPem.matchedTypes).toEqual(["pem_private_key"]);
		expect(scrubbedPem.content).toBe("Key:\n[REDACTED]");
		expect(scrubbedPem.content).not.toContain("MIIFDj");
	});

	it("scrubs text data URIs before writing blob bytes to disk", () => {
		const blobRoot = useTempBlobDir();
		const textDataPayload =
			"Header\n<private>hidden note</private>\nAuthorization: Bearer sampleLongCredential123456789";
		const textDataUri = `data:text/plain;base64,${Buffer.from(textDataPayload, "utf8").toString("base64")}`;
		const [, dataUriMeta] = sanitizeContent(textDataUri);
		expect(dataUriMeta.extraction_reason).toBe("data_uri");
		expect(dataUriMeta.stripped_tags).toBe(true);
		expect(dataUriMeta.redacted_secrets).toEqual(["auth_bearer_basic"]);
		const dataUriSha = (dataUriMeta.blob_ref ?? "").replace("blob://sha256/", "");
		const dataUriBlobBytes = readFileSync(
			join(blobRoot, dataUriSha.slice(0, 2), dataUriSha.slice(0, 4), dataUriSha),
			"utf8",
		);
		expect(dataUriBlobBytes).not.toContain("hidden note");
		expect(dataUriBlobBytes).not.toContain("sampleLongCredential123456789");
		expect(dataUriBlobBytes).toContain("Authorization: Bearer [REDACTED]");
	});

	it("scrubs oversized payloads before writing blob bytes to disk", () => {
		const blobRoot = useTempBlobDir();
		const oversizedPayload = `<system-notice>internal</system-notice>\nAuthorization: Bearer sampleLongCredential123456789\n${"x".repeat(1_000_010)}`;
		const [, capMeta] = sanitizeContent(oversizedPayload);
		expect(capMeta.extraction_reason).toBe("size_cap");
		expect(capMeta.stripped_tags).toBe(true);
		expect(capMeta.redacted_secrets).toEqual(["auth_bearer_basic"]);
		const capSha = (capMeta.blob_ref ?? "").replace("blob://sha256/", "");
		const capBlobBytes = readFileSync(join(blobRoot, capSha.slice(0, 2), capSha.slice(0, 4), capSha), "utf8");
		expect(capBlobBytes).not.toContain("internal");
		expect(capBlobBytes).not.toContain("sampleLongCredential123456789");
		expect(capBlobBytes).toContain("Authorization: Bearer [REDACTED]");
	});

	it("completes 16,000 open tags followed by 16,000 unmatched closers in under 50ms", () => {
		const count = 16000;
		const payload = "<private>".repeat(count) + "</system-notice>".repeat(count);
		const start = performance.now();
		const res = stripInjectedMemoryTags(payload);
		const elapsed = performance.now() - start;
		expect(res.stripped).toBe(true);
		expect(res.content).toBe("");
		expect(elapsed).toBeLessThan(50);
	});

	it("preserves prefix text before a truncated closing tag", () => {
		const res = stripInjectedMemoryTags("keep this </private");
		expect(res.stripped).toBe(true);
		expect(res.content).toBe("keep this");
	});

	it("sanitizes memory writes via BeamMemory.remember", () => {
		const beam = new BeamMemory({ dbPath: ":memory:", sessionId: "sanitize-remember-test" });
		try {
			const id = beam.remember(
				"Keep this\n<private>injected note</private>\nAuthorization: Bearer sampleLongCredential123456789",
			);
			const stored = beam.get(id) as { content: string } | null;
			expect(stored?.content).toBe("Keep this\n\nAuthorization: Bearer [REDACTED]");
			expect(stored?.content).not.toContain("injected note");
			expect(stored?.content).not.toContain("sampleLongCredential123456789");
		} finally {
			beam.close();
		}
	});

	it("sanitizes memory writes via BeamMemory.rememberBatch", () => {
		const beam = new BeamMemory({ dbPath: ":memory:", sessionId: "sanitize-batch-test" });
		try {
			const [batchId] = beam.rememberBatch([
				{
					content: "Batch item\n<system-notice>harness block</system-notice>\nsecret_aB3dEfGh1JkLmN0pQ",
				},
			]);
			const batchStored = beam.get(batchId!) as { content: string } | null;
			expect(batchStored?.content).toBe("Batch item\n\n[REDACTED]");
		} finally {
			beam.close();
		}
	});

	it("sanitizes memory writes via BeamMemory.updateWorking", () => {
		const beam = new BeamMemory({ dbPath: ":memory:", sessionId: "sanitize-update-test" });
		try {
			const id = beam.remember("Initial safe content");
			beam.updateWorking(
				id,
				"Updated\n<memories>recalled</memories>\nAuthorization: Bearer anotherLongSecretToken987654",
			);
			const updatedStored = beam.get(id) as { content: string } | null;
			expect(updatedStored?.content).toBe("Updated\n\nAuthorization: Bearer [REDACTED]");
		} finally {
			beam.close();
		}
	});

	it("completes stripping 150 KB of repeated truncated opening tags in under 50ms", () => {
		const payload = "<private ".repeat(18000);
		const start = performance.now();
		const res = stripInjectedMemoryTags(payload);
		const duration = performance.now() - start;
		expect(res.stripped).toBe(true);
		expect(res.content).toBe("");
		expect(duration).toBeLessThan(50);
	});

	it("completes redacting 180 KB of repeated unterminated PEM headers in under 50ms", () => {
		const payload = "-----BEGIN PRIVATE KEY-----!\n".repeat(6000);
		const start = performance.now();
		const res = scrubLiveCredentials(payload);
		const duration = performance.now() - start;
		expect(res.matchedTypes).toContain("pem_private_key");
		expect(res.content).not.toContain("BEGIN PRIVATE KEY");
		expect(duration).toBeLessThan(50);
	});

	it("scrubs live credentials from textual data URIs containing NUL bytes before writing blob to disk", () => {
		const blobRoot = useTempBlobDir();
		const textWithNul = "pre\x00mid\nAuthorization: Bearer secretToken123456789\x00post";
		const uri = `data:text/plain;base64,${Buffer.from(textWithNul, "utf8").toString("base64")}`;
		const [, meta] = sanitizeContent(uri);
		expect(meta.extraction_reason).toBe("data_uri");
		expect(meta.redacted_secrets).toContain("auth_bearer_basic");
		const sha = (meta.blob_ref ?? "").replace("blob://sha256/", "");
		const blobPath = join(blobRoot, sha.slice(0, 2), sha.slice(0, 4), sha);
		const blobContent = readFileSync(blobPath, "utf8");
		expect(blobContent).not.toContain("secretToken123456789");
		expect(blobContent).toContain("Authorization: Bearer [REDACTED]");
	});

	it("sanitizes source and metadata fields when importing from dictionary", () => {
		const beam = new BeamMemory({ dbPath: ":memory:", sessionId: "import-sanitize-test" });
		try {
			beam.importFromDict({
				working_memory: [
					{
						id: "wm-imported-1",
						content: "Imported working content",
						source: "src-<private>hidden</private>-Authorization: Bearer secretToken123456789",
						metadata_json: JSON.stringify({
							note: "note-<system-reminder>bad</system-reminder>-Authorization: Bearer secretToken987654321",
							nested: {
								apiKey: "sk-live-123456789012345678901234",
							},
						}),
					},
				],
				episodic_memory: [
					{
						id: "ep-imported-1",
						session_id: "import-sanitize-test",
						content: "Imported episodic content",
						source: "ep-src-<private>hidden</private>-Authorization: Bearer secretToken123456789",
						metadata_json: JSON.stringify({
							client_secret: "secret_abc123def456ghi789jkl012",
						}),
					},
				],
			});

			const wm = beam.get("wm-imported-1") as { source: string; metadata: string } | null;
			expect(wm?.source).toBe("src--Authorization: Bearer [REDACTED]");
			expect(wm?.source).not.toContain("secretToken123456789");
			const wmMeta = JSON.parse(wm?.metadata ?? "{}");
			expect(wmMeta.note).toBe("note--Authorization: Bearer [REDACTED]");
			expect(wmMeta.note).not.toContain("bad");
			expect(wmMeta.note).not.toContain("secretToken987654321");
			expect(wmMeta.nested.apiKey).toBe("[REDACTED]");

			const ep = beam.get("ep-imported-1") as { source: string; metadata: string } | null;
			expect(ep?.source).toBe("ep-src--Authorization: Bearer [REDACTED]");
			const epMeta = JSON.parse(ep?.metadata ?? "{}");
			expect(epMeta.client_secret).toBe("[REDACTED]");
		} finally {
			beam.close();
		}
	});

	it("does not create blob files when updateWorking targets a nonexistent ID", () => {
		const blobRoot = useTempBlobDir();
		const beam = new BeamMemory({ dbPath: ":memory:", sessionId: "update-working-noop" });
		try {
			const oversizedContent = "A".repeat(1_000_050);
			const updated = beam.updateWorking("nonexistent-wm-id", oversizedContent);
			expect(updated).toBe(false);
			expect(existsSync(blobRoot)).toBe(false);
		} finally {
			beam.close();
		}
	});

	it("sanitizes consolidation source containing prompt tags and credentials in consolidateToEpisodic", () => {
		const beam = new BeamMemory({ dbPath: ":memory:", sessionId: "consolidate-source-test" });
		try {
			const wmId = beam.remember("Source working memory item");
			const episodicId = beam.consolidateToEpisodic(
				"Consolidated episodic summary",
				[wmId],
				"source-<memories>injected</memories>-Authorization: Bearer secretToken123456789",
			);
			const stored = beam.get(episodicId) as { source: string } | null;
			expect(stored?.source).toBe("source--Authorization: Bearer [REDACTED]");
			expect(stored?.source).not.toContain("injected");
			expect(stored?.source).not.toContain("secretToken123456789");
		} finally {
			beam.close();
		}
	});

	it("sanitizes standalone metadata dictionary containing both a metadata key and sibling secrets in importFromDict", () => {
		const beam = new BeamMemory({ dbPath: ":memory:", sessionId: "import-meta-sibling-test" });
		try {
			beam.importFromDict({
				working_memory: [
					{
						id: "wm-sibling-meta-1",
						content: "Imported content",
						metadata_json: JSON.stringify({
							metadata: {
								nestedTag: "<private>strip-this</private>nested value",
							},
							apiKey: "sk-live-123456789012345678901234",
							clientSecret: "secret_12345678901234567890",
						}),
					},
				],
			});

			const wm = beam.get("wm-sibling-meta-1") as { metadata: string } | null;
			const parsed = JSON.parse(wm?.metadata ?? "{}");
			expect(parsed.metadata.nestedTag).toBe("nested value");
			expect(parsed.apiKey).toBe("[REDACTED]");
			expect(parsed.clientSecret).toBe("[REDACTED]");
		} finally {
			beam.close();
		}
	});

	it("preserves suffix text after self-closing injected wrapper tags", () => {
		const [cleaned, meta] = sanitizeContent("keep <private/> tail and <system-reminder /> end");
		expect(meta.stripped_tags).toBe(true);
		expect(cleaned).toBe("keep  tail and  end");
	});

	it("preserves binary application/pdf data URI bytes without UTF-8 re-encoding", () => {
		const blobRoot = useTempBlobDir();
		const pdfBytes = Buffer.from(
			"%PDF-1.7\n1 0 obj\n<< /Author (Authorization: Bearer sampleLongCredential123456789) >>\nendobj\n\x80\xff",
			"latin1",
		);
		const uri = `data:application/pdf;base64,${pdfBytes.toString("base64")}`;
		const [, meta] = sanitizeContent(uri);
		expect(meta.extraction_reason).toBe("data_uri");
		expect(meta.redacted_secrets).toBeUndefined();
		const sha = (meta.blob_ref ?? "").replace("blob://sha256/", "");
		const stored = readFileSync(join(blobRoot, sha.slice(0, 2), sha.slice(0, 4), sha));
		expect(Buffer.compare(stored, pdfBytes)).toBe(0);
	});

	it("does not write blob files when updateWorking targets a cross-session memory ID in a shared database", () => {
		const blobRoot = useTempBlobDir();
		const dbDir = mkdtempSync(join(tmpdir(), "mnemopi-shared-db-"));
		const sharedDbPath = join(dbDir, "shared.db");
		const beamSession1 = new BeamMemory({ dbPath: sharedDbPath, sessionId: "session-1" });
		const beamSession2 = new BeamMemory({ dbPath: sharedDbPath, sessionId: "session-2" });
		try {
			const id = beamSession1.remember("Session 1 item");
			const oversizedContent = "A".repeat(1_000_050);
			const updated = beamSession2.updateWorking(id, oversizedContent);
			expect(updated).toBe(false);
			expect(existsSync(blobRoot)).toBe(false);
		} finally {
			beamSession1.close();
			beamSession2.close();
			rmSync(dbDir, { recursive: true, force: true });
		}
	});
});
