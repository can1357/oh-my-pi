import * as path from "node:path";

import { ToolError } from "../../../tools/tool-errors";
import type { JsStatusEvent } from "./types";

export interface HelperOptions {
	limit?: number;
	offset?: number;
}

/**
 * Inputs the helper factory needs from its host runtime. `cwd` is a getter so the runtime
 * can update it between cells (e.g. when the agent's session cwd changes) without
 * recreating helpers.
 */
export interface HelperContext {
	cwd(): string;
	env: Map<string, string>;
	/**
	 * On-disk roots for internal-URL schemes the helpers accept (e.g.
	 * `{ local: "/…/artifacts/local" }`). A path like `local://x.md` is rewritten
	 * to `<root>/x.md` before any filesystem op; unknown schemes are rejected.
	 */
	localRoots(): Record<string, string>;
	emitStatus(event: JsStatusEvent): void;
}

/**
 * The set of functions exposed to user code via `globalThis.__omp_helpers__`. The JS
 * prelude reads from this bag and attaches short aliases (`read`, `write`, `env`, ...)
 * onto the global scope.
 */
export interface HelperBundle {
	read(rawPath: string, options?: HelperOptions): Promise<string>;
	writeFile(rawPath: string, data: unknown): Promise<string>;
	env(key?: string, value?: string): string | Record<string, string> | undefined;
}

const utf8Encoder = new TextEncoder();

export function createHelpers(ctx: HelperContext): HelperBundle {
	return {
		read: async (rawPath, options = {}) => {
			const { filePath, file, size } = await resolveRegularFile(ctx, rawPath);
			let text = await file.text();
			const offset = typeof options.offset === "number" ? options.offset : 1;
			const limit = typeof options.limit === "number" ? options.limit : undefined;
			if (offset > 1 || limit !== undefined) {
				const lines = text.split(/\r?\n/);
				const start = Math.max(0, offset - 1);
				const end = limit !== undefined ? start + limit : lines.length;
				text = lines.slice(start, end).join("\n");
			}
			ctx.emitStatus({ op: "read", path: filePath, bytes: size, chars: text.length });
			return text;
		},
		writeFile: async (rawPath, data) => {
			if (!isWriteData(data)) {
				throw new ToolError("write() expects string, Blob, ArrayBuffer, or TypedArray data");
			}
			const filePath = resolveHelperPath(ctx, rawPath, "write");
			if (typeof data === "string" || data instanceof Blob || data instanceof ArrayBuffer) {
				await Bun.write(filePath, data);
			} else {
				await Bun.write(filePath, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
			}
			ctx.emitStatus({ op: "write", path: filePath, bytes: getDataSize(data) });
			return filePath;
		},
		env: (key, value) => {
			if (!key) {
				const merged = Object.fromEntries(Object.entries(getMergedEnv(ctx)).sort(([a], [b]) => a.localeCompare(b)));
				ctx.emitStatus({ op: "env", count: Object.keys(merged).length, keys: Object.keys(merged).slice(0, 20) });
				return merged;
			}
			if (value !== undefined) {
				ctx.env.set(key, value);
				ctx.emitStatus({ op: "env", key, value, action: "set" });
				return value;
			}
			const result = ctx.env.get(key) ?? Bun.env[key];
			ctx.emitStatus({ op: "env", key, value: result, action: "get" });
			return result;
		},
	};
}

function getMergedEnv(ctx: HelperContext): Record<string, string> {
	const merged: Record<string, string> = {};
	for (const [key, value] of Object.entries(Bun.env)) {
		if (typeof value === "string") merged[key] = value;
	}
	for (const [key, value] of ctx.env) merged[key] = value;
	return merged;
}

const INTERNAL_URL_RE = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i;

function resolvePath(ctx: HelperContext, value: string): string {
	if (path.isAbsolute(value)) return path.normalize(value);
	return path.resolve(ctx.cwd(), value);
}

/**
 * Map a raw helper path to an absolute filesystem path. Plain paths resolve
 * against the cwd; an internal-URL whose scheme has an injected root (e.g.
 * `local://`) is rewritten under that root; any other `scheme://` is rejected
 * so we never silently create a literal `scheme:/` directory.
 */
function resolveHelperPath(ctx: HelperContext, rawPath: string, op: "read" | "write"): string {
	const match = INTERNAL_URL_RE.exec(rawPath);
	if (!match) return resolvePath(ctx, rawPath);
	const scheme = match[1].toLowerCase();
	const root = ctx.localRoots()[scheme];
	if (!root) {
		throw new ToolError(`Protocol paths are not supported by ${op}(): ${rawPath}`);
	}
	return resolveUnderRoot(scheme, root, match[2], rawPath);
}

/** Resolve an internal-URL relative path under its root, mirroring the host
 *  local-protocol handler: decode, reject absolute/traversal, confine to root. */
function resolveUnderRoot(scheme: string, root: string, rawRelative: string, rawPath: string): string {
	let relative: string;
	try {
		relative = decodeURIComponent(rawRelative.replaceAll("\\", "/"));
	} catch {
		throw new ToolError(`Invalid URL encoding in ${scheme}:// path: ${rawPath}`);
	}
	const rootPath = path.resolve(root);
	if (relative === "") return rootPath;
	if (path.isAbsolute(relative)) {
		throw new ToolError(`Absolute paths are not allowed in ${scheme}:// URLs: ${rawPath}`);
	}
	const normalized = path.normalize(relative);
	if (normalized.startsWith("..") || normalized.includes("/../") || normalized.includes("/..")) {
		throw new ToolError(`Path traversal (..) is not allowed in ${scheme}:// URLs: ${rawPath}`);
	}
	const resolved = path.resolve(rootPath, normalized);
	if (resolved !== rootPath && !resolved.startsWith(`${rootPath}${path.sep}`)) {
		throw new ToolError(`${scheme}:// path escapes its root: ${rawPath}`);
	}
	return resolved;
}

async function resolveRegularFile(
	ctx: HelperContext,
	rawPath: string,
): Promise<{ filePath: string; file: Bun.BunFile; size: number }> {
	const filePath = resolveHelperPath(ctx, rawPath, "read");
	const file = Bun.file(filePath);
	const stat = await file.stat();
	if (stat.isDirectory()) {
		throw new ToolError(`Directory paths are not supported by read(): ${filePath}`);
	}
	return { filePath, file, size: stat.size };
}

function getDataSize(data: string | Blob | ArrayBuffer | ArrayBufferView): number {
	if (typeof data === "string") return utf8Encoder.encode(data).byteLength;
	if (data instanceof Blob) return data.size;
	if (data instanceof ArrayBuffer) return data.byteLength;
	return data.byteLength;
}

function isWriteData(value: unknown): value is string | Blob | ArrayBuffer | ArrayBufferView {
	return (
		typeof value === "string" || value instanceof Blob || value instanceof ArrayBuffer || ArrayBuffer.isView(value)
	);
}
