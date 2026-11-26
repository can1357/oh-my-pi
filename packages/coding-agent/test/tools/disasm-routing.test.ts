import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgDisasmBackend } from "@oh-my-pi/pi-coding-agent/disasm/active";
import { DISASM_BACKENDS, type DisasmBackendId } from "@oh-my-pi/pi-coding-agent/disasm/backend";
import * as client from "@oh-my-pi/pi-coding-agent/disasm/client";
import { locateDatabase, prepareStoreDir } from "@oh-my-pi/pi-coding-agent/disasm/store";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { readBinary } from "@oh-my-pi/pi-coding-agent/tools/read-binary";
import { parseSel } from "@oh-my-pi/pi-coding-agent/tools/read-selector";
import type { ReadToolDetails } from "@oh-my-pi/pi-coding-agent/tools/details/read";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";

const BOUNDARY = "analysis boundary reached";

/** Real SQLite-format bytes holding one `probe_rows` table. */
function sqliteBytes(): Uint8Array {
	const db = new Database(":memory:");
	try {
		db.run("CREATE TABLE probe_rows (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
		db.run("INSERT INTO probe_rows (name) VALUES ('Alice')");
		return db.serialize();
	} finally {
		db.close();
	}
}

function textOutput(result: AgentToolResult<ReadToolDetails>): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

let root: string;
let session: ToolSession;
beforeEach(async () => {
	// Resolved up front: macOS temp directories sit behind a symlink.
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "disasm-routing-")));
	session = {
		cwd: root,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"disassembler.backend": "none",
			"read.summarize.enabled": false,
			"edit.mode": "hashline",
		}),
	};
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

async function fixture(bytes: Uint8Array, name: string): Promise<string> {
	const file = path.join(root, name);
	await Bun.write(file, bytes);
	return file;
}

/** Stop at the analysis boundary: the spy records what the disassembler route asked for. */
function spyOnAcquire() {
	return spyOn(client, "acquireDatabase").mockImplementation(async () => {
		throw new Error(BOUNDARY);
	});
}

describe("read routing of a SQLite-format disassembler database", () => {
	it("sends x.bndb:overview to the disassembler route, not the SQLite reader", async () => {
		const file = await fixture(sqliteBytes(), "x.bndb");
		const backend = spyOn(cfgDisasmBackend, "get").mockReturnValue("binja");
		const acquire = spyOnAcquire();
		try {
			await expect(new ReadTool(session).execute("bndb-overview", { path: "x.bndb:overview" })).rejects.toThrow(
				BOUNDARY,
			);
			expect(acquire).toHaveBeenCalledTimes(1);
			expect(acquire.mock.calls[0]?.slice(1, 3)).toEqual(["binja", file]);
		} finally {
			acquire.mockRestore();
			backend.mockRestore();
		}
	});

	it("reports a disabled backend for x.bndb:overview instead of looking up a table", async () => {
		await fixture(sqliteBytes(), "x.bndb");
		await expect(new ReadTool(session).execute("bndb-disabled", { path: "x.bndb:overview" })).rejects.toThrow(
			"set disassembler.backend to auto, ida, ghidra, or binja",
		);
	});

	it("shows database metadata for a bare x.bndb without opening it", async () => {
		await fixture(sqliteBytes(), "x.bndb");
		const acquire = spyOnAcquire();
		try {
			const text = textOutput(await new ReadTool(session).execute("bndb-metadata", { path: "x.bndb" }));
			expect(text).toContain("Binary Ninja database (.bndb)");
			expect(text).toContain("database not opened");
			expect(text).toContain("auto, ida, ghidra, or binja");
			expect(text).not.toContain("probe_rows");
			expect(acquire).not.toHaveBeenCalled();
		} finally {
			acquire.mockRestore();
		}
	});

	it("keeps :raw byte-verbatim for x.bndb", async () => {
		await fixture(sqliteBytes(), "x.bndb");
		const raw = await new ReadTool(session).execute("bndb-raw", { path: "x.bndb:raw" });
		expect(textOutput(raw)).toContain("SQLite format 3");
	});

	it("still reads ordinary SQLite files as SQLite, whatever their extension", async () => {
		await fixture(sqliteBytes(), "data.db");
		await fixture(sqliteBytes(), "History");
		const acquire = spyOnAcquire();
		try {
			const tool = new ReadTool(session);
			expect(textOutput(await tool.execute("sqlite-tables", { path: "data.db" }))).toContain("probe_rows");
			expect(textOutput(await tool.execute("sqlite-rows", { path: "data.db:probe_rows" }))).toContain("Alice");
			expect(textOutput(await tool.execute("sqlite-sniffed", { path: "History:probe_rows" }))).toContain("Alice");
			expect(acquire).not.toHaveBeenCalled();
		} finally {
			acquire.mockRestore();
		}
	});

	it("reads a literal file named x.bndb:overview as that file", async () => {
		await fixture(sqliteBytes(), "x.bndb");
		await fixture(Buffer.from("literal contents"), "x.bndb:overview");
		const result = await new ReadTool(session).execute("bndb-literal", { path: "x.bndb:overview" });
		expect(textOutput(result)).toContain("literal contents");
	});
});

describe("database ownership in read", () => {
	const cases: Array<[string, DisasmBackendId, string]> = [
		["x.bndb", "ida", "Binary Ninja databases require disassembler.backend=binja"],
		["x.bndb", "ghidra", "Binary Ninja databases require disassembler.backend=binja"],
		["x.i64", "binja", "IDA databases require disassembler.backend=ida"],
		["x.idb", "binja", "IDA databases require disassembler.backend=ida"],
	];
	for (const [name, backend, message] of cases) {
		it(`rejects ${name} under ${backend}, naming the owner`, async () => {
			const file = await fixture(sqliteBytes(), name);
			const acquire = spyOnAcquire();
			try {
				await expect(
					readBinary(session, { backend, absolutePath: file, view: "overview" }, parseSel(undefined)),
				).rejects.toThrow(message);
				expect(acquire).not.toHaveBeenCalled();
			} finally {
				acquire.mockRestore();
			}
		});
	}

	it("opens a database under its own backend", async () => {
		const file = await fixture(sqliteBytes(), "x.bndb");
		const acquire = spyOnAcquire();
		try {
			await expect(
				readBinary(session, { backend: "binja", absolutePath: file, view: "overview" }, parseSel(undefined)),
			).rejects.toThrow(BOUNDARY);
			expect(acquire).toHaveBeenCalledTimes(1);
		} finally {
			acquire.mockRestore();
		}
	});
});

describe("single writer for in-place databases", () => {
	let originalAgentDir: string;
	beforeEach(() => {
		originalAgentDir = getAgentDir();
	});
	afterEach(() => {
		setAgentDir(originalAgentDir);
	});

	/** Locate a binary's managed store location and put a database file where its unit would save one. */
	async function managedDatabase(backend: DisasmBackendId) {
		const descriptor = DISASM_BACKENDS[backend];
		const binary = await fixture(Buffer.from("\u007fELF fixture"), "sample.bin");
		const managed = await locateDatabase(descriptor, binary);
		await fs.mkdir(managed.dir, { recursive: true });
		const database = path.join(managed.dir, descriptor.databaseName("sample.bin"));
		await Bun.write(database, sqliteBytes());
		return { descriptor, managed, database };
	}

	for (const backend of ["ida", "binja"] as const) {
		it(`locks a managed ${backend} database opened by its own path with the store directory's lock`, async () => {
			setAgentDir(path.join(root, "agent"));
			const { descriptor, managed, database } = await managedDatabase(backend);
			expect(managed.kind).toBe("store");

			const direct = await locateDatabase(descriptor, database);
			expect(direct.kind).toBe("inplace");
			expect(direct.lockTarget).toBe(managed.lockTarget);
			expect(direct.lockTarget).toBe(path.join(managed.dir, "db"));
			expect(direct.openPath).toBe(database);
		});
	}

	it("resolves a symlink to a managed database to the same lock and identity", async () => {
		setAgentDir(path.join(root, "agent"));
		const { descriptor, managed, database } = await managedDatabase("binja");
		const link = path.join(root, "alias.bndb");
		await fs.symlink(database, link);

		const direct = await locateDatabase(descriptor, database);
		const viaLink = await locateDatabase(descriptor, link);
		expect(viaLink.lockTarget).toBe(managed.lockTarget);
		expect(viaLink.id).toBe(direct.id);
		expect(viaLink.openPath).toBe(database);
	});

	it("matches the managed lock when the agent directory itself is reached through a symlink", async () => {
		await fs.mkdir(path.join(root, "real-agent"));
		await fs.symlink(path.join(root, "real-agent"), path.join(root, "agent-link"));
		setAgentDir(path.join(root, "agent-link"));
		const { descriptor, managed, database } = await managedDatabase("binja");

		expect((await locateDatabase(descriptor, database)).lockTarget).toBe(managed.lockTarget);
	});

	it("keeps a database outside the store on its own lock, shared by its symlinks", async () => {
		setAgentDir(path.join(root, "agent"));
		const database = await fixture(sqliteBytes(), "mine.bndb");
		const link = path.join(root, "alias.bndb");
		await fs.symlink(database, link);
		// Two levels below the agent dir is not enough: only `<storeDir>/<id>/` is managed.
		const nested = await fixture(sqliteBytes(), path.join("agent", "other", "id", "x.bndb"));

		const own = await locateDatabase(DISASM_BACKENDS.binja, database);
		expect(own.lockTarget).toBe(database);
		expect(own.dir).toBe(root);
		const viaLink = await locateDatabase(DISASM_BACKENDS.binja, link);
		expect(viaLink.lockTarget).toBe(database);
		expect(viaLink.id).toBe(own.id);
		expect((await locateDatabase(DISASM_BACKENDS.binja, nested)).lockTarget).toBe(nested);
	});

	it("refuses an in-place database its own application has unpacked, for a backend that unpacks one", async () => {
		setAgentDir(path.join(root, "agent"));
		// IDA unpacks `<name>.id0` beside a database while it has it open.
		const idb = await fixture(sqliteBytes(), "open.i64");
		await fixture(new Uint8Array(), "open.id0");
		await expect(
			prepareStoreDir(DISASM_BACKENDS.ida, await locateDatabase(DISASM_BACKENDS.ida, idb)),
		).rejects.toThrow(/appears open in IDA \(unpacked \.id0 present\)/);

		// Binary Ninja unpacks nothing: the same stray sibling does not block a `.bndb`.
		const bndb = await fixture(sqliteBytes(), "open.bndb");
		const location = await locateDatabase(DISASM_BACKENDS.binja, bndb);
		await prepareStoreDir(DISASM_BACKENDS.binja, location);
		expect(location.openPath).toBe(bndb);
	});
});
