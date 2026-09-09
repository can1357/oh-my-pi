import { describe, expect, test } from "bun:test";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";

describe("MemorySessionStorage indexed mirror", () => {
	test("append builds the same content as a single writeTextSync of the join", async () => {
		const storage = new MemorySessionStorage();
		const path = "/virtual/session.jsonl";
		const parts = Array.from({ length: 32 }, (_, i) => `{"i":${i}}\n`);
		const writer = storage.openWriter(path, { flags: "w" });
		try {
			for (const part of parts) await writer.append(part);
		} finally {
			await writer.close();
		}

		// Construct the baseline from the same parts.
		const expected = parts.join("");
		const actual = await storage.readText(path);
		expect(actual).toBe(expected);
		expect(actual.length).toBe(expected.length);
	});

	test("statSync reports UTF-8 byte length, not character count", async () => {
		const storage = new MemorySessionStorage();
		const path = "/virtual/unicode.jsonl";
		const writer = storage.openWriter(path, { flags: "w" });
		try {
			await writer.append("héllo\n"); // é = 2 bytes in UTF-8
			await writer.append("日本語\n"); // 3 chars × 3 bytes = 9
		} finally {
			void writer.close();
		}

		const expectedBytes = Buffer.byteLength("héllo\n日本語\n", "utf-8");
		expect(storage.statSync(path).size).toBe(expectedBytes);
	});

	test("readTextSlices slices the head by UTF-8 byte budget across chunks", async () => {
		const storage = new MemorySessionStorage();
		const path = "/virtual/prefix.jsonl";
		const writer = storage.openWriter(path, { flags: "w" });
		try {
			await writer.append("alpha\n");
			await writer.append("bravo\n");
			await writer.append("charlie\n");
		} finally {
			void writer.close();
		}

		// Cap mid-second-chunk; first chunk = 6B, take 4 of the second.
		const [prefix] = await storage.readTextSlices(path, 10, 0);
		expect(prefix).toBe("alpha\nbrav");
	});

	test("readTextSlices slices the tail by UTF-8 byte budget across chunks", async () => {
		const storage = new MemorySessionStorage();
		const path = "/virtual/suffix.jsonl";
		const writer = storage.openWriter(path, { flags: "w" });
		try {
			await writer.append("alpha\n");
			await writer.append("bravo\n");
			await writer.append("charlie\n");
		} finally {
			void writer.close();
		}

		// Last 10 bytes span the tail of "bravo\n" plus all of "charlie\n".
		expect(await storage.readTextSlices(path, 0, 10)).toEqual(["", "o\ncharlie\n"]);
		// Budget >= size returns the whole file; zero budget returns "".
		expect(await storage.readTextSlices(path, 0, 100)).toEqual(["", "alpha\nbravo\ncharlie\n"]);
		expect(await storage.readTextSlices(path, 0, 0)).toEqual(["", ""]);
	});

	test("readTextSlices returns both requested ends in one call", async () => {
		const storage = new MemorySessionStorage();
		const path = "/virtual/both.jsonl";
		const writer = storage.openWriter(path, { flags: "w" });
		try {
			await writer.append("alpha\n");
			await writer.append("bravo\n");
			await writer.append("charlie\n");
		} finally {
			void writer.close();
		}

		expect(await storage.readTextSlices(path, 10, 10)).toEqual(["alpha\nbrav", "o\ncharlie\n"]);
	});

	test("prefix and suffix preserve byte-oriented UTF-8 slicing semantics", async () => {
		const storage = new MemorySessionStorage();
		const path = "/virtual/unicode-slices.jsonl";
		const writer = storage.openWriter(path, { flags: "w" });
		try {
			await writer.append("é\n");
			await writer.append("日本\n");
		} finally {
			void writer.close();
		}

		expect(storage.statSync(path).size).toBe(Buffer.byteLength("é\n日本\n", "utf-8"));
		expect(await storage.readTextSlices(path, 4, 5)).toEqual(["é\n�", "�本\n"]);
		expect(await storage.readTextSlices(path, 0, 4)).toEqual(["", "本\n"]);
	});

	test("subsequent append after readText appends after materialized content", async () => {
		const storage = new MemorySessionStorage();
		const path = "/virtual/cont.jsonl";
		const writer = storage.openWriter(path, { flags: "w" });
		try {
			await writer.append("first\n");
			await writer.append("second\n");
			// Materialise once — implementation may collapse previous chunks into one
			// string, but future appends must still retain content and byte accounting.
			expect(await storage.readText(path)).toBe("first\nsecond\n");
			await writer.append("third\n");
			expect(await storage.readText(path)).toBe("first\nsecond\nthird\n");
			expect(storage.statSync(path).size).toBe(Buffer.byteLength("first\nsecond\nthird\n", "utf-8"));
		} finally {
			void writer.close();
		}
	});

	test("writeTextSync resets the chunks and byte counter (overwrite semantics)", async () => {
		const storage = new MemorySessionStorage();
		const path = "/virtual/overwrite.jsonl";
		storage.writeTextSync(path, "abcdef");
		expect(storage.statSync(path).size).toBe(6);
		storage.writeTextSync(path, "xy");
		expect(storage.statSync(path).size).toBe(2);
		expect(await storage.readText(path)).toBe("xy");
	});

	test("updateSessionTitle replaces the fixed slot and preserves the tail", async () => {
		const storage = new MemorySessionStorage();
		const path = "/virtual/head.jsonl";
		const tail = `${JSON.stringify({ type: "session", id: "s", timestamp: "t", cwd: "/repo" })}\n`;
		storage.writeTextSync(path, `${serializeTitleSlot({ title: "Old", source: "auto", updatedAt: "t1" })}${tail}`);

		await storage.updateSessionTitle(path, { title: "New", source: "user", updatedAt: "t2" });

		const content = await storage.readText(path);
		const [slotLine, ...rest] = content.split("\n");
		expect(JSON.parse(slotLine)).toMatchObject({ type: "title", title: "New", source: "user", updatedAt: "t2" });
		expect(rest.join("\n")).toBe(tail);
	});

	test("updateSessionTitle preserves the memory storage missing-file error", async () => {
		const storage = new MemorySessionStorage();

		await expect(
			storage.updateSessionTitle("/virtual/missing.jsonl", { title: "New", updatedAt: "t2" }),
		).rejects.toThrow("File not found: /virtual/missing.jsonl");
	});
});
