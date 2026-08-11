import { describe, expect, it } from "bun:test";
import type { ExtensionUIContext } from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/extensions";
import {
	createMCPHostInteractionBridge,
	type MCPHostInteractionPresenter,
} from "@pk-nerdsaver-ai/pi-coding-agent/mcp/host-interaction";
import type { MCPInputCollectionContext, MCPInputRequests } from "@pk-nerdsaver-ai/pi-coding-agent/mcp/types";
import { createTuiMCPHostInteractionPresenter } from "@pk-nerdsaver-ai/pi-coding-agent/sdk";

const formParams = {
	message: "Confirm the deployment settings.",
	requestedSchema: {
		type: "object",
		additionalProperties: false,
		required: ["retries", "enabled"],
		properties: {
			retries: { type: "integer", title: "Retries" },
			enabled: { type: "boolean", title: "Enabled" },
			note: { type: "string", title: "Note" },
		},
	},
};

function context(inputRequests: MCPInputRequests, signal?: AbortSignal): MCPInputCollectionContext {
	return {
		connection: {
			name: "release-server",
			serverInfo: { name: "release-server", version: "1.0.0" },
			protocol: undefined,
		},
		method: "tools/call",
		originalParams: { name: "deploy" },
		round: 1,
		inputRequired: { resultType: "input_required", inputRequests, requestState: "opaque-state" },
		signal,
	};
}

function presenter(overrides: Partial<MCPHostInteractionPresenter> = {}): MCPHostInteractionPresenter {
	return {
		presentForm: async () => ({ action: "cancel" }),
		presentUrl: async () => ({ action: "cancel" }),
		openUrl: () => {},
		...overrides,
	};
}

describe("MCP host interaction bridge", () => {
	it("fails closed before binding and advertises only after a presenter is active", async () => {
		const bridge = createMCPHostInteractionBridge();
		const requests: MCPInputRequests = {
			form: { method: "elicitation/create", params: formParams },
			url: {
				method: "elicitation/create",
				params: { mode: "url", message: "Complete sign-in", url: "https://example.test/login" },
			},
		};

		expect(bridge.clientCapabilities).toEqual({});
		expect(await bridge.collectInput(context(requests))).toEqual({
			form: { action: "cancel" },
			url: { action: "cancel" },
		});

		bridge.bind(presenter());
		expect(bridge.clientCapabilities).toEqual({ elicitation: { form: {}, url: {} } });
		expect(bridge.clientCapabilities).not.toHaveProperty("sampling");
		expect(bridge.clientCapabilities).not.toHaveProperty("roots");
		bridge.unbind();
		expect(bridge.clientCapabilities).toEqual({});
	});

	it("requires the TUI Submit action before accepting a form and preserves Decline", async () => {
		const form = {
			serverName: "release-server",
			message: "Choose a deployment name.",
			fields: [{ name: "name", title: "Deployment name", type: "string" as const, required: true }],
		};
		const submitUi = {
			input: async () => "canary",
			select: async (_title: string, options: string[]) => (options.includes("Submit") ? "Submit" : undefined),
		} as unknown as ExtensionUIContext;
		expect(await createTuiMCPHostInteractionPresenter(submitUi).presentForm(form)).toEqual({
			action: "accept",
			content: { name: "canary" },
		});

		const declineUi = {
			input: async () => "canary",
			select: async () => "Decline",
		} as unknown as ExtensionUIContext;
		expect(await createTuiMCPHostInteractionPresenter(declineUi).presentForm(form)).toEqual({ action: "decline" });
	});

	it("maps accepted normalized form content and explicit decline without changing MRTR keys", async () => {
		const bridge = createMCPHostInteractionBridge();
		let formCalls = 0;
		bridge.bind(
			presenter({
				presentForm: async () => {
					formCalls += 1;
					return formCalls === 1
						? { action: "accept", content: { retries: "3", enabled: "true", note: "canary" } }
						: { action: "decline" };
				},
			}),
		);

		expect(
			await bridge.collectInput(
				context({
					approval: { method: "elicitation/create", params: formParams },
					secondApproval: { method: "elicitation/create", params: formParams },
				}),
			),
		).toEqual({
			approval: { action: "accept", content: { retries: 3, enabled: true, note: "canary" } },
			secondApproval: { action: "decline" },
		});
	});

	it("requires URL Open before opening and accepts without URL content", async () => {
		const bridge = createMCPHostInteractionBridge();
		const events: string[] = [];
		bridge.bind(
			presenter({
				presentUrl: async request => {
					events.push(`consent:${request.serverName}:${request.origin}:${request.url}`);
					return { action: "accept" };
				},
				openUrl: url => {
					events.push(`open:${url}`);
				},
			}),
		);

		expect(
			await bridge.collectInput(
				context({
					browser: {
						method: "elicitation/create",
						params: { mode: "url", message: "Open the authorization page", url: "https://example.test/a?b=c" },
					},
				}),
			),
		).toEqual({ browser: { action: "accept" } });
		expect(events).toEqual([
			"consent:release-server:https://example.test:https://example.test/a?b=c",
			"open:https://example.test/a?b=c",
		]);
	});

	it("cancels unsafe, aborted, and opener-failed requests without invoking unsafe URLs", async () => {
		const unsafeBridge = createMCPHostInteractionBridge();
		let presented = false;
		unsafeBridge.bind(
			presenter({
				presentUrl: async () => {
					presented = true;
					return { action: "accept" };
				},
			}),
		);
		expect(
			await unsafeBridge.collectInput(
				context({
					unsafe: {
						method: "elicitation/create",
						params: { mode: "url", message: "Open", url: "http://example.test" },
					},
					valid: { method: "elicitation/create", params: formParams },
				}),
			),
		).toEqual({ unsafe: { action: "cancel" }, valid: { action: "cancel" } });
		expect(presented).toBe(false);

		const aborted = new AbortController();
		aborted.abort();
		expect(
			await unsafeBridge.collectInput(
				context({ form: { method: "elicitation/create", params: formParams } }, aborted.signal),
			),
		).toEqual({ form: { action: "cancel" } });

		const abortDuringPresentation = new AbortController();
		const bridgeAbortedDuringPresentation = createMCPHostInteractionBridge();
		bridgeAbortedDuringPresentation.bind(
			presenter({
				presentForm: async () => {
					abortDuringPresentation.abort();
					return { action: "accept", content: { retries: "1", enabled: "true" } };
				},
			}),
		);
		expect(
			await bridgeAbortedDuringPresentation.collectInput(
				context(
					{
						first: { method: "elicitation/create", params: formParams },
						second: { method: "elicitation/create", params: formParams },
					},
					abortDuringPresentation.signal,
				),
			),
		).toEqual({ first: { action: "cancel" }, second: { action: "cancel" } });

		const failingBridge = createMCPHostInteractionBridge();
		failingBridge.bind(
			presenter({
				presentUrl: async () => ({ action: "accept" }),
				openUrl: () => {
					throw new Error("launcher unavailable");
				},
			}),
		);
		expect(
			await failingBridge.collectInput(
				context({
					url: {
						method: "elicitation/create",
						params: { mode: "url", message: "Open", url: "https://example.test" },
					},
				}),
			),
		).toEqual({ url: { action: "cancel" } });
	});
});
