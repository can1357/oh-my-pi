import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { getProjectAgentDir, logger, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

import { cfgProvidersMaxInFlightRequests, cfgTemperature } from "@oh-my-pi/pi-coding-agent/session/settings";

describe("Settings config-file watching", () => {
	let state: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		state = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-settings-watch-");
		agentDir = tempDir.join("agent");
		projectDir = tempDir.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
	});

	afterEach(() => {
		restoreSettingsTestState(state);
		state = undefined;
		// Persisted instances open agent.db under tempDir; close it before the directory goes away.
		AgentStorage.close();
		tempDir.removeSync();
	});

	/** Editor-style atomic replace: write a sibling temp file, then rename it over config.yml. */
	const replaceConfig = async (content: string) => {
		const configPath = path.join(agentDir, "config.yml");
		const tempPath = `${configPath}.edit.tmp`;
		await Bun.write(tempPath, content);
		await fs.promises.rename(tempPath, configPath);
	};

	it("applies on-disk edits to watchers and keeps the last good values across malformed YAML", async () => {
		await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify({ temperature: 0.1 }));
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		settings.startWatching();
		expect(cfgTemperature.get(settings)).toBe(0.1);

		let notify: ((value: number) => void) | undefined;
		const nextChange = () => {
			const { promise, resolve } = Promise.withResolvers<number>();
			notify = resolve;
			return promise;
		};
		cfgTemperature.listen(settings, value => notify?.(value));

		const firstChange = nextChange();
		await replaceConfig(YAML.stringify({ temperature: 0.7 }));
		expect(await firstChange).toBe(0.7);

		const rejected = Promise.withResolvers<void>();
		vi.spyOn(logger, "warn").mockImplementation((message: string) => {
			if (message.includes("keeping last good config")) rejected.resolve();
		});
		await replaceConfig("temperature: [unterminated\n");
		await rejected.promise;
		expect(cfgTemperature.get(settings)).toBe(0.7);

		const recovered = nextChange();
		await replaceConfig(YAML.stringify({ temperature: 0.3 }));
		expect(await recovered).toBe(0.3);
	});

	it("keeps the last good values when an on-disk edit fails validation", async () => {
		await Bun.write(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ providers: { maxInFlightRequests: { openai: 2 } } }),
		);
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		settings.startWatching();

		const rejected = Promise.withResolvers<void>();
		vi.spyOn(logger, "warn").mockImplementation((message: string) => {
			if (message.includes("on-disk change is invalid")) rejected.resolve();
		});
		await replaceConfig(YAML.stringify({ providers: { maxInFlightRequests: { openai: 0 } } }));
		await rejected.promise;
		expect(cfgProvidersMaxInFlightRequests.get(settings)).toEqual({ openai: 2 });
	});
});
