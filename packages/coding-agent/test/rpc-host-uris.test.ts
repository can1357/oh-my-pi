import { beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter, SessionUrlSchemes } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { RpcHostUriBridge } from "@oh-my-pi/pi-coding-agent/modes/rpc/host-uris";
import type { RpcHostUriCancelRequest, RpcHostUriRequest } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";

function recordOutput(): {
	frames: Array<RpcHostUriRequest | RpcHostUriCancelRequest>;
	push: (frame: RpcHostUriRequest | RpcHostUriCancelRequest) => void;
} {
	const frames: Array<RpcHostUriRequest | RpcHostUriCancelRequest> = [];
	return { frames, push: frame => frames.push(frame) };
}

function lastRequest(frames: Array<RpcHostUriRequest | RpcHostUriCancelRequest>): RpcHostUriRequest {
	const request = frames.at(-1);
	if (request?.type !== "host_uri_request") throw new Error("Expected host_uri_request frame");
	return request;
}

function toolSession(schemes: SessionUrlSchemes): ToolSession {
	return {
		cwd: os.tmpdir(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		urlRouter: schemes.router,
		settings: Settings.isolated(),
	};
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(part => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

describe("RpcHostUriBridge", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	it("lets the read tool of the RPC session reach the host, while another session's read tool does not", async () => {
		const requests: string[] = [];
		const rpcSession = new SessionUrlSchemes();
		const otherSession = new SessionUrlSchemes();
		// The host answers each request as it arrives.
		const bridge: RpcHostUriBridge = new RpcHostUriBridge(frame => {
			if (frame.type !== "host_uri_request") return;
			requests.push(frame.url);
			bridge.handleResult({ type: "host_uri_result", id: frame.id, content: "row 42 payload" });
		}, rpcSession.hostUris);
		bridge.setSchemes([{ scheme: "db" }]);

		const read = await new ReadTool(toolSession(rpcSession)).execute("read-db", { path: "db://users/42" });
		expect(resultText(read)).toContain("row 42 payload");
		expect(requests).toEqual(["db://users/42"]);

		await expect(
			new ReadTool(toolSession(otherSession)).execute("read-db", { path: "db://users/42" }),
		).rejects.toThrow();
		expect(requests).toEqual(["db://users/42"]);
		bridge.clear("test cleanup");
	});

	it("serves a read through the session router of the session it was bound to, and no other", async () => {
		const out = recordOutput();
		const rpcSession = new SessionUrlSchemes();
		const otherSession = new SessionUrlSchemes();
		const bridge = new RpcHostUriBridge(out.push, rpcSession.hostUris);

		bridge.setSchemes([{ scheme: "db", description: "rows", writable: false }]);
		expect(rpcSession.router.canHandle("db://users/42")).toBe(true);
		expect(otherSession.router.canHandle("db://users/42")).toBe(false);
		expect(InternalUrlRouter.builtins().canHandle("db://users/42")).toBe(false);

		const pending = rpcSession.router.resolve("db://users/42");
		const request = lastRequest(out.frames);
		expect(request.operation).toBe("read");
		expect(request.url).toBe("db://users/42");
		bridge.handleResult({
			type: "host_uri_result",
			id: request.id,
			content: "id=42",
			contentType: "application/json",
			notes: ["fresh"],
		});
		const resource = await pending;
		expect(resource.content).toBe("id=42");
		expect(resource.contentType).toBe("application/json");
		expect(resource.notes).toEqual(["fresh"]);

		// The other session never reaches the host: the URL falls through to the built-ins' MCP resource fallback.
		await expect(otherSession.router.resolve("db://users/42")).rejects.toThrow("No MCP manager available");
		expect(out.frames).toHaveLength(1);
		bridge.clear("test cleanup");
	});

	it("writes through the session router only for writable schemes", async () => {
		const out = recordOutput();
		const session = new SessionUrlSchemes();
		const bridge = new RpcHostUriBridge(out.push, session.hostUris);
		bridge.setSchemes([
			{ scheme: "db", writable: true },
			{ scheme: "notes", writable: false },
		]);

		const pending = session.router.write("db://users/42", "new content");
		const request = lastRequest(out.frames);
		expect(request.operation).toBe("write");
		expect(request.url).toBe("db://users/42");
		expect(request.content).toBe("new content");
		bridge.handleResult({ type: "host_uri_result", id: request.id });
		await expect(pending).resolves.toBeUndefined();

		await expect(session.router.write("notes://idx", "x")).rejects.toThrow("notes:// URLs are read-only");
		expect(out.frames).toHaveLength(1);
		bridge.clear("test cleanup");
	});

	it("propagates host-reported errors as exceptions", async () => {
		const out = recordOutput();
		const session = new SessionUrlSchemes();
		const bridge = new RpcHostUriBridge(out.push, session.hostUris);
		bridge.setSchemes([{ scheme: "db", writable: true }]);

		const pending = session.router.resolve("db://users/42");
		bridge.handleResult({
			type: "host_uri_result",
			id: lastRequest(out.frames).id,
			isError: true,
			error: "row not found",
		});

		await expect(pending).rejects.toThrow("row not found");
		bridge.clear("test cleanup");
	});

	it("emits a cancel frame when the read signal aborts", async () => {
		const out = recordOutput();
		const session = new SessionUrlSchemes();
		const bridge = new RpcHostUriBridge(out.push, session.hostUris);
		bridge.setSchemes([{ scheme: "db" }]);

		const controller = new AbortController();
		const pending = bridge.requestRead("db", parseInternalUrl("db://users/42"), { signal: controller.signal });
		expect(out.frames).toHaveLength(1);

		controller.abort();
		await expect(pending).rejects.toThrow(/aborted/);
		expect(out.frames[1]?.type).toBe("host_uri_cancel");
		bridge.clear("test cleanup");
	});

	it("refuses built-in and standard schemes, changing nothing", () => {
		const session = new SessionUrlSchemes();
		const bridge = new RpcHostUriBridge(() => {}, session.hostUris);
		bridge.setSchemes([{ scheme: "db" }]);
		for (const scheme of ["security", "local", "Agent", "mcp"]) {
			expect(() => bridge.setSchemes([{ scheme: "notes" }, { scheme, writable: true }])).toThrow(
				`Host URI scheme is reserved by OMP: ${scheme.toLowerCase()}://`,
			);
		}
		for (const scheme of ["http", "file"]) {
			expect(() => bridge.setSchemes([{ scheme }])).toThrow(`Host URI scheme is a standard scheme: ${scheme}://`);
		}
		expect(bridge.getSchemes()).toEqual(["db"]);
		expect(session.router.canHandle("db://x")).toBe(true);
		expect(session.router.canHandle("notes://x")).toBe(false);
		// Built-ins keep their own semantics.
		expect(session.router.normalize("local:/x")).toBe("local://x");
		expect(session.router.fileWritable("local://x")).toBe(true);
		expect(session.router.canHandle("agent://x")).toBe(true);
		bridge.clear("test cleanup");
	});

	it("normalizes scheme casing and rejects invalid characters", () => {
		const session = new SessionUrlSchemes();
		const bridge = new RpcHostUriBridge(() => {}, session.hostUris);
		expect(bridge.setSchemes([{ scheme: "  DB  " }])).toEqual(["db"]);
		expect(session.router.canHandle("DB://x")).toBe(true);

		expect(() => bridge.setSchemes([{ scheme: "1bad" }])).toThrow();
		bridge.clear("test cleanup");
	});

	it("replaces the registered set, and clear() drops every host scheme", () => {
		const session = new SessionUrlSchemes();
		const bridge = new RpcHostUriBridge(() => {}, session.hostUris);
		bridge.setSchemes([{ scheme: "db" }, { scheme: "notes" }]);
		expect(session.router.canHandle("notes://idx")).toBe(true);

		bridge.setSchemes([{ scheme: "db" }]);
		expect(session.router.canHandle("notes://idx")).toBe(false);
		expect(session.router.canHandle("db://idx")).toBe(true);

		bridge.clear("test cleanup");
		expect(session.router.canHandle("db://idx")).toBe(false);
	});
});
