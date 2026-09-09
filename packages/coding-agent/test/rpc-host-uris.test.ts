import { afterEach, describe, expect, it } from "bun:test";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { RpcHostUriBridge } from "@oh-my-pi/pi-coding-agent/modes/rpc/host-uris";
import type { RpcHostUriCancelRequest, RpcHostUriRequest } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

const router = InternalUrlRouter.instance();

afterEach(() => {
	// Tests register transient schemes on the global router; clean them up
	// between cases so neighboring suites observe the default registration.
	router.unregister("db");
	router.unregister("notes");
	router.unregister("Db"); // case-insensitive guard
});

function recordOutput(): {
	frames: Array<RpcHostUriRequest | RpcHostUriCancelRequest>;
	push: (frame: RpcHostUriRequest | RpcHostUriCancelRequest) => void;
} {
	const frames: Array<RpcHostUriRequest | RpcHostUriCancelRequest> = [];
	return { frames, push: frame => frames.push(frame) };
}

describe("RpcHostUriBridge", () => {
	it("registers schemes against the router and surfaces read results", async () => {
		const out = recordOutput();
		const bridge = new RpcHostUriBridge(out.push);

		bridge.setSchemes([{ scheme: "db", description: "rows", writable: false }]);
		expect(router.canHandle("db://users/42")).toBe(true);

		const pending = bridge.requestRead("db", parseInternalUrl("db://users/42"));
		expect(out.frames).toHaveLength(1);
		const request = out.frames[0];
		if (request?.type !== "host_uri_request") {
			throw new Error("Expected host_uri_request frame");
		}
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
		bridge.clear("test cleanup");
	});

	it("attaches a write hook only for writable schemes", async () => {
		const out = recordOutput();
		const bridge = new RpcHostUriBridge(out.push);
		bridge.setSchemes([
			{ scheme: "db", writable: true },
			{ scheme: "notes", writable: false },
		]);

		const dbHandler = router.getHandler("db");
		const notesHandler = router.getHandler("notes");
		expect(typeof dbHandler?.write).toBe("function");
		expect(notesHandler?.write).toBeUndefined();

		const url = parseInternalUrl("db://users/42");
		const pending = bridge.requestWrite("db", url, "new content");
		expect(out.frames).toHaveLength(1);
		const request = out.frames[0];
		if (request?.type !== "host_uri_request") {
			throw new Error("Expected host_uri_request frame");
		}
		expect(request.operation).toBe("write");
		expect(request.content).toBe("new content");

		bridge.handleResult({ type: "host_uri_result", id: request.id });
		await expect(pending).resolves.toBeUndefined();
		bridge.clear("test cleanup");
	});

	it("propagates host-reported errors as exceptions", async () => {
		const out = recordOutput();
		const bridge = new RpcHostUriBridge(out.push);
		bridge.setSchemes([{ scheme: "db", writable: true }]);

		const url = parseInternalUrl("db://users/42");
		const pending = bridge.requestRead("db", url);
		const request = out.frames[0];
		if (request?.type !== "host_uri_request") {
			throw new Error("Expected host_uri_request frame");
		}
		bridge.handleResult({
			type: "host_uri_result",
			id: request.id,
			isError: true,
			error: "row not found",
		});

		await expect(pending).rejects.toThrow("row not found");
		bridge.clear("test cleanup");
	});

	it("emits a cancel frame when the read signal aborts", async () => {
		const out = recordOutput();
		const bridge = new RpcHostUriBridge(out.push);
		bridge.setSchemes([{ scheme: "db" }]);

		const controller = new AbortController();
		const url = parseInternalUrl("db://users/42");
		const pending = bridge.requestRead("db", url, { signal: controller.signal });
		expect(out.frames).toHaveLength(1);

		controller.abort();
		await expect(pending).rejects.toThrow(/aborted/);
		const cancel = out.frames[1];
		expect(cancel?.type).toBe("host_uri_cancel");
		bridge.clear("test cleanup");
	});

	it("rejects OMP-reserved schemes", () => {
		const bridge = new RpcHostUriBridge(() => {});
		expect(() => bridge.setSchemes([{ scheme: "security" }])).toThrow(
			"Host URI scheme is reserved by OMP: security://",
		);
	});

	it("normalizes scheme casing and rejects invalid characters", () => {
		const bridge = new RpcHostUriBridge(() => {});
		const accepted = bridge.setSchemes([{ scheme: "  DB  " }]);
		expect(accepted).toEqual(["db"]);
		expect(router.canHandle("db://x")).toBe(true);

		expect(() => bridge.setSchemes([{ scheme: "1bad" }])).toThrow();
		bridge.clear("test cleanup");
	});

	it("replaces the registered set and unregisters schemes that drop off", () => {
		const bridge = new RpcHostUriBridge(() => {});
		bridge.setSchemes([{ scheme: "db" }, { scheme: "notes" }]);
		expect(router.canHandle("notes://idx")).toBe(true);

		bridge.setSchemes([{ scheme: "db" }]);
		expect(router.canHandle("notes://idx")).toBe(false);
		expect(router.canHandle("db://idx")).toBe(true);
		bridge.clear("test cleanup");
	});
});
