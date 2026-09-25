// oxlint-disable no-template-curly-in-string -- literal `${VAR}` is .npmrc syntax under test
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadNpmRegistryResolver } from "../../src/cli/npm-registry";
import { buildBunInstallArgs, buildNpmInstallArgs } from "../../src/cli/update-cli";

const PKG = "@oh-my-pi/pi-coding-agent";
const dirs: string[] = [];

async function home(files: Record<string, string>): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-npm-registry-"));
	dirs.push(dir);
	for (const [name, content] of Object.entries(files)) await Bun.write(path.join(dir, name), content);
	return dir;
}

afterEach(async () => {
	await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("loadNpmRegistryResolver", () => {
	it("defaults to the public registry when nothing is configured", async () => {
		const resolve = await loadNpmRegistryResolver({ env: {}, homeDir: await home({}) });
		expect(resolve(PKG)).toEqual({ url: "https://registry.npmjs.org/", source: "default", authorization: undefined });
	});

	it("uses the user .npmrc registry with its env-expanded token, matched by path prefix", async () => {
		const homeDir = await home({
			".npmrc": [
				"; corporate feed",
				"registry=https://npm.corp.example/api/npm/feed",
				"//npm.corp.example/api/npm/:_authToken=${CORP_TOKEN}",
			].join("\n"),
		});
		const resolve = await loadNpmRegistryResolver({ env: { CORP_TOKEN: "t0k" }, homeDir });
		expect(resolve(PKG)).toEqual({
			url: "https://npm.corp.example/api/npm/feed/",
			source: path.join(homeDir, ".npmrc"),
			authorization: "Bearer t0k",
		});
	});

	it("prefers a scoped registry for the package's scope over the default registry", async () => {
		const homeDir = await home({
			".npmrc": "registry=https://a.example/\n@oh-my-pi:registry=https://scoped.example/npm/\n",
		});
		const resolve = await loadNpmRegistryResolver({ env: {}, homeDir });
		expect(resolve(PKG).url).toBe("https://scoped.example/npm/");
		expect(resolve("@other/pkg").url).toBe("https://a.example/");
	});

	it("lets npm_config_registry override the .npmrc registry, case-insensitively", async () => {
		const homeDir = await home({ ".npmrc": "registry=https://a.example/\n" });
		const resolve = await loadNpmRegistryResolver({ env: { NPM_CONFIG_REGISTRY: "https://env.example/" }, homeDir });
		expect(resolve(PKG)).toMatchObject({ url: "https://env.example/", source: "environment" });
	});

	it("honors npm_config_userconfig instead of ~/.npmrc", async () => {
		const homeDir = await home({
			".npmrc": "registry=https://ignored.example/\n",
			"custom.npmrc": "registry=https://custom.example/\n",
		});
		const resolve = await loadNpmRegistryResolver({
			env: { npm_config_userconfig: path.join(homeDir, "custom.npmrc") },
			homeDir,
		});
		expect(resolve(PKG).url).toBe("https://custom.example/");
	});

	it("falls back to the global bunfig registry and its token", async () => {
		const homeDir = await home({
			".bunfig.toml": '[install]\nregistry = { url = "https://bun.example/feed", token = "$BUN_TOKEN" }\n',
		});
		const resolve = await loadNpmRegistryResolver({ env: { BUN_TOKEN: "b" }, homeDir });
		expect(resolve(PKG)).toEqual({
			url: "https://bun.example/feed/",
			source: path.join(homeDir, ".bunfig.toml"),
			authorization: "Bearer b",
		});
	});

	it("moves credentials embedded in the registry URL into basic auth, never into the URL or install argv", async () => {
		const homeDir = await home({ ".npmrc": "registry=https://me:p%40ss@creds.example/\n" });
		const resolve = await loadNpmRegistryResolver({ env: {}, homeDir });
		const registry = resolve(PKG);
		expect(registry.authorization).toBe(`Basic ${btoa("me:p@ss")}`);
		expect(registry.url).toBe("https://creds.example/");
		const argv = [
			...buildBunInstallArgs("19.0.0", "linux-x64", undefined, { registry: registry.url }),
			...buildNpmInstallArgs("19.0.0", "linux-x64", undefined, { registry: registry.url }),
		].join(" ");
		expect(argv).not.toContain("p%40ss");
		expect(argv).not.toContain("me:");
	});

	it("rejects a malformed configured registry instead of silently using the public one", async () => {
		const homeDir = await home({ ".npmrc": "registry=not a url\n" });
		const resolve = await loadNpmRegistryResolver({ env: {}, homeDir });
		expect(() => resolve(PKG)).toThrow('Invalid npm registry URL "not a url"');
	});

	it("fails loudly on an unset required ${VAR} like npm does", async () => {
		const homeDir = await home({ ".npmrc": "//x.example/:_authToken=${MISSING}\n" });
		await expect(loadNpmRegistryResolver({ env: {}, homeDir })).rejects.toThrow("${MISSING}");
	});
});

describe("install args follow the checked registry", () => {
	it("pins bun and npm installs to the registry the release was resolved from", () => {
		const registry = "https://npm.corp.example/api/npm/feed/";
		expect(buildBunInstallArgs("19.0.0", "linux-x64", undefined, { registry })).toContain(`--registry=${registry}`);
		expect(buildNpmInstallArgs("19.0.0", "linux-x64", undefined, { registry })).toContain(`--registry=${registry}`);
	});
});
