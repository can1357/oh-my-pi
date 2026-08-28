/**
 * Tests for secrets regex parsing, compilation, and obfuscation.
 */

import { describe, expect, it, spyOn } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context, Message, TextContent } from "@oh-my-pi/pi-ai";
import {
	builtinCredentialSecretEntries,
	getExistingSecretPlaceholderKey,
	getSecretPlaceholderKey,
	getSecretPlaceholderKeySync,
	loadSecrets,
} from "@oh-my-pi/pi-coding-agent/secrets";
import {
	deobfuscateAgentMessages,
	deobfuscateToolArguments,
	obfuscateMessages,
	obfuscateProviderContext,
	obfuscateToolArguments,
} from "@oh-my-pi/pi-coding-agent/secrets/message-transform";
import { type SecretEntry, SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";
import {
	sanitizeSecretFriendlyName,
	secretEntriesNeedPlaceholderKey,
	secretEntryNeedsPlaceholderKey,
	stripPendingSecretPlaceholderSuffix,
} from "@oh-my-pi/pi-coding-agent/secrets/placeholder";
import { compileSecretRegex } from "@oh-my-pi/pi-coding-agent/secrets/regex";
import { getActiveProfile, getAgentDir, setProfile } from "@oh-my-pi/pi-utils/dirs";

describe("compileSecretRegex", () => {
	it("adds global flag when not provided", () => {
		const regex = compileSecretRegex("api[_-]?key\\s*=\\s*\\w+", "i");
		expect(regex.source).toBe("api[_-]?key\\s*=\\s*\\w+");
		expect(regex.flags).toBe("gi");
	});

	it("defaults to global flag when no flags provided", () => {
		const regex = compileSecretRegex("api[_-]?key\\s*=\\s*\\w+");
		expect(regex.source).toBe("api[_-]?key\\s*=\\s*\\w+");
		expect(regex.flags).toBe("g");
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
	it("obfuscates and deobfuscates regex matches with flags", () => {
		const obfuscator = new SecretObfuscator([{ type: "regex", content: "api[_-]?key\\s*=\\s*\\w+", flags: "i" }]);
		const original = "API_KEY=abc and api-key=def";
		const obfuscated = obfuscator.obfuscate(original);
		expect(obfuscated).not.toEqual(original);
		expect(obfuscator.deobfuscate(obfuscated)).toEqual(original);
	});

	it("supports bare regex patterns without explicit flags", () => {
		const obfuscator = new SecretObfuscator([{ type: "regex", content: "api[_-]?key\\s*=\\s*\\w+" }]);
		const text = "api_key=abc and API_KEY=def";
		const obfuscated = obfuscator.obfuscate(text);
		expect(obfuscated).not.toEqual(text);
		expect(obfuscator.deobfuscate(obfuscated)).toEqual(text);
	});
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

	it("obfuscates conversation messages but leaves the system prompt untouched", () => {
		const secret = "SUPER_SECRET_TOKEN_12345";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);
		const context: Context = {
			systemPrompt: [`workspace contains ${secret}`],
			messages: [{ role: "user", content: `use ${secret}`, timestamp: 1 }],
		};

		const obfuscated = obfuscateProviderContext(obfuscator, context);

		// Conversation messages are redacted (and round-trip back to the secret)...
		expect(JSON.stringify(obfuscated.messages)).not.toContain(secret);
		expect(obfuscator.deobfuscate(JSON.stringify(obfuscated.messages))).toContain(secret);
		// ...but the author-controlled system prompt passes through by reference.
		expect(obfuscated.systemPrompt).toBe(context.systemPrompt);
	});

	it("leaves tool schemas untouched in provider context (no clone, no redaction)", () => {
		const secret = "SUPER_SECRET_TOKEN_12345";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);
		const parameters = type({
			note: "string",
		}).describe(`write ${secret}`);
		const context: Context = {
			messages: [],
			tools: [
				{
					name: "extension_tool",
					description: `preserve ${secret}`,
					parameters,
				},
			],
		};

		const obfuscated = obfuscateProviderContext(obfuscator, context);

		expect(obfuscated.tools).toBe(context.tools);
		expect(obfuscated.tools?.[0]?.parameters).toBe(parameters);
	});

	it("redacts user-facing messages and assistant replay content", () => {
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

		// User-facing content and assistant replay fields are redacted.
		expect(JSON.stringify(obfuscated[0])).not.toContain(secret);
		expect(JSON.stringify(obfuscated[2])).not.toContain(secret);
		expect(JSON.stringify(obfuscated[3])).not.toContain(secret);
		expect(JSON.stringify(obfuscated[4])).not.toContain(secret);
		// System developer reminders remain untouched.
		expect(obfuscated[1]).toBe(systemDeveloperMsg);
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

describe("SecretObfuscator friendlyName placeholders", () => {
	it("prefixes plain secret placeholders with sanitized friendly names", () => {
		const secret = "github_pat_abc123";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret, friendlyName: "GitHub Token!" }]);
		const input = `use ${secret} now`;
		const obfuscated = obfuscator.obfuscate(input);

		expect(obfuscated).toMatch(/\$\$GITHUBTOKEN_[A-Z0-9]+:L\$\$/);
		expect(obfuscated).not.toContain(secret);
		expect(obfuscator.deobfuscate(obfuscated)).toBe(input);
	});

	it("rejects a friendlyName that is a case/punctuation variant of its own secret, but still applies unrelated friendly names", () => {
		// `#friendlyNameCollidesWithSecret` used to compare the sanitized (uppercased,
		// alnum-only) friendly name against each secret's RAW value, so a friendlyName
		// that was merely a case/punctuation variant of its own secret (e.g.
		// "GitHub_Pat_Abc123" labeling "github_pat_abc123") slipped through: sanitizing
		// the label produced "GITHUBPATABC123", which never literally appears inside the
		// lowercase, underscored raw secret string. The fix sanitizes the secret value
		// the same way before comparing, so this exact-content-under-normalization case
		// is now caught and the secret falls back to a bare placeholder — while a
		// genuinely unrelated friendly name is untouched and still gets its prefix.
		const collidingSecret = "github_pat_abc123";
		const collidingObfuscator = new SecretObfuscator([
			{ type: "plain", content: collidingSecret, friendlyName: "GitHub_Pat_Abc123" },
		]);
		const collidingObfuscated = collidingObfuscator.obfuscate(collidingSecret);

		expect(collidingObfuscated).not.toMatch(/GITHUBPATABC123_/);
		expect(collidingObfuscated).toMatch(/^\$\$[A-Z0-9]+:L\$\$$/);
		expect(collidingObfuscator.deobfuscate(collidingObfuscated)).toBe(collidingSecret);

		const distinctSecret = "github_pat_xyz789";
		const distinctObfuscator = new SecretObfuscator([
			{ type: "plain", content: distinctSecret, friendlyName: "GitHub Token" },
		]);
		const distinctObfuscated = distinctObfuscator.obfuscate(distinctSecret);

		expect(distinctObfuscated).toMatch(/^\$\$GITHUBTOKEN_[A-Z0-9]+:L\$\$$/);
		expect(distinctObfuscator.deobfuscate(distinctObfuscated)).toBe(distinctSecret);
	});

	it("rejects a friendlyName equal to its own secret even when the secret's sanitized form exceeds the 32-char display cap", () => {
		// `#friendlyNameCollidesWithSecret` used to compare the friendly name
		// against each secret's sanitized value using the ALREADY-CAPPED,
		// display-length friendly name (sliced to `MAX_FRIENDLY_NAME_LEN` = 32
		// chars by `sanitizeSecretFriendlyName`) rather than the full,
		// un-truncated sanitized form. For a secret whose sanitized (alnum-only,
		// uppercased) form is longer than 32 characters, the 32-char-capped
		// label being checked could never `.includes()` the longer sanitized
		// secret, so a friendlyName set to the secret's own value slipped past
		// the collision guard entirely — and the secret's first 32 sanitized
		// characters were accepted and baked into the placeholder as a
		// visible prefix (e.g. "#GITHUBPATABCDEFGHIJKLMNOPQRSTUV_<hash>:L#"),
		// leaking part of the secret. The check now runs against the full,
		// un-truncated sanitized label before the 32-char cap is applied for
		// display, so secrets longer than the cap are still fully compared
		// and caught.
		const longSecret = "github_pat_abcdefghijklmnopqrstuvwxyz0123456789";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: longSecret, friendlyName: longSecret }]);
		const obfuscated = obfuscator.obfuscate(longSecret);

		expect(obfuscated).not.toMatch(/GITHUBPAT/);
		expect(obfuscated).toMatch(/^\$\$[A-Z0-9]+:L\$\$$/);
		expect(obfuscator.deobfuscate(obfuscated)).toBe(longSecret);
	});

	it("rejects a friendlyName whose sanitized value is exactly the first 32 characters of a longer secret", () => {
		// Regression: `sanitizedLabelCollidesWithSecret` must also reject a
		// friendlyName that is a strict PREFIX of a longer secret's sanitized
		// form, not just one that equals the secret outright (the case above).
		// A friendlyName that sanitizes to exactly `MAX_FRIENDLY_NAME_LEN` (32)
		// characters and happens to be the secret's own leading 32 sanitized
		// characters must still be treated as a collision — otherwise those 32
		// characters are accepted and baked into the placeholder verbatim as a
		// visible, secret-derived prefix (e.g.
		// "#GITHUBPATABCDEFGHIJKLMNOPQRSTUVW_<hash>:L#").
		const longSecret = "github_pat_abcdefghijklmnopqrstuvwxyz0123456789";
		const leakedPrefix = "GITHUBPATABCDEFGHIJKLMNOPQRSTUVW"; // first 32 sanitized chars of longSecret
		const obfuscator = new SecretObfuscator([{ type: "plain", content: longSecret, friendlyName: leakedPrefix }]);
		const obfuscated = obfuscator.obfuscate(longSecret);

		expect(obfuscated).not.toContain(leakedPrefix);
		expect(obfuscated).toMatch(/^\$\$[A-Z0-9]+:L\$\$$/);
		expect(obfuscator.deobfuscate(obfuscated)).toBe(longSecret);
	});

	it("uses regex entry friendly names for discovered matches", () => {
		const secret = "tok_abc123";
		const obfuscator = new SecretObfuscator([{ type: "regex", content: "tok_[a-z0-9]+", friendlyName: "API Key" }]);
		const input = `use ${secret} please`;
		const obfuscated = obfuscator.obfuscate(input);

		expect(obfuscated).toMatch(/\$\$APIKEY_[A-Z0-9]+:L\$\$/);
		expect(obfuscated).not.toContain(secret);
		expect(obfuscator.deobfuscate(obfuscated)).toBe(input);
	});

	it("rejects a regex entry friendlyName that is itself a live match for its own pattern", () => {
		// `#friendlyNameCollidesWithSecret` used to run each regex entry's pattern
		// against the SANITIZED friendly name (uppercased, non-alphanumeric
		// stripped) instead of the raw one. A case-sensitive/punctuated pattern
		// like `tok_[a-z0-9]+` requires a literal lowercase underscore, so it could
		// never match the sanitized label "TOKABC123" even though the raw
		// friendlyName "tok_abc123" is itself a live match for that very pattern.
		// That let a secret-shaped friendlyName slip through and get stamped
		// (minus separators, uppercased) into every placeholder minted for it. The
		// check now runs the pattern against the raw, pre-sanitization
		// friendlyName, so this case is caught and the secret falls back to a bare
		// placeholder.
		const secret = "tok_abc123";
		const obfuscator = new SecretObfuscator([
			{ type: "regex", content: "tok_[a-z0-9]+", friendlyName: "tok_abc123" },
		]);
		const input = `use ${secret} now`;
		const obfuscated = obfuscator.obfuscate(input);

		expect(obfuscated).not.toMatch(/TOKABC123_/);
		expect(obfuscated).toMatch(/^use \$\$[A-Z0-9]+:L\$\$ now$/);
		expect(obfuscator.deobfuscate(obfuscated)).toBe(input);
	});

	it("rejects a regex entry friendlyName that is the normalized form of a value the regex discovers", () => {
		// `#friendlyNameCollidesWithSecret` also used to test the RAW friendlyName
		// directly against the regex entry's own pattern. That misses labels which
		// are already normalized (uppercased, separators stripped): "TOKABC123"
		// has no lowercase letters or underscore, so it can never match the
		// case-sensitive, punctuated pattern `tok_[a-z0-9]+` directly - even though
		// "TOKABC123" is exactly the normalized rendering of "tok_abc123", a value
		// that pattern actually discovers. Nothing compared the label against the
		// literal match either, so this friendlyName slipped through and got
		// stamped into the placeholder. The check now also compares the sanitized
		// label against the sanitized value of the current secret being minted,
		// catching this on the secret's very first mint.
		const obfuscator = new SecretObfuscator([{ type: "regex", content: "tok_[a-z0-9]+", friendlyName: "TOKABC123" }]);
		const input = "use tok_abc123 now";
		const obfuscated = obfuscator.obfuscate(input);

		expect(obfuscated).not.toMatch(/TOKABC123_/);
		expect(obfuscated).toMatch(/^use \$\$[A-Z0-9]+:L\$\$ now$/);
		expect(obfuscator.deobfuscate(obfuscated)).toBe(input);
	});

	it("omits an unrelated regex entry's friendly label that normalizes to a value a later regex entry discovers in the same input", () => {
		// Earlier coverage only caught a regex entry's friendlyName colliding with
		// its own pattern/value. Regex placeholders are minted lazily in entries[]
		// order, so an unrelated entry listed first could stamp a normalized form
		// of a later regex match into its placeholder before that later entry
		// discovered the raw value in the same input. The upfront input scan keeps
		// labels from exposing any regex-protected value present in this pass,
		// regardless of entry order.
		const obfuscator = new SecretObfuscator([
			{ type: "regex", content: "zeta_[a-z0-9]+", friendlyName: "TOKABC123" },
			{ type: "regex", content: "tok_[a-z0-9]+" },
		]);
		const input = "use zeta_secret1 and tok_abc123 now";
		const obfuscated = obfuscator.obfuscate(input);

		expect(obfuscated).not.toContain("TOKABC123_");
		expect(obfuscated).not.toContain("zeta_secret1");
		expect(obfuscated).not.toContain("tok_abc123");
		expect(obfuscated).toMatch(/^use \$\$[A-Z0-9]{4,}(?::[ULCM])?\$\$ and \$\$[A-Z0-9]{4,}(?::[ULCM])?\$\$ now$/);
		expect(obfuscator.deobfuscate(obfuscated)).toBe(input);
	});

	it("omits an unrelated regex entry's friendly label that normalizes to a regex-protected value produced by a plain replace mapping", () => {
		// Regression: the upfront regex-secret scan that seeds the friendly-label
		// collision set only ran once, against the ORIGINAL input, before plain
		// replace-mode mappings execute. A replace-mode plain secret can emit
		// text a later regex entry protects (here `X` -> `tok_abc123`, discovered
		// by `tok_[a-z0-9]+`) even though that exact text never appeared in the
		// raw input. Without also re-scanning the POST-replace text, an unrelated
		// regex entry's friendlyName that normalizes to that produced value still
		// got stamped into its placeholder. The obfuscator now merges regex
		// matches collected after the replace phase into the same collision set.
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: "X", mode: "replace", replacement: "tok_abc123" },
			{ type: "regex", content: "zeta_[a-z0-9]+", friendlyName: "TOKABC123" },
			{ type: "regex", content: "tok_[a-z0-9]+" },
		]);
		const input = "use X and zeta_secret1 now";
		const obfuscated = obfuscator.obfuscate(input);

		expect(obfuscated).not.toContain("TOKABC123_");
		expect(obfuscated).not.toContain("zeta_secret1");
		expect(obfuscated).not.toContain("tok_abc123");
		expect(obfuscated).toMatch(/^use \$\$[A-Z0-9]{4,}(?::[ULCM])?\$\$ and \$\$[A-Z0-9]{4,}(?::[ULCM])?\$\$ now$/);
		// Deobfuscation restores the two obfuscate-mode (regex-discovered)
		// placeholders to the values that were actually matched — the replace-
		// produced `tok_abc123` and the raw `zeta_secret1` — but the one-way
		// replace mapping never restores `X` itself.
		expect(obfuscator.deobfuscate(obfuscated)).toBe("use tok_abc123 and zeta_secret1 now");
	});

	it("omits an unrelated regex entry's friendly label that normalizes to a regex-protected value produced by a regex replace mapping", () => {
		// Regression: same upfront-collision-set gap as the plain-replace case
		// above, but the value-producing entry is itself a REGEX replace mapping
		// (`X` -> `tok_abc123` via `{ type: "regex", mode: "replace" }`) rather
		// than a plain replace secret. The regex-entries loop processes entries
		// in order and must merge newly discovered regex-protected values into
		// the friendly-label collision set after EACH replace-mode regex entry
		// runs, so the unrelated `zeta_[a-z0-9]+` entry's friendlyName
		// "TOKABC123" must still be rejected even though `tok_abc123` never
		// appeared in the raw input — it only exists because the regex replace
		// entry ahead of it produced it.
		const obfuscator = new SecretObfuscator([
			{ type: "regex", mode: "replace", content: "X", replacement: "tok_abc123" },
			{ type: "regex", content: "zeta_[a-z0-9]+", friendlyName: "TOKABC123" },
			{ type: "regex", content: "tok_[a-z0-9]+" },
		]);
		const input = "use X and zeta_secret1 now";
		const obfuscated = obfuscator.obfuscate(input);

		expect(obfuscated).not.toContain("TOKABC123_");
		expect(obfuscated).not.toContain("zeta_secret1");
		expect(obfuscated).not.toContain("tok_abc123");
		expect(obfuscated).toMatch(/^use \$\$[A-Z0-9]{4,}(?::[ULCM])?\$\$ and \$\$[A-Z0-9]{4,}(?::[ULCM])?\$\$ now$/);
		// Deobfuscation restores the two obfuscate-mode (regex-discovered)
		// placeholders to the values that were actually matched — the
		// regex-replace-produced `tok_abc123` and the raw `zeta_secret1` — but
		// the one-way regex replace mapping never restores the original `X`.
		expect(obfuscator.deobfuscate(obfuscated)).toBe("use tok_abc123 and zeta_secret1 now");
	});

	it("omits a plain secret's own friendly label that normalizes to a regex-protected value produced by a later regex replace mapping", () => {
		// Regression: the two collision-set gaps above cover an UNRELATED regex
		// entry's friendlyName colliding with a later-produced regex-protected
		// value. This covers a PLAIN obfuscate-mode secret's OWN friendlyName.
		// Plain obfuscate secrets mint their placeholder in the CONSTRUCTOR —
		// before `obfuscate()` ever runs and forecasts post-replace regex
		// values into `#currentRegexSecretValues` — so a friendlyName that
		// merely normalizes to a value a LATER regex replace mapping produces
		// (here `X` -> `tok_abc123`, protected by `tok_[a-z0-9]+`) can get
		// baked into the placeholder at mint time even though `tok_abc123`
		// never appears in the raw input. The obfuscator must re-check the
		// baked-in friendly prefix against the freshly forecasted collision
		// set on every `obfuscate()` call and fall back to a bare placeholder
		// when it collides, so the friendly prefix never exposes the
		// normalized future regex secret.
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: "OTHERSECRET", friendlyName: "TOKABC123" },
			{ type: "regex", mode: "replace", content: "X", replacement: "tok_abc123" },
			{ type: "regex", content: "tok_[a-z0-9]+" },
		]);
		const input = "use OTHERSECRET and X now";
		const obfuscated = obfuscator.obfuscate(input);

		expect(obfuscated).not.toContain("TOKABC123_");
		expect(obfuscated).not.toContain("OTHERSECRET");
		expect(obfuscated).not.toContain("tok_abc123");
		expect(obfuscated).toMatch(/^use \$\$[A-Z0-9]{4,}:U\$\$ and \$\$[A-Z0-9]{4,}:L\$\$ now$/);
		// Deobfuscation restores the plain secret's placeholder to `OTHERSECRET`
		// and the regex-discovered placeholder to the value actually matched
		// (`tok_abc123`); the one-way regex replace mapping never restores `X`.
		expect(obfuscator.deobfuscate(obfuscated)).toBe("use OTHERSECRET and tok_abc123 now");
	});

	it("omits a plain secret's own friendly label that normalizes to a regex-protected value produced through a DEFAULT (no custom replacement) regex replace hop", () => {
		// Regression: the forecast above only ever simulated CUSTOM-replacement
		// regex replace entries (`entry.replacement !== undefined`). A DEFAULT
		// replace-mode entry (no `replacement` configured) still produces
		// deterministic output — `X` (one byte) always redacts to `Z` — and that
		// output can itself be the trigger a LATER replace entry needs to fire.
		// Here `X` -> `Z` is the default hop, and only `Z` -> `tok_abc123` (a
		// second, custom-replacement entry) actually produces the
		// `tok_[a-z0-9]+`-protected value. Skipping the default hop means the
		// forecast never sees `Z` in the simulated text, so the second entry
		// never matches and `tok_abc123` is never simulated — the plain secret's
		// own friendlyName "TOKABC123" (which normalizes to that same value)
		// wrongly survives into its placeholder. The forecast must simulate the
		// default hop's own deterministic output too, not just custom
		// replacements, before checking friendly labels.
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: "OTHERSECRET", friendlyName: "TOKABC123" },
			{ type: "regex", mode: "replace", content: "X" },
			{ type: "regex", mode: "replace", content: "Z", replacement: "tok_abc123" },
			{ type: "regex", content: "tok_[a-z0-9]+" },
		]);
		const input = "use OTHERSECRET and X now";
		const obfuscated = obfuscator.obfuscate(input);

		expect(obfuscated).not.toContain("TOKABC123_");
		expect(obfuscated).not.toContain("OTHERSECRET");
		expect(obfuscated).not.toContain("tok_abc123");
		expect(obfuscated).toMatch(/^use \$\$[A-Z0-9]{4,}:U\$\$ and \$\$[A-Z0-9]{4,}:L\$\$ now$/);
		// Deobfuscation restores the plain secret's placeholder to `OTHERSECRET`
		// and the regex-discovered placeholder to the value actually matched
		// (`tok_abc123`); the default `X` -> `Z` hop is one-way, so neither `X`
		// nor the intermediate `Z` marker is ever restored.
		expect(obfuscator.deobfuscate(obfuscated)).toBe("use OTHERSECRET and tok_abc123 now");
	});

	it("strips an unsafe prefix from an unknown historical friendly placeholder", () => {
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: "OTHERSECRET", friendlyName: "TOKABC123" },
			{ type: "regex", content: "tok_[a-z0-9]+" },
		]);
		const stalePlaceholder = "$$TOKABC123_OLDHASH:L$$";

		expect(obfuscator.stripUnsafeFriendlyPlaceholderPrefixes(stalePlaceholder, new Set(["tok_abc123"]))).toBe(
			"$$OLDHASH:L$$",
		);
	});
	it("strips unsafe prefixes from overlapping historical placeholders", () => {
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: "OTHERSECRET", friendlyName: "TOKABC123" },
			{ type: "regex", content: "tok_[a-z0-9]+" },
		]);
		const stalePlaceholders = "$$FOOO$$$$TOKABC123_OLDHASH:L$$";

		expect(obfuscator.stripUnsafeFriendlyPlaceholderPrefixes(stalePlaceholders, new Set(["tok_abc123"]))).toBe(
			"$$FOOO$$$$OLDHASH:L$$",
		);
	});

	it("strips an already-obfuscated placeholder's unsafe friendly prefix carried in from earlier history when a later input reveals the regex-protected value it normalizes to", () => {
		// Regression: the two same-call forecasts above only re-check a friendly
		// prefix at the moment its placeholder is FIRST substituted into THIS
		// call's output, against a collision set forecasted from THIS call's own
		// input. A friendly placeholder minted in an EARLIER call — before
		// `tok_abc123` had ever appeared anywhere — is baked into provider-visible
		// history and re-enters a LATER `obfuscate()` call verbatim as part of the
		// input text (the SDK re-obfuscates the whole message array every turn).
		// The obfuscator must re-check that ALREADY-PRESENT placeholder's baked-in
		// prefix against the freshly forecasted collision set on every call too —
		// not just newly minted placeholders — and fall back to the
		// friendly-name-independent bare alias once a later turn's regex-protected
		// value normalizes to that prefix. Copying the placeholder verbatim would
		// leave "TOKABC123_" standing in for `tok_abc123`, the very value the
		// `tok_[a-z0-9]+` regex is configured to hide.
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: "OTHERSECRET", friendlyName: "TOKABC123" },
			{ type: "regex", content: "tok_[a-z0-9]+" },
		]);

		// Turn 1: tok_abc123 has not appeared anywhere yet, so "TOKABC123" is not
		// a collision — the friendly prefix is applied and persisted into history.
		const turn1 = obfuscator.obfuscate("use OTHERSECRET now");
		expect(turn1).toMatch(/^use \$\$TOKABC123_[A-Z0-9]+:U\$\$ now$/);
		const oldPlaceholder = turn1.match(/\$\$TOKABC123_[A-Z0-9]+:U\$\$/)![0];
		const bareAlias = oldPlaceholder.replace(/^\$\$TOKABC123_/, "$$");

		// Turn 2: the already-obfuscated turn-1 output re-enters as prior history
		// alongside NEW text that reveals tok_abc123 — a regex-protected value that
		// normalizes to exactly the prefix already baked into the turn-1 placeholder.
		const turn2Input = `${turn1} and now use tok_abc123`;
		const turn2 = obfuscator.obfuscate(turn2Input);

		expect(turn2).not.toContain("TOKABC123_");
		expect(turn2).not.toContain(oldPlaceholder);
		expect(turn2).not.toContain("tok_abc123");
		// The preserved placeholder is re-emitted as its bare, friendly-name-independent alias.
		expect(turn2).toContain(bareAlias);
		// OTHERSECRET still round-trips via the bare alias, and the newly
		// discovered regex secret restores to the value actually matched.
		expect(obfuscator.deobfuscate(turn2)).toBe("use OTHERSECRET now and now use tok_abc123");
		// Stripping the unsafe prefix is itself a fixed point: a further pass must
		// not resurrect the friendly prefix or otherwise change the bytes.
		expect(obfuscator.obfuscate(turn2)).toBe(turn2);
	});

	it("does not replace plain secrets inside generated friendly placeholders", () => {
		const longSecret = "long-secret-token";
		const prefixSecret = "TOKENABC";
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: longSecret, friendlyName: "token" },
			{ type: "plain", content: prefixSecret },
		]);
		const input = `${longSecret} ${prefixSecret}`;
		const obfuscated = obfuscator.obfuscate(input);

		expect(obfuscated).toMatch(/^\$\$TOKEN_[A-Z0-9]+:L\$\$ \$\$[A-Z0-9]+:U\$\$$/);
		expect(obfuscated).not.toContain(longSecret);
		expect(obfuscator.deobfuscate(obfuscated)).toBe(input);
	});

	it("redacts configured secrets that already look like placeholders", () => {
		const secret = "#PASSWORD123#";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);
		const obfuscated = obfuscator.obfuscate(`value ${secret}`);

		expect(obfuscated).not.toContain(secret);
		expect(obfuscated).toMatch(/^value \$\$[A-Z0-9]+:U\$\$$/);
		expect(obfuscator.deobfuscate(obfuscated)).toBe(`value ${secret}`);
	});

	it("redacts regex matches after rejected placeholder-shaped text", () => {
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: "ABCDEFGH" },
			{ type: "regex", content: "SECRET[A-Z]{12}", mode: "replace" },
		]);

		const obfuscated = obfuscator.obfuscate("#SECRETUVKABCDEFGHI");

		expect(obfuscated).not.toContain("SECRET");
		expect(obfuscated).not.toContain("ABCDEFGH");
	});

	it("redacts regex matches that span known placeholders", () => {
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: "abcdefgh" },
			{ type: "regex", content: "api_key=\\S+", friendlyName: "api-key" },
		]);

		const obfuscated = obfuscator.obfuscate("api_key=abcdefghXYZ");

		expect(obfuscated).toMatch(/^\$\$APIKEY_[A-Z0-9]+:M\$\$$/);
		expect(obfuscated).not.toContain("abcdefgh");
		expect(obfuscator.deobfuscate(obfuscated)).toBe("api_key=abcdefghXYZ");
	});

	it("redacts bounded obfuscate regex spans around generated placeholders", () => {
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: "abcdefgh" },
			{ type: "regex", content: "api_key=[A-Za-z0-9]{11}", friendlyName: "api-key" },
		]);

		const obfuscated = obfuscator.obfuscate("api_key=abcdefghXYZ");

		expect(obfuscated).toMatch(/^\$\$APIKEY_[A-Z0-9]+:M\$\$$/);
		expect(obfuscated).not.toContain("abcdefgh");
		expect(obfuscator.deobfuscate(obfuscated)).toBe("api_key=abcdefghXYZ");
	});
	it("obfuscates bounded regex remainders around prior placeholders", () => {
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: "abcdefgh" },
			{ type: "regex", content: "api_key=[A-Za-z0-9]{11}", friendlyName: "api-key" },
		]);
		const token = obfuscator.obfuscate("abcdefgh");

		const obfuscated = obfuscator.obfuscate(`api_key=${token}XYZ`);

		expect(obfuscated).not.toContain("api_key=");
		expect(obfuscated).not.toContain("XYZ");
		expect(obfuscated).toContain(token);
		expect(obfuscator.deobfuscate(obfuscated)).toBe("api_key=abcdefghXYZ");
		expect(obfuscator.obfuscate(obfuscated)).toBe(obfuscated);
	});

	it("skips sub-threshold obfuscate regex matches that straddle a generated placeholder", () => {
		// `[A-Z]{6}` only ever matches 6 chars — below MIN_OBFUSCATE_SECRET_LEN — but
		// when a match overlaps the plain secret's placeholder its range is extended
		// across the whole `#…#` token. Guarding on that rewritten span (instead of
		// the regex's own match length) let the short match re-placeholder across the
		// token and corrupt round-trip deobfuscation (e.g. "XXSECRETUVYY" dropping to
		// "XXSECRETUV"). The plain secret must stay hidden, the surrounding literals
		// must survive, and the round trip must be exact.
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: "SECRETUV" },
			{ type: "regex", content: "[A-Z]{6}" },
		]);

		const obfuscated = obfuscator.obfuscate("XXSECRETUVYY");

		expect(obfuscated).not.toContain("SECRETUV");
		expect(obfuscated.startsWith("XX")).toBe(true);
		expect(obfuscated.endsWith("YY")).toBe(true);
		expect(obfuscator.deobfuscate(obfuscated)).toBe("XXSECRETUVYY");
		// Re-obfuscation MUST be a fixed point: a sub-threshold match straddling the
		// now-input placeholder must not rewrite the surrounding context into fresh
		// placeholders, or provider-visible history and prompt-cache prefixes drift.
		expect(obfuscator.obfuscate(obfuscated)).toBe(obfuscated);
	});

	it("leaves placeholders intact when a regex match cuts across their expanded value", () => {
		// `[A-Z]{8}` meets MIN_OBFUSCATE_SECRET_LEN, but on "YYBBABCDEFGHSECRETUV"
		// (plain secret `ABCDEFGH`) its greedy 8-char matches start/end inside the
		// secret's placeholder expansion ("YYBBABCD", "EFGHSECR"). Snapping each to
		// the whole `#…#` token mapped them to overlapping ranges that clobbered on
		// apply and dropped the `SECR` bytes (round-trip restored "YYBBABCDEFGHETUV").
		// The scan now resumes past the cut placeholder instead, so the secret stays
		// hidden, no bytes are lost, the trailing 8-char run is obfuscated on its own,
		// and re-obfuscation is a fixed point.
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: "ABCDEFGH" },
			{ type: "regex", content: "[A-Z]{8}" },
		]);

		const obfuscated = obfuscator.obfuscate("YYBBABCDEFGHSECRETUV");

		expect(obfuscated).not.toContain("ABCDEFGH");
		expect(obfuscated).not.toContain("SECRETUV");
		expect(obfuscator.deobfuscate(obfuscated)).toBe("YYBBABCDEFGHSECRETUV");
		expect(obfuscator.obfuscate(obfuscated)).toBe(obfuscated);
	});

	it("keeps the full cut-match length when a regex match's outside prefix is clamped below the short-match floor", () => {
		// Regression: when an obfuscate-mode regex match starts before an
		// already-generated placeholder and gets clamped down to just the
		// wholly-outside prefix portion before that placeholder, the short-match
		// guard (MIN_OBFUSCATE_SECRET_LEN) must measure the FULL original match
		// length in the expanded scan view, not the shorter clamped-prefix length.
		// Reusing the sibling "[A-Z]{8}" straddle above but split across two
		// obfuscate() calls (same instance/key, so the first call's placeholder is
		// recognized as already-generated on the second): call 1 mints ABCDEFGH's
		// placeholder alone; call 2 re-scans "YYBB" immediately followed by that
		// placeholder, and the SAME "[A-Z]{8}" regex re-matches across "YYBB" plus
		// the placeholder's expanded value, clamping to just the 4-byte "YYBB"
		// prefix. Before the fix, that clamped 4-byte length (not the true 8-byte
		// full match) was checked against the floor, so "YYBB" was wrongly skipped
		// as too short and left raw/unredacted in the output.
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: "ABCDEFGH" },
			{ type: "regex", content: "[A-Z]{8}" },
		]);

		const placeholder = obfuscator.obfuscate("ABCDEFGH");
		expect(placeholder).not.toContain("ABCDEFGH");

		const second = obfuscator.obfuscate(`YYBB${placeholder}`);

		expect(second).not.toContain("YYBB");
		expect(obfuscator.deobfuscate(second)).toBe("YYBBABCDEFGH");
	});

	it("keeps replace regexes from rewriting placeholders their match cuts across", () => {
		// Same partial-placeholder cut as above but in replace mode: `[A-Z]{8}`
		// matches straddle the `ABCDEFGH` placeholder. Redacting only the bytes
		// outside the snapped token was not a fixed point — the deterministic scramble
		// of the prefix drifted across re-obfuscation passes ("ZZgK…" → "ZZgZ…"). The
		// scan now resumes past the cut placeholder, so the cut secret stays hidden as
		// its placeholder, the trailing 8-char run is redacted on its own, and
		// re-obfuscation is stable.
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: "ABCDEFGH" },
			{ type: "regex", content: "[A-Z]{8}", mode: "replace" },
		]);

		const obfuscated = obfuscator.obfuscate("YYBBABCDEFGHSECRETUV");

		expect(obfuscated).not.toContain("ABCDEFGH");
		expect(obfuscated).not.toContain("SECRETUV");
		expect(obfuscator.obfuscate(obfuscated)).toBe(obfuscated);
	});

	it("replace-mode re-obfuscation is a fixed point when a spillover match straddles a prior-call placeholder whose value satisfies the regex", () => {
		// `[A-Z0-9]{8,12}` in replace mode greedily spans `SECRETUV` into the
		// `ABCDEFGH` placeholder on re-obfuscation — `ABCDEFGH` alone satisfies the
		// regex. Previously the short non-matching spillover bytes abutting the
		// placeholder were fed into the deterministic scramble on every pass
		// (e.g. `…#…#ZZJ5sotJ` → `…#…#ZZpvsotJ`), invalidating provider prompt-cache
		// prefixes despite no new input. The fix: when a replace match straddles a
		// placeholder whose own deobfuscated value satisfies the regex, the surrounding
		// spillover bytes are left verbatim instead of being re-scrambled.
		const obf = new SecretObfuscator(
			[
				{ type: "plain", content: "ABCDEFGH" },
				{ type: "regex", content: "[A-Z0-9]{8,12}", mode: "replace" },
			],
			"Q".repeat(43),
		);
		const first = obf.obfuscate("YYBBABCDEFGHSECRETUV");

		// Core regression: re-obfuscation must be a fixed point.
		expect(obf.obfuscate(first)).toBe(first);
		// Stable across multiple passes.
		expect(obf.obfuscate(obf.obfuscate(first))).toBe(first);
		// Plain secret must not leak into provider-visible output.
		expect(first).not.toContain("ABCDEFGH");
	});

	it("redacts an independently matching prefix before a cut placeholder", () => {
		// A regex match that starts in outside text and ends inside a generated
		// placeholder's expanded value is not rewritten across the token (that drops
		// bytes / drifts the redaction). But when the wholly-outside prefix before the
		// placeholder is itself a complete match it is provider-visible secret-shaped
		// content, not a drift artifact. Regression: `[A-Z0-9]{8,12}` greedily
		// spanning `SECRETUV` into an `ABCDEFGH` placeholder returned `SECRETUV#…#`,
		// leaving `SECRETUV` visible even though it independently satisfies the regex.
		// Obfuscate mode: the prefix gets its own reversible placeholder and the whole
		// input still round-trips.
		const obf = new SecretObfuscator(
			[
				{ type: "plain", content: "ABCDEFGH" },
				{ type: "regex", content: "[A-Z0-9]{8,12}" },
			],
			"Q".repeat(43),
		);
		const out = obf.obfuscate("SECRETUVABCDEFGH");
		expect(out).not.toContain("SECRETUV");
		expect(out).not.toContain("ABCDEFGH");
		expect(obf.deobfuscate(out)).toBe("SECRETUVABCDEFGH");
		expect(obf.obfuscate(out)).toBe(out);

		// Replace mode: the prefix is redacted one-way while the cut secret's
		// placeholder is preserved and still restores.
		const repl = new SecretObfuscator(
			[
				{ type: "plain", content: "ABCDEFGH" },
				{ type: "regex", content: "[A-Z0-9]{8,12}", mode: "replace" },
			],
			"Q".repeat(43),
		);
		const rout = repl.obfuscate("SECRETUVABCDEFGH");
		expect(rout).not.toContain("SECRETUV");
		expect(rout).not.toContain("ABCDEFGH");
		expect(repl.deobfuscate(rout)).toMatch(/ABCDEFGH$/);
		expect(repl.deobfuscate(rout)).not.toContain("SECRETUV");
		expect(repl.obfuscate(rout)).toBe(rout);
	});

	it("re-obfuscation is a fixed point when a greedy regex would spill into a trailing raw chunk around a prior-call placeholder", () => {
		// `[A-Z0-9]{8,12}` greedily matches `SECRETUVA` (9 chars) when the SECRETUV
		// placeholder is followed by the raw literal `A`. Previously the spillover
		// caused that short surrounding chunk to be minted into a fresh placeholder on
		// every subsequent obfuscate() call, drifting provider-visible history and the
		// prompt-cache prefix. The fix: a surrounding raw chunk is only obfuscated when
		// the placeholder's own deobfuscated value does NOT independently satisfy the
		// regex; when it does (greedy spillover), the surrounding bytes stay verbatim.
		const obf = new SecretObfuscator(
			[
				{ type: "plain", content: "ABCDEFGH" },
				{ type: "plain", content: "SECRETUV" },
				{ type: "regex", content: "[A-Z0-9]{8,12}" },
			],
			"Q".repeat(43),
		);
		const first = obf.obfuscate("ZZZZZZZZABCDEFGHSECRETUVA");

		// Core regression: re-obfuscation must be a fixed point.
		expect(obf.obfuscate(first)).toBe(first);
		// Round-trip must restore every byte of the original input.
		expect(obf.deobfuscate(first)).toBe("ZZZZZZZZABCDEFGHSECRETUVA");
		// The trailing `A` must survive the first pass verbatim: SECRETUV alone
		// satisfies [A-Z0-9]{8,12}, so the short tail must not be placeholdered.
		expect(first.endsWith("A")).toBe(true);
		// Plain secrets must not appear in provider-visible output.
		expect(first).not.toContain("SECRETUV");
		expect(first).not.toContain("ABCDEFGH");
	});

	it("first obfuscate() call already matches later calls when a bounded exact-quantifier regex spills past two adjacent placeholders", () => {
		// `[A-Z]{9}` (an EXACT quantifier, unlike the `{8,12}` RANGE case above) over
		// `ABCDEFGH` + `SECRETUV` + trailing raw `A`: the placeholder's OWN value
		// (`SECRETUV`, 8 chars) does NOT independently satisfy `{9}`, so this exercises
		// a different path than the independently-matching-spillover case. Previously
		// a cut-resolution resume point that landed exactly on the START of the
		// SECRETUV placeholder was handed straight to a fresh regex.exec instead of
		// being chained past it too: the FIRST obfuscate() call treated the still-raw
		// ABCDEFGH prefix as its own match and resumed right after it, leaving the
		// trailing `A` untouched — but a SECOND call, with ABCDEFGH already a
		// placeholder, started its match attempt inside the placeholder run, could not
		// be prefix-narrowed, and resumed mid-run instead of past it, exposing the
		// shorter tail `SECRETUV` + `A` to a clean match the first call never
		// attempted, minting a brand-new placeholder for `A` and drifting
		// provider-visible history / the prompt-cache prefix across the call-1-to-2
		// transition. The fix chains the resume point through every immediately
		// adjacent generated-placeholder segment, so both calls land on the same
		// resolution from the very first pass.
		const obf = new SecretObfuscator(
			[
				{ type: "plain", content: "ABCDEFGH" },
				{ type: "plain", content: "SECRETUV" },
				{ type: "regex", content: "[A-Z]{9}" },
			],
			"Q".repeat(43),
		);
		const first = obf.obfuscate("ZZZZZZZZABCDEFGHSECRETUVA");

		// The trailing `A` must survive the FIRST pass verbatim.
		expect(first.endsWith("A")).toBe(true);
		// Core regression: re-obfuscation must already be a fixed point from the
		// very first call — this used to be false, turning `A` into a new placeholder
		// on the second call.
		expect(obf.obfuscate(first)).toBe(first);
		// Stable across multiple passes.
		expect(obf.obfuscate(obf.obfuscate(first))).toBe(first);
		// Round-trip must restore every byte of the original input.
		expect(obf.deobfuscate(first)).toBe("ZZZZZZZZABCDEFGHSECRETUVA");
	});

	it("keeps a default replace regex a fixed point on the first pass when raw text flanks a generated placeholder on both sides", () => {
		// `[A-Z]{9}` (exact quantifier) over raw `X` + plain secret `SECRETUV`
		// (minted fresh this call, 8 chars) + raw `Y`: the greedy left-to-right
		// match on the FIRST pass is exactly "XSECRETUV" (the 1-char raw prefix
		// plus the whole placeholder's expanded value), so the scan resumes right
		// past it and the trailing `Y` — only 1 char, short of the exact {9}
		// quantifier — was left raw and unredacted (`a#…#Y`). Once the prefix
		// redacts to a non-uppercase marker, a SECOND pass re-aligns the same
		// regex to match "SECRETUVY" instead (placeholder + the now-exposed raw
		// suffix) and redacts `Y` for the first time — drifting provider-visible
		// history and the prompt-cache prefix across the call-1-to-2 transition
		// (`a#…#Y` -> `a#…#a`). The fix must already redact both flanking chunks
		// on the very first pass so obfuscate() is a fixed point from the start.
		const obf = new SecretObfuscator(
			[
				{ type: "plain", content: "SECRETUV" },
				{ type: "regex", mode: "replace", content: "[A-Z]{9}" },
			],
			"Q".repeat(43),
		);

		const first = obf.obfuscate("XSECRETUVY");

		// The plain secret must never survive in provider-visible output.
		expect(first).not.toContain("SECRETUV");
		// Core regression: the trailing raw suffix must already be redacted on
		// the FIRST pass instead of surviving verbatim until a second call
		// re-aligns the match around it.
		expect(first.endsWith("Y")).toBe(false);
		// Core regression: re-obfuscation must already be a fixed point from the
		// very first call — this used to be false (`a#…#Y` -> `a#…#a`).
		expect(obf.obfuscate(first)).toBe(first);
		// Stable across multiple passes.
		expect(obf.obfuscate(obf.obfuscate(first))).toBe(first);

		// Deobfuscating restores the plain secret (reversible), but the regex's
		// one-way replace-mode redaction never restores the raw flanking bytes
		// it consumed — that is the correct, appropriate behavior for replace
		// mode.
		const restored = obf.deobfuscate(first);
		expect(restored).toContain("SECRETUV");
		expect(restored).not.toBe("XSECRETUVY");
	});

	it("redacts a two-sided independently matching chunk instead of leaking it as spillover", () => {
		// `\b[A-Z]{8}\b|[A-Z]{17}` union regex, prior-call placeholder for `SECRETUV`
		// flanked by prefix `ABCDEFGH` (independently matches `\b[A-Z]{8}\b`) and
		// suffix `I` (matches nothing alone). The straddling match is the 17-char
		// run `ABCDEFGH` + `SECRETUV` + `I`, which previously tested the concatenated
		// outside chunks `"ABCDEFGH" + "I"` = `"ABCDEFGHI"` against the regex — that
		// concatenation erases the placeholder-token boundary between the chunks, so
		// neither alternative matches (9 chars, and `H` is no longer at a word
		// boundary), and the whole match was left verbatim, leaking `ABCDEFGH`
		// unredacted. The fix tests each outside chunk in its own real, flanked
		// context: `ABCDEFGH` alone still independently matches `\b[A-Z]{8}\b`, so it
		// is redacted instead of leaked.
		const obf = new SecretObfuscator(
			[
				{ type: "plain", content: "SECRETUV" },
				{ type: "regex", content: "\\b[A-Z]{8}\\b|[A-Z]{17}" },
			],
			"Q".repeat(43),
		);
		const placeholdered = obf.obfuscate("SECRETUV");
		const second = obf.obfuscate(`ABCDEFGH${placeholdered}I`);

		// Core regression: the independently matching prefix must not survive
		// verbatim in provider-visible output.
		expect(second).not.toContain("ABCDEFGH");
		expect(second).not.toContain("SECRETUV");
		// Every byte must still round-trip.
		expect(obf.deobfuscate(second)).toBe("ABCDEFGHSECRETUVI");
		// Redacting the prefix must itself be a fixed point.
		expect(obf.obfuscate(second)).toBe(second);
	});

	it("leaves a genuine one-sided spillover chunk verbatim under the same union regex", () => {
		// Contrast case for the fix above: the trailing chunk `IJKLMNOPQ` (9 chars)
		// does NOT independently match `\b[A-Z]{8}\b|[A-Z]{17}` on its own, and only
		// forms a match by bridging across the `SECRETUV` placeholder (`SECRETUV` +
		// `IJKLMNOPQ` = 17 chars). This is genuine greedy spillover, not independent
		// secret-shaped content, so per-chunk testing must still leave it verbatim
		// and a fixed point — the fix must not turn spillover into a false positive.
		const obf = new SecretObfuscator(
			[
				{ type: "plain", content: "SECRETUV" },
				{ type: "regex", content: "\\b[A-Z]{8}\\b|[A-Z]{17}" },
			],
			"Q".repeat(43),
		);
		const placeholdered = obf.obfuscate("SECRETUV");
		const second = obf.obfuscate(`${placeholdered}IJKLMNOPQ`);

		expect(second.endsWith("IJKLMNOPQ")).toBe(true);
		expect(obf.deobfuscate(second)).toBe("SECRETUVIJKLMNOPQ");
		expect(obf.obfuscate(second)).toBe(second);
	});

	it("redacts a lookbehind-anchored prefix tested in its real source context instead of leaking it", () => {
		// `(?<=api=)[0-9]{8}[A-Z]{8}|(?<=api=)[0-9]{8}|[A-Z]{8}` combined with a
		// prior-call placeholder for `ABCDEFGH` (independently matches the bare
		// `[A-Z]{8}` alternative). Re-obfuscating `api=12345678` + placeholder makes
		// the full match (placeholder expanded) `12345678ABCDEFGH`, preceded by the
		// literal `api=`. The outside chunk is `12345678`. Testing that chunk as an
		// ISOLATED slice (starting a fresh string at index 0) loses the real `api=`
		// bytes immediately before it in the source, so `(?<=api=)[0-9]{8}` never
		// fires, none of the three alternatives match a bare "12345678", and the
		// digits were wrongly left verbatim — a lookbehind-blind leak. The fix tests
		// the chunk against the regex at its REAL position in the full text, where
		// the lookbehind correctly sees the preceding `api=` and the chunk is
		// identified as an independent match, so it is redacted like any other
		// secret-shaped content.
		const obf = new SecretObfuscator(
			[
				{ type: "plain", content: "ABCDEFGH" },
				{ type: "regex", content: "(?<=api=)[0-9]{8}[A-Z]{8}|(?<=api=)[0-9]{8}|[A-Z]{8}" },
			],
			"Q".repeat(43),
		);
		const placeholdered = obf.obfuscate("ABCDEFGH");
		const second = obf.obfuscate(`api=12345678${placeholdered}`);

		// Core regression: the lookbehind-qualified digits must not survive
		// verbatim in provider-visible output.
		expect(second).not.toContain("12345678");
		expect(second).not.toContain("ABCDEFGH");
		// Every byte must still round-trip.
		expect(obf.deobfuscate(second)).toBe("api=12345678ABCDEFGH");
		// Redacting the prefix must itself be a fixed point.
		expect(obf.obfuscate(second)).toBe(second);
	});

	it("redacts a suffix whose lookbehind only resolves against the expanded scan context, not the literal placeholder token", () => {
		// `ABCDEFGHSECRET|(?<=ABCDEFGH)SECRET|ABCDEFGH` combined with a prior-call
		// placeholder for `ABCDEFGH` (independently matches the bare `ABCDEFGH`
		// alternative). Re-obfuscating placeholder + `SECRET` makes the full match
		// (placeholder expanded) `ABCDEFGHSECRET`; the outside chunk is `SECRET`.
		// The ONLY way `SECRET` independently matches on its own is via the second
		// alternative's lookbehind `(?<=ABCDEFGH)SECRET` — but the bytes immediately
		// preceding it in the actual text are the LITERAL placeholder token (`#…#`),
		// not `ABCDEFGH`, so testing the chunk in its literal-token context alone
		// never satisfies the lookbehind and wrongly reports no independent match
		// (unlike the two-sided-chunk test above, which literal context alone does
		// catch). Testing the same chunk against the EXPANDED scan context — where
		// the placeholder is resolved back to `ABCDEFGH` — lets the lookbehind see
		// its real preceding bytes and correctly reports an independent match.
		// Without that expanded-context check unioned with the literal-context one,
		// `SECRET` was wrongly treated as spillover and leaked verbatim beside the
		// placeholder.
		const obf = new SecretObfuscator(
			[
				{ type: "plain", content: "ABCDEFGH" },
				{ type: "regex", content: "ABCDEFGHSECRET|(?<=ABCDEFGH)SECRET|ABCDEFGH" },
			],
			"Q".repeat(43),
		);
		const placeholdered = obf.obfuscate("ABCDEFGH");
		const second = obf.obfuscate(`${placeholdered}SECRET`);

		// Core regression: the lookbehind-qualified suffix must not survive
		// verbatim in provider-visible output.
		expect(second).not.toContain("SECRET");
		expect(second).not.toContain("ABCDEFGH");
		// Every byte must still round-trip.
		expect(obf.deobfuscate(second)).toBe("ABCDEFGHSECRET");
		// Redacting the suffix must itself be a fixed point.
		expect(obf.obfuscate(second)).toBe(second);
	});

	it("redacts a cut prefix using placeholder right context instead of leaking it", () => {
		const obf = new SecretObfuscator(
			[
				{ type: "plain", content: "ABCDEFGH" },
				{ type: "regex", content: "SECRETUVABCD|SECRETUV(?=ABCD)|[A-Z]{8}" },
			],
			"Q".repeat(43),
		);
		const placeholdered = obf.obfuscate("ABCDEFGH");
		const second = obf.obfuscate(`SECRETUV${placeholdered}`);

		// The prefix match depends on lookahead supplied by the expanded placeholder.
		// It must still be redacted while the placeholder's own bytes stay atomic.
		expect(second).not.toContain("SECRETUV");
		expect(second).toContain(placeholdered);
		expect(obf.deobfuscate(second)).toBe("SECRETUVABCDEFGH");
		expect(obf.obfuscate(second)).toBe(second);
	});

	it("redacts a cut suffix using placeholder left context instead of leaking it", () => {
		const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1n";
		const entries = [
			{ type: "plain" as const, content: "ABCDEFGH" },
			{ type: "regex" as const, mode: "replace" as const, content: "(?<=ABCD)[A-Z]{8}" },
		];
		const obf = new SecretObfuscator(entries, key);
		const placeholdered = obf.obfuscate("ABCDEFGH");
		const second = obf.obfuscate("ABCDEFGHIJKL");

		// The suffix match depends on lookbehind supplied by the expanded placeholder.
		// It must still be redacted while the placeholder's own bytes stay atomic.
		expect(second).not.toContain("IJKL");
		expect(second).toContain(placeholdered);
		expect(obf.obfuscate(second)).toBe(second);

		const restarted = new SecretObfuscator(entries, key);
		expect(restarted.obfuscate(second)).toBe(second);
	});

	it("obfuscates a short cut suffix covered by a full-length placeholder-context match", () => {
		const obf = new SecretObfuscator(
			[
				{ type: "plain", content: "ABCDEFGH" },
				{ type: "regex", content: "(?<=ABCD)[A-Z]{8}" },
			],
			"Q".repeat(43),
		);

		const second = obf.obfuscate("ABCDEFGHIJKL");

		expect(second).not.toContain("IJKL");
		expect(obf.deobfuscate(second)).toBe("ABCDEFGHIJKL");
		expect(obf.obfuscate(second)).toBe(second);
	});

	it("keeps default replace markers stable when a lookbehind match spills into a prior placeholder", () => {
		const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1n";
		const entries = [
			{ type: "plain" as const, content: "ABCDEFGH" },
			{
				type: "regex" as const,
				mode: "replace" as const,
				content: "(?<=api=)[0-9]{8}[A-Z]{8}|(?<=api=)[0-9]{8}|[A-Z]{8}",
			},
		];
		const obf = new SecretObfuscator(entries, key);
		const placeholdered = obf.obfuscate("ABCDEFGH");
		const persisted = obf.obfuscate(`api=12345678${placeholdered}`);

		expect(persisted).not.toContain("12345678");
		expect(persisted).not.toContain("ABCDEFGH");
		expect(persisted).toContain(placeholdered);
		expect(obf.obfuscate(persisted)).toBe(persisted);

		const restarted = new SecretObfuscator(entries, key);
		expect(restarted.obfuscate(persisted)).toBe(persisted);
	});

	it("preserves a same-call fresh placeholder's origin across sequential replace-mode regex entries", () => {
		// Codex review on PR #2735 ("Preserve fresh placeholder origin after regex
		// redactions"): `ABCDEFGH` (obfuscate mode) + `[A-Z]{8}` (replace) +
		// `[A-Z]{8,14}` (replace), all discovered in a SINGLE obfuscate() call on
		// `ABCDEFGHSECRET`. Step 2 turns `ABCDEFGH` into a placeholder tagged "F"
		// (fresh this call). The first regex entry's redaction pass matches that
		// placeholder token exactly and preserves it untouched — but blanket-tagging
		// the whole redacted span "I" mislabeled the preserved placeholder as
		// prior-call. That false "I" tag then made the SECOND regex entry treat the
		// placeholder as eligible for the greedy-spillover fixed-point skip: its
		// deobfuscated inner value (`ABCDEFGH`, 8 chars) independently matches
		// `[A-Z]{8,14}` while the outside chunk (`SECRET`, 6 chars) does not, so
		// redaction was skipped entirely, leaking `SECRET` verbatim in the output.
		// The fix threads the origin tag through the redaction helpers so a
		// preserved placeholder keeps its own "F" tag, and the second entry
		// correctly redacts `SECRET` instead of treating it as spillover.
		const obf = new SecretObfuscator(
			[
				{ type: "plain", content: "ABCDEFGH" },
				{ type: "regex", content: "[A-Z]{8}", mode: "replace" },
				{ type: "regex", content: "[A-Z]{8,14}", mode: "replace" },
			],
			"Q".repeat(43),
		);
		const result = obf.obfuscate("ABCDEFGHSECRET");

		// Core regression: the trailing secret must not survive verbatim in
		// provider-visible output.
		expect(result).not.toContain("SECRET");
		// Re-obfuscating the already-redacted output must be a fixed point.
		expect(obf.obfuscate(result)).toBe(result);
	});

	it("does not preserve a raw outside chunk merely because its bytes match a generated replacement minted elsewhere", () => {
		// PR #4636 review: default replace-mode preservation checked ONLY
		// `#generatedReplaceChunks.has(match.inputPlaceholderOutside)` — a set of
		// every replacement value this obfuscator has EVER emitted, keyed by VALUE
		// across its whole lifetime, not scoped to the current call. A raw outside
		// chunk that merely happens to share bytes with a replacement minted for a
		// completely different secret elsewhere was treated as "already redacted"
		// and skipped, even though this exact span was never touched by this
		// obfuscator. The fix additionally requires the outside chunk's own origin
		// to carry an "F" tag (generated THIS call) before trusting the value
		// collision, so raw input can never be waved through just because some
		// unrelated redaction happened to produce the same bytes.
		const obf = new SecretObfuscator(
			[
				{ type: "plain", content: "ABCDEFGH" },
				{ type: "regex", mode: "replace", content: "[A-Z]{9}" },
				{ type: "regex", mode: "replace", content: "X" },
			],
			"Q".repeat(43),
		);
		const placeholder = obf.obfuscate("ABCDEFGH");

		// Seed `#generatedReplaceChunks` with "Z" via an UNRELATED occasion: a raw
		// "X" directly abutting the placeholder forms "XABCDEFGH" (9 chars), so the
		// 1-char outside chunk is redacted through the length-keyed chunk sentinel
		// (`#generateReplacement` always probes "Z" first for a 1-char remainder and
		// records it in `#generatedReplaceChunks` even when a distinct non-matching
		// value is ultimately emitted for THIS chunk).
		obf.obfuscate(`X${placeholder}`);

		// A brand-new, never-before-seen raw "Z" now trails the SAME placeholder:
		// expanded, `ABCDEFGH` + `Z` forms `ABCDEFGHZ` — another 9-char match. This
		// "Z" was never generated by this obfuscator; it only coincidentally equals
		// a value already sitting in `#generatedReplaceChunks`.
		const result = obf.obfuscate(`${placeholder}Z`);

		// Core regression: the raw trailing `Z` must be redacted on this FIRST
		// pass, not preserved verbatim just because "Z" is already a member of
		// `#generatedReplaceChunks` from an unrelated redaction elsewhere.
		expect(result).not.toBe(`${placeholder}Z`);
		expect(result.endsWith("Z")).toBe(false);
		expect(result.startsWith(placeholder)).toBe(true);
		// Must already be a fixed point on the very first pass.
		expect(obf.obfuscate(result)).toBe(result);
		// The reversible obfuscate-mode placeholder still recovers ABCDEFGH; the
		// one-way replace-mode marker consumed for the raw `Z` is never restored.
		const restored = obf.deobfuscate(result);
		expect(restored).toContain("ABCDEFGH");
		expect(restored).not.toBe("ABCDEFGHZ");
	});

	it("never mints a placeholder equal to another configured secret's literal value", () => {
		// Codex review on PR #2735 ("Reject placeholders that equal configured
		// secret values"): `#placeholderConflicts` only checked the internal
		// deobfuscation map, not the full set of configured plain-secret literals.
		// Discover the exact keyed placeholder `ABCDEFGH` mints under a fixed key,
		// then configure THAT placeholder string as a second, unrelated plain
		// secret ("B"). Its own plain-secret redaction pass (sorted by length, run
		// once per obfuscate() call) already completed before `ABCDEFGH`'s
		// placeholder existed in the text, so a naive conflict check never catches
		// the collision — the newly-minted placeholder becomes a verbatim,
		// provider-visible copy of B's raw secret. Covers both entry orderings
		// since the bug depended on which secret's redaction pass ran first.
		const key = "Q".repeat(43);
		const discoveryObf = new SecretObfuscator([{ type: "plain", content: "ABCDEFGH" }], key);
		const collidingPlaceholder = discoveryObf.obfuscate("ABCDEFGH");
		expect(collidingPlaceholder).toMatch(/^\$\$[A-Z0-9]+(?::[ULCM])?\$\$$/);

		for (const entries of [
			[
				{ type: "plain" as const, content: "ABCDEFGH" },
				{ type: "plain" as const, content: collidingPlaceholder },
			],
			[
				{ type: "plain" as const, content: collidingPlaceholder },
				{ type: "plain" as const, content: "ABCDEFGH" },
			],
		]) {
			const obf = new SecretObfuscator(entries, key);
			const input = "value=ABCDEFGH other=stuff";

			const out = obf.obfuscate(input);

			// Core regression: B's raw literal must never survive verbatim,
			// disguised as A's placeholder, in provider-visible output.
			expect(out).not.toContain(collidingPlaceholder);
			// Deobfuscation still restores the original input.
			expect(obf.deobfuscate(out)).toBe(input);
			// Re-obfuscating the already-redacted output must be a fixed point.
			expect(obf.obfuscate(out)).toBe(out);
		}
	});

	it("keeps regex placeholders stable when inner friendly names change", () => {
		const sharedKey = "E".repeat(43);
		const before = new SecretObfuscator(
			[
				{ type: "plain", content: "abcdefgh", friendlyName: "old" },
				{ type: "regex", content: "api_key=\\S+", friendlyName: "api-key" },
			],
			sharedKey,
		);
		const persisted = before.obfuscate("api_key=abcdefghXYZ");
		const after = new SecretObfuscator(
			[
				{ type: "plain", content: "abcdefgh", friendlyName: "new" },
				{ type: "regex", content: "api_key=\\S+", friendlyName: "api-key" },
			],
			sharedKey,
		);

		expect(after.obfuscate("api_key=abcdefghXYZ")).toBe(persisted);
		expect(after.deobfuscate(persisted)).toBe("api_key=abcdefghXYZ");
	});

	it("keeps default replace markers stable when friendly placeholder aliases advance scan context", () => {
		const sharedKey = "E".repeat(43);
		const regex = "api_key=[a-z]{8}[A-Za-z0-9]{3}|(?<=abcdefgh)[A-Za-z0-9]{3}";
		const before = new SecretObfuscator(
			[
				{ type: "plain", content: "abcdefgh", friendlyName: "old" },
				{ type: "regex", mode: "replace", content: regex },
			],
			sharedKey,
		);
		const oldPlaceholder = before.obfuscate("abcdefgh");
		const after = new SecretObfuscator(
			[
				{ type: "plain", content: "abcdefgh", friendlyName: "new" },
				{ type: "regex", mode: "replace", content: regex },
			],
			sharedKey,
		);

		const persisted = after.obfuscate(`api_key=${oldPlaceholder}XYZ`);

		expect(persisted).toContain(oldPlaceholder);
		expect(persisted).not.toContain("XYZ");
		expect(after.obfuscate(persisted)).toBe(persisted);
	});

	it("redacts literal hash-delimited text inside regex matches", () => {
		const obfuscator = new SecretObfuscator(
			[{ type: "regex", content: "api_key=\\S+", friendlyName: "api-key" }],
			"F".repeat(43),
		);

		const obfuscated = obfuscator.obfuscate("api_key=#XRRS#");
		expect(obfuscated).toMatch(/^\$\$APIKEY_[A-Z0-9]+(?::[ULCM])?\$\$$/);
		expect(obfuscator.deobfuscate(obfuscated)).toBe("api_key=#XRRS#");
	});

	it("redacts replace-mode regex spans around generated placeholders", () => {
		const obfuscator = new SecretObfuscator(
			[
				{ type: "plain", content: "SECRETUV" },
				{ type: "regex", mode: "replace", content: "[A-Z0-9]{8,}", replacement: "REDACTED" },
			],
			"A".repeat(43),
		);

		const obfuscated = obfuscator.obfuscate("SECRETUVX1");

		expect(obfuscated).toMatch(/^\$\$[A-Z0-9]+:U\$\$REDACTED$/);
		expect(obfuscated).not.toMatch(/X1$/);
		expect(obfuscator.deobfuscate(obfuscated)).toBe("SECRETUVREDACTED");
	});

	it("redacts bounded replace-mode regex suffixes after generated placeholders", () => {
		const obfuscator = new SecretObfuscator(
			[
				{ type: "plain", content: "SECRETUV" },
				{ type: "regex", mode: "replace", content: "[A-Z0-9]{10}", replacement: "REDACTED" },
			],
			"B".repeat(43),
		);

		const obfuscated = obfuscator.obfuscate("SECRETUVX1");

		// The 8-char SECRETUVX1 redacts to one placeholder + REDACTED; assert the `X1`
		// suffix is gone via end-anchored structure, not substring absence — the
		// random keyed base can itself contain the two chars "X1".
		expect(obfuscated).toMatch(/^\$\$[A-Z0-9]+:U\$\$REDACTED$/);
		expect(obfuscated).not.toMatch(/X1$/);
		expect(obfuscator.deobfuscate(obfuscated)).toBe("SECRETUVREDACTED");
	});

	it("emits a custom replacement once around a generated placeholder", () => {
		const obfuscator = new SecretObfuscator(
			[
				{ type: "plain", content: "abcdefgh" },
				{ type: "regex", mode: "replace", content: "api_key=\\S+", replacement: "REDACTED" },
			],
			"C".repeat(43),
		);

		const obfuscated = obfuscator.obfuscate("api_key=abcdefghXYZ");

		// A custom replacement is a single redaction marker for the whole match, so
		// it must not be duplicated on both sides of the preserved placeholder (the
		// bug produced `REDACTED#…#REDACTED`). Asserted by structure plus an
		// end-anchored guard rather than a base-collidable substring count.
		expect(obfuscated).toMatch(/^REDACTED\$\$[A-Z0-9]+:L\$\$$/);
		expect(obfuscated).not.toMatch(/REDACTED$/);
		expect(obfuscated).not.toContain("api_key=");
		expect(obfuscator.deobfuscate(obfuscated)).toBe("REDACTEDabcdefgh");
	});

	it("is idempotent when re-obfuscating already-obfuscated text", () => {
		// The SDK obfuscates messages in both convertToLlm and transformProviderContext,
		// and prior-turn messages re-enter every turn, so obfuscate() must be a fixed
		// point. Re-running it on its own output must not re-redact around an existing
		// placeholder (regression: `#…#REDACTED` -> `#…#REDACTEDDACTED`).
		const replace = new SecretObfuscator(
			[
				{ type: "plain", content: "SECRETUV" },
				{ type: "regex", mode: "replace", content: "[A-Z0-9]{10}", replacement: "REDACTED" },
			],
			"D".repeat(43),
		);
		const replaceOnce = replace.obfuscate("SECRETUVX1");
		expect(replaceOnce).toMatch(/^\$\$[A-Z0-9]+:U\$\$REDACTED$/);
		expect(replace.obfuscate(replaceOnce)).toBe(replaceOnce);
		expect(replace.obfuscate(replace.obfuscate(replaceOnce))).toBe(replaceOnce);
		expect(replace.deobfuscate(replaceOnce)).toBe("SECRETUVREDACTED");

		// Custom replacement spanning a placeholder must also stay a fixed point.
		const custom = new SecretObfuscator(
			[
				{ type: "plain", content: "abcdefgh" },
				{ type: "regex", mode: "replace", content: "api_key=\\S+", replacement: "REDACTED" },
			],
			"E".repeat(43),
		);
		const customOnce = custom.obfuscate("api_key=abcdefghXYZ");
		expect(custom.obfuscate(customOnce)).toBe(customOnce);
		expect(custom.deobfuscate(customOnce)).toBe("REDACTEDabcdefgh");

		// Obfuscate-mode regex spanning a placeholder is a fixed point too.
		const obf = new SecretObfuscator(
			[
				{ type: "plain", content: "abcdefgh" },
				{ type: "regex", content: "api_key=[A-Za-z0-9]{11}", friendlyName: "api-key" },
			],
			"F".repeat(43),
		);
		const obfOnce = obf.obfuscate("api_key=abcdefghXYZ");
		expect(obf.obfuscate(obfOnce)).toBe(obfOnce);
		expect(obf.deobfuscate(obfOnce)).toBe("api_key=abcdefghXYZ");
	});

	it("cross-matches a fresh placeholder whose token already appears in the input", () => {
		const obf = new SecretObfuscator(
			[
				{ type: "plain", content: "abcdefgh" },
				{ type: "regex", mode: "replace", content: "api_key=\\S+", replacement: "REDACTED" },
			],
			"G".repeat(43),
		);
		const token = obf.obfuscate("abcdefgh");
		expect(token).toMatch(/^\$\$[A-Z0-9]+:L\$\$$/);

		// Input carries the prior token literally AND a fresh api_key=abcdefghXYZ (raw `abc`).
		// The fresh occurrence must still be redacted (XYZ gone) while the prior token is
		// preserved; range-based origin tracking distinguishes the two same-token spans,
		// where a token-value guard would skip both and leak XYZ.
		const out = obf.obfuscate(`${token} api_key=abcdefghXYZ`);
		expect(out).toBe(`${token} REDACTED${token}`);
		expect(obf.deobfuscate(out)).toBe("abcdefgh REDACTEDabcdefgh");
		expect(obf.obfuscate(out)).toBe(out); // still a fixed point
	});

	it("redacts new surrounding bytes around a prior-call placeholder without re-redacting markers", () => {
		const obf = new SecretObfuscator(
			[
				{ type: "plain", content: "abcdefgh" },
				{ type: "regex", mode: "replace", content: "api_key=\\S+", replacement: "REDACTED" },
			],
			"H".repeat(43),
		);
		// Simulate a session where `abc` was obfuscated in an earlier turn (the token
		// is a prior-call/input placeholder) and the regex now re-enters text where
		// `api_key=` + raw `XYZ` still surround that token. The prior placeholder is
		// preserved, but the genuinely-new surrounding bytes (`api_key=`, `XYZ`) must
		// be redacted — not dropped, which would leak `XYZ` to the provider.
		const token = obf.obfuscate("abcdefgh");
		const out = obf.obfuscate(`api_key=${token}XYZ`);
		expect(out).toBe(`REDACTED${token}`);
		expect(out).not.toContain("XYZ");
		expect(out).not.toContain("api_key=");
		expect(obf.deobfuscate(out)).toBe("REDACTEDabcdefgh");
		// Re-obfuscating the redacted output is a fixed point: the marker `REDACTED`
		// does not independently satisfy `api_key=\S+`, so nothing grows.
		expect(obf.obfuscate(out)).toBe(out);
	});

	it("redacts bounded replace regex remainders around prior placeholders", () => {
		const obf = new SecretObfuscator(
			[
				{ type: "plain", content: "abcdefgh" },
				{ type: "regex", mode: "replace", content: "api_key=[A-Za-z0-9]{11}", replacement: "REDACTED" },
			],
			"I".repeat(43),
		);
		const token = obf.obfuscate("abcdefgh");

		const out = obf.obfuscate(`api_key=${token}XYZ`);

		expect(out).toBe(`REDACTED${token}`);
		expect(out).not.toContain("XYZ");
		expect(out).not.toContain("api_key=");
		expect(obf.deobfuscate(out)).toBe("REDACTEDabcdefgh");
		expect(obf.obfuscate(out)).toBe(out);
	});

	it("redacts custom replacement prefixes that are raw regex remainders", () => {
		const obf = new SecretObfuscator(
			[
				{ type: "plain", content: "SECRETUV" },
				{ type: "regex", mode: "replace", content: "[A-Z0-9]{9}", replacement: "REDACTED" },
			],
			"K".repeat(43),
		);
		const token = obf.obfuscate("SECRETUV");

		const out = obf.obfuscate(`${token}R`);

		expect(out).toBe(`${token}REDACTED`);
		expect(obf.deobfuscate(out)).toBe("SECRETUVREDACTED");
		expect(obf.obfuscate(out)).toBe(out);
	});

	it("redacts trailing bytes after existing custom replacement markers", () => {
		const obf = new SecretObfuscator(
			[
				{ type: "plain", content: "SECRETUV" },
				{ type: "regex", mode: "replace", content: "[A-Z0-9]{17}", replacement: "REDACTED" },
			],
			"L".repeat(43),
		);
		const token = obf.obfuscate("SECRETUV");

		const out = obf.obfuscate(`${token}REDACTEDX`);

		expect(out).toBe(`${token}REDACTED`);
		expect(obf.obfuscate(out)).toBe(out);
	});

	it("keeps bounded custom replacement matches idempotent around preserved placeholders", () => {
		const obf = new SecretObfuscator(
			[
				{ type: "plain", content: "SECRETUV" },
				{ type: "regex", mode: "replace", content: "[A-Z0-9]{8,12}", replacement: "REDACTED" },
			],
			"M".repeat(43),
		);
		const out = obf.obfuscate("XSECRETUVREDACTED");

		expect(out).toMatch(/^REDACTED\$\$[A-Z0-9]+:U\$\$REDACTED$/);
		expect(obf.obfuscate(out)).toBe(out);
		expect(obf.deobfuscate(out)).toBe("REDACTEDSECRETUVREDACTED");
	});

	it("redacts default replace regex remainders around prior placeholders", () => {
		const obf = new SecretObfuscator(
			[
				{ type: "plain", content: "abcdefgh" },
				{ type: "regex", mode: "replace", content: "api_key=[A-Za-z0-9]{11}" },
			],
			"J".repeat(43),
		);
		const token = obf.obfuscate("abcdefgh");

		const out = obf.obfuscate(`api_key=${token}XYZ`);

		expect(out).toContain(token);
		expect(out).not.toContain("XYZ");
		expect(out).not.toContain("api_key=");
		expect(obf.obfuscate(out)).toBe(out);
	});

	it("redacts bounded regex remainders around renamed friendly placeholders", () => {
		const sharedKey = "J".repeat(43);
		const before = new SecretObfuscator([{ type: "plain", content: "abcdefgh", friendlyName: "old" }], sharedKey);
		const oldToken = before.obfuscate("abcdefgh");
		const after = new SecretObfuscator(
			[
				{ type: "plain", content: "abcdefgh", friendlyName: "new" },
				{ type: "regex", mode: "replace", content: "api_key=[A-Za-z0-9]{11}" },
			],
			sharedKey,
		);

		const out = after.obfuscate(`api_key=${oldToken}XYZ`);

		expect(out).toContain(oldToken);
		expect(out).not.toContain("api_key=");
		expect(out).not.toContain("XYZ");
		expect(after.obfuscate(out)).toBe(out);
	});

	it("redacts default replace raw suffixes after prior placeholders", () => {
		const obf = new SecretObfuscator(
			[
				{ type: "plain", content: "SECRETUV" },
				{ type: "regex", mode: "replace", content: "[A-Z0-9]{10}" },
			],
			"N".repeat(43),
		);
		const token = obf.obfuscate("SECRETUV");

		const out = obf.obfuscate(`${token}X1`);

		expect(out).toContain(token);
		expect(out).not.toContain("X1");
		expect(obf.obfuscate(out)).toBe(out);
	});

	it("redacts raw default replace values that look like generated sentinels", () => {
		const obf = new SecretObfuscator([{ type: "plain", content: "ZZTOPSECRET", mode: "replace" }], "Q".repeat(43));

		const out = obf.obfuscate("ZZTOPSECRET");

		expect(out).not.toBe("ZZTOPSECRET");
		expect(out).toHaveLength("ZZTOPSECRET".length);
	});

	it("does not emit a plain replace secret equal to the Z/ZZ sentinel unchanged", () => {
		for (const content of ["Z", "ZZ"]) {
			const obf = new SecretObfuscator([{ type: "plain", content, mode: "replace" }], "Q".repeat(43));

			const out = obf.obfuscate(content);

			expect(out).not.toBe(content);
			expect(out).toHaveLength(content.length);
			// Replace mode is one-way; re-obfuscating the emitted value is a fixed point.
			expect(obf.obfuscate(out)).toBe(out);
		}
	});

	it("does not emit a default replace regex match equal to the Z/ZZ sentinel unchanged", () => {
		// A literal regex whose match is exactly the sentinel: the perturbed value is
		// not re-matched, so it is emitted distinct AND stays a fixed point.
		for (const content of ["Z", "ZZ"]) {
			const obf = new SecretObfuscator([{ type: "regex", mode: "replace", content }], "Q".repeat(43));

			const out = obf.obfuscate(content);

			expect(out).not.toBe(content);
			expect(out).toHaveLength(content.length);
			expect(obf.obfuscate(out)).toBe(out);
		}
	});

	it("redacts a self-matching sentinel regex to a stable nonmatching value", () => {
		// A regex that also matches the single A/B perturbation still has same-length
		// values it does NOT match (a lowercase pair for [A-Z]{2}, an A/Z-free pair for
		// Z+). The bounded search finds one, so the sentinel is redacted to a value the
		// regex never re-matches: leak-free AND a fixed point under re-obfuscation.
		for (const content of ["Z+", "[A-Z]{2}"]) {
			const obf = new SecretObfuscator([{ type: "regex", mode: "replace", content }], "Q".repeat(43));

			const out = obf.obfuscate("ZZ");

			expect(out).not.toBe("ZZ");
			expect(out).toHaveLength(2);
			expect(obf.obfuscate(out)).toBe(out);
			expect(obf.obfuscate(obf.obfuscate(out))).toBe(out);
		}
	});

	it("searches past the first perturbation when it also matches the regex", () => {
		// Regression for a regex that matches both the sentinel and its single A/B
		// perturbation: `Z|A`/`[AZ]` match `Z` and `A`, so the old guard kept the raw
		// `Z` and shipped it. A nonmatching same-length value (`B`) must be found.
		for (const content of ["Z|A", "[AZ]"]) {
			const obf = new SecretObfuscator([{ type: "regex", mode: "replace", content }], "Q".repeat(43));

			const out = obf.obfuscate("Z");

			expect(out).not.toBe("Z");
			expect(out).toHaveLength(1);
			expect(obf.obfuscate(out)).toBe(out);
		}
	});

	it("falls back to punctuation when a regex matches every alphanumeric sentinel candidate", () => {
		const obf = new SecretObfuscator([{ type: "regex", mode: "replace", content: "[A-Za-z0-9]{2}" }], "Q".repeat(43));

		const out = obf.obfuscate("ZZ");

		expect(out).not.toBe("ZZ");
		expect(out).toHaveLength(2);
		expect(/^[A-Za-z0-9]{2}$/.test(out)).toBe(false);
		expect(obf.obfuscate(out)).toBe(out);
	});

	it("exhausts two-character fallback candidates before keeping the sentinel", () => {
		const obf = new SecretObfuscator([{ type: "regex", mode: "replace", content: "[A-Za-z0-9]." }], "Q".repeat(43));

		const out = obf.obfuscate("ZZ");

		expect(out).not.toBe("ZZ");
		expect(out).toHaveLength(2);
		expect(/[A-Za-z0-9]./.test(out)).toBe(false);
		expect(obf.obfuscate(out)).toBe(out);
	});

	it("samples every leading character class before giving up on three-character collisions", () => {
		const obf = new SecretObfuscator(
			[{ type: "regex", mode: "replace", content: "[A-Za-z0-9].{2}" }],
			"Q".repeat(43),
		);

		const out = obf.obfuscate("ZZc");

		expect(out).not.toBe("ZZc");
		expect(out).toHaveLength(3);
		expect(/[A-Za-z0-9].{2}/.test(out)).toBe(false);
		expect(obf.obfuscate(out)).toBe(out);
	});

	it("exhausts three-character fallback candidates when the nonmatching byte must be last", () => {
		const obf = new SecretObfuscator(
			[{ type: "regex", mode: "replace", content: ".{2}[A-Za-z0-9]" }],
			"Q".repeat(43),
		);

		const out = obf.obfuscate("ZZc");

		expect(out).not.toBe("ZZc");
		expect(out).toHaveLength(3);
		expect(/.{2}[A-Za-z0-9]/.test(out)).toBe(false);
		expect(obf.obfuscate(out)).toBe(out);
	});

	it("exhausts longer fallback candidates when the nonmatching byte must be last", () => {
		const obf = new SecretObfuscator(
			[{ type: "regex", mode: "replace", content: ".{4}[A-Za-z0-9]" }],
			"Q".repeat(43),
		);

		const out = obf.obfuscate("ZZLB6");

		expect(out).not.toBe("ZZLB6");
		expect(out).toHaveLength(5);
		expect(/.{4}[A-Za-z0-9]/.test(out)).toBe(false);
		expect(obf.obfuscate(out)).toBe(out);
	});

	it("tries multi-character fallback replacements when one changed byte is still matchable", () => {
		const obf = new SecretObfuscator([{ type: "regex", mode: "replace", content: "[A-Za-z0-9].*" }], "Q".repeat(43));

		const out = obf.obfuscate("ZZLB6");

		expect(out).not.toBe("ZZLB6");
		expect(out).toHaveLength(5);
		expect(/[A-Za-z0-9].*/.test(out)).toBe(false);
		expect(obf.obfuscate(out)).toBe(out);
	});

	it("redacts a default replace regex that matches every non-whitespace candidate", () => {
		// `\S{5}` matches every non-whitespace value, so the alphanumeric and
		// punctuation candidates are all exhausted. A same-length whitespace run is a
		// stable nonmatching redaction, so the colliding sentinel value is replaced
		// rather than shipped raw to the provider.
		const obf = new SecretObfuscator([{ type: "regex", mode: "replace", content: "\\S{5}" }], "Q".repeat(43));

		const out = obf.obfuscate("ZZLB6");

		expect(out).not.toBe("ZZLB6");
		expect(out).toHaveLength(5);
		expect(/\S{5}/.test(out)).toBe(false);
		expect(obf.obfuscate(out)).toBe(out);
	});

	it("redacts a replace regex that also matches all-space and all-tab runs via a mixed marker", () => {
		// `(?:\S{5}| {5}|\t{5})` matches every non-whitespace run AND a full space or
		// tab run, so neither the punctuation candidates nor a full whitespace run is a
		// stable redaction. A mixed marker (one whitespace byte among filler, e.g.
		// ` AAAA`) breaks every fixed-length run, so the colliding sentinel value is
		// still redacted to a stable nonmatching value instead of shipped raw.
		const obf = new SecretObfuscator(
			[{ type: "regex", mode: "replace", content: "(?:\\S{5}| {5}|\\t{5})" }],
			"Q".repeat(43),
		);

		const out = obf.obfuscate("ZZLB6");

		expect(out).not.toBe("ZZLB6");
		expect(out).toHaveLength(5);
		expect(/(?:\S{5}| {5}|\t{5})/.test(out)).toBe(false);
		expect(obf.obfuscate(out)).toBe(out);
	});

	it("drops a replace regex entirely when it can never redact a 1-2 char match distinctly from itself", () => {
		// A match-everything regex has no nonmatching same-length redaction for a
		// 1-2 char value, so `findNonMatchingReplacement` would exhaust even against
		// an isolated probe drawn from the fallback's own alphabet — the regex has
		// already proven it matches literally every candidate that alphabet could
		// produce. Accepting the entry would mean the only "redaction" available is
		// the raw match returned unchanged, which is worse than not registering the
		// entry at all. The constructor now drops such entries silently at
		// construction (`regexHasUnresolvableShortMatchFallback`), so with no other
		// configured secret, `hasSecrets()` is false and the input passes through
		// completely unobfuscated.
		for (const content of [".", "[\\s\\S]", "[\\s\\S]{2}"]) {
			const obf = new SecretObfuscator([{ type: "regex", mode: "replace", content }], "Q".repeat(43));
			const input = content === "[\\s\\S]{2}" ? "ZZ" : "Z";

			expect(obf.hasSecrets()).toBe(false);
			expect(obf.obfuscate(input)).toBe(input);
		}
	});

	it("resolves a three-character match-everything regex without the removed exhaustive sweep", () => {
		// Regression: `findNonMatchingReplacement` used to special-case `len <= 3`
		// with a fully exhaustive search over every `base**length` candidate
		// (base = 90, so 90**3 = 729000) before falling back to the whitespace/keyed
		// marker. A 3-byte default replace regex that matches every candidate
		// (`[\s\S]{3}`) rejects the ENTIRE sweep on every single match, so this exact
		// shape burned the whole 729000-candidate search (measured ~70ms on this
		// machine) on one redaction. The fix drops the special case so length <= 3
		// goes through the same bounded single-position-substitution search already
		// used for longer values (O(length * 90)), measured at ~1ms for this case —
		// correctness is unchanged (the caller's keyed marker is still the fixed
		// point once the bounded search exhausts), but the pathological cost is gone.
		const obf = new SecretObfuscator([{ type: "regex", mode: "replace", content: "[\\s\\S]{3}" }], "Q".repeat(43));

		const start = performance.now();
		const out = obf.obfuscate("ZZc");
		const elapsed = performance.now() - start;

		// Correctness: the search still terminates with a usable, stable redaction.
		expect(out).toHaveLength(3);
		expect(obf.obfuscate(out)).toBe(out);
		expect(obf.obfuscate(obf.obfuscate(out))).toBe(out);
		// Perf guard: bounded search resolves in ~1ms here; the removed exhaustive
		// branch took ~70ms+ for this exact case. 30ms is far above the bounded cost
		// (even generously slower CI hardware) yet well under half the exhaustive
		// branch's cost, so a reinstated `len <= 3` sweep reliably fails this.
		expect(elapsed).toBeLessThan(30);
	});

	it("keeps a whole-match default replace regex idempotent when no candidate avoids the regex", () => {
		// `[\s\S]{8}` matches every possible 8-byte value (unlike `\S{n}` above, it
		// also matches whitespace and line terminators), so `findNonMatchingReplacement`
		// exhausts for a value of length >= 3 — the content-hash path the length-1
		// sentinel test above cannot reach, since 1-2 char values hardcode to `Z`/`ZZ`
		// regardless of content. Regression: the whole-match default-replace fallback
		// kept the content-hash replacement as-is. That replacement is derived from a
		// hash of the bytes being replaced, so once it is emitted and re-scanned on the
		// next obfuscate() pass, hashing ITS OWN bytes (not the original secret)
		// produced a DIFFERENT same-length value — the marker churned forever instead
		// of reaching a fixed point. The fix falls back to the key+length-only marker,
		// which is stable because it depends on nothing the marker's own regeneration changes.
		const obf = new SecretObfuscator([{ type: "regex", mode: "replace", content: "[\\s\\S]{8}" }], "Q".repeat(43));

		const out = obf.obfuscate("SECRET12");

		expect(out).toHaveLength(8);
		expect(obf.obfuscate(out)).toBe(out);
		expect(obf.obfuscate(obf.obfuscate(out))).toBe(out);
	});

	it("keeps a whole-match default replace regex stable across restart when no candidate avoids the regex", () => {
		// Cross-restart counterpart to the previous test. The key+length-only fallback
		// marker depends only on the persisted key and the value's length, so a fresh
		// obfuscator with the same key reproduces the IDENTICAL marker and persisted
		// text never drifts. Regression: the old content-hash fallback depended on the
		// bytes of the already-redacted marker, so a fresh obfuscator re-hashed those
		// marker bytes into a different value, drifting persisted obfuscated text — and
		// the provider prompt-cache prefix it anchors — across every restart.
		const key = "R".repeat(43);
		const entries = [{ type: "regex" as const, mode: "replace" as const, content: "[\\s\\S]{8}" }];
		const first = new SecretObfuscator(entries, key);
		const persisted = first.obfuscate("SECRET12");

		const restarted = new SecretObfuscator(entries, key);
		expect(restarted.obfuscate(persisted)).toBe(persisted);
	});

	it("redacts a context-sensitive replace regex to a value stable in place", () => {
		// A replace-mode regex with lookbehind matches a value only in context, so a
		// candidate tested in isolation can be accepted yet re-match once substituted
		// back. Regression: `(?<=api=)[AZ]` redacting `api=Z` to `api=A` (A does not
		// match a bare `A`) was then re-redacted to `api=Z` on the next pass, shipping
		// the raw matched value on every other turn. The replacement must be a fixed
		// point evaluated in its surrounding context. Both inputs exercise a distinct
		// path: `Z` is the sentinel collision, `A`'s deterministic replacement (`Z`)
		// differs from the value but still re-matches in context.
		for (const input of ["api=Z", "api=A"]) {
			const obf = new SecretObfuscator(
				[{ type: "regex", mode: "replace", content: "(?<=api=)[AZ]" }],
				"Q".repeat(43),
			);

			const out = obf.obfuscate(input);

			expect(out).toHaveLength(input.length);
			expect(out.startsWith("api=")).toBe(true);
			// The matched character must not survive in a position the regex re-matches.
			expect(/(?<=api=)[AZ]/.test(out)).toBe(false);
			// Re-obfuscation is a fixed point, so it never oscillates back to the raw value.
			expect(obf.obfuscate(out)).toBe(out);
			expect(obf.obfuscate(obf.obfuscate(out))).toBe(out);
		}
	});

	it("redacts a wide-lookbehind replace regex to a value stable in place", () => {
		// A lookbehind wider than the re-match back-scan window (512) must still
		// evaluate against the full surrounding text. Regression: truncating the
		// fixed-point probe to a fixed window dropped the 600-char lookbehind, so the
		// check falsely accepted a candidate the regex DOES re-match once the whole
		// prefix is present — the redaction then oscillated back to the raw matched
		// value on alternating obfuscate() passes, leaking it to the provider.
		const prefix = "A".repeat(600);
		const re = new RegExp(`(?<=${prefix})[AZ]`);
		for (const input of [`${prefix}Z`, `${prefix}A`]) {
			const obf = new SecretObfuscator(
				[{ type: "regex", mode: "replace", content: `(?<=${prefix})[AZ]` }],
				"Q".repeat(43),
			);

			const out = obf.obfuscate(input);

			expect(out).toHaveLength(input.length);
			expect(out.startsWith(prefix)).toBe(true);
			// The matched character must not survive where the full-context regex re-matches.
			expect(re.test(out)).toBe(false);
			// Re-obfuscation is a fixed point, so it never oscillates back to the raw value.
			expect(obf.obfuscate(out)).toBe(out);
			expect(obf.obfuscate(obf.obfuscate(out))).toBe(out);
		}
	});

	it("does not require a placeholder key for entries that never produce a reversible placeholder", () => {
		// Short plain obfuscate entries are toned down, so they must not force key
		// creation; regex/long-plain obfuscate entries can placehold and do need it.
		// A plain replace entry's replacement is pure content-hash, so it never needs
		// the key either — see the tests below for regex replace entries, which can
		// still need the key for a different reason (the fixed-point fallback marker).
		expect(secretEntryNeedsPlaceholderKey({ type: "plain", content: "abc" })).toBe(false);
		expect(secretEntryNeedsPlaceholderKey({ type: "plain", content: "abcdefgh" })).toBe(true);
		expect(secretEntryNeedsPlaceholderKey({ type: "regex", content: "[A-Z]{2}" })).toBe(true);
		expect(secretEntryNeedsPlaceholderKey({ type: "plain", content: "abc", mode: "replace" })).toBe(false);
	});

	it("requires a placeholder key for a default replace regex but not one with a custom replacement", () => {
		// A replace-mode regex with NO custom `replacement` can reach
		// `#generateRegexReplacement`'s no-stable-candidate fallback (e.g. for a
		// pathological match-everything regex like `[\s\S]{8}`), which derives its
		// marker from the persisted key so it stays a fixed point across restarts —
		// so this shape DOES need the key. Regression: this previously returned
		// `false` for every replace-mode entry, so a fresh install with only this
		// entry never persisted a key and `SecretObfuscator` fell back to
		// `defaultPlaceholderKey()` (process-random, regenerated every restart),
		// churning the fallback marker across restarts anyway — the exact symptom
		// the fixed-point fix was meant to eliminate.
		expect(secretEntryNeedsPlaceholderKey({ type: "regex", content: "[\\s\\S]{8}", mode: "replace" })).toBe(true);
		// A regex WITH a custom `replacement` never reaches that fallback — it always
		// emits the literal configured string — so it still does not need the key.
		expect(
			secretEntryNeedsPlaceholderKey({
				type: "regex",
				content: "[\\s\\S]{8}",
				mode: "replace",
				replacement: "REDACTED",
			}),
		).toBe(false);
	});

	it("requires a persisted placeholder key for a config with only a whole-match default replace regex", () => {
		// End-to-end counterpart to the previous test, exercised through
		// `secretEntriesNeedPlaceholderKey` — what `sdk.ts` actually calls to decide
		// whether to create/read the persisted key file. Entries mirror "keeps a
		// whole-match default replace regex stable across restart" above. Regression:
		// this previously returned `false` for this exact config, so `sdk.ts` never
		// persisted a key and `SecretObfuscator` fell back to a process-random key,
		// churning the fixed-point fallback marker across restarts anyway.
		const entries = [{ type: "regex" as const, mode: "replace" as const, content: "[\\s\\S]{8}" }];
		expect(secretEntriesNeedPlaceholderKey(entries)).toBe(true);
	});

	it("ignores obfuscate entries shadowed by a same-content replace entry when deciding key need", () => {
		const secret = "ghp_exampletoken1234567890";
		// A same-content plain replace entry runs before the plain obfuscate entry in
		// obfuscate(), so the value is one-way replaced and the obfuscate entry never
		// emits a reversible placeholder. The set must therefore not require the key.
		expect(
			secretEntriesNeedPlaceholderKey([
				{ type: "plain", content: secret, mode: "obfuscate" },
				{ type: "plain", content: secret, mode: "replace" },
			]),
		).toBe(false);
		// Verify the shadowing actually holds: no reversible placeholder is emitted.
		const obf = new SecretObfuscator(
			[
				{ type: "plain", content: secret, mode: "obfuscate" },
				{ type: "plain", content: secret, mode: "replace" },
			],
			"test-placeholder-key",
		);
		const out = obf.obfuscate(`value=${secret}`);
		expect(out).not.toContain(secret);
		expect(out).not.toMatch(/\$\$[A-Z0-9]/);
		// An unshadowed obfuscate entry still requires the key.
		expect(secretEntriesNeedPlaceholderKey([{ type: "plain", content: secret, mode: "obfuscate" }])).toBe(true);
		// A replace entry with DIFFERENT content does not shadow the obfuscate entry.
		expect(
			secretEntriesNeedPlaceholderKey([
				{ type: "plain", content: secret, mode: "obfuscate" },
				{ type: "plain", content: "unrelated-other-secret", mode: "replace" },
			]),
		).toBe(true);
		// A replace entry whose CUSTOM replacement still contains the secret does NOT
		// shadow it: obfuscate()'s later pass re-scans the inserted replacement text and
		// emits a reversible placeholder, which needs the persisted key.
		const reintroEntries: SecretEntry[] = [
			{ type: "plain", content: secret, mode: "obfuscate" },
			{ type: "plain", content: secret, mode: "replace", replacement: `PREFIX_${secret}_SUFFIX` },
		];
		expect(secretEntriesNeedPlaceholderKey(reintroEntries)).toBe(true);
		const reintroOut = new SecretObfuscator(reintroEntries, "test-placeholder-key").obfuscate(`value=${secret}`);
		expect(reintroOut).toMatch(/\$\$[A-Z0-9]/);
		// Among duplicate same-content replace entries the LAST one wins (the
		// obfuscator stores replace mappings in a content-keyed Map), so a safe earlier
		// duplicate must not mask a later reintroducing one: key is still required.
		const dupReintroLast: SecretEntry[] = [
			{ type: "plain", content: secret, mode: "obfuscate" },
			{ type: "plain", content: secret, mode: "replace" },
			{ type: "plain", content: secret, mode: "replace", replacement: secret },
		];
		expect(secretEntriesNeedPlaceholderKey(dupReintroLast)).toBe(true);
		expect(new SecretObfuscator(dupReintroLast, "test-placeholder-key").obfuscate(`value=${secret}`)).toMatch(
			/\$\$[A-Z0-9]/,
		);
		// Reverse order: a later safe replacement overrides an earlier reintroducing
		// one, so the obfuscate entry is shadowed and no key is needed.
		const dupSafeLast: SecretEntry[] = [
			{ type: "plain", content: secret, mode: "obfuscate" },
			{ type: "plain", content: secret, mode: "replace", replacement: `X_${secret}_X` },
			{ type: "plain", content: secret, mode: "replace" },
		];
		expect(secretEntriesNeedPlaceholderKey(dupSafeLast)).toBe(false);
		expect(new SecretObfuscator(dupSafeLast, "test-placeholder-key").obfuscate(`value=${secret}`)).not.toMatch(
			/\$\$[A-Z0-9]/,
		);
		// A transitive replace chain that rewrites a safe alias back into the secret
		// (`SECRET -> ALIAS`, `ALIAS -> SECRET`) reintroduces the value before the
		// plain-obfuscate pass, so the key is still required.
		const alias = "ALIAS_TOKEN_XYZ";
		const chainReintro: SecretEntry[] = [
			{ type: "plain", content: secret, mode: "obfuscate" },
			{ type: "plain", content: secret, mode: "replace", replacement: alias },
			{ type: "plain", content: alias, mode: "replace", replacement: secret },
		];
		expect(secretEntriesNeedPlaceholderKey(chainReintro)).toBe(true);
		expect(new SecretObfuscator(chainReintro, "test-placeholder-key").obfuscate(`value=${secret}`)).toMatch(
			/\$\$[A-Z0-9]/,
		);
		// A replacement fragment that joins with adjacent passthrough bytes to form an
		// obfuscate content (`A -> SEC`, so `ARET12` becomes `SECRET12` during the
		// replace phase) still emits a reversible placeholder, so the key is required
		// even though no single replacement contains the whole content.
		const fragmentJoin: SecretEntry[] = [
			{ type: "plain", content: "SECRET12", mode: "obfuscate" },
			{ type: "plain", content: "SECRET12", mode: "replace", replacement: "SAFE" },
			{ type: "plain", content: "A", mode: "replace", replacement: "SEC" },
		];
		expect(secretEntriesNeedPlaceholderKey(fragmentJoin)).toBe(true);
		expect(new SecretObfuscator(fragmentJoin, "test-placeholder-key").obfuscate("x ARET12 y")).toMatch(
			/\$\$[A-Z0-9]/,
		);
		// A delete replacement also joins the passthrough bytes on both sides of the
		// removed token, so it can reconstruct the obfuscate content even though its
		// replacement output is empty.
		const deleteJoin: SecretEntry[] = [
			{ type: "plain", content: "SECRET12", mode: "obfuscate" },
			{ type: "plain", content: "SECRET12", mode: "replace", replacement: "SAFE" },
			{ type: "plain", content: "X", mode: "replace", replacement: "" },
		];
		expect(secretEntriesNeedPlaceholderKey(deleteJoin)).toBe(true);
		expect(new SecretObfuscator(deleteJoin, "test-placeholder-key").obfuscate("SECRETX12")).toMatch(/\$\$[A-Z0-9]/);
	});

	it("does not require the key when a later replacement erases a content-forming fragment", () => {
		// `AA -> SEC` could seed `SECRET12`, but the later (shorter-content) `S -> X`
		// rewrites every `SEC` into `XEC`, so the replace phase can never leave
		// `SECRET12` for the plain-obfuscate pass. The key-need check must model that
		// erasure and stay key-free instead of writing secret-placeholder.key for an
		// effectively non-placeholding config.
		const entries: SecretEntry[] = [
			{ type: "plain", content: "SECRET12", mode: "obfuscate" },
			{ type: "plain", content: "SECRET12", mode: "replace", replacement: "SAFE" },
			{ type: "plain", content: "AA", mode: "replace", replacement: "SEC" },
			{ type: "plain", content: "S", mode: "replace", replacement: "X" },
		];
		expect(secretEntriesNeedPlaceholderKey(entries)).toBe(false);
		// And the obfuscator never reconstructs the secret nor emits a reversible
		// placeholder, confirming the config is genuinely non-placeholding.
		const out = new SecretObfuscator(entries, "test-placeholder-key").obfuscate("AARET12 and AART12");
		expect(out).not.toContain("SECRET12");
		expect(out).not.toMatch(/\$\$[A-Z0-9]/);
	});

	it("does not require the key when a later replacement erases the surrounding context bytes", () => {
		// `AA -> SEC` could seed `SECRET12` by tiling its `SEC` output against
		// passthrough `RET12`, but the later `R -> X` rewrites that surrounding `R`,
		// so a freshly formed `SECRET12` becomes `SECXET12` before the obfuscate pass
		// — direct `SECRET12` is also shadowed to `SAFE`. The probe must model that
		// later replacements destroy the required surrounding bytes, not just the
		// fragment itself, and stay key-free for this effectively non-placeholding
		// config (otherwise it writes secret-placeholder.key and fails startup in an
		// unwritable agent config dir).
		const entries: SecretEntry[] = [
			{ type: "plain", content: "SECRET12", mode: "obfuscate" },
			{ type: "plain", content: "SECRET12", mode: "replace", replacement: "SAFE" },
			{ type: "plain", content: "AA", mode: "replace", replacement: "SEC" },
			{ type: "plain", content: "R", mode: "replace", replacement: "X" },
		];
		expect(secretEntriesNeedPlaceholderKey(entries)).toBe(false);
		const out = new SecretObfuscator(entries, "test-placeholder-key").obfuscate("AARET12 and SECRET12");
		expect(out).not.toContain("SECRET12");
		expect(out).not.toMatch(/\$\$[A-Z0-9]/);
	});

	it("redacts a raw sentinel-shaped suffix bridged into a match by a prior placeholder", () => {
		// A prior-call placeholder followed by RAW text that merely looks like a
		// deterministic redaction sentinel (`ZZ…`). The default-replace regex matches
		// only because the deobfuscated placeholder bridges the combined value. The raw
		// suffix was never emitted by this obfuscator, so it must be redacted rather than
		// skipped by shape — both for a fixed-width regex (where the suffix does NOT
		// independently match) and a variable-width one (where it DOES). Either way,
		// leaving it would leak `ZZZZ` to the provider.
		for (const content of ["[A-Z0-9]{12}", "[A-Z0-9]{4,12}"]) {
			const obf = new SecretObfuscator(
				[
					{ type: "plain", content: "SECRETUV" },
					{ type: "regex", mode: "replace", content },
				],
				"R".repeat(43),
			);
			const token = obf.obfuscate("SECRETUV");
			expect(token).toMatch(/^\$\$[A-Z0-9]+:U\$\$$/);

			const out = obf.obfuscate(`${token}ZZZZ`);

			expect(out).toContain(token);
			expect(out).not.toContain("ZZZZ");
		}
	});

	it("keeps default replace regex output idempotent around prior placeholders", () => {
		const obf = new SecretObfuscator(
			[
				{ type: "plain", content: "SECRETUV" },
				{ type: "regex", mode: "replace", content: "[A-Za-z0-9]{10}" },
			],
			"M".repeat(43),
		);

		const out = obf.obfuscate("SECRETUVX1");

		expect(obf.obfuscate(out)).toBe(out);
	});

	it("keeps broad default replace regex output idempotent around prior placeholders", () => {
		const obf = new SecretObfuscator(
			[
				{ type: "plain", content: "SECRETUV" },
				{ type: "regex", mode: "replace", content: "[A-Za-z0-9]+" },
			],
			"O".repeat(43),
		);

		const out = obf.obfuscate("SECRETUVX1");

		expect(obf.obfuscate(out)).toBe(out);
	});

	it("keeps default replace regex output idempotent after restart", () => {
		const key = "P".repeat(43);
		const first = new SecretObfuscator(
			[
				{ type: "plain", content: "SECRETUV" },
				{ type: "regex", mode: "replace", content: "[A-Za-z0-9]+" },
			],
			key,
		);
		const persisted = first.obfuscate("SECRETUVX1");
		const restarted = new SecretObfuscator(
			[
				{ type: "plain", content: "SECRETUV" },
				{ type: "regex", mode: "replace", content: "[A-Za-z0-9]+" },
			],
			key,
		);

		expect(restarted.obfuscate(persisted)).toBe(persisted);
	});

	it("keeps a multi-char default replace remainder stable across restart", () => {
		// Regression: a per-chunk remainder longer than the 2-char `ZZ` sentinel was
		// redacted to a content-derived `ZZ`+hash chunk that was only a fixed point
		// within the generating session (tracked in #generatedReplaceChunks). A fresh
		// obfuscator with the same key re-redacted it to a different value, so persisted
		// obfuscated text — and the provider prompt-cache prefixes it anchors — drifted
		// across restart (`ZZPL#…#` -> `ZZ7f#…#`). The remainder marker now depends only
		// on the key and length, so a fresh instance reproduces it byte-identically.
		const key = "Z".repeat(43);
		const entries = [
			{ type: "plain" as const, content: "ABCDEFGH" },
			{ type: "regex" as const, mode: "replace" as const, content: "[A-Z0-9]{12}" },
		];
		const first = new SecretObfuscator(entries, key);
		const token = first.obfuscate("ABCDEFGH");
		const persisted = first.obfuscate("BBBBABCDEFGH");

		// The 4-char remainder is redacted (raw bytes gone) but the placeholder survives.
		expect(persisted).not.toContain("BBBB");
		expect(persisted).toContain(token);
		expect(first.obfuscate(persisted)).toBe(persisted);

		// A fresh obfuscator (same key) reprocessing the persisted text must not drift.
		const restarted = new SecretObfuscator(entries, key);
		expect(restarted.obfuscate(persisted)).toBe(persisted);
	});

	it("ignores regex matches that fall entirely inside known placeholders", () => {
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: "abcdefgh" },
			{ type: "regex", mode: "replace", content: "P+", replacement: "REDACTED" },
		]);

		const obfuscated = obfuscator.obfuscate("abcdefgh");

		expect(obfuscated).not.toBe("REDACTED");
		expect(obfuscated).toMatch(/^\$\$[A-Z0-9]+:L\$\$$/);
		expect(obfuscator.deobfuscate(obfuscated)).toBe("abcdefgh");
	});

	it("ignores obfuscate regex matches that fall entirely inside known placeholders", () => {
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: "abcdefgh" },
			{ type: "regex", content: "P{8}", friendlyName: "inner" },
		]);

		const obfuscated = obfuscator.obfuscate("abcdefgh");

		expect(obfuscated).toMatch(/^\$\$[A-Z0-9]+:L\$\$$/);
		expect(obfuscated).not.toMatch(/^\$\$INNER_/);
		expect(obfuscator.deobfuscate(obfuscated)).toBe("abcdefgh");
	});

	it("ignores obfuscate regex matches that partially overlap known placeholders", () => {
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: "secretuv" },
			{ type: "regex", content: "P{3}X", friendlyName: "partial" },
		]);

		const obfuscated = obfuscator.obfuscate("secretuvX");

		expect(obfuscated).toMatch(/^\$\$[A-Z0-9]+:L\$\$X$/);
		expect(obfuscated).not.toMatch(/^\$\$PARTIAL_/);
		expect(obfuscator.deobfuscate(obfuscated)).toBe("secretuvX");
	});

	it("does not recursively rewrite plain secrets that look like placeholders", () => {
		const sharedKey = "D".repeat(43);
		const firstOnly = new SecretObfuscator(
			[{ type: "plain", content: "legacy-secret", friendlyName: "old" }],
			sharedKey,
		);
		const firstPlaceholder = firstOnly.obfuscate("legacy-secret");
		const secondOnly = new SecretObfuscator(
			[{ type: "plain", content: firstPlaceholder, friendlyName: "other" }],
			sharedKey,
		);
		const secondPlaceholder = secondOnly.obfuscate(firstPlaceholder);
		const obfuscator = new SecretObfuscator(
			[
				{ type: "plain", content: "legacy-secret", friendlyName: "old" },
				{ type: "plain", content: firstPlaceholder, friendlyName: "other" },
			],
			sharedKey,
		);

		expect(secondPlaceholder).toMatch(/^\$\$OTHER_[A-Z0-9]+(?::[ULCM])?\$\$$/);
		expect(obfuscator.deobfuscate(secondPlaceholder)).toBe(firstPlaceholder);
	});

	it("keeps no-name placeholders unprefixed but content-derived", () => {
		const first = new SecretObfuscator([
			{ type: "plain", content: "alpha-secret" },
			{ type: "plain", content: "beta-secret" },
		]);
		const second = new SecretObfuscator([
			{ type: "plain", content: "beta-secret" },
			{ type: "plain", content: "alpha-secret" },
		]);

		const firstToken = first.obfuscate("alpha-secret").match(/\$\$[A-Z0-9]+:L\$\$/)?.[0];
		const secondToken = second.obfuscate("alpha-secret").match(/\$\$[A-Z0-9]+:L\$\$/)?.[0];

		expect(firstToken).toBeDefined();
		expect(firstToken).toBe(secondToken);
		expect(firstToken).not.toMatch(/_[A-Z0-9]+/);
		expect(first.deobfuscate(firstToken ?? "")).toBe("alpha-secret");
	});

	it("leaves hash-delimited tokens inert while restoring current placeholders", () => {
		const obfuscator = new SecretObfuscator([{ type: "plain", content: "legacy-secret" }]);
		const current = obfuscator.obfuscate("legacy-secret");
		const message: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: `legacy #XRRS# current ${current}` }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		};

		const restored = deobfuscateAgentMessages(obfuscator, [message])[0];
		if (restored?.role !== "assistant") throw new Error("expected restored assistant message");
		const text = restored.content[0];
		expect(text?.type === "text" && text.text).toBe("legacy #XRRS# current legacy-secret");
	});

	it("deobfuscates placeholders after friendlyName changes", () => {
		const renamed = new SecretObfuscator([{ type: "plain", content: "renamed-secret", friendlyName: "new name" }]);
		const current = renamed.obfuscate("renamed-secret");
		const oldName = current.replace("$$NEWNAME_", () => "$$OLDNAME_");
		const removedName = new SecretObfuscator([{ type: "plain", content: "renamed-secret" }]);

		expect(current).toMatch(/^\$\$NEWNAME_[A-Z0-9]+:L\$\$$/);
		expect(renamed.deobfuscate(oldName)).toBe("renamed-secret");
		expect(removedName.deobfuscate(oldName)).toBe("renamed-secret");
	});

	it("keeps friendly-name-independent aliases unique for same-base same-hint secrets", () => {
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: "SeCretuv", friendlyName: "alpha" },
			{ type: "plain", content: "SecRetuv", friendlyName: "bravo" },
		]);
		const obfuscated = obfuscator.obfuscate("SeCretuv SecRetuv");
		const [tokenA, tokenB] = obfuscated.split(" ");
		if (!tokenA || !tokenB) throw new Error("expected two friendly placeholders");

		expect(tokenA).toMatch(/^\$\$ALPHA_[A-Z0-9]+:M\$\$$/);
		expect(tokenB).toMatch(/^\$\$BRAVO_[A-Z0-9]+:M\$\$$/);
		expect(obfuscator.deobfuscate(obfuscated)).toBe("SeCretuv SecRetuv");

		const aliasA = tokenA.replace(/^\$\$[A-Z0-9]+_/, () => "$$");
		const aliasB = tokenB.replace(/^\$\$[A-Z0-9]+_/, () => "$$");
		expect(aliasA).not.toBe(aliasB);
		expect(obfuscator.deobfuscate(aliasA)).toBe("SeCretuv");
		expect(obfuscator.deobfuscate(aliasB)).toBe("SecRetuv");
	});

	it("resolves a persisted friendly placeholder to the right same-base secret after a rename", () => {
		const original = new SecretObfuscator([
			{ type: "plain", content: "SeCretuv", friendlyName: "alpha" },
			{ type: "plain", content: "SecRetuv", friendlyName: "bravo" },
		]);
		const persistedBravo = original.obfuscate("SeCretuv SecRetuv").split(" ")[1];
		if (!persistedBravo) throw new Error("expected a bravo placeholder");

		// bravo renamed to charlie while both same-base secrets still exist.
		const renamed = new SecretObfuscator([
			{ type: "plain", content: "SeCretuv", friendlyName: "alpha" },
			{ type: "plain", content: "SecRetuv", friendlyName: "charlie" },
		]);
		expect(renamed.deobfuscate(persistedBravo)).toBe("SecRetuv");
	});

	it("rejects a forged placeholder wrapper that smuggles a real secret prefix past obfuscate()", () => {
		// Regression: #isGeneratedPlaceholder decides "is this span already a
		// safely-generated placeholder" for a friendly-prefixed candidate
		// (`#PREFIX_HASH:HINT#`) by falling back to the friendly-name-independent
		// bare alias `#HASH:HINT#` — the SAME loose lookup deobfuscate()
		// intentionally uses so a mangled/renamed friendly-name prefix still
		// round-trips. Accepting ANY prefix whose bare alias resolves let
		// untrusted text forge `#<REAL-SECRET>_<hash-of-some-OTHER-secret>:<hint>#`:
		// the other secret's bare alias resolves fine (it really is configured),
		// so the WHOLE forged token — including the exposed secret literal
		// standing in for the friendly name — was treated as already-redacted and
		// passed through obfuscate() untouched. The fix refuses the bare-alias
		// fallback whenever the dropped prefix CONTAINS a configured secret's
		// literal value (exactly, or as a substring), so a forged prefix built
		// from a real secret is never treated as safe, while a genuine
		// friendly-name label (or a stale one after a rename) still is.
		const secretA = "LEAKEDSECRETALPHA"; // uppercase-alnum: fits the placeholder-prefix grammar
		const secretB = "bravo-secret-9f3d8c2b";
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: secretA, friendlyName: "ALPHA" },
			{ type: "plain", content: secretB, friendlyName: "BRAVO" },
		]);

		// Learn secretB's real generated placeholder, then derive the friendly-
		// name-independent bare-alias suffix (`_<hash>:<hint>#`) that
		// lookupFriendlyPlaceholderAlias also resolves on purpose for deobfuscate().
		const bravoPlaceholder = obfuscator.obfuscate(secretB);
		expect(bravoPlaceholder).toMatch(/^\$\$BRAVO_[A-Z0-9]{4,}(?::[ULCM])?\$\$$/);
		const aliasSuffix = bravoPlaceholder.replace(/^\$\$BRAVO/, "");

		// Forge a token shaped exactly like a friendly placeholder for secretB, but
		// with secretA's raw literal value standing in for the friendly name.
		const forgedExact = `$$${secretA}${aliasSuffix}`;
		expect(forgedExact).toMatch(/^\$\$[A-Z0-9]+_[A-Z0-9]{4,}(?::[ULCM])?\$\$$/);
		expect(obfuscator.obfuscate(forgedExact)).not.toContain(secretA);

		// A prefix that merely CONTAINS secretA (not just equals it) must also be
		// rejected — the fix scans for containment, not exact equality.
		const forgedSubstring = `#X${secretA}Y${aliasSuffix}`;
		expect(obfuscator.obfuscate(forgedSubstring)).not.toContain(secretA);

		// Mixed real + forged in one call: the real secretB placeholder must still
		// round-trip normally via deobfuscate(), and the forged wrapper must still
		// not leak secretA.
		const mixed = `${bravoPlaceholder} then ${forgedExact}`;
		const mixedObfuscated = obfuscator.obfuscate(mixed);
		expect(mixedObfuscated).not.toContain(secretA);
		expect(mixedObfuscated).toContain(bravoPlaceholder);
		expect(obfuscator.deobfuscate(bravoPlaceholder)).toBe(secretB);
	});

	it("rejects a forged placeholder wrapper that smuggles a regex-discovered secret prefix past obfuscate()", () => {
		// Regression: the forged-prefix check above only ever scanned
		// `#configuredSecretValues` (secrets known up front). A regex-discovered
		// secret is never in that set — regex secrets are found dynamically as
		// obfuscate() encounters them — so a REGEX secret's literal value could
		// still be wrapped as the forged "friendly name" prefix around another
		// secret's real bare-alias suffix and sail through #isGeneratedPlaceholder
		// untouched. The fix also scans every value this instance has ever minted
		// an obfuscate-mode placeholder for (`#obfuscateMappings`, which regex
		// discoveries populate too), not just the always-known configured set.
		const regexSecret = "LEAKTOKEN42";
		const secretB = "bravo-secret-value";
		const obfuscator = new SecretObfuscator([
			{ type: "regex", content: "LEAKTOKEN[0-9]+", friendlyName: "leak" },
			{ type: "plain", content: secretB, friendlyName: "BRAVO" },
		]);

		// Force the regex secret to be discovered/minted first, matching the real
		// attack model of "attacker has observed this secret's placeholder in an
		// earlier turn" — only after this does #obfuscateMappings know its value.
		const regexPlaceholder = obfuscator.obfuscate(regexSecret);
		expect(regexPlaceholder).not.toContain(regexSecret);

		// Learn secretB's real placeholder, then derive the friendly-name-
		// independent bare-alias suffix (`_<hash>:<hint>#`).
		const bravoPlaceholder = obfuscator.obfuscate(secretB);
		expect(bravoPlaceholder).toMatch(/^\$\$BRAVO_[A-Z0-9]{4,}(?::[ULCM])?\$\$$/);
		const aliasSuffix = bravoPlaceholder.replace(/^\$\$BRAVO/, "");

		// Forge a token wrapping the REGEX secret's raw literal around secretB's
		// real bare-alias suffix.
		const forgedExact = `$$${regexSecret}${aliasSuffix}`;
		expect(forgedExact).toMatch(/^\$\$[A-Z0-9]+_[A-Z0-9]{4,}(?::[ULCM])?\$\$$/);
		expect(obfuscator.obfuscate(forgedExact)).not.toContain(regexSecret);

		// Mixed real + forged in one call: the real secretB placeholder must still
		// round-trip normally via deobfuscate(), and the forged wrapper must still
		// not leak the regex secret.
		const mixed = `${bravoPlaceholder} then ${forgedExact}`;
		const mixedObfuscated = obfuscator.obfuscate(mixed);
		expect(mixedObfuscated).not.toContain(regexSecret);
		expect(mixedObfuscated).toContain(bravoPlaceholder);
		expect(obfuscator.deobfuscate(bravoPlaceholder)).toBe(secretB);
	});

	it("rejects a forged alias wrapper whose prefix only matches a case-variant regex-discovered secret", () => {
		// Regression: the forged-prefix checks above only ever scanned EXACT
		// previously-DISCOVERED secret strings (`#configuredSecretValues` and
		// `#obfuscateMappings`), recorded in whatever casing they first turned
		// up in. A case-insensitive (or other flag-variant) regex — e.g.
		// `{ type: "regex", content: "tok[a-z0-9]+", flags: "i" }` — only ever
		// records the ONE casing it actually discovered (lowercase
		// `tokabc123`) in `#obfuscateMappings`. A forged token wrapping a
		// DIFFERENTLY-cased occurrence of that same secret-shaped text
		// (`TOKABC123`) around a real bare-alias suffix matched neither exact-
		// string check, so it sailed through #isGeneratedPlaceholder as an
		// already-generated placeholder and the uppercase secret text leaked
		// verbatim. The fix also tests the dropped prefix directly against the
		// configured regex's own pattern, which matches regardless of the
		// casing the secret was first discovered under.
		const obf = new SecretObfuscator([{ type: "regex", content: "tok[a-z0-9]+", flags: "i" }], "Q".repeat(43));

		// Discover the secret in lowercase, minting a real bare placeholder and
		// registering `tokabc123` (not `TOKABC123`) in `#obfuscateMappings`.
		const real = obf.obfuscate("use tokabc123 now");
		expect(real).not.toContain("tokabc123");
		const suffix = /\$\$([A-Z0-9]{4,}(?::[ULCM])?)\$\$/.exec(real)?.[1];
		expect(suffix).toBeDefined();

		// Forge a token wrapping an UPPERCASE variant of the secret around the
		// real bare-alias suffix — differently cased from what was actually
		// discovered, so it cannot match either exact-string check, only the
		// regex pattern itself.
		const forged = `see $$TOKABC123_${suffix}$$ here`;
		const out = obf.obfuscate(forged);
		expect(out).not.toContain("TOKABC123");
	});

	it("refuses deobfuscate()'s bare-alias fallback for a forged secret-shaped prefix, but still honors a genuine rename", () => {
		// Regression: `#lookupLiveAlias`'s bare-alias fallback (`#PREFIX_HASH#` →
		// strip prefix → look up bare `#HASH#`) used to accept ANY prefix
		// unconditionally as long as the bare hash suffix belonged to a real
		// placeholder. On the live provider-output / tool-call-argument restore
		// path, an attacker who observed any real placeholder's bare hash suffix
		// elsewhere in a transcript could wrap it in a forged prefix that is a
		// sanitized/normalized rendering of a configured secret's own value (or a
		// different secret's), and deobfuscate() would restore that OTHER
		// secret's raw value in its place — worse than the obfuscate-direction
		// leak defended against above, since this is the path that reconstitutes
		// real secrets for outbound tool calls. The fix reuses
		// `#prefixIsSecretShaped` (shared with `#isGeneratedPlaceholder`) to
		// refuse the fallback whenever the dropped prefix is itself
		// secret-shaped, while a genuine friendly-name rename — a prefix that
		// matches no configured secret value or pattern — still round-trips.
		const secret = "github_pat_abc123";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);

		const real = obfuscator.obfuscate(secret);
		const suffix = /\$\$([A-Z0-9]{4,}(?::[ULCM])?)\$\$/.exec(real)?.[1];
		expect(suffix).toBeDefined();

		// Forge a prefix that is the sanitized rendering of the SAME configured
		// secret's own value, wrapped around the real bare-alias suffix.
		const forged = `run tool with $$GITHUBPATABC123_${suffix}$$ now`;
		const restored = obfuscator.deobfuscate(forged);
		expect(restored).not.toContain(secret);
		expect(restored).toContain("$$GITHUBPATABC123_");

		// A genuine rename is unaffected: the OLD friendly-name prefix is not
		// itself secret-shaped, so the bare-alias fallback still resolves it to
		// the same secret under the RENAMED (equally non-secret-shaped) prefix.
		const renameObfuscator = new SecretObfuscator([
			{ type: "plain", content: "some-other-secret-value", friendlyName: "OldName" },
		]);
		const currentToken = renameObfuscator.obfuscate("some-other-secret-value");
		expect(currentToken).toMatch(/^\$\$OLDNAME_[A-Z0-9]+:L\$\$$/);
		const renameSuffix = currentToken.replace(/^\$\$OLDNAME/, "");
		expect(renameObfuscator.deobfuscate(`$$NEWNAME${renameSuffix}`)).toBe("some-other-secret-value");
	});

	it("drops a friendly name that contains another configured secret's literal value", () => {
		// Regression: a friendlyName is baked verbatim into every placeholder
		// minted for its secret (`#NAME_hash:hint#`) via an EXACT
		// `#deobfuscateMap` entry — not through the loose alias-fallback lookup
		// the forged-wrapper tests above defend against. If that friendly name
		// happens to CONTAIN another LIVE secret's literal value, the baked-in
		// prefix leaks that other secret on every use of THIS secret — and,
		// because the whole token is now a recognized "already generated"
		// placeholder, the leaked literal is protected from ever being redacted
		// by that other secret's own plain-secret pass. The fix refuses the
		// friendly-name prefix for this specific mint (falling back to a bare,
		// unprefixed placeholder) whenever the sanitized name contains a
		// configured plain secret's literal value.
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: "ABCDEFGH", friendlyName: "LEAKTOKEN" },
			{ type: "plain", content: "LEAKTOKEN" },
			{ type: "plain", content: "OTHERSECRETXY", friendlyName: "SAFE" },
		]);

		const obfuscated = obfuscator.obfuscate("ABCDEFGH");
		expect(obfuscated).not.toContain("LEAKTOKEN");
		// Friendly name dropped for this mint: bare, unprefixed placeholder shape.
		expect(obfuscated).toMatch(/^\$\$[A-Z0-9]{4,}(?::[ULCM])?\$\$$/);

		// A friendly name that does NOT collide with any live secret is unaffected.
		const safeObfuscated = obfuscator.obfuscate("OTHERSECRETXY");
		expect(safeObfuscated).toMatch(/^\$\$SAFE_[A-Z0-9]{4,}(?::[ULCM])?\$\$$/);
	});

	it("drops a friendly name matched by a later-declared regex secret, regardless of entries[] order", () => {
		// Regression: the collision guard above must also cover configured REGEX
		// patterns, not just plain-secret literals — and must do so regardless of
		// where the regex entry sits in `entries[]`. The constructor compiles
		// every regex entry into `#regexEntries` in a dedicated pass BEFORE any
		// placeholder is minted, so a plain entry's friendly name is checked
		// against a fully-populated regex set even when its colliding regex entry
		// is declared LATER in the array. A naive fix that only pre-collected
		// plain-secret literals (leaving regex compilation in the same forward
		// pass that mints placeholders) would miss exactly this ordering: at mint
		// time for the entry below, `#regexEntries` would still be empty.
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: "ABCDEFGH", friendlyName: "LEAKTOKEN" },
			{ type: "regex", content: "LEAKTOKEN" },
		]);

		const obfuscated = obfuscator.obfuscate("ABCDEFGH");
		expect(obfuscated).not.toContain("LEAKTOKEN");
		expect(obfuscated).toMatch(/^\$\$[A-Z0-9]{4,}(?::[ULCM])?\$\$$/);
	});

	it("keeps a mixed-case placeholder stable when a same-normalized secret is added earlier", () => {
		// Session 1: only SecRet is configured; persist its mixed-case token.
		const before = new SecretObfuscator([{ type: "plain", content: "SecRetuv" }]);
		const persisted = before.obfuscate("SecRetuv");
		expect(persisted).toMatch(/^\$\$[A-Z0-9]+:M\$\$$/);

		// Session 2: SeCret (same normalized value, also :M) is added EARLIER.
		const after = new SecretObfuscator([
			{ type: "plain", content: "SeCretuv" },
			{ type: "plain", content: "SecRetuv" },
		]);

		// SecRet's token must be value-stable, not bumped to a fallback, so the
		// persisted placeholder still round-trips to SecRet rather than SeCret.
		expect(after.obfuscate("SecRetuv")).toBe(persisted);
		expect(after.deobfuscate(persisted)).toBe("SecRetuv");
		expect(after.obfuscate("SeCretuv")).not.toBe(persisted);
	});

	it("derives each placeholder purely from its own secret, independent of load order", () => {
		// A secret persisted alone must keep the same token when unrelated secrets
		// are later added before it, so old session text never aliases to another
		// secret because of config/env ordering.
		const alone = new SecretObfuscator([{ type: "plain", content: "secret397" }]);
		const persisted = alone.obfuscate("secret397");

		const before = new SecretObfuscator([
			{ type: "plain", content: "secret658" },
			{ type: "plain", content: "secret397" },
		]);
		const after = new SecretObfuscator([
			{ type: "plain", content: "secret397" },
			{ type: "plain", content: "secret658" },
		]);

		expect(before.obfuscate("secret397")).toBe(persisted);
		expect(after.obfuscate("secret397")).toBe(persisted);
		expect(before.deobfuscate(persisted)).toBe("secret397");
		expect(before.obfuscate("secret658")).not.toBe(persisted);
	});

	it("keeps Unicode case variants on distinct bases despite a shared ASCII hint", () => {
		// `Äbc` and `äbc` differ only by Unicode case; the ASCII case hint (`:L`)
		// cannot reconstruct Unicode casing, so they must NOT share a base key. A
		// `secret.toLowerCase()` normalization folds `Ä`→`ä` and collapses them,
		// letting a persisted token alias to whichever secret loads first.
		const alone = new SecretObfuscator([{ type: "plain", content: "Äbcdefgh" }]);
		const persisted = alone.obfuscate("Äbcdefgh");

		// A later session loads `äbc` EARLIER than `Äbc`.
		const reordered = new SecretObfuscator([
			{ type: "plain", content: "äbcdefgh" },
			{ type: "plain", content: "Äbcdefgh" },
		]);

		expect(reordered.obfuscate("Äbcdefgh")).toBe(persisted);
		expect(reordered.obfuscate("äbcdefgh")).not.toBe(persisted);
		expect(reordered.deobfuscate(persisted)).toBe("Äbcdefgh");
		expect(reordered.deobfuscate(reordered.obfuscate("äbcdefgh"))).toBe("äbcdefgh");
	});

	it("derives placeholders from a keyed digest, not a public content hash", () => {
		// A provider that sees the placeholder and knows the algorithm must not be
		// able to dictionary low-entropy secrets: the base is keyed by a private
		// per-install secret, so the same secret yields different tokens per key.
		const secret = "hunter2-password";
		const keyA = new SecretObfuscator([{ type: "plain", content: secret }], "install-key-a");
		const keyB = new SecretObfuscator([{ type: "plain", content: secret }], "install-key-b");

		const tokenA = keyA.obfuscate(secret);
		const tokenB = keyB.obfuscate(secret);

		expect(tokenA).not.toBe(secret);
		expect(tokenA).not.toBe(tokenB);

		// Same key + same secret is stable across instances and round-trips.
		const keyAgain = new SecretObfuscator([{ type: "plain", content: secret }], "install-key-a");
		expect(keyAgain.obfuscate(secret)).toBe(tokenA);
		expect(keyA.deobfuscate(tokenA)).toBe(secret);
	});

	it("redacts its own keyed-hash key from obfuscated output", () => {
		// The key can be read from a user-readable config file by a prompt-injected
		// tool; if it reached the provider verbatim, the keyed placeholder bases
		// could be dictionaried, so the obfuscator must never emit its own key.
		const key = "install-key-that-must-never-leak-1234567890";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: "real-secret" }], key);
		const obfuscated = obfuscator.obfuscate(`cat secret-placeholder.key => ${key} (and real-secret)`);

		expect(obfuscated).not.toContain(key);
		expect(obfuscated).not.toContain("real-secret");
	});

	it("withholds pending placeholders while streaming provider text", () => {
		expect(stripPendingSecretPlaceholderSuffix("before $")).toBe("before ");
		expect(stripPendingSecretPlaceholderSuffix("before $$")).toBe("before ");
		expect(stripPendingSecretPlaceholderSuffix("before $$AB12:")).toBe("before ");
		expect(stripPendingSecretPlaceholderSuffix("before $$TOKEN")).toBe("before ");
		expect(stripPendingSecretPlaceholderSuffix("before $$TOKEN_")).toBe("before ");
		expect(stripPendingSecretPlaceholderSuffix("before $$TOKEN_AB12:")).toBe("before ");
		expect(stripPendingSecretPlaceholderSuffix("before $$TOKEN_AB12:U")).toBe("before ");
		// A trailing delimiter character is buffered because it can open an adjacent placeholder.
		expect(stripPendingSecretPlaceholderSuffix("before $$TOKEN_AB12:U$$")).toBe("before $$TOKEN_AB12:U");
		expect(stripPendingSecretPlaceholderSuffix("prefix ID$")).toBe("prefix ID");
		expect(stripPendingSecretPlaceholderSuffix("count 42$")).toBe("count 42");
		expect(stripPendingSecretPlaceholderSuffix("before $$TOKEN ")).toBe("before $$TOKEN ");
		// A single `$` followed by non-`$` can never open a `$$…$$` placeholder, so it
		// must stream through instead of being withheld until the next boundary.
		expect(stripPendingSecretPlaceholderSuffix("run $HOME")).toBe("run $HOME");
		expect(stripPendingSecretPlaceholderSuffix("pay $100")).toBe("pay $100");
		expect(stripPendingSecretPlaceholderSuffix("cost $$100")).toBe("cost ");
	});

	it("uses independent bases across casing variants with distinct hints", () => {
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: "secretuv", friendlyName: "token" },
			{ type: "plain", content: "SECRETUV", friendlyName: "token" },
			{ type: "plain", content: "Secretuv", friendlyName: "token" },
		]);
		const obfuscated = obfuscator.obfuscate("secretuv SECRETUV Secretuv");
		const tokens = obfuscated.match(/\$\$TOKEN_[A-Z0-9]+:[ULCM]\$\$/g);
		if (!tokens) throw new Error("Expected case-hinted placeholders");
		const bases = tokens.map(token => /^\$\$TOKEN_([A-Z0-9]+):/.exec(token)?.[1]);

		expect(tokens).toHaveLength(3);
		// Distinct ASCII-case variants must NOT share a base: a shared case-folded
		// base would let a provider synthesize a sibling token by swapping the hint.
		expect(new Set(bases).size).toBe(3);
		expect(tokens[0]?.endsWith(":L$$")).toBe(true);
		expect(tokens[1]?.endsWith(":U$$")).toBe(true);
		expect(tokens[2]?.endsWith(":C$$")).toBe(true);
		expect(obfuscator.deobfuscate(obfuscated)).toBe("secretuv SECRETUV Secretuv");
	});

	it("does not restore a case-variant sibling synthesized by swapping the hint", () => {
		// P1: two obfuscate-mode secrets differing only by ASCII case. Only the
		// lowercase one is ever provider-visible; a prompt-injected model must not
		// recover the uppercase secret (never emitted) by taking the visible
		// token's base and swapping the case hint in a tool-call argument.
		const key = "case-variant-install-key-0000000000000000000";
		const obfuscator = new SecretObfuscator(
			[
				{ type: "plain", content: "abc12345" },
				{ type: "plain", content: "ABC12345" },
			],
			key,
		);

		// Provider sees only the lowercase placeholder.
		const visible = obfuscator.obfuscate("abc12345");
		expect(visible).toMatch(/^\$\$[A-Z0-9]+:L\$\$$/);
		const base = /^\$\$([A-Z0-9]+):L\$\$$/.exec(visible)?.[1];
		if (!base) throw new Error("expected a lowercase placeholder base");

		// The uppercase secret's real token uses an independent base.
		const upperReal = obfuscator.obfuscate("ABC12345");
		expect(upperReal).toMatch(/^\$\$[A-Z0-9]+:U\$\$$/);
		expect(upperReal).not.toBe(`$$${base}:U$$`);

		// Live deobfuscation of the synthesized sibling token leaves it literal
		// instead of restoring the never-provider-visible uppercase secret.
		const synthesized = `$$${base}:U$$`;
		expect(obfuscator.deobfuscate(synthesized)).toBe(synthesized);
		expect(obfuscator.deobfuscateObject({ cmd: synthesized })).toEqual({ cmd: synthesized });
		// The legitimate visible token still round-trips.
		expect(obfuscator.deobfuscate(visible)).toBe("abc12345");
	});

	it("gives duplicate mixed-case variants distinct placeholders", () => {
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: "SeCretuv", friendlyName: "token" },
			{ type: "plain", content: "SecRetuv", friendlyName: "token" },
		]);
		const repeated = new SecretObfuscator([
			{ type: "plain", content: "SeCretuv", friendlyName: "token" },
			{ type: "plain", content: "SecRetuv", friendlyName: "token" },
		]);
		const input = "SeCretuv SecRetuv";
		const obfuscated = obfuscator.obfuscate(input);
		const tokens = obfuscated.match(/\$\$TOKEN_[A-Z0-9]+:M\$\$/g);
		if (!tokens) throw new Error("Expected mixed-case placeholders");

		expect(tokens).toHaveLength(2);
		expect(new Set(tokens).size).toBe(2);
		expect(repeated.obfuscate(input)).toBe(obfuscated);
		expect(obfuscator.deobfuscate(obfuscated)).toBe(input);
	});

	it("allows duplicate friendly names because hash suffixes disambiguate them", () => {
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: "first-token", friendlyName: "api" },
			{ type: "plain", content: "second-token", friendlyName: "api" },
		]);
		const obfuscated = obfuscator.obfuscate("first-token second-token");
		const tokens = obfuscated.match(/\$\$API_[A-Z0-9]+:L\$\$/g);
		if (!tokens) throw new Error("Expected friendly-name placeholders");

		expect(tokens).toHaveLength(2);
		expect(new Set(tokens).size).toBe(2);
		expect(obfuscator.deobfuscate(obfuscated)).toBe("first-token second-token");
	});

	it("sanitizes and caps friendly names", () => {
		expect(sanitizeSecretFriendlyName("git hub-token!!!")).toBe("GITHUBTOKEN");
		expect(sanitizeSecretFriendlyName("0123456789abcdefghijklmnopqrstuvwxyz")).toBe(
			"0123456789ABCDEFGHIJKLMNOPQRSTUV",
		);
		expect(sanitizeSecretFriendlyName("***")).toBeUndefined();
	});

	it("omits invalid friendlyName metadata without dropping the secret", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-secret-friendly-"));
		try {
			const project = path.join(root, "project");
			const agentDir = path.join(root, "agent");
			await fs.mkdir(path.join(project, ".omp"), { recursive: true });
			await fs.mkdir(agentDir, { recursive: true });
			await fs.writeFile(
				path.join(project, ".omp", "secrets.yml"),
				"- type: plain\n  content: invalid-friendly-secret\n  friendlyName: '***'\n",
			);

			const entries = await loadSecrets(project, agentDir);
			const obfuscator = new SecretObfuscator(entries);
			const obfuscated = obfuscator.obfuscate("invalid-friendly-secret");

			expect(entries).toHaveLength(1);
			expect(entries[0]?.friendlyName).toBeUndefined();
			expect(obfuscated).toMatch(/\$\$[A-Z0-9]+:L\$\$/);
			expect(obfuscated).not.toMatch(/_[A-Z0-9]+/);
			expect(obfuscator.deobfuscate(obfuscated)).toBe("invalid-friendly-secret");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("omits non-string friendlyName metadata without dropping the secret", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-secret-friendly-"));
		try {
			const project = path.join(root, "project");
			const agentDir = path.join(root, "agent");
			await fs.mkdir(path.join(project, ".omp"), { recursive: true });
			await fs.mkdir(agentDir, { recursive: true });
			await fs.writeFile(
				path.join(project, ".omp", "secrets.yml"),
				"- type: plain\n  content: non-string-friendly-secret\n  friendlyName: 123\n",
			);

			const entries = await loadSecrets(project, agentDir);
			const obfuscator = new SecretObfuscator(entries);
			const obfuscated = obfuscator.obfuscate("non-string-friendly-secret");

			expect(entries).toHaveLength(1);
			expect(entries[0]?.friendlyName).toBeUndefined();
			expect(obfuscated).toMatch(/\$\$[A-Z0-9]+:L\$\$/);
			expect(obfuscated).not.toMatch(/_[A-Z0-9]+/);
			expect(obfuscator.deobfuscate(obfuscated)).toBe("non-string-friendly-secret");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("rejects a secrets.yml replace regex entry that can never redact a 1-2 char match distinctly from itself", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-secret-friendly-"));
		try {
			const project = path.join(root, "project");
			const agentDir = path.join(root, "agent");
			await fs.mkdir(path.join(project, ".omp"), { recursive: true });
			await fs.mkdir(agentDir, { recursive: true });
			await fs.writeFile(
				path.join(project, ".omp", "secrets.yml"),
				'- type: regex\n  mode: replace\n  content: "."\n',
			);

			const entries = await loadSecrets(project, agentDir);

			expect(entries).toEqual([]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("preserves the raw friendlyName from secrets.yml so a regex entry's self-collision check still catches it", async () => {
		// Regression: `loadFriendlyName` used to return the SANITIZED (uppercased,
		// separator-stripped) friendlyName, which then got stored verbatim as
		// `entry.friendlyName` in the loaded `SecretEntry`. That defeated the
		// regex-entry self-collision check above (see "rejects a regex entry
		// friendlyName that is itself a live match for its own pattern"), which
		// must test the RAW label against the configured pattern: a
		// case-sensitive/punctuated pattern like `tok_[a-z0-9]+` can never match
		// an already-uppercased, separator-stripped rendering of itself. The fix
		// still validates the friendlyName but returns it unsanitized.
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-secret-friendly-"));
		try {
			const project = path.join(root, "project");
			const agentDir = path.join(root, "agent");
			await fs.mkdir(path.join(project, ".omp"), { recursive: true });
			await fs.mkdir(agentDir, { recursive: true });
			await fs.writeFile(
				path.join(project, ".omp", "secrets.yml"),
				'- type: regex\n  content: "tok_[a-z0-9]+"\n  friendlyName: "tok_abc123"\n',
			);

			const entries = await loadSecrets(project, agentDir);
			expect(entries[0]?.friendlyName).toBe("tok_abc123");

			const obfuscator = new SecretObfuscator(entries);
			const obfuscated = obfuscator.obfuscate("use tok_abc123 now");

			expect(obfuscated).not.toMatch(/TOKABC123_/);
			expect(obfuscated).toMatch(/^use \$\$[A-Z0-9]+:L\$\$ now$/);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

describe("SecretObfuscator cross-turn cache stability", () => {
	// The provider prompt cache is content-addressed: convertToLlm / transformProviderContext
	// re-run obfuscation over the WHOLE message array every turn, so a non-deterministic
	// placeholder for the same secret would rewrite already-sent prefix bytes and bust the
	// cache (cacheWrite @ $6.25/M vs cacheRead @ $0.50/M on opus). These tests pin the
	// determinism that makes obfuscation cache-safe so a future change cannot silently
	// reintroduce per-turn cache invalidation.
	it("produces byte-identical output when re-obfuscating the same content across turns", () => {
		const secret = "SUPER_SECRET_TOKEN_12345";
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: secret },
			{ type: "regex", content: "tok_[a-z0-9]+" },
		]);
		const messages: Message[] = [{ role: "user", content: `use ${secret} and tok_abc123`, timestamp: 1 }];

		const turn1 = JSON.stringify(obfuscateMessages(obfuscator, messages));
		const turn2 = JSON.stringify(obfuscateMessages(obfuscator, messages));

		expect(turn1).not.toContain(secret);
		expect(turn1).not.toContain("tok_abc123");
		// Identical bytes on the second pass → the cached prefix stays valid.
		expect(turn2).toEqual(turn1);
	});

	it("keeps earlier message placeholders stable when a later message reveals a new regex secret", () => {
		const obfuscator = new SecretObfuscator([{ type: "regex", content: "tok_[a-z0-9]+" }]);
		const early: Message[] = [{ role: "user", content: "first uses tok_aaaa", timestamp: 1 }];

		// Turn N: only the early message exists; tok_aaa mints a fresh placeholder.
		const earlyTurnN = JSON.stringify(obfuscateMessages(obfuscator, early));
		expect(earlyTurnN).not.toContain("tok_aaaa");

		// A later turn reveals a brand-new secret. Lazy regex discovery assigns it a fresh
		// index — this MUST NOT shift the placeholder already minted for tok_aaa.
		const later: Message[] = [{ role: "user", content: "later uses tok_bbbb", timestamp: 2 }];
		const laterOut = JSON.stringify(obfuscateMessages(obfuscator, later));
		expect(laterOut).not.toContain("tok_bbbb");

		// Re-obfuscate the early message after the new discovery: identical bytes → the
		// already-cached prefix for the early message stays valid.
		const earlyTurnNPlus1 = JSON.stringify(obfuscateMessages(obfuscator, early));
		expect(earlyTurnNPlus1).toEqual(earlyTurnN);
	});

	it("shares regex-protected values across the whole outbound batch so an earlier message's friendly prefix cannot leak a later message's secret", () => {
		// Regression: obfuscateMessages precomputes `sharedRegexSecretValues` across
		// ALL targeted message texts before obfuscating any single one. Without that
		// precomputation, processing messages one by one would let an EARLIER message
		// mint a friendly-prefixed placeholder for `OTHERSECRET` before the regex
		// value it collides with (`tok_abc123`, sanitized to `TOKABC123`, matching the
		// `friendlyName`) is even discovered in a LATER message — baking a normalized
		// rendering of that later secret into provider-visible text as an "innocent"
		// friendly label instead of stripping it to a bare placeholder.
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: "OTHERSECRET", friendlyName: "TOKABC123" },
			{ type: "regex", content: "tok_[a-z0-9]+" },
		]);
		const messages: Message[] = [
			{ role: "user", content: "first message carries OTHERSECRET", timestamp: 1 },
			{ role: "user", content: "later message reveals tok_abc123", timestamp: 2 },
		];

		const obfuscated = obfuscateMessages(obfuscator, messages);
		const serialized = JSON.stringify(obfuscated);

		expect(serialized).not.toContain("OTHERSECRET");
		expect(serialized).not.toContain("tok_abc123");
		// The friendly prefix is itself a normalized rendering of the later-discovered
		// regex value; sharing regex values across the batch up front must strip it
		// down to a bare placeholder rather than bake it into message 1's output.
		expect(serialized).not.toContain("TOKABC123_");

		// Both originals still round-trip through deobfuscation of the serialized batch.
		const restored = obfuscator.deobfuscate(serialized);
		expect(restored).toContain("OTHERSECRET");
		expect(restored).toContain("tok_abc123");

		// Re-obfuscating the already-obfuscated batch is a fixed point: identical bytes,
		// so re-running obfuscateMessages over a growing conversation never busts the
		// provider prompt cache for messages already sent.
		expect(JSON.stringify(obfuscateMessages(obfuscator, obfuscated))).toEqual(serialized);
	});

	it("includes assistant replay content in the batch regex collision pre-scan", () => {
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: "OTHERSECRET", friendlyName: "TOKABC123" },
			{ type: "regex", content: "tok_[a-z0-9]+" },
		]);
		const messages: Message[] = [
			{ role: "user", content: "first message carries OTHERSECRET", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { token: "tok_abc123" } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test-model",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 2,
			},
		];

		const serialized = JSON.stringify(obfuscateMessages(obfuscator, messages));

		expect(serialized).not.toContain("OTHERSECRET");
		expect(serialized).not.toContain("tok_abc123");
		expect(serialized).not.toContain("TOKABC123_");
	});

	it("collects regex-protected values across the whole tool-call argument payload before obfuscating any single string", () => {
		// Regression: `obfuscateToolArguments` must precompute regex-protected
		// values by walking the ENTIRE JSON argument object up front — the same
		// whole-batch precomputation `obfuscateMessages` performs above — before
		// redacting any single string within it, when the caller passes no
		// `sharedRegexSecretValues` of its own. Mapping each JSON string
		// independently (obfuscating `first` before `nested.later` is ever
		// visited) would let `first`'s OTHERSECRET mint a friendly-prefixed
		// placeholder before `tok_abc123` is discovered deeper in the same
		// payload, baking a normalized rendering of that later secret into
		// provider-visible text as an "innocent" friendly label.
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: "OTHERSECRET", friendlyName: "TOKABC123" },
			{ type: "regex", content: "tok_[a-z0-9]+" },
		]);
		const args = { first: "OTHERSECRET", nested: { later: "tok_abc123" } };

		const obfuscated = obfuscateToolArguments(obfuscator, args);
		const serialized = JSON.stringify(obfuscated);

		expect(serialized).not.toContain("OTHERSECRET");
		expect(serialized).not.toContain("tok_abc123");
		// The friendly prefix is itself a normalized rendering of the
		// later-discovered regex value; collecting regex values across the whole
		// payload up front must strip it down to a bare placeholder rather than
		// bake it into `first`'s output before `nested.later` is ever visited.
		expect(serialized).not.toContain("TOKABC123_");

		// Both originals round-trip through deobfuscation of the serialized args.
		expect(deobfuscateToolArguments(obfuscator, obfuscated)).toEqual(args);

		// Re-obfuscating the already-obfuscated args is a fixed point: identical
		// bytes, matching the cache-stability guarantee `obfuscateMessages` gives
		// full conversation batches.
		expect(JSON.stringify(obfuscateToolArguments(obfuscator, obfuscated))).toEqual(serialized);
	});

	it("strips a stale friendly prefix from persisted assistant history once a later message reveals the colliding regex secret", () => {
		// Regression: `obfuscateAssistantContentForReplay` only scans
		// the assistant content passed to THIS call. If an earlier turn already
		// minted `#TOKABC123_<hash>#` for `OTHERSECRET` and that exact placeholder
		// was persisted verbatim into assistant history before `tok_abc123` was
		// ever seen, replaying that history alongside a NEW message that finally
		// reveals `tok_abc123` must still scrub the now-unsafe prefix out of the
		// OLD assistant text — not merely avoid minting a fresh prefixed one.
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: "OTHERSECRET", friendlyName: "TOKABC123" },
			{ type: "regex", content: "tok_[a-z0-9]+" },
		]);

		function assistantText(message: Message): string {
			if (message.role !== "assistant") throw new Error("expected an assistant message");
			const block = message.content.find((c): c is TextContent => c.type === "text");
			if (block === undefined) throw new Error("expected an assistant text block");
			return block.text;
		}
		function toolResultText(message: Message): string {
			if (message.role !== "toolResult") throw new Error("expected a toolResult message");
			const block = message.content.find((c): c is TextContent => c.type === "text");
			if (block === undefined) throw new Error("expected a toolResult text block");
			return block.text;
		}
		function userText(message: Message): string {
			if (message.role !== "user") throw new Error("expected a user message");
			if (typeof message.content !== "string") throw new Error("expected string user content");
			return message.content;
		}

		// Turn 1: mint the friendly-prefixed placeholder for OTHERSECRET while
		// tok_abc123 is still unknown to this obfuscator instance — nothing in
		// this batch matches the regex pattern, so the collision guard has
		// nothing to compare the friendly name against yet.
		const minted = obfuscateMessages(obfuscator, [
			{ role: "user", content: "remember OTHERSECRET for later", timestamp: 1 },
		]);
		const mintedMatch = /\$\$TOKABC123_[A-Z0-9]+(?::[ULCM])?\$\$/.exec(userText(minted[0]));
		if (mintedMatch === null) throw new Error("expected turn 1 to mint a friendly-prefixed placeholder");
		const mintedPlaceholder = mintedMatch[0];
		const bareAlias = mintedPlaceholder.replace(/^\$\$TOKABC123_/, "$$");

		// Turn 2: assistant history persisted that exact prefixed placeholder
		// verbatim, wrapped in ordinary prose that carries no secret material
		// and must survive untouched. A tool result in the same batch finally
		// reveals the raw regex-protected secret it collides with.
		const untouchedPrefix = "Sure, I stored it — ";
		const untouchedSuffix = " — anything else?";
		const assistantMessage: Message = {
			role: "assistant",
			content: [{ type: "text", text: `${untouchedPrefix}${mintedPlaceholder}${untouchedSuffix}` }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		};
		const toolResultMessage: Message = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text", text: "the real token is tok_abc123" }],
			isError: false,
			timestamp: 3,
		};

		const result = obfuscateMessages(obfuscator, [assistantMessage, toolResultMessage]);
		const strippedAssistantText = assistantText(result[0]);
		const redactedToolResultText = toolResultText(result[1]);

		// The stale friendly prefix is gone, replaced by the friendly-name-
		// independent bare alias minted back in turn 1...
		expect(strippedAssistantText).not.toContain("TOKABC123_");
		expect(strippedAssistantText).toContain(bareAlias);
		// ...while the surrounding raw assistant prose is untouched byte-for-byte.
		expect(strippedAssistantText).toContain(untouchedPrefix);
		expect(strippedAssistantText).toContain(untouchedSuffix);

		// The newly revealed raw secret is redacted in the tool result.
		expect(redactedToolResultText).not.toContain("tok_abc123");

		// Both secrets still round-trip through deobfuscation of the serialized batch.
		const serialized = JSON.stringify(result);
		const restored = obfuscator.deobfuscate(serialized);
		expect(restored).toContain("OTHERSECRET");
		expect(restored).toContain("tok_abc123");

		// Fixed point: re-obfuscating the already-stripped batch changes nothing further.
		expect(JSON.stringify(obfuscateMessages(obfuscator, result))).toEqual(serialized);
	});

	it("strips a stale friendly prefix from an assistant toolCall block's arguments, intent, and rawBlock once a later message reveals the colliding regex secret", () => {
		// Regression: `obfuscateAssistantContentForReplay` walks `text`
		// blocks and `toolCall` blocks differently — a toolCall's `arguments`,
		// `intent`, and `rawBlock` are where the model's own tool invocations
		// persist a friendly-prefixed placeholder minted in an earlier turn. If a
		// later message reveals the regex-protected value that placeholder's
		// friendly name normalizes to, the toolCall fields must be re-scanned and
		// scrubbed exactly like assistant text — leaving "TOKABC123_" baked into a
		// replayed tool call would expose the very value `tok_[a-z0-9]+` is
		// configured to hide, just via a different content-block type.
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: "OTHERSECRET", friendlyName: "TOKABC123" },
			{ type: "regex", content: "tok_[a-z0-9]+" },
		]);

		type AssistantToolCallBlock = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;
		function assistantToolCall(message: Message): AssistantToolCallBlock {
			if (message.role !== "assistant") throw new Error("expected an assistant message");
			const block = message.content.find((c): c is AssistantToolCallBlock => c.type === "toolCall");
			if (block === undefined) throw new Error("expected an assistant toolCall block");
			return block;
		}
		function toolResultText(message: Message): string {
			if (message.role !== "toolResult") throw new Error("expected a toolResult message");
			const block = message.content.find((c): c is TextContent => c.type === "text");
			if (block === undefined) throw new Error("expected a toolResult text block");
			return block.text;
		}
		function userText(message: Message): string {
			if (message.role !== "user") throw new Error("expected a user message");
			if (typeof message.content !== "string") throw new Error("expected string user content");
			return message.content;
		}

		// Turn 1: mint the friendly-prefixed placeholder for OTHERSECRET while
		// tok_abc123 is still unknown to this obfuscator instance.
		const minted = obfuscateMessages(obfuscator, [
			{ role: "user", content: "remember OTHERSECRET for later", timestamp: 1 },
		]);
		const mintedMatch = /\$\$TOKABC123_[A-Z0-9]+(?::[ULCM])?\$\$/.exec(userText(minted[0]));
		if (mintedMatch === null) throw new Error("expected turn 1 to mint a friendly-prefixed placeholder");
		const mintedPlaceholder = mintedMatch[0];
		const bareAlias = mintedPlaceholder.replace(/^\$\$TOKABC123_/, "$$");

		// Turn 2: assistant history persisted that exact prefixed placeholder
		// verbatim inside a toolCall block's arguments, intent, and rawBlock —
		// each also carrying ordinary raw prose that carries no secret material
		// and must survive untouched. A tool result in the same batch finally
		// reveals the raw regex-protected secret it collides with.
		const untouchedPrefix = "run with token ";
		const untouchedSuffix = " please";
		const staleField = `${untouchedPrefix}${mintedPlaceholder}${untouchedSuffix}`;
		const assistantMessage: Message = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call-1",
					name: "bash",
					arguments: { command: staleField, note: "no secret material here" },
					intent: staleField,
					rawBlock: staleField,
				},
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		};
		const toolResultMessage: Message = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text", text: "the real token is tok_abc123" }],
			isError: false,
			timestamp: 3,
		};

		const result = obfuscateMessages(obfuscator, [assistantMessage, toolResultMessage]);
		const strippedToolCall = assistantToolCall(result[0]);
		const redactedToolResultText = toolResultText(result[1]);

		// The stale friendly prefix is gone from every toolCall field, replaced by
		// the friendly-name-independent bare alias minted back in turn 1, while the
		// surrounding raw prose in each field is untouched byte-for-byte.
		const strippedArgsJson = JSON.stringify(strippedToolCall.arguments);
		expect(strippedArgsJson).not.toContain("TOKABC123_");
		expect(strippedArgsJson).toContain(bareAlias);
		expect(strippedArgsJson).toContain(untouchedPrefix);
		expect(strippedArgsJson).toContain(untouchedSuffix);

		if (strippedToolCall.intent === undefined) throw new Error("expected intent to survive stripping");
		expect(strippedToolCall.intent).not.toContain("TOKABC123_");
		expect(strippedToolCall.intent).toContain(bareAlias);
		expect(strippedToolCall.intent).toContain(untouchedPrefix);
		expect(strippedToolCall.intent).toContain(untouchedSuffix);

		if (strippedToolCall.rawBlock === undefined) throw new Error("expected rawBlock to survive stripping");
		expect(strippedToolCall.rawBlock).not.toContain("TOKABC123_");
		expect(strippedToolCall.rawBlock).toContain(bareAlias);
		expect(strippedToolCall.rawBlock).toContain(untouchedPrefix);
		expect(strippedToolCall.rawBlock).toContain(untouchedSuffix);

		// The newly revealed raw secret is redacted in the tool result.
		expect(redactedToolResultText).not.toContain("tok_abc123");

		// Both secrets still round-trip through deobfuscation of the serialized batch.
		const serialized = JSON.stringify(result);
		const restored = obfuscator.deobfuscate(serialized);
		expect(restored).toContain("OTHERSECRET");
		expect(restored).toContain("tok_abc123");

		// Fixed point: re-obfuscating the already-stripped batch changes nothing further.
		expect(JSON.stringify(obfuscateMessages(obfuscator, result))).toEqual(serialized);
	});

	it("strips a stale friendly prefix from an assistant thinking block once a later message reveals the colliding regex secret", () => {
		// Regression: `obfuscateAssistantContentForReplay` strips
		// `text` and `toolCall` blocks, but everywhere ELSE in the obfuscator a
		// `thinking` block is deliberately treated as opaque provider-replay data
		// that passes through byte-identical (see `deobfuscateAssistantContent`'s
		// doc comment). If the friendly-prefix strip pass fell through thinking
		// blocks the same way, a stale `#TOKABC123_<hash>#` placeholder minted
		// before `tok_abc123` was ever seen would keep leaking the friendly
		// name's normalized collision with that regex-protected secret every
		// time persisted thinking history was replayed to the provider.
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: "OTHERSECRET", friendlyName: "TOKABC123" },
			{ type: "regex", content: "tok_[a-z0-9]+" },
		]);

		type AssistantThinkingBlock = Extract<AssistantMessage["content"][number], { type: "thinking" }>;
		function assistantThinking(message: Message): AssistantThinkingBlock {
			if (message.role !== "assistant") throw new Error("expected an assistant message");
			const block = message.content.find((c): c is AssistantThinkingBlock => c.type === "thinking");
			if (block === undefined) throw new Error("expected an assistant thinking block");
			return block;
		}
		function toolResultText(message: Message): string {
			if (message.role !== "toolResult") throw new Error("expected a toolResult message");
			const block = message.content.find((c): c is TextContent => c.type === "text");
			if (block === undefined) throw new Error("expected a toolResult text block");
			return block.text;
		}
		function userText(message: Message): string {
			if (message.role !== "user") throw new Error("expected a user message");
			if (typeof message.content !== "string") throw new Error("expected string user content");
			return message.content;
		}

		// Turn 1: mint the friendly-prefixed placeholder for OTHERSECRET while
		// tok_abc123 is still unknown to this obfuscator instance.
		const minted = obfuscateMessages(obfuscator, [
			{ role: "user", content: "remember OTHERSECRET for later", timestamp: 1 },
		]);
		const mintedMatch = /\$\$TOKABC123_[A-Z0-9]+(?::[ULCM])?\$\$/.exec(userText(minted[0]));
		if (mintedMatch === null) throw new Error("expected turn 1 to mint a friendly-prefixed placeholder");
		const mintedPlaceholder = mintedMatch[0];
		const bareAlias = mintedPlaceholder.replace(/^\$\$TOKABC123_/, "$$");

		// Turn 2: assistant history persisted that exact prefixed placeholder
		// verbatim inside a thinking block, wrapped in ordinary raw reasoning
		// prose that carries no secret material and must survive untouched. A
		// tool result in the same batch finally reveals the raw regex-protected
		// secret it collides with.
		const untouchedPrefix = "Let me recall the value I stored earlier: ";
		const untouchedSuffix = " — that should still be correct.";
		const assistantMessage: Message = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: `${untouchedPrefix}${mintedPlaceholder}${untouchedSuffix}`,
					thinkingSignature: "signed-original-thinking",
				},
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		};
		const toolResultMessage: Message = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text", text: "the real token is tok_abc123" }],
			isError: false,
			timestamp: 3,
		};

		const result = obfuscateMessages(obfuscator, [assistantMessage, toolResultMessage]);
		const strippedThinkingBlock = assistantThinking(result[0]);
		const strippedThinking = strippedThinkingBlock.thinking;
		const redactedToolResultText = toolResultText(result[1]);

		// The stale friendly prefix is gone from the thinking block, replaced by
		// the friendly-name-independent bare alias minted back in turn 1, while
		// the surrounding raw reasoning prose is untouched byte-for-byte.
		expect(strippedThinking).not.toContain("TOKABC123_");
		expect(strippedThinking).toContain(bareAlias);
		expect(strippedThinking).toContain(untouchedPrefix);
		expect(strippedThinking).toContain(untouchedSuffix);
		expect(strippedThinkingBlock.thinkingSignature).toBeUndefined();

		// The newly revealed raw secret is redacted in the tool result.
		expect(redactedToolResultText).not.toContain("tok_abc123");

		// Both secrets still round-trip through deobfuscation of the serialized batch.
		const serialized = JSON.stringify(result);
		const restored = obfuscator.deobfuscate(serialized);
		expect(restored).toContain("OTHERSECRET");
		expect(restored).toContain("tok_abc123");

		// Fixed point: re-obfuscating the already-stripped batch changes nothing further.
		expect(JSON.stringify(obfuscateMessages(obfuscator, result))).toEqual(serialized);
	});
});

describe("deobfuscateAgentMessages (display restore)", () => {
	it("restores assistant text and tool calls while leaving raw user text and thinking untouched", () => {
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
		// Opaque thinking is never walked: placeholder-shaped bytes survive unchanged.
		expect(assistantJson).toContain(`reason ${placeholder}`);
		expect(assistantJson).not.toContain(`reason ${secret}`);
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
