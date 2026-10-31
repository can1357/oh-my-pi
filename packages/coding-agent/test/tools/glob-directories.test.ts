import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { glob } from "@oh-my-pi/pi-natives";
import { Settings } from "../../src/config/settings";
import { InternalUrlFilesystem } from "../../src/internal-urls/url-filesystem";
import type { ToolSession } from "../../src/tools";
import { GlobTool } from "../../src/tools/glob";
import { parseFindPattern, resolveSearchBase } from "../../src/tools/path-utils";

describe("directory-only glob patterns", () => {
	let dir: string;
	let session: ToolSession;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "glob-directories-"));
		session = {
			cwd: dir,
			hasUI: false,
			settings: Settings.isolated({}),
			getSessionFile: () => null,
			getSessionSpawns: () => null,
		};
		await fs.mkdir(path.join(dir, "beta.8a", "nested"), { recursive: true });
		await fs.mkdir(path.join(dir, "beta.8b"));
		await Bun.write(path.join(dir, "beta.8file"), "not a directory");
		await Bun.write(path.join(dir, "beta.8a", "nested", "file.ts"), "export {};\n");
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("matches only directories for absolute, relative, and Windows-separated globs", async () => {
		const tool = new GlobTool(session);
		for (const pattern of [`${dir}/beta.8*/`, "./beta.8*/", ".\\beta.8*\\"]) {
			const result = await tool.execute("directory-pattern", { path: pattern, gitignore: false });
			expect(result.details?.files?.toSorted()).toEqual(["beta.8a/", "beta.8b/"]);
		}
	});

	it("keeps recursive directory patterns and no-slash file matching distinct", async () => {
		const tool = new GlobTool(session);
		const directories = await tool.execute("recursive-directories", { path: "**/", gitignore: false });
		expect(directories.details?.files?.toSorted()).toEqual(["beta.8a/", "beta.8a/nested/", "beta.8b/"]);
		const all = await tool.execute("files-and-directories", { path: "./beta.8*", gitignore: false });
		expect(all.details?.files?.toSorted()).toEqual(["beta.8a/", "beta.8b/", "beta.8file"]);
	});

	it("preserves directory filtering when merging multiple roots", async () => {
		const result = await new GlobTool(session).execute("multi-directory-pattern", {
			path: "./beta.8*/;./beta.8a/*/",
			gitignore: false,
		});
		expect(result.details?.files?.toSorted()).toEqual(["beta.8a/", "beta.8a/nested/", "beta.8b/"]);
	});

	it("normalizes home and drive patterns without changing slash-only roots", () => {
		const home = parseFindPattern("~/beta.8*/");
		expect(home).toEqual({ basePath: "~", globPattern: "beta.8*", hasGlob: true, directoryOnly: true });
		expect(resolveSearchBase(home.basePath, dir)).toBe(os.homedir());
		expect(parseFindPattern("C:\\work\\beta.8*\\")).toEqual({
			basePath: "C:/work",
			globPattern: "beta.8*",
			hasGlob: true,
			directoryOnly: true,
		});
		expect(parseFindPattern("/")).toEqual({ basePath: "/", globPattern: "**/*", hasGlob: false });
	});

	it("matches URL directories without interpreting a URL root as a pattern separator", async () => {
		const artifacts = path.join(dir, "artifacts");
		await fs.mkdir(path.join(artifacts, "local", "beta.8a"), { recursive: true });
		await Bun.write(path.join(artifacts, "local", "beta.8file"), "not a directory");
		const result = await new GlobTool({
			...session,
			getArtifactsDir: () => artifacts,
			getSessionId: () => "glob-directories",
		}).execute("url-directories", { path: "local://beta.8*/", gitignore: false });
		expect(result.details?.files).toEqual(["local://beta.8a/"]);
		expect(parseFindPattern("local://")).toEqual({ basePath: "local://", globPattern: "**/*", hasGlob: false });
	});

	it("passes directory-only filtering to delegated glob operations", async () => {
		const filesystem = new InternalUrlFilesystem({ context: { cwd: dir }, tier: "read" });
		const result = await new GlobTool(session, {
			operations: {
				exists: () => true,
				glob: async (pattern, cwd, options) => {
					const matches = await glob({
						pattern,
						path: cwd,
						recursive: false,
						fileType: options.fileType,
						hidden: options.hidden,
						gitignore: options.gitignore,
						filesystem: filesystem.shellFilesystem(),
					});
					return matches.matches.map(match => match.path);
				},
			},
		}).execute("delegated-directories", { path: "./beta.8*/" });
		expect(result.details?.files?.toSorted()).toEqual(["beta.8a/", "beta.8b/"]);
	});
});
