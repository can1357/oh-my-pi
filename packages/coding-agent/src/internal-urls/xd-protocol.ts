import { parseXdUrl } from "@oh-my-pi/pi-tui/tools/xd-url";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, WriteContext } from "./types";

/** Routes session-bound virtual tool devices through `xd://` URLs. */
export class XdProtocolHandler implements ProtocolHandler {
	readonly scheme = "xd";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const target = parseXdUrl(url.href);
		if (!target) throw new Error(`Invalid xd:// URL: ${url.href}. Use xd:// or xd://<tool>.`);
		if (!context?.xd) throw new Error("xd:// is not mounted in this session.");
		const content = await context.xd.read(target.name);
		return { url: url.href, content, contentType: "text/plain", size: Buffer.byteLength(content) };
	}

	async write(url: InternalUrl, content: string, context?: WriteContext): Promise<void> {
		const target = parseXdUrl(url.href);
		if (!target) throw new Error(`Invalid xd:// URL: ${url.href}. Use xd://<tool>.`);
		if (!context?.xd) throw new Error("xd:// is not mounted in this session.");
		await context.xd.write(target.name, content);
	}
}
