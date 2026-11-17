import * as fs from "node:fs/promises";
import { type } from "@oh-my-pi/omptype";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { logger, untilAborted } from "@oh-my-pi/pi-utils";
import type { EvalPreludeDefinition } from "../eval/preludes";
import dsmDocumentation from "../prompts/tools/dsm.md" with { type: "text" };
import dsmGuidance from "../prompts/tools/dsm-guidance.md" with { type: "text" };
import type { ToolSession } from "../tools";
import { resolveToCwd } from "../tools/path-utils";
import { parseBinaryView } from "../tools/read-binary";
import { cfgToolsMaxTimeout } from "../tools/settings";
import { clampTimeout } from "../tools/tool-timeouts";
import { cfgDisasmBackend } from "./active";
import { DISASM_BACKENDS, type DisasmBackendId } from "./backend";
import { acquireDatabase, type DisasmDatabase, findDatabaseHandle, findOpenDatabase, listDatabases } from "./client";
// @ts-expect-error Bun imports this JavaScript source as text instead of evaluating its module shape.
import dsmJavascript from "./prelude.js" with { type: "text" };
import dsmPython from "./prelude.py" with { type: "text" };
import { parseDatabaseHandle } from "./protocol";
import { DSM_REFERENCES, type DsmReferenceOwner } from "./reference-owner";
import { isExecutableFile, locateDatabase, splitSliceRef } from "./store";

const REQUEST_TIMEOUT_MS = 120_000;
const handleFields = { lease: type("string > 0"), backend: type("'ida' | 'ghidra'") };
const target = type("string > 0").or("number.integer");
const paramsSchema = type({ action: "'open'", path: "string > 0", "+": "reject" })
	.or({ action: "'list'", "+": "reject" })
	.or({ action: "'get'", "ref?": "string > 0", "+": "reject" })
	.or({ ...handleFields, action: "'view'", "view?": "string", "+": "reject" })
	.or({ ...handleFields, action: "'exec'", code: "string > 0", "timeout?": "number", "+": "reject" })
	.or({ ...handleFields, action: "'rename'", target, name: "string > 0", "+": "reject" })
	.or({ ...handleFields, action: "'comment'", target, text: "string", "repeatable?": "boolean", "+": "reject" })
	.or({ ...handleFields, action: "'set_type'", target, decl: "string > 0", "+": "reject" })
	.or({ ...handleFields, action: "'make_function'", target, "+": "reject" })
	.or({ ...handleFields, action: "'save'", "+": "reject" })
	.or({ ...handleFields, action: "'close'", "save?": "boolean", "+": "reject" });

type DsmParams = typeof paramsSchema.infer;

interface ExecResult {
	output: string;
	value: string | null;
	error: string | null;
}

function releaseConversation(owner: DsmReferenceOwner): Promise<void> {
	owner.generation++;
	const references = [...owner.references.values()];
	owner.references.clear();
	const pending = [...owner.pending];
	// Detach synchronously, but let already-running calls settle before dropping their references.
	owner.cleanup = owner.cleanup.then(async () => {
		await Promise.allSettled(pending);
		await Promise.all(
			references.map(async entry => {
				if (!entry.db.connected) return;
				try {
					await entry.db.release(entry.reference.lease, { save: true });
				} catch (error) {
					logger.warn("dsm reference cleanup failed", { id: entry.db.id, error: String(error) });
				}
			}),
		);
	});
	return owner.cleanup;
}

/** Release only this session's dsm references, including in-flight retains; SDK disposal awaits it. */
export function releaseDsmReferences(session: ToolSession): Promise<void> {
	const owner = session[DSM_REFERENCES];
	if (!owner) return Promise.resolve();
	if (owner.disposed) return owner.cleanup;
	owner.disposed = true;
	for (const unregister of owner.unregister) unregister();
	owner.unregister.length = 0;
	return releaseConversation(owner);
}

function referenceOwner(session: ToolSession): DsmReferenceOwner {
	const existing = session[DSM_REFERENCES];
	if (existing) return existing;
	const owner: DsmReferenceOwner = {
		references: new Map(),
		pending: new Set(),
		generation: 0,
		disposed: false,
		cleanup: Promise.resolve(),
		unregister: [],
	};
	Object.defineProperty(session, DSM_REFERENCES, { value: owner, configurable: true });
	owner.unregister.push(
		cfgDisasmBackend.listen(session.settings, () => {
			void releaseConversation(owner);
		}),
	);
	const stopSession = session.registerSessionChangeCallback?.(() => {
		void releaseConversation(owner);
	});
	if (typeof stopSession === "function") owner.unregister.push(stopSession);
	const stopDispose = session.registerDisposeCallback?.(() => {
		void releaseDsmReferences(session);
	});
	if (typeof stopDispose === "function") owner.unregister.push(stopDispose);
	return owner;
}

function describeCall(parameters: unknown): string | undefined {
	const params = paramsSchema(parameters);
	if (params instanceof type.errors) return undefined;
	switch (params.action) {
		case "open":
			return `dsm.open(${JSON.stringify(params.path)})`;
		case "get":
			return `dsm.get(${params.ref === undefined ? "" : JSON.stringify(params.ref)})`;
		case "list":
			return "dsm.list()";
		case "view":
			return `dsm.view(${JSON.stringify(params.view ?? "overview")})`;
		case "rename":
			return `dsm.rename(${JSON.stringify(params.target)}, ${JSON.stringify(params.name)})`;
		case "comment":
		case "set_type":
		case "make_function":
			return `dsm.${params.action}(${JSON.stringify(params.target)})`;
		default:
			return `dsm.${params.action}()`;
	}
}

/** Hidden, backend-neutral disassembly capability with independently retained cross-agent database handles. */
export function createDsmPrelude(session: ToolSession): EvalPreludeDefinition {
	const owner = referenceOwner(session);
	const notOpen = () =>
		new ToolError("Database reference is closed or expired; reopen with dsm.open(path or handle).");
	const describe = (db: DisasmDatabase, backend: DisasmBackendId) => ({
		id: db.id,
		backend,
		ref: db.ref,
		path: db.idbPath,
		info: db.info,
		handle: db.handle,
		references: db.status.references,
	});
	const invoke = async (params: DsmParams, signal?: AbortSignal): Promise<unknown> => {
		const generation = owner.generation;
		await owner.cleanup;
		const active = (expected?: DisasmBackendId): DisasmBackendId => {
			signal?.throwIfAborted();
			if (owner.disposed || session.isDisposed?.() || owner.generation !== generation) {
				throw new ToolError("dsm session changed or was disposed; obtain a new database reference.");
			}
			const backend = cfgDisasmBackend.get(session.settings);
			if (backend === undefined) throw new ToolError("dsm is disabled in the current session.");
			if (expected !== undefined && backend !== expected)
				throw new ToolError("Disassembler backend changed; reopen with dsm.open(path or handle).");
			return backend;
		};
		const backend = active();
		const remember = async (db: DisasmDatabase, expected = db.handle) => {
			active(backend);
			const reference = await db.retain(expected);
			try {
				active(backend);
			} catch (error) {
				await db.release(reference.lease, { save: true });
				throw error;
			}
			owner.references.set(reference.lease, { backend, db, reference });
			return { ...describe(db, backend), lease: reference.lease, handle: reference.handle };
		};
		const openDatabases = async () => {
			const databases = new Map((await listDatabases(session, backend)).map(db => [db.handle, db]));
			for (const entry of owner.references.values()) {
				if (entry.backend !== backend || !entry.db.connected || databases.has(entry.db.handle)) continue;
				await entry.db.refresh();
				if (entry.db.status.state === "open") databases.set(entry.db.handle, entry.db);
			}
			active(backend);
			return [...databases.values()].filter(db => db.status.state === "open");
		};
		switch (params.action) {
			case "list":
				return (await openDatabases()).map(db => describe(db, backend));
			case "get": {
				if (params.ref === undefined) {
					const dbs = await openDatabases();
					if (dbs.length === 0) throw notOpen();
					if (dbs.length > 1)
						throw new ToolError(
							`Multiple databases open (${dbs.map(db => db.id).join(", ")}); pass dsm.get(ref).`,
						);
					return remember(dbs[0]);
				}
				const ref = params.ref;
				const owned = [...owner.references.values()].find(
					entry =>
						entry.backend === backend &&
						entry.db.connected &&
						(entry.db.id === ref || entry.db.name === ref || entry.db.ref === ref),
				);
				if (owned) return remember(owned.db);
				let db = await findOpenDatabase(session, backend, ref);
				active(backend);
				if (!db) {
					const { path, arch } = splitSliceRef(ref);
					const absolutePath = resolveToCwd(path, session.cwd);
					const stat = await fs.stat(absolutePath).catch(() => null);
					active(backend);
					if (!stat?.isFile()) throw notOpen();
					const loc = await locateDatabase(DISASM_BACKENDS[backend], absolutePath, { arch });
					active(backend);
					db = await findOpenDatabase(session, backend, loc.id);
				}
				if (!db) throw notOpen();
				return remember(db);
			}
			case "open": {
				const portable = parseDatabaseHandle(params.path);
				if (portable) {
					active(portable.backend);
					return remember(await findDatabaseHandle(portable), params.path);
				}
				const { path, arch } = splitSliceRef(params.path);
				const absolutePath = resolveToCwd(path, session.cwd);
				const stat = await fs.stat(absolutePath).catch(() => null);
				if (
					!stat?.isFile() ||
					(!DISASM_BACKENDS[backend].isDatabasePath(absolutePath) && !(await isExecutableFile(absolutePath)))
				) {
					throw new ToolError(`Not an executable or supported database: ${params.path}`);
				}
				active(backend);
				return remember(await acquireDatabase(session, backend, absolutePath, { arch, signal }));
			}
		}
		active(params.backend);
		const entry = owner.references.get(params.lease);
		if (!entry || entry.backend !== backend || !entry.db.connected) throw notOpen();
		await entry.db.refresh();
		active(params.backend);
		if (
			owner.references.get(params.lease) !== entry ||
			entry.db.status.state !== "open" ||
			entry.db.handle !== entry.reference.handle
		)
			throw notOpen();
		const db = entry.db;
		const options = { signal, timeoutMs: REQUEST_TIMEOUT_MS };
		switch (params.action) {
			case "view":
				return (await db.request<{ text: string }>("view", parseBinaryView(params.view ?? "overview"), options))
					.text;
			case "exec": {
				const seconds = clampTimeout("dsm", params.timeout, cfgToolsMaxTimeout.get(session.settings));
				return db.request<ExecResult>("exec", { code: params.code }, { signal, timeoutMs: seconds * 1000 });
			}
			case "rename":
				return db.request<unknown>("rename", { target: params.target, name: params.name }, options);
			case "comment":
				return db.request<unknown>(
					"comment",
					{ target: params.target, text: params.text, repeatable: params.repeatable ?? false },
					options,
				);
			case "set_type":
				return db.request<unknown>("set_type", { target: params.target, decl: params.decl }, options);
			case "make_function":
				return db.request<unknown>("make_function", { target: params.target }, options);
			case "save":
				return { path: (await db.request<{ idb: string }>("save", {}, options)).idb };
			case "close":
				owner.references.delete(params.lease);
				await db.release(entry.reference.lease, { save: params.save ?? true });
				return null;
		}
	};
	return {
		name: "dsm",
		documentation: dsmDocumentation,
		guidance: dsmGuidance,
		javascript: dsmJavascript,
		python: dsmPython,
		exports: ["dsm"],
		enabled: () => !owner.disposed && !session.isDisposed?.() && cfgDisasmBackend.get(session.settings) !== undefined,
		approval: parameters => {
			const parsed = paramsSchema(parameters);
			if (parsed instanceof type.errors || parsed.action === "exec") return "exec";
			return parsed.action === "list" || parsed.action === "get" || parsed.action === "view" ? "read" : "write";
		},
		invoke: async (parameters, context) => {
			const parsed = paramsSchema(parameters);
			if (parsed instanceof type.errors) throw new ToolError(`dsm received invalid arguments: ${parsed.summary}`);
			const pending = invoke(parsed, context.signal);
			owner.pending.add(pending);
			void pending.then(
				() => {
					owner.pending.delete(pending);
				},
				() => {
					owner.pending.delete(pending);
				},
			);
			return { content: [], details: { value: await untilAborted(context.signal, pending) } };
		},
		status: describeCall,
	};
}
