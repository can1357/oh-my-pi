/**
 * The `tts` and `generate_image` tools send paid provider requests through
 * clients that take a `fetch` but no `beforeDispatch`, so `/pause` holds each
 * of those requests in `pauseHeldFetch`. Resuming answers the parked hold, and
 * the request used to reach the wire some microtasks later: a pause that
 * returned in between went unseen, and the tool's request went out while the
 * gate was engaged. These tests run each tool through that window at every
 * depth and check that no request reaches the wire while `/pause` is engaged.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import type { Api, FetchImpl, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { modelKind } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { imageGenTool } from "@oh-my-pi/pi-coding-agent/tools/image-gen";
import { ttsTool } from "@oh-my-pi/pi-coding-agent/tools/tts";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/** Deep enough to reach past every microtask between the gate's hold answering and the send. */
const MAX_DEPTH = 24;

const generatedImagePaths: string[] = [];
let tempDir: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-pause-held-tools-"));
});

afterEach(() => {
	agentPauseGate.resume();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

afterAll(async () => {
	await Promise.all(generatedImagePaths.map(imagePath => removeWithRetries(imagePath)));
});

function tick(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

/** Runs `fn` `depth` microtasks from now. */
function afterMicrotasks(depth: number, fn: () => void): void {
	queueMicrotask(() => (depth <= 1 ? fn() : afterMicrotasks(depth - 1, fn)));
}

function toolContext(models: Model<Api>[], settings: Settings, fetch: FetchImpl): CustomToolContext {
	const authStorage = createInMemoryAuthStorage();
	for (const model of models) authStorage.keys.setRuntime(model.provider, `key-${model.provider}`);
	const modelRegistry = new ModelRegistry(authStorage);
	modelRegistry.getAvailable = (kind = "chat") =>
		kind === "all" ? [...models] : models.filter(model => modelKind(model) === kind);
	modelRegistry.getAll = () => [...models];
	modelRegistry.find = (provider, modelId) =>
		models.find(model => model.provider === provider && model.id === modelId);
	return {
		fetch,
		sessionManager: SessionManager.inMemory(tempDir),
		modelRegistry,
		model: undefined,
		settings,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
	};
}

/**
 * Starts `run` with the gate open — a tool call already running when `/pause`
 * lands — and closes the gate in the same step, so the tool's request parks in
 * its held fetch; `sent` (what the wire saw) stays empty while it does. Then
 * resumes, closes the gate again `depth` microtasks later, and resumes once
 * more on the next turn so the tool can finish.
 */
async function resumeIntoReturningPause<T>(run: () => Promise<T>, sent: readonly boolean[], depth: number): Promise<T> {
	const pending = run();
	agentPauseGate.pause();
	for (let i = 0; i < 50 && sent.length === 0; i++) await tick();
	expect(sent).toEqual([]);
	agentPauseGate.resume();
	afterMicrotasks(depth, () => agentPauseGate.pause());
	await tick();
	agentPauseGate.resume();
	return pending;
}

describe("speech and image tools under a pause that returns during the resume", () => {
	test("the tts tool's speech request never reaches the wire while paused", async () => {
		const speechModel = getBundledModel("deepinfra", "hexgrad/Kokoro-82M");
		if (!speechModel) throw new Error("Missing bundled test model: deepinfra/hexgrad/Kokoro-82M");
		const settings = Settings.isolated({
			modelRoles: { speech: `${speechModel.provider}/${speechModel.id}` },
			"retry.fallbackChains": { speech: [] },
		});
		let sent: boolean[] = [];
		const ctx = toolContext([speechModel], settings, async () => {
			sent.push(agentPauseGate.paused);
			return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
		});

		const sentWhilePaused: number[] = [];
		for (let depth = 1; depth <= MAX_DEPTH; depth++) {
			sent = [];
			const result = await resumeIntoReturningPause(
				() =>
					ttsTool.execute(
						`tts-${depth}`,
						{ text: "Hello", language: "en", output_path: `voice-${depth}.mp3` },
						undefined,
						ctx,
					),
				sent,
				depth,
			);
			if (sent.includes(true)) sentWhilePaused.push(depth);
			expect(sent).toHaveLength(1);
			expect(result.details).toMatchObject({ backend: "openai-speech", bytes: 3 });
		}
		expect(sentWhilePaused).toEqual([]);
	});

	test("the generate_image tool's generation request never reaches the wire while paused", async () => {
		const imageModel = buildModel({
			id: "pause-image",
			name: "deepinfra/pause-image",
			api: "openai-images",
			provider: "deepinfra",
			baseUrl: "https://deepinfra.example/v1",
			kind: "image",
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_192,
		});
		const settings = Settings.isolated({
			modelRoles: { image: `${imageModel.provider}/${imageModel.id}` },
			"retry.fallbackChains": { image: [] },
		});
		let sent: boolean[] = [];
		const ctx = toolContext([imageModel], settings, async () => {
			sent.push(agentPauseGate.paused);
			return new Response(
				JSON.stringify({ data: [{ b64_json: Buffer.from("image").toString("base64"), media_type: "image/png" }] }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});

		const sentWhilePaused: number[] = [];
		for (let depth = 1; depth <= MAX_DEPTH; depth++) {
			sent = [];
			const result = await resumeIntoReturningPause(
				() => imageGenTool.execute(`image-${depth}`, { subject: "a held request" }, undefined, ctx),
				sent,
				depth,
			);
			generatedImagePaths.push(...(result.details?.imagePaths ?? []));
			if (sent.includes(true)) sentWhilePaused.push(depth);
			expect(sent).toHaveLength(1);
			expect(result.details?.imageCount).toBe(1);
		}
		expect(sentWhilePaused).toEqual([]);
	});
});
