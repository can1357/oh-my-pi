import { afterEach, describe, expect, it } from "bun:test";
import {
	type InternalResource,
	InternalUrlRouter,
	type ProtocolHandler,
} from "@oh-my-pi/pi-coding-agent/internal-urls";

const resolveNothing = async (): Promise<InternalResource> => {
	throw new Error("fixture:// never resolves");
};

afterEach(() => {
	InternalUrlRouter.resetForTests();
});

describe("InternalUrlRouter spec contracts", () => {
	it("refuses handlers whose write hook disagrees with spec.write.via", () => {
		const router = InternalUrlRouter.instance();
		const writeWithoutPolicy: ProtocolHandler = {
			scheme: "fixture",
			spec: { backing: "virtual", selectors: "lines", immutable: false },
			resolve: resolveNothing,
			write: async () => {},
		};
		const handlerPolicyWithoutWrite: ProtocolHandler = {
			scheme: "fixture",
			spec: {
				backing: "virtual",
				selectors: "lines",
				immutable: false,
				write: { via: "handler", payload: "text", scope: "workspace", tier: () => "write" },
			},
			resolve: resolveNothing,
		};
		const fileWriteWithoutLocate: ProtocolHandler = {
			scheme: "fixture",
			spec: {
				backing: "file",
				selectors: "lines",
				immutable: false,
				write: { via: "file", payload: "text", scope: "workspace", tier: () => "write" },
			},
			resolve: resolveNothing,
		};

		for (const handler of [writeWithoutPolicy, handlerPolicyWithoutWrite, fileWriteWithoutLocate]) {
			expect(() => router.register(handler)).toThrow("fixture://");
		}
		expect(router.canHandle("fixture://x")).toBe(false);
	});

	it("approves writes to schemes without a write policy at the fail-closed write tier", () => {
		const router = InternalUrlRouter.instance();

		expect(router.writeTier("artifact://3", "x", undefined)).toBe("write");
		expect(router.writeTier("history://Worker", "x", undefined)).toBe("write");
		// Declared policies still decide: local:// is session scratch, approved at read tier.
		expect(router.writeTier("local:/notes.md", "x", undefined)).toBe("read");
	});
});
