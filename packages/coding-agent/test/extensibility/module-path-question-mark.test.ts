/**
 * Bun cannot load a module from a path that contains `?`: it reads the path cut
 * at the `?` and reports "Cannot find module …" (with `?mtime=…` for an
 * extension), which names neither the cause nor the fix. Through a `?`-free
 * link into such a directory, a hook, custom command or share script failed
 * with "ENOENT reading …"; a custom command could load instead, in an order
 * where a hook load through the same link ran earlier in the process, before
 * the command's file was written. Every place that imports user code from a
 * path refuses such a path before importing, with an error that names the
 * path and the limit, whatever ran before it.
 * These tests pin that message at each of them.
 */
import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadCustomCommands } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/loader";
import { loadCustomTools } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/loader";
import { importExtensionModule } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { loadHooks } from "@oh-my-pi/pi-coding-agent/extensibility/hooks/loader";
import { assertBunCanImport } from "@oh-my-pi/pi-coding-agent/extensibility/module-path";
import { loadLegacyPiModule } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const roots: string[] = [];

afterAll(async () => {
	for (const root of roots) {
		await removeWithRetries(root);
	}
});

const LIMIT =
	'Bun cannot load a module from a path that contains "?". Move the files to a directory whose path has no "?".';

/** A new temporary root. */
async function makeRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-module-path-q-"));
	roots.push(root);
	return root;
}

/** A new root holding a `q?x` directory, and the root itself. */
async function makeQuestionRoot(): Promise<{ root: string; questionDir: string }> {
	const root = await makeRoot();
	const questionDir = path.join(root, "q?x");
	await fs.mkdir(questionDir);
	return { root, questionDir };
}

async function writeModule(file: string, source = "export default function () {}\n"): Promise<string> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, source, "utf8");
	return file;
}

function message(modulePath: string, realPath = modulePath): string {
	const via = realPath === modulePath ? "" : ` (its real path ${realPath})`;
	return `Cannot load ${modulePath}${via}: ${LIMIT}`;
}

/** The `value` export of the module `loadLegacyPiModule` loads from `entry`. */
async function loadedValue(entry: string): Promise<unknown> {
	const loaded = await loadLegacyPiModule(entry);
	return loaded !== null && typeof loaded === "object" && "value" in loaded ? loaded.value : undefined;
}

// Windows file names cannot hold `?`.
describe.skipIf(process.platform === "win32")("a module under a path that contains ?", () => {
	it("is refused by loadLegacyPiModule, with the path and the limit", async () => {
		const { questionDir } = await makeQuestionRoot();
		const entry = await writeModule(path.join(questionDir, "ext", "index.ts"));
		await expect(loadLegacyPiModule(entry)).rejects.toThrow(message(entry));
	});

	it("is not refused when only a module the entry imports has one: the loader serves its source", async () => {
		// The entry imports `../lib/helper.ts`, and `lib` links to `q?x`. The
		// extension loader's own load hooks serve the source modules of the
		// entry's graph, so Bun never opens the `?` path, and the module loads
		// and reloads. Refusing it would break an extension that works.
		const { root, questionDir } = await makeQuestionRoot();
		const helper = await writeModule(path.join(questionDir, "helper.ts"), "export const helper = 41;\n");
		await fs.symlink(questionDir, path.join(root, "lib"));
		const entry = await writeModule(
			path.join(root, "ext", "index.ts"),
			'import { helper } from "../lib/helper.ts";\nexport const value = helper + 1;\n',
		);
		expect(await loadedValue(entry)).toBe(42);
		await fs.writeFile(helper, "export const helper = 99;\n");
		const later = new Date(Date.now() + 5_000);
		await fs.utimes(helper, later, later);
		expect(await loadedValue(entry)).toBe(100);
	});

	it("is refused when a ?-free symbolic link leads into it", async () => {
		const { root, questionDir } = await makeQuestionRoot();
		const entry = await writeModule(path.join(questionDir, "index.ts"));
		const link = path.join(root, "plain-link");
		await fs.symlink(questionDir, link);
		await expect(loadLegacyPiModule(path.join(link, "index.ts"))).rejects.toThrow(message(entry));
		await expect(assertBunCanImport(path.join(link, "index.ts"))).rejects.toThrow(
			message(path.join(link, "index.ts"), entry),
		);
	});

	it("is reported by an extension's load", async () => {
		const { questionDir } = await makeQuestionRoot();
		const entry = await writeModule(path.join(questionDir, "ext", "index.ts"));
		const loaded = await importExtensionModule(entry, path.dirname(entry));
		expect(loaded.error).toBe(`Failed to load extension: ${message(entry)}`);
	});

	it("is reported by a custom tool's load", async () => {
		const { questionDir } = await makeQuestionRoot();
		const tool = await writeModule(path.join(questionDir, "tool.ts"));
		const loaded = await loadCustomTools([{ path: tool }], questionDir, []);
		expect(loaded.errors.map(error => error.error)).toEqual([`Failed to load tool: ${message(tool)}`]);
	});

	it("is reported by a hook's load", async () => {
		const { questionDir } = await makeQuestionRoot();
		const hook = await writeModule(path.join(questionDir, "hook.ts"));
		const loaded = await loadHooks([hook], questionDir);
		expect(loaded.errors).toEqual([{ path: hook, error: `Failed to load hook: ${message(hook)}` }]);
	});

	it("is reported by a custom command's load", async () => {
		const { questionDir } = await makeQuestionRoot();
		const command = await writeModule(path.join(questionDir, "agent", "commands", "probe", "index.ts"));
		const loaded = await loadCustomCommands({ cwd: questionDir, agentDir: path.join(questionDir, "agent") });
		expect(loaded.errors).toEqual([{ path: command, error: `Failed to load command: ${message(command)}` }]);
	});

	it("is refused for a custom command whose directory is a link into it", async () => {
		// The commands loader follows a linked command directory, so the
		// command's real path holds the `?` while the path it finds does not.
		const { root, questionDir } = await makeQuestionRoot();
		const target = await writeModule(path.join(questionDir, "pkg", "index.ts"));
		const agentDir = path.join(root, "agent");
		await fs.mkdir(path.join(agentDir, "commands"), { recursive: true });
		await fs.symlink(path.dirname(target), path.join(agentDir, "commands", "probe"));
		const loaded = await loadCustomCommands({ cwd: root, agentDir });
		const linked = path.join(agentDir, "commands", "probe", "index.ts");
		expect(loaded.errors).toEqual([{ path: linked, error: `Failed to load command: ${message(linked, target)}` }]);
	});

	it("is refused for a custom command through a link, also when a hook load through the link ran first", async () => {
		// Before this check, this order loaded the command: a hook load
		// through the link, then the command's file written, then the command
		// load through the same link. Alone, or with its file written before
		// the hook load, the command failed with "ENOENT reading". A fresh
		// process, so this order is the only history its loaders have; the
		// files are written there, each just before its own load.
		const { root, questionDir } = await makeQuestionRoot();
		const link = path.join(root, "plain-link");
		await fs.symlink(questionDir, link);
		const probe = [
			'import * as fs from "node:fs/promises";',
			'import { loadCustomCommands } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/loader";',
			'import { loadHooks } from "@oh-my-pi/pi-coding-agent/extensibility/hooks/loader";',
			"const { PROBE_LINK: link } = process.env;",
			'await fs.writeFile(link + "/hook.ts", "export default function () {}\\n");',
			'await loadHooks([link + "/hook.ts"], link);',
			'await fs.mkdir(link + "/agent/commands/probe", { recursive: true });',
			'await fs.writeFile(link + "/agent/commands/probe/index.ts",',
			'  \'export default () => ({ name: "probe-link", description: "probe", execute: async () => {} });\\n\');',
			'const loaded = await loadCustomCommands({ cwd: link, agentDir: link + "/agent" });',
			"const loadedProbe = loaded.commands.some(entry => entry.command.name === 'probe-link');",
			"console.log(JSON.stringify({ loadedProbe, errors: loaded.errors }));",
		].join("\n");
		const child = Bun.spawn([process.execPath, "-e", probe], {
			cwd: path.join(import.meta.dir, "..", ".."),
			env: { ...process.env, PROBE_LINK: link },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(code, stderr).toBe(0);
		const linked = path.join(link, "agent", "commands", "probe", "index.ts");
		const real = path.join(questionDir, "agent", "commands", "probe", "index.ts");
		expect(JSON.parse(stdout.trim())).toEqual({
			loadedProbe: false,
			errors: [{ path: linked, error: `Failed to load command: ${message(linked, real)}` }],
		});
	});

	it("is reported by the custom share script's load", async () => {
		const { questionDir } = await makeQuestionRoot();
		const agentDir = path.join(questionDir, "agent");
		const script = await writeModule(path.join(agentDir, "share.ts"));
		const probe = [
			'import { loadCustomShare } from "@oh-my-pi/pi-coding-agent/export/custom-share";',
			"try { await loadCustomShare(); console.log('loaded'); }",
			"catch (error) { console.log(error instanceof Error ? error.message : String(error)); }",
		].join("\n");
		const child = Bun.spawn([process.execPath, "-e", probe], {
			cwd: path.join(import.meta.dir, "..", ".."),
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
		expect(code).toBe(0);
		expect(stdout.trim()).toBe(`Failed to load share script: ${message(script)}`);
	});
});

describe("a module under a path with no ?", () => {
	it("passes the check, also for a path that does not exist", async () => {
		const root = await makeRoot();
		const plain = await writeModule(path.join(root, "#%' x", "index.ts"));
		await assertBunCanImport(plain);
		await assertBunCanImport(path.join(root, "missing", "index.ts"));
	});

	// The `?` of the `\\?\` prefix is not part of the path Bun reads.
	it.skipIf(process.platform !== "win32")("passes a Windows extended-length path", async () => {
		const root = await makeRoot();
		const plain = await writeModule(path.join(root, "ext", "index.ts"));
		await assertBunCanImport(`\\\\?\\${plain}`);
	});
});
