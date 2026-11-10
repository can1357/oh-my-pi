import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { bindEffects } from "@oh-my-pi/pi-coding-agent/config/registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { resolveMarkdownLinkHrefs } from "@oh-my-pi/pi-coding-agent/internal-urls/hyperlink-targets";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { tryFileUri } from "@oh-my-pi/pi-tui/render/hyperlink";
import { applyLinkMapSetting } from "@oh-my-pi/pi-tui/render/link-map";
import { TempDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState } from "../helpers/settings-test-state";

afterEach(() => applyLinkMapSetting({}));

describe.skipIf(process.platform === "win32")("tui.linkMap", () => {
	it("follows the global config and never a project's settings", async () => {
		using dir = TempDir.createSync("@pi-link-map-scope-");
		const agentDir = dir.join("agent");
		const projectDir = dir.join("project");
		await Bun.write(path.join(agentDir, "config.yml"), "tui:\n  linkMap:\n    /mnt/projects: file:///Z:/\n");
		await Bun.write(
			path.join(projectDir, ".omp", "config.yml"),
			"tui:\n  linkMap:\n    /mnt/projects: https://attacker.example/\n    /srv: https://attacker.example/srv/\n",
		);
		const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		const release = bindEffects(settings);
		try {
			expect(tryFileUri("/mnt/projects/a.ts")).toBe("file:///Z:/a.ts");
			expect(tryFileUri("/srv/a.ts")).toBe("file:///srv/a.ts");
		} finally {
			release();
			settings.cancelPendingSaves();
			// The persisted instance opened agent storage under the temp dir removed below.
			AgentStorage.close();
		}
	});

	it("shows and saves the operator's map in the settings panel, never a project's entries", async () => {
		using dir = TempDir.createSync("@pi-link-map-editor-");
		const projectDir = dir.join("project");
		const overlay = dir.join("extra.yml");
		await Bun.write(overlay, "tui:\n  linkMap:\n    /work: file:///W:/\n");
		const projectConfig = path.join(projectDir, ".omp", "config.yml");
		const state = beginSettingsTest();
		try {
			const settings = await Settings.init({ cwd: projectDir, agentDir: dir.join("agent"), configFiles: [overlay] });
			const host = createSettingsHost();
			// The project's map appears while the panel is open, then the editor saves what it was shown plus one entry.
			await Bun.write(projectConfig, "tui:\n  linkMap:\n    /srv: https://attacker.example/srv/\n");
			await settings.reloadFromDisk();
			const shown = host.get("tui.linkMap");
			expect(shown).toEqual({ "/work": "file:///W:/" });
			host.set("tui.linkMap", Object.assign({}, shown, { "/mnt/projects": "file:///Z:/" }));
			expect(tryFileUri("/mnt/projects/a.ts")).toBe("file:///Z:/a.ts");
			expect(tryFileUri("/srv/a.ts")).toBe("file:///srv/a.ts");
		} finally {
			restoreSettingsTestState(state);
			AgentStorage.close();
		}
	});

	it("sends a resolved Markdown link to the mapped target with its fragment", async () => {
		using dir = TempDir.createSync("@pi-link-map-markdown-");
		await Bun.write(dir.join("guide.md"), "# Guide\n");
		applyLinkMapSetting({ [dir.path()]: "https://git.contoso.example/handbook/blob/main" });
		const href = `${dir.join("guide.md")}#L3`;
		const targets = await resolveMarkdownLinkHrefs([href]);
		expect(targets.get(href)).toBe("https://git.contoso.example/handbook/blob/main/guide.md#L3");
	});
});
