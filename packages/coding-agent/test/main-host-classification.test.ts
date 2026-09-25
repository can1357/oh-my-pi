import { expect, it } from "bun:test";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { getDbBusyTimeoutMs, setInteractiveHost, TempDir } from "@oh-my-pi/pi-utils";

it("classifies an interactive host before opening auth storage", async () => {
	const previous = setInteractiveHost(false);
	const stop = new Error("stop after auth classification");
	let observedTimeout: number | undefined;
	const parsed = parseArgs([]);
	parsed.noExtensions = true;

	try {
		await expect(
			runRootCommand(parsed, [], {
				discoverAuthStorage: async () => {
					observedTimeout = getDbBusyTimeoutMs();
					throw stop;
				},
			}),
		).rejects.toBe(stop);
	} finally {
		setInteractiveHost(previous);
	}

	expect(observedTimeout).toBe(5000);
});

it("standalone auth discovery routes by PI_CONFIG_FILES policy over main config", async () => {
	using tempDir = TempDir.createSync("@omp-standalone-policy-");
	const overlayPath = tempDir.join("policy.yml");
	await Bun.write(
		tempDir.join("config.yml"),
		"auth:\n  accountPolicies:\n    - provider: test-provider\n      unsupported: true\n",
	);
	await Bun.write(
		overlayPath,
		[
			"auth:",
			"  accountPolicies:",
			"    - provider: test-provider",
			"      account:",
			"        email: preferred@example.test",
			"      priority: 70",
			"retry:",
			"  usageReservePct: 17",
			"",
		].join("\n"),
	);
	const previousOverlay = process.env.PI_CONFIG_FILES;
	process.env.PI_CONFIG_FILES = overlayPath;
	resetSettingsForTest();
	try {
		const storage = await discoverAuthStorage(tempDir.path(), { cwd: tempDir.path() });
		try {
			await storage.credentials.set("test-provider", [
				{
					type: "oauth",
					access: "other-token",
					refresh: "other-refresh",
					expires: Date.now() + 3_600_000,
					email: "other@example.test",
				},
				{
					type: "oauth",
					access: "preferred-token",
					refresh: "preferred-refresh",
					expires: Date.now() + 3_600_000,
					email: "preferred@example.test",
				},
			]);
			expect(await storage.keys.get("test-provider", "standalone-policy-session")).toBe("preferred-token");
		} finally {
			storage.close();
		}
	} finally {
		if (previousOverlay === undefined) delete process.env.PI_CONFIG_FILES;
		else process.env.PI_CONFIG_FILES = previousOverlay;
		resetSettingsForTest();
	}
});
