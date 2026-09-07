/**
 * `extendedContext: false` clamps a premium long-context model's window, so
 * `omp models` must say so rather than presenting the clamped number as the
 * model's own. Two output contracts are covered here because the registry tests
 * only exercise the metadata behind them:
 * - `--json`: `cappedExtendedContextWindow` carries the window the setting
 *   withholds (and is `null` for models the setting does not cap).
 * - the text table: the capped row's context cell gets a `*` marker and the
 *   listing gains the footnote naming the setting.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { runModelsListing } from "@oh-my-pi/pi-coding-agent/cli/models-cli";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

/** `openai/gpt-5.6-sol` bills 2x input above 272K, so the cap clamps it there. */
const CLAMPED_WINDOW = 272_000;
const FULL_WINDOW = 1_050_000;

let tmp: TempDir;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;

beforeAll(async () => {
	tmp = await TempDir.create("@models-cli-cap-");
	resetSettingsForTest();
	// The registry applies the clamp from the global setting at construction.
	await Settings.init({ inMemory: true, overrides: { extendedContext: false } });
	authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("openai", "sk-test");
	modelRegistry = new ModelRegistry(authStorage);
	const capped = modelRegistry.find("openai", "gpt-5.6-sol");
	// Guard: both assertions below are vacuous if the fixture is not capped.
	expect(capped?.contextWindow).toBe(CLAMPED_WINDOW);
	expect(modelRegistry.cappedExtendedContextWindow(capped!)).toBe(FULL_WINDOW);
});

afterAll(async () => {
	authStorage.close();
	resetSettingsForTest();
	await tmp.remove();
});

async function captureListing(json: boolean): Promise<string> {
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
			action: "find",
			pattern: "gpt-5.6-sol",
			json,
			disableExtensionDiscovery: true,
		});
	} finally {
		process.stdout.write = originalWrite;
	}
	return captured.join("");
}

test("omp models --json reports the window the cap withholds", async () => {
	const parsed: {
		models: { selector: string; contextWindow: number | null; cappedExtendedContextWindow: number | null }[];
	} = JSON.parse(await captureListing(true));

	const capped = parsed.models.find(model => model.selector === "openai/gpt-5.6-sol");
	expect(capped).toBeDefined();
	expect(capped?.contextWindow).toBe(CLAMPED_WINDOW);
	expect(capped?.cappedExtendedContextWindow).toBe(FULL_WINDOW);
});

test("omp models --json leaves the field null for an uncapped model", async () => {
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
			action: "find",
			// Standard-priced, no premium long-context tier: never clamped.
			pattern: "gpt-5.4",
			json: true,
			disableExtensionDiscovery: true,
		});
	} finally {
		process.stdout.write = originalWrite;
	}
	const parsed: { models: { selector: string; cappedExtendedContextWindow: number | null }[] } = JSON.parse(
		captured.join(""),
	);
	const uncapped = parsed.models.find(model => model.selector === "openai/gpt-5.4");
	expect(uncapped).toBeDefined();
	expect(uncapped?.cappedExtendedContextWindow).toBeNull();
});

test("omp models marks the capped row and footnotes the setting", async () => {
	const output = await captureListing(false);

	// The clamped window renders with the marker, not as a bare number.
	expect(output).toMatch(/gpt-5\.6-sol\s*│\s*272K\*/);
	expect(output).toContain("* capped by extendedContext=off");
	expect(output).toContain("/extended-context on restores the full premium window");
});
