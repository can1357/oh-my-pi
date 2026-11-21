import * as fs from "node:fs/promises";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ReadToolDetails } from "@oh-my-pi/pi-tui/tools/read";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import {
	cfgDisasmBackend,
	DISASM_BACKEND_IDS,
	type DisasmBackendId,
	databaseOwner,
	isExecutableFile,
	SLICE_SEPARATOR,
} from "../disasm";
import { acquireDatabase } from "../disasm/client";
import { readBinaryMetadata } from "../disasm/metadata";
import type { ToolSession } from "../sdk";
import { formatPathRelativeToCwd, resolveReadPath } from "./path-utils";
import { buildInMemorySelectorResult } from "./read-format";
import type { ParsedSelector } from "./read-selector";

/** disassembler view rendered by the worker's `view` method. */
export type BinaryViewKind = "overview" | "pseudocode" | "asm" | "imports" | "exports" | "strings" | "xrefs";

/** Parsed `<binary>:<view>` suffix; `target` is a symbol name or `0x` address. */
export type BinaryView = { kind: BinaryViewKind; target?: string };

/** An executable or IDB on disk plus the unparsed view suffix after it. */
export interface BinaryViewTarget {
	backend?: DisasmBackendId;
	absolutePath: string;
	view: string;
	/** Universal-binary slice from a leading `@<arch>` view segment; default slice when absent. */
	arch?: string;
}

const RESERVED_VIEWS: Record<string, BinaryViewKind> = {
	overview: "overview",
	imports: "imports",
	exports: "exports",
	strings: "strings",
};
const SLICE_PREFIX = "@";
const XREFS_PREFIX = "xrefs:";
const ASM_SUFFIX = ":asm";
const VIEW_TIMEOUT_MS = 120_000;
/** Every value of `disassembler.backend` that enables analysis: "auto, ida, ghidra, or binja". */
const BACKEND_CHOICES = new Intl.ListFormat("en", { type: "disjunction" }).format(["auto", ...DISASM_BACKEND_IDS]);

/**
 * Parse the view suffix of a binary read. Reserved words (`overview`, `imports`,
 * `exports`, `strings`) win over same-named functions, which stay reachable by `0x` address.
 * Empty suffixes are metadata-only in readBinary, not requests for this overview.
 */
export function parseBinaryView(view: string): BinaryView {
	if (view === "") return { kind: "overview" };
	const reserved = Object.hasOwn(RESERVED_VIEWS, view) ? RESERVED_VIEWS[view] : undefined;
	if (reserved) return { kind: reserved };
	if (view.startsWith(XREFS_PREFIX)) {
		const target = view.slice(XREFS_PREFIX.length);
		if (!target) throw new ToolError("xrefs needs a target: <binary>:xrefs:<func|0xaddr>");
		return { kind: "xrefs", target };
	}
	if (view.endsWith(ASM_SUFFIX)) return { kind: "asm", target: view.slice(0, -ASM_SUFFIX.length) };
	return { kind: "pseudocode", target: view };
}

async function isFile(absolutePath: string): Promise<boolean> {
	try {
		return (await fs.stat(absolutePath)).isFile();
	} catch {
		return false;
	}
}

/**
 * Split `readPath` into an executable/IDB file and an disassembler view suffix. Returns
 * null when the path has no `:`, the whole path is an existing
 * file, or no `:`-delimited prefix names an executable or IDB.
 */
export async function resolveBinaryViewPath(session: ToolSession, readPath: string): Promise<BinaryViewTarget | null> {
	const backend = cfgDisasmBackend.get(session.settings);
	if (!readPath.includes(":")) return null;
	if (await isFile(resolveReadPath(readPath, session.cwd))) return null;
	for (let i = readPath.lastIndexOf(":"); i > 0; i = readPath.lastIndexOf(":", i - 1)) {
		const absolutePath = resolveReadPath(readPath.slice(0, i), session.cwd);
		if (!(await isFile(absolutePath))) continue;
		if (databaseOwner(absolutePath) || (await isExecutableFile(absolutePath))) {
			return { backend, absolutePath, ...splitSliceView(readPath.slice(i + 1)) };
		}
	}
	return null;
}

/** Split a leading `@<arch>` slice segment off a view: `@x86_64:main` → `{ arch: "x86_64", view: "main" }`. */
function splitSliceView(view: string): { view: string; arch?: string } {
	if (!view.startsWith(SLICE_PREFIX)) return { view };
	const end = view.indexOf(":");
	const arch = view.slice(SLICE_PREFIX.length, end < 0 ? undefined : end);
	if (!arch) throw new ToolError(`empty slice name: use <binary>${SLICE_SEPARATOR}<arch>`);
	return { arch, view: end < 0 ? "" : view.slice(end + 1) };
}

/** Empty views inspect on-disk metadata only; nonempty views explicitly opt into analysis. */
export async function readBinary(
	session: ToolSession,
	target: BinaryViewTarget,
	parsed: ParsedSelector,
	signal?: AbortSignal,
): Promise<AgentToolResult<ReadToolDetails>> {
	if (target.view === "") {
		const metadata = await readBinaryMetadata(target.absolutePath, target.arch);
		const bin = formatPathRelativeToCwd(target.absolutePath, session.cwd);
		const p = metadata.fat ? `${bin}${SLICE_SEPARATOR}${metadata.fat.slice.arch}` : bin;
		const guidance =
			target.backend === undefined
				? `Analysis disabled: set disassembler.backend to ${BACKEND_CHOICES} to enable explicit analysis views and dsm.`
				: `Analysis (explicit opt-in): ${p}:overview, ${p}:<func|0xaddr>, ${p}:<func>:asm, :imports, :exports, :strings, :xrefs:<func|0xaddr>. Use the dsm namespace at help://eval/dsm for scripting or dsm.open.`;
		const slices = metadata.fat
			? `\nPick a universal slice with ${bin}${SLICE_SEPARATOR}<arch> (metadata only until a view is added).`
			: "";
		return buildInMemorySelectorResult(session, `${metadata.text}\n${guidance}${slices}`, parsed, {
			details: { resolvedPath: target.absolutePath },
			sourcePath: target.absolutePath,
			entityLabel: "binary metadata",
			immutable: true,
		});
	}
	if (target.backend === undefined) {
		throw new ToolError(
			`Binary analysis is disabled or unavailable; set disassembler.backend to ${BACKEND_CHOICES}. Read the bare binary path for on-disk metadata.`,
		);
	}
	const owner = databaseOwner(target.absolutePath);
	if (owner && owner.id !== target.backend) {
		throw new ToolError(
			`${owner.label} databases require disassembler.backend=${owner.id} with ${owner.label} installed. Read the bare database path for metadata.`,
		);
	}
	const view = parseBinaryView(target.view);
	const db = await acquireDatabase(session, target.backend, target.absolutePath, { arch: target.arch, signal });
	const { text } = await db.request<{ text: string }>("view", view, { signal, timeoutMs: VIEW_TIMEOUT_MS });
	let output = text;
	if (view.kind === "overview") {
		const bin = formatPathRelativeToCwd(target.absolutePath, session.cwd);
		const fat = db.fat;
		const p = fat ? `${bin}${SLICE_SEPARATOR}${fat.slice.arch}` : bin;
		const slices = fat
			? `; universal slices: ${fat.slices.map(s => (s.arch === fat.slice.arch ? `${s.arch} (shown)` : s.arch)).join(", ")}, pick via ${bin}${SLICE_SEPARATOR}<arch>`
			: "";
		output = `[${db.id}${slices}; views: ${p}:<func|0xaddr> pseudocode, ${p}:<func>:asm, :imports, :exports, :strings, :xrefs:<func|0xaddr>]\n${text}`;
	}
	// Immutable: the view is generated text, so it must never seed hashline edits against the binary itself.
	return buildInMemorySelectorResult(session, output, parsed, {
		details: { resolvedPath: target.absolutePath },
		sourcePath: target.absolutePath,
		entityLabel: `binary ${view.kind}`,
		immutable: true,
	});
}
