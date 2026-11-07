import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as dirs from "@oh-my-pi/pi-utils";
import { isProviderExhausted, recordProviderFailure } from "../src/session/provider-exhaustion";

let directory: string | undefined;
afterEach(() => {
	if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

test("availability checks avoid rereading unchanged cooldowns and observe replacement and removal", () => {
	directory = fs.mkdtempSync(path.join(os.tmpdir(), "omp-cooldown-cache-"));
	const file = path.join(directory, "provider-cooldowns.json");
	const root = spyOn(dirs, "getProviderCooldownsPath").mockReturnValue(file);
	const read = spyOn(fs, "readFileSync");
	try {
		recordProviderFailure("canary", { status: 402 });
		read.mockClear();
		for (let i = 0; i < 100; i++) expect(isProviderExhausted("canary")).toBe(true);
		expect(read.mock.calls.filter(([name]) => name === file)).toHaveLength(1);
		fs.writeFileSync(`${file}.tmp`, "[]");
		fs.renameSync(`${file}.tmp`, file);
		expect(isProviderExhausted("canary")).toBe(false);
		recordProviderFailure("canary", { status: 402 });
		expect(isProviderExhausted("canary")).toBe(true);
		fs.unlinkSync(file);
		expect(isProviderExhausted("canary")).toBe(false);
	} finally {
		read.mockRestore();
		root.mockRestore();
	}
});
