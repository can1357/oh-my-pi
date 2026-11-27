import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Judge, JudgmentRequest, JudgmentResult, Questions } from "@oh-my-pi/pi-ai";
import { tokenUsage } from "@oh-my-pi/pi-ai";
import { FileType, glob } from "@oh-my-pi/pi-natives";
import { InternalUrlFilesystem } from "../../src/internal-urls/url-filesystem";
import { runCascade } from "../../src/tools/jfind/cascade";
import { readText } from "../../src/tools/jfind/text";
import { listFiles, resolveSearchRoot } from "../../src/tools/jfind/tree";

describe("linked find candidates", () => {
	let dir: string;
	let scope: string;
	let filesystem: InternalUrlFilesystem;
	const source = "export function linkedSource() { return 1; }\n";

	beforeEach(async () => {
		dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jfind-linked-files-")));
		scope = path.join(dir, "scope");
		await fs.mkdir(scope);
		await Bun.write(path.join(dir, "target.ts"), source);
		await fs.utimes(path.join(dir, "target.ts"), 1_600_000_000, 1_600_000_000);
		await fs.symlink(path.join(dir, "target.ts"), path.join(scope, "source.ts"), "file");
		filesystem = new InternalUrlFilesystem({ context: { cwd: dir }, tier: "read" });
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("reports a filtered linked file's target size and mtime instead of missing metadata", async () => {
		for (const sortByMtime of [false, true]) {
			const result = await glob({
				path: scope,
				pattern: "*",
				fileType: FileType.File,
				gitignore: false,
				sortByMtime,
			});
			expect(result.matches).toEqual([
				{ path: "source.ts", fileType: FileType.File, size: Buffer.byteLength(source), mtime: 1_600_000_000_000 },
			]);
		}
	});

	it("lists and reads a nonempty linked file without constructing a judge, including a linked root", async () => {
		await fs.symlink(scope, path.join(dir, "linked-root"), "dir");
		for (const rootPath of [scope, path.join(dir, "linked-root")]) {
			const root = await resolveSearchRoot(filesystem, rootPath, dir);
			const entries = await listFiles(root, { filesystem: filesystem.shellFilesystem(), includeHidden: false });
			expect(entries).toEqual([{ path: path.join(rootPath, "source.ts"), rel: "source.ts", size: source.length }]);
			expect((await readText(filesystem, entries[0]!.path, 1000)).text).toBe(source);
		}
	});

	it("still excludes empty, dangling, hidden, credential, and binary linked entries", async () => {
		await Bun.write(path.join(dir, "empty.ts"), "");
		await fs.symlink(path.join(dir, "empty.ts"), path.join(scope, "empty.ts"), "file");
		await fs.symlink(path.join(dir, "absent.ts"), path.join(scope, "dangling.ts"), "file");
		for (const name of [".hidden.ts", ".env", "private.pem", "image.png"]) {
			await fs.symlink(path.join(dir, "target.ts"), path.join(scope, name), "file");
		}
		const entries = await listFiles(
			{ path: scope, type: "directory" },
			{ filesystem: filesystem.shellFilesystem(), includeHidden: false },
		);
		expect(entries.map(entry => entry.rel)).toEqual(["source.ts"]);
		const hidden = await listFiles(
			{ path: scope, type: "directory" },
			{ filesystem: filesystem.shellFilesystem(), includeHidden: true },
		);
		expect(hidden.map(entry => entry.rel)).toEqual([".hidden.ts", "source.ts"]);
	});

	it("admits the linked candidate to the fake judge and makes no requests for an empty candidate set", async () => {
		const judge = new AcceptingJudge();
		const result = await runCascade({
			root: { path: scope, type: "directory" },
			filesystem,
			query: "linked source",
			extraKeywords: [],
			judge,
			includeHidden: false,
		});
		expect(result.stats.listed).toBe(1);
		expect(result.hits.map(hit => hit.rel)).toEqual(["source.ts"]);
		expect(judge.requests).toBeGreaterThan(0);
		await fs.unlink(path.join(scope, "source.ts"));
		const emptyJudge = new AcceptingJudge();
		const empty = await runCascade({
			root: { path: scope, type: "directory" },
			filesystem,
			query: "linked source",
			extraKeywords: [],
			judge: emptyJudge,
			includeHidden: false,
		});
		expect(empty.stats.listed).toBe(0);
		expect(emptyJudge.requests).toBe(0);
	});
});

class AcceptingJudge implements Judge {
	readonly label = "accepting-fixture";
	requests = 0;

	async judge<Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
		this.requests++;
		const answers = Object.fromEntries(Object.keys(request.questions).map(key => [key, { type: "noul", noul: 0.9 }]));
		return {
			api: "typesafe",
			provider: "fake",
			model: "fake",
			answers: answers as JudgmentResult<Q>["answers"],
			usage: tokenUsage(100, 0, 0.001),
		};
	}
}
