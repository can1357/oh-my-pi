import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { resolveModelCacheProviderId } from "@oh-my-pi/pi-catalog/provider-models";
import { getModelDbPath, TempDir } from "@oh-my-pi/pi-utils";

const cliEntry = path.join(import.meta.dir, "..", "src", "cli.ts");

test("omp dry-balance resolves credential-scoped models from the model cache", async () => {
	const tempDir = TempDir.createSync("@omp-dry-balance-runtime-");
	const apiKey = "dry-balance-cache-test-key";
	const modelId = "cached-dry-balance-model";
	const cacheDbPath = getModelDbPath(tempDir.path());
	await fs.mkdir(path.dirname(cacheDbPath), { recursive: true });
	try {
		writeModelCache(
			resolveModelCacheProviderId("opencode-go", { apiKey }),
			Date.now(),
			[
				buildModel({
					id: modelId,
					name: "Cached Dry Balance Model",
					provider: "opencode-go",
					api: "openai-completions",
					baseUrl: "https://opencode.ai/zen/go/v1",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 4096,
				}),
			],
			true,
			"",
			cacheDbPath,
		);
		const child = Bun.spawn(
			[process.execPath, cliEntry, "dry-balance", `opencode-go/${modelId}`, "--count", "1", "--json"],
			{
				cwd: tempDir.path(),
				env: { ...process.env, NO_COLOR: "1", OPENCODE_API_KEY: apiKey, PI_CODING_AGENT_DIR: tempDir.path() },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);

		// No OAuth account is stored, so the sample itself fails; resolving the model is the contract here.
		expect(stderr).toBe("");
		expect(JSON.parse(stdout).model).toBe(`opencode-go/${modelId}`);
	} finally {
		await tempDir.remove();
	}
});
