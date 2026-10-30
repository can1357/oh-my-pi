/**
 * `tts` and `generate_image` install the way `sdk.ts` installs them: through
 * `customToolToDefinition` and the extension runner. So the context they run with is an extension
 * context, and the session's services reach them as an extension's context hands them
 * (`context-surfaces.ts`) — the registry's catalog and credential lookups, the session manager's
 * read-only members. Each test runs one tool down that path and checks what goes on the wire: the
 * selected model's endpoint, with the session's credential.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { modelKind } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import {
	ExtensionRuntime,
	extensionToolSourceInfo,
	loadExtensionFromFactory,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { wrapRegisteredTools } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { customToolToDefinition } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { imageGenTool } from "@oh-my-pi/pi-coding-agent/tools/image-gen";
import { ttsTool } from "@oh-my-pi/pi-coding-agent/tools/tts";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { removeWithRetries, TempDir } from "@oh-my-pi/pi-utils";

interface Sent {
	url: string;
	authorization: string | null;
}

let dir: TempDir;
let auth: AuthStorage;
const cleanups: Array<() => void | Promise<void>> = [];

beforeEach(async () => {
	dir = TempDir.createSync("@bundled-tools-runner-");
	auth = await AuthStorage.create(":memory:");
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	auth.close();
	dir.removeSync();
	resetSettingsForTest();
});

/** Records every request the tool makes, answering each with `answer`. */
function recordRequests(answer: () => Response): Sent[] {
	const sent: Sent[] = [];
	spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
		sent.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
		return answer();
	}) as typeof fetch);
	return sent;
}

/** `tool`, installed as `sdk.ts` installs `tts` and `generate_image`: a definition registered
 *  through the extension runner, so it runs with that runner's context. */
async function installed(tool: CustomTool, registry: ModelRegistry) {
	const owner = new ExtensionRuntime();
	const release = owner.beginSession();
	cleanups.push(release);
	const extension = await loadExtensionFromFactory(() => {}, dir.path(), new EventBus(), owner, "bundled-tools");
	const runner = new ExtensionRunner([extension], owner, dir.path(), SessionManager.inMemory(dir.path()), registry);
	const definition = customToolToDefinition(tool);
	const [adapted] = wrapRegisteredTools(
		[{ definition, extensionPath: "<sdk>", sourceInfo: extensionToolSourceInfo(definition, "<sdk>") }],
		runner,
	);
	if (!adapted) throw new Error("the tool was not installed");
	return adapted;
}

describe("tts through the extension runner", () => {
	test("synthesizes with the selected speech model and the session's credential", async () => {
		const speech = getBundledModel("deepinfra", "hexgrad/Kokoro-82M");
		if (!speech) throw new Error("expected the bundled deepinfra speech model");
		await Settings.init({
			inMemory: true,
			cwd: dir.path(),
			overrides: {
				modelRoles: { speech: `${speech.provider}/${speech.id}` },
				"retry.fallbackChains": { speech: [] },
			},
		});
		auth.keys.setRuntime(speech.provider, "deepinfra-session-key");
		const registry = new ModelRegistry(auth, path.join(dir.path(), "models.yml"));
		const sent = recordRequests(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
		const tool = await installed(ttsTool as unknown as CustomTool, registry);

		const result = await tool.execute("tts-1", {
			text: "Hello",
			voice_id: "sky",
			language: "en",
			output_path: "voice.mp3",
		});

		expect(result.isError).not.toBe(true);
		expect(sent).toEqual([{ url: `${speech.baseUrl}/audio/speech`, authorization: "Bearer deepinfra-session-key" }]);
		expect(fs.existsSync(path.join(dir.path(), "voice.mp3"))).toBe(true);
		// Each tool builds a session and a registry; 72 ms alone, but this sits in a sweep of
		// thousands of tests, where the default 5 s is not room enough on a loaded box.
	}, 30_000);
});

describe("generate_image through the extension runner", () => {
	test("generates with the selected image model and the session's credential", async () => {
		const image: Model<Api> = buildModel({
			id: "requested-image",
			name: "openrouter/requested-image",
			api: "openrouter-images",
			provider: "openrouter",
			baseUrl: "https://openrouter.example/v1",
			kind: "image",
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_192,
		});
		await Settings.init({
			inMemory: true,
			cwd: dir.path(),
			overrides: { modelRoles: { image: `${image.provider}/${image.id}` } },
		});
		auth.keys.setRuntime(image.provider, "openrouter-session-key");
		const registry = new ModelRegistry(auth, path.join(dir.path(), "models.yml"));
		// The catalog serves the one image model; the registry's credential lookups stay its own.
		registry.getAvailable = (kind = "chat") => (kind === "all" || modelKind(image) === kind ? [image] : []);
		registry.getAll = () => [image];
		registry.find = (provider, id) => (provider === image.provider && id === image.id ? image : undefined);
		const sent = recordRequests(
			() =>
				new Response(
					JSON.stringify({
						data: [{ b64_json: Buffer.from("image").toString("base64"), media_type: "image/png" }],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		const tool = await installed(imageGenTool as unknown as CustomTool, registry);

		const result = await tool.execute("image-1", { subject: "a lighthouse" });
		const details: unknown = result.details;
		const imagePaths =
			typeof details === "object" && details !== null && "imagePaths" in details && Array.isArray(details.imagePaths)
				? details.imagePaths.filter((entry): entry is string => typeof entry === "string")
				: [];
		cleanups.push(() => Promise.all(imagePaths.map(imagePath => removeWithRetries(imagePath))).then(() => {}));

		expect(result.isError).not.toBe(true);
		expect(sent).toEqual([
			{ url: "https://openrouter.example/v1/images", authorization: "Bearer openrouter-session-key" },
		]);
		expect(imagePaths).toHaveLength(1);
	}, 30_000);
});
