import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { createAgentSession } from "../src/sdk";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

registerMockApi();

describe("inspect_image status notice after model change", () => {
	it("names the newly active model when cycling between two image-capable models", async () => {
		const dir = TempDir.createSync("@inspect-image-notice-");
		const auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
		try {
			auth.setRuntimeApiKey("mock", "test-key");
			const text = createMockModel({ id: "text", handler: () => ({ content: ["a"] }) });
			const visionA = createMockModel({ id: "visionA", handler: () => ({ content: ["b"] }) });
			visionA.input.push("image");
			const visionB = createMockModel({ id: "visionB", handler: () => ({ content: ["c"] }) });
			visionB.input.push("image");
			const settings = Settings.isolated({
				"compaction.enabled": false,
				"images.blockImages": false,
				"todo.enabled": false,
				"retry.enabled": false,
			});
			const { session } = await createAgentSession({
				cwd: dir.path(),
				agentDir: dir.path(),
				authStorage: auth,
				modelRegistry: new ModelRegistry(auth, path.join(dir.path(), "models.yml")),
				model: text,
				settings,
				sessionManager: SessionManager.inMemory(dir.path()),
				disableExtensionDiscovery: true,
				enableMCP: false,
				enableLsp: false,
				skills: [],
				rules: [],
				contextFiles: [],
			});
			const visionNotices: string[] = [];
			const unsubscribe = session.subscribe(event => {
				if (event.type === "notice" && event.source === "vision") visionNotices.push(event.message);
			});
			try {
				// text -> visionA: tool flips to hidden, notice names visionA.
				await session.setModel(visionA);
				expect(visionNotices.at(-1)).toContain("hidden");
				expect(visionNotices.at(-1)).toContain("mock/visionA");

				// visionA -> visionB: tool stays hidden (both image-capable). The
				// notice must refresh to name visionB, not keep naming visionA.
				await session.setModel(visionB);
				expect(visionNotices.at(-1)).toContain("mock/visionB");
				expect(visionNotices.at(-1)).not.toContain("mock/visionA");
			} finally {
				unsubscribe();
				await session.dispose();
			}
		} finally {
			auth.close();
			dir.removeSync();
		}
	});
});
