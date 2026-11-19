/**
 * Contract of the real Binary Ninja worker (`src/binja/worker.py`) as the unmodified supervisor
 * (`DisasmWorker`) drives it: the RPC results, what survives a save, a close and a cold reopen,
 * what a failed or interrupted `exec` leaves behind, and how a failed open is answered. The
 * daemon tests substitute a fake worker, so nothing else runs this Python code.
 *
 * Skipped unless a Binary Ninja install resolves on the host and a Python 3 can start it headless
 * (which is where the licence is checked). Each test works in its own temp dir against a copy of
 * `/bin/true` or a shared library it builds there, so it touches neither the agent dir nor the
 * user's databases.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { $ } from "bun";
import { binjaPythonDir, locateBinjaInstall } from "@oh-my-pi/pi-coding-agent/binja/install";
import { DISASM_BACKENDS, type WorkerRuntime } from "@oh-my-pi/pi-coding-agent/disasm/backend";
import type { DatabaseLocation } from "@oh-my-pi/pi-coding-agent/disasm/store";
import { DisasmWorker, type WorkerRequestOptions } from "@oh-my-pi/pi-coding-agent/disasm/supervisor";
import { IpcConnection } from "@oh-my-pi/pi-natives";
import { acquireFileLock, TempDir } from "@oh-my-pi/pi-utils";
import { waitFor } from "../fixtures/daemon-harness";

const BACKEND = DISASM_BACKENDS.binja;
/** A small dynamically linked ELF: analysis takes well under a second. */
const INPUT = "/bin/true";
const TEST_TIMEOUT_MS = 120_000;
const PROBE = "import binaryninja as b; b.BinaryView.new(b'\\x00')";

function isElf(file: string): boolean {
	let fd: number;
	try {
		fd = fs.openSync(file, "r");
	} catch {
		return false;
	}
	try {
		const magic = Buffer.alloc(4);
		return fs.readSync(fd, magic, 0, 4, 0) === 4 && magic.toString("latin1") === "\x7fELF";
	} finally {
		fs.closeSync(fd);
	}
}

/** Interpreter and environment that start Binary Ninja headless on this host, if any. */
function headlessRuntime(): WorkerRuntime | undefined {
	const installDir = locateBinjaInstall(undefined);
	const pythonPath = Bun.which("python3");
	if (!installDir || !pythonPath || !isElf(INPUT)) return undefined;
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && key !== "BN_LICENSE") env[key] = value;
	}
	env.PYTHONUNBUFFERED = "1";
	env.PYTHONIOENCODING = "utf-8";
	env.PYTHONPATH = binjaPythonDir(installDir);
	env.BN_DISABLE_USER_PLUGINS = "1";
	env.BN_DISABLE_REPOSITORY_PLUGINS = "1";
	const probe = Bun.spawnSync([pythonPath, "-c", PROBE], { env, stdout: "ignore", stderr: "ignore" });
	return probe.exitCode === 0 ? { pythonPath, env } : undefined;
}

const runtime = headlessRuntime();
const isRoot = process.getuid?.() === 0;
/** Builds the shared-library fixture; the import test is skipped without it. */
const cc = Bun.which("cc");

interface ViewResult {
	text: string;
}

interface ExecResult {
	output: string;
	value: string | null;
	error: string | null;
}

interface RenameResult {
	ea: string;
	old: string;
	new: string;
}

interface SetTypeResult {
	ea: string;
	type: string;
}

interface MakeFunctionResult {
	ea: string;
	name: string;
}

describe.skipIf(!runtime)("Binary Ninja worker", () => {
	let tmp: TempDir;
	let live: DisasmWorker[];
	let endpoints: number;

	beforeEach(() => {
		tmp = TempDir.createSync("@omp-binja-worker-test-");
		live = [];
		endpoints = 0;
	});

	afterEach(async () => {
		for (const worker of live) {
			if (worker.running) await worker.kill();
			// The supervisor finishes its exit handling a moment after the process is gone and removes
			// the endpoint last; it exposes no promise for that. Deleting the directory under it leaves
			// part of the tree behind.
			const { endpoint } = worker.state();
			await waitFor(() => !fs.existsSync(endpoint), `the supervisor to clean up ${endpoint}`);
		}
		// A test may have left its store directory read-only.
		for (const entry of fs.readdirSync(tmp.path(), { withFileTypes: true })) {
			if (entry.isDirectory()) fs.chmodSync(path.join(tmp.path(), entry.name), 0o755);
		}
		await tmp.remove();
	});

	/** A managed store directory holding the staged input, as `prepareStoreDir` leaves it. */
	function stageInput(source: string = INPUT): string {
		const dir = tmp.join("store");
		fs.mkdirSync(dir);
		fs.copyFileSync(source, path.join(dir, path.basename(source)));
		return dir;
	}

	function storeLocation(dir: string, isNew: boolean, source: string = INPUT): DatabaseLocation {
		const stagedPath = path.join(dir, path.basename(source));
		return {
			id: "test-true",
			dir,
			sourcePath: source,
			stagedPath,
			kind: "store",
			openPath: isNew ? stagedPath : BACKEND.databaseName(stagedPath),
			isNew,
			lockTarget: path.join(dir, "db"),
		};
	}

	/**
	 * A shared library whose `api` calls libc's `puts`, `dep_fn` from a second library under the
	 * symbol version `DEP_1`, and its own exported `helper`, which the linker routes through the PLT.
	 * `direct` and `tail` are built without a PLT: `direct` calls `puts` through the import slot,
	 * and `tail` is nothing but a jump through it, which is also what a PLT entry looks like.
	 */
	async function buildLibrary(): Promise<string> {
		if (!cc) throw new Error("no C compiler on PATH");
		const src = tmp.join("src");
		fs.mkdirSync(src);
		await Bun.write(path.join(src, "dep.c"), "int dep_fn(int x) { return x * 3; }\n");
		await Bun.write(path.join(src, "dep.map"), "DEP_1 { global: dep_fn; local: *; };\n");
		await Bun.write(
			path.join(src, "fix.c"),
			[
				"#include <stdio.h>",
				"int dep_fn(int);",
				"int helper(int x) { return x + 41; }",
				"int api(const char *s) { return helper(dep_fn(puts(s))); }",
				"",
			].join("\n"),
		);
		await Bun.write(
			path.join(src, "direct.c"),
			["#include <stdio.h>", "int direct(const char *s) { return puts(s); }", ""].join("\n"),
		);
		await Bun.write(
			path.join(src, "tail.c"),
			["#include <stdio.h>", "int tail(const char *s) { return puts(s); }", ""].join("\n"),
		);
		await $`${cc} -shared -fPIC -O0 -Wl,--version-script=dep.map -o libdep.so dep.c`.cwd(src).quiet();
		await $`${cc} -c -fPIC -O0 -o fix.o fix.c`.cwd(src).quiet();
		await $`${cc} -c -fPIC -O0 -fno-plt -o direct.o direct.c`.cwd(src).quiet();
		await $`${cc} -c -fPIC -O2 -fno-plt -fcf-protection=none -o tail.o tail.c`.cwd(src).quiet();
		await $`${cc} -shared -o libfix.so fix.o direct.o tail.o -L. -ldep`.cwd(src).quiet();
		return path.join(src, "libfix.so");
	}

	function inPlaceLocation(database: string): DatabaseLocation {
		return {
			id: "test-inplace",
			dir: path.dirname(database),
			sourcePath: database,
			stagedPath: database,
			kind: "inplace",
			openPath: database,
			isNew: false,
			lockTarget: database,
		};
	}

	/** Spawn the real worker script for `loc` under the real supervisor; the caller opens it. */
	async function spawn(loc: DatabaseLocation): Promise<DisasmWorker> {
		if (!runtime) throw new Error("no headless Binary Ninja runtime");
		const lock = await acquireFileLock(loc.lockTarget);
		const n = ++endpoints;
		let worker: DisasmWorker;
		try {
			worker = await DisasmWorker.spawn(BACKEND, loc, runtime, lock, {
				endpoint: tmp.join(`worker-${n}.sock`),
				logPath: tmp.join(`worker-${n}.log`),
			});
		} catch (error) {
			lock.release();
			throw error;
		}
		live.push(worker);
		return worker;
	}

	async function open(loc: DatabaseLocation): Promise<DisasmWorker> {
		const worker = await spawn(loc);
		await worker.open(loc);
		return worker;
	}

	async function view(worker: DisasmWorker, kind: string, target?: string): Promise<string> {
		return (await worker.request<ViewResult>("view", { kind, target })).text;
	}

	function exec(worker: DisasmWorker, code: string, options?: WorkerRequestOptions): Promise<ExecResult> {
		return worker.request<ExecResult>("exec", { code }, options);
	}

	/** Names starting with `omp_` that the database currently gives its functions, by address. */
	async function ompFunctions(worker: DisasmWorker): Promise<string | null> {
		return (await exec(worker, "[name for _, name in functions('^omp_')]")).value;
	}

	/** Functions Binary Ninja named itself (no symbol), as `[address, name]` in address order. */
	function unnamedFunctions(overview: string): [string, string][] {
		return [...overview.matchAll(/^ {2}0x([0-9a-f]+) +\d+ {2}(sub_[0-9a-f]+)$/gm)].map((m): [string, string] => [
			m[1],
			m[2],
		]);
	}

	async function inputSha256(): Promise<string> {
		return new Bun.CryptoHasher("sha256").update(await Bun.file(INPUT).bytes()).digest("hex");
	}

	it(
		"serves views and edits, reverts a failed or interrupted exec, and keeps the edits across save, close and a cold reopen",
		async () => {
			const dir = stageInput();
			let worker = await open(storeLocation(dir, true));

			// The store holds the published `<name>.bndb` and no half-written file.
			expect(worker.idbPath).toBe(path.join(dir, "true.bndb"));
			expect(
				fs
					.readdirSync(dir)
					.filter(name => name !== "db.lock")
					.sort(),
			).toEqual(["true", "true.bndb"]);
			expect(worker.info).toMatchObject({ module: "true", format: "ELF" });
			expect(worker.needsSave).toBe(false);

			const sha256 = await inputSha256();
			const overview = await view(worker, "overview");
			expect(overview).toContain(`sha256 ${sha256}`);
			const [edited, untouched] = unnamedFunctions(overview);
			if (!edited || !untouched) throw new Error(`${INPUT} has no unnamed functions to edit`);
			const dataStart = /^ {2}\.data 0x([0-9a-f]+)-/m.exec(overview)?.[1];
			if (!dataStart) throw new Error(`${INPUT} has no .data section`);

			// Views: the pointer-called import is a callee of the entry point and an import.
			const entry = await view(worker, "pseudocode", "_start");
			expect(entry).toMatch(/^\/\/ _start @ 0x[0-9a-f]+-0x[0-9a-f]+\n/);
			expect(entry).toContain("__libc_start_main(");
			expect((await exec(worker, "callees('_start')")).value).toBe("['__libc_start_main']");
			expect(await view(worker, "imports")).toMatch(/^0x[0-9a-f]+ {2}__libc_start_main$/m);
			expect(await view(worker, "xrefs", "__libc_start_main")).toMatch(/^0x[0-9a-f]+ {2}CALL {2}in _start$/m);
			const strings = await view(worker, "strings");
			expect(strings).toMatch(/^0x[0-9a-f]+ {2}"\/lib[^"]*\/ld-[^"]+"$/m);
			// Binary Ninja also finds "strings" in instruction bytes; the view lists none, and the
			// overview counts what the view lists.
			const inCode = "[hex(ea) for ea, _ in strings() if bv.get_functions_containing(ea)]";
			expect((await exec(worker, inCode)).value).toBe("[]");
			expect(overview).toContain(`, ${strings.split("\n").length} strings\n`);
			// The lazy-binding stub jumps through a GOT slot that reads 0 in the file: not a callee.
			const unresolvable = [
				"missing = []",
				"for ea, _ in functions():",
				"    for callee in callees(ea):",
				"        try:",
				"            resolve(callee)",
				"        except LookupError:",
				"            missing.append(callee)",
				"missing",
			].join("\n");
			expect((await exec(worker, unresolvable)).value).toBe("[]");
			expect(await view(worker, "exports")).toMatch(/^0x[0-9a-f]+ {2}_start$/m);
			const entryAsm = await view(worker, "asm", "_start");
			const entryAddresses = [...new Set([...entryAsm.matchAll(/^0x([0-9a-f]+) {2}\S/gm)].map(m => m[1]))];
			expect(entryAsm.split("\n").length).toBe([...entryAsm.matchAll(/^0x[0-9a-f]+ {2}\S/gm)].length);

			// Each mutation answers with its result and reads back.
			expect(await worker.request<RenameResult>("rename", { target: edited[1], name: "omp_kept" })).toEqual({
				ea: `0x${edited[0]}`,
				old: edited[1],
				new: "omp_kept",
			});
			expect(worker.needsSave).toBe(true);
			expect(
				await worker.request<{ ea: string }>("comment", { target: "omp_kept", text: "omp note", repeatable: true }),
			).toEqual({ ea: `0x${edited[0]}` });
			const prototype = { target: "omp_kept", decl: "int omp_kept(int a, char *b);" };
			expect(await worker.request<SetTypeResult>("set_type", prototype)).toEqual({
				ea: `0x${edited[0]}`,
				type: "int32_t omp_kept(int32_t a, char* b)",
			});
			// A data type at a function start is refused instead of being silently dropped.
			await expect(worker.request("set_type", { target: "omp_kept", decl: "int" })).rejects.toThrow(
				/function prototype/,
			);
			expect((await view(worker, "pseudocode", "omp_kept")).split("\n").slice(0, 2)).toEqual([
				expect.stringMatching(new RegExp(`^// omp_kept @ 0x${edited[0]}-0x[0-9a-f]+$`)),
				"int32_t omp_kept(int32_t a, char* b)",
			]);
			const data = `0x${dataStart}`;
			expect(await worker.request<SetTypeResult>("set_type", { target: data, decl: "uint32_t" })).toEqual({
				ea: data,
				type: "uint32_t",
			});
			expect(await worker.request<RenameResult>("rename", { target: data, name: "omp_global" })).toEqual({
				ea: data,
				old: "",
				new: "omp_global",
			});
			const inside = entryAddresses[1];
			if (!inside) throw new Error("_start has a single instruction");
			expect(await worker.request<MakeFunctionResult>("make_function", { target: `0x${inside}` })).toEqual({
				ea: `0x${inside}`,
				name: `sub_${inside}`,
			});

			// exec: output, value and error; a raising call reverts its own edits and nothing earlier.
			expect(await exec(worker, "print('out')\n1 + 2")).toEqual({ output: "out\n", value: "3", error: null });
			const failed = await exec(
				worker,
				[
					`rename('${untouched[1]}', 'omp_reverted')`,
					"comment('omp_kept', 'reverted note')",
					"print('ran')",
					"raise RuntimeError('boom')",
				].join("\n"),
			);
			expect(failed.output).toBe("ran\n");
			expect(failed.value).toBeNull();
			expect(failed.error).toContain("RuntimeError: boom");
			expect((await exec(worker, "[name for _, name in functions('^omp_')], func('omp_kept').comment")).value).toBe(
				"(['omp_kept'], 'omp note')",
			);

			// An interrupt ends the running exec with the interrupt error, reverts it, and the worker carries on.
			const interrupted = await exec(worker, `rename('${untouched[1]}', 'omp_interrupted')\nwhile True: pass`, {
				timeoutMs: 500,
			});
			expect(interrupted.error).toBe("KeyboardInterrupt: interrupted (timeout or cancel)");
			expect(await ompFunctions(worker)).toBe("['omp_kept']");

			await worker.request("save", {});
			expect(worker.needsSave).toBe(false);
			await worker.close({ save: false });
			expect(await worker.exited).toBe(0);

			// The published file is an ordinary database: moved elsewhere, it opens in place.
			const database = tmp.join("mine.bndb");
			fs.renameSync(path.join(dir, "true.bndb"), database);
			worker = await open(inPlaceLocation(database));
			expect(worker.idbPath).toBe(database);
			expect(worker.info).toMatchObject({ module: "true", format: "ELF" });
			expect(worker.needsSave).toBe(false);
			// No input file sits beside an in-place database: it reports the digests of the file it was created from.
			expect(await view(worker, "overview")).toContain(`sha256 ${sha256}\n`);
			expect((await view(worker, "pseudocode", "omp_kept")).split("\n").slice(0, 2)).toEqual([
				expect.stringMatching(new RegExp(`^// omp_kept @ 0x${edited[0]}-0x[0-9a-f]+$`)),
				"int32_t omp_kept(int32_t a, char* b)",
			]);
			const persisted = await exec(
				worker,
				[
					"func('omp_kept').comment",
					`str(bv.get_data_var_at(0x${dataStart}).type)`,
					"hex(resolve('omp_global'))",
					`func(0x${inside}).start == 0x${inside}`,
				].join(", "),
			);
			expect(persisted.value).toBe(`('omp note', 'uint32_t', '0x${dataStart}', True)`);
			// A name Binary Ninja generated has no symbol and no cached IL after a reopen; it still opens both ways.
			const cold = await view(worker, "pseudocode", untouched[1]);
			expect(cold).toStartWith(`// ${untouched[1]} @ 0x${untouched[0]}-0x`);
			expect(cold).not.toContain("showing disassembly");
			expect(await view(worker, "asm", untouched[1])).toStartWith(`0x${untouched[0]}  `);
			// Patched bytes do not change them: they stay the analyzed file's.
			expect((await exec(worker, "bv.write(bv.start + 0x40, b'\\x90')")).error).toBeNull();
			expect(await view(worker, "overview")).toContain(`sha256 ${sha256}\n`);
			await worker.close({ save: false });
			expect(await worker.exited).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"keeps unsaved edits across a replaced connection, drops them on close without save, and saves them on SIGTERM",
		async () => {
			const dir = stageInput();
			let worker = await open(storeLocation(dir, true));
			const [first, second] = unnamedFunctions(await view(worker, "overview"));
			if (!first || !second) throw new Error(`${INPUT} has no unnamed functions to edit`);
			await worker.request("rename", { target: first[1], name: "omp_saved" });
			await worker.request("save", {});
			await worker.request("rename", { target: second[1], name: "omp_unsaved" });

			// A connection without the token is closed unanswered.
			const { endpoint, token } = worker.state();
			const stranger = await IpcConnection.connect(endpoint, { framing: "lines", timeoutMs: 5_000 });
			const strangerLines: string[] = [];
			const strangerClosed = Promise.withResolvers<void>();
			stranger.start(
				line => strangerLines.push(line),
				() => strangerClosed.resolve(),
			);
			stranger.send(JSON.stringify({ token: `${token}-wrong` }));
			stranger.send(JSON.stringify({ id: 1, method: "status", params: {} }));
			await strangerClosed.promise;
			expect(strangerLines).toEqual([]);

			// An authenticated connection replaces the supervisor's, which reconnects and replaces
			// this one in turn; the database and its unsaved edit are still there.
			const rival = await IpcConnection.connect(endpoint, { framing: "lines", timeoutMs: 5_000 });
			const rivalClosed = Promise.withResolvers<void>();
			rival.start(
				() => {},
				() => rivalClosed.resolve(),
			);
			rival.send(JSON.stringify({ token }));
			await rivalClosed.promise;
			expect(await worker.request("status", {})).toMatchObject({ open: true, idb: path.join(dir, "true.bndb") });
			expect(await ompFunctions(worker)).toBe("['omp_saved', 'omp_unsaved']");

			await worker.close({ save: false });
			expect(await worker.exited).toBe(0);

			worker = await open(storeLocation(dir, false));
			// A managed database reports the digests of its staged input.
			expect(await view(worker, "overview")).toContain(`sha256 ${await inputSha256()}\n`);
			expect(await ompFunctions(worker)).toBe("['omp_saved']");
			await worker.request("rename", { target: second[1], name: "omp_sigterm" });
			expect(worker.needsSave).toBe(true);
			process.kill(worker.pid, "SIGTERM");
			expect(await worker.exited).toBe(0);

			worker = await open(storeLocation(dir, false));
			expect(await ompFunctions(worker)).toBe("['omp_saved', 'omp_sigterm']");
			await worker.close({ save: false });
		},
		TEST_TIMEOUT_MS,
	);

	it.skipIf(!cc)(
		"lists as imports only what the loader resolves, resolves a name to the function rather than its PLT entry, and finds callers through the PLT entry and the import slot",
		async () => {
			const library = await buildLibrary();
			const dir = stageInput(library);
			const worker = await open(storeLocation(dir, true, library));

			const imports = await view(worker, "imports");
			const names = imports.split("\n").map(line => line.replace(/^0x[0-9a-f]+ {2}/, ""));
			expect(names).toContain("puts");
			// Binary Ninja also keeps the import as `dep_fn@DEP_1`.
			expect(names.filter(name => name.startsWith("dep_fn"))).toEqual(["dep_fn"]);
			// The PLT entry of the library's own `helper` is typed as an import.
			expect(names).not.toContain("helper");
			expect(await view(worker, "pseudocode", "helper")).toMatch(/\+ (41|0x29)\b/);

			// By name, `puts` is its PLT entry: `api` calls that, `direct` calls through the import
			// slot and `tail` jumps through it. The entry's own jump through the slot is no caller.
			expect((await exec(worker, "callers('puts')")).value).toBe("['api', 'direct', 'tail']");
			const byName = await view(worker, "xrefs", "puts");
			expect(byName).toMatch(/^0x[0-9a-f]+ {2}CALL {2}in api$/m);
			expect(byName).toMatch(/^0x[0-9a-f]+ {2}CALL {2}in direct$/m);
			expect(byName).toMatch(/^0x[0-9a-f]+ {2}CODE {2}in tail$/m);
			expect(byName).not.toMatch(/in puts$/m);
			// Binary Ninja names `tail` `puts` as well; it is not the entry, and nothing calls it.
			expect((await exec(worker, "callers('tail')")).value).toBe("[]");
			// The library's own `helper` is only reached through its PLT entry.
			expect((await exec(worker, "callers('helper')")).value).toBe("['api']");

			// Asked by address, the slot shows the plumbing as it is. Binary Ninja reports the
			// entry's jump as a call instruction; it is a jump.
			const slot = /^(0x[0-9a-f]+) {2}puts$/m.exec(imports)?.[1];
			if (!slot) throw new Error(`no import slot for puts in:\n${imports}`);
			const bySlot = await view(worker, "xrefs", slot);
			expect(bySlot).toMatch(/^0x[0-9a-f]+ {2}CODE {2}in puts$/m);
			expect(bySlot).toMatch(/^0x[0-9a-f]+ {2}CALL {2}in direct$/m);
			await worker.close({ save: false });
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"shows a function Binary Ninja skipped as disassembly and names the reason",
		async () => {
			const dir = stageInput();
			const worker = await open(storeLocation(dir, true));
			const skip = [
				"from binaryninja.enums import FunctionAnalysisSkipOverride",
				"func('_start').analysis_skip_override = FunctionAnalysisSkipOverride.AlwaysSkipFunctionAnalysis",
				"wait_analysis()",
			].join("\n");
			expect((await exec(worker, skip)).error).toBeNull();

			const [header, reason, ...body] = (await view(worker, "pseudocode", "_start")).split("\n");
			expect(header).toStartWith("// _start @ 0x");
			expect(reason).toContain("AlwaysSkipReason");
			expect(body.join("\n")).toBe(await view(worker, "asm", "_start"));
			await worker.close({ save: false });
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"writes nothing on a saving close of an unchanged database, and saves exec edits the dirty flags miss",
		async () => {
			const dir = stageInput();
			const database = path.join(dir, "true.bndb");
			const digest = async () =>
				new Bun.CryptoHasher("sha256").update(await Bun.file(database).bytes()).digest("hex");
			let worker = await open(storeLocation(dir, true));
			await worker.close({ save: true });
			expect(await worker.exited).toBe(0);
			const created = await digest();

			// Views read; a saving close after them leaves the file byte for byte as it was.
			worker = await open(storeLocation(dir, false));
			expect(await view(worker, "pseudocode", "_start")).toStartWith("// _start @ 0x");
			expect(worker.needsSave).toBe(false);
			await worker.close({ save: true });
			expect(await worker.exited).toBe(0);
			expect(await digest()).toBe(created);

			// Metadata raises neither dirty flag, yet it came from an exec: the saving close keeps it.
			worker = await open(storeLocation(dir, false));
			expect((await exec(worker, "bv.store_metadata('omp.note', 'kept')")).error).toBeNull();
			await worker.close({ save: true });
			expect(await worker.exited).toBe(0);
			expect(await digest()).not.toBe(created);
			worker = await open(storeLocation(dir, false));
			expect((await exec(worker, "bv.query_metadata('omp.note')")).value).toBe("'kept'");
			await worker.close({ save: false });
		},
		TEST_TIMEOUT_MS,
	);

	it.skipIf(isRoot)(
		"answers a creation it cannot write with an error and publishes no database",
		async () => {
			const dir = stageInput();
			const loc = storeLocation(dir, true);
			const worker = await spawn(loc);
			fs.chmodSync(dir, 0o555);

			await expect(worker.open(loc)).rejects.toThrow(/cannot create database .*true\.bndb/);
			expect(worker.opened).toBe(false);
			expect(fs.readdirSync(dir).filter(name => name !== "db.lock")).toEqual(["true"]);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"refuses a file that only carries the .bndb extension and leaves it untouched",
		async () => {
			const impostor = tmp.join("plain.bndb");
			fs.copyFileSync(INPUT, impostor);
			const loc = inPlaceLocation(impostor);
			const worker = await spawn(loc);

			await expect(worker.open(loc)).rejects.toThrow(/plain\.bndb is not a Binary Ninja database/);
			expect(worker.opened).toBe(false);
			expect(new Bun.CryptoHasher("sha256").update(await Bun.file(impostor).bytes()).digest("hex")).toBe(
				await inputSha256(),
			);
		},
		TEST_TIMEOUT_MS,
	);
});
