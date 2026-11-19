import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearClaudePluginRootsCache } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import {
	__resetLegacyPiResolutionCache,
	__rewriteLegacyExtensionSourceForTests,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
import { getEnabledPlugins } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const tempRoots: string[] = [];

afterEach(async () => {
	__resetLegacyPiResolutionCache();
	clearClaudePluginRootsCache();
	mock.restore();
	for (const root of tempRoots.splice(0)) {
		await removeWithRetries(root);
	}
});

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await Bun.write(filePath, `${JSON.stringify(value)}\n`);
}

test("getEnabledPlugins caches repeated discovery for the same cwd and home until plugin caches clear", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-plugin-cache-"));
	tempRoots.push(root);
	const home = path.join(root, "home");
	const cwd = path.join(root, "project");
	const pluginsDir = path.join(home, ".omp", "plugins");
	const pluginPackageJson = path.join(pluginsDir, "node_modules", "omp-cache-repro", "package.json");
	await fs.mkdir(path.dirname(pluginPackageJson), { recursive: true });
	await fs.mkdir(cwd, { recursive: true });
	await writeJson(path.join(pluginsDir, "package.json"), { dependencies: { "omp-cache-repro": "1.0.0" } });
	await writeJson(path.join(pluginsDir, "omp-plugins.lock.json"), {
		plugins: { "omp-cache-repro": { version: "1.0.0", enabled: true, enabledFeatures: null } },
		settings: {},
	});
	await writeJson(pluginPackageJson, {
		name: "omp-cache-repro",
		version: "1.0.0",
		omp: { tools: "tools" },
	});

	const [firstPlugin] = await getEnabledPlugins(cwd, { home });
	await writeJson(pluginPackageJson, {
		name: "omp-cache-repro",
		version: "2.0.0",
		omp: { tools: "tools" },
	});
	const [cachedPlugin] = await getEnabledPlugins(cwd, { home });

	expect(firstPlugin?.version).toBe("1.0.0");
	expect(cachedPlugin?.version).toBe("1.0.0");

	clearClaudePluginRootsCache();
	const [refreshedPlugin] = await getEnabledPlugins(cwd, { home });

	expect(refreshedPlugin?.version).toBe("2.0.0");
});

test("legacy bare dependency rewrites cache fallback package resolution until plugin caches clear", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-legacy-cache-"));
	tempRoots.push(root);
	const importer = path.join(root, "extension", "src", "entry.ts");
	const depRoot = path.join(root, "extension", "node_modules", "left-pad");
	const manifestPath = path.join(depRoot, "package.json");
	await fs.mkdir(path.dirname(importer), { recursive: true });
	await fs.mkdir(depRoot, { recursive: true });
	await Bun.write(importer, "export {};\n");
	await writeJson(manifestPath, { name: "left-pad", version: "1.0.0", main: "index.js" });
	await Bun.write(path.join(depRoot, "index.js"), "export default function leftPad() {}\n");
	await Bun.write(path.join(depRoot, "alt.js"), "export default function altLeftPad() {}\n");

	spyOn(Bun, "resolveSync").mockImplementation(() => {
		throw new Error("compiled fallback");
	});

	const firstRewrite = await __rewriteLegacyExtensionSourceForTests('import leftPad from "left-pad";', importer);
	await writeJson(manifestPath, { name: "left-pad", version: "1.0.0", main: "alt.js" });
	const cachedRewrite = await __rewriteLegacyExtensionSourceForTests('import leftPad from "left-pad";', importer);

	expect(firstRewrite).toContain("index.js");
	expect(cachedRewrite).toBe(firstRewrite);

	clearClaudePluginRootsCache();
	const refreshedRewrite = await __rewriteLegacyExtensionSourceForTests('import leftPad from "left-pad";', importer);

	expect(refreshedRewrite).toContain("alt.js");
});
