import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdExport, cmdImport, cmdRemember, runCli } from "@oh-my-pi/pi-mnemopi/cli";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mnemopi-ts-cli-errors-parity-"));
	process.env.MNEMOPI_DATA_DIR = root;
	process.env.MNEMOPI_NO_EMBEDDINGS = "1";
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	delete process.env.MNEMOPI_DATA_DIR;
	delete process.env.MNEMOPI_NO_EMBEDDINGS;
});

function capture() {
	let stdout = "";
	let stderr = "";
	return {
		context(dataDir = root) {
			return {
				dataDir,
				stdout: { write: (data: string) => (stdout += data) },
				stderr: { write: (data: string) => (stderr += data) },
			};
		},
		get stdout() {
			return stdout;
		},
		get stderr() {
			return stderr;
		},
	};
}

describe("CLI usage and operation failure parity", () => {
	it("reports missing required arguments as usage errors without tracebacks", async () => {
		for (const [args, expected] of [
			[["store"], "Usage: mnemopi store <content> [source] [importance]"],
			[["recall"], "Usage: mnemopi recall <query> [top_k]"],
			[["update", "missing-id"], "Usage: mnemopi update <memory_id> <new_content> [importance]"],
			[["delete"], "Usage: mnemopi delete <memory_id>"],
			[["import"], "Usage: mnemopi import <file.json>"],
			[["export"], "Usage: mnemopi export <file.json>"],
			[["bank"], "Usage: mnemopi bank <list|create|delete> [name]"],
		] as const) {
			const io = capture();
			expect(await runCli([...args], io.context())).toBe(2);
			expect(io.stdout).toBe("");
			expect(io.stderr).toContain(expected);
			expect(io.stderr).not.toContain("Traceback");
		}
	});

	it("reports parse errors and unknown commands without tracebacks", async () => {
		for (const [args, expected] of [
			[["store", "hello", "cli", "not-a-float"], "importance must be a number"],
			[["recall", "hello", "not-an-int"], "top_k must be an integer"],
			[["update", "missing-id", "new content", "not-a-float"], "importance must be a number"],
		] as const) {
			const io = capture();
			expect(await runCli([...args], io.context())).toBe(2);
			expect(io.stdout).toBe("");
			expect(io.stderr).toContain(expected);
			expect(io.stderr).not.toContain("Traceback");
		}

		const unknown = capture();
		expect(await runCli(["definitely-not-a-command"], unknown.context())).toBe(2);
		expect(unknown.stdout).toBe("");
		expect(unknown.stderr).toContain("Unknown command: definitely-not-a-command");
		expect(unknown.stderr).toContain("Run 'mnemopi --help' for usage.");
		expect(unknown.stderr).not.toContain("Traceback");
	});

	it("reports update/delete missing-memory operation failures with exit code 1", async () => {
		for (const args of [
			["update", "missing-id", "new content"],
			["delete", "missing-id"],
		] as const) {
			const io = capture();
			expect(await runCli([...args], io.context())).toBe(1);
			expect(io.stdout).toBe("");
			expect(io.stderr).toContain("Memory not found: missing-id");
			expect(io.stderr).not.toContain("Traceback");
		}
	});

	it("reports import file and JSON validation errors without tracebacks", async () => {
		const missing = capture();
		expect(await runCli(["import", join(root, "missing-file.json")], missing.context())).toBe(1);
		expect(missing.stderr).toContain("Import file not found");
		expect(missing.stderr).not.toContain("Traceback");

		for (const payload of ["[]", '"not an export"']) {
			const path = join(root, `not-object-${payload.length}.json`);
			writeFileSync(path, payload);
			const io = capture();
			expect(await runCli(["import", path], io.context())).toBe(1);
			expect(io.stdout).toBe("");
			expect(io.stderr).toContain("Import file must contain a Mnemopi export object");
			expect(io.stderr).not.toContain("Traceback");
		}

		const badJson = join(root, "bad.json");
		writeFileSync(badJson, "{not valid json");
		const malformed = capture();
		expect(await runCli(["import", badJson], malformed.context())).toBe(1);
		expect(malformed.stdout).toBe("");
		expect(malformed.stderr).toContain("Invalid JSON");
		expect(malformed.stderr).not.toContain("Traceback");
	});

	it("export and import report actual memory counts", async () => {
		const source = join(root, "source");
		const sourceIo = capture();
		expect(await cmdRemember(["exported memory", "cli", "0.7"], sourceIo.context(source))).toBe(0);
		const exportPath = join(root, "export.json");
		const exportIo = capture();
		expect(await cmdExport([exportPath], exportIo.context(source))).toBe(0);
		expect(exportIo.stdout).toContain("Exported 1 working, 0 episodic");
		expect(exportIo.stdout).not.toContain("Exported 0 memories");

		const importIo = capture();
		expect(await cmdImport([exportPath], importIo.context(join(root, "imported")))).toBe(0);
		expect(importIo.stdout).toContain("Imported 1 working, 0 episodic");
		expect(importIo.stdout).not.toContain("Imported 0 memories");
	});

	it("bank validation errors are user-facing", async () => {
		for (const [args, expected, code] of [
			[["bank", "create", "bad/name"], "Invalid bank name", 2],
			[["bank", "create"], "Usage: mnemopi bank create <name>", 2],
			[["bank", "delete"], "Usage: mnemopi bank delete <name>", 2],
			[["bank", "nope"], "Unknown bank command: nope", 2],
			[["bank", "delete", "missing_bank"], "Bank not found: missing_bank", 1],
		] as const) {
			const io = capture();
			expect(await runCli([...args], io.context())).toBe(code);
			expect(io.stdout).toBe("");
			expect(io.stderr).toContain(expected);
			expect(io.stderr).not.toContain("Traceback");
		}
	});
});
