import { describe, expect, test } from "bun:test";
import type { SessionData } from "../src/export/html";
import {
	buildShareSnapshot,
	normalizeShareServerUrl,
	SERVER_MAX_SEALED_BYTES,
	sealToFit,
	shareSession,
} from "../src/export/share";
import { SecretObfuscator } from "../src/secrets/obfuscator";
import type { SessionEntry } from "../src/session/session-entries";
import type { SessionManager } from "../src/session/session-manager";

const IV_LENGTH = 12;
const TEST_MAX_SEALED_BYTES = 4_000;

async function makeKey(): Promise<CryptoKey> {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Mirror of share-loader.js: AES-GCM open + gunzip + parse. */
async function open(key: CryptoKey, sealed: Uint8Array<ArrayBuffer>): Promise<SessionData> {
	const plain = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: sealed.subarray(0, IV_LENGTH) },
		key,
		sealed.subarray(IV_LENGTH),
	);
	return JSON.parse(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(plain))));
}

function messageEntry(id: string, parentId: string | null, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-06-12T00:00:00.000Z",
		message: { role: "user", content: [{ type: "text", text }] },
	} as unknown as SessionEntry;
}

function sessionData(entries: SessionEntry[], leafId: string): SessionData {
	return {
		header: { type: "session", version: 3, id: "t", timestamp: "2026-06-12T00:00:00.000Z", cwd: "/tmp" },
		entries,
		leafId,
	};
}

/** Incompressible filler so gzip cannot absorb the payload. */
function randomHex(words: number): string {
	return Array.from(crypto.getRandomValues(new Uint32Array(words)), v => v.toString(16)).join("");
}

describe("sealToFit", () => {
	test("round-trips losslessly when under budget", async () => {
		const key = await makeKey();
		const data = sessionData([messageEntry("e1", null, "hello"), messageEntry("e2", "e1", "world")], "e2");

		const { sealed, truncated } = await sealToFit(key, data, SERVER_MAX_SEALED_BYTES);

		expect(truncated).toBe(false);
		expect(await open(key, sealed)).toEqual(data);
	});

	test("trims oversized text into budget without dropping entries", async () => {
		const key = await makeKey();
		const data = sessionData(
			[messageEntry("e1", null, "keep me"), messageEntry("e2", "e1", randomHex(10_000))],
			"e2",
		);

		const { sealed, truncated } = await sealToFit(key, data, TEST_MAX_SEALED_BYTES);

		expect(truncated).toBe(true);
		expect(sealed.byteLength).toBeLessThanOrEqual(TEST_MAX_SEALED_BYTES);
		const opened = await open(key, sealed);
		expect(opened.entries).toHaveLength(2);
		expect(opened.leafId).toBe("e2");
		expect(JSON.stringify(opened)).toContain("keep me");
		expect(JSON.stringify(opened)).toContain("…[truncated for share]");
	});

	test("replaces large inline images with placeholders before trimming text", async () => {
		const key = await makeKey();
		const imageEntry = {
			type: "message",
			id: "img",
			parentId: null,
			timestamp: "2026-06-12T00:00:00.000Z",
			message: {
				role: "user",
				content: [
					{ type: "text", text: "see screenshot" },
					{ type: "image", data: randomHex(2_000), mimeType: "image/png" },
				],
			},
		} as unknown as SessionEntry;
		const data = sessionData([imageEntry], "img");

		const { sealed, truncated } = await sealToFit(key, data, TEST_MAX_SEALED_BYTES);

		expect(truncated).toBe(true);
		const flat = JSON.stringify(await open(key, sealed));
		expect(flat).toContain("[image omitted from share]");
		expect(flat).toContain("see screenshot");
	});
});

describe("buildShareSnapshot", () => {
	test("redacts secrets through the obfuscator and leaves the original untouched", () => {
		const entries = [messageEntry("e1", null, "the token is hunter2-XYZZY, keep safe")];
		const sm = {
			getHeader: () => sessionData([], "x").header,
			getEntries: () => entries,
			getLeafId: () => "e1",
		} as unknown as SessionManager;
		const obfuscator = new SecretObfuscator([{ type: "plain", content: "hunter2-XYZZY" }]);

		const snapshot = buildShareSnapshot(sm, { obfuscator });

		expect(JSON.stringify(snapshot)).not.toContain("hunter2-XYZZY");
		expect(JSON.stringify(snapshot)).toContain("the token is");
		// Source entries must keep the real value; redaction is share-only.
		expect(JSON.stringify(entries)).toContain("hunter2-XYZZY");

		const plain = buildShareSnapshot(sm, {});
		expect(JSON.stringify(plain)).toContain("hunter2-XYZZY");
	});

	test("redacts header cwd, bookmark labels, and file-mention paths", () => {
		const secret = "shareleak-ABCDE";
		const ts = "2026-06-12T00:00:00.000Z";
		const entries: SessionEntry[] = [
			{
				type: "label",
				id: "l1",
				parentId: null,
				timestamp: ts,
				targetId: "e1",
				label: `bookmark ${secret}`,
			} as SessionEntry,
			{
				type: "message",
				id: "e1",
				parentId: null,
				timestamp: ts,
				message: {
					role: "fileMention",
					files: [{ path: `/home/${secret}/.env`, content: `KEY=${secret}` }],
					timestamp: 1,
				},
			} as unknown as SessionEntry,
		];
		const header = {
			type: "session",
			version: 3,
			id: "t",
			timestamp: ts,
			cwd: `/home/${secret}/proj`,
			previousSessionFiles: [`/home/${secret}/old/session.jsonl`],
		};
		const sm = {
			getHeader: () => header,
			getEntries: () => entries,
			getLeafId: () => "e1",
		} as unknown as SessionManager;
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);

		const snapshot = buildShareSnapshot(sm, { obfuscator });
		const flat = JSON.stringify(snapshot);

		// cwd, label, file path, and file content are all redacted...
		expect(flat).not.toContain(secret);
		// ...while surrounding structure (the path shape) survives.
		expect(flat).toContain("/.env");
		// Source entries keep the real values; redaction is share-only.
		expect(JSON.stringify(entries)).toContain(secret);
		expect(JSON.stringify(header)).toContain(secret);
	});

	test("redacts assistant tool calls / error messages and bash meta, and drops provider replay payloads", () => {
		const secret = "asst-secret-ABCDE";
		const replaySentinel = "REPLAY_BLOB_SENTINEL_XYZ";
		const serverToolSentinel = "SERVER_TOOL_ENCRYPTED_SENTINEL_QWE";
		const ts = "2026-06-12T00:00:00.000Z";
		const usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "a1",
				parentId: null,
				timestamp: ts,
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: `answer ${secret}` },
						{
							type: "toolCall",
							id: "c1",
							name: "read",
							arguments: { path: `/x/${secret}` },
							intent: `intent ${secret}`,
							rawBlock: `raw ${secret}`,
						},
						{
							type: "anthropicServerTool",
							block: {
								type: "server_tool_use",
								id: "srvtoolu_1",
								name: "web_search",
								input: { query: `find ${secret}` },
							},
						},
						{
							type: "anthropicServerTool",
							block: {
								type: "web_search_tool_result",
								tool_use_id: "srvtoolu_1",
								content: [{ type: "web_search_result", encrypted_content: serverToolSentinel }],
							},
						},
					],
					api: "test",
					provider: "test",
					model: "test",
					usage,
					stopReason: "toolUse",
					errorMessage: `boom ${secret}`,
					providerPayload: { type: "openaiResponsesHistory", items: [{ note: replaySentinel }] },
					timestamp: 1,
				},
			} as unknown as SessionEntry,
			{
				type: "message",
				id: "b1",
				parentId: "a1",
				timestamp: ts,
				message: {
					role: "bashExecution",
					command: `echo ${secret}`,
					output: `out ${secret}`,
					exitCode: 0,
					cancelled: false,
					truncated: false,
					meta: {
						source: { type: "path", value: `/home/${secret}/log` },
						diagnostics: { summary: `diag ${secret}`, messages: [`msg ${secret}`] },
					},
					timestamp: 2,
				},
			} as unknown as SessionEntry,
		];
		const sm = {
			getHeader: () => sessionData([], "x").header,
			getEntries: () => entries,
			getLeafId: () => "b1",
		} as unknown as SessionManager;
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);

		const flat = JSON.stringify(buildShareSnapshot(sm, { obfuscator }));

		// Every freeform occurrence (text, tool-call args/intent/rawBlock, errorMessage, bash output + meta) is redacted.
		expect(flat).not.toContain(secret);
		// Opaque provider-replay payload is dropped wholesale — the sentinel is NOT a configured secret,
		// so its absence proves the subtree was removed rather than merely obfuscated.
		expect(flat).not.toContain(replaySentinel);
		// Native Anthropic server-tool blocks are opaque provider-replay state: dropped wholesale,
		// so neither the obfuscated query secret nor the encrypted result sentinel can leak.
		expect(flat).not.toContain(serverToolSentinel);
		// Source entries keep the real values; redaction is share-only.
		expect(JSON.stringify(entries)).toContain(secret);
	});

	test("redacts every title-change field before sharing", () => {
		const secret = "share-title-secret";
		const entries: SessionEntry[] = [
			{
				type: "title_change",
				id: "title-1",
				parentId: null,
				timestamp: "2026-06-12T00:00:00.000Z",
				title: `new ${secret}`,
				previousTitle: `old ${secret}`,
				source: "user",
				trigger: `rename ${secret}`,
			} as SessionEntry,
		];
		const sm = {
			getHeader: () => sessionData([], "x").header,
			getEntries: () => entries,
			getLeafId: () => "title-1",
		} as unknown as SessionManager;
		const snapshot = buildShareSnapshot(sm, {
			obfuscator: new SecretObfuscator([{ type: "plain", content: secret }]),
		});

		expect(JSON.stringify(snapshot)).not.toContain(secret);
		expect(JSON.stringify(entries)).toContain(secret);
	});

	test("includes every title-change field in the regex collision pre-scan", () => {
		const plainTitle = "PLAIN_TITLE_SECRET";
		const plainPreviousTitle = "PLAIN_PREVIOUS_TITLE_SECRET";
		const plainTrigger = "PLAIN_TRIGGER_SECRET";
		const friendlyTitle = "TOKTITLEABC";
		const friendlyPreviousTitle = "TOKPREVABC";
		const friendlyTrigger = "TOKTRIGGERABC";
		const entries: SessionEntry[] = [
			{
				type: "title_change",
				id: "title-1",
				parentId: null,
				timestamp: "2026-06-12T00:00:00.000Z",
				title: "tok_title_abc",
				previousTitle: "tok_prev_abc",
				source: "user",
				trigger: "tok_trigger_abc",
			} as SessionEntry,
		];
		const sm = {
			getHeader: () => ({
				...sessionData([], "x").header,
				title: `${plainTitle} ${plainPreviousTitle} ${plainTrigger}`,
			}),
			getEntries: () => entries,
			getLeafId: () => "title-1",
		} as unknown as SessionManager;
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: plainTitle, friendlyName: friendlyTitle },
			{ type: "plain", content: plainPreviousTitle, friendlyName: friendlyPreviousTitle },
			{ type: "plain", content: plainTrigger, friendlyName: friendlyTrigger },
			{ type: "regex", content: "tok_title_[a-z]+" },
			{ type: "regex", content: "tok_prev_[a-z]+" },
			{ type: "regex", content: "tok_trigger_[a-z]+" },
		]);

		const flat = JSON.stringify(buildShareSnapshot(sm, { obfuscator }));

		expect(flat).not.toContain(friendlyTitle);
		expect(flat).not.toContain(friendlyPreviousTitle);
		expect(flat).not.toContain(friendlyTrigger);
	});

	test("collects regex-protected values across the whole snapshot so an earlier field's friendly-name placeholder cannot leak a later field's secret", () => {
		// `buildShareSnapshot` must precompute regex-matched secret values across the ENTIRE
		// snapshot (header + entries) before redacting any single field. Otherwise the header
		// (redacted first) would obfuscate `plainSecret` under its friendly name unaware that
		// `regexSecret` — only present in a LATER bash-output field — sanitizes to the exact
		// same label, and the friendly prefix would leak the regex secret's shape into the share.
		const plainSecret = "OTHERSECRET";
		const friendlyName = "TOKABC123";
		const regexSecret = "tok_abc123";
		const ts = "2026-06-12T00:00:00.000Z";
		const header = {
			type: "session",
			version: 3,
			id: "t",
			timestamp: ts,
			cwd: "/tmp",
			title: `investigating ${plainSecret}`,
		};
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "b1",
				parentId: null,
				timestamp: ts,
				message: {
					role: "bashExecution",
					command: "cat token.txt",
					output: `token is ${regexSecret}`,
					exitCode: 0,
					cancelled: false,
					truncated: false,
					timestamp: 1,
				},
			} as unknown as SessionEntry,
		];
		const sm = {
			getHeader: () => header,
			getEntries: () => entries,
			getLeafId: () => "b1",
		} as unknown as SessionManager;
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: plainSecret, friendlyName },
			{ type: "regex", content: "tok_[a-z0-9]+" },
		]);

		const flat = JSON.stringify(buildShareSnapshot(sm, { obfuscator }));

		// Neither raw secret leaves the share...
		expect(flat).not.toContain(plainSecret);
		expect(flat).not.toContain(regexSecret);
		// ...and the header's placeholder for `plainSecret` was NOT minted with the friendly
		// prefix that spells out the later field's regex-protected value's sanitized shape.
		expect(flat).not.toContain(`${friendlyName}_`);

		// Deobfuscating the redacted share recovers both originals (the stripped placeholder
		// still carries its friendly-name-independent alias), and is a fixed point.
		const recovered = obfuscator.deobfuscate(flat);
		expect(recovered).toContain(plainSecret);
		expect(recovered).toContain(regexSecret);
		expect(obfuscator.deobfuscate(recovered)).toBe(recovered);
	});

	test("skips raw image payload bytes when collecting regex-protected values, so image data cannot spuriously trigger friendly-prefix collision avoidance", () => {
		// Regression: the whole-snapshot collision pre-scan only skipped strings
		// already shaped like a `data:image/...` URL, but `ImageContent.data` at
		// rest is raw base64 (that URL form only exists in the rendered viewer).
		// Left unguarded, every image payload gets regex-scanned like any other
		// string on each share — wasteful for large images, and an accidental
		// regex match inside the base64 bytes would poison the whole-snapshot
		// collision set used to decide whether OTHER fields' friendly-name
		// placeholders are safe to render.
		const plainSecret = "OTHERSECRET";
		const friendlyName = "TOKABC123";
		const regexSecret = "tok_abc123";
		const ts = "2026-06-12T00:00:00.000Z";
		// A regex secret ("tok_[a-z0-9]+") happens to match literally inside this
		// "image" payload, cleanly bounded so the match is exactly `regexSecret`;
		// a correct scan must never see it.
		const imageData = `binary noise ${regexSecret} more noise`;
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "a1",
				parentId: null,
				timestamp: ts,
				message: {
					role: "user",
					content: [
						{ type: "text", text: `remember ${plainSecret} for later` },
						{ type: "image", data: imageData, mimeType: "image/png" },
					],
					timestamp: 1,
				},
			} as unknown as SessionEntry,
		];
		const sm = {
			getHeader: () => sessionData([], "x").header,
			getEntries: () => entries,
			getLeafId: () => "a1",
		} as unknown as SessionManager;
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: plainSecret, friendlyName },
			{ type: "regex", content: "tok_[a-z0-9]+" },
		]);

		const flat = JSON.stringify(buildShareSnapshot(sm, { obfuscator }));

		expect(flat).not.toContain(plainSecret);
		// The image payload is left byte-for-byte intact — redaction never
		// touches inline image bytes (size trimming is a separate later pass).
		expect(flat).toContain(imageData);
		// Because the image bytes were skipped by the collision pre-scan, the
		// sibling plain secret's friendly-name placeholder needed no collision
		// avoidance and keeps its normal friendly prefix.
		expect(flat).toContain(`${friendlyName}_`);
	});

	test("ignores dropped provider replay payloads when collecting regex collision values", () => {
		const plainSecret = "OTHERSECRET";
		const friendlyName = "TOKABC123";
		const regexSecret = "tok_abc123";
		const ts = "2026-06-12T00:00:00.000Z";
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "a1",
				parentId: null,
				timestamp: ts,
				message: {
					role: "assistant",
					content: [{ type: "text", text: `remember ${plainSecret} for later` }],
					providerPayload: { items: [{ note: regexSecret }] },
					timestamp: 1,
				},
			} as unknown as SessionEntry,
		];
		const sm = {
			getHeader: () => sessionData([], "x").header,
			getEntries: () => entries,
			getLeafId: () => "a1",
		} as unknown as SessionManager;
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: plainSecret, friendlyName },
			{ type: "regex", content: "tok_[a-z0-9]+" },
		]);

		const flat = JSON.stringify(buildShareSnapshot(sm, { obfuscator }));

		expect(flat).not.toContain(plainSecret);
		expect(flat).not.toContain(regexSecret);
		expect(flat).toContain(`${friendlyName}_`);
	});

	test("collects regex values from tool arguments that resemble image blocks", () => {
		const plainSecret = "OTHERSECRET";
		const friendlyName = "TOKABC123";
		const regexSecret = "tok_abc123";
		const ts = "2026-06-12T00:00:00.000Z";
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "a1",
				parentId: null,
				timestamp: ts,
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "call-1", name: "read", arguments: { type: "image", value: regexSecret } },
					],
					timestamp: 1,
				},
			} as unknown as SessionEntry,
		];
		const sm = {
			getHeader: () => ({ ...sessionData([], "x").header, title: `remember ${plainSecret}` }),
			getEntries: () => entries,
			getLeafId: () => "a1",
		} as unknown as SessionManager;
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: plainSecret, friendlyName },
			{ type: "regex", content: "tok_[a-z0-9]+" },
		]);

		const flat = JSON.stringify(buildShareSnapshot(sm, { obfuscator }));

		expect(flat).not.toContain(plainSecret);
		expect(flat).not.toContain(regexSecret);
		expect(flat).not.toContain(`${friendlyName}_`);
	});
});

describe("normalizeShareServerUrl", () => {
	test("strips trailing slashes and falls back to the default", () => {
		expect(normalizeShareServerUrl("https://my.omp.sh/s/")).toBe("https://my.omp.sh/s");
		expect(normalizeShareServerUrl("https://example.com/s///")).toBe("https://example.com/s");
		expect(normalizeShareServerUrl(undefined)).toBe("https://my.omp.sh/s");
		expect(normalizeShareServerUrl("   ")).toBe("https://my.omp.sh/s");
	});
});

describe("shareSession", () => {
	test("default store seals the snapshot and uploads it to the share server", async () => {
		const entries = [messageEntry("e1", null, "share me"), messageEntry("e2", "e1", "second")];
		const sm = {
			getHeader: () => sessionData([], "x").header,
			getEntries: () => entries,
			getLeafId: () => "e2",
		} as unknown as SessionManager;

		let uploaded: Uint8Array<ArrayBuffer> | null = null;
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method !== "POST") return new Response("nope", { status: 405 });
				uploaded = new Uint8Array(await req.arrayBuffer());
				return Response.json({ id: "blobshareid01" });
			},
		});
		try {
			const base = `http://localhost:${server.port}`;
			const result = await shareSession(sm, { serverUrl: base });

			// Default store ("blob") routes to the server, not a gist: server-issued id, no gistUrl.
			expect(result.method).toBe("server");
			expect(result.gistUrl).toBeUndefined();
			const [link, keyText] = result.url.split("#");
			expect(link).toBe(`${base}/blobshareid01`);
			expect(uploaded).not.toBeNull();

			// The #key fragment decrypts the exact bytes the server received.
			const key = await crypto.subtle.importKey("raw", Buffer.from(keyText, "base64url"), "AES-GCM", false, [
				"decrypt",
			]);
			const opened = await open(key, uploaded as unknown as Uint8Array<ArrayBuffer>);
			expect(opened.entries).toHaveLength(2);
			expect(JSON.stringify(opened)).toContain("share me");
		} finally {
			server.stop(true);
		}
	});
});
