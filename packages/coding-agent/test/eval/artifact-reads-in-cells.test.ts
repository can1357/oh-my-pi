import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { $which, TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { releaseArtifactRoots } from "../../src/eval/artifact-readiness";
import js from "../../src/eval/js";
import { disposeAllVmContexts } from "../../src/eval/js/context-manager";
import py from "../../src/eval/py";
import { disposeAllKernelSessions } from "../../src/eval/py/executor";
import { disposePyToolBridge } from "../../src/eval/py/tool-bridge";
import { registerArtifactsDir } from "../../src/internal-urls/registry-helpers";
import type { ToolSession } from "../../src/tools";

/**
 * `artifact://<n>` read from real cells: a JavaScript worker and a Python
 * kernel, each asking the host across its own bridge.
 */

const python = Bun.env.PYTHON ?? $which("python3") ?? $which("python");
const q = JSON.stringify;
const languages = python ? (["js", "py"] as const) : (["js"] as const);
type Language = (typeof languages)[number];

afterEach(async () => {
	await disposeAllVmContexts();
	await disposeAllKernelSessions();
	await disposePyToolBridge();
	await releaseArtifactRoots();
});

interface Fixture {
	dir: string;
	root: string;
	session: ToolSession;
}

function fixture(tempDir: TempDir): Fixture {
	const dir = tempDir.path();
	const root = path.join(dir, "a");
	const id = `cells-${crypto.randomUUID()}`;
	const session: ToolSession = {
		cwd: dir,
		hasUI: false,
		settings: Settings.isolated({
			"async.enabled": false,
			"eval.autoProvision": false,
			"python.interpreter": python ?? "",
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getSessionId: () => id,
		getEvalSessionId: () => id,
		getArtifactsDir: () => root,
	};
	return { dir, root, session };
}

function run(language: Language, code: string, f: Fixture) {
	const backend = language === "js" ? js : py;
	return backend.execute(code, {
		cwd: f.dir,
		sessionId: f.session.getSessionId?.() ?? "",
		sessionFile: undefined,
		kernelOwnerId: undefined,
		session: f.session,
		reset: false,
		onChunk: () => {},
	});
}

/** Read `artifact://8` and print it. */
function printRead(language: Language): string {
	return language === "js" ? `print(await read('artifact://8'));\n` : `print(read('artifact://8'))\n`;
}

/** Announce `key` and wait for `key-go`: the test changes the directory in between. */
function barrier(language: Language, dir: string, key: string): string {
	const ready = path.join(dir, key);
	const go = path.join(dir, `${key}-go`);
	return language === "js"
		? `await Bun.write(${q(ready)}, "1"); while (!(await Bun.file(${q(go)}).exists())) await Bun.sleep(5);\n`
		: `from pathlib import Path\nimport time\nPath(${q(ready)}).write_text("1")\nwhile not Path(${q(go)}).exists(): time.sleep(.005)\n`;
}

/**
 * Wait for a cell to reach `file`. The cell is another process or worker
 * talking over IPC, which no fake clock can advance: polling for the file it
 * writes is the condition itself.
 */
async function until(file: string): Promise<void> {
	for (let n = 0; n < 4_000; n++) {
		if (fs.existsSync(file)) return;
		await Bun.sleep(5);
	}
	throw new Error(`the cell never reached ${file}`);
}

function openUnder(dir: string): number {
	let open = 0;
	for (const fd of fs.readdirSync("/proc/self/fd")) {
		try {
			if (fs.readlinkSync(`/proc/self/fd/${fd}`).startsWith(`${dir}/`)) open++;
		} catch {
			// Closed between the listing and the readlink.
		}
	}
	return open;
}

describe.skipIf(process.platform !== "linux")("artifact reads in real cells", () => {
	for (const language of languages) {
		it(`${language}: a root that arrived mid-cell stays the cell's when it is replaced`, async () => {
			using tempDir = TempDir.createSync("@omp-eval-cells-");
			const f = fixture(tempDir);
			const cell = run(
				language,
				barrier(language, f.dir, "ready") +
					printRead(language) +
					barrier(language, f.dir, "read") +
					printRead(language),
				f,
			);
			try {
				// The cell started before its artifacts directory existed; its
				// first read binds the directory that has arrived by then.
				await until(path.join(f.dir, "ready"));
				fs.mkdirSync(f.root);
				fs.writeFileSync(path.join(f.root, "8.read.log"), "LATE ORIGINAL");
				fs.writeFileSync(path.join(f.dir, "ready-go"), "1");
				await until(path.join(f.dir, "read"));
				fs.renameSync(f.root, path.join(f.dir, "saved"));
				fs.mkdirSync(f.root);
				fs.writeFileSync(path.join(f.root, "8.read.log"), "WRONG FOREIGN");
				fs.writeFileSync(path.join(f.dir, "read-go"), "1");
				const result = await cell;
				expect(result.output.trim()).toBe("LATE ORIGINAL\nLATE ORIGINAL");
				expect(result.exitCode).toBe(0);
			} finally {
				fs.writeFileSync(path.join(f.dir, "ready-go"), "1");
				fs.writeFileSync(path.join(f.dir, "read-go"), "1");
				await cell;
			}
		}, 30_000);

		it(`${language}: a root that arrived mid-cell and vanished is not a reason to read another session's`, async () => {
			using tempDir = TempDir.createSync("@omp-eval-cells-");
			const f = fixture(tempDir);
			const foreign = path.join(f.dir, "other");
			fs.mkdirSync(foreign);
			fs.writeFileSync(path.join(foreign, "8.read.log"), "WRONG FOREIGN");
			const unregister = registerArtifactsDir(foreign);
			const cell = run(
				language,
				barrier(language, f.dir, "ready") +
					printRead(language) +
					barrier(language, f.dir, "read") +
					printRead(language),
				f,
			);
			try {
				await until(path.join(f.dir, "ready"));
				fs.mkdirSync(f.root);
				fs.writeFileSync(path.join(f.root, "8.read.log"), "LATE ORIGINAL");
				fs.writeFileSync(path.join(f.dir, "ready-go"), "1");
				await until(path.join(f.dir, "read"));
				fs.renameSync(f.root, path.join(f.dir, "saved"));
				fs.writeFileSync(path.join(f.dir, "read-go"), "1");
				const result = await cell;
				expect(result.output).not.toContain("WRONG FOREIGN");
				expect(result.output.trim()).toBe("LATE ORIGINAL\nLATE ORIGINAL");
			} finally {
				unregister();
				fs.writeFileSync(path.join(f.dir, "ready-go"), "1");
				fs.writeFileSync(path.join(f.dir, "read-go"), "1");
				await cell;
			}
		}, 30_000);

		it(`${language}: forty one-read cells each give their pin back`, async () => {
			using tempDir = TempDir.createSync("@omp-eval-cells-");
			const f = fixture(tempDir);
			fs.mkdirSync(f.root);
			for (let n = 0; n < 40; n++) fs.writeFileSync(path.join(f.root, `${n}.read.log`), `ORIGINAL ${n}`);
			const failures: string[] = [];
			for (let n = 0; n < 40; n++) {
				const code = language === "js" ? `print(await read('artifact://${n}'));` : `print(read('artifact://${n}'))`;
				const result = await run(language, code, f);
				if (result.exitCode !== 0 || result.output.trim() !== `ORIGINAL ${n}`) failures.push(result.output);
			}
			expect(failures).toEqual([]);
			// Given back as each read finished, not when the kernel goes.
			expect(openUnder(f.root)).toBe(0);
		}, 60_000);
	}

	it.skipIf(!python)(
		"py: a read whose name was replaced reads the pinned file it was answered about",
		async () => {
			using tempDir = TempDir.createSync("@omp-eval-cells-");
			const f = fixture(tempDir);
			fs.mkdirSync(f.root);
			const file = path.join(f.root, "0.read.log");
			fs.writeFileSync(file, "ORIGINAL 0");
			// Between the host's answer and the kernel's open, the name is given to
			// another file: the kernel must take its own pin, not give it back first.
			const code = [
				"import os",
				"real_open = os.open",
				"armed = False",
				"def swap(name, flags, *args, **kwargs):",
				"    global armed",
				`    if str(name) == ${q(file)} and not armed:`,
				"        armed = True",
				`        os.rename(${q(file)}, ${q(path.join(f.root, "moved"))})`,
				`        with open(${q(file)}, "w") as handle: handle.write("WRONG FOREIGN")`,
				"    return real_open(name, flags, *args, **kwargs)",
				"os.open = swap",
				"print(read('artifact://0'))",
			].join("\n");
			const result = await run("py", code, f);
			expect(result.output.trim()).toBe("ORIGINAL 0");
			expect(result.exitCode).toBe(0);
			expect(openUnder(f.root)).toBe(0);
		},
		30_000,
	);

	it.skipIf(!python)(
		"py: a kernel that dies between the answer and its read leaves no pin behind",
		async () => {
			using tempDir = TempDir.createSync("@omp-eval-cells-");
			const f = fixture(tempDir);
			fs.mkdirSync(f.root);
			const file = path.join(f.root, "0.read.log");
			fs.writeFileSync(file, "ORIGINAL 0");
			const code = [
				"import os",
				"real_open = os.open",
				"def die(name, flags, *args, **kwargs):",
				`    if str(name) == ${q(file)}: os._exit(17)`,
				"    return real_open(name, flags, *args, **kwargs)",
				"os.open = die",
				"print(read('artifact://0'))",
			].join("\n");
			await run("py", code, f).catch(() => undefined);
			// The cell is over, and with it the answer it was given.
			expect(openUnder(f.root)).toBe(0);
		},
		30_000,
	);
});
