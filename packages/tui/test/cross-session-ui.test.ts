import { beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createIrcMessageCard } from "../src/tools/wait";
import { buildIrcMessageCard } from "../src/chat/transcript-render-helpers";
import { PromptActionAutocompleteProvider } from "../src/prompt/prompt-action-autocomplete";
import { initTheme, theme } from "../src/theme";
import type { DescribeContext } from "../src/native/node";
import { ExtensionDashboard, type ExtensionDashboardRuntime } from "../src/overlays/extensions/extension-dashboard";

beforeAll(async () => {
	await initTheme(false);
});

describe("cross-session UI", () => {
	it("shows peer addresses under the dashboard header in ANSI and both native layouts", async () => {
		const runtime: ExtensionDashboardRuntime = {
			peerAddress: () => "pipe:omp-msg-test",
			getDisabledExtensions: () => [],
			setDisabledExtensions: () => {},
			getProviders: () => [],
			loadExtensions: async () => [],
			toggleProvider: () => true,
			toggleUserSource: () => true,
			persistMcpToggle: async () => {},
			applyMcpToggle: async () => {},
			subscribeMcpChanges: () => [],
		};
		const dashboard = await ExtensionDashboard.create({ runtime, terminalHeight: 30 });
		expect(Bun.stripANSI(dashboard.render(100)[1]!)).toContain("Peer address  pipe:omp-msg-test");
		const context: DescribeContext = {
			cols: 100,
			reduceMotion: true,
			dark: true,
			supports: () => true,
			feature: () => false,
		};
		const sheet = dashboard.describe(context);
		expect(sheet.k).toBe("picker");
		if (sheet.k !== "picker") throw new Error("Expected picker");
		expect(sheet.p?.subtitle).toBe("Peer address  pipe:omp-msg-test");
		const page = dashboard.describe({ ...context, supports: kind => kind !== "picker" });
		expect(JSON.stringify(page)).toContain("Peer address  pipe:omp-msg-test");
		const without = await ExtensionDashboard.create({
			runtime: { ...runtime, peerAddress: undefined },
			terminalHeight: 30,
		});
		expect(without.render(100).join("\n")).not.toContain("Peer address");
	});

	it("collapses remote IRC to one ellipsized line but expands the full markdown body", () => {
		let expanded = false;
		const body = "\nFirst line of a message\n\n**Second line**\nLast line";
		const card = createIrcMessageCard(
			{ kind: "incoming", from: "release notes", body, remote: true },
			() => expanded,
			theme,
		);
		expect(card.render(100).map(line => Bun.stripANSI(line).trim())).toEqual([
			"IRC ← @release notes: First line of a message",
		]);
		expect(card.render(30)).toHaveLength(1);
		expect(Bun.stripANSI(card.render(30)[0]!)).toContain("…");
		const node = card.describe!({
			cols: 100,
			reduceMotion: true,
			dark: true,
			supports: () => true,
			feature: () => false,
		});
		if (node?.k !== "card") throw new Error("Expected card");
		expect(node.p?.preview).toEqual({ lines: 0 });
		expanded = true;
		expect(Bun.stripANSI(card.render(100).join("\n"))).toContain("Last line");
		const transcript = buildIrcMessageCard(
			{
				role: "custom",
				customType: "irc:incoming",
				content: "model-only text",
				display: true,
				timestamp: 1,
				details: { from: "release notes", message: body, remote: true },
			},
			() => false,
		);
		expect(transcript.render(100)).toHaveLength(1);
	});

	it("preserves the local IRC preview and its expansion behavior", () => {
		let expanded = false;
		const card = createIrcMessageCard(
			{ kind: "incoming", from: "Worker", body: "one\ntwo\nthree\nfour" },
			() => expanded,
			theme,
		);
		const collapsed = Bun.stripANSI(card.render(100).join("\n"));
		expect(collapsed).toContain("IRC");
		expect(collapsed).toContain("Worker");
		expect(collapsed).toContain("three");
		expect(collapsed).toContain("… +1 more line");
		expanded = true;
		expect(Bun.stripANSI(card.render(100).join("\n"))).toContain("four");
	});

	it("appends sessions after file results and quotes a live session token without replacing surrounding prose", async () => {
		using dir = TempDir.createSync("@omp-session-mentions-");
		await Bun.write(path.join(dir.path(), "release.txt"), "release");
		const provider = new PromptActionAutocompleteProvider(
			[],
			dir.path(),
			[],
			undefined,
			undefined,
			undefined,
			async () => [
				{ name: "release notes", cwd: "/project" },
				{ name: 'release "draft"', cwd: "/draft" },
			],
		);
		const suggestions = await provider.getSuggestions(["tell @"], 0, 6);
		if (!suggestions) throw new Error("Expected file and session suggestions");
		const file = suggestions.items.findIndex(item => item.value.includes("release.txt"));
		const session = suggestions.items.findIndex(item => item.label === "@release notes");
		expect(file).toBeGreaterThanOrEqual(0);
		expect(session).toBeGreaterThan(file);
		expect(suggestions.items[session]?.description).toBe("session · /project");
		const applied = provider.applyCompletion(
			["tell @release and wait"],
			0,
			13,
			suggestions.items[session]!,
			suggestions.prefix,
		);
		expect(applied.lines).toEqual(['tell @"release notes"  and wait']);
		expect(applied.cursorCol).toBe('tell @"release notes" '.length);
		const quoted = suggestions.items.find(item => item.label === '@release "draft"')!;
		expect(provider.applyCompletion(["@"], 0, 1, quoted, "@").lines).toEqual(['@"release \\"draft\\"" ']);
	});
});
