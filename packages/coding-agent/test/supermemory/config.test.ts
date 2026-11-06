import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	isSupermemoryConfigured,
	loadSupermemoryConfig,
	resolveSupermemoryContainerTag,
} from "@oh-my-pi/pi-coding-agent/supermemory/config";
import { TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

const TOUCHED = ["SUPERMEMORY_API_KEY", "SUPERMEMORY_BASE_URL"] as const;
const saved = new Map(TOUCHED.map(name => [name, Bun.env[name]]));

beforeEach(() => {
	for (const name of TOUCHED) delete Bun.env[name];
});
afterEach(() => {
	for (const [name, value] of saved) {
		if (value === undefined) delete Bun.env[name];
		else Bun.env[name] = value;
	}
});

function configWith(env: Partial<Record<(typeof TOUCHED)[number], string>>, overrides: Record<string, unknown> = {}) {
	Object.assign(Bun.env, env);
	return loadSupermemoryConfig(Settings.isolated(overrides));
}

describe("loadSupermemoryConfig", () => {
	it("reads SUPERMEMORY_* environment variables over defaults, while a runtime override beats them", () => {
		const fromEnv = configWith({
			SUPERMEMORY_API_KEY: "sm-synthetic-env",
			SUPERMEMORY_BASE_URL: "http://127.0.0.1:1/",
		});
		expect(fromEnv.apiKey).toBe("sm-synthetic-env");
		expect(fromEnv.baseUrl).toBe("http://127.0.0.1:1");

		const overridden = configWith(
			{ SUPERMEMORY_API_KEY: "sm-synthetic-env" },
			{ "supermemory.apiKey": "sm-synthetic-override" },
		);
		expect(overridden.apiKey).toBe("sm-synthetic-override");
	});

	it("accepts https or loopback http base URLs only", () => {
		const accepted = ["https://api.example", "http://localhost:8080", "http://127.0.0.1:1", "http://[::1]:9"];
		for (const baseUrl of accepted) {
			expect(
				isSupermemoryConfigured(configWith({}, { "supermemory.apiKey": "k", "supermemory.baseUrl": baseUrl })),
			).toBe(true);
		}
		const rejected = [
			"http://api.example",
			"http://app.localhost",
			"ftp://localhost",
			"https://user:pass@api.example",
			"https://api.example/?token=x",
			"not a url",
		];
		for (const baseUrl of rejected) {
			const config = configWith({}, { "supermemory.apiKey": "k", "supermemory.baseUrl": baseUrl });
			expect(config.baseUrl).toBeNull();
			expect(isSupermemoryConfigured(config)).toBe(false);
		}
	});

	it("clamps numeric tuning into range", () => {
		const config = configWith(
			{},
			{ "supermemory.retainEveryNTurns": 0, "supermemory.recallLimit": 500, "supermemory.threshold": 2 },
		);
		expect([config.retainEveryNTurns, config.recallLimit, config.threshold]).toEqual([1, 50, 1]);
	});
});

describe("resolveSupermemoryContainerTag", () => {
	let dir: TempDir | undefined;
	afterEach(async () => {
		await dir?.remove();
		dir = undefined;
	});

	it("shares one opaque tag across a repo subdirectory and a linked worktree", async () => {
		dir = TempDir.createSync("@supermemory-tag-");
		const repo = path.join(dir.path(), "secret-project");
		await fs.mkdir(path.join(repo, "nested"), { recursive: true });
		await $`git init -q && git -c core.hooksPath=/dev/null -c user.email=t@t -c user.name=t commit -q --allow-empty -m init`
			.cwd(repo)
			.quiet();
		const worktree = path.join(dir.path(), "wt");
		await $`git -c core.hooksPath=/dev/null worktree add -q ${worktree}`.cwd(repo).quiet();

		const tag = resolveSupermemoryContainerTag(repo, "per-project");
		expect(tag).toMatch(/^omp-project-[0-9a-f]{24}$/);
		expect(resolveSupermemoryContainerTag(path.join(repo, "nested"), "per-project")).toBe(tag);
		expect(resolveSupermemoryContainerTag(worktree, "per-project")).toBe(tag);
		expect(tag).not.toContain("secret-project");
		expect(resolveSupermemoryContainerTag(dir.path(), "per-project")).not.toBe(tag);
		expect(resolveSupermemoryContainerTag(repo, "global")).toBe("omp-global");
	});
});
