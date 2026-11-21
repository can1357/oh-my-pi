import { afterEach, describe, expect, it, vi } from "bun:test";
import { containedEnv } from "@oh-my-pi/pi-coding-agent/sandbox/env";
import * as utils from "@oh-my-pi/pi-utils";

afterEach(() => {
	vi.restoreAllMocks();
});

// Which values omp's own .env files define is `stripOmpDotenvEnv`'s contract (pi-utils env tests);
// here `OWN_KEY` stands in for one of them.
describe("containedEnv", () => {
	it("strips the base env and layers the explicit env on top unchanged, own-file values included", () => {
		vi.spyOn(utils, "stripOmpDotenvEnv").mockImplementation(env =>
			Object.fromEntries(
				Object.entries(env).filter(
					(entry): entry is [string, string] => entry[0] !== "OWN_KEY" && entry[1] !== undefined,
				),
			),
		);
		const base = { OWN_KEY: "secret", KEPT: "kept", UNSET: undefined };
		expect(containedEnv(base)).toStrictEqual({ KEPT: "kept" });
		expect(containedEnv(base, { OWN_KEY: "secret", KEPT: "explicit", SKIPPED: undefined })).toStrictEqual({
			KEPT: "explicit",
			OWN_KEY: "secret",
		});
	});
});
