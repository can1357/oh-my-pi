import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { $which, TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { artifactPinCeiling, releaseArtifactRoots } from "../../src/eval/artifact-readiness";
import { artifactRequestOf } from "../../src/eval/artifact-wire";
import js from "../../src/eval/js";
import {
	disposeAllVmContexts,
	type JsEvalWorkerHandle,
	setJsEvalWorkerFactoriesForTests,
} from "../../src/eval/js/context-manager";
import type { WorkerOutbound } from "../../src/eval/js/worker-protocol";
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

		// Past the old fixed ceiling of 32: an ordinary cell that reads many
		// artifacts at once, which the derived ceiling must not refuse.
		it.skipIf(artifactPinCeiling() < 128)(
			`${language}: a hundred artifact reads started together in one cell all succeed`,
			async () => {
				using tempDir = TempDir.createSync("@omp-eval-cells-");
				const f = fixture(tempDir);
				fs.mkdirSync(f.root);
				for (let n = 0; n < 100; n++) fs.writeFileSync(path.join(f.root, `${n}.read.log`), `ORIGINAL ${n}`);
				const code =
					language === "js"
						? "const texts = await Promise.all(Array.from({ length: 100 }, (_, n) => read('artifact://' + n)));\nprint(texts.filter((text, n) => text === 'ORIGINAL ' + n).length);\n"
						: [
								// Every thread holds its answer until all hundred have one: a hundred
								// reads in flight at once, as slow consumers would leave them.
								"import os, threading",
								"from concurrent.futures import ThreadPoolExecutor",
								"real_open = os.open",
								"gate = threading.Barrier(100, timeout=5)",
								"def held(name, flags, *rest, **kw):",
								"    if str(name).endswith('.read.log'):",
								"        try: gate.wait()",
								"        except threading.BrokenBarrierError: pass",
								"    return real_open(name, flags, *rest, **kw)",
								"os.open = held",
								"with ThreadPoolExecutor(max_workers=100) as pool:",
								"    texts = list(pool.map(lambda n: read(f'artifact://{n}'), range(100)))",
								"print(sum(text == f'ORIGINAL {n}' for n, text in enumerate(texts)))",
							].join("\n");
				const result = await run(language, code, f);
				expect(result.output.trim()).toBe("100");
				expect(result.exitCode).toBe(0);
				expect(openUnder(f.root)).toBe(0);
			},
			60_000,
		);

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

	it("js: two first reads in one rootless cell read the directory the cell bound, not its replacement", async () => {
		using tempDir = TempDir.createSync("@omp-eval-cells-");
		const f = fixture(tempDir);
		const tokens: (string | undefined)[] = [];
		let answers = 0;
		let deliverSecond: (() => void) | undefined;
		// A real worker whose second `answer` request reaches the host only when the test lets it.
		const spawn = (): JsEvalWorkerHandle => {
			const worker = new Worker(new URL("../../src/eval/js/worker-entry.ts", import.meta.url).href, {
				type: "module",
			});
			return {
				mode: "worker",
				send: message => worker.postMessage(message),
				onMessage(handler) {
					const listener = (event: MessageEvent<WorkerOutbound>): void => {
						const message = event.data;
						const request = message.type === "tool-call" ? artifactRequestOf(message.args) : null;
						if (request?.op === "answer") {
							tokens.push(request.token);
							if (++answers === 2) {
								deliverSecond = () => handler(message);
								return;
							}
						}
						handler(message);
					};
					worker.addEventListener("message", listener);
					return () => worker.removeEventListener("message", listener);
				},
				onError(handler) {
					const listener = (event: ErrorEvent): void => handler(new Error(event.message));
					worker.addEventListener("error", listener);
					return () => worker.removeEventListener("error", listener);
				},
				async close() {
					worker.terminate();
					return true;
				},
				async terminate() {
					worker.terminate();
				},
			};
		};
		const restore = setJsEvalWorkerFactoriesForTests({ spawnProcess: spawn, spawnWorker: spawn });
		const first = path.join(f.dir, "first");
		const code =
			barrier("js", f.dir, "ready") +
			`const first = read('artifact://0').then(async text => { print('FIRST', text); await Bun.write(${q(first)}, '1'); });\n` +
			`const second = read('artifact://0').then(text => print('SECOND', text));\n` +
			`const both = await Promise.all([first, second]);\n`;
		const cell = run("js", code, f);
		try {
			await until(path.join(f.dir, "ready"));
			fs.mkdirSync(f.root);
			fs.writeFileSync(path.join(f.root, "0.read.log"), "ORIGINAL");
			fs.writeFileSync(path.join(f.dir, "ready-go"), "1");
			await until(first);
			// The first read has bound the directory; the second's request is still on its way.
			fs.renameSync(f.root, path.join(f.dir, "saved"));
			fs.mkdirSync(f.root);
			fs.writeFileSync(path.join(f.root, "0.read.log"), "WRONG FOREIGN");
			if (!deliverSecond) throw new Error("the second read never asked");
			deliverSecond();
			const result = await cell;
			expect(result.output).not.toContain("WRONG FOREIGN");
			expect(result.output.trim()).toBe("FIRST ORIGINAL\nSECOND ORIGINAL");
			expect(result.exitCode).toBe(0);
			// Both first reads asked with no token; the refused answer was asked again through the bound hold.
			expect(tokens.slice(0, 2)).toEqual([undefined, undefined]);
			expect(tokens[2]).toStartWith("root-");
		} finally {
			restore();
			fs.writeFileSync(path.join(f.dir, "ready-go"), "1");
			deliverSecond?.();
			await cell.catch(() => undefined);
		}
	}, 30_000);

	it.skipIf(!python)(
		"py: two first reads on two threads read the directory the cell bound, not its replacement",
		async () => {
			using tempDir = TempDir.createSync("@omp-eval-cells-");
			const f = fixture(tempDir);
			const at = (name: string) => q(path.join(f.dir, name));
			// Each thread writes what it read to a file: thread output does not reach the cell's.
			const code = [
				"from pathlib import Path",
				"import time",
				"from threading import Thread, Lock",
				"real_bridge = _bridge_call",
				"lock = Lock()",
				"answers = 0",
				"def gated(name, args, *rest, **kw):",
				"    global answers",
				"    hold = False",
				"    if name == '__artifacts_ready__' and args.get('op') == 'answer':",
				"        with lock:",
				"            answers += 1",
				"            hold = answers == 2",
				"        if hold:",
				`            Path(${at("second")}).write_text('1')`,
				`            while not Path(${at("next")}).exists(): time.sleep(.005)`,
				"    return real_bridge(name, args, *rest, **kw)",
				"_bridge_call = gated",
				"def first():",
				`    Path(${at("first-text")}).write_text(read('artifact://0'))`,
				`    Path(${at("first")}).write_text('1')`,
				"def second():",
				`    Path(${at("second-text")}).write_text(read('artifact://0'))`,
				`Path(${at("ready")}).write_text('1')`,
				`while not Path(${at("go")}).exists(): time.sleep(.005)`,
				"threads = [Thread(target=first), Thread(target=second)]",
				"for thread in threads: thread.start()",
				"for thread in threads: thread.join()",
			].join("\n");
			const cell = run("py", code, f);
			try {
				await until(path.join(f.dir, "ready"));
				fs.mkdirSync(f.root);
				fs.writeFileSync(path.join(f.root, "0.read.log"), "ORIGINAL");
				fs.writeFileSync(path.join(f.dir, "go"), "1");
				await Promise.all([until(path.join(f.dir, "first")), until(path.join(f.dir, "second"))]);
				fs.renameSync(f.root, path.join(f.dir, "saved"));
				fs.mkdirSync(f.root);
				fs.writeFileSync(path.join(f.root, "0.read.log"), "WRONG FOREIGN");
				fs.writeFileSync(path.join(f.dir, "next"), "1");
				const result = await cell;
				expect(result.exitCode).toBe(0);
				expect(fs.readFileSync(path.join(f.dir, "first-text"), "utf8")).toBe("ORIGINAL");
				expect(fs.readFileSync(path.join(f.dir, "second-text"), "utf8")).toBe("ORIGINAL");
			} finally {
				fs.writeFileSync(path.join(f.dir, "go"), "1");
				fs.writeFileSync(path.join(f.dir, "next"), "1");
				await cell.catch(() => undefined);
			}
		},
		30_000,
	);

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
