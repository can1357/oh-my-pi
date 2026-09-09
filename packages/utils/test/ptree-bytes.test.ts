import { describe, expect, it } from "bun:test";
import { spawn } from "@oh-my-pi/pi-utils/ptree";

describe("ptree.ChildProcess.bytes()", () => {
	// Regression for https://github.com/can1357/oh-my-pi/issues/3712:
	// `Response(stream).bytes()` returns the raw `ArrayBuffer` once the body
	// arrives in more than one chunk (which happens for subprocess stdout past
	// ~128 KB). Downstream code — e.g. the SSH read path's `decodeUtf8Text` —
	// relied on `Uint8Array` methods (`.indexOf`, `.subarray`) and crashed.
	it("returns a Uint8Array regardless of stdout size", async () => {
		// 256 KB is comfortably past the multi-chunk boundary observed on Bun
		// 1.3.x; the test then asserts only on the contract, not on the exact
		// chunk threshold, so it stays robust to future Bun runtime changes.
		const size = 256 * 1024;
		const child = spawn(["bun", "-e", `process.stdout.write("a".repeat(${size}))`]);
		const bytes = await child.bytes();
		await child.exitedCleanly;

		expect(bytes).toBeInstanceOf(Uint8Array);
		expect(bytes.length).toBe(size);
		// The two methods the SSH read path depends on.
		expect(typeof bytes.indexOf).toBe("function");
		expect(typeof bytes.subarray).toBe("function");
		expect(bytes.indexOf(0)).toBe(-1);
		expect(bytes.subarray(0, 4)).toEqual(new Uint8Array([0x61, 0x61, 0x61, 0x61]));
	});
});
