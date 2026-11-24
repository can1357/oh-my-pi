import { afterEach, beforeEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LspTool } from "@oh-my-pi/pi-coding-agent/lsp";
import { shutdownAll } from "@oh-my-pi/pi-coding-agent/lsp/client";
import { configCache } from "@oh-my-pi/pi-coding-agent/lsp/config";
import type { Location, WorkspaceEdit } from "@oh-my-pi/pi-coding-agent/lsp/types";
import { fileToUri } from "@oh-my-pi/pi-coding-agent/lsp/uri";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { LspParams } from "@oh-my-pi/pi-coding-agent/tools/details/lsp";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { FakeLspOptions } from "../fixtures/fake-lsp-server";

const EXT = ".lsp-checkout";
const FILE = `target${EXT}`;
const SOURCE = "def target():\n    return 1\nvalue = target()\n";
const FIXTURE = path.join(import.meta.dir, "..", "fixtures", "fake-lsp-server.ts");
const FOLDER_CHANGES = { workspace: { workspaceFolders: { supported: true, changeNotifications: true } } };

let dir: TempDir;
let cwd: string;
let checkout: string;
let queriedFile: string;
let otherFile: string;

beforeEach(async () => {
	dir = await TempDir.create("@omp-lsp-checkout-");
	const root = await fs.realpath(dir.path());
	cwd = path.join(root, "main");
	checkout = path.join(root, "feature");
	const alias = path.join(root, "feature-link");
	queriedFile = path.join(alias, "src", FILE);
	otherFile = path.join(checkout, "src", `feature-only${EXT}`);
	await fs.mkdir(path.join(cwd, ".git"), { recursive: true });
	await Bun.write(path.join(checkout, ".git"), "gitdir: ../main/.git/worktrees/feature\n");
	await Bun.write(path.join(cwd, "src", FILE), SOURCE);
	await Bun.write(path.join(cwd, "src", `main-only${EXT}`), "target()\n");
	await Bun.write(path.join(checkout, "src", FILE), SOURCE);
	await Bun.write(otherFile, "target()\n");
	// The checkout has a real root, but the server may echo the path it was asked to open.
	await fs.symlink(checkout, alias, "junction");
});

afterEach(async () => {
	await shutdownAll();
	configCache.delete(cwd);
	await dir.remove();
});

function location(file: string, line: number, character: number): Location {
	return {
		uri: fileToUri(file),
		range: { start: { line, character }, end: { line, character: character + "target".length } },
	};
}

async function execute(params: LspParams, initOptions: FakeLspOptions): Promise<string> {
	await Bun.write(
		path.join(cwd, "lsp.json"),
		JSON.stringify({
			servers: {
				"fake-checkout-lsp": {
					command: process.execPath,
					args: ["run", FIXTURE],
					fileTypes: [EXT],
					rootMarkers: ["lsp.json"],
					isLinter: true,
					initOptions,
				},
			},
		}),
	);
	const tool = new LspTool({ cwd, settings: Settings.isolated() } as ToolSession);
	const { content } = await tool.execute(params.action, { file: queriedFile, line: 1, symbol: "target", ...params });
	return content[0]?.type === "text" ? content[0].text : "";
}

function occurrenceWarning(output: string): string | undefined {
	return output.split("\n").find(line => line.startsWith("⚠") && line.includes("textual occurrence(s)"));
}

it("reports only unmatched textual occurrences in the queried checkout", async () => {
	const output = await execute(
		{ action: "references" },
		{
			capabilities: { referencesProvider: true, ...FOLDER_CHANGES },
			responses: { "textDocument/references": [location(queriedFile, 0, 4), location(queriedFile, 2, 8)] },
		},
	);
	expect(output).toContain(`${FILE}:1:5`);
	expect(output).toContain(`${FILE}:3:9`);
	const warning = occurrenceWarning(output);
	expect(warning).not.toContain(`${FILE}:`);
	expect(warning).toContain(`feature-only${EXT}:1`);
	expect(warning).not.toContain(`main-only${EXT}`);
});

it("reports occurrences from the queried checkout when no references are returned", async () => {
	const output = await execute(
		{ action: "references" },
		{
			capabilities: { referencesProvider: true, ...FOLDER_CHANGES },
			responses: { "textDocument/references": [] },
		},
	);
	expect(output).toContain("No references found");
	const warning = occurrenceWarning(output);
	expect(warning).toContain(`feature-only${EXT}:1`);
	expect(warning).not.toContain(`main-only${EXT}`);
});

it("reports rename leftovers only in the edited checkout", async () => {
	const { uri, range: declaration } = location(queriedFile, 0, 4);
	const { range: use } = location(queriedFile, 2, 8);
	const edit: WorkspaceEdit = {
		changes: {
			[uri]: [
				{ range: declaration, newText: "renamed" },
				{ range: use, newText: "renamed" },
			],
		},
	};
	const output = await execute(
		{ action: "rename", new_name: "renamed" },
		{ capabilities: { renameProvider: true, ...FOLDER_CHANGES }, responses: { "textDocument/rename": edit } },
	);
	expect(await Bun.file(queriedFile).text()).toBe("def renamed():\n    return 1\nvalue = renamed()\n");
	const warning = occurrenceWarning(output);
	expect(warning).toContain(`feature-only${EXT}:1`);
	expect(warning).not.toContain(`${FILE}:`);
	expect(warning).not.toContain(`main-only${EXT}`);
});

it("does not warn that the checkout is unloaded when references include another file in it", async () => {
	const output = await execute(
		{ action: "references" },
		{
			capabilities: { referencesProvider: true },
			responses: { "textDocument/references": [location(queriedFile, 0, 4), location(otherFile, 0, 0)] },
		},
	);
	expect(output).toContain(`feature-only${EXT}:1:1`);
	expect(output).not.toContain("cannot load the checkout");
});

it.each(["only the queried file", "only the session checkout", "no files"] as const)(
	"keeps the checkout note when references cover %s",
	async scenario => {
		const result =
			scenario === "no files"
				? []
				: [location(path.join(scenario === "only the queried file" ? checkout : cwd, "src", FILE), 0, 4)];
		const output = await execute(
			{ action: "references" },
			{ capabilities: { referencesProvider: true }, responses: { "textDocument/references": result } },
		);
		expect(output).toContain(result.length === 0 ? "No references found" : `${FILE}:1:5`);
		expect(output).toContain("cannot load the checkout");
	},
);

it.each(["changes", "documentChanges"] as const)(
	"uses cross-file rename edits in %s as evidence that the checkout is loaded",
	async encoding => {
		const { uri, range } = location(otherFile, 0, 0);
		const edits = [{ range, newText: "renamed" }];
		const edit: WorkspaceEdit =
			encoding === "changes" ? { changes: { [uri]: edits } } : { documentChanges: [{ textDocument: { uri }, edits }] };
		const output = await execute(
			{ action: "rename", new_name: "renamed", apply: false },
			{ capabilities: { renameProvider: true }, responses: { "textDocument/rename": edit } },
		);
		expect(output).toContain(`feature-only${EXT}: 1 edit`);
		expect(output).not.toContain("cannot load the checkout");
	},
);
