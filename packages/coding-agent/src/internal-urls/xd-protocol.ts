import { validateToolArguments } from "@pk-nerdsaver-ai/pi-ai";
import type { XdevRegistry } from "../tools/xdev";
import type {
	InternalResource,
	InternalUrl,
	ProtocolHandler,
	ResolveContext,
	WriteContext,
	XdevWriteResult,
} from "./types";

export const XD_URL_PREFIX = "xd://";

function requireRegistry(context?: ResolveContext | WriteContext): XdevRegistry {
	const registry = context?.xdev?.getRegistry();
	if (!registry) {
		throw new Error("xd:// is disabled; set tools.xdev to true to enable virtual tool devices.");
	}
	return registry;
}

function toolNameFromUrl(url: InternalUrl): string {
	const toolName = url.rawHost || url.hostname;
	const pathname = url.rawPathname ?? url.pathname;
	if (pathname && pathname !== "/") {
		throw new Error(`xd:// URLs address one tool by host name; unexpected path: ${pathname}`);
	}
	return toolName;
}

function resource(url: InternalUrl, content: string): InternalResource {
	return {
		url: url.href,
		content,
		contentType: "text/markdown",
		size: Buffer.byteLength(content, "utf-8"),
		notes: [],
	};
}

function unknownToolMessage(name: string, listing: string): string {
	return `Unknown xd:// tool "${name}".\n\n${listing}`;
}

/** Session-scoped virtual device surface for MCP and custom tools. */
export class XdProtocolHandler implements ProtocolHandler {
	readonly scheme = "xd";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const registry = requireRegistry(context);
		const name = toolNameFromUrl(url);
		if (!name) return resource(url, registry.listing());

		const docs = registry.docs(name);
		if (!docs) throw new Error(unknownToolMessage(name, registry.listing()));
		return resource(url, docs);
	}

	async write(url: InternalUrl, content: string, context?: WriteContext): Promise<XdevWriteResult> {
		const registry = requireRegistry(context);
		const name = toolNameFromUrl(url);
		if (!name) throw new Error("xd:// writes require a tool name, for example xd://mcp__server__tool.");

		const tool = registry.get(name);
		if (!tool) throw new Error(unknownToolMessage(name, registry.listing()));
		if (!context?.xdev) throw new Error("xd:// execution bridge is unavailable for this session.");

		const trimmed = content.trim();
		if (!trimmed || trimmed === "?" || trimmed.toLowerCase() === "help") {
			throw new Error(`Read xd://${name} for its schema, then write a JSON object to execute it.`);
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Invalid JSON for xd://${name}: ${message}. Read xd://${name} for its schema.`);
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`Arguments for xd://${name} must be a JSON object. Read xd://${name} for its schema.`);
		}

		let normalized: Record<string, unknown>;
		try {
			normalized = validateToolArguments(tool, {
				type: "toolCall",
				id: `xd-${crypto.randomUUID()}`,
				name,
				arguments: parsed as Record<string, unknown>,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`${message}\nRead xd://${name} for the accepted JSON schema.`);
		}

		return context.xdev.execute(name, normalized, context.signal);
	}
}
