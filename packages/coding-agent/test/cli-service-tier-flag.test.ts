import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("--service-tier", () => {
	it("parses supported OpenAI tiers without leaking the value into the prompt", () => {
		const parsed = parseArgs(["--service-tier=flex", "hello"]);

		expect(parsed.serviceTier).toBe("flex");
		expect(parsed.messages).toEqual(["hello"]);
	});

	it("rejects unsupported tiers", () => {
		expect(() => parseArgs(["--service-tier", "fast"])).toThrow(
			'Invalid --service-tier value: "fast". Expected one of: none, auto, default, flex, scale, priority.',
		);
	});

	it("maps none to an explicit OpenAI service-tier omission", async () => {
		const authStorage = await AuthStorage.create(":memory:");
		try {
			const options = await buildSessionOptions(
				parseArgs(["--service-tier", "none"]),
				[],
				SessionManager.inMemory(),
				new ModelRegistry(authStorage),
				Settings.isolated(),
			);

			expect(options.openAIServiceTier).toBeNull();
		} finally {
			authStorage.close();
		}
	});

	it("overrides only the OpenAI family in the live session", async () => {
		const authStorage = await AuthStorage.create(":memory:");
		const sessionManager = SessionManager.inMemory();
		try {
			const { session } = await createAgentSession({
				cwd: process.cwd(),
				agentDir: process.cwd(),
				modelRegistry: new ModelRegistry(authStorage),
				settings: Settings.isolated({ "tier.anthropic": "priority" }),
				sessionManager,
				openAIServiceTier: "flex",
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});
			try {
				expect(session.serviceTierByFamily).toEqual({ openai: "flex", anthropic: "priority" });
			} finally {
				await session.dispose();
			}
		} finally {
			authStorage.close();
		}
	});

	it("persists a resumed OpenAI override without changing other families", async () => {
		using tempDir = TempDir.createSync("@omp-service-tier-resume-");
		const authStorage = await AuthStorage.create(":memory:");
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		const seededManager = await SessionManager.open(sessionFile, tempDir.path());
		seededManager.appendServiceTierChange({ openai: "priority", anthropic: "priority", google: "flex" });
		await seededManager.flush();
		await seededManager.close();
		try {
			const firstManager = await SessionManager.open(sessionFile, tempDir.path());
			const { session: overridden } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				modelRegistry: new ModelRegistry(authStorage),
				settings: Settings.isolated(),
				sessionManager: firstManager,
				openAIServiceTier: "flex",
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});
			expect(overridden.serviceTierByFamily).toEqual({
				openai: "flex",
				anthropic: "priority",
				google: "flex",
			});
			await overridden.dispose();

			const resumedManager = await SessionManager.open(sessionFile, tempDir.path());
			const { session: resumed } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				modelRegistry: new ModelRegistry(authStorage),
				settings: Settings.isolated(),
				sessionManager: resumedManager,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});
			try {
				expect(resumed.serviceTierByFamily).toEqual({
					openai: "flex",
					anthropic: "priority",
					google: "flex",
				});
			} finally {
				await resumed.dispose();
			}
		} finally {
			authStorage.close();
		}
	});
	it("keeps an earlier pin when a different family is set afterwards", async () => {
		// Each whole-map receipt recomputed tracking purely from value equality,
		// so a write about family B re-marked an already-pinned family A as
		// config-following. Pin OpenAI to the value config happens to hold, then
		// set Google: the Google operation excludes only Google, and OpenAI's pin
		// was silently handed back to `tier.openai`.
		using tempDir = TempDir.createSync("@omp-service-tier-carry-");
		const authStorage = await AuthStorage.create(":memory:");
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		try {
			const manager = await SessionManager.open(sessionFile, tempDir.path());
			const { session } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				modelRegistry: new ModelRegistry(authStorage),
				settings: Settings.isolated({ "tier.openai": "priority" }),
				sessionManager: manager,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});
			// Pin OpenAI away and back, so the pin is real but its value equals
			// `tier.openai` — the only state equality inference cannot recover.
			session.setServiceTierFamily("openai", "flex");
			session.setServiceTierFamily("openai", "priority");
			// Now an unrelated family's operation writes a fresh whole-map receipt.
			session.setServiceTierFamily("google", "priority");
			await session.dispose();
			await manager.flush();
			await manager.close();

			const resumedManager = await SessionManager.open(sessionFile, tempDir.path());
			const { session: resumed } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				modelRegistry: new ModelRegistry(authStorage),
				settings: Settings.isolated({ "tier.openai": "none" }),
				sessionManager: resumedManager,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});
			try {
				// Pre-fix the Google write erased OpenAI's provenance, so the edit
				// to `none` took effect.
				expect(resumed.serviceTierByFamily.openai).toBe("priority");
				// The family that was actually set is unaffected either way.
				expect(resumed.serviceTierByFamily.google).toBe("priority");
			} finally {
				await resumed.dispose();
				await resumedManager.close();
			}
		} finally {
			authStorage.close();
		}
	});

	it("keeps an explicit selection pinned when it equals the configured tier", async () => {
		// Provenance was inferred by comparing values, so an explicit selection
		// that HAPPENS to equal the configured tier was recorded as
		// settings-tracking — and the next config edit silently overwrote a
		// choice that is meant to outrank config.
		using tempDir = TempDir.createSync("@omp-service-tier-equal-");
		const authStorage = await AuthStorage.create(":memory:");
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		try {
			const manager = await SessionManager.open(sessionFile, tempDir.path());
			const { session } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				modelRegistry: new ModelRegistry(authStorage),
				settings: Settings.isolated({ "tier.openai": "priority" }),
				sessionManager: manager,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});
			// Pin away from config, then explicitly select back to the value config
			// happens to hold. Still a pin — the second call is what equality
			// inference could not see.
			session.setServiceTierFamily("openai", "flex");
			session.setServiceTierFamily("openai", "priority");
			await session.dispose();
			await manager.flush();
			await manager.close();

			const resumedManager = await SessionManager.open(sessionFile, tempDir.path());
			const { session: resumed } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				modelRegistry: new ModelRegistry(authStorage),
				settings: Settings.isolated({ "tier.openai": "none" }),
				sessionManager: resumedManager,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});
			try {
				// Pre-fix the config edit to `none` wiped the explicit selection.
				expect(resumed.serviceTierByFamily.openai).toBe("priority");
			} finally {
				await resumed.dispose();
			}
		} finally {
			authStorage.close();
		}
	});

	it("keeps other families tracking config when a resume carries --service-tier", async () => {
		// The resume branch appended the whole tier map with no provenance. Being
		// the LATEST receipt, it decided what the next resume restored — so the
		// intentional OpenAI pin froze Anthropic alongside it and no later config
		// edit could ever move that family again.
		using tempDir = TempDir.createSync("@omp-service-tier-resume-prov-");
		const authStorage = await AuthStorage.create(":memory:");
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		const seededManager = await SessionManager.open(sessionFile, tempDir.path());
		seededManager.appendServiceTierChange({ anthropic: "priority" }, ["anthropic", "google"]);
		await seededManager.flush();
		await seededManager.close();
		try {
			// Resume WITH the flag: this is the receipt that used to clear provenance.
			const pinnedManager = await SessionManager.open(sessionFile, tempDir.path());
			const { session: pinned } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				modelRegistry: new ModelRegistry(authStorage),
				settings: Settings.isolated({ "tier.anthropic": "priority" }),
				sessionManager: pinnedManager,
				openAIServiceTier: "flex",
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});
			expect(pinned.serviceTierByFamily).toEqual({ openai: "flex", anthropic: "priority" });
			await pinned.dispose();

			// Offline edit of the OTHER family, then a plain resume.
			const resumedManager = await SessionManager.open(sessionFile, tempDir.path());
			const { session: resumed } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				modelRegistry: new ModelRegistry(authStorage),
				settings: Settings.isolated({ "tier.anthropic": "flex" }),
				sessionManager: resumedManager,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});
			try {
				// Pre-fix Anthropic stayed pinned at `priority`, permanently.
				expect(resumed.serviceTierByFamily.anthropic).toBe("flex");
			} finally {
				await resumed.dispose();
			}
		} finally {
			authStorage.close();
		}
	});

	it("re-derives a startup-derived tier after the config is edited while stopped", async () => {
		using tempDir = TempDir.createSync("@omp-service-tier-startup-");
		const authStorage = await AuthStorage.create(":memory:");
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		try {
			// A plain start with a configured tier: no flag, so every family here
			// FOLLOWS `tier.*`. Startup wrote this receipt without provenance, and
			// `hasServiceTierEntry` then treats it as authoritative forever.
			const firstManager = await SessionManager.open(sessionFile, tempDir.path());
			const { session: started } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				modelRegistry: new ModelRegistry(authStorage),
				settings: Settings.isolated({ "tier.openai": "priority" }),
				sessionManager: firstManager,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});
			expect(started.serviceTierByFamily).toEqual({ openai: "priority" });
			await started.dispose();

			// The edit lands while the session is stopped, so no refresh can see it.
			const resumedManager = await SessionManager.open(sessionFile, tempDir.path());
			const { session: resumed } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				modelRegistry: new ModelRegistry(authStorage),
				settings: Settings.isolated({ "tier.openai": "none" }),
				sessionManager: resumedManager,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});
			try {
				// Pre-fix the provenance-less startup receipt replayed `priority`.
				expect(resumed.serviceTierByFamily).toEqual({});
			} finally {
				await resumed.dispose();
			}
		} finally {
			authStorage.close();
		}
	});

	it("keeps a --service-tier pin while other families still track the config", async () => {
		using tempDir = TempDir.createSync("@omp-service-tier-startup-pin-");
		const authStorage = await AuthStorage.create(":memory:");
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		try {
			// The flag pins openai ALONE, so anthropic must keep its provenance.
			const firstManager = await SessionManager.open(sessionFile, tempDir.path());
			const { session: started } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				modelRegistry: new ModelRegistry(authStorage),
				settings: Settings.isolated({ "tier.openai": "priority", "tier.anthropic": "priority" }),
				sessionManager: firstManager,
				openAIServiceTier: "flex",
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});
			expect(started.serviceTierByFamily).toEqual({ openai: "flex", anthropic: "priority" });
			await started.dispose();

			const resumedManager = await SessionManager.open(sessionFile, tempDir.path());
			const { session: resumed } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				modelRegistry: new ModelRegistry(authStorage),
				settings: Settings.isolated({ "tier.openai": "priority", "tier.anthropic": "none" }),
				sessionManager: resumedManager,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});
			try {
				// The pin survives; the config-following family follows the edit.
				expect(resumed.serviceTierByFamily).toEqual({ openai: "flex" });
			} finally {
				await resumed.dispose();
			}
		} finally {
			authStorage.close();
		}
	});
	it("tracks a family that was unset at startup so a later config add takes effect", async () => {
		using tempDir = TempDir.createSync("@omp-service-tier-unset-");
		const authStorage = await AuthStorage.create(":memory:");
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		try {
			// Google is `none` at startup, so it has no key in the receipt's map —
			// which is exactly why keying provenance off that map omitted it.
			const firstManager = await SessionManager.open(sessionFile, tempDir.path());
			const { session: started } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				modelRegistry: new ModelRegistry(authStorage),
				settings: Settings.isolated({ "tier.openai": "priority" }),
				sessionManager: firstManager,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});
			expect(started.serviceTierByFamily).toEqual({ openai: "priority" });
			await started.dispose();

			// Added while stopped: no refresh can detect it afterwards.
			const resumedManager = await SessionManager.open(sessionFile, tempDir.path());
			const { session: resumed } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				modelRegistry: new ModelRegistry(authStorage),
				settings: Settings.isolated({ "tier.openai": "priority", "tier.google": "priority" }),
				sessionManager: resumedManager,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});
			try {
				// Pre-fix Google had no provenance, so the restored map omitted it.
				expect(resumed.serviceTierByFamily).toEqual({ openai: "priority", google: "priority" });
			} finally {
				await resumed.dispose();
			}
		} finally {
			authStorage.close();
		}
	});
});
