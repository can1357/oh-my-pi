import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { StreamRedactor } from "@oh-my-pi/pi-coding-agent/stream/redactor";
import { logger } from "@oh-my-pi/pi-utils";

let redactor: StreamRedactor;
let cwd: string;

beforeAll(async () => {
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stream-redactor-"));
	redactor = await StreamRedactor.load(cwd, []);
});

afterAll(async () => {
	await fs.rm(cwd, { force: true, recursive: true });
});

describe("StreamRedactor", () => {
	it("redacts a vendor token while it is still being typed", () => {
		expect(redactor.redactRow("token sk-ant-api03-x pending")).toBe("token •••••• pending");
	});

	it("redacts an incomplete six-character prefix of a dotenv-derived value", async () => {
		const name = "STREAM_REDACTOR_PUBLIC_LABEL";
		const value = "source-value-987654";
		const previous = process.env[name];
		process.env[name] = value;
		await Bun.write(path.join(cwd, ".env"), `${name}=${value}\n`);
		try {
			const dotenvRedactor = await StreamRedactor.load(cwd, []);
			expect(dotenvRedactor.redactRow("typing source")).toBe("typing ••••••");
		} finally {
			if (previous === undefined) delete process.env[name];
			else process.env[name] = previous;
			await fs.rm(path.join(cwd, ".env"), { force: true });
		}
	});

	it("drops ANSI styling from a row containing a secret", async () => {
		const styledRedactor = await StreamRedactor.load(cwd, ["styled-secret"]);
		const row = "value \x1b[31mstyled-secret\x1b[0m remains";
		expect(styledRedactor.redactRow(row)).toBe("value •••••• remains");
	});

	it("returns the original benign row unchanged", () => {
		const row = "compilation finished successfully";
		expect(redactor.redactRow(row)).toBe(row);
	});

	it("redacts only the value in a secret assignment", () => {
		expect(redactor.redactRow("prefix API_KEY=abcd1234 suffix")).toBe("prefix API_KEY=•••••• suffix");
	});

	it("skips an invalid user pattern while applying the remaining patterns", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const customRedactor = await StreamRedactor.load(cwd, ["(", "custom-secret"]);
			expect(customRedactor.redactRow("found custom-secret here")).toBe("found •••••• here");
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});

	it("redacts a connection URL password without hiding the username or host", () => {
		expect(redactor.redactRow("db postgres://alice:hunter2-db@db.local/main")).toBe(
			"db postgres://alice:••••••@db.local/main",
		);
	});
});
