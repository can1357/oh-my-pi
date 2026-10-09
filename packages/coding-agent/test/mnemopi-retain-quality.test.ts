import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { hasRetainableMessages } from "@oh-my-pi/pi-coding-agent/hindsight/content";
import { loadMnemopiConfig } from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import { loadMnemopi, loadMnemopiCore, MnemopiSessionState } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { MnemopiLlmCompletion } from "@oh-my-pi/pi-mnemopi/core/runtime-options";

await Promise.all([loadMnemopi(), loadMnemopiCore()]);

describe("Mnemopi transcript retention quality", () => {
	it("does not write a greeting-only one-turn session on disposal below the retain threshold", async () => {
		const dir = TempDir.createSync("@mnemopi-retain-quality-");
		const dbPath = dir.join("memory.db");
		const settings = Settings.isolated({
			"memory.backend": "mnemopi",
			"mnemopi.scoping": "global",
			"mnemopi.dbPath": dbPath,
			"mnemopi.noEmbeddings": true,
			"mnemopi.llmMode": "none",
			"mnemopi.retainEveryNTurns": 5,
		});
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "hello",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "Selam Echo", timestamp: Date.now() },
			},
		];
		const state = new MnemopiSessionState({
			sessionId: "greeting-only",
			config: loadMnemopiConfig(settings, dir.path()),
			session: {
				sessionId: "greeting-only",
				settings,
				sessionManager: { getEntries: () => entries, getCwd: () => dir.path() },
				emitNotice: () => {},
			} as never,
		});
		let disposed = false;
		try {
			await state.maybeRetainOnAgentEnd([]);
			await state.dispose();
			disposed = true;
			using db = new Database(dbPath, { readonly: true });
			for (const table of ["working_memory", "episodic_memory", "facts", "memoria_facts", "fts_working", "gists", "triples", "memory_embeddings"]) {
				expect(db.query(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
			}
		} finally {
			if (!disposed) await state.dispose({ consolidate: false });
			await dir.remove();
		}
	});

	it("retains a meaningful short turn on disposal even below the retain threshold", async () => {
		const dir = TempDir.createSync("@mnemopi-retain-meaningful-");
		const dbPath = dir.join("memory.db");
		const settings = Settings.isolated({
			"memory.backend": "mnemopi",
			"mnemopi.scoping": "global",
			"mnemopi.dbPath": dbPath,
			"mnemopi.noEmbeddings": true,
			"mnemopi.llmMode": "none",
			"mnemopi.retainEveryNTurns": 5,
		});
		const state = new MnemopiSessionState({
			sessionId: "meaningful",
			config: loadMnemopiConfig(settings, dir.path()),
			session: {
				sessionId: "meaningful",
				settings,
				sessionManager: {
					getEntries: () => [{
						type: "message",
						id: "port",
						parentId: null,
						timestamp: new Date().toISOString(),
						message: { role: "user", content: "Port 8080", timestamp: Date.now() },
					}],
					getCwd: () => dir.path(),
				},
				emitNotice: () => {},
			} as never,
		});
		let disposed = false;
		try {
			await state.maybeRetainOnAgentEnd([]);
			expect(state.memory.conn.query("SELECT COUNT(*) AS count FROM working_memory").get()).toEqual({ count: 0 });
			await state.dispose();
			disposed = true;
			using db = new Database(dbPath, { readonly: true });
			expect(db.query("SELECT content, memory_type FROM working_memory").get()).toEqual({
				content: "[role: user]\nPort 8080\n[user:end]",
				memory_type: "episode",
			});
		} finally {
			if (!disposed) await state.dispose({ consolidate: false });
			await dir.remove();
		}
	});

	it("extracts assistant experiences separately without attributing assistant prose to the user", async () => {
		const dir = TempDir.createSync("@mnemopi-experience-source-");
		const settings = Settings.isolated({
			"memory.backend": "mnemopi",
			"mnemopi.scoping": "global",
			"mnemopi.dbPath": dir.join("memory.db"),
			"mnemopi.noEmbeddings": true,
			"mnemopi.llmMode": "none",
		});
		const calls: Array<{ sourceKind: string | undefined; input: string }> = [];
		const complete: MnemopiLlmCompletion = (_prompt, options) => {
			calls.push({ sourceKind: options?.task?.sourceKind, input: options?.task?.input ?? "" });
			if (options?.task?.sourceKind === "experience") {
				return JSON.stringify({
					facts: [
						{ text: "The agent fixed the parser and ran its regression test", kind: "experience" },
						{ text: "The user uses spaces", kind: "world" },
					],
					instructions: [{ text: "Always use spaces", kind: "experience" }],
					preferences: [{ text: "The user prefers spaces", kind: "experience" }],
					kg: [{ subject: "user", predicate: "uses", object: "spaces" }],
				});
			}
			return JSON.stringify({ facts: [{ text: "The user prefers tabs", kind: "world" }] });
		};
		const config = loadMnemopiConfig(settings, dir.path());
		const state = new MnemopiSessionState({
			sessionId: "experience-sources",
			config: { ...config, providerOptions: { ...config.providerOptions, llm: { enabled: true, complete } } },
			session: {
				sessionId: "experience-sources",
				settings,
				sessionManager: { getEntries: () => [], getCwd: () => dir.path() },
				emitNotice: () => {},
			} as never,
		});
		try {
			await state.retainMessages([
				{ role: "user", content: "I prefer tabs." },
				{ role: "assistant", content: "I fixed the parser for alex@example.com and ran its regression test. I always use spaces." },
			], "first-window");
			await state.memory.flushExtractions();
			expect(calls.map(call => call.sourceKind)).toEqual([undefined, "experience"]);
			expect(calls[0]?.input).not.toContain("fixed the parser");
			expect(calls[1]?.input).toContain("[role: assistant]");
			expect(calls[1]?.input).not.toContain("I prefer tabs");
			expect(calls[1]?.input).not.toContain("alex@example.com");
			expect(calls[1]?.input).toContain("[REDACTED:email]");
			expect(state.memory.beam.factRecall("tabs", 5)[0]?.memory_kind).toBe("world");
			expect(state.memory.beam.factRecall("parser", 5)[0]?.memory_kind).toBe("experience");
			expect(state.memory.beam.factRecall("spaces", 5)).toEqual([]);
			expect(state.memory.conn.query("SELECT COUNT(*) AS count FROM memoria_instructions").get()).toEqual({ count: 0 });
			expect(state.memory.conn.query("SELECT COUNT(*) AS count FROM memoria_preferences").get()).toEqual({ count: 1 });

			await state.retainMessages([
				{ role: "user", content: "Teşekkürler!" },
				{ role: "assistant", content: "I fixed the parser and ran its regression test." },
			], "thanks-window");
			await state.memory.flushExtractions();
			expect(calls.map(call => call.sourceKind)).toEqual([undefined, "experience", "experience"]);
		} finally {
			await state.dispose({ consolidate: false });
			await dir.remove();
		}
	});

	it("rejects multilingual chatter and recalled context without discarding real content", () => {
		expect(hasRetainableMessages([
			{ role: "user", content: "Selam Echo!" },
			{ role: "user", content: "Teşekkürler \u{1F44B}\u{1F3FB}" },
			{ role: "assistant", content: "Merhaba! Nasıl yardımcı olabilirim?" },
			{ role: "user", content: "Tamam, çok teşekkür ederim." },
		])).toBe(false);
		expect(hasRetainableMessages([
			{ role: "user", content: "Hello Echo!" },
			{ role: "assistant", content: "Hello! How can I help you today?" },
			{ role: "user", content: "Okay, thank you very much!" },
		])).toBe(false);
		expect(hasRetainableMessages([{ role: "user", content: "<memories>Use tabs</memories>\nTeşekkürler" }])).toBe(false);
		expect(hasRetainableMessages([{ role: "user", content: "Tamam, port 8080 olsun." }])).toBe(true);
		expect(hasRetainableMessages([{ role: "user", content: "I prefer tabs." }])).toBe(true);
		expect(hasRetainableMessages([{ role: "assistant", content: "The agent fixed the parser." }])).toBe(true);
	});
});
