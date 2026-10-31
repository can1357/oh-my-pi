import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { SessionEvent } from "@oh-my-pi/pi-coding-agent/extensibility/shared-events";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * File storage that reports one session id as owned by another live process,
 * which is what makes a write move the session off its file. Every other id —
 * the sibling it moves to included — claims normally.
 */
class StorageWithForeignOwner extends FileSessionStorage {
	readonly #ownedElsewhere: string;

	constructor(ownedElsewhere: string) {
		super();
		this.#ownedElsewhere = ownedElsewhere;
	}

	override claimSession(sessionId: string, sessionPath: string): (() => void) | null {
		return sessionId === this.#ownedElsewhere ? null : super.claimSession(sessionId, sessionPath);
	}
}

describe("a session that had to leave its file", () => {
	it("announces the move with both ids, and never as a switch somebody chose", async () => {
		using tempDir = TempDir.createSync("@omp-session-moved-");
		const sessionDir = path.join(tempDir.path(), "sessions");
		const seed = SessionManager.create(tempDir.path(), sessionDir, new FileSessionStorage());
		await seed.ensureOnDisk();
		const sessionFile = seed.getSessionFile();
		const sessionId = seed.getSessionId();
		if (!sessionFile) throw new Error("Expected a persisted session");
		await seed.close();

		const sessionManager = await SessionManager.open(
			sessionFile,
			sessionDir,
			new StorageWithForeignOwner(sessionId),
			{ suppressBreadcrumb: true },
		);
		const events: SessionEvent[] = [];
		const announced = Promise.withResolvers<void>();
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("session_moved", event => {
					events.push(event);
					announced.resolve();
				});
				pi.on("session_switch", event => {
					events.push(event);
					announced.resolve();
				});
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"capture-session-moved",
		);
		const authStorage = await AuthStorage.create(":memory:");
		const modelRegistry = new ModelRegistry(authStorage);
		const mock = createMockModel();
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: mock, systemPrompt: ["Test"], tools: [], messages: [] },
				convertToLlm,
				streamFn: mock.stream,
			}),
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
			extensionRunner: new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry),
		});
		try {
			sessionManager.appendMessage({ role: "user", content: "a turn worth saving", timestamp: Date.now() });
			await sessionManager.flush();
			await announced.promise;

			expect(events).toEqual([
				{
					type: "session_moved",
					reason: "open-elsewhere",
					previousSessionId: sessionId,
					sessionId: sessionManager.getSessionId(),
					previousSessionFile: sessionFile,
					sessionFile: sessionManager.getSessionFile() as string,
				},
			]);
			expect(sessionManager.getSessionId()).not.toBe(sessionId);
		} finally {
			await session.dispose();
		}
	}, 30_000);
});
