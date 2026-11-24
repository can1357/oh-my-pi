import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { importExtensionModule } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import {
	installLegacyPiSpecifierShim,
	loadLegacyPiModule,
	PI_TUI_MIGRATION_DOC,
	PiTuiImportError,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

// End-to-end resolution proof for the upstream-root bridges: legacy extensions
// import the aliased package roots (`@earendil-works/pi-ai` etc.) and Bun's
// static named-export check fails the whole plugin on one missing symbol.
// pi-optchat imports `getCurrentSystemMessage` from the pi-ai root and
// `parseSkillBlock` from the pi-coding-agent root; each failed plugin
// validation before the respective shim bridge existed. pi-tui is gone: an
// extension importing it fails with an error naming the pi-tui migration. Fixtures here import through the public legacy
// specifiers — the same path `loadLegacyPiModule` gives real extensions.

installLegacyPiSpecifierShim();

const tempRoots: string[] = [];
afterAll(async () => {
	for (const dir of tempRoots) await removeWithRetries(dir);
});

async function writeFixtureExtension(source: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-legacy-upstream-bridges-"));
	tempRoots.push(dir);
	const entry = path.join(dir, "index.ts");
	await fs.writeFile(entry, source, "utf8");
	return entry;
}

describe("legacy aliased-scope roots resolve the upstream 1.1.0 bridges", () => {
	it("resolves getCurrentSystemMessage from the @earendil-works/pi-ai root and replays tool state", async () => {
		const entry = await writeFixtureExtension(
			[
				'import { getCurrentSystemMessage, getCurrentTools } from "@earendil-works/pi-ai";',
				"export const replayed = getCurrentSystemMessage([",
				'  { role: "system", content: "Base.", toolsAdded: [{ name: "read", description: "r", parameters: {} }], timestamp: 5 },',
				'  { role: "system", content: "More.", timestamp: 7 },',
				"]);",
				'export const tools = getCurrentTools([{ role: "system", toolsAdded: [{ name: "read", description: "r", parameters: {} }] }]);',
			].join("\n"),
		);
		const loaded = (await loadLegacyPiModule(entry)) as {
			replayed: { content: string; timestamp: number; toolsAdded?: { name: string }[] } | undefined;
			tools: { name: string }[];
		};
		expect(loaded.replayed?.content).toBe("Base.\n\nMore.");
		expect(loaded.replayed?.timestamp).toBe(5);
		expect(loaded.replayed?.toolsAdded?.map(t => t.name)).toEqual(["read"]);
		expect(loaded.tools.map(t => t.name)).toEqual(["read"]);
	});

	it("resolves parseSkillBlock from the @earendil-works/pi-coding-agent root", async () => {
		const entry = await writeFixtureExtension(
			[
				'import { parseSkillBlock } from "@earendil-works/pi-coding-agent";',
				'export const parsed = parseSkillBlock(\'<skill name="s" location="/l">\\nbody\\n</skill>\');',
				"export const miss = parseSkillBlock('no block here');",
			].join("\n"),
		);
		const loaded = (await loadLegacyPiModule(entry)) as {
			parsed: { name: string; content: string } | null;
			miss: null;
		};
		expect(loaded.parsed?.name).toBe("s");
		expect(loaded.parsed?.content).toBe("body");
		expect(loaded.miss).toBeNull();
	});

	it.each(["@mariozechner/pi-tui", "@earendil-works/pi-tui/components/editor"])(
		"rejects an import of %s with the pi-tui migration error",
		async specifier => {
			const entry = await writeFixtureExtension(
				`import { Text } from "${specifier}";\nexport const probe = Text;\n`,
			);
			const error = await loadLegacyPiModule(entry).then(
				() => undefined,
				(caught: unknown) => caught,
			);
			expect(error).toBeInstanceOf(PiTuiImportError);
			expect((error as PiTuiImportError).specifier).toBe(specifier);
			expect((error as Error).message).toContain("@oh-my-pi/pi-tui");
			expect((error as Error).message).toContain(PI_TUI_MIGRATION_DOC);
		},
	);

	it("rejects pi-tui reached through a relative module and a require()", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-legacy-pi-tui-"));
		tempRoots.push(dir);
		await fs.writeFile(path.join(dir, "index.ts"), 'export { probe } from "./ui";\n', "utf8");
		await fs.writeFile(path.join(dir, "ui.cjs"), 'exports.probe = require("@mariozechner/pi-tui").Text;\n', "utf8");
		await fs.writeFile(path.join(dir, "ui.ts"), 'export { probe } from "./ui.cjs";\n', "utf8");
		const error = await loadLegacyPiModule(path.join(dir, "index.ts")).then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(PiTuiImportError);
		expect((error as PiTuiImportError).importerPath).toEndWith("ui.cjs");
	});

	it("fails the extension load with the actionable message", async () => {
		const entry = await writeFixtureExtension(
			[
				'import { Container } from "@mariozechner/pi-tui";',
				"export default function extension() { return new Container(); }",
			].join("\n"),
		);
		const prepared = await importExtensionModule(entry, path.dirname(entry));
		expect(prepared.factory).toBeNull();
		expect(prepared.error).toStartWith("Failed to load extension: ");
		expect(prepared.error).toContain('imports "@mariozechner/pi-tui"');
		expect(prepared.error).toContain(PI_TUI_MIGRATION_DOC);
	});

	it("resolves @oh-my-pi/pi-tui to the host's copy so extension nodes share its runtime", async () => {
		const entry = await writeFixtureExtension(
			[
				'import { isUiNode, jsx } from "@oh-my-pi/pi-tui";',
				'export const node = jsx("text", { text: "x" });',
				"export { isUiNode };",
			].join("\n"),
		);
		const loaded = (await loadLegacyPiModule(entry)) as { node: unknown; isUiNode: (value: unknown) => boolean };
		const host = await import("@oh-my-pi/pi-tui");
		expect(host.isUiNode(loaded.node)).toBe(true);
		expect(loaded.isUiNode).toBe(host.isUiNode);
	});

	it("loads the helpers the old pi-tui carried from where they live now", async () => {
		const entry = await writeFixtureExtension(
			[
				'import { concreteThinkingLevel, toReasoningEffort } from "@oh-my-pi/pi-tui/thinking";',
				'import { fuzzyMatch } from "@oh-my-pi/pi-tui/fuzzy";',
				"export { concreteThinkingLevel, toReasoningEffort, fuzzyMatch };",
			].join("\n"),
		);
		const loaded = (await loadLegacyPiModule(entry)) as Record<string, unknown>;
		const levels = await import("@oh-my-pi/pi-coding-agent/thinking/levels");
		expect(loaded.concreteThinkingLevel).toBe(levels.concreteThinkingLevel);
		expect(loaded.toReasoningEffort).toBe(levels.toReasoningEffort);
		expect(typeof loaded.fuzzyMatch).toBe("function");
	});
});
