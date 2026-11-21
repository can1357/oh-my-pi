import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { IpcConnection, IpcServer, ipcEndpoint } from "@oh-my-pi/pi-natives";
import { Settings } from "../../src/config/settings";
import * as daemon from "../../src/daemon/client";
import type { DaemonClient, DaemonTunnel, UnitRef } from "../../src/daemon/protocol";
import { cfgDisasmBackend } from "../../src/disasm/active";
import type { DisasmBackendId } from "../../src/disasm/backend";
import * as client from "../../src/disasm/client";
import { createDsmPrelude, releaseDsmReferences } from "../../src/disasm/prelude-definition";
import {
	DISASM_UNIT_KIND,
	formatDatabaseHandle,
	type DatabaseHandle,
	type HostRequest,
	type HostStatus,
	parseDatabaseHandle,
	parseHostRequest,
} from "../../src/disasm/protocol";
import { disposeAllVmContexts } from "../../src/eval/js/context-manager";
import { executeJs } from "../../src/eval/js/executor";
import { invokeEvalPrelude } from "../../src/eval/preludes";
import { disposeAllKernelSessions, executePython } from "../../src/eval/py/executor";
import type { ToolSession } from "../../src/tools";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	try {
		for (const cleanup of cleanups.splice(0)) await cleanup();
	} finally {
		vi.restoreAllMocks();
	}
});
afterAll(async () => {
	await Promise.all([disposeAllVmContexts(), disposeAllKernelSessions()]);
});

function field(value: unknown, name: string): unknown {
	return value !== null && typeof value === "object" ? Reflect.get(value, name) : undefined;
}

/** Daemon stand-in whose `attach` dials the fixture's host endpoint; the fixture never uses anything else. */
function hostDaemon(endpoint: string): DaemonClient {
	const unused = async (): Promise<never> => {
		throw new Error("unused by the dsm fixture");
	};
	const noSubscription = () => () => {};
	return {
		welcome: { v: 1, daemon: { pid: process.pid, build: "test", startedAt: 0 }, caps: { [DISASM_UNIT_KIND]: 1 } },
		request: unused,
		open: unused,
		release: unused,
		call: unused,
		async attach(unit: UnitRef): Promise<DaemonTunnel> {
			if (typeof unit === "string") throw new Error("dsm attaches by (kind, scope, key)");
			const connection = await IpcConnection.connect(endpoint, { framing: "raw" });
			return {
				unit: {
					id: `unit-${unit.key}`,
					kind: unit.kind,
					scope: unit.scope,
					key: unit.key,
					label: unit.key,
					generation: "1",
					state: "running",
					pids: [],
					createdAt: 0,
					startedAt: 0,
					restartCount: 0,
					outputBytes: 0,
					leases: 0,
					policy: { hold: "leases", idleMs: 0, onIdle: "flush-stop", restart: "no", survive: "none" },
					supervised: true,
				},
				send: data => connection.send(data),
				drained: () => connection.drained(),
				start: (onData, onClose) => connection.startRaw(onData, onClose),
				close: () => connection.destroy(),
				ref: () => connection.ref(),
				unref: () => connection.unref(),
			};
		},
		onCompletion: noSubscription,
		onNotify: noSubscription,
		onUnit: noSubscription,
		onReconnect: noSubscription,
		close() {},
	};
}

/** Real connections and eval kernels; only backend computation and the daemon's unit routing are stand-ins. */
async function fixture(maxTimeout = 0, daemonBackend: DisasmBackendId = "ida") {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-dsm-prelude-"));
	const binary = path.join(dir, "sample");
	await Bun.write(binary, new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]));
	const endpoint = ipcEndpoint(dir, "dsm");
	const freshHandle = () =>
		formatDatabaseHandle({ backend: daemonBackend, id: "sample-id", instance: crypto.randomUUID() });
	const status: HostStatus = {
		id: "sample-id",
		ref: binary,
		handle: freshHandle(),
		references: 0,
		idbPath: path.join(dir, "sample.i64"),
		info: { module: "sample", format: "ELF", arch: "x86", bitness: 64 },
		state: "open",
		busy: false,
		lastUsed: Date.now(),
		current: null,
		dirty: false,
	};
	const requests: HostRequest[] = [];
	const connections: IpcConnection[] = [];
	const databases: client.DisasmDatabase[] = [];
	const sessions: ToolSession[] = [];
	const retained = new Set<string>();
	const waiting = Promise.withResolvers<void>();
	const canceled = Promise.withResolvers<void>();
	let open = true;
	const server = await IpcServer.listen(endpoint, { framing: "lines" }, connection => {
		connections.push(connection);
		const leases = new Set<string>();
		connection.start(
			line => {
				const request = parseHostRequest(line);
				requests.push(request);
				const error = (message: string) =>
					connection.send(JSON.stringify({ id: request.id, ok: false, error: message }));
				let result: unknown;
				if (request.op === "status" || request.op === "open")
					result = { ...status, state: open ? "open" : "opening" };
				else if (request.op === "retain") {
					if (!open || request.handle !== status.handle) return error("dsm handle has expired");
					const lease = crypto.randomUUID();
					leases.add(lease);
					retained.add(lease);
					status.references = retained.size;
					result = { lease, handle: status.handle, references: retained.size };
				} else if (request.op === "release") {
					if (!leases.has(request.lease) || !retained.has(request.lease)) return error("reference is not owned");
					leases.delete(request.lease);
					retained.delete(request.lease);
					status.references = retained.size;
					if (retained.size === 0) open = false;
					result = { references: retained.size };
				} else if (request.op === "close") {
					if (retained.size > 0) return error("active references");
					open = false;
					result = null;
				} else if (request.op === "cancel") {
					canceled.resolve();
					return;
				} else if (request.op === "call") {
					switch (request.method) {
						case "view":
							result = {
								text: `view:${field(request.params, "kind")}:${field(request.params, "target") ?? ""}`,
							};
							break;
						case "exec":
							if (field(request.params, "code") === "wait") {
								waiting.resolve();
								return;
							}
							result = { output: "printed\n", value: "42", error: "ValueError: preserved" };
							break;
						case "save":
							result = { idb: status.idbPath };
							break;
						case "rename":
							result = { ea: 4096, old: "main", new: field(request.params, "name") };
							break;
						case "comment":
							result = { ea: 4096 };
							break;
						case "set_type":
							result = { ea: 4096, type: field(request.params, "decl") };
							break;
						case "make_function":
							result = { ea: 4096, name: "created" };
							break;
					}
				}
				connection.send(JSON.stringify({ id: request.id, ok: true, result }));
			},
			() => {
				let abandoned = false;
				for (const lease of leases) abandoned = retained.delete(lease) || abandoned;
				leases.clear();
				status.references = retained.size;
				if (abandoned && retained.size === 0) open = false;
			},
		);
	});
	cleanups.push(async () => {
		await Promise.all(sessions.map(releaseDsmReferences));
		for (const db of databases) db.disconnect();
		for (const connection of connections) connection.destroy();
		await server.close();
		await fs.rm(dir, { recursive: true, force: true });
	});
	vi.spyOn(daemon, "daemonClient").mockResolvedValue(hostDaemon(endpoint));
	const connect = async () => {
		const connected = await client.DisasmDatabase.attach(`${daemonBackend}:sample-id`, "status");
		if (!connected) throw new Error("Fixture database did not attach");
		databases.push(connected);
		return connected;
	};
	let db = await connect();
	let backend: DisasmBackendId | undefined = daemonBackend;
	const computeBackend = cfgDisasmBackend.get.bind(cfgDisasmBackend);
	vi.spyOn(cfgDisasmBackend, "get").mockImplementation(() => backend);
	const find = vi
		.spyOn(client, "findOpenDatabase")
		.mockImplementation(async (selected, ref) =>
			open && selected === backend && (ref === status.id || ref === db.name) ? db : undefined,
		);
	const list = vi.spyOn(client, "listDatabases").mockImplementation(async () => (open ? [db] : []));
	const byHandle = vi.spyOn(client, "findDatabaseHandle").mockImplementation(async handle => {
		if (!open || formatDatabaseHandle(handle) !== status.handle) throw new Error("dsm handle has expired");
		return db;
	});
	const acquire = vi.spyOn(client, "acquireDatabase").mockImplementation(async () => {
		if (!open) {
			status.handle = freshHandle();
			retained.clear();
			status.references = 0;
		}
		open = true;
		if (!db.connected) db = await connect();
		await db.refresh();
		return db;
	});
	const makeOwner = () => {
		const callbacks = new Set<() => void>();
		const session: ToolSession = {
			cwd: dir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			settings: Settings.isolated({ "tools.maxTimeout": maxTimeout }),
			registerDisposeCallback: callback => {
				callbacks.add(callback);
				return () => {
					callbacks.delete(callback);
				};
			},
		};
		sessions.push(session);
		const prelude = createDsmPrelude(session);
		session.getEvalPreludes = () => [prelude];
		const invoke = async (parameters: unknown, signal?: AbortSignal) => {
			const result = await prelude.invoke(parameters, { session, toolCallId: "dsm-test", signal });
			return field(result.details, "value");
		};
		const getHandle = async () => {
			const value = await invoke({ action: "get" });
			const lease = field(value, "lease");
			if (typeof lease !== "string") throw new Error("Missing retained database reference");
			return { lease, backend: daemonBackend };
		};
		return {
			session,
			prelude,
			invoke,
			getHandle,
			async dispose() {
				for (const callback of callbacks) callback();
				callbacks.clear();
				await releaseDsmReferences(session);
			},
		};
	};
	return {
		...makeOwner(),
		dir,
		binary,
		status,
		requests,
		find,
		list,
		byHandle,
		acquire,
		waiting: waiting.promise,
		canceled: canceled.promise,
		child: makeOwner,
		get database() {
			return db;
		},
		setBackend(value: DisasmBackendId | undefined) {
			backend = value;
		},
		setBackendFromSettings(settings: Settings) {
			backend = computeBackend(settings);
		},
		setOpen(value: boolean) {
			open = value;
			if (!value) db.disconnect();
		},
		async replaceConnection() {
			retained.clear();
			status.references = 0;
			status.handle = freshHandle();
			db.disconnect();
			open = true;
			db = await connect();
		},
	};
}

describe("dsm host capability", () => {
	it("round-trips a radare2 dsm handle", () => {
		const handle: DatabaseHandle = {
			backend: "radare2",
			id: "sample-id",
			instance: crypto.randomUUID(),
		};
		expect(parseDatabaseHandle(formatDatabaseHandle(handle))).toEqual(handle);
	});

	it("dsm.open with backend radare2 routes calls through the r2 fixture", async () => {
		const f = await fixture(0, "radare2");
		const r2 = path.join(f.dir, "radare2");
		await Bun.write(r2, "");
		await fs.chmod(r2, 0o755);
		f.setBackendFromSettings(
			Settings.isolated({
				"ida.installDir": path.join(f.dir, "no-ida"),
				"radare2.r2Path": r2,
			}),
		);
		const opened = await f.invoke({ action: "open", path: "sample" });
		expect(field(opened, "backend")).toBe("radare2");
		expect(f.acquire).toHaveBeenCalledWith(f.session, "radare2", f.binary, expect.anything());
		expect(parseDatabaseHandle(String(field(opened, "handle")))?.backend).toBe("radare2");
		const handle = { lease: field(opened, "lease"), backend: "radare2" };
		expect(await f.invoke({ ...handle, action: "view" })).toBe("view:overview:");
		expect(await f.invoke({ ...handle, action: "rename", target: 4096, name: "r2_named" })).toEqual({
			ea: 4096,
			old: "main",
			new: "r2_named",
		});
		expect(f.requests).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ op: "call", method: "view" }),
				expect.objectContaining({ op: "call", method: "rename" }),
			]),
		);
		f.setBackend("ida");
		await expect(f.invoke({ ...handle, action: "view" })).rejects.toThrow("backend changed");
	});

	it("creates independent references only through explicit valid opens or existing get", async () => {
		const f = await fixture();
		const opened = await f.invoke({ action: "open", path: "sample" });
		expect(field(opened, "handle")).toBe(f.status.handle);
		const attached = await f.invoke({ action: "get", ref: f.status.id });
		expect(field(attached, "handle")).toBe(field(opened, "handle"));
		expect(field(attached, "lease")).not.toBe(field(opened, "lease"));
		expect(f.status.references).toBe(2);
		f.setOpen(false);
		await expect(f.invoke({ action: "get", ref: "sample" })).rejects.toThrow("dsm.open");
		expect(f.acquire).toHaveBeenCalledTimes(1);
		await Bun.write(path.join(f.dir, "text"), "not an executable");
		await expect(f.invoke({ action: "open", path: "text" })).rejects.toThrow("Not an executable");
		expect(f.acquire).toHaveBeenCalledTimes(1);
	});

	it("keeps explicit slice selection and accepts existing IDA databases", async () => {
		const f = await fixture();
		await f.invoke({ action: "open", path: "sample:@arm64e" });
		expect(f.acquire).toHaveBeenLastCalledWith(f.session, "ida", f.binary, { arch: "arm64e", signal: undefined });
		const databasePath = path.join(f.dir, "existing.i64");
		await Bun.write(databasePath, "database");
		await f.invoke({ action: "open", path: "existing.i64" });
		expect(f.acquire).toHaveBeenLastCalledWith(f.session, "ida", databasePath, {
			arch: undefined,
			signal: undefined,
		});
	});

	it("rejects another backend's database file by naming its owner", async () => {
		const f = await fixture();
		const binjaDatabase = path.join(f.dir, "existing.bndb");
		await Bun.write(binjaDatabase, "database");
		await Bun.write(path.join(f.dir, "existing.i64"), "database");
		await expect(f.invoke({ action: "open", path: "existing.bndb" })).rejects.toThrow(
			"Binary Ninja database existing.bndb cannot be opened with the active IDA backend; set disassembler.backend to binja.",
		);
		f.setBackend("ghidra");
		await expect(f.invoke({ action: "open", path: "existing.i64" })).rejects.toThrow(
			"IDA database existing.i64 cannot be opened with the active Ghidra backend; set disassembler.backend to ida.",
		);
		f.setBackend("binja");
		await expect(f.invoke({ action: "open", path: "existing.i64" })).rejects.toThrow(
			"IDA database existing.i64 cannot be opened with the active Binary Ninja backend; set disassembler.backend to ida.",
		);
		expect(f.acquire).not.toHaveBeenCalled();
		await f.invoke({ action: "open", path: "existing.bndb" });
		expect(f.acquire).toHaveBeenLastCalledWith(f.session, "binja", binjaDatabase, {
			arch: undefined,
			signal: undefined,
		});
	});

	it("keeps closed references invalid across a reopen or host replacement", async () => {
		const f = await fixture();
		const handle = await f.getHandle();
		await f.invoke({ ...handle, action: "close", save: false });
		expect(f.requests).toContainEqual(expect.objectContaining({ op: "release", save: false }));
		await f.invoke({ action: "open", path: "sample" });
		await expect(f.invoke({ ...handle, action: "view" })).rejects.toThrow("dsm.open");
		const replacementHandle = await f.getHandle();
		await f.replaceConnection();
		await expect(f.invoke({ ...replacementHandle, action: "exec", code: "42" })).rejects.toThrow("dsm.open");
		expect(f.requests.filter(request => request.op === "call")).toHaveLength(0);
	});

	it("shares a printable handle with a child without letting that child close its parent's reference", async () => {
		const f = await fixture();
		const parent = await f.invoke({ action: "open", path: "sample" });
		const child = f.child();
		const imported = await child.invoke({ action: "open", path: field(parent, "handle") });
		expect(f.byHandle).toHaveBeenCalledWith(expect.objectContaining({ backend: "ida", id: f.status.id }));
		await child.invoke({ action: "close", lease: field(imported, "lease"), backend: "ida" });
		expect(f.status.references).toBe(1);
		expect(
			await f.invoke({ action: "exec", lease: field(parent, "lease"), backend: "ida", code: "42" }),
		).toMatchObject({ value: "42" });
		await child.dispose();
		expect(f.status.references).toBe(1);
		await f.dispose();
		expect(f.status.references).toBe(0);
	});

	it("drains an in-flight retain on disposal without releasing a child's reference", async () => {
		const f = await fixture();
		const parent = await f.invoke({ action: "open", path: "sample" });
		const child = f.child();
		await child.invoke({ action: "open", path: field(parent, "handle") });
		const original = f.database.retain.bind(f.database);
		const started = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		vi.spyOn(f.database, "retain").mockImplementationOnce(async expected => {
			started.resolve();
			await gate.promise;
			return original(expected);
		});
		const opening = f.invoke({ action: "open", path: "sample" });
		await started.promise;
		const disposing = f.dispose();
		gate.resolve();
		await expect(opening).rejects.toThrow("disposed");
		await disposing;
		expect(f.status.references).toBe(1);
	});

	it("rejects disabled and switched backends before accessing their databases", async () => {
		const f = await fixture();
		const handle = await f.getHandle();
		f.setBackend("ghidra");
		await expect(f.invoke({ ...handle, action: "save" })).rejects.toThrow("backend changed");
		await expect(f.invoke({ ...handle, backend: "ghidra", action: "save" })).rejects.toThrow("dsm.open");
		f.setBackend(undefined);
		expect(f.prelude.enabled?.()).toBe(false);
		await expect(
			invokeEvalPrelude("dsm", { action: "list" }, { session: f.session, toolCallId: "disabled" }),
		).rejects.toThrow("not enabled");
	});

	it("classifies validated actions for approval and fails invalid arguments closed", async () => {
		const f = await fixture();
		const handle = await f.getHandle();
		const approval = f.prelude.approval;
		if (typeof approval !== "function") throw new Error("Expected argument-dependent approval");
		for (const parameters of [{ action: "list" }, { action: "get" }, { ...handle, action: "view" }])
			expect(approval(parameters)).toBe("read");
		for (const parameters of [
			{ action: "open", path: f.binary },
			{ ...handle, action: "save" },
			{ ...handle, action: "close" },
			{ ...handle, action: "rename", target: 4096, name: "new" },
			{ ...handle, action: "comment", target: "main", text: "" },
			{ ...handle, action: "set_type", target: "main", decl: "int main()" },
			{ ...handle, action: "make_function", target: "main" },
		])
			expect(approval(parameters)).toBe("write");
		expect(approval({ ...handle, action: "exec", code: "42" })).toBe("exec");
		for (const parameters of [
			{ action: "list", code: "hidden" },
			{ ...handle, action: "view", timeout: 1 },
			{ action: "close" },
		]) {
			expect(approval(parameters)).toBe("exec");
			await expect(f.invoke(parameters)).rejects.toThrow("invalid arguments");
		}
	});

	it("caps exec deadlines and forwards cancellation to the real database connection", async () => {
		const f = await fixture(7);
		const handle = await f.getHandle();
		expect(await f.invoke({ ...handle, action: "exec", code: "42", timeout: 9000 })).toEqual({
			output: "printed\n",
			value: "42",
			error: "ValueError: preserved",
		});
		expect(f.requests).toContainEqual(expect.objectContaining({ op: "call", method: "exec", timeoutMs: 7000 }));
		expect(await f.invoke({ ...handle, action: "save" })).toEqual({ path: f.status.idbPath });
		const controller = new AbortController();
		const pending = f.invoke({ ...handle, action: "exec", code: "wait" }, controller.signal);
		await f.waiting;
		controller.abort(new Error("stop this cell"));
		await expect(pending).rejects.toThrow("stop this cell");
		await f.canceled;
	});
});

describe("dsm in real eval runtimes", () => {
	for (const language of ["js", "py"]) {
		it(`dispatches ${language} retained handles and preserves structured worker results`, async () => {
			const f = await fixture();
			const reportPath = path.join(f.dir, "result.json");
			const code =
				language === "js"
					? [
							'globalThis.db = await dsm.open("sample");',
							"const result = { metadata: [db.id, db.backend, db.ref, db.path, db.info], portable: db.handle(), list: await dsm.list(), same: (await dsm.get()).id === db.id };",
							'result.view = await db.view(); result.asm = await db.view("main:asm"); result.xrefs = await db.view("xrefs:main");',
							'result.exec = await db.exec("6 * 7"); result.rename = await db.rename(4096, "renamed");',
							'result.comment = await db.comment("renamed", "note", { repeatable: true });',
							'result.type = await db.setType("renamed", "int renamed()"); result.function = await db.makeFunction("0x1000");',
							"result.save = await db.save(); print(db.handle()); await db.close({ save: false });",
							'try { await db.exec("42"); } catch (error) { result.closed = error.message.includes("dsm.open"); }',
							`await Bun.write(${JSON.stringify(reportPath)}, JSON.stringify(result));`,
						].join("\n")
					: [
							"import json",
							"from pathlib import Path",
							'db = await dsm.open("sample")',
							'result = {"metadata": [db.id, db.backend, db.ref, db.path, db.info], "portable": db.handle(), "list": await dsm.list(), "same": (await dsm.get()).id == db.id}',
							'result["view"] = await db.view()',
							'result["asm"] = await db.view("main:asm")',
							'result["xrefs"] = await db.view("xrefs:main")',
							'result["exec"] = await db.exec("6 * 7")',
							'result["rename"] = await db.rename(4096, "renamed")',
							'result["comment"] = await db.comment("renamed", "note", repeatable=True)',
							'result["type"] = await db.set_type("renamed", "int renamed()")',
							'result["function"] = await db.make_function("0x1000")',
							'result["save"] = await db.save()',
							"print(db.handle())",
							"await db.close(save=False)",
							"try:",
							'    await db.exec("42")',
							"except Exception as error:",
							'    result["closed"] = "dsm.open" in str(error)',
							`Path(${JSON.stringify(reportPath)}).write_text(json.dumps(result), encoding="utf-8")`,
						].join("\n");
			const sessionId = `dsm-${language}-${crypto.randomUUID()}`;
			const result =
				language === "js"
					? await executeJs(code, { cwd: f.dir, sessionId, session: f.session })
					: await executePython(code, { cwd: f.dir, sessionId, toolSession: f.session, kernelMode: "per-call" });
			expect(result.exitCode).toBe(0);
			expect(result.output.split("\n")[0]).toBe(f.status.handle);
			const report: unknown = await Bun.file(reportPath).json();
			expect(report).toEqual({
				metadata: [f.status.id, "ida", f.binary, f.status.idbPath, f.status.info],
				portable: f.status.handle,
				list: [
					{
						id: f.status.id,
						backend: "ida",
						ref: f.binary,
						path: f.status.idbPath,
						info: f.status.info,
						handle: f.status.handle,
						references: 1,
					},
				],
				same: true,
				view: "view:overview:",
				asm: "view:asm:main",
				xrefs: "view:xrefs:main",
				exec: { output: "printed\n", value: "42", error: "ValueError: preserved" },
				rename: { ea: 4096, old: "main", new: "renamed" },
				comment: { ea: 4096 },
				type: { ea: 4096, type: "int renamed()" },
				function: { ea: 4096, name: "created" },
				save: { path: f.status.idbPath },
				closed: true,
			});
			expect(f.requests).toContainEqual(expect.objectContaining({ op: "release", save: false }));
		}, 60_000);
	}
});
