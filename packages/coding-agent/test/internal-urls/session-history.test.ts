import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { InternalUrlFilesystem } from "@oh-my-pi/pi-coding-agent/internal-urls/url-filesystem";
import {
	CURRENT_SESSION_VERSION,
	type SessionEntry,
	type SessionHeader,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { sessionDirForCwd } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as dirs from "@oh-my-pi/pi-utils/dirs";
import { resourceText } from "../helpers/resource-text";

const browse = "history://session/browse";
const timestamp = "2026-07-01T00:00:00.000Z";

function user(id: string, parentId: string | null, content: string): SessionEntry {
	return { type: "message", id, parentId, timestamp, message: { role: "user", content, timestamp: 1 } };
}

describe("history://session/browse", () => {
	let temp: TempDir;
	let cwd: string;
	let root: string;
	let bucket: string;
	let router: InternalUrlRouter;

	beforeEach(async () => {
		temp = TempDir.createSync("@omp-session-history-");
		cwd = temp.join("repo");
		root = temp.join("sessions");
		await fs.mkdir(cwd, { recursive: true });
		spyOn(dirs, "getSessionsDir").mockReturnValue(root);
		bucket = sessionDirForCwd(cwd, root);
		router = InternalUrlRouter.instance();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		temp.removeSync();
	});

	async function save(
		file: string,
		id: string,
		entries: SessionEntry[],
		options: { project?: string; title?: string; updated?: number; origin?: SessionHeader["origin"] } = {},
	): Promise<string> {
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id,
			timestamp,
			cwd: options.project ?? cwd,
			title: options.title,
			origin: options.origin,
		};
		await Bun.write(file, `${[header, ...entries].map(entry => JSON.stringify(entry)).join("\n")}\n`);
		if (options.updated !== undefined) await fs.utimes(file, options.updated, options.updated);
		return file;
	}

	async function read(suffix = "", sessionId?: string): Promise<string> {
		return resourceText(await router.resolve(`${browse}${suffix}`, { cwd, sessionId }));
	}

	it("keeps projects separate even when their cwd paths encode to the same bucket", async () => {
		const projectA = temp.join("projects", "a-b");
		const projectB = temp.join("projects", "a", "b");
		await fs.mkdir(projectA, { recursive: true });
		await fs.mkdir(projectB, { recursive: true });
		cwd = projectA;
		bucket = sessionDirForCwd(cwd, root);
		await save(path.join(bucket, "one.jsonl"), "first-project", [user("a", null, "first private prompt")]);
		await save(
			path.join(sessionDirForCwd(projectB, root), "two.jsonl"),
			"second-project",
			[user("b", null, "second private prompt")],
			{ project: projectB },
		);
		const local = await read();
		expect(local).toContain("first-project");
		expect(local).not.toContain("second private prompt");
		await expect(read("/second-project")).rejects.toThrow("scope=all");
		expect(await read("?scope=all")).toContain("second-project");
		expect(await read("/second-project?scope=all")).toContain("second private prompt");
	});

	it("does not expose another client's session in either scope", async () => {
		await save(path.join(bucket, "browser.jsonl"), "browser-session", [user("b", null, "browser prompt")], {
			origin: "chrome",
		});
		for (const scope of ["", "?scope=all"]) {
			expect(await read(scope)).not.toContain("browser-session");
			await expect(read(`/browser-session${scope}`)).rejects.toThrow("Unknown session ID");
		}
	});

	it("finds an equivalent project path and hides duplicate copies of one ID", async () => {
		const alias = temp.join("alias");
		await fs.symlink(cwd, alias, "junction");
		const older = path.join(bucket, "older.jsonl");
		const newer = path.join(bucket, "replaced-filename.jsonl");
		await save(older, "alias-project", [user("old", null, "old copy")], { project: alias, updated: 1 });
		await save(newer, "alias-project", [user("new", null, "new copy")], { project: alias, updated: 2 });
		const index = await read("", "alias-project");
		expect(index.match(/\| `alias-project` \|/g)).toHaveLength(1);
		expect(index).toContain("new copy (current)");
		expect(await read("/ALIAS-PRO")).toContain("new copy");
		expect(await router.locate(`${browse}/alias-project`, { cwd })).toBe(newer);
		await expect(read("/replaced-filename")).rejects.toThrow("Unknown session ID");
	});

	it("lets a case-sensitive exact header ID win over an ambiguous prefix", async () => {
		await save(path.join(bucket, "a.jsonl"), "Case", [user("a", null, "exact header match")]);
		await save(path.join(bucket, "b.jsonl"), "Case-sibling", [user("b", null, "related candidate")]);
		expect(await read("/Case")).toContain("exact header match");
		await expect(read("/cAsE")).rejects.toThrow(/Ambiguous session ID prefix[\s\S]*Case-sibling[\s\S]*/);
		await expect(read("/Cas-sib")).rejects.toThrow(/Did you mean:[\s\S]*Case-sibling/);
	});

	it("filters metadata, preserves the query in page links, and reports an empty page past the end", async () => {
		const first = "first prompt | markup\r\nnot an index row";
		await save(path.join(bucket, "older.jsonl"), "older", [user("a", null, first)], { updated: 10 });
		await save(path.join(bucket, "newest.jsonl"), "newest", [user("b", null, "private body")], {
			title: "FIRST title",
			updated: 20,
		});
		await save(path.join(bucket, "other.jsonl"), "other", [user("c", null, "other body")], { updated: 30 });
		const page = await read("?scope=all&q=first&limit=1");
		expect(page).toContain("Showing 1–1 of 2");
		expect(page).toContain("`newest`");
		expect(page).not.toContain("`older`");
		const next = page.match(/Next page: `(history:\/\/session\/browse[^`]+)`/)?.[1];
		if (!next) throw new Error("Expected a next-page URL");
		const followup = resourceText(await router.resolve(next, { cwd }));
		expect(followup).toContain("`older` | first prompt \\| markup");
		expect(followup).not.toContain("not an index row");
		expect(followup).not.toContain("`other`");
		const pastEnd = await read("?q=first&offset=100");
		expect(pastEnd).toContain("2 matching");
		expect(pastEnd).not.toMatch(/Showing|Next page|`older`|`newest`/);
	});

	it("serves the rendered transcript and line selectors through the virtual filesystem", async () => {
		await save(path.join(bucket, "shell.jsonl"), "shell-fixture", [user("a", null, "shell-visible prompt")]);
		const filesystem = new InternalUrlFilesystem({ context: { cwd }, tier: "exec" });
		const decoder = new TextDecoder();
		const index = decoder.decode(await filesystem.readPrefix(`${browse}?q=shell-fixture:raw:1-8`, 4096));
		const transcript = decoder.decode(await filesystem.readPrefix(`${browse}/shell-f?full=1:raw:10-11`, 4096));
		expect(index).toContain("`shell-fixture`");
		expect(transcript.trim()).toBe("### user\nshell-visible prompt");
	});

	it.each([
		["/%2e%2e", /single ID/],
		["/nested%2Ffile", /single ID/],
		["/C%3A%5Cfile", /single ID/],
		["/%zz", /encoding/],
		["?limit=101", /Invalid limit/],
		["?offset=-1", /Invalid offset/],
		["?scope=unknown", /scope=project or scope=all/],
		["?scope=project&scope=all", /Repeated/],
		["/known?full=maybe", /full=0 or full=1/],
		["/known?q=text", /Unsupported/],
		["/known#heading", /fragments/],
	])("rejects an invalid selector or query (%s)", async (suffix, error) => {
		await expect(read(suffix)).rejects.toThrow(error);
	});

	it("reads the committed prefix of a live journal without repairing backups or changing the file", async () => {
		const file = await save(path.join(bucket, "live.jsonl"), "live", [user("a", null, "persisted turn")]);
		const backup = await save(path.join(bucket, "stranded.jsonl.123.bak"), "stranded", [user("b", null, "backup")]);
		await fs.appendFile(file, '{"type":"message","id":"unfinished');
		const contents = await Bun.file(file).text();
		expect(await read()).not.toContain("stranded");
		expect(await read("/live")).toContain("persisted turn");
		expect(await read("/live?full=1")).not.toContain("unfinished");
		expect(await Bun.file(file).text()).toBe(contents);
		expect((await fs.readdir(bucket)).sort()).toEqual([path.basename(file), path.basename(backup)].sort());
	});

	it("rejects a journal replaced by a different session between listing and reading", async () => {
		const file = await save(path.join(bucket, "reused.jsonl"), "original", [user("a", null, "original turn")]);
		const readText = FileSessionStorage.prototype.readText;
		spyOn(FileSessionStorage.prototype, "readText").mockImplementation(
			async function (this: FileSessionStorage, target) {
				if (target === file) await save(file, "replacement", [user("b", null, "replacement turn")]);
				return readText.call(this, target);
			},
		);
		await expect(read("/original?full=1")).rejects.toThrow("Session original is no longer available");
	});

	it("recovers text and entry boundaries before compaction and reset, without reading a sibling branch", async () => {
		const entries: SessionEntry[] = [
			user("root", null, "before compaction"),
			{
				type: "compaction",
				id: "compact",
				parentId: "root",
				timestamp,
				summary: "old summary",
				firstKeptEntryId: "kept",
				tokensBefore: 123,
			},
			user("kept", "compact", "kept before reset"),
			user("sibling", "kept", "abandoned branch text"),
			{ type: "reset_boundary", id: "reset", parentId: "kept", timestamp },
			user("current", "reset", "after reset"),
			{ ...user("late", "sibling", "late off-branch output"), activeLeafId: "current" },
		];
		await save(path.join(bucket, "branch.jsonl"), "branch", entries, { title: "Branch fixture" });
		const concise = await read("/branch");
		expect(concise).toContain("after reset");
		expect(concise).not.toMatch(/before (compaction|reset)|abandoned branch text/);
		const full = await read("/branch?full=1");
		expect(full).toContain("before compaction");
		expect(full).toContain("kept before reset");
		expect(full).toContain("after reset");
		expect(full).toContain("Entry compact · compaction");
		expect(full).toContain("Entry reset · reset_boundary");
		expect(full).not.toMatch(/abandoned branch text|late off-branch output/);
	});

	it("recovers original execution output and entries intentionally omitted from concise history", async () => {
		await save(path.join(bucket, "execution.jsonl"), "execution", [
			{
				type: "message",
				id: "shell",
				parentId: null,
				timestamp,
				message: {
					role: "bashExecution",
					command: "printf 'local probe'",
					output: "shell result beyond the command preview",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					excludeFromContext: true,
					timestamp: 1,
				},
			},
			{
				type: "custom_message",
				id: "custom",
				parentId: "shell",
				timestamp,
				customType: "fixture",
				content: "hidden extension note",
				display: false,
			},
			{
				type: "message",
				id: "files",
				parentId: "custom",
				timestamp,
				message: {
					role: "fileMention",
					files: [{ path: "fixture.txt", content: "saved file text" }],
					timestamp: 2,
				},
			},
			{
				type: "branch_summary",
				id: "summary",
				parentId: "files",
				timestamp,
				fromId: "shell",
				summary: "earlier branch summary",
			},
		]);
		const concise = await read("/execution");
		expect(concise).not.toMatch(/shell result|hidden extension note|saved file text/);
		const full = await read("/execution?full=1");
		expect(full).toContain("shell result beyond the command preview");
		expect(full).toContain("hidden extension note");
		expect(full).toContain("saved file text");
		expect(full).toContain("earlier branch summary");
	});
});
