import { describe, expect, it } from "bun:test";
import { formatJavaScriptForDisplay } from "@oh-my-pi/pi-coding-agent/tools/eval-format/javascript";

describe("formatJavaScriptForDisplay", () => {
	it("expands compact control flow and keeps short objects and arrays inline", () => {
		expect(formatJavaScriptForDisplay("if (ready){const item = { value: 1 };use(item);}else{fallback();}")).toBe(
			["if (ready) {", "    const item = { value: 1 };", "    use(item);", "} else {", "    fallback();", "}"].join(
				"\n",
			),
		);

		expect(formatJavaScriptForDisplay("const rows = [{ value: 1 },{ value: 2 }];")).toBe(
			"const rows = [{ value: 1 }, { value: 2 }];",
		);
	});

	it("explodes object literals that exceed the display width", () => {
		const source =
			"const box={left:rect.left+offset.left,right:rect.right+offset.right,top:rect.top+offset.top,bottom:rect.bottom+offset.bottom};";
		expect(formatJavaScriptForDisplay(source)).toBe(
			[
				"const box = {",
				"    left: rect.left + offset.left,",
				"    right: rect.right + offset.right,",
				"    top: rect.top + offset.top,",
				"    bottom: rect.bottom + offset.bottom",
				"};",
			].join("\n"),
		);
	});

	it("normalizes operator spacing, preserves angle brackets, and keeps for-loop header semicolons inline", () => {
		expect(formatJavaScriptForDisplay("for(;;){tick();}for(let i=0;i<2;i++){work(i);}")).toBe(
			["for (;;) {", "    tick();", "}", "for (let i = 0; i<2; i++) {", "    work(i);", "}"].join("\n"),
		);
		// Angle brackets never get binary-operator spacing: generics would mangle.
		expect(formatJavaScriptForDisplay("const seen=new Map<string,number>();")).toBe(
			"const seen = new Map<string, number>();",
		);
	});

	it("does not split literals, templates, regexes, or comments", () => {
		const doubleQuoted = String.raw`"a\";{b}"`;
		const singleQuoted = String.raw`'a\';{b}'`;
		// oxlint-disable-next-line no-template-curly-in-string -- sample source-code string contains template placeholder
		const template = '`raw;{${fn({ value: "}" })}}`';
		const regex = "/[;{}]+/g";
		const lineComment = "// keep ; { }";
		const blockComment = "/* keep ; { } */";
		const source = `const double = ${doubleQuoted};const single = ${singleQuoted};const template = ${template};const regex = ${regex}; ${lineComment}\n${blockComment}done();`;

		expect(formatJavaScriptForDisplay(source)).toBe(
			[
				`const double = ${doubleQuoted};`,
				`const single = ${singleQuoted};`,
				`const template = ${template};`,
				`const regex = ${regex}; ${lineComment}`,
				`${blockComment}done();`,
			].join("\n"),
		);
	});

	it("returns unfinished literals, comments, and blocks without inventing closers", () => {
		const samples: Array<{ source: string; expected: string }> = [
			{ source: "const value = `raw;${call({ x: 1", expected: "const value = `raw;${call({ x: 1" },
			{ source: "/* unfinished ; {", expected: "/* unfinished ; {" },
			{ source: "// unfinished ; {", expected: "// unfinished ; {" },
			{ source: "const pattern = /[;{]", expected: "const pattern = /[;{]" },
			{ source: "if (ready){work();", expected: "if (ready) {\n    work();" },
		];

		for (const sample of samples) {
			expect(() => formatJavaScriptForDisplay(sample.source)).not.toThrow();
			expect(formatJavaScriptForDisplay(sample.source)).toBe(sample.expected);
		}
	});

	it("is idempotent", () => {
		const source = "try{const result = { ok: true };use(result);}catch(error){report(error);}finally{cleanup();}";
		const formatted = formatJavaScriptForDisplay(source);
		expect(formatJavaScriptForDisplay(formatted)).toBe(formatted);
	});

	it("never changes already committed lines while a prefix grows", () => {
		// oxlint-disable-next-line no-template-curly-in-string -- sample source-code string contains template placeholder
		const source = "if(flag){const value={text:`a;${item}`};run(value);}else{for(;;){tick();}}";
		let committed: string[] = [];

		for (let end = 1; end <= source.length; end++) {
			let formatted = "";
			expect(() => {
				formatted = formatJavaScriptForDisplay(source.slice(0, end));
			}).not.toThrow();
			const lines = formatted.split("\n");
			const nextCommitted = lines.slice(0, -1);
			expect(nextCommitted.slice(0, committed.length)).toEqual(committed);
			committed = nextCommitted;
		}
	});
});
