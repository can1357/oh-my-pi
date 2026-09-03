import { describe, expect, it } from "bun:test";
import { deviceCheckGenerateToken } from "../native/index.js";

// A locally built addon can predate the DeviceCheck binding; skip instead of
// failing on stale artifacts, mirroring the desktop test gate.
const deviceCheckTest = typeof deviceCheckGenerateToken === "function" ? it : it.skip;

describe("deviceCheckGenerateToken", () => {
	deviceCheckTest("resolves the DCDevice.generateToken contract", async () => {
		const result = await deviceCheckGenerateToken();
		expect(typeof result.supported).toBe("boolean");
		expect(typeof result.latencyMs).toBe("number");
		expect(result.latencyMs).toBeGreaterThanOrEqual(0);
		if (process.platform !== "darwin") {
			expect(result.supported).toBe(false);
			return;
		}
		if (!result.supported) {
			expect(result.tokenBase64 ?? null).toBeNull();
			return;
		}
		// A supported device yields exactly one of token or error reason;
		// network/Apple-service failures surface as `error`, never a throw.
		expect(typeof result.tokenBase64 === "string").toBe(result.tokenBase64 !== undefined);
		if (result.tokenBase64 !== undefined) {
			expect(result.tokenBase64.length).toBeGreaterThan(0);
			expect(result.error ?? null).toBeNull();
		} else {
			expect(typeof result.error).toBe("string");
		}
	});
});
