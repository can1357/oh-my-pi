import * as fs from "node:fs/promises";
import { type } from "@oh-my-pi/omptype";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import type { OutputMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import { enforceInlineByteCap } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { prompt } from "@oh-my-pi/pi-utils";
import {
	acquireDatabase,
	cfgDisasmBackend,
	DISASM_BACKENDS,
	type DisasmBackendId,
	findOpenDatabase,
	type DisasmDatabase,
	listDatabases,
	locateDatabase,
	splitSliceRef,
} from "../disasm";
import idaDescription from "../prompts/tools/ida.md" with { type: "text" };
import ghidraDescription from "../prompts/tools/ghidra.md" with { type: "text" };
import type { ToolSession } from ".";
import { truncateForPrompt } from "./approval";
import { saveArtifactText } from "./gh-common";
import { resolveToCwd } from "./path-utils";
import { cfgToolsMaxTimeout } from "./settings";
import { toolResult } from "./tool-result";
import { clampTimeout } from "./tool-timeouts";

/** Timeout for structured edit/save RPCs against a disassembler worker. */
const DISASM_EDIT_TIMEOUT_MS = 120_000;

const disasmSchema = type({
	action: type.enumerated("list", "open", "save", "close", "exec", "rename", "comment", "set_type", "make_function"),
	"db?": type("string").describe(
		"binary path (IDA also .i64/.idb), or open db id; optional when exactly one db is open",
	),
	"target?": type("string").describe("symbol name or 0x address"),
	"name?": type("string").describe("new name (rename)"),
	"text?": type("string").describe("comment text"),
	"repeatable?": type("boolean").describe("repeatable comment"),
	"decl?": type("string").describe("C declaration (set_type)"),
	"code?": type("string").describe("Python for exec; namespace persists per db"),
	"save?": type("boolean").describe("close: save first (default true)"),
	"timeout?": type("number").describe("exec timeout seconds"),
});

/** Parameters accepted by either disassembler tool. */
export type DisasmParams = typeof disasmSchema.infer;
/** Actions supported by either disassembler tool. */
export type DisasmAction = DisasmParams["action"];

/** Structured details attached to disassembler tool results. */
export interface DisasmToolDetails {
	action: DisasmAction;
	db?: string;
	meta?: OutputMeta;
}

interface ExecResult {
	output: string;
	value: string | null;
	error: string | null;
}

function stringArg(args: unknown, key: string): string | undefined {
	if (typeof args !== "object" || args === null || !(key in args)) return undefined;
	const value: unknown = Reflect.get(args, key);
	return typeof value === "string" ? value : undefined;
}

function requireArg(value: string | undefined, name: string, action: DisasmAction): string {
	if (value === undefined || value.trim() === "") throw new ToolError(`${name} is required for ${action}`);
	return value;
}

/** Lifecycle, edits, and Python scripting for backend databases shared across agents. */
export class DisasmTool implements AgentTool<typeof disasmSchema, DisasmToolDetails> {
	readonly name: DisasmBackendId;
	readonly approval = (args: unknown): ToolApprovalDecision => {
		const action = stringArg(args, "action");
		if (action === "list") return "read";
		if (action === "exec") return "exec";
		return "write";
	};
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const lines = [`Action: ${stringArg(args, "action") ?? "(missing)"}`];
		const db = stringArg(args, "db");
		if (db) lines.push(`DB: ${truncateForPrompt(db)}`);
		const target = stringArg(args, "target");
		if (target) lines.push(`Target: ${truncateForPrompt(target)}`);
		const code = stringArg(args, "code");
		if (code) lines.push(`Code: ${truncateForPrompt(code)}`);
		return lines;
	};
	readonly label: string;
	readonly summary: string;
	readonly description: string;
	readonly parameters = disasmSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";

	constructor(
		private readonly session: ToolSession,
		backend: DisasmBackendId,
	) {
		this.name = backend;
		this.label = DISASM_BACKENDS[backend].label;
		this.summary =
			backend === "ida"
				? "Open, edit, and script IDA Pro databases shared across agents"
				: "Open, edit, and script Ghidra programs shared across agents";
		this.description = prompt.render(backend === "ida" ? idaDescription : ghidraDescription);
	}

	/** Create the tool only when its backend serves this session. */
	static createIf(session: ToolSession, backend: DisasmBackendId): DisasmTool | null {
		return cfgDisasmBackend.get(session.settings) === backend ? new DisasmTool(session, backend) : null;
	}

	async execute(
		_toolCallId: string,
		params: DisasmParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<DisasmToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<DisasmToolDetails>> {
		const details: DisasmToolDetails = { action: params.action };
		const result = toolResult(details);
		switch (params.action) {
			case "list": {
				const dbs = await listDatabases(this.session, this.name);
				if (dbs.length === 0) return result.text(`No ${this.label} databases open.`).done();
				const lines = dbs.map(db => {
					const { state, info, current } = db.status;
					if (state === "opening") return `${db.id}  (opening)  ${shortenPath(db.ref)}`;
					const running = current ? `  [${current.method} running]` : "";
					return `${db.id}  ${info.module}  ${info.format}  ${info.arch}/${info.bitness}  ${shortenPath(db.idbPath)}${running}`;
				});
				return result.text(lines.join("\n")).done();
			}
			case "open": {
				const ref = requireArg(params.db, "db", params.action);
				const db = await this.#resolveDb(ref, true, signal);
				details.db = db.id;
				const { module, format, arch, bitness } = db.info;
				return result
					.text(
						`Opened ${db.id} (${module}, ${format}, ${arch} ${bitness}-bit) → ${shortenPath(db.idbPath)}. read ${shortenPath(db.ref)} for the overview.`,
					)
					.done();
			}
			case "save": {
				const db = await this.#resolveDb(params.db, false, signal);
				details.db = db.id;
				const { idb } = await db.request<{ idb: string }>(
					"save",
					{},
					{ signal, timeoutMs: DISASM_EDIT_TIMEOUT_MS },
				);
				return result.text(`Saved ${shortenPath(idb)}`).done();
			}
			case "close": {
				const db = await this.#resolveDb(params.db, false, signal);
				details.db = db.id;
				const save = params.save ?? true;
				await db.close({ save });
				return result.text(`Closed ${db.id}${save ? " (saved)" : " (discarded unsaved changes)"}`).done();
			}
			case "rename": {
				const target = requireArg(params.target, "target", params.action);
				const name = requireArg(params.name, "name", params.action);
				const db = await this.#resolveDb(params.db, true, signal);
				details.db = db.id;
				const res = await db.request<{ ea: string; old: string; new: string }>(
					"rename",
					{ target, name },
					{ signal, timeoutMs: DISASM_EDIT_TIMEOUT_MS },
				);
				return result.text(`Renamed ${res.ea} ${res.old || "(unnamed)"} → ${res.new}`).done();
			}
			case "comment": {
				const target = requireArg(params.target, "target", params.action);
				const text = requireArg(params.text, "text", params.action);
				const db = await this.#resolveDb(params.db, true, signal);
				details.db = db.id;
				const repeatable = params.repeatable ?? false;
				const res = await db.request<{ ea: string }>(
					"comment",
					{ target, text, repeatable },
					{ signal, timeoutMs: DISASM_EDIT_TIMEOUT_MS },
				);
				return result.text(`Set ${repeatable ? "repeatable " : ""}comment at ${res.ea}`).done();
			}
			case "set_type": {
				const target = requireArg(params.target, "target", params.action);
				const decl = requireArg(params.decl, "decl", params.action);
				const db = await this.#resolveDb(params.db, true, signal);
				details.db = db.id;
				const res = await db.request<{ ea: string; type: string }>(
					"set_type",
					{ target, decl },
					{ signal, timeoutMs: DISASM_EDIT_TIMEOUT_MS },
				);
				return result.text(`Typed ${res.ea} as ${res.type}`).done();
			}
			case "make_function": {
				const target = requireArg(params.target, "target", params.action);
				const db = await this.#resolveDb(params.db, true, signal);
				details.db = db.id;
				const res = await db.request<{ ea: string; name: string }>(
					"make_function",
					{ target },
					{ signal, timeoutMs: DISASM_EDIT_TIMEOUT_MS },
				);
				return result.text(`Created function ${res.name} at ${res.ea}`).done();
			}
			case "exec": {
				const code = requireArg(params.code, "code", params.action);
				const db = await this.#resolveDb(params.db, true, signal);
				details.db = db.id;
				const timeoutSec = clampTimeout(this.name, params.timeout, cfgToolsMaxTimeout.get(this.session.settings));
				const res = await db.request<ExecResult>("exec", { code }, { signal, timeoutMs: timeoutSec * 1000 });
				const parts: string[] = [];
				if (res.output) parts.push(res.output.trimEnd());
				if (res.value !== null) parts.push(`=> ${res.value}`);
				if (res.error !== null) parts.push(res.error.trimEnd());
				const text = await enforceInlineByteCap(parts.length > 0 ? parts.join("\n") : "(no output)", {
					saveArtifact: full => saveArtifactText(this.session, this.name, full).catch(() => undefined),
				});
				return result
					.text(text)
					.error(res.error !== null)
					.done();
			}
		}
	}

	/** Resolve `db` (id, path, or omitted) to an open database; `open` opens/creates it when needed. */
	async #resolveDb(ref: string | undefined, open: boolean, signal?: AbortSignal): Promise<DisasmDatabase> {
		if (!ref) {
			const dbs = (await listDatabases(this.session, this.name)).filter(db => db.status.state === "open");
			if (dbs.length === 0) throw new ToolError(`No ${this.label} database open; pass db=<binary path>`);
			if (dbs.length > 1)
				throw new ToolError(`Multiple ${this.label} databases open (${dbs.map(db => db.id).join(", ")}); pass db`);
			return dbs[0];
		}
		const byId = await findOpenDatabase(this.session, this.name, ref);
		if (byId) return byId;
		const { path: sourcePath, arch } = splitSliceRef(ref);
		const abs = resolveToCwd(sourcePath, this.session.cwd);
		const stat = await fs.stat(abs).catch(() => null);
		if (!stat?.isFile()) throw new ToolError(`db not found: ${ref}`);
		if (open) return acquireDatabase(this.session, this.name, abs, { arch, signal });
		const loc = await locateDatabase(DISASM_BACKENDS[this.name], abs, { arch });
		const db = await findOpenDatabase(this.session, this.name, loc.id);
		if (!db) throw new ToolError(`${ref} is not open`);
		return db;
	}
}
