/**
 * Tests for secrets regex parsing, compilation, and obfuscation.
 */

import { describe, expect, it, spyOn } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message } from "@oh-my-pi/pi-ai";
import type {
	ResponseInputItem,
	ResponseToolSearchOutputItemParam,
} from "@oh-my-pi/pi-ai/providers/openai-responses-wire";
import { isJsonSchemaValueValid } from "@oh-my-pi/pi-ai/utils/schema/json-schema-validator";
import {
	builtinCredentialSecretEntries,
	collectEnvSecrets,
	getExistingSecretPlaceholderKey,
	getSecretPlaceholderKey,
	getSecretPlaceholderKeySync,
} from "@oh-my-pi/pi-coding-agent/secrets";
import {
	deobfuscateAgentMessages,
	deobfuscateToolArguments,
	obfuscateMessages,
	obfuscateNativeReplay,
} from "@oh-my-pi/pi-coding-agent/secrets/message-transform";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";
import { compileSecretRegex } from "@oh-my-pi/pi-coding-agent/secrets/regex";
import { getActiveProfile, getAgentDir, setProfile } from "@oh-my-pi/pi-utils/dirs";

describe("compileSecretRegex", () => {
	it("parses /pattern/flags literal syntax and redacts the secret group", () => {
		const regex = compileSecretRegex("/api_key=(?P<secret>\\w+)/i");
		expect(regex.source).toBe("api_key=(?P<secret>\\w+)");
		expect(regex.flags).toBe("i");
		const match = regex.exec("set API_KEY=abc123 now");
		expect(match?.[0]).toBe("abc123");
		expect(match?.index).toBe(12);
	});

	it("rejects invalid regex pattern", () => {
		expect(() => compileSecretRegex("(")).toThrow();
	});
	it("rejects invalid regex flags", () => {
		expect(() => compileSecretRegex("x", "zz")).toThrow();
	});
});

describe("builtinCredentialSecretEntries", () => {
	// Issue #6968: an unconfigured credential-shaped token in a tool result used
	// to fall through to pi-ai's irreversible `[*_token_redacted]` rewrite, so an
	// edit-tool `old_string` echoing that placeholder could never match the file.
	// The contract: the token is hidden from provider-visible text AND restored
	// byte-exact in tool-call arguments before tool execution.
	it("hides unconfigured credential-shaped tokens and restores them in tool-call arguments", () => {
		const obfuscator = new SecretObfuscator(builtinCredentialSecretEntries());
		expect(obfuscator.hasSecrets()).toBe(true);

		const tokens = [`sk-${"a1B-c2D".repeat(7)}e3F`, `ghp_${"aB1".repeat(12)}`, `glpat-${"xY2-".repeat(5)}`];
		for (const token of tokens) {
			const fileLine = `MOONSHOT_API_KEY=${token}`;
			const providerView = obfuscator.obfuscate(fileLine);
			expect(providerView).not.toContain(token);
			// Re-obfuscation is a fixed point: the placeholder itself is never re-matched.
			expect(obfuscator.obfuscate(providerView)).toBe(providerView);
			// The model echoes the placeholder into edit-tool old_string verbatim.
			const args = deobfuscateToolArguments(obfuscator, { old_string: providerView });
			expect(args.old_string).toBe(fileLine);
		}
	});

	it("hides vendor-prefixed credentials across built-in families and restores them in tool-call arguments", () => {
		const obfuscator = new SecretObfuscator(builtinCredentialSecretEntries());
		const awsKey = `AKIA${"Z9".repeat(8)}`;
		const googleKey = `AIza${"xQ9_".repeat(8)}abc`;
		const slackToken = `xoxb-${"1a2B".repeat(6)}`;
		const npmToken = `npm_${"Cd34".repeat(9)}`;
		const stripeKey = `sk_live_${"Ef56".repeat(6)}`;
		const stripeWebhook = `whsec_${"Gh78".repeat(8)}`;
		const hfToken = `hf_${"Ij90".repeat(8)}ab`;
		const sendgridKey = `SG.${"K1".repeat(11)}.${"M2".repeat(21)}M`;
		const jwt = `eyJ${"N3".repeat(10)}.eyJ${"O4".repeat(10)}.${"P5".repeat(13)}P`;
		const lines = [
			`aws_access_key_id = ${awsKey}`,
			`google api key: ${googleKey}`,
			`SLACK_BOT_TOKEN=${slackToken}`,
			`//registry.npmjs.org/:_authToken=${npmToken}`,
			`stripe secret: ${stripeKey}`,
			`endpoint_secret = ${stripeWebhook}`,
			`HF_TOKEN=${hfToken}`,
			`SENDGRID_API_KEY=${sendgridKey}`,
			`id_token: ${jwt}`,
		];
		const tokens = [awsKey, googleKey, slackToken, npmToken, stripeKey, stripeWebhook, hfToken, sendgridKey, jwt];
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const token = tokens[i];
			const providerView = obfuscator.obfuscate(line);
			expect(providerView).not.toContain(token);
			expect(obfuscator.obfuscate(providerView)).toBe(providerView);
			const args = deobfuscateToolArguments(obfuscator, { old_string: providerView });
			expect(args.old_string).toBe(line);
		}
	});

	it("replaces only the token after a Bearer prefix", () => {
		const obfuscator = new SecretObfuscator(builtinCredentialSecretEntries());
		const token = `${"Q7w".repeat(13)}Z`;
		const input = `Authorization: Bearer ${token}`;

		const providerView = obfuscator.obfuscate(input);

		expect(providerView).toContain("Authorization: Bearer ");
		expect(providerView).not.toContain(token);
		const args = deobfuscateToolArguments(obfuscator, { old_string: providerView });
		expect(args.old_string).toBe(input);
	});

	it("hides a multi-line PEM private key block as a single placeholder", () => {
		const obfuscator = new SecretObfuscator(builtinCredentialSecretEntries());
		const dash = "-".repeat(5);
		const bodyLine = "A".repeat(64);
		const pem = `${dash}BEGIN RSA PRIVATE KEY${dash}\n${bodyLine}\n${bodyLine}\n${bodyLine}\n${dash}END RSA PRIVATE KEY${dash}`;
		const input = `before line\n${pem}\nafter line`;

		const providerView = obfuscator.obfuscate(input);

		expect(providerView).not.toContain("BEGIN RSA PRIVATE KEY");
		expect(providerView).not.toContain("END RSA PRIVATE KEY");
		expect(providerView).not.toContain(bodyLine);
		expect(providerView.split("\n")).toHaveLength(3);
		expect(providerView.startsWith("before line\n")).toBe(true);
		expect(providerView.endsWith("\nafter line")).toBe(true);
		const args = deobfuscateToolArguments(obfuscator, { old_string: providerView });
		expect(args.old_string).toBe(input);
	});

	it("leaves publishable keys, identifiers, and plain hashes alone", () => {
		const obfuscator = new SecretObfuscator(builtinCredentialSecretEntries());
		const publishable = `pk_live_${"Ab12".repeat(6)}`;
		const gitSha = "a1b2c3d4".repeat(5);
		const input = [
			`publishable = ${publishable}`,
			"token = get_token_expiry_seconds()",
			`commit ${gitSha}`,
			"keyboard_shortcut_secret_value",
		].join("\n");

		expect(obfuscator.obfuscate(input)).toBe(input);
	});
});

describe("collectEnvSecrets connection URLs", () => {
	it("registers the password from a DSN env var that does not match secret-name patterns", () => {
		const name = "OMP_TEST_CONNURL_DSN";
		const scheme = "postgres";
		const user = "app";
		const pw = `pw${"0123456789ab".slice(0, 12)}`;
		const host = "db.internal:5432";
		const db = "shop";
		const url = `${scheme}://${user}:${pw}@${host}/${db}`;
		process.env[name] = url;
		try {
			const entries = collectEnvSecrets();
			expect(entries.some(e => e.type === "plain" && e.mode === "obfuscate" && e.content === pw)).toBe(true);
			expect(entries.some(e => e.content === url)).toBe(false);
		} finally {
			delete process.env[name];
		}
	});

	it("registers both raw and decoded forms of a percent-encoded password", () => {
		const name = "OMP_TEST_CONNURL_ENCODED";
		const pwRaw = `p%40ss${"12345678"}%3Ax`;
		const pwDecoded = decodeURIComponent(pwRaw);
		const url = `postgres://app:${pwRaw}@db.internal:5432/shop`;
		process.env[name] = url;
		try {
			const entries = collectEnvSecrets();
			expect(entries.some(e => e.content === pwRaw)).toBe(true);
			expect(entries.some(e => e.content === pwDecoded)).toBe(true);
		} finally {
			delete process.env[name];
		}
	});

	it("registers the password from a userless connection URL", () => {
		const name = "OMP_TEST_CONNURL_NOUSER";
		const pw = `pw${"0123456789ab".slice(0, 12)}`;
		const url = `redis://:${pw}@redis.internal:6379/0`;
		process.env[name] = url;
		try {
			const entries = collectEnvSecrets();
			expect(entries.some(e => e.type === "plain" && e.mode === "obfuscate" && e.content === pw)).toBe(true);
		} finally {
			delete process.env[name];
		}
	});

	it("registers the full password when it contains an unescaped at sign", () => {
		const name = "OMP_TEST_CONNURL_RAW_AT";
		const pw = "passwrd1@correcthorse";
		const url = `postgres://app:${pw}@db.internal/shop`;
		process.env[name] = url;
		try {
			const entries = collectEnvSecrets();
			expect(entries.some(e => e.type === "plain" && e.mode === "obfuscate" && e.content === pw)).toBe(true);
			expect(new SecretObfuscator(entries).obfuscate(url)).not.toContain("correcthorse");
		} finally {
			delete process.env[name];
		}
	});

	it("skips connection-URL passwords shorter than the minimum length", () => {
		const name = "OMP_TEST_CONNURL_SHORT";
		const url = "postgres://app:pw@db.internal:5432/shop";
		process.env[name] = url;
		try {
			const entries = collectEnvSecrets();
			expect(entries.some(e => e.content === "pw")).toBe(false);
		} finally {
			delete process.env[name];
		}
	});

	it("ignores non-URL values on non-secret variable names", () => {
		const name = "OMP_TEST_CONNURL_PLAIN";
		const value = "hello-world-value-123";
		process.env[name] = value;
		try {
			const entries = collectEnvSecrets();
			expect(entries.some(e => e.content === value)).toBe(false);
		} finally {
			delete process.env[name];
		}
	});
});

describe("lazy placeholder key", () => {
	// The built-in credential entries match dynamically, so they must not force
	// `secret-placeholder.key` creation for every secrets.enabled session: the
	// key provider is only invoked when a credential-shaped token is actually
	// obfuscated, and exactly once across the obfuscator's lifetime.
	it("resolves the key provider only on the first real credential match", () => {
		let resolutions = 0;
		const obfuscator = new SecretObfuscator(builtinCredentialSecretEntries(), () => {
			resolutions++;
			return crypto.randomBytes(32).toString("base64url");
		});
		expect(resolutions).toBe(0);
		obfuscator.obfuscate("MOONSHOT_API_KEY=huntsville");
		expect(resolutions).toBe(0);

		const token = `sk-${"a1B-c2D".repeat(7)}e3F`;
		const providerView = obfuscator.obfuscate(`MOONSHOT_API_KEY=${token}`);
		expect(resolutions).toBe(1);
		expect(providerView).not.toContain(token);
		obfuscator.obfuscate(`repeat: ${token}`);
		expect(resolutions).toBe(1);
		const args = deobfuscateToolArguments(obfuscator, { old_string: providerView });
		expect(args.old_string).toBe(`MOONSHOT_API_KEY=${token}`);
	});

	it("redacts a lazily resolved key from the same input that triggers resolution", () => {
		const key = "K".repeat(43);
		const obfuscator = new SecretObfuscator(builtinCredentialSecretEntries(), () => key);
		const token = `sk-${"a1B-c2D".repeat(7)}e3F`;

		const providerView = obfuscator.obfuscate(`key=${key}\ncredential=${token}`);

		expect(providerView).not.toContain(key);
		expect(providerView).not.toContain(token);
	});

	it("getSecretPlaceholderKeySync creates the key file on demand and shares it with the async readers", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-lazy-placeholder-key-"));
		try {
			expect(await getExistingSecretPlaceholderKey(dir)).toBeUndefined();
			const key = getSecretPlaceholderKeySync(dir);
			expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
			expect(await getExistingSecretPlaceholderKey(dir)).toBe(key);
			expect(await getSecretPlaceholderKey(dir)).toBe(key);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("SecretObfuscator regex behavior", () => {
	it("deobfuscates placeholders through tool-call arguments", () => {
		const obfuscator = new SecretObfuscator([{ type: "regex", content: "api[_-]?key\\s*=\\s*\\w+", flags: "i" }]);
		const original = { cmd: "API_KEY=abc and api-key=def", status: "ok", nested: { note: "API_KEY=zzz" } };
		const obfuscated = {
			cmd: obfuscator.obfuscate(original.cmd),
			status: original.status,
			nested: { note: obfuscator.obfuscate(original.nested.note) },
		};
		expect(JSON.stringify(obfuscated)).not.toContain("API_KEY=abc");
		expect(deobfuscateToolArguments(obfuscator, obfuscated)).toEqual(original);
	});

	it("encodes plaintext in every outbound role", () => {
		const secret = "SUPER_SECRET_TOKEN_12345";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);
		const userMsg: Message = { role: "user", content: `user says ${secret}`, timestamp: 1 };
		const systemDeveloperMsg: Message = { role: "developer", content: `system reminder ${secret}`, timestamp: 1 };
		const fileMentionMsg: Message = {
			role: "developer",
			content: `<file>${secret}</file>`,
			attribution: "user",
			timestamp: 1,
		};
		const assistantMsg: Message = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_1",
					name: "handoff",
					arguments: { note: secret },
					intent: `handoff ${secret}`,
				},
			],
			api: "test",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 1,
		};
		const toolResultMsg: Message = {
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "read",
			content: [{ type: "text", text: `tool output ${secret}` }],
			isError: false,
			timestamp: 1,
		};

		const obfuscated = obfuscateMessages(obfuscator, [
			userMsg,
			systemDeveloperMsg,
			fileMentionMsg,
			assistantMsg,
			toolResultMsg,
		]);

		// User, developer (system reminders included), file mentions, tool results, and assistant
		// content the model wrote from plaintext (redaction was off) are all encoded.
		for (const message of obfuscated) expect(JSON.stringify(message)).not.toContain(secret);
	});

	it("obfuscates file metadata on a replayed compaction payload but keeps the block verbatim", () => {
		const secret = "SUPER_SECRET_TOKEN_12345";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);
		const message: Message = {
			role: "user",
			content: "Prior model work available.",
			timestamp: 1,
			providerPayload: {
				type: "anthropicCompaction",
				provider: "anthropic",
				content: "## Goal\nAudit the handlers.",
				filesText: `<files>\n# /repo/\n${secret}.key (Read)\n</files>`,
				retainedFiles: [{ text: `<files>\n# /repo/\n${secret}.old (Read)\n</files>`, after: 0 }],
			},
		};

		const [obfuscated] = obfuscateMessages(obfuscator, [message]);
		if (obfuscated?.role !== "user") throw new Error("expected user message");
		const payload = obfuscated.providerPayload;
		if (payload?.type !== "anthropicCompaction") throw new Error("expected compaction payload");
		// The metadata takes the same boundary as the summary text...
		expect(payload.filesText).not.toContain(secret);
		expect(obfuscator.deobfuscate(payload.filesText ?? "")).toContain(secret);
		expect(payload.retainedFiles?.[0]?.text).not.toContain(secret);
		expect(payload.retainedFiles?.[0]?.after).toBe(0);
		// ...while the replayed block stays byte-identical to the API summary.
		expect(payload.content).toBe("## Goal\nAudit the handlers.");
		expect(obfuscated).not.toBe(message);
	});

	it("never rewrites inline image bytes", () => {
		const secret = "SUPER_SECRET_TOKEN_12345";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);
		// A base64 payload that literally contains the secret substring must survive byte-identical;
		// rewriting it would corrupt the data URL (the Codex "invalid base64" failure).
		const imageData = `iVBORw0KGgo${secret}AAAASUVORK5CYII=`;
		const message: Message = {
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "read",
			content: [
				{ type: "text", text: `read ${secret}` },
				{ type: "image", data: imageData, mimeType: "image/png" },
			],
			isError: false,
			timestamp: 1,
		};

		const [obfuscated] = obfuscateMessages(obfuscator, [message]) as [typeof message];
		const blocks = obfuscated.content;
		const image = blocks[1];
		const text = blocks[0];
		// Image bytes untouched...
		expect(image.type === "image" && image.data).toBe(imageData);
		// ...while the adjacent text is redacted.
		expect(text.type === "text" && text.text.includes(secret)).toBe(false);
	});

	it("ignores configured plain secrets shorter than 8 characters", () => {
		const obfuscator = new SecretObfuscator([{ type: "plain", content: "esp" }]);
		expect(obfuscator.hasSecrets()).toBe(false);
		expect(obfuscator.obfuscate("the response despite whitespace")).toBe("the response despite whitespace");
	});

	it("ignores regex matches shorter than 8 characters", () => {
		const obfuscator = new SecretObfuscator([{ type: "regex", content: "esp" }]);
		expect(obfuscator.obfuscate("the response despite whitespace")).toBe("the response despite whitespace");
	});
});

describe("getSecretPlaceholderKey", () => {
	// Isolate under a fresh $HOME (never the real homedir) so mkdir/writeFile
	// below cannot hit EACCES in a sandboxed CI/review environment where the
	// real home is read-only, and so the default-arg path under test resolves
	// through the SAME `getAgentDir()` the runtime uses (see getSecretPlaceholderKey's
	// docstring) rather than the unrelated `getConfigRootDir()`.
	async function withTempAgentHome(run: () => Promise<void>): Promise<void> {
		const originalProfile = getActiveProfile();
		const originalHome = process.env.HOME;
		const tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-secret-key-"));
		process.env.HOME = tempHomeDir;
		const homedirSpy = spyOn(os, "homedir").mockReturnValue(tempHomeDir);
		try {
			setProfile(undefined);
			await run();
		} finally {
			setProfile(originalProfile);
			homedirSpy.mockRestore();
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
			await fs.rm(tempHomeDir, { recursive: true, force: true });
		}
	}

	it("caches placeholder keys per profile agent dir", async () => {
		await withTempAgentHome(async () => {
			const alphaKey = "A".repeat(43);
			const betaKey = "B".repeat(43);
			setProfile("alpha");
			await fs.mkdir(getAgentDir(), { recursive: true });
			await fs.writeFile(path.join(getAgentDir(), "secret-placeholder.key"), alphaKey);
			expect(await getSecretPlaceholderKey()).toBe(alphaKey);

			setProfile("beta");
			await fs.mkdir(getAgentDir(), { recursive: true });
			await fs.writeFile(path.join(getAgentDir(), "secret-placeholder.key"), betaKey);
			expect(await getSecretPlaceholderKey()).toBe(betaKey);
		});
	});

	it("rejects truncated placeholder key files", async () => {
		await withTempAgentHome(async () => {
			setProfile("truncated");
			await fs.mkdir(getAgentDir(), { recursive: true });
			await fs.writeFile(path.join(getAgentDir(), "secret-placeholder.key"), "abc123");

			await expect(getSecretPlaceholderKey()).rejects.toThrow("secret placeholder key");
		});
	});

	it("retries empty existing placeholder key files without creating a new one", async () => {
		await withTempAgentHome(async () => {
			setProfile("race");
			await fs.mkdir(getAgentDir(), { recursive: true });
			const keyPath = path.join(getAgentDir(), "secret-placeholder.key");
			await fs.writeFile(keyPath, "");
			const eventualKey = "C".repeat(43);
			// Real delay is intentional: this exercises readPlaceholderKeyFile's retry
			// loop against an actual concurrent filesystem write, not a mockable timer.
			const writer = Bun.sleep(25).then(() => fs.writeFile(keyPath, eventualKey));

			await expect(getExistingSecretPlaceholderKey()).resolves.toBe(eventualKey);
			await writer;
		});
	});

	it("treats an invalid existing placeholder key as absent for redaction", async () => {
		await withTempAgentHome(async () => {
			setProfile("invalid-existing");
			await fs.mkdir(getAgentDir(), { recursive: true });
			await fs.writeFile(path.join(getAgentDir(), "secret-placeholder.key"), "abc123");

			// Replace-only/no-secret sessions load the key only to redact it from tool
			// output; a corrupt key must not block startup, so the existing-key probe
			// is best-effort. The obfuscate-mode loader still rejects an invalid key.
			await expect(getExistingSecretPlaceholderKey()).resolves.toBeUndefined();
			await expect(getSecretPlaceholderKey()).rejects.toThrow("secret placeholder key");
		});
	});
});

describe("native replay secret obfuscation", () => {
	it("redacts dynamic discovery descriptions and schema examples without changing identifiers", () => {
		const secret = "DISCOVERY_SECRET_123";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);
		const schemaFor = (text: string) => ({
			type: "object",
			description: text,
			required: ["description"],
			properties: { description: { type: "array", items: { $ref: "#/$defs/value" }, examples: [[text]] } },
			$defs: { value: { type: "string", title: text, $comment: text } },
		});
		const itemsFor = (text: string) => [
			{
				type: "mcp_list_tools",
				id: secret,
				server_label: secret,
				tools: [
					{
						name: secret,
						description: text,
						input_schema: schemaFor(text),
						annotations: { title: text, readOnlyHint: true },
					},
				],
			} satisfies ResponseInputItem.McpListTools,
			{
				type: "tool_search_output",
				id: secret,
				call_id: secret,
				execution: "client",
				status: "completed",
				tools: [
					{
						type: "namespace",
						name: secret,
						description: text,
						tools: [
							{ type: "function", name: secret, description: text, parameters: schemaFor(text), strict: true },
							{
								type: "custom",
								name: secret,
								description: text,
								format: { type: "grammar", syntax: "regex", definition: secret },
							},
						],
					},
					{
						type: "mcp",
						server_label: secret,
						server_description: text,
						server_url: `https://example.test/${secret}`,
						authorization: secret,
					},
					{
						type: "shell",
						environment: { type: "local", skills: [{ name: secret, path: secret, description: text }] },
					},
				],
			} satisfies ResponseToolSearchOutputItemParam,
			{
				type: "additional_tools",
				role: "developer",
				id: secret,
				tools: [
					{ type: "tool_search", execution: "client", description: text, parameters: schemaFor(text) },
					{
						type: "shell",
						environment: {
							type: "container_auto",
							file_ids: [secret],
							skills: [
								{
									type: "inline",
									name: secret,
									description: text,
									source: { type: "base64", media_type: "application/zip", data: secret },
								},
								{ type: "skill_reference", skill_id: secret, version: "latest" },
							],
						},
					},
					{ type: "shell", environment: { type: "container_reference", container_id: secret } },
				],
			} satisfies ResponseInputItem.AdditionalTools,
		];
		const original = {
			providerPayload: { type: "openaiResponsesHistory" as const, provider: "openai", items: itemsFor(secret) },
			preserveData: { openaiRemoteCompaction: { provider: "openai", replacementHistory: itemsFor(secret) } },
		};
		const snapshot = structuredClone(original);
		const scrubbed = obfuscateNativeReplay(obfuscator, original);
		const expected = itemsFor(obfuscator.obfuscate(secret));
		expect(scrubbed.providerPayload.items).toEqual(expected);
		expect(scrubbed.preserveData.openaiRemoteCompaction.replacementHistory).toEqual(expected);
		expect(original).toEqual(snapshot);
		expect(obfuscateNativeReplay(obfuscator, scrubbed)).toBe(scrubbed);
	});

	it("preserves satisfiable discovery constraints while redacting descriptions", () => {
		const secret = "NATIVE_SECRET_123456";
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: "OTHERSECRET", friendlyName: "NATIVESECRET123456" },
			{ type: "regex", content: "NATIVE_SECRET_[0-9]+" },
		]);
		const stale = obfuscator.obfuscate("OTHERSECRET");
		const parameters = {
			type: "object",
			description: "Choose OTHERSECRET",
			required: ["token", "mode"],
			additionalProperties: false,
			properties: {
				token: { type: "string", const: secret, pattern: "^NATIVE_SECRET_[0-9]+$", maxLength: secret.length },
				mode: { type: "string", enum: [secret, "public"], default: secret },
			},
			"x-mcp-header": secret,
		};
		const replay = {
			providerPayload: {
				type: "openaiResponsesHistory" as const,
				provider: "openai",
				items: [
					{
						type: "tool_search_output",
						id: secret,
						execution: "client",
						status: "completed",
						tools: [{ type: "function", name: secret, parameters, strict: false }],
					} satisfies ResponseToolSearchOutputItemParam,
				],
			},
		};
		const scrubbed = obfuscateNativeReplay(obfuscator, replay);
		const schema = scrubbed.providerPayload.items[0]!.tools[0]!.parameters;
		expect(isJsonSchemaValueValid(schema, { token: secret, mode: secret })).toBe(true);
		expect(isJsonSchemaValueValid(schema, { token: secret, mode: "public" })).toBe(true);
		expect(isJsonSchemaValueValid(schema, { token: "invalid", mode: "public" })).toBe(false);
		expect(isJsonSchemaValueValid(schema, { token: secret, mode: "invalid" })).toBe(false);
		expect(schema.description).not.toContain("OTHERSECRET");
		expect(parameters.description).toBe("Choose OTHERSECRET");
		expect(stale).toContain("NATIVESECRET123456_");
	});

	it("scrubs native plaintext and tool data without rewriting encrypted or structural fields", () => {
		const obfuscator = new SecretObfuscator([{ type: "plain", content: "OTHERSECRET", friendlyName: "Other" }]);
		// Plaintext in every slot; only the protocol's plaintext slots may be encoded.
		const stale = "OTHERSECRET";
		const image = { type: "input_image", image_url: `data:image/png;base64,${stale}`, detail: "auto" };
		const file = { type: "input_file", file_id: stale, file_data: stale };
		const compactionItem = { type: "compaction_summary", summary: stale, encrypted_content: stale };
		const items: Array<Record<string, unknown>> = [
			{ type: "message", role: "user", id: stale, content: [{ type: "input_text", text: stale }, image, file] },
			{
				type: "message",
				role: "assistant",
				phase: "final_answer",
				content: [
					{ type: "output_text", text: stale, annotations: [{ type: "file_citation", file_id: stale }] },
					{ type: "refusal", refusal: stale },
				],
			},
			{
				type: "reasoning",
				id: stale,
				encrypted_content: stale,
				summary: [{ type: "summary_text", text: stale }],
				content: [{ type: "reasoning_text", text: stale }],
			},
			{
				type: "function_call",
				call_id: stale,
				name: stale,
				arguments: JSON.stringify({ nested: [stale], [stale]: 1 }),
				encrypted_function_args: [],
			},
			{ type: "function_call", call_id: "structured", name: "search", arguments: { nested: { query: stale } } },
			{ type: "function_call_output", call_id: stale, output: [{ type: "input_text", text: stale }, image, file] },
			{ type: "custom_tool_call", call_id: stale, name: "apply_patch", input: stale },
			{ type: "custom_tool_call_output", call_id: stale, output: stale },
			{
				type: "function_call",
				call_id: "encrypted",
				name: "collaborate",
				arguments: stale,
				encrypted_function_args: [stale],
			},
			{
				type: "shell_call_output",
				call_id: "shell",
				output: [{ stdout: stale, stderr: stale, outcome: { type: "exit", exit_code: 1 } }],
			},
			{
				type: "computer_call",
				call_id: "computer",
				actions: [
					{ type: "type", text: stale },
					{ type: "keypress", keys: ["ENTER"] },
				],
			},
			compactionItem,
		];
		const original = {
			providerPayload: { type: "openaiResponsesHistory" as const, provider: "openai-codex", dt: true, items },
			preserveData: {
				openaiRemoteCompaction: { provider: "openai-codex", replacementHistory: items, compactionItem },
				extension: { text: stale },
			},
		};
		const redacted = obfuscator.obfuscate(stale);
		expect(redacted).not.toContain("OTHERSECRET");
		const scrubbed = obfuscateNativeReplay(obfuscator, original);
		expect(scrubbed.providerPayload.items).toEqual([
			{ ...items[0], content: [{ type: "input_text", text: redacted }, image, file] },
			{
				...items[1],
				content: [
					{ type: "output_text", text: redacted, annotations: [{ type: "file_citation", file_id: stale }] },
					{ type: "refusal", refusal: redacted },
				],
			},
			{
				...items[2],
				summary: [{ type: "summary_text", text: redacted }],
				content: [{ type: "reasoning_text", text: redacted }],
			},
			{ ...items[3], arguments: JSON.stringify({ nested: [redacted], [stale]: 1 }) },
			{ ...items[4], arguments: { nested: { query: redacted } } },
			{ ...items[5], output: [{ type: "input_text", text: redacted }, image, file] },
			{ ...items[6], input: redacted },
			{ ...items[7], output: redacted },
			items[8],
			{ ...items[9], output: [{ stdout: redacted, stderr: redacted, outcome: { type: "exit", exit_code: 1 } }] },
			{
				...items[10],
				actions: [
					{ type: "type", text: redacted },
					{ type: "keypress", keys: ["ENTER"] },
				],
			},
			{ ...compactionItem, summary: redacted },
		]);
		expect(scrubbed.preserveData.openaiRemoteCompaction.replacementHistory).toBe(scrubbed.providerPayload.items);
		expect(scrubbed.preserveData.openaiRemoteCompaction.compactionItem).toEqual({
			...compactionItem,
			summary: redacted,
		});
		expect(scrubbed.preserveData.extension).toBe(original.preserveData.extension);
		expect(original.providerPayload.items[6]?.input).toBe(stale);
		expect(original.preserveData.openaiRemoteCompaction.compactionItem.summary).toBe(stale);
		expect(obfuscateNativeReplay(obfuscator, scrubbed)).toBe(scrubbed);
		expect(obfuscateNativeReplay(new SecretObfuscator([]), original)).toBe(original);
		const detached = { ...original, preserveData: structuredClone(original.preserveData) };
		const detachedScrubbed = obfuscateNativeReplay(obfuscator, detached);
		expect(detachedScrubbed.preserveData.openaiRemoteCompaction.replacementHistory).toEqual(
			scrubbed.providerPayload.items,
		);
	});
});

describe("deobfuscateAgentMessages (display restore)", () => {
	it("restores assistant text, thinking, and tool calls while leaving raw user text untouched", () => {
		const secret = "DISPLAY_SECRET_TOKEN_123";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);
		const placeholder = obfuscator.obfuscate(secret);
		expect(placeholder).not.toBe(secret);

		const userMsg: AgentMessage = { role: "user", content: `literal ${placeholder} token`, timestamp: 1 };
		const assistantMsg: AgentMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: `answer ${placeholder}` },
				{ type: "thinking", thinking: `reason ${placeholder}` },
				{
					type: "toolCall",
					id: "call_1",
					name: "read",
					arguments: { path: `path ${placeholder}` },
					intent: `intent ${placeholder}`,
				},
			],
			api: "test",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		};
		const branchSummary: AgentMessage = {
			role: "branchSummary",
			summary: `branch ${placeholder}`,
			fromId: "x",
			timestamp: 3,
		};
		const compactionSummary: AgentMessage = {
			role: "compactionSummary",
			summary: `compact ${placeholder}`,
			shortSummary: `short ${placeholder}`,
			tokensBefore: 0,
			timestamp: 4,
		};

		const restored = deobfuscateAgentMessages(obfuscator, [userMsg, assistantMsg, branchSummary, compactionSummary]);

		// Assistant text and tool-call args/intent are restored to the real secret.
		const restoredAssistant = restored[1] as AssistantMessage;
		const assistantJson = JSON.stringify(restoredAssistant.content);
		expect(assistantJson).toContain(secret);
		expect(assistantJson).not.toContain(`answer ${placeholder}`);
		expect(assistantJson).not.toContain(`path ${placeholder}`);
		expect(assistantJson).not.toContain(`intent ${placeholder}`);
		// Thinking is model-authored placeholder text like the reply, so the display shows the value.
		expect(assistantJson).toContain(`reason ${secret}`);
		// Model-generated summaries are restored.
		expect((restored[2] as { summary: string }).summary).toBe(`branch ${secret}`);
		expect((restored[3] as { summary: string; shortSummary?: string }).summary).toBe(`compact ${secret}`);
		expect((restored[3] as { summary: string; shortSummary?: string }).shortSummary).toBe(`short ${secret}`);
		// The user message is persisted raw and never walked: a literal placeholder-shaped token
		// survives byte-identical (same reference) rather than being turned into the secret.
		expect(restored[0]).toBe(userMsg);
	});

	it("restores compactionSummary block text while leaving snapcompact image bytes intact", () => {
		const secret = "BLOCKS_SECRET_TOKEN_456";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);
		const placeholder = obfuscator.obfuscate(secret);
		const imageData = `frame${secret}bytes==`;
		const message: AgentMessage = {
			role: "compactionSummary",
			summary: `summary ${placeholder}`,
			tokensBefore: 0,
			blocks: [
				{ type: "text", text: `archived ${placeholder}` },
				{ type: "image", data: imageData, mimeType: "image/png" },
			],
			timestamp: 1,
		};

		const restored = deobfuscateAgentMessages(obfuscator, [message])[0];
		if (restored?.role !== "compactionSummary") throw new Error("expected restored compaction summary");
		const blocks = restored.blocks ?? [];
		const text = blocks[0];
		const image = blocks[1];
		// Archived text is restored to the real secret...
		expect(text.type === "text" && text.text).toBe(`archived ${secret}`);
		// ...while the snapcompact image bytes pass through untouched.
		expect(image.type === "image" && image.data).toBe(imageData);
	});
});
