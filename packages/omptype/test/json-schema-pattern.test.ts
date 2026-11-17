import { describe, expect, it } from "bun:test";
import { compileSimplePattern } from "../src/jsonschema/pattern";

const PATTERNS = [
	"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
	"^\\d{4}-\\d{2}-\\d{2}$",
	"^[A-Za-z0-9._-]+$",
	"^[a-z0-9-]+$",
	"^#[0-9a-f]{6}$",
	"^[0-9a-f]{16}$",
	"^a?b$",
	"^[a-z]+[0-9]{2}$",
	"^x*$",
	"^\\d{2,4}$",
	"^\\w+\\.json$",
	"^ab{2,}c$",
	"^$",
	"^\\$$",
	"^a\\$",
	// Not simple: must fall back to the regex.
	"^(a|b)$",
	"^[^a]+$",
	"^.$",
	"abc",
	"^a+b+$",
	"^[a-z]+?$",
	"^é+$",
	"^\\s+$",
];

const INPUTS = [
	"",
	"a",
	"b",
	"ab",
	"abb",
	"abbc",
	"abc",
	"x",
	"xxxx",
	"12",
	"123",
	"12345",
	"2026-10-31",
	"2026-1-031",
	"01890a5d-ac96-774b-bcce-b302099a8057",
	"01890a5d-ac96-774b-bcce-b302099a805",
	"01890A5D-ac96-774b-bcce-b302099a8057",
	"A.b_c",
	"a b",
	"a-1",
	"#00ff00",
	"#00ff0",
	"00112233aabbccdd",
	"abc12",
	"abc1",
	"file.json",
	"file.json\n",
	"$",
	"a$",
	"é",
	"ab😀",
	"😀",
	" \t",
];

describe("compileSimplePattern", () => {
	it("agrees with the u-flag RegExp on every pattern it compiles", () => {
		const mismatches: string[] = [];
		for (const source of PATTERNS) {
			const helper = compileSimplePattern(source, "test");
			if (helper === undefined) continue;
			const compiled = new Function(`${helper};return test`)() as (value: string) => boolean;
			const regex = new RegExp(source, "u");
			for (const input of INPUTS) {
				if (compiled(input) !== regex.test(input)) mismatches.push(`${source} on ${JSON.stringify(input)}`);
			}
		}
		expect(mismatches).toEqual([]);
	});
});
