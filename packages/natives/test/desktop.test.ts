import { describe, expect, it } from "bun:test";
import { createDesktopSession } from "../native/desktop.js";
import { DesktopSession } from "../native/index.js";

const ERROR_CODE_PREFIX = /^([A-Z][A-Za-z]+): /;
const PERMISSION_STATES = ["granted", "denied", "unknown", "unavailable", "prompt-or-granted"];
const BACKENDS = ["quartz", "x11", "wayland", "win32", "unavailable"];

async function expectRejectionCode(operation: () => Promise<unknown>, acceptedCodes: readonly string[]): Promise<void> {
	const fulfilled = Symbol("fulfilled");
	let rejection: unknown = fulfilled;

	try {
		await operation();
	} catch (error) {
		rejection = error;
	}

	if (rejection === fulfilled) {
		throw new Error(`expected rejection with one of: ${acceptedCodes.join(", ")}`);
	}
	if (!(rejection instanceof Error)) {
		throw new Error("expected native rejection to be an Error");
	}

	expect(rejection.message).toMatch(ERROR_CODE_PREFIX);
	const match = ERROR_CODE_PREFIX.exec(rejection.message);
	if (match === null) {
		throw new Error(`native rejection lacks a CODE prefix: ${rejection.message}`);
	}
	expect(acceptedCodes).toContain(match[1]);
}

describe("DesktopSession", () => {
	it("constructs through the factory and reports the complete capability shape", async () => {
		const session = createDesktopSession({ display: "all" });
		try {
			expect(session).toBeInstanceOf(DesktopSession);

			const capabilities = session.capabilities;
			expect(BACKENDS).toContain(capabilities.backend);
			// displayServer is optional (`displayServer?: string`): napi omits the
			// key entirely when the backend reports None (headless CI).
			expect(["string", "undefined"]).toContain(typeof capabilities.displayServer);
			expect(typeof capabilities.capture).toBe("boolean");
			expect(typeof capabilities.input).toBe("boolean");
			expect(typeof capabilities.ax).toBe("boolean");
			expect(typeof capabilities.backgroundWindowInput).toBe("boolean");
			expect(Array.isArray(capabilities.deliveryModes)).toBe(true);
			for (const mode of capabilities.deliveryModes) {
				expect(typeof mode).toBe("string");
			}
			expect(PERMISSION_STATES).toContain(capabilities.capturePermission);
			expect(PERMISSION_STATES).toContain(capabilities.inputPermission);
			expect(PERMISSION_STATES).toContain(capabilities.axPermission);
			expect(typeof capabilities.displayCount).toBe("number");
		} finally {
			await session.close();
		}
	});

	it("rejects a nonexistent capture target with a documented native code", async () => {
		const session = new DesktopSession({ display: "all" });
		try {
			await expectRejectionCode(
				() => session.capture("no-such-window-id-999999"),
				["WindowNotFound", "InvalidTarget", "CaptureFailed", "PermissionDenied"],
			);
		} finally {
			await session.close();
		}
	});

	it("rejects coordinate input before capture", async () => {
		const session = new DesktopSession({ display: "all" });
		try {
			await expectRejectionCode(
				() => session.click("desktop", 1, 1),
				["InvalidCoordinateFrame", "PermissionDenied"],
			);
		} finally {
			await session.close();
		}
	});

	it("closes idempotently", async () => {
		const session = new DesktopSession({ display: "all" });
		await session.close();
		await session.close();
	});

	it("rejects calls after close with Closed", async () => {
		const session = new DesktopSession({ display: "all" });
		await session.close();

		await expectRejectionCode(() => session.capture("desktop"), ["Closed"]);
		await expectRejectionCode(() => session.listWindows(), ["Closed"]);
		await expectRejectionCode(() => session.click("desktop", 1, 1), ["Closed"]);
	});
});
