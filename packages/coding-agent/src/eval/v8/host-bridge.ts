import { isRecord } from "@oh-my-pi/pi-utils";
import { InternalUrlRouter } from "../../internal-urls";
import { sessionResolveContext, sessionWriteContext } from "../../internal-urls/context";
import { buildDirectoryResource } from "../../internal-urls/filesystem-resource";
import { parseSel, resolveTailSelector } from "../../tools/read-selector";
import { ToolError } from "../../tools/tool-errors";
import {
	bridgeValueFromToolResult,
	getTool,
	NO_REPLY_SINK,
	runSessionTool,
	type ToolBridgeOptions,
} from "../js/tool-bridge";
import { withEvalBridgeToolCall } from "../tool-bridge-policy";
import { type EvalDisplayOutput, evalImageMetadata } from "../types";
import type { V8ReadOptions, V8WriteEncoding } from "./protocol";
import { isDirectReadableV8Url, isDirectWritableV8Url } from "./url-policy";

const MAX_V8_DIRECT_READ_BYTES = 4 * 1024 * 1024;

export interface V8HostBridgeOptions extends ToolBridgeOptions {
	onDisplay?: (output: EvalDisplayOutput) => void;
}

function surfaceV8ToolImages(value: unknown, onDisplay?: (output: EvalDisplayOutput) => void): unknown {
	if (!isRecord(value) || !Array.isArray(value.images) || value.images.length === 0) return value;
	let displayed = 0;
	for (const image of value.images) {
		if (!isRecord(image) || typeof image.data !== "string" || typeof image.mimeType !== "string") continue;
		onDisplay?.({ type: "image", data: image.data, mimeType: image.mimeType, ...evalImageMetadata(image) });
		displayed++;
	}
	if (displayed === 0) return value;
	return {
		...value,
		images: `(${displayed} image${displayed === 1 ? "" : "s"} displayed)`,
	};
}

function formatDelegatedReadPath(rawPath: string, options?: V8ReadOptions): string | null {
	const base = /^https?:\/\//i.test(rawPath) || /:raw(?::|$)/i.test(rawPath) ? rawPath : `${rawPath}:raw`;
	const offset = typeof options?.offset === "number" ? options.offset : 1;
	const limit = typeof options?.limit === "number" ? options.limit : undefined;
	if (offset <= 1 && limit === undefined) return base;
	if (limit !== undefined && limit <= 0) return null;
	const start = Math.max(1, offset);
	if (limit === undefined) return `${base}:${start}-`;
	return `${base}:${start}-${start + limit - 1}`;
}

function sliceLines(text: string, options?: V8ReadOptions): string {
	const offset = typeof options?.offset === "number" ? options.offset : 1;
	const limit = typeof options?.limit === "number" ? options.limit : undefined;
	if (offset <= 1 && limit === undefined) return text;
	if (limit !== undefined && limit <= 0) return "";
	const lines = text.split(/\r?\n/);
	const start = Math.max(0, offset - 1);
	const end = limit !== undefined ? start + limit : lines.length;
	return lines.slice(start, end).join("\n");
}

function applyTargetSelector(text: string, sel: string): string | null {
	const parsed = parseSel(sel);
	if (parsed.kind === "none" || parsed.kind === "raw") return text;
	if (parsed.kind === "image" || parsed.kind === "conflicts") return null;
	const lines = text.split(/\r?\n/);
	const resolved = resolveTailSelector(parsed, lines.length);
	if (resolved.kind !== "lines") return text;
	const chunks: string[] = [];
	for (const range of resolved.ranges) {
		const start = Math.max(0, range.startLine - 1);
		const end = range.endLine !== undefined ? range.endLine : lines.length;
		chunks.push(lines.slice(start, end).join("\n"));
	}
	return chunks.join("\n");
}

export async function handleV8ToolCall(name: string, args: unknown, options: V8HostBridgeOptions): Promise<unknown> {
	if (name.startsWith("__")) {
		throw new ToolError(`Unknown tool in V8 sandbox: ${name}`);
	}
	return await withEvalBridgeToolCall(options.session.toolCommands, async () => {
		const call = await runSessionTool(getTool(options.session, name), args, options);
		const value = bridgeValueFromToolResult(call.name, call.args, call.result, options.emitStatus);
		return surfaceV8ToolImages(value, options.onDisplay);
	});
}

export async function handleV8UrlRead(
	rawPath: string,
	readOptions: V8ReadOptions | undefined,
	options: V8HostBridgeOptions,
): Promise<string> {
	const policy = isDirectReadableV8Url(rawPath);
	if (!policy.allowed) {
		const delegatedPath = formatDelegatedReadPath(rawPath, readOptions);
		if (delegatedPath === null) return "";
		const res = await handleV8ToolCall("read", { path: delegatedPath }, options);
		if (isRecord(res) && typeof res.text === "string") return res.text;
		return typeof res === "string" ? res : JSON.stringify(res);
	}

	const router = InternalUrlRouter.instance();
	const resolveCtx = sessionResolveContext(options.session, { signal: options.signal, containSkillPaths: true });
	const target = await router.target(policy.normalized, resolveCtx);
	if (!target || (target.url.protocol === "skill:" && target.kind === "resource")) {
		const delegatedPath = formatDelegatedReadPath(rawPath, readOptions);
		if (delegatedPath === null) return "";
		const res = await handleV8ToolCall("read", { path: delegatedPath }, options);
		return isRecord(res) && typeof res.text === "string" ? res.text : String(res ?? "");
	}

	let text: string;
	if (target.kind === "file") {
		const file = Bun.file(target.path);
		try {
			const stat = await file.stat();
			if (stat.isDirectory()) {
				const listing = await buildDirectoryResource(target.url.href, target.path);
				text = listing.content;
			} else if (stat.size > MAX_V8_DIRECT_READ_BYTES) {
				const delegatedPath = formatDelegatedReadPath(rawPath, readOptions);
				if (delegatedPath === null) return "";
				const res = await handleV8ToolCall("read", { path: delegatedPath }, options);
				return isRecord(res) && typeof res.text === "string" ? res.text : String(res ?? "");
			} else {
				const head = await file.slice(0, 8192).bytes();
				if (head.includes(0)) {
					const delegatedPath = formatDelegatedReadPath(rawPath, readOptions);
					if (delegatedPath === null) return "";
					const res = await handleV8ToolCall("read", { path: delegatedPath }, options);
					return isRecord(res) && typeof res.text === "string" ? res.text : String(res ?? "");
				}
				text = await file.text();
			}
		} catch (error) {
			throw new ToolError(
				`Cannot read ${policy.normalized}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	} else {
		const resource = await router.resolve(target.url.href, resolveCtx);
		text = typeof resource.content === "string" ? resource.content : resource.content.toString("utf-8");
	}

	if (target.sel) {
		const selected = applyTargetSelector(text, target.sel);
		if (selected === null) {
			const delegatedPath = formatDelegatedReadPath(rawPath, readOptions);
			if (delegatedPath === null) return "";
			const res = await handleV8ToolCall("read", { path: delegatedPath }, options);
			return isRecord(res) && typeof res.text === "string" ? res.text : String(res ?? "");
		}
		text = selected;
	}

	const sliced = sliceLines(text, readOptions);
	options.emitStatus?.({ op: "read", path: policy.normalized, chars: sliced.length });
	return sliced;
}

export async function handleV8UrlWrite(
	rawPath: string,
	data: string,
	encoding: V8WriteEncoding,
	options: V8HostBridgeOptions,
): Promise<string> {
	const textData = encoding === "utf8" ? data : undefined;
	const policy = isDirectWritableV8Url(rawPath, textData, options.session);
	if (!policy.allowed) {
		if (policy.denyReason) {
			throw new ToolError(policy.denyReason);
		}
		if (encoding !== "utf8") {
			throw new ToolError("Binary writes are only supported for local:// URLs.");
		}
		const res = await handleV8ToolCall("write", { path: rawPath, content: data }, options);
		if (isRecord(res) && (res.hasError === true || res.isError === true)) {
			throw new ToolError(typeof res.text === "string" && res.text ? res.text : `Write failed for ${rawPath}`);
		}
		return rawPath;
	}

	const payload = encoding === "base64" ? Buffer.from(data, "base64") : data;
	const bytes = typeof payload === "string" ? Buffer.byteLength(payload, "utf-8") : payload.byteLength;
	if (policy.maxBytes !== undefined && bytes > policy.maxBytes) {
		throw new ToolError(`Write to ${policy.peeled} exceeds ${policy.maxBytes} byte limit (${bytes} bytes).`);
	}

	const router = InternalUrlRouter.instance();
	if (policy.via === "file") {
		const resolveCtx = sessionResolveContext(options.session, { signal: options.signal });
		const located = await router.locate(policy.peeled, resolveCtx, { create: true });
		if (!located) {
			throw new ToolError(`Cannot write ${policy.peeled}: no local file backs it`);
		}
		await Bun.write(located, payload);
		options.emitStatus?.({ op: "write", path: policy.peeled, bytes });
		return policy.peeled;
	}

	if (encoding !== "utf8") {
		throw new ToolError(`Binary writes are not supported for ${policy.peeled}.`);
	}
	if (policy.scope === "reply" && !options.onReply) {
		options.emitStatus?.({ op: "write", path: policy.peeled, error: NO_REPLY_SINK });
		throw new ToolError(NO_REPLY_SINK);
	}
	const writeResult = await router.write(
		policy.peeled,
		data,
		sessionWriteContext(options.session, { signal: options.signal }),
	);
	if (writeResult?.isError) {
		const message = writeResult.content
			.flatMap(block => (block.type === "text" && typeof block.text === "string" ? [block.text] : []))
			.join("\n")
			.trim();
		throw new ToolError(message || `Write failed for ${policy.peeled}`);
	}
	if (policy.scope === "reply") {
		options.onReply?.(data);
	}
	options.emitStatus?.({ op: "write", path: policy.peeled, bytes });
	return policy.peeled;
}
