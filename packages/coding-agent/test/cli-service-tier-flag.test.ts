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
});
