import { afterEach, beforeEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { LspTool } from "@oh-my-pi/pi-coding-agent/lsp";
import { getOrCreateClient, sendRequest, shutdownAll } from "@oh-my-pi/pi-coding-agent/lsp/client";
import { configCache, getConfig } from "@oh-my-pi/pi-coding-agent/lsp/config";
import {
	type CodeAction,
	FileChangeType,
	type Location,
	type LocationLink,
	type WorkspaceEdit,
} from "@oh-my-pi/pi-coding-agent/lsp/types";
import { fileToUri } from "@oh-my-pi/pi-coding-agent/lsp/uri";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { LspParams } from "@oh-my-pi/pi-coding-agent/tools/details/lsp";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { FakeLspOptions } from "../fixtures/fake-lsp-server";

const EXT = ".lsp-checkout";
const FILE = `target${EXT}`;
const SOURCE = "def target():\n    return 1\nvalue = target()\n";
const FIXTURE = path.join(import.meta.dir, "..", "fixtures", "fake-lsp-server.ts");
const SERVER_NAME = "fake-checkout-lsp";
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

async function configureServer(initOptions: FakeLspOptions): Promise<void> {
	await Bun.write(
		path.join(cwd, "lsp.json"),
		JSON.stringify({
			servers: {
				[SERVER_NAME]: {
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
}

async function executeConfigured(params: LspParams): Promise<string> {
	const tool = new LspTool({ cwd, settings: Settings.isolated() } as ToolSession);
	const { content } = await tool.execute(params.action, { file: queriedFile, line: 1, symbol: "target", ...params });
	return content[0]?.type === "text" ? content[0].text : "";
}

async function execute(params: LspParams, initOptions: FakeLspOptions): Promise<string> {
	await configureServer(initOptions);
	return executeConfigured(params);
}

async function serverState() {
	const client = await getOrCreateClient(getConfig(cwd).servers[SERVER_NAME]!, cwd);
	return (await sendRequest(client, "test/state", {})) as {
		didOpen: Record<string, number>;
		didClose: string[];
		notifications: string[];
		workspaceFolders: string[];
		watchedFileChanges: unknown[];
		willRenameFiles: unknown[];
		didRenameFiles: unknown[];
	};
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

it.each([
	["definition", "definitionProvider", "textDocument/definition"],
	["type_definition", "typeDefinitionProvider", "textDocument/typeDefinition"],
	["implementation", "implementationProvider", "textDocument/implementation"],
] as const)("uses locations returned by %s as checkout evidence", async (action, capability, method) => {
	const { uri, range } = location(otherFile, 0, 0);
	const link: LocationLink = { targetUri: uri, targetRange: range, targetSelectionRange: range };
	const output = await execute({ action }, { capabilities: { [capability]: true }, responses: { [method]: [link] } });
	expect(output).toContain(`feature-only${EXT}:1:1`);
	expect(output).not.toContain("cannot load the checkout");
});

it.each(["only the queried file", "only the session checkout", "no files"] as const)(
	"keeps the checkout note when references cover %s",
	async scenario => {
		const result =
			scenario === "no files"
				? []
				: [location(scenario === "only the queried file" ? queriedFile : path.join(cwd, "src", FILE), 0, 4)];
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
			encoding === "changes"
				? { changes: { [uri]: edits } }
				: { documentChanges: [{ textDocument: { uri }, edits }] };
		const output = await execute(
			{ action: "rename", new_name: "renamed", apply: false },
			{ capabilities: { renameProvider: true }, responses: { "textDocument/rename": edit } },
		);
		expect(output).toContain(`feature-only${EXT}: 1 edit`);
		expect(output).not.toContain("cannot load the checkout");
	},
);

it.each([false, true])("uses available code-action edits as checkout evidence (apply: %s)", async apply => {
	const { uri, range } = location(otherFile, 0, 0);
	const action: CodeAction = {
		title: "Update the caller",
		kind: "quickfix",
		edit: { changes: { [uri]: [{ range, newText: "renamed" }] } },
	};
	const output = await execute(
		{ action: "code_actions", apply },
		{
			capabilities: { codeActionProvider: true },
			responses: {
				"textDocument/codeAction": [apply ? { title: action.title, kind: action.kind, data: 1 } : action],
				"codeAction/resolve": action,
			},
		},
	);
	expect(output).toContain(action.title);
	expect(output).not.toContain("cannot load the checkout");
	expect(await Bun.file(otherFile).text()).toBe(apply ? "renamed()\n" : "target()\n");
});

it("keeps the checkout note for code actions that only return commands", async () => {
	const output = await execute(
		{ action: "code_actions" },
		{
			capabilities: { codeActionProvider: true },
			responses: { "textDocument/codeAction": [{ title: "Run server command", command: "test.run" }] },
		},
	);
	expect(output).toContain("Run server command");
	expect(output).toContain("cannot load the checkout");
});

it("opens a file reached through a symlink inside a folder the server was told about", async () => {
	await execute(
		{ action: "references" },
		{
			capabilities: { referencesProvider: true, ...FOLDER_CHANGES },
			responses: { "textDocument/references": [] },
		},
	);
	const state = await serverState();
	expect(Object.keys(state.didOpen)).toEqual([fileToUri(path.join(checkout, "src", FILE))]);
	expect(state.workspaceFolders).toContain(fileToUri(checkout));
});

it.each([true, false])("keeps one document for an edit followed by references (folder changes: %s)", async folders => {
	await configureServer({
		capabilities: { referencesProvider: true, ...(folders ? FOLDER_CHANGES : {}) },
		responses: { "textDocument/references": [location(otherFile, 0, 0)] },
	});
	const getArtifactsDir = () => path.join(cwd, "artifacts");
	const getSessionId = () => "session-lsp-checkout";
	const edit = new EditTool(
		{
			cwd,
			hasUI: false,
			enableLsp: true,
			getArtifactsDir,
			getSessionId,
			getSessionFile: () => path.join(cwd, "session.jsonl"),
			getSessionSpawns: () => "*",
			localProtocolOptions: { getArtifactsDir, getSessionId },
			settings: Settings.isolated({ "lsp.diagnosticsOnEdit": true, "lsp.formatOnWrite": false }),
		} as ToolSession,
		"apply_patch",
	);
	const result = await edit.execute("edit", {
		input: `*** Begin Patch\n*** Update File: ${queriedFile}\n@@\n-    return 1\n+    return 2\n*** End Patch`,
	});
	expect(await Bun.file(queriedFile).text()).toBe(SOURCE.replace("return 1", "return 2"));
	expect(result.details?.diagnostics?.messages.join("\n")).toContain("fake");
	expect(await executeConfigured({ action: "references" })).toContain(`feature-only${EXT}:1:1`);

	const uri = fileToUri(path.join(checkout, "src", FILE));
	const state = await serverState();
	expect(state.didOpen).toEqual({ [uri]: 1 });
	expect(state.notifications).toContain("textDocument/didSave");
	expect(state.workspaceFolders).toEqual(folders ? [fileToUri(checkout)] : []);
	if (folders) expect(state.watchedFileChanges).toContainEqual({ uri, type: FileChangeType.Changed });
});

it.each(["file", "directory"] as const)("uses resolved rename URIs for a %s in a checkout alias", async kind => {
	const sourceName = kind === "directory" ? "nested" : FILE;
	const destName = kind === "directory" ? "moved" : `renamed${EXT}`;
	const leaf = kind === "directory" ? path.join("deep", FILE) : "";
	const source = path.join(path.dirname(queriedFile), sourceName);
	const opened = path.join(source, leaf);
	if (kind === "directory") await Bun.write(opened, SOURCE);

	await execute(
		{ action: "references", file: opened },
		{
			capabilities: { referencesProvider: true, ...FOLDER_CHANGES },
			responses: { "textDocument/references": [], "workspace/willRenameFiles": null },
		},
	);
	const output = await executeConfigured({ action: "rename_file", file: source, new_name: destName });
	expect(output).toContain("Renamed");

	const oldUri = fileToUri(path.join(checkout, "src", sourceName, leaf));
	const newPath = path.join(checkout, "src", destName, leaf);
	const rename = { files: [{ oldUri, newUri: fileToUri(newPath) }] };
	const state = await serverState();
	expect(state.willRenameFiles).toEqual([rename]);
	expect(state.didRenameFiles).toEqual([rename]);
	expect(state.didClose).toEqual([oldUri]);
	expect(await Bun.file(newPath).text()).toBe(SOURCE);
	expect(await Bun.file(opened).exists()).toBe(false);
});
