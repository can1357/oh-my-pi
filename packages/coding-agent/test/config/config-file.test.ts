/**
 * Regression: the JSON → YAML config migration publishes `models.yml` with
 * owner-only permissions and without ever leaving a half-written file behind.
 *
 * `models.yml` can carry inline provider API keys, and the legacy `models.json`
 * it is migrated from is typically 0600. A migration that writes the destination
 * in place (no mode, no staging) both widens the permissions of the secret and
 * leaves a truncated file when the write dies midway — and the next load then
 * treats that truncated file as an already-migrated config, silently dropping
 * every custom provider.
 */
import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigFile } from "@oh-my-pi/pi-coding-agent/config/config-file";
import { getModelsConfigSchema } from "@oh-my-pi/pi-coding-agent/config/models-config-schema-bundle";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

const API_KEY = "sk-live-secret";
const LEGACY_MODELS_JSON = JSON.stringify({
	providers: {
		acme: {
			baseUrl: "https://api.acme.test/v1",
			apiKey: API_KEY,
		},
	},
});

describe("ConfigFile JSON → YAML migration", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		for (const dir of tempDirs.splice(0)) {
			removeSyncWithRetries(dir);
		}
	});

	test("publishes the migrated config readable only by its owner", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-config-migrate-"));
		tempDirs.push(dir);
		fs.writeFileSync(path.join(dir, "models.json"), LEGACY_MODELS_JSON, { encoding: "utf-8", mode: 0o600 });
		const ymlPath = path.join(dir, "models.yml");

		const result = new ConfigFile<unknown>("models", getModelsConfigSchema(), ymlPath).tryLoad();

		expect(result.status).toBe("ok");
		expect(fs.existsSync(ymlPath)).toBe(true);
		if (process.platform !== "win32") {
			expect(fs.statSync(ymlPath).mode & 0o777).toBe(0o600);
		}
		expect(fs.readFileSync(ymlPath, "utf-8")).toContain(API_KEY);
	});

	test("a write that dies midway leaves no config behind, so the next load retries", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-config-migrate-"));
		tempDirs.push(dir);
		fs.writeFileSync(path.join(dir, "models.json"), LEGACY_MODELS_JSON, { encoding: "utf-8", mode: 0o600 });
		const ymlPath = path.join(dir, "models.yml");

		// Simulate an interrupted write: the leading bytes reach the destination,
		// then the write fails before the rest of the content is flushed.
		vi.spyOn(fs, "writeFileSync").mockImplementation(
			(target: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView) => {
				const bytes =
					typeof data === "string"
						? Buffer.from(data)
						: Buffer.from(data.buffer, data.byteOffset, data.byteLength);
				const partial = bytes.subarray(0, 8);
				if (typeof target === "number") {
					fs.writeSync(target, partial);
				} else {
					fs.appendFileSync(target, partial);
				}
				throw new Error("simulated interrupted write");
			},
		);

		new ConfigFile<unknown>("models", getModelsConfigSchema(), ymlPath).tryLoad();
		vi.restoreAllMocks();

		// No truncated destination may survive the failure.
		expect(fs.existsSync(ymlPath)).toBe(false);

		// The next start retries the migration and publishes the whole config.
		const retry = new ConfigFile<unknown>("models", getModelsConfigSchema(), ymlPath).tryLoad();

		expect(retry.status).toBe("ok");
		expect(fs.readFileSync(ymlPath, "utf-8")).toContain(API_KEY);
	});
});
