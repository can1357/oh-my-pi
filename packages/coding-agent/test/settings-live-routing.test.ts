import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { resolveAgentModelSelection } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { createAuthStorageSettingsSync } from "@oh-my-pi/pi-coding-agent/session/auth-broker-config";
import { getRetryFallbackChains } from "@oh-my-pi/pi-coding-agent/session/retry-fallback-chains";
import { cfgRetryUsageReservePct } from "@oh-my-pi/pi-coding-agent/session/settings";
import { cfgTaskAgentModelOverrides } from "@oh-my-pi/pi-coding-agent/task/settings";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const routing = (model: string, reservePct = 10, priority = 1) => ({
	modelRoles: { smol: `anthropic/${model}`, slow: "anthropic/strong" },
	retry: { fallbackChains: { smol: [`anthropic/${model}-fallback`] }, usageReservePct: reservePct },
	task: { agentModelOverrides: { worker: "@smol" } },
	auth: { accountPolicies: [{ provider: "live-routing-test", account: { accountId: "routing-test" }, priority }] },
});

// Real filesystem notifications arrive outside fake timers; wait for observed
// settings/log transitions while exercising the production debounce.
async function waitFor(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!check()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for live config reload");
		await Bun.sleep(10);
	}
}

// Windows cannot rename a directory link over an existing one (EPERM), so it swaps non-atomically.
async function retargetDirLink(link: string, target: string): Promise<void> {
	if (process.platform === "win32") {
		await fs.unlink(link);
		await fs.symlink(target, link, "dir");
		return;
	}
	await fs.symlink(target, `${link}.next`, "dir");
	await fs.rename(`${link}.next`, link);
}

function selection(settings: Settings) {
	return resolveAgentModelSelection({
		settingsOverride: cfgTaskAgentModelOverrides.get(settings).worker,
		agentModel: "anthropic/agent-default",
		settings,
	});
}

describe("live routing config files", () => {
	let state: SettingsTestState | undefined;
	let tempDir: TempDir;
	let settings: Settings;
	const cleanups: Array<() => void> = [];

	beforeEach(() => {
		state = beginSettingsTest();
		delete process.env.PI_CONFIG_FILES;
		tempDir = TempDir.createSync("@pi-live-routing-");
	});

	afterEach(async () => {
		settings?.cancelPendingSaves();
		for (const cleanup of cleanups.splice(0)) cleanup();
		AgentStorage.close();
		restoreSettingsTestState(state);
		await tempDir.remove();
	});

	async function start(file: string, agentDir = tempDir.join("agent")) {
		settings = await Settings.init({ cwd: tempDir.path(), agentDir, configFiles: [file] });
		settings.startWatching();
		return settings;
	}

	it("applies atomic overlay edits to subsequent model selection, fallbacks and account health", async () => {
		const file = tempDir.join("routing.yml");
		await Bun.write(file, YAML.stringify(routing("first")));
		await start(file);
		const storage = new AuthStorage(await SqliteAuthCredentialStore.open(tempDir.join("auth.db")), {
			defaultReservePct: cfgRetryUsageReservePct.get(settings),
			usageProviderResolver: () => ({
				id: "live-routing-test",
				fetchUsage: async () => ({
					provider: "live-routing-test",
					fetchedAt: Date.now(),
					limits: [
						{
							id: "quota",
							label: "Quota",
							scope: { provider: "live-routing-test" },
							amount: { usedFraction: 0.8, unit: "percent" },
							status: "ok",
						},
					],
				}),
			}),
		});
		await storage.credentials.set("live-routing-test", {
			type: "oauth",
			access: "test-access",
			refresh: "test-refresh",
			expires: Date.now() + 3600000,
			accountId: "routing-test",
		});
		const sync = createAuthStorageSettingsSync(settings, storage);
		cleanups.push(
			() => sync.stop(),
			() => storage.close(),
		);
		expect(selection(settings).patterns).toEqual(["anthropic/first"]);
		// A non-finite per-call threshold uses the storage's configured reserve.
		expect((await storage.health.model("live-routing-test", { reserveFraction: Number.NaN })).state).toBe("healthy");

		const next = routing("second", 30, 7);
		next.task.agentModelOverrides.worker = "@slow";
		await Bun.write(`${file}.next`, YAML.stringify(next));
		await fs.rename(`${file}.next`, file);
		await waitFor(() => settings.getModelRole("smol") === "anthropic/second");
		await sync.settled();

		expect(selection(settings).patterns).toEqual(["anthropic/strong"]);
		expect(getRetryFallbackChains(settings).smol).toEqual(["anthropic/second-fallback"]);
		expect(storage.oauth.policy("live-routing-test", { accountId: "routing-test" })?.priority).toBe(7);
		expect((await storage.health.model("live-routing-test", { reserveFraction: Number.NaN })).state).toBe("reserve");
	});

	it("follows replacement of a profile ancestor symlink and watches the new target", async () => {
		const first = tempDir.join("profile-a");
		const second = tempDir.join("profile-b");
		await Bun.write(path.join(first, "config", "routing.yml"), YAML.stringify(routing("first")));
		await Bun.write(path.join(second, "config", "routing.yml"), YAML.stringify(routing("second")));
		const profile = tempDir.join("profile");
		await fs.symlink(first, profile, "dir");
		await start(path.join(profile, "config", "routing.yml"));
		await retargetDirLink(profile, second);
		await waitFor(() => settings.getModelRole("smol") === "anthropic/second");
		expect(selection(settings).patterns).toEqual(["anthropic/second"]);
		await Bun.write(path.join(second, "config", "routing.yml"), YAML.stringify(routing("third")));
		await waitFor(() => settings.getModelRole("smol") === "anthropic/third");
		expect(getRetryFallbackChains(settings).smol).toEqual(["anthropic/third-fallback"]);
	});

	it("follows an intermediate file symlink replaced without touching the logical overlay", async () => {
		const first = tempDir.join("first.yml");
		const second = tempDir.join("second.yml");
		await Bun.write(first, YAML.stringify(routing("first")));
		await Bun.write(second, YAML.stringify(routing("second")));
		const managed = tempDir.join("managed", "current.yml");
		await fs.mkdir(path.dirname(managed));
		await fs.symlink(first, managed, "file");
		const file = tempDir.join("routing.yml");
		await fs.symlink(managed, file, "file");
		await start(file);
		await fs.symlink(second, `${managed}.next`, "file");
		await fs.rename(`${managed}.next`, managed);
		await waitFor(() => settings.getModelRole("smol") === "anthropic/second");
		expect(selection(settings).patterns).toEqual(["anthropic/second"]);
		await Bun.write(second, YAML.stringify(routing("third")));
		await waitFor(() => settings.getModelRole("smol") === "anthropic/third");
	});

	it("keeps last good routing on malformed target replacement and preserves runtime overrides on recovery", async () => {
		const first = tempDir.join("profile-a");
		const second = tempDir.join("profile-b");
		await Bun.write(path.join(first, "routing.yml"), YAML.stringify(routing("first")));
		await Bun.write(path.join(second, "routing.yml"), "modelRoles: [\n");
		const profile = tempDir.join("profile");
		await fs.symlink(first, profile, "dir");
		await start(path.join(profile, "routing.yml"));
		cfgTaskAgentModelOverrides.override(settings, { worker: "anthropic/runtime" });
		const warnings = vi.spyOn(logger, "warn");
		await retargetDirLink(profile, second);
		await waitFor(() => warnings.mock.calls.some(([message]) => message.includes("keeping last good config")));
		expect(settings.getModelRole("smol")).toBe("anthropic/first");
		expect(await Bun.file(path.join(second, "routing.yml")).text()).toBe("modelRoles: [\n");
		await Bun.write(path.join(second, "routing.yml"), YAML.stringify(routing("recovered")));
		await waitFor(() => settings.getModelRole("smol") === "anthropic/recovered");
		expect(selection(settings).patterns).toEqual(["anthropic/runtime"]);
		expect(getRetryFallbackChains(settings).smol).toEqual(["anthropic/recovered-fallback"]);
	});
});
