import { beforeAll, describe, expect, test } from "bun:test";
import type { ToolInfo } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ExtensionList } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/extension-list";
import { liveToolsForExtension } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/inspector-model";
import { InspectorPanel } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/inspector-panel";
import {
	type LiveToolSessionLookup,
	listLiveToolRecords,
	liveToolRecordFromSession,
	snapshotToolRuntimeSource,
} from "@oh-my-pi/pi-coding-agent/modes/components/extensions/live-tool-session";
import type { Extension } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/types";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

function info(
	name: string,
	source: "builtin" | "mcp" | "sdk" | "extension",
	path: string,
	parameters: unknown = { type: "object", properties: { q: { type: "string" } } },
): ToolInfo {
	return {
		name,
		description: `${name} desc`,
		parameters: parameters as ToolInfo["parameters"],
		sourceInfo: { path, source, scope: "temporary", origin: "top-level" },
	};
}

type FixtureTool = {
	name: string;
	label?: string;
	description?: string;
	parameters?: unknown;
	hidden?: boolean;
	loadMode?: "essential" | "discoverable";
};

function tool(name: string, overrides: Partial<FixtureTool> = {}): FixtureTool {
	return {
		name,
		label: overrides.label ?? `${name} label`,
		description: overrides.description ?? `${name} desc`,
		parameters: overrides.parameters ?? { type: "object", properties: { q: { type: "string" } } },
		hidden: overrides.hidden,
		loadMode: overrides.loadMode,
	};
}

function fakeSession(infos: ToolInfo[], tools: FixtureTool[]): LiveToolSessionLookup & { snapshotCalls: number } {
	const byName = new Map(tools.map(entry => [entry.name, entry]));
	let snapshotCalls = 0;
	return {
		get snapshotCalls() {
			return snapshotCalls;
		},
		getToolByName(name) {
			return byName.get(name);
		},
		getAllToolInfos() {
			snapshotCalls += 1;
			return infos;
		},
	};
}

beforeAll(async () => {
	await initTheme(false);
});

describe("listLiveToolRecords snapshot", () => {
	test("lists every tool from one getAllToolInfos call", () => {
		const gitPath = "/tmp/tools/git.ts";
		const commitPath = "/tmp/tools/git_commit.ts";
		const systemdPath = "/tmp/tools/systemd.ts";
		const infos = [
			info("read", "builtin", "<builtin:read>"),
			info("mcp_ping", "mcp", "<mcp:mcp_ping>"),
			info("sdk_host", "sdk", "<sdk:sdk_host>"),
			info("git", "extension", gitPath),
			info("git_commit", "extension", commitPath),
			info("systemd_inspect", "extension", systemdPath),
			info("systemd_control", "extension", systemdPath),
			info("orphan", "extension", "/tmp/tools/orphan.ts"),
		];
		const tools = [
			tool("read"),
			tool("mcp_ping"),
			tool("sdk_host"),
			tool("git", { parameters: { type: "object", properties: { path: { type: "string" } } } }),
			tool("git_commit"),
			tool("systemd_inspect", { hidden: true, loadMode: "discoverable" }),
			tool("systemd_control", { loadMode: "essential" }),
			// orphan is in ToolInfo but not registered
		];
		const session = fakeSession(infos, tools);

		const listed = listLiveToolRecords(session);
		expect(session.snapshotCalls).toBe(1);
		expect(listed.map(entry => entry.name)).toEqual([
			"read",
			"mcp_ping",
			"sdk_host",
			"git",
			"git_commit",
			"systemd_inspect",
			"systemd_control",
		]);
		expect(listed.find(entry => entry.name === "git")?.sourcePath).toBe(gitPath);
		expect(listed.find(entry => entry.name === "git_commit")?.sourcePath).toBe(commitPath);
		expect(listed.find(entry => entry.name === "systemd_inspect")?.sourcePath).toBe(systemdPath);
		expect(listed.find(entry => entry.name === "systemd_control")?.sourcePath).toBe(systemdPath);
		expect(listed.find(entry => entry.name === "read")?.source).toBe("builtin");
		expect(listed.find(entry => entry.name === "mcp_ping")?.source).toBe("mcp");
		expect(listed.find(entry => entry.name === "sdk_host")?.source).toBe("sdk");
		expect(listed.find(entry => entry.name === "git")?.source).toBe("extension");
		expect(listed.find(entry => entry.name === "read")?.sourcePath).toBeUndefined();
		expect(listed.find(entry => entry.name === "git")?.parameters).toEqual({
			type: "object",
			properties: { path: { type: "string" } },
		});
		expect(listed.find(entry => entry.name === "systemd_inspect")?.hidden).toBe(true);
		expect(listed.find(entry => entry.name === "systemd_inspect")?.loadMode).toBe("discoverable");
		expect(listed.find(entry => entry.name === "systemd_control")?.loadMode).toBe("essential");

		const gitRow: Extension = {
			id: "tool:git",
			kind: "tool",
			name: "git",
			displayName: "git",
			path: gitPath,
			source: { provider: "native", providerName: "OMP", level: "user" },
			state: "active",
			raw: { name: "git", path: gitPath },
		};
		const systemdRow: Extension = {
			...gitRow,
			id: "tool:systemd",
			name: "systemd",
			displayName: "systemd",
			path: systemdPath,
			raw: { name: "systemd", path: systemdPath },
		};
		const builtinShadow: Extension = {
			...gitRow,
			id: "tool:read",
			name: "read",
			displayName: "read",
			path: "/tmp/tools/read.ts",
			raw: { name: "read", path: "/tmp/tools/read.ts" },
		};

		const toolSource = {
			getLiveTool: (name: string) => listed.find(entry => entry.name === name),
			listLiveTools: () => listed,
		};
		expect(liveToolsForExtension(gitRow, toolSource).map(entry => entry.name)).toEqual(["git"]);
		expect(liveToolsForExtension(systemdRow, toolSource).map(entry => entry.name)).toEqual([
			"systemd_inspect",
			"systemd_control",
		]);
		expect(liveToolsForExtension(builtinShadow, toolSource)).toEqual([]);

		liveToolRecordFromSession(session, "git");
		expect(session.snapshotCalls).toBe(2);
	});

	test("joins factory siblings on a UNC source path", () => {
		const unc = "\\\\server\\share\\.omp\\tools\\systemd.ts";
		const infos = [info("systemd_inspect", "extension", unc), info("systemd_control", "extension", unc)];
		const session = fakeSession(infos, [tool("systemd_inspect"), tool("systemd_control")]);
		const listed = listLiveToolRecords(session);
		expect(listed.every(entry => entry.sourcePath === unc)).toBe(true);
		const row: Extension = {
			id: "tool:systemd",
			kind: "tool",
			name: "systemd",
			displayName: "systemd",
			path: unc,
			source: { provider: "native", providerName: "OMP", level: "user" },
			state: "active",
			raw: { name: "systemd", path: unc },
		};
		const toolSource = {
			getLiveTool: (name: string) => listed.find(entry => entry.name === name),
			listLiveTools: () => listed,
		};
		expect(liveToolsForExtension(row, toolSource).map(entry => entry.name)).toEqual([
			"systemd_inspect",
			"systemd_control",
		]);
	});

	test("one listLiveTools call for many rows and the inspector", () => {
		const systemdPath = "/tmp/tools/systemd.ts";
		const gitPath = "/tmp/tools/git.ts";
		const infos = [
			info("git", "extension", gitPath),
			info("systemd_inspect", "extension", systemdPath),
			info("systemd_control", "extension", systemdPath),
		];
		const session = fakeSession(infos, [tool("git"), tool("systemd_inspect"), tool("systemd_control")]);
		const production = {
			getLiveTool: (name: string) => liveToolRecordFromSession(session, name),
			listLiveTools: () => listLiveToolRecords(session),
		};
		let listCalls = 0;
		const counting = {
			getLiveTool: (name: string) => production.getLiveTool(name),
			listLiveTools: () => {
				listCalls += 1;
				return production.listLiveTools();
			},
		};
		const frame = snapshotToolRuntimeSource(counting);
		const rows: Extension[] = [
			{
				id: "tool:git",
				kind: "tool",
				name: "git",
				displayName: "git",
				path: gitPath,
				source: { provider: "native", providerName: "OMP", level: "user" },
				state: "active",
				raw: { name: "git", path: gitPath },
			},
			{
				id: "tool:systemd",
				kind: "tool",
				name: "systemd",
				displayName: "systemd",
				path: systemdPath,
				source: { provider: "native", providerName: "OMP", level: "user" },
				state: "active",
				raw: { name: "systemd", path: systemdPath },
			},
		];
		const list = new ExtensionList(rows, { toolSource: frame });
		list.render(80);
		const panel = new InspectorPanel();
		panel.setToolSource(frame);
		panel.setExtension(rows[1]!);
		panel.render(72);
		expect(listCalls).toBe(1);
		expect(session.snapshotCalls).toBe(1);
		expect(liveToolsForExtension(rows[0]!, frame).map(entry => entry.name)).toEqual(["git"]);
		expect(liveToolsForExtension(rows[1]!, frame).map(entry => entry.name)).toEqual([
			"systemd_inspect",
			"systemd_control",
		]);
	});
});
