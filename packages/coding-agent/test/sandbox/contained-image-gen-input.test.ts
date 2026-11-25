/**
 * `generate_image` input files under the OS sandbox: an input path is read as `read` reads files,
 * so the container decides it. A path `stat` ahead of the open would run in omp, outside the
 * container, and report the size and kind of a file the container hides. The contained case skips
 * where no backend exists.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { type Api, type FetchImpl, type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { modelKind } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools";
import { ContainedFileAccess } from "@oh-my-pi/pi-coding-agent/sandbox/file-access";
import type { HostRequest } from "@oh-my-pi/pi-coding-agent/sandbox/host-protocol";
import { cfgSandboxEnabled } from "@oh-my-pi/pi-coding-agent/sandbox/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { imageGenTool } from "@oh-my-pi/pi-coding-agent/tools/image-gen";
import { encodeRawPng } from "@oh-my-pi/pi-coding-agent/utils/png-encode";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import {
	beginContainedSandboxTest,
	CONTAINED_SOURCE_RUNS,
	type ContainedSandboxTest,
	endContainedSandboxTest,
	SANDBOX_BACKEND_PRESENT,
} from "../helpers/sandbox-test-state";

const PNG = encodeRawPng(new Uint8Array(3 * 2 * 3), 3, 2, 3);
const GENERATED_DATA = Buffer.from("generated-image").toString("base64");

let fixture: ContainedSandboxTest;
let workspace: string;
const generatedImagePaths: string[] = [];

beforeEach(async () => {
	fixture = await beginContainedSandboxTest("contained-image-gen");
	({ workspace } = fixture);
});

afterEach(async () => {
	await Promise.all(generatedImagePaths.splice(0).map(imagePath => removeWithRetries(imagePath)));
	await endContainedSandboxTest(fixture);
});

function context(fetch: FetchImpl): CustomToolContext {
	const model: Model<Api> = buildModel({
		id: "flux",
		name: "deepinfra/flux",
		api: "openai-images",
		provider: "deepinfra",
		baseUrl: "https://deepinfra.example/v1",
		kind: "image",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	});
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("deepinfra", "key-deepinfra");
	const registry = new ModelRegistry(authStorage);
	registry.getAvailable = (kind = "chat") => (kind === "all" || modelKind(model) === kind ? [model] : []);
	registry.getAll = () => [model];
	registry.find = (provider, modelId) => (provider === model.provider && modelId === model.id ? model : undefined);
	return {
		fetch,
		sessionManager: SessionManager.inMemory(workspace),
		modelRegistry: registry,
		model: undefined,
		settings: Settings.isolated({ modelRoles: { image: "deepinfra/flux" } }),
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
	};
}

const imageFetch: FetchImpl = async () =>
	new Response(JSON.stringify({ data: [{ b64_json: GENERATED_DATA, media_type: "image/png" }] }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});

describe("generate_image input files", () => {
	it.skipIf(!SANDBOX_BACKEND_PRESENT || !CONTAINED_SOURCE_RUNS)(
		"opens an input file through the container and never stats its path in omp",
		async () => {
			const input = path.join(workspace, "in.png");
			fs.writeFileSync(input, PNG);
			const stat = vi.spyOn(fsp, "stat");
			const request = vi.spyOn(ContainedFileAccess.prototype, "request");

			const result = await imageGenTool.execute(
				"call-contained",
				{ subject: "edit", input: [{ path: input }] },
				undefined,
				context(imageFetch),
			);
			generatedImagePaths.push(...(result.details?.imagePaths ?? []));

			expect(result.details?.imageCount).toBe(1);
			expect(stat.mock.calls.map(([target]) => String(target))).not.toContain(input);
			const identified = request.mock.calls
				.map(([message]) => message as HostRequest)
				.filter(message => message.op === "file.identify")
				.map(message => message.path);
			expect(identified).toContain(input);
		},
	);

	it.skipIf(process.platform === "win32")(
		"refuses an input FIFO by its path stat before opening it when nothing is contained",
		async () => {
			cfgSandboxEnabled.set(fixture.settings, false);
			const fifo = path.join(workspace, "pipe.png");
			expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);

			await expect(
				imageGenTool.execute(
					"call-fifo",
					{ subject: "edit", input: [{ path: fifo }] },
					undefined,
					context(imageFetch),
				),
			).rejects.toThrow("it is a FIFO, not a regular file or directory");
		},
	);

	it.skipIf(!SANDBOX_BACKEND_PRESENT || !CONTAINED_SOURCE_RUNS)(
		"refuses a contained input FIFO with the special-file message, not the open's EINVAL",
		async () => {
			const fifo = path.join(workspace, "pipe.png");
			expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);

			await expect(
				imageGenTool.execute(
					"call-contained-fifo",
					{ subject: "edit", input: [{ path: fifo }] },
					undefined,
					context(imageFetch),
				),
			).rejects.toThrow(`Cannot load '${fifo}': it is a FIFO, device or other special file`);
		},
	);
});
