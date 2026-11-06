import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { collabRelayHeaders } from "@oh-my-pi/pi-coding-agent/collab/relay-headers";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const RELAY_URL = "ws://relay.example.test/r/headersRoom01?role=guest";

describe("collabRelayHeaders", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-relay-headers-");
		authStorage = createInMemoryAuthStorage();
	});

	afterEach(() => {
		AgentStorage.close();
		authStorage.close();
		tempDir.removeSync();
	});

	async function createSession(deferredExtensionPaths: string[]) {
		const eventBus = new EventBus();
		return createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			settings: Settings.isolated(),
			eventBus,
			preloadedExtensions: await loadExtensions([], tempDir.path(), eventBus),
			deferredExtensionPaths,
			enableLsp: false,
			enableMCP: false,
			skipPythonPreflight: true,
			skills: [],
			rules: [],
			preloadedCustomToolPaths: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			toolNames: ["read"],
		});
	}

	// `omp join <link>` connects before startup-deferred extensions bind.
	it("waits for a startup-deferred extension and returns its headers", async () => {
		const deferredPath = path.join(tempDir.path(), "relay-auth.ts");
		fs.writeFileSync(
			deferredPath,
			`export default function(pi) {
				pi.on("collab_relay_connect", event => ({ headers: { Authorization: "Bearer deferred", "X-Role": event.role } }));
			}`,
		);
		const { session } = await createSession([deferredPath]);
		try {
			expect(session.extensionRunner?.hasHandlers("collab_relay_connect") ?? false).toBe(false);

			expect(await collabRelayHeaders(session, RELAY_URL, "guest")).toEqual({
				authorization: "Bearer deferred",
				"x-role": "guest",
			});
		} finally {
			await session.dispose();
		}
	});

	it("returns undefined synchronously when no extension can add headers", async () => {
		const { session } = await createSession([]);
		try {
			expect(session.hasPendingDeferredExtensions).toBe(false);
			expect(collabRelayHeaders(session, RELAY_URL, "host")).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});
});
