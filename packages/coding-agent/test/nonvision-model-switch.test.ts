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

describe("model switch from vision to text-only", () => {
	it("omits historical images from the text-only provider request", async () => {
		const dir = TempDir.createSync("@nonvision-history-");
		const auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
		try {
			auth.setRuntimeApiKey("mock", "test-key");
			const vision = createMockModel({ id: "vision", handler: () => ({ content: ["first"] }) });
			vision.input.push("image");
			const text = createMockModel({ id: "text", handler: () => ({ content: ["second"] }) });
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
				model: vision,
				settings,
				sessionManager: SessionManager.inMemory(dir.path()),
				disableExtensionDiscovery: true,
				enableMCP: false,
				enableLsp: false,
				skills: [],
				rules: [],
				contextFiles: [],
			});
			const notices: string[] = [];
			const unsubscribe = session.subscribe(event => {
				if (event.type === "notice") notices.push(`${event.source}:${event.message}`);
			});
			try {
				await session.prompt("see image", { images: [{ type: "image", data: "aaaa", mimeType: "image/png" }] });
				await session.setModel(text);
				await session.prompt("now text only");

				const messages = text.calls.at(-1)?.context.messages ?? [];
				expect(
					messages.flatMap<unknown>(message => (Array.isArray(message.content) ? message.content : [])),
				).not.toContainEqual(expect.objectContaining({ type: "image" }));

				await session.setModel(vision);
				expect(notices.at(-1)).toContain("vision:inspect_image is now hidden:");
				expect(notices.at(-1)).toContain("supports image input natively. Override with /vision on.");
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
