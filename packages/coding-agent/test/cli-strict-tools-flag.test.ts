import { describe, expect, it } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

async function activeToolsFor(argv: string[]): Promise<string[]> {
	using tempDir = TempDir.createSync("@omp-strict-tools-");
	const authStorage = await AuthStorage.create(":memory:");
	// Context management widens a `read,grep` list with context_notes/new_context.
	const settings = Settings.isolated({ "compaction.experimentalContextManagement": true });
	try {
		const modelRegistry = new ModelRegistry(authStorage);
		const options = await buildSessionOptions(
			parseArgs(argv),
			[],
			SessionManager.inMemory(),
			modelRegistry,
			settings,
		);
		const { session } = await createAgentSession({
			...options,
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			modelRegistry,
			settings,
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
		});
		try {
			return session.getActiveToolNames().sort();
		} finally {
			await session.dispose();
		}
	} finally {
		authStorage.close();
	}
}

describe("--strict-tools", () => {
	it("keeps settings from adding tools to the --tools list", async () => {
		expect(await activeToolsFor(["--tools", "read,grep"])).toContain("context_notes");
		expect(await activeToolsFor(["--tools", "read,grep", "--strict-tools"])).toEqual(["grep", "read"]);
	});

	it("leaves a --no-tools session with no tools", async () => {
		expect(await activeToolsFor(["--no-tools", "--strict-tools"])).toEqual([]);
	});
});
