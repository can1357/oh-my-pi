import { describe, expect, it } from "bun:test";
import {
	RpcClientConnection,
	RpcClientRegistry,
	type RpcClientFrame,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/client-connection";
import { isRecord } from "@oh-my-pi/pi-utils";
import { RpcPendingExtensionRequests, requestRpcInput } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { RpcExtensionUIRequest } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

function uiRequest(id: string): RpcExtensionUIRequest {
	return { type: "extension_ui_request", id, method: "notify", message: `ui-${id}` };
}

describe("RpcClientRegistry extension UI ownership", () => {
	it("routes extension UI frames to one active UI-capable connection", () => {
		const libraryFrames: RpcClientFrame[] = [];
		const dialogsFrames: RpcClientFrame[] = [];
		const library = new RpcClientConnection({ id: "library", supportsUi: false, send: f => libraryFrames.push(f) });
		const dialogs = new RpcClientConnection({ id: "dialogs", supportsUi: true, send: f => dialogsFrames.push(f) });
		const registry = new RpcClientRegistry();
		registry.register(library);
		registry.register(dialogs);

		expect(registry.sendUi(uiRequest("ui-1"))).toBe(true);

		expect(libraryFrames).toEqual([]);
		expect(dialogsFrames).toHaveLength(1);
	});

	it("hands extension UI to the next UI-capable connection when the active one closes", () => {
		const firstFrames: RpcClientFrame[] = [];
		const secondFrames: RpcClientFrame[] = [];
		const first = new RpcClientConnection({ id: "first", send: f => firstFrames.push(f) });
		const second = new RpcClientConnection({ id: "second", send: f => secondFrames.push(f) });
		const registry = new RpcClientRegistry();
		registry.register(first);
		registry.register(second);

		registry.sendUi(uiRequest("ui-1"));
		expect(firstFrames).toHaveLength(1);

		first.close();
		registry.sendUi(uiRequest("ui-2"));
		expect(secondFrames).toHaveLength(1);
	});
});

describe("RpcPendingExtensionRequests per-connection cancellation", () => {
	it("settles only the disconnected client's pending UI request", async () => {
		const firstFrames: RpcClientFrame[] = [];
		const secondFrames: RpcClientFrame[] = [];
		const first = new RpcClientConnection({ id: "first", send: f => firstFrames.push(f) });
		const second = new RpcClientConnection({ id: "second", send: f => secondFrames.push(f) });
		const registry = new RpcClientRegistry();
		registry.register(first);
		registry.register(second);
		const pending = new RpcPendingExtensionRequests(() => registry.activeUiConn());
		const output = (frame: RpcClientFrame) => registry.sendUi(frame);

		const firstDialog = requestRpcInput(pending, output, "first dialog");
		expect(firstFrames).toHaveLength(1);
		expect(secondFrames).toEqual([]);

		const disconnectMessage = "RPC client disconnected before extension UI response completed";
		first.close();
		registry.unregister(first);
		pending.rejectFor(first, disconnectMessage);
		await expect(firstDialog).rejects.toThrow(disconnectMessage);

		const secondDialog = requestRpcInput(pending, output, "second dialog");
		expect(secondFrames).toHaveLength(1);
		const secondRequest = secondFrames[0];
		if (
			!isRecord(secondRequest) ||
			secondRequest.type !== "extension_ui_request" ||
			typeof secondRequest.id !== "string"
		) {
			throw new Error("Expected an extension_ui_request frame");
		}
		const pendingRequest = pending.get(secondRequest.id);
		if (!pendingRequest) throw new Error("Expected the second dialog to stay pending");
		pendingRequest.resolve({ type: "extension_ui_response", id: secondRequest.id, cancelled: true });
		await expect(secondDialog).resolves.toBeUndefined();
	});
});
