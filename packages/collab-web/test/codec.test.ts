import { describe, expect, it } from "bun:test";
import type { WireFrame } from "@oh-my-pi/pi-wire";
import { generateRoomKey, importRoomKey, open, seal } from "../src/lib/codec";
import { decodeBase64Url } from "../src/lib/link";

/** Interop vector generated with the real coding-agent `seal()` (see contract). */
const VECTOR_KEY = "AAcOFRwjKjE4P0ZNVFtiaXB3foWMk5qhqK-2vcTL0tk";
const VECTOR_SEALED = "m0PA1QNfpOGtl_iq1yfKhoux0moFN_WQtCExumBVOWKeHFY_yx7T4s3B5YFUSn6Dc9aAyVsjIjPQXLxqsg8_UQiZ9Q";

describe("collab codec", () => {
	it("decrypts the coding-agent interop vector", async () => {
		const keyBytes = decodeBase64Url(VECTOR_KEY);
		const sealed = decodeBase64Url(VECTOR_SEALED);
		if (!keyBytes || !sealed) throw new Error("vector constants must decode");
		const key = await importRoomKey(keyBytes);
		const frame = await open(key, sealed);
		expect(frame).toEqual({ t: "hello", proto: 1, name: "vector" });
	});

	it("round-trips a frame through seal/open", async () => {
		const key = await importRoomKey(generateRoomKey());
		const frame: WireFrame = { t: "prompt", text: "hello there" };
		const opened = await open(key, await seal(key, frame));
		expect(opened).toEqual(frame);
	});

	it("rejects tampered ciphertext", async () => {
		const key = await importRoomKey(generateRoomKey());
		const sealed = await seal(key, { t: "abort" });
		sealed[sealed.length - 1] ^= 0xff;
		await expect(open(key, sealed)).rejects.toThrow();
	});
});
