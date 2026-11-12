import { describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";
import { cfgHotReload, HotReloadCoordinator, type HotReloadSubsystem } from "../../src/session/hot-reload";

describe("cfgHotReload unified settings", () => {
	it("resolves defaults with mcpConfig, mcpServers, and binary enabled and tools/skills/extensions disabled", () => {
		const settings = Settings.isolated({});
		expect(cfgHotReload.get(settings)).toEqual({
			enabled: true,
			tools: false,
			skills: false,
			extensions: false,
			mcpConfig: true,
			mcpServers: true,
			binary: true,
		});
	});

	it("activates tools, skills, and extensions via unified hotReload.* keys", () => {
		const settings = Settings.isolated({
			"hotReload.tools": true,
			"hotReload.skills": true,
			"hotReload.extensions": true,
			"hotReload.mcpConfig": false,
			"hotReload.mcpServers": false,
			"hotReload.binary": false,
		});
		expect(cfgHotReload.get(settings)).toEqual({
			enabled: true,
			tools: true,
			skills: true,
			extensions: true,
			mcpConfig: false,
			mcpServers: false,
			binary: false,
		});
	});

	it("turns off every subsystem when hotReload.enabled is false", () => {
		const settings = Settings.isolated({
			"hotReload.enabled": false,
			"hotReload.tools": true,
			"hotReload.skills": true,
			"hotReload.extensions": true,
			"hotReload.mcpConfig": true,
			"hotReload.mcpServers": true,
			"hotReload.binary": true,
		});
		expect(cfgHotReload.get(settings)).toEqual({
			enabled: false,
			tools: false,
			skills: false,
			extensions: false,
			mcpConfig: false,
			mcpServers: false,
			binary: false,
		});
	});
});

describe("HotReloadCoordinator", () => {
	it("polls registered subsystems, deduplicates deferral notices by group, and flushes on idle", async () => {
		let busy = false;
		let idleListeners: Array<() => void> = [];
		const notices: Array<{ level: string; message: string; source?: string }> = [];
		let alphaVersion = "v1";
		let betaVersion = "v1";
		const events: string[] = [];

		const alpha: HotReloadSubsystem<string> = {
			id: "alpha",
			source: "plugins",
			deferralGroup: "plugins-group",
			deferredMessage: "plugins changed; reload deferred until the current turn ends",
			signature: async () => alphaVersion,
			reload: async () => {
				events.push(`alpha:${alphaVersion}`);
				return `alpha updated to ${alphaVersion}`;
			},
			describe: summary => ({ level: "info", message: summary }),
		};

		const beta: HotReloadSubsystem = {
			id: "beta",
			source: "plugins",
			deferralGroup: "plugins-group",
			deferredMessage: "plugins changed; reload deferred until the current turn ends",
			signature: async () => betaVersion,
			reload: async () => {
				events.push(`beta:${betaVersion}`);
			},
		};

		const coordinator = new HotReloadCoordinator({
			subsystems: [alpha],
			isBusy: () => busy,
			onIdle: listener => {
				idleListeners.push(listener);
				return () => {
					idleListeners = idleListeners.filter(item => item !== listener);
				};
			},
			notify: (level, message, source) => {
				notices.push({ level, message, source });
			},
			pollIntervalMs: 3_600_000,
		});

		const unregisterBeta = coordinator.register(beta);
		expect(coordinator.subsystemIds).toEqual(["alpha", "beta"]);

		await coordinator.start();
		await coordinator.poll();
		expect(events).toEqual([]);

		// Both subsystems change while busy: shared deferralGroup announces only once.
		busy = true;
		alphaVersion = "v2";
		betaVersion = "v2";
		await coordinator.poll();
		expect(events).toEqual([]);
		expect(notices).toEqual([
			{
				level: "info",
				message: "plugins changed; reload deferred until the current turn ends",
				source: "plugins",
			},
		]);

		// Settle idle: both subsystems flush in registration order.
		busy = false;
		for (const listener of idleListeners) listener();
		await coordinator.poll();

		expect(events).toEqual(["alpha:v2", "beta:v2"]);
		expect(notices).toEqual([
			{
				level: "info",
				message: "plugins changed; reload deferred until the current turn ends",
				source: "plugins",
			},
			{
				level: "info",
				message: "alpha updated to v2",
				source: "plugins",
			},
		]);

		unregisterBeta();
		expect(coordinator.subsystemIds).toEqual(["alpha"]);
		coordinator.stop();
	});

	it("supports dynamic enable/disable via sync() and on-demand reloadNow()", async () => {
		let enabled = false;
		let sig = "1";
		let reloads = 0;

		const coordinator = new HotReloadCoordinator({
			subsystems: [
				{
					id: "custom",
					enabled: () => enabled,
					signature: async () => sig,
					reload: async () => {
						reloads++;
					},
				},
			],
			isBusy: () => false,
			onIdle: () => () => {},
			notify: () => {},
			pollIntervalMs: 3_600_000,
		});

		await coordinator.sync();
		sig = "2";
		await coordinator.poll();
		expect(reloads).toBe(0);

		enabled = true;
		await coordinator.sync();
		await coordinator.poll();
		expect(reloads).toBe(0);

		sig = "3";
		await coordinator.poll();
		expect(reloads).toBe(1);

		await coordinator.reloadNow(["custom"]);
		expect(reloads).toBe(2);
		coordinator.stop();
	});
});
