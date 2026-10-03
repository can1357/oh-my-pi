import { describe, expect, it } from "bun:test";
import type { Context, Message } from "@oh-my-pi/pi-ai";
import { obfuscateMessages, obfuscateProviderContext } from "@oh-my-pi/pi-coding-agent/secrets/message-transform";
import { type SecretEntry, SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";
import { generateDeterministicReplacement } from "@oh-my-pi/pi-coding-agent/secrets/replacement";
import {
	SecretCollisionSnapshots,
	SecretTextCache,
	SecretTextResultCache,
} from "@oh-my-pi/pi-coding-agent/secrets/scan-cache";

const KEY = "incremental-test-placeholder-key";
const SOURCE = "tok_[a-z0-9]+";

/** Count expensive regex execution without exposing a runtime instrumentation API. */
function withScanCounts(run: (counts: Map<string, number>) => void): void {
	const counts = new Map<string, number>();
	const originalExec = RegExp.prototype.exec;
	RegExp.prototype.exec = function (text: string) {
		if (this.source === SOURCE) counts.set(text, (counts.get(text) ?? 0) + 1);
		return originalExec.call(this, text);
	};
	try {
		run(counts);
	} finally {
		RegExp.prototype.exec = originalExec;
	}
}

describe("incremental secret scans", () => {
	it("reuses content across recreated history, both outbound boundaries and harmless appends", () => {
		const entries: SecretEntry[] = [
			{ type: "plain", content: "CONFIGUREDSECRET" },
			{ type: "regex", content: SOURCE },
		];
		const obfuscator = new SecretObfuscator(entries, KEY);
		const history: Message[] = Array.from({ length: 64 }, (_, index) => ({
			role: "user",
			content: `retained-${index} ${"ordinary context ".repeat(32)} CONFIGUREDSECRET tok_abc123`,
			timestamp: index,
		}));
		const transform = (messages: Message[]): Context =>
			obfuscateProviderContext(obfuscator, { messages: obfuscateMessages(obfuscator, messages) });
		const expected = transform(history);
		// Discovery mutates recognition state. Warm only explicitly scanned inputs,
		// never assume the first output is a fixed point without scanning it.
		transform(history);
		transform(history);
		withScanCounts(counts => {
			const recreated = history.map(message => ({ ...message }));
			expect(transform(recreated)).toEqual(expected);
			expect(counts.size).toBe(0);
			const appended: Message = { role: "user", content: "new harmless context", timestamp: 100 };
			const result = transform([...recreated, appended]);
			expect(result.messages.slice(0, history.length)).toEqual(expected.messages);
			expect(counts.get("new harmless context")).toBeGreaterThan(0);
			expect([...counts.keys()].some(text => text.includes("retained-"))).toBe(false);
		});
		for (let index = 0; index < history.length; index++) {
			const input = history[index]!;
			const output = expected.messages[index]!;
			if (
				input.role !== "user" ||
				output.role !== "user" ||
				typeof input.content !== "string" ||
				typeof output.content !== "string"
			) {
				throw new Error("bad fixture");
			}
			expect(output.content).not.toContain("CONFIGUREDSECRET");
			expect(output.content).not.toContain("tok_abc123");
			expect(obfuscator.deobfuscate(output.content)).toBe(input.content);
		}
	});

	it("reuses literal probes too, not only regex executions", () => {
		const obfuscator = new SecretObfuscator(
			[{ type: "regex", content: "needle_[0-9]+", literalPrefixes: ["needle_"] }],
			KEY,
		);
		const originalIncludes = String.prototype.includes;
		let probes = 0;
		String.prototype.includes = function (search: string, position?: number) {
			if (search === "needle_") probes++;
			return originalIncludes.call(this, search, position);
		};
		try {
			const text = "unchanged retained history";
			expect(obfuscator.obfuscate(text)).toBe(text);
			expect(probes).toBeGreaterThan(0);
			probes = 0;
			expect(obfuscator.obfuscate(`${text}`)).toBe(text);
			expect(obfuscator.collectRegexSecretValuesForObfuscation(text).size).toBe(0);
			expect(probes).toBe(0);
			expect(obfuscator.obfuscate("changed history needle_123456")).not.toContain("needle_123456");
			expect(probes).toBeGreaterThan(0);
		} finally {
			String.prototype.includes = originalIncludes;
		}
	});

	it("scans newly introduced provider text after transcript redaction", () => {
		const obfuscator = new SecretObfuscator([{ type: "regex", content: SOURCE }], KEY);
		const messages = obfuscateMessages(obfuscator, [{ role: "user", content: "initial context", timestamp: 1 }]);
		const result = obfuscateProviderContext(obfuscator, {
			messages: [...messages, { role: "user", content: "provider adds tok_newsecret", timestamp: 2 }],
		});
		expect(JSON.stringify(result)).not.toContain("tok_newsecret");
	});

	it("reuses native replay fields without bypassing whole-batch collisions or opaque fields", () => {
		const obfuscator = new SecretObfuscator(
			[
				{ type: "plain", content: "OTHERSECRET", friendlyName: "TOKABC123" },
				{ type: "regex", content: SOURCE },
			],
			KEY,
		);
		const messages: Message[] = [
			{
				role: "user",
				content: "native-retained OTHERSECRET",
				timestamp: 1,
				providerPayload: {
					type: "openaiResponsesHistory",
					items: [
						{
							type: "message",
							role: "user",
							content: [{ type: "input_text", text: "native-retained tok_abc123" }],
						},
						{ type: "reasoning", encrypted_content: "tok_opaque" },
					],
				},
			},
		];
		const transform = () =>
			obfuscateProviderContext(obfuscator, {
				messages: obfuscateMessages(
					obfuscator,
					messages.map(message => ({ ...message })),
				),
			});
		const expected = transform();
		transform();
		transform();
		const serialized = JSON.stringify(expected.messages);
		expect(serialized).not.toContain("OTHERSECRET");
		expect(serialized).not.toContain("tok_abc123");
		expect(serialized).not.toContain("TOKABC123_");
		expect(serialized).toContain("tok_opaque");
		withScanCounts(counts => {
			expect(transform()).toEqual(expected);
			expect(counts.size).toBe(0);
		});
	});

	it("returns defensive collection results and scans outputs before caching them", () => {
		const obfuscator = new SecretObfuscator(
			[
				{ type: "regex", content: SOURCE },
				{ type: "regex", content: "first_secret", mode: "replace", replacement: "second_secret" },
				{ type: "regex", content: "second_secret", mode: "replace", replacement: "third_secret" },
			],
			KEY,
		);
		const values = obfuscator.collectRegexSecretValuesForObfuscation("tok_abc123");
		values.clear();
		values.add("injected-value");
		expect([...obfuscator.collectRegexSecretValuesForObfuscation("tok_abc123")]).toEqual(["tok_abc123"]);
		// Earlier rules can match a later replacement only on the next pass.
		const cascading = new SecretObfuscator(
			[
				{ type: "regex", content: "second_secret", mode: "replace", replacement: "third_secret" },
				{ type: "regex", content: "first_secret", mode: "replace", replacement: "second_secret" },
			],
			KEY,
		);
		expect(cascading.obfuscate("first_secret")).toBe("second_secret");
		expect(cascading.obfuscate("second_secret")).toBe("third_secret");
	});

	it("invalidates same-size shared set mutations and later discovered friendly collisions", () => {
		const obfuscator = new SecretObfuscator(
			[
				{ type: "plain", content: "OTHERSECRET", friendlyName: "TOKABC123" },
				{ type: "regex", content: SOURCE },
			],
			KEY,
		);
		const old = obfuscator.obfuscate("OTHERSECRET");
		const shared = new Set(["tok_unrelated"]);
		expect(obfuscator.obfuscate(old, shared)).toBe(old);
		expect(obfuscator.stripUnsafeFriendlyPlaceholderPrefixes(old, shared)).toBe(old);
		shared.delete("tok_unrelated");
		shared.add("tok_abc123");
		expect(obfuscator.obfuscate(old, shared)).not.toContain("TOKABC123_");
		expect(obfuscator.stripUnsafeFriendlyPlaceholderPrefixes(old, shared)).not.toContain("TOKABC123_");
		// A global discovery invalidates old results even with no shared values.
		expect(obfuscator.obfuscate(old)).toBe(old);
		obfuscator.obfuscate("tok_abc123");
		const safe = obfuscator.obfuscate(old);
		expect(safe).not.toContain("TOKABC123_");
		expect(obfuscator.deobfuscate(safe)).toBe("OTHERSECRET");
	});

	it("invalidates lazy key self-redaction and recollects its new batch collision values", () => {
		const keyReplacement = generateDeterministicReplacement(KEY);
		const label = keyReplacement.toUpperCase();
		let resolves = 0;
		const obfuscator = new SecretObfuscator(
			[
				{ type: "regex", content: "firstsecret", friendlyName: label },
				{ type: "regex", content: `(?<=key=)${keyReplacement}` },
			],
			() => {
				resolves++;
				return KEY;
			},
		);
		// This identity result is valid only before key registration.
		expect(obfuscator.obfuscate(KEY)).toBe(KEY);
		const messages: Message[] = [
			{ role: "user", content: "firstsecret", timestamp: 1 },
			{ role: "user", content: `key=${KEY}`, timestamp: 2 },
		];
		const result = obfuscateMessages(obfuscator, messages);
		expect(resolves).toBe(1);
		expect(JSON.stringify(result)).not.toContain(KEY);
		expect(JSON.stringify(result)).not.toContain(`${label}_`);
		expect(obfuscator.obfuscate(KEY)).not.toBe(KEY);
	});

	it("uses actual lookbehind matches for lazy resolution and does not cache disabled collection", () => {
		for (const batch of [false, true]) {
			let resolves = 0;
			const obfuscator = new SecretObfuscator([{ type: "regex", content: `(?<=api=)${SOURCE}` }], () => {
				resolves++;
				return KEY;
			});
			const text = `key=${KEY} api=tok_abc123`;
			obfuscator.setObfuscating(false);
			expect(obfuscator.collectRegexSecretValuesForObfuscation(text).has("tok_abc123")).toBe(true);
			expect(resolves).toBe(0);
			obfuscator.setObfuscating(true);
			const output = batch
				? JSON.stringify(
						obfuscateMessages(obfuscator, [
							{ role: "user", content: `key=${KEY}`, timestamp: 1 },
							{ role: "user", content: "api=tok_abc123", timestamp: 2 },
						]),
					)
				: obfuscator.obfuscate(text);
			expect(resolves).toBe(1);
			expect(output).not.toContain(KEY);
			expect(output).not.toContain("tok_abc123");
		}
	});

	it("refreshes replacement ordering when a lazy key overwrites a configured mapping at the same size", () => {
		const obfuscator = new SecretObfuscator(
			[
				{ type: "plain", content: KEY, mode: "replace", replacement: "custom-marker" },
				{ type: "regex", content: SOURCE },
			],
			() => KEY,
		);
		expect(obfuscator.obfuscate(KEY)).toBe("custom-marker");
		obfuscator.obfuscate("tok_trigger");
		expect(obfuscator.obfuscate(KEY)).toBe(generateDeterministicReplacement(KEY));
	});

	it("invalidates alias expansion and replacement chunk registration", () => {
		const entries: SecretEntry[] = [
			{ type: "regex", content: "foobarxy" },
			{ type: "regex", content: "foobarxyZ[0-9]{8}" },
			{ type: "regex", content: "(?<=api=)[A-Za-z0-9]{8}", mode: "replace" },
		];
		const template = new SecretObfuscator(entries, KEY);
		const placeholder = template.obfuscate("foobarxy");
		const obfuscator = new SecretObfuscator(entries, KEY);
		const unknown = `${placeholder}Z12345678`;
		obfuscator.obfuscate(unknown);
		obfuscator.obfuscate("foobarxy");
		// A fresh scan must use the alias registered after the cached input.
		expect(obfuscator.obfuscate(unknown)).toBe(template.obfuscate(unknown));
		expect(obfuscator.obfuscate(unknown)).not.toBe(unknown);
		const raw = "api=abcdefgh";
		const output = obfuscator.obfuscate(raw);
		expect(output).not.toContain("abcdefgh");
		expect(obfuscator.obfuscate(output)).toBe(output);
		expect(obfuscator.obfuscate(raw)).toBe(output);
	});

	it("keeps mode toggles outside caches and clears active collisions after exceptions", () => {
		const obfuscator = new SecretObfuscator(
			[
				{ type: "plain", content: "OTHERSECRET", friendlyName: "TOKABC123" },
				{ type: "regex", content: SOURCE },
			],
			KEY,
		);
		const old = obfuscator.obfuscate("OTHERSECRET");
		obfuscator.setObfuscating(false);
		expect(obfuscator.obfuscate("OTHERSECRET")).toBe("OTHERSECRET");
		obfuscator.setObfuscating(true);
		expect(obfuscator.obfuscate("OTHERSECRET")).toBe(old);
		const originalExec = RegExp.prototype.exec;
		let calls = 0;
		RegExp.prototype.exec = function (text: string) {
			if (this.source === SOURCE && text.includes("throw_marker") && ++calls === 5) throw new Error("scan failure");
			return originalExec.call(this, text);
		};
		try {
			expect(() => obfuscator.obfuscate("tok_abc123 throw_marker")).toThrow("scan failure");
		} finally {
			RegExp.prototype.exec = originalExec;
		}
		expect(obfuscator.obfuscate(`new input ${old}`)).toBe(`new input ${old}`);
	});
});

describe("secret cache memory bounds", () => {
	it("counts keys and retained values, evicts least-recently-used entries and bypasses oversized entries", () => {
		const cache = new SecretTextCache<string>(12, 2);
		cache.set("aa", "1111", 4);
		cache.set("bb", "2222", 4);
		expect(cache.get("aa")).toBe("1111");
		cache.set("cc", "3333", 4);
		expect(cache.get("bb")).toBeUndefined();
		expect(cache.get("aa")).toBe("1111");
		cache.set("oversized-key", "x", 1);
		expect(cache.get("oversized-key")).toBeUndefined();
		cache.set("aa", "oversized-retained-value", 24);
		expect(cache.get("aa")).toBeUndefined();
		cache.clear();
		expect(cache.get("cc")).toBeUndefined();
		const entryLimited = new SecretTextCache<string>(100, 1);
		entryLimited.set("a", "", 0);
		entryLimited.set("b", "", 0);
		expect(entryLimited.get("a")).toBeUndefined();
	});

	it("bounds collision variants and includes every output in the memory budget", () => {
		const cache = new SecretTextResultCache(100);
		for (let id = 0; id < 5; id++) cache.set("key", id, `result-${id}`);
		expect(cache.get("key", 0)).toBeUndefined();
		expect(cache.get("key", 1)).toBe("result-1");
		const weighted = new SecretTextResultCache(10);
		weighted.set("key", 0, "12345");
		weighted.set("key", 1, "12345");
		expect(weighted.get("key", 0)).toBeUndefined();
		expect(weighted.get("key", 1)).toBeUndefined();
	});

	it("interns membership rather than identity and bounds snapshots without mutable exposure", () => {
		const snapshots = new SecretCollisionSnapshots(12, 2);
		const first = snapshots.prepare(new Set(["abc"]));
		expect(snapshots.prepare(new Set(["abc"]))).toBe(first);
		expect((first as unknown as Set<string>).add).toBeUndefined();
		expect(Object.isFrozen(first)).toBe(true);
		const mutable = new Set(["def"]);
		const previous = snapshots.prepare(mutable);
		mutable.delete("def");
		mutable.add("ghi");
		expect(snapshots.prepare(mutable).id).not.toBe(previous.id);
		expect(snapshots.prepare(new Set(["abc"])).id).not.toBe(first.id);
		const oversized = new Set(["x".repeat(13)]);
		expect(snapshots.prepare(oversized).id).not.toBe(snapshots.prepare(oversized).id);
	});
});
