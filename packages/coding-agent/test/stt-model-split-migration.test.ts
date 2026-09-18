import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { DEFAULT_CLOUD_STT_MODEL } from "@oh-my-pi/pi-coding-agent/stt/cloud-models";
import { DEFAULT_STT_MODEL_KEY } from "@oh-my-pi/pi-coding-agent/stt/models";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

// `stt.modelName` held two disjoint families (local tiers and OpenAI
// transcription ids) in one enum. Configs written by older builds must land on
// the family they belong to, leaving the other family at its default.
describe("stt.modelName → stt.localModel / stt.cloudModel migration", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@test-stt-model-split-");
		agentDir = path.join(tempDir.path(), "agent");
		projectDir = path.join(tempDir.path(), "project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
	});

	afterEach(async () => {
		AgentStorage.close();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		try {
			await tempDir.remove();
		} catch {}
	});

	async function loadWith(raw: Record<string, unknown>): Promise<Settings> {
		await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify(raw, null, 2));
		resetSettingsForTest();
		return Settings.init({ cwd: projectDir, agentDir });
	}

	it("routes a legacy local tier to stt.localModel", async () => {
		const settings = await loadWith({ stt: { backend: "local", modelName: "turbo" } });
		expect(settings.get("stt.localModel")).toBe("turbo");
		expect(settings.get("stt.cloudModel")).toBe(DEFAULT_CLOUD_STT_MODEL);
	});

	it("routes a legacy transcription id to stt.cloudModel and keeps the local fallback default", async () => {
		const settings = await loadWith({ stt: { backend: "cloud", modelName: "whisper-1" } });
		expect(settings.get("stt.cloudModel")).toBe("whisper-1");
		expect(settings.get("stt.localModel")).toBe(DEFAULT_STT_MODEL_KEY);
	});

	it("keeps an already-materialised target over the legacy value", async () => {
		const settings = await loadWith({ stt: { modelName: "fast", localModel: "balanced" } });
		expect(settings.get("stt.localModel")).toBe("balanced");
	});

	it("promotes a quoted-dotted target that coexists with the legacy key", async () => {
		// The flat spelling is authoritative over the legacy value, but normal
		// lookup only traverses the nested `stt` object: it has to be promoted,
		// not merely respected.
		const settings = await loadWith({ stt: { modelName: "fast" }, "stt.localModel": "balanced" });
		expect(settings.get("stt.localModel")).toBe("balanced");
	});

	it("migrates the flat quoted-dotted spelling too", async () => {
		const settings = await loadWith({ "stt.modelName": "gpt-transcribe" });
		expect(settings.get("stt.cloudModel")).toBe("gpt-transcribe");
	});

	it("drops the legacy key so the migrated config no longer carries it", async () => {
		const settings = await loadWith({ stt: { modelName: "turbo" } });
		settings.set("stt.localModel", "parakeet");
		await settings.flush();
		const persisted = YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text()) as {
			stt?: Record<string, unknown>;
		};
		expect(persisted.stt).toEqual({ localModel: "parakeet" });
	});
});
