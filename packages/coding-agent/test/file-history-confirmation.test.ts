import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileHistory } from "../src/session/file-history";
import { lookupBuiltinSlashCommand } from "../src/slash-commands/builtin-registry";
import type { TuiSlashCommandRuntime } from "../src/slash-commands/types";
import { PREVIEW_LIMITS, TRUNCATE_LENGTHS } from "../src/tools/render-utils";

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

test("redo previews intervening edits and cancellation preserves files, conversation and redo", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-redo-confirm-"));
	dirs.push(root);
	const cwd = path.join(root, "workspace");
	await fs.mkdir(cwd);
	const file = path.join(cwd, "a.txt");
	const history = new FileHistory(cwd, path.join(root, "history"), "redo");
	await history.command("on");
	await Bun.write(file, "before");
	await history.beginTurn({ leafId: "before", label: "edit" });
	await Bun.write(file, "after");
	let leaf: string | null = "after";
	const navigate = async (next: string | null) => {
		leaf = next;
	};
	await history.change(await history.points(), leaf, navigate, async () => true);
	await Bun.write(file, "external edit");
	let title = "";
	let accept = false;
	let rendered = 0;
	const runtime = {
		ctx: {
			session: {
				rewindFilesAndConversation: (_turn?: string, confirm?: (changes: string[]) => Promise<boolean>) =>
					history.change([], leaf, navigate, confirm ?? (async () => true)),
			},
			showHookSelector: async (text: string, choices: string[]) => {
				title = text;
				return choices[accept ? 0 : 1];
			},
			renderInitialMessages: async () => {
				rendered++;
			},
			reloadTodos: async () => {},
			editor: { setText: () => {} },
			showStatus: () => {},
		},
	} as unknown as TuiSlashCommandRuntime;
	const redo = lookupBuiltinSlashCommand("redo")!;
	await redo.handleTui!({ name: "redo", args: "", text: "/redo" }, runtime);
	expect(title).toContain("a.txt");
	expect(await Bun.file(file).text()).toBe("external edit");
	expect(leaf).toBe("before");
	expect(rendered).toBe(0);
	accept = true;
	await redo.handleTui!({ name: "redo", args: "", text: "/redo" }, runtime);
	expect(await Bun.file(file).text()).toBe("after");
	expect(leaf).toBe("after");
	expect(rendered).toBe(1);
});

test("restore confirmation bounds and sanitizes path previews including the home directory", async () => {
	let title = "";
	const changes = Array.from(
		{ length: PREVIEW_LIMITS.EXPANDED_LINES + 3 },
		(_, i) => `write: ${os.homedir()}/tab\tline\n\x1b[31m${i}-${"界".repeat(100)}.txt`,
	);
	const runtime = {
		ctx: {
			session: {
				rewindFilesAndConversation: async (
					_turn: string | undefined,
					confirm: (changes: string[]) => Promise<boolean>,
				) => confirm(changes),
			},
			showHookSelector: async (text: string) => {
				title = text;
				return "Cancel";
			},
		},
	} as unknown as TuiSlashCommandRuntime;
	const redo = lookupBuiltinSlashCommand("redo")!;
	await redo.handleTui!({ name: "redo", args: "", text: "/redo" }, runtime);
	expect(title).not.toContain(os.homedir());
	expect(title).not.toMatch(/[\t\x1b]/);
	const lines = title.split("\n");
	expect(lines).toHaveLength(PREVIEW_LIMITS.EXPANDED_LINES + 1);
	expect(lines[1]).toContain("~/");
	for (const line of lines.slice(1)) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(TRUNCATE_LENGTHS.CONTENT);
});
