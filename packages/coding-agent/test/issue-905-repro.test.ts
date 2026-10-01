/**
 * Regression test for issue #905.
 *
 * Model listing did not include providers contributed by extensions
 * (via `pi.registerProvider(...)`), regardless of whether the extension was
 * supplied via `-e <path>` or configured under `extensions:` in the user
 * settings. The original `--list-models` short-circuit in `runRootCommand`
 * exited before extensions were loaded.
 *
 * Contract under test: the `omp models` listing entry point loads extensions
 * (CLI `-e` paths and configured `settings.extensions`) before listing, so
 * extension-registered providers/models appear in the output.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { runModelsListing } from "@oh-my-pi/pi-coding-agent/cli/models-cli";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";

let tmp: TempDir;
let extPath: string;
let explicitPackagePath: string;
let ambientExtPath: string;
let ambientHookMarkerPath: string;
let configuredHookMarkerPath: string;
let dbPath: string;
let shutdownExtPath: string;
let shutdownPath: string;

beforeAll(async () => {
	tmp = await TempDir.create("@issue-905-");
	extPath = tmp.join("ext.ts");
	dbPath = tmp.join("auth.db");
	shutdownExtPath = tmp.join("shutdown-ext.ts");
	shutdownPath = tmp.join("shutdown");
	await fs.writeFile(
		extPath,
		`export default function (pi) {
	pi.registerProvider("test-gw", {
		baseUrl: "https://example.com/v1",
		apiKey: "literal-test-key",
		api: "openai-completions",
		models: [{
			id: "test-model",
			name: "Test Model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		}],
	});
}
`,
	);
	await fs.writeFile(
		shutdownExtPath,
		`export default function (pi) {
	pi.on("session_shutdown", async () => {
		await Bun.write(${JSON.stringify(shutdownPath)}, "shutdown");
	});
}
`,
	);
	explicitPackagePath = tmp.join("explicit-package");
	ambientExtPath = tmp.join("ambient.ts");
	ambientHookMarkerPath = tmp.join("ambient-hook-loaded");
	configuredHookMarkerPath = tmp.join("configured-hook-loaded");
	await fs.mkdir(tmp.join("explicit-package", "src"), { recursive: true });
	await fs.mkdir(tmp.join("explicit-package", "hooks", "pre"), { recursive: true });
	const hookDir = path.join(getProjectAgentDir(tmp.path()), "hooks", "pre");
	await fs.mkdir(hookDir, { recursive: true });
	await fs.writeFile(
		path.join(hookDir, "models-poison.ts"),
		`await Bun.write(${JSON.stringify(ambientHookMarkerPath)}, "loaded");
export default function () {}
`,
	);
	await fs.writeFile(
		tmp.join("explicit-package", "package.json"),
		JSON.stringify({ name: "explicit-package", omp: { extensions: ["./src/main.ts"] } }),
	);
	await fs.writeFile(
		tmp.join("explicit-package", "hooks", "pre", "models-poison.ts"),
		`await Bun.write(${JSON.stringify(configuredHookMarkerPath)}, "loaded");
export default function () {}
`,
	);
	await fs.writeFile(
		tmp.join("explicit-package", "src", "main.ts"),
		`export default function (pi) {
	pi.registerProvider("explicit-gw", {
		baseUrl: "https://explicit.example.com/v1",
		apiKey: "literal-test-key",
		api: "openai-completions",
		models: [{
			id: "explicit-model",
			name: "Explicit Model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		}],
	});
}
`,
	);
	await fs.writeFile(
		ambientExtPath,
		`export default function (pi) {
	pi.registerProvider("ambient-gw", {
		baseUrl: "https://ambient.example.com/v1",
		apiKey: "literal-test-key",
		api: "openai-completions",
		models: [{
			id: "ambient-model",
			name: "Ambient Model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		}],
	});
}
`,
	);
});

afterAll(async () => {
	await tmp.remove();
});

test("omp models surfaces extension-registered providers (issue #905)", async () => {
	const authStorage = await AuthStorage.create(dbPath);
	try {
		const modelRegistry = new ModelRegistry(authStorage);

		const captured: string[] = [];
		const originalWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: string | Uint8Array) => {
			captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		}) as typeof process.stdout.write;

		try {
			await runModelsListing({
				modelRegistry,
				cwd: tmp.path(),
				action: "ls",
				additionalExtensionPaths: [extPath],
				disableExtensionDiscovery: true,
			});
		} finally {
			process.stdout.write = originalWrite;
		}

		const output = captured.join("");
		expect(output).toContain("test-gw");
		expect(output).toContain("test-model");
	} finally {
		authStorage.close();
	}
});

test("omp models does not execute ambient hooks while retaining explicit providers", async () => {
	const authStorage = await AuthStorage.create(":memory:");
	try {
		const modelRegistry = new ModelRegistry(authStorage);
		const captured: string[] = [];
		const originalWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: string | Uint8Array) => {
			captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		}) as typeof process.stdout.write;

		try {
			await runModelsListing({
				modelRegistry,
				cwd: tmp.path(),
				action: "ls",
				additionalExtensionPaths: [explicitPackagePath],
			});
		} finally {
			process.stdout.write = originalWrite;
		}

		const output = captured.join("");
		expect(output).toContain("explicit-gw");
		expect(output).toContain("explicit-model");
		expect(await Bun.file(ambientHookMarkerPath).exists()).toBe(false);
		expect(await Bun.file(configuredHookMarkerPath).exists()).toBe(false);
	} finally {
		authStorage.close();
	}
});

test("omp models emits extension shutdown after listing (issue #6297)", async () => {
	const authStorage = await AuthStorage.create(":memory:");
	try {
		const modelRegistry = new ModelRegistry(authStorage);
		await runModelsListing({
			modelRegistry,
			cwd: tmp.path(),
			action: "ls",
			pattern: "issue-6297-no-models",
			additionalExtensionPaths: [shutdownExtPath],
			disableExtensionDiscovery: true,
		});

		expect(await Bun.file(shutdownPath).text()).toBe("shutdown");
	} finally {
		authStorage.close();
	}
});

test("omp models explicit-only mode resolves a package and excludes settings providers", async () => {
	const authStorage = await AuthStorage.create(":memory:");
	try {
		const modelRegistry = new ModelRegistry(authStorage);
		const captured: string[] = [];
		const originalWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: string | Uint8Array) => {
			captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		}) as typeof process.stdout.write;

		try {
			await runModelsListing({
				modelRegistry,
				cwd: tmp.path(),
				action: "ls",
				additionalExtensionPaths: [explicitPackagePath],
				settingsExtensions: [ambientExtPath],
				disableExtensionDiscovery: true,
			});
		} finally {
			process.stdout.write = originalWrite;
		}

		const output = captured.join("");
		expect(output).toContain("explicit-gw");
		expect(output).toContain("explicit-model");
		expect(output).not.toContain("ambient-gw");
		expect(output).not.toContain("ambient-model");
	} finally {
		authStorage.close();
	}
});

test("omp models prints invalid models.yml schema errors before listing output", async () => {
	const modelsPath = tmp.join("invalid-models.yml");
	await fs.writeFile(
		modelsPath,
		`providers:
  myprovider:
    baseUrl: http://localhost:8000/v1
    api: openai-completions
    auth: none
    compat:
      thinkingFormat: deepseek
    models:
      - id: my-model
        name: My Model
        reasoning: false
        input: [text]
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        contextWindow: 8192
        maxTokens: 4096
`,
	);

	const authStorage = await AuthStorage.create(":memory:");
	try {
		const modelRegistry = new ModelRegistry(authStorage, modelsPath);

		const captured: string[] = [];
		const originalWrite = process.stdout.write;
		Reflect.set(process.stdout, "write", (chunk: string | Uint8Array) => {
			captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		});

		try {
			await runModelsListing({
				modelRegistry,
				cwd: tmp.path(),
				action: "ls",
				pattern: "myprovider",
				disableExtensionDiscovery: true,
			});
		} finally {
			process.stdout.write = originalWrite;
		}

		const output = captured.join("");
		expect(output).toContain("Warning: models.yml validation failed — custom providers disabled");
		expect(output).toContain("providers.myprovider.compat.thinkingFormat");
		expect(output).toContain("deepseek");
	} finally {
		authStorage.close();
	}
});
