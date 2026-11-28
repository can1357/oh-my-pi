import { expect, test } from "bun:test";
import { formatBytes } from "../src/bytes";

test("formats binary multiples", () => {
	expect(formatBytes(512)).toBe("512 B");
	expect(formatBytes(1536)).toBe("1.5 KiB");
	expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GiB");
});
