import { describe, expect, it } from "bun:test";
import { formatPythonForDisplay } from "@oh-my-pi/pi-coding-agent/tools/eval-format/python";

const compact =
	'class Classifier:def classify(self,value):if value>0:return "positive";elif value<0:return "negative";else:return "zero"';

const expandedCompact = [
	"class Classifier:",
	"    def classify(self,value):",
	"        if value>0:",
	'            return "positive";',
	"        elif value<0:",
	'            return "negative";',
	"        else:",
	'            return "zero"',
].join("\n");

const lexicalSafetySource = String.raw`if ready:# keep ; and : exactly
    text = "semi; escaped \" quote"; result = call([1; 2], {"k;": 3}) # tail ; :
else:# other
    result = None`;

const lexicalSafetyExpected = [
	"if ready:# keep ; and : exactly",
	String.raw`    text = "semi; escaped \" quote";`,
	'    result = call([1; 2], {"k;": 3}) # tail ; :',
	"else:# other",
	"    result = None",
].join("\n");

describe("formatPythonForDisplay", () => {
	it("expands genuinely compact nested suites and compound clauses", () => {
		expect(formatPythonForDisplay(compact)).toBe(expandedCompact);
	});

	it("only splits top-level semicolons and leaves strings, delimiters, and comments intact", () => {
		expect(formatPythonForDisplay(lexicalSafetySource)).toBe(lexicalSafetyExpected);
	});

	it("keeps unfinished strings and headers conservative", () => {
		const unfinished = 'def build():value = """open;:#\nstill open';
		expect(formatPythonForDisplay(unfinished)).toBe('def build():\n    value = """open;:#\nstill open');
		expect(formatPythonForDisplay("while waiting:")).toBe("while waiting:");
	});

	it("is idempotent for compact, readable, and incomplete prefixes", () => {
		const readable = [
			"def outer(value):",
			"    if value:",
			'        return {"items": [value; 2]}',
			"    else:",
			"        return None",
		].join("\n");
		const unfinished = 'def build():value = """open;:#\nstill open';

		for (const source of [compact, lexicalSafetySource, readable, unfinished, "if pending:"]) {
			const formatted = formatPythonForDisplay(source);
			expect(formatPythonForDisplay(formatted)).toBe(formatted);
		}
	});

	it("never changes lines committed by an earlier sequential prefix", () => {
		const source =
			'async def choose(values):if values:item="a;b";elif fallback:item=call([1;2]);else:item="""open\nstill';
		const expected = [
			"async def choose(values):",
			"    if values:",
			'        item="a;b";',
			"    elif fallback:",
			"        item=call([1;2]);",
			"    else:",
			'        item="""open',
			"still",
		].join("\n");
		let committed: string[] = [];

		for (let end = 0; end <= source.length; end++) {
			const formatted = formatPythonForDisplay(source.slice(0, end));
			const nextCommitted = formatted.split("\n").slice(0, -1);
			expect(nextCommitted.slice(0, committed.length)).toEqual(committed);
			committed = nextCommitted;
		}
		expect(formatPythonForDisplay(source)).toBe(expected);
	});
});
