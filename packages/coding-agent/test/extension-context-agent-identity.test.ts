import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionAgentIdentity } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { type CreateAgentSessionOptions, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

// Extensions need to know which agent they run in: the same factory is rebound to every
// subagent, and hooks such as a Claude-style SubagentStart must act only there.
describe("ExtensionContext.agent", () => {
	let tempDir: string;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-ext-agent-identity-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		for (const authStorage of authStorages.splice(0)) authStorage.close();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	async function agentSeenByExtensions(options: Partial<CreateAgentSessionOptions>): Promise<ExtensionAgentIdentity> {
		const authStorage = createInMemoryAuthStorage();
		authStorages.push(authStorage);
		let seen: ExtensionAgentIdentity | undefined;
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, "models.yml")),
			settings: Settings.isolated(),
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			extensions: [
				pi => {
					pi.on("before_agent_start", (_event, ctx) => {
						seen = ctx.agent;
					});
				},
			],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			...options,
		});
		try {
			await session.extensionRunner!.emitBeforeAgentStart("hi", undefined, []);
			return seen!;
		} finally {
			await session.dispose();
		}
	}

	test("a top-level session reports itself as the main agent", async () => {
		expect(await agentSeenByExtensions({})).toEqual({ kind: "main", id: "Main", name: "main", depth: 0 });
	});

	test("a subagent session reports its kind, id, definition name, depth and parent", async () => {
		expect(
			await agentSeenByExtensions({
				taskDepth: 2,
				parentTaskPrefix: "0-Explore",
				agentId: "0-Explore",
				agentDisplayName: "Explore",
				agentName: "Explore",
				parentAgentId: "Main",
			}),
		).toEqual({ kind: "sub", id: "0-Explore", name: "explore", depth: 2, parentId: "Main" });
	});

	test("a spawned session outside the task tool is a subagent at depth 0", async () => {
		// `/tan` clones pass a parent prefix but no task depth or agent definition.
		expect(
			await agentSeenByExtensions({
				parentTaskPrefix: "Main-tan-1",
				agentId: "Main-tan-1",
				agentDisplayName: "tan",
				parentAgentId: "Main",
			}),
		).toEqual({ kind: "sub", id: "Main-tan-1", name: "sub", depth: 0, parentId: "Main" });
	});
});
