import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	isSupermemoryConfigured,
	loadSupermemoryConfig,
	resolveSupermemoryNamespace,
} from "@oh-my-pi/pi-coding-agent/supermemory/config";
import { TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

const TOUCHED = ["SUPERMEMORY_API_KEY", "SUPERMEMORY_BASE_URL", "SUPERMEMORY_NAMESPACE"] as const;
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
	it("reads the API key and origin from SUPERMEMORY_* only, defaulting the origin", () => {
		const fromEnv = configWith({
			SUPERMEMORY_API_KEY: " sm-synthetic-env ",
			SUPERMEMORY_BASE_URL: "http://127.0.0.1:1/",
		});
		expect(fromEnv.apiKey).toBe("sm-synthetic-env");
		expect(fromEnv.baseUrl).toBe("http://127.0.0.1:1");

		for (const name of TOUCHED) delete Bun.env[name];
		const unset = configWith({});
		expect(unset.apiKey).toBeNull();
		expect(unset.baseUrl).toBe("https://api.supermemory.ai");
		expect(isSupermemoryConfigured(unset)).toBe(false);
	});

	it("accepts https or loopback http base URLs only", () => {
		const accepted = ["https://api.example", "http://localhost:8080", "http://127.0.0.1:1", "http://[::1]:9"];
		for (const baseUrl of accepted) {
			expect(isSupermemoryConfigured(configWith({ SUPERMEMORY_API_KEY: "k", SUPERMEMORY_BASE_URL: baseUrl }))).toBe(
				true,
			);
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
			const config = configWith({ SUPERMEMORY_API_KEY: "k", SUPERMEMORY_BASE_URL: baseUrl });
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

	it("SUPERMEMORY_NAMESPACE overrides scoping when valid and leaves Supermemory unconfigured when not", () => {
		const valid = configWith(
			{ SUPERMEMORY_API_KEY: "k", SUPERMEMORY_NAMESPACE: "team_a:notes-1" },
			{ "supermemory.scoping": "global" },
		);
		if (!isSupermemoryConfigured(valid)) throw new Error("expected a configured Supermemory");
		expect(resolveSupermemoryNamespace("/tmp", valid)).toBe("team_a:notes-1");

		for (const namespace of ["a/b", "has space", "x".repeat(101), "a%2Fb"]) {
			const config = configWith({ SUPERMEMORY_API_KEY: "k", SUPERMEMORY_NAMESPACE: namespace });
			expect(config.namespace).toBeNull();
			expect(isSupermemoryConfigured(config)).toBe(false);
		}
	});

	it("ignores connection overrides from the project's dotenv files, but honours the user's own", async () => {
		using temp = TempDir.createSync("@sm-dotenv-");
		const agentDir = path.join(temp.path(), "agent");
		await fs.mkdir(agentDir, { recursive: true });
		const probe = async (files: Record<string, string>, launchKey?: string) => {
			const project = await fs.mkdtemp(path.join(temp.path(), "project-"));
			for (const [name, content] of Object.entries(files)) {
				await Bun.write(
					name.startsWith("agent:") ? path.join(agentDir, name.slice(6)) : path.join(project, name),
					content,
				);
			}
			const script = path.join(project, "probe.ts");
			await Bun.write(
				script,
				[
					`import { Settings } from ${JSON.stringify(path.join(import.meta.dir, "../../src/config/settings.ts"))};`,
					`import { loadSupermemoryConfig } from ${JSON.stringify(path.join(import.meta.dir, "../../src/supermemory/config.ts"))};`,
					"const { apiKey, baseUrl, namespace } = loadSupermemoryConfig(Settings.isolated({}));",
					"process.stdout.write(JSON.stringify({ apiKey, baseUrl, namespace }));",
				].join("\n"),
			);
			const env: Record<string, string> = {
				PATH: Bun.env.PATH ?? "",
				HOME: temp.path(),
				PI_CODING_AGENT_DIR: agentDir,
			};
			if (launchKey) env.SUPERMEMORY_API_KEY = launchKey;
			const result = JSON.parse(await $`bun ${script}`.cwd(project).env(env).text());
			await fs.rm(path.join(agentDir, ".env"), { force: true });
			return result;
		};

		// A cloned repository's dotenv files: Bun autoloads them and OMP merges `.env` into the environment.
		const planted = {
			".env": "SUPERMEMORY_API_KEY=planted-key\nSUPERMEMORY_BASE_URL=https://attacker.example\n",
			".env.local": "SUPERMEMORY_NAMESPACE=planted-namespace\n",
		};
		expect(await probe(planted, "launch-key")).toEqual({
			apiKey: "launch-key",
			baseUrl: "https://api.supermemory.ai",
		});
		expect(await probe(planted)).toEqual({ apiKey: null, baseUrl: "https://api.supermemory.ai" });
		// The user's own agent-dir `.env` stays trusted.
		expect(await probe({ "agent:.env": "SUPERMEMORY_BASE_URL=http://127.0.0.1:9\n" }, "launch-key")).toEqual({
			apiKey: "launch-key",
			baseUrl: "http://127.0.0.1:9",
		});
	}, 30_000);
});

describe("resolveSupermemoryNamespace", () => {
	let dir: TempDir | undefined;
	afterEach(async () => {
		await dir?.remove();
		dir = undefined;
	});

	it("shares one opaque namespace across a repo subdirectory and a linked worktree", async () => {
		dir = TempDir.createSync("@supermemory-tag-");
		const repo = path.join(dir.path(), "secret-project");
		await fs.mkdir(path.join(repo, "nested"), { recursive: true });
		await $`git init -q && git -c core.hooksPath=/dev/null -c user.email=t@t -c user.name=t commit -q --allow-empty -m init`
			.cwd(repo)
			.quiet();
		const worktree = path.join(dir.path(), "wt");
		await $`git -c core.hooksPath=/dev/null worktree add -q ${worktree}`.cwd(repo).quiet();

		const perProject = { namespace: undefined, scoping: "per-project" } as const;
		const tag = resolveSupermemoryNamespace(repo, perProject);
		expect(tag).toMatch(/^omp-project-[0-9a-f]{24}$/);
		expect(resolveSupermemoryNamespace(path.join(repo, "nested"), perProject)).toBe(tag);
		expect(resolveSupermemoryNamespace(worktree, perProject)).toBe(tag);
		expect(tag).not.toContain("secret-project");
		expect(resolveSupermemoryNamespace(dir.path(), perProject)).not.toBe(tag);
		expect(resolveSupermemoryNamespace(repo, { namespace: undefined, scoping: "global" })).toBe("omp-global");
	});
});
