import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { bindEffects } from "@oh-my-pi/pi-coding-agent/config/registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { resolveMarkdownLinkHrefs } from "@oh-my-pi/pi-coding-agent/internal-urls/hyperlink-targets";
import { cfgTuiLinkMap } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { resolveFileLink } from "@oh-my-pi/pi-tui/render/hyperlink";
import { applyLinkMapSetting } from "@oh-my-pi/pi-tui/render/link-map";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState } from "../helpers/settings-test-state";

afterEach(() => {
	vi.restoreAllMocks();
	applyLinkMapSetting({});
});

describe.skipIf(process.platform === "win32")("tui.linkMap", () => {
	it("follows the global config and never a project's settings", async () => {
		using dir = TempDir.createSync("@pi-link-map-scope-");
		const agentDir = dir.join("agent");
		const projectDir = dir.join("project");
		const projectConfig = path.join(projectDir, ".omp", "config.yml");
		await Bun.write(path.join(agentDir, "config.yml"), "tui:\n  linkMap:\n    /mnt/projects: file:///Z:/\n");
		await Bun.write(
			projectConfig,
			"tui:\n  linkMap:\n    /mnt/projects: https://attacker.example/\n    /srv: https://attacker.example/srv/\n",
		);
		const warn = vi.spyOn(logger, "warn");
		const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		const release = bindEffects(settings);
		try {
			expect(resolveFileLink({ path: "/mnt/projects/a.ts", kind: "file" })).toBe("file:///Z:/a.ts");
			expect(resolveFileLink({ path: "/srv/a.ts", kind: "file" })).toBe("file:///srv/a.ts");
			expect(cfgTuiLinkMap.get(settings)).toEqual({ "/mnt/projects": "file:///Z:/" });
			// The project's value is reported when it is dropped, once: a reload reads it again and stays quiet.
			await settings.reloadFromDisk();
			const dropped = warn.mock.calls.filter(([, context]) => context?.setting === cfgTuiLinkMap.id);
			expect(dropped.map(([, context]) => context?.source)).toEqual([projectConfig]);
		} finally {
			release();
			settings.cancelPendingSaves();
			// The persisted instance opened agent storage under the temp dir removed below.
			AgentStorage.close();
		}
	});

	it("applies an edit to a key the project also sets without a restart", async () => {
		using dir = TempDir.createSync("@pi-link-map-edit-");
		const agentDir = dir.join("agent");
		const projectDir = dir.join("project");
		await Bun.write(path.join(agentDir, "config.yml"), "tui:\n  linkMap:\n    /mnt/projects: file:///Z:/\n");
		await Bun.write(
			path.join(projectDir, ".omp", "config.yml"),
			"tui:\n  linkMap:\n    /mnt/projects: https://attacker.example/\n",
		);
		const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		const release = bindEffects(settings);
		try {
			cfgTuiLinkMap.setEntry(settings, "/mnt/projects", "file:///Y:/");
			expect(resolveFileLink({ path: "/mnt/projects/a.ts", kind: "file" })).toBe("file:///Y:/a.ts");
		} finally {
			release();
			settings.cancelPendingSaves();
			AgentStorage.close();
		}
	});

	it("shows the operator's map in the settings panel and saves only global entries, never a project's", async () => {
		using dir = TempDir.createSync("@pi-link-map-editor-");
		const agentDir = dir.join("agent");
		const projectDir = dir.join("project");
		const globalConfig = path.join(agentDir, "config.yml");
		const overlay = dir.join("extra.yml");
		await Bun.write(globalConfig, "tui:\n  linkMap:\n    /home: file:///H:/\n");
		await Bun.write(overlay, "tui:\n  linkMap:\n    /work: file:///W:/\n");
		const projectConfig = path.join(projectDir, ".omp", "config.yml");
		const state = beginSettingsTest();
		try {
			const settings = await Settings.init({ cwd: projectDir, agentDir, configFiles: [overlay] });
			const host = createSettingsHost();
			// The project's map appears while the panel is open.
			await Bun.write(projectConfig, "tui:\n  linkMap:\n    /srv: https://attacker.example/srv/\n");
			await settings.reloadFromDisk();
			expect(host.get("tui.linkMap")).toEqual({ "/home": "file:///H:/", "/work": "file:///W:/" });
			// The `--config` file's entry is marked as that layer's; the global one is the editor's to change.
			expect(host.shadowingLayer("tui.linkMap", "/work")).toBeDefined();
			expect(host.shadowingLayer("tui.linkMap", "/home")).toBeUndefined();

			host.setEntry("tui.linkMap", "/mnt/projects", "file:///Z:/");
			expect(resolveFileLink({ path: "/mnt/projects/a.ts", kind: "file" })).toBe("file:///Z:/a.ts");
			expect(resolveFileLink({ path: "/srv/a.ts", kind: "file" })).toBe("file:///srv/a.ts");
			// The global config gains that entry alone: the `--config` file's entry is not copied into it.
			await settings.flush();
			expect(YAML.parse(await Bun.file(globalConfig).text())).toEqual({
				tui: { linkMap: { "/home": "file:///H:/", "/mnt/projects": "file:///Z:/" } },
			});
		} finally {
			restoreSettingsTestState(state);
			AgentStorage.close();
		}
	});

	it("sends a resolved Markdown link to the mapped target with its fragment", async () => {
		using dir = TempDir.createSync("@pi-link-map-markdown-");
		await Bun.write(dir.join("guide.md"), "# Guide\n");
		await Bun.write(dir.join("src", "lib", "a.ts"), "");
		applyLinkMapSetting({
			[dir.path()]: "https://git.contoso.example/handbook/blob/main",
			[dir.join("src")]: "vscode://vscode-remote/ssh-remote+devbox/src",
		});
		const href = `${dir.join("guide.md")}#L3`;
		const folder = dir.join("src", "lib");
		const targets = await resolveMarkdownLinkHrefs([href, folder]);
		expect(targets.get(href)).toBe("https://git.contoso.example/handbook/blob/main/guide.md#L3");
		// A directory opens as a folder: VS Code would open a remote target ending in `:<line>` as a file.
		expect(targets.get(folder)).toBe("vscode://vscode-remote/ssh-remote+devbox/src/lib");
	});
});
