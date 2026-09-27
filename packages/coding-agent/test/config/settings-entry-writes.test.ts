import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type RawSettings, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { cfgRetryFallbackChains } from "@oh-my-pi/pi-coding-agent/session/settings";
import { cfgTaskDisabledAgents } from "@oh-my-pi/pi-coding-agent/task/settings";
import { acquireFileLock, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

// Editing one fallback chain or one agent must persist only that entry: every entry another layer
// (a `--config` overlay) supplies stays out of config.yml.
describe("Settings entry-level writes", () => {
	let state: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let cwd: string;
	let overlayPath: string;

	beforeEach(() => {
		state = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-settings-entries-");
		agentDir = tempDir.join("agent");
		cwd = tempDir.join("project");
		overlayPath = tempDir.join("overlay.yml");
		for (const dir of [agentDir, cwd]) fs.mkdirSync(dir, { recursive: true });
	});

	afterEach(() => {
		restoreSettingsTestState(state);
		state = undefined;
		AgentStorage.close();
		// SQLite keeps agent.db open until GC finalizes its statements; Windows cannot delete an open file.
		Bun.gc(true);
		tempDir.removeSync();
	});

	const configPath = () => path.join(agentDir, "config.yml");
	const readConfig = async (): Promise<RawSettings> => YAML.parse(await Bun.file(configPath()).text()) as RawSettings;

	async function load(config: RawSettings, overlay: RawSettings): Promise<Settings> {
		await Bun.write(configPath(), YAML.stringify(config));
		await Bun.write(overlayPath, YAML.stringify(overlay));
		return Settings.loadIsolated({ agentDir, cwd, configFiles: [overlayPath] });
	}

	it("persists one fallback chain without the chains a --config overlay supplies", async () => {
		const settings = await load({}, { retry: { fallbackChains: { smol: ["overlay/cheap"] } } });

		cfgRetryFallbackChains.setEntry(settings, "slow", ["user/slow-fallback"]);
		await settings.flush();

		expect(await readConfig()).toEqual({ retry: { fallbackChains: { slow: ["user/slow-fallback"] } } });
		expect(cfgRetryFallbackChains.get(settings)).toEqual({
			smol: ["overlay/cheap"],
			slow: ["user/slow-fallback"],
		});
	});

	it("addresses a dotted record key exactly, across an external edit, and deletes it on undefined", async () => {
		const settings = await load({ retry: { fallbackChains: { slow: ["user/slow"] } } }, {});

		cfgRetryFallbackChains.setEntry(settings, "openai/gpt-5.4", ["openai/gpt-5.4-mini"]);
		// Another process edits config.yml before the save merges this write into it.
		await Bun.write(
			configPath(),
			YAML.stringify({ temperature: 0.3, retry: { fallbackChains: { slow: ["user/slow"] } } }),
		);
		await settings.flush();
		expect(await readConfig()).toEqual({
			temperature: 0.3,
			retry: { fallbackChains: { slow: ["user/slow"], "openai/gpt-5.4": ["openai/gpt-5.4-mini"] } },
		});

		cfgRetryFallbackChains.setEntry(settings, "openai/gpt-5.4", undefined);
		await settings.flush();
		expect(await readConfig()).toEqual({ temperature: 0.3, retry: { fallbackChains: { slow: ["user/slow"] } } });
		expect(cfgRetryFallbackChains.get(settings)).toEqual({ slow: ["user/slow"] });
	});

	it("saves a whole-record write made while a save of one of its entries waits for the config lock", async () => {
		const settings = await load({ retry: { fallbackChains: { slow: ["old/slow"], smol: ["old/smol"] } } }, {});
		cfgRetryFallbackChains.setEntry(settings, "slow", ["intermediate/slow"]);

		const lock = await acquireFileLock(configPath());
		let entrySave: Promise<void> | undefined;
		try {
			// This save captures the entry write, then cannot read config.yml before the whole record is set.
			entrySave = settings.flush();
			cfgRetryFallbackChains.set(settings, { slow: ["final/slow"], smol: ["final/smol"] });
		} finally {
			lock.release();
		}
		await entrySave;
		await settings.flush();

		expect(await readConfig()).toEqual({
			retry: { fallbackChains: { slow: ["final/slow"], smol: ["final/smol"] } },
		});
	});

	it.each([
		{
			edited: "another setting",
			external: { temperature: 0.3, retry: { fallbackChains: { slow: ["old/slow"], smol: ["old/smol"] } } },
			saved: { temperature: 0.3, retry: { fallbackChains: { slow: ["final/slow"], smol: ["final/smol"] } } },
		},
		{
			edited: "an entry only the whole-record write sets",
			external: { retry: { fallbackChains: { slow: ["old/slow"], smol: ["external/smol"] } } },
			saved: { retry: { fallbackChains: { slow: ["final/slow"], smol: ["external/smol"] } } },
		},
	])(
		"merges an entry write and a later whole-record write with an external edit of $edited",
		async ({ external, saved }) => {
			const settings = await load({ retry: { fallbackChains: { slow: ["old/slow"], smol: ["old/smol"] } } }, {});

			cfgRetryFallbackChains.setEntry(settings, "slow", ["intermediate/slow"]);
			cfgRetryFallbackChains.set(settings, { slow: ["final/slow"], smol: ["final/smol"] });
			await Bun.write(configPath(), YAML.stringify(external));
			await settings.flush();

			expect(await readConfig()).toEqual(saved);
		},
	);

	it("writes an entry into a record malformed as a list, keeping the entries an overlay supplies", async () => {
		const settings = await load(
			{ retry: { fallbackChains: [] } },
			{ retry: { fallbackChains: { smol: ["overlay/cheap"] } } },
		);

		cfgRetryFallbackChains.setEntry(settings, "slow", ["user/slow"]);
		await settings.flush();

		expect(cfgRetryFallbackChains.get(settings)).toEqual({ smol: ["overlay/cheap"], slow: ["user/slow"] });
		expect(await readConfig()).toEqual({ retry: { fallbackChains: { slow: ["user/slow"] } } });
	});

	it("changes the persisted agent list by the toggled item only while an overlay supplies the list", async () => {
		const settings = await load({ task: { disabledAgents: ["reviewer"] } }, { task: { disabledAgents: ["scout"] } });

		cfgTaskDisabledAgents.setMember(settings, "dev", true);
		cfgTaskDisabledAgents.setMember(settings, "reviewer", false);
		await settings.flush();

		expect(await readConfig()).toEqual({ task: { disabledAgents: ["dev"] } });
	});
});
