/**
 * `@image.png` mentions are image attachments: with `images.describeForTextModels`
 * a text-only model must receive the vision-role description, same as images sent
 * as prompt content (#16853).
 */
import { afterEach, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as imageVisionFallback from "@oh-my-pi/pi-coding-agent/utils/image-vision-fallback";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

const cleanups: Array<() => unknown> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("describes an @-mentioned image for a text-only model", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-file-mention-vision-"));
	cleanups.push(() => removeWithRetries(dir));
	const imagePath = path.join(dir, "shot.png");
	await Bun.write(imagePath, Buffer.from(PNG_BASE64, "base64"));

	const authStorage = await AuthStorage.create(":memory:");
	cleanups.push(() => authStorage.close());
	authStorage.keys.setRuntime("anthropic", "test-key");
	const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!bundled) throw new Error("Expected claude-sonnet-4-5 model to exist");
	const textOnly: Model = { ...bundled, input: ["text"] };
	const mock = createMockModel({ responses: [{ content: ["ok"] }] });
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model: textOnly, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		}),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
		modelRegistry: new ModelRegistry(authStorage),
	});
	cleanups.push(() => session.dispose());
	const describe = spyOn(imageVisionFallback, "describeAttachedImagesForTextModel").mockResolvedValue([
		{ type: "text", text: "a single grey pixel" },
	]);
	cleanups.push(() => describe.mockRestore());

	await session.prompt(`@${imagePath} what does this say?`);

	expect(describe).toHaveBeenCalledTimes(1);
	expect(describe.mock.calls[0]?.[0]).toHaveLength(1);
	expect(JSON.stringify(mock.calls[0]?.context.messages)).toContain("a single grey pixel");
});
