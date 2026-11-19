import { afterEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type InternalUrl, VaultProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";

function createSession(): ToolSession {
	return {
		cwd: os.tmpdir(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("read keeps the query of schemes that own it", () => {
	it("hands vault://…?op=search&q=… to the vault handler instead of peeling an image question", async () => {
		const seen: InternalUrl[] = [];
		vi.spyOn(VaultProtocolHandler.prototype, "locate").mockResolvedValue(null);
		vi.spyOn(VaultProtocolHandler.prototype, "resolve").mockImplementation(async url => {
			seen.push(url);
			return { url: url.href, content: "hit: Plans/roadmap.md", contentType: "text/plain" };
		});

		const result = await new ReadTool(createSession()).execute("vault-search", {
			path: "vault://Work?op=search&q=plan",
		});

		expect(seen.map(url => [url.searchParams.get("op"), url.searchParams.get("q")])).toEqual([["search", "plan"]]);
		expect(result.content.map(part => (part.type === "text" ? part.text : "")).join("\n")).toContain(
			"hit: Plans/roadmap.md",
		);
	});
});
