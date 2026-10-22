import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { renderProviderModels } from "@oh-my-pi/pi-coding-agent/cli/models-cli";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { TempDir } from "@oh-my-pi/pi-utils";

const config = `providers:
  review-provider:
    baseUrl: http://localhost:8000/v1
    api: openai-completions
    auth: none
    models:
      - id: review-model
        name: Review Model
        input: [text]
        contextWindow: 8192
        maxTokens: 4096
`;

function captureWarning(registry: ModelRegistry, json: boolean): string {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const out = spyOn(process.stdout, "write").mockImplementation(chunk => {
		stdout.push(String(chunk));
		return true;
	});
	const err = spyOn(process.stderr, "write").mockImplementation(chunk => {
		stderr.push(String(chunk));
		return true;
	});
	try {
		renderProviderModels(registry, "ls", "review-provider", json);
	} finally {
		out.mockRestore();
		err.mockRestore();
	}
	return (json ? stderr : stdout)
		.join("")
		.replace(/\u001b\[[0-9;]*m/g, "")
		.split("\n")[0]!;
}

test("review 4243915272: sidecar is private at creation and after rename", async () => {
	const tmp = TempDir.createSync("@last-good-private-");
	const auth = await AuthStorage.create(":memory:");
	const modelsPath = tmp.join("models.yml");
	const sidecarPath = tmp.join("models.last-good.yml");
	fs.writeFileSync(modelsPath, config);
	const originalOpen = fs.openSync;
	const creations: { temporary: string; mode: unknown }[] = [];
	const open = spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
		if (String(file).startsWith(`${sidecarPath}.`) && String(file).endsWith(".tmp")) {
			creations.push({ temporary: String(file), mode });
		}
		return originalOpen(file, flags, mode);
	}) as typeof fs.openSync);
	try {
		const registry = new ModelRegistry(auth, modelsPath);
		expect(registry.find("review-provider", "review-model")?.contextWindow).toBe(8192);
		expect(creations).toHaveLength(1);
		expect(creations[0].mode).toBe(0o600);
		expect(fs.existsSync(creations[0].temporary)).toBe(false);
		expect(fs.statSync(sidecarPath).mode & 0o777).toBe(0o600);
		expect(fs.readFileSync(sidecarPath, "utf8")).toBe(config);
	} finally {
		open.mockRestore();
		auth.close();
		await tmp.remove();
	}
});

test("review 4243915269: commented JSONC restores exact model values", async () => {
	const tmp = TempDir.createSync("@last-good-jsonc-");
	const auth = await AuthStorage.create(":memory:");
	const modelsPath = tmp.join("models.jsonc");
	const jsonc = `{
  // Preserve the primary parser, not the sidecar extension.
  "providers": {
    "review-provider": {
      "baseUrl": "http://localhost:8000/v1",
      "api": "openai-completions",
      "auth": "none",
      "models": [{ "id": "review-model", "name": "JSONC Model", "contextWindow": 8192, "maxTokens": 4096 }]
    }
  }
}`;
	try {
		fs.writeFileSync(modelsPath, jsonc);
		const good = new ModelRegistry(auth, modelsPath);
		expect(good.getError()).toBeUndefined();
		expect(good.find("review-provider", "review-model")?.name).toBe("JSONC Model");
		expect(fs.readFileSync(tmp.join("models.last-good.yml"), "utf8")).toBe(jsonc);
		fs.writeFileSync(modelsPath, "{ invalid JSONC");
		const restored = new ModelRegistry(auth, modelsPath);
		expect(restored.find("review-provider", "review-model")?.name).toBe("JSONC Model");
		expect(restored.find("review-provider", "review-model")?.contextWindow).toBe(8192);
		expect(restored.find("review-provider", "review-model")?.maxTokens).toBe(4096);
		expect(restored.getError()?.filePath).toBe(modelsPath);
	} finally {
		auth.close();
		await tmp.remove();
	}
});

test("review 4243915267: text and JSON warnings follow actual recovery state", async () => {
	const tmp = TempDir.createSync("@last-good-status-");
	const auth = await AuthStorage.create(":memory:");
	const modelsPath = tmp.join("models.yml");
	const sidecarPath = tmp.join("models.last-good.yml");
	const invalid = "providers:\n  review-provider:\n    models: null\n";
	const assertStatus = (registry: ModelRegistry, recovered: boolean) => {
		const error = registry.getError()!;
		expect(error.filePath).toBe(modelsPath);
		expect(error.line).toBe(3);
		// Neither wording may determine whether a snapshot exists.
		for (const message of ["fixture failure", "fixture custom providers failure"]) {
			Object.defineProperty(error, "message", { value: message, configurable: true });
			expect(error.message).toBe(message);
			const expected = `Warning: models.yml validation failed at ${modelsPath}:3 — ${recovered ? "keeping last-good custom providers" : "custom providers disabled"}`;
			for (const json of [false, true]) expect(captureWarning(registry, json)).toBe(expected);
		}
		expect(registry.isUsingLastGoodConfig()).toBe(recovered);
		expect(registry.find("review-provider", "review-model")?.id).toBe(recovered ? "review-model" : undefined);
	};
	try {
		fs.writeFileSync(modelsPath, invalid);
		assertStatus(new ModelRegistry(auth, modelsPath), false);
		fs.writeFileSync(sidecarPath, "providers: [invalid");
		assertStatus(new ModelRegistry(auth, modelsPath), false);
		fs.writeFileSync(modelsPath, config);
		const memory = new ModelRegistry(auth, modelsPath);
		expect(memory.isUsingLastGoodConfig()).toBe(false);
		fs.writeFileSync(modelsPath, invalid);
		assertStatus(new ModelRegistry(auth, modelsPath), true);
		fs.unlinkSync(sidecarPath);
		await memory.refresh("offline");
		assertStatus(memory, true);
		fs.writeFileSync(modelsPath, config);
		await memory.refresh("offline");
		expect(memory.getError()).toBeUndefined();
		expect(memory.isUsingLastGoodConfig()).toBe(false);
		fs.unlinkSync(modelsPath);
		const deleted = new ModelRegistry(auth, modelsPath);
		expect(deleted.getError()).toBeUndefined();
		expect(deleted.isUsingLastGoodConfig()).toBe(false);
		expect(deleted.find("review-provider", "review-model")).toBeUndefined();
	} finally {
		auth.close();
		await tmp.remove();
	}
});
