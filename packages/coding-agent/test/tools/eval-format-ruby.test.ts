import { describe, expect, it } from "bun:test";
import { formatRubyForDisplay } from "@oh-my-pi/pi-coding-agent/tools/eval-format/ruby";

describe("formatRubyForDisplay", () => {
	it("expands genuinely compact nested blocks", () => {
		const source = 'class Greeter;def call(name);if name;puts "Hello, #{name}";else;puts "nobody";end;end;end';

		expect(formatRubyForDisplay(source)).toBe(
			[
				"class Greeter;",
				"    def call(name);",
				"        if name;",
				'            puts "Hello, #{name}";',
				"        else;",
				'            puts "nobody";',
				"        end;",
				"    end;",
				"end",
			].join("\n"),
		);
	});

	it("keeps semicolons and keywords inside literals, symbols, interpolation, and comments", () => {
		const source =
			'puts "if; \\"end\\"; #{label == "else;"}"; puts \'do; end\'; puts `case; end`; puts :end; puts :"if;else"; puts %q{class; {end;}}; puts %Q[do; #{value; other}]; # if; end';

		expect(formatRubyForDisplay(source)).toBe(
			[
				'puts "if; \\"end\\"; #{label == "else;"}";',
				"puts 'do; end';",
				"puts `case; end`;",
				"puts :end;",
				'puts :"if;else";',
				"puts %q{class; {end;}};",
				"puts %Q[do; #{value; other}];",
				"# if; end",
			].join("\n"),
		);
	});

	it("indents do blocks and aligns case branches", () => {
		const source = "items.each do |item|;case item;when 1;puts item;else;next;end;end";

		expect(formatRubyForDisplay(source)).toBe(
			[
				"items.each do |item|;",
				"    case item;",
				"    when 1;",
				"        puts item;",
				"    else;",
				"        next;",
				"    end;",
				"end",
			].join("\n"),
		);
	});

	it("leaves modifier-form statements conservative", () => {
		expect(formatRubyForDisplay("work if ready; cleanup unless dry_run")).toBe(
			"work if ready;\ncleanup unless dry_run",
		);
	});

	it("tolerates unfinished literal and block prefixes without inventing closers", () => {
		const unfinished = [
			'"unfinished; \\"still open',
			"'unfinished; end",
			"`unfinished; do",
			"%q{unfinished; end",
			"%Q[before #{value; other}",
			"items.each do; work",
		];

		for (const source of unfinished) expect(() => formatRubyForDisplay(source)).not.toThrow();
		expect(formatRubyForDisplay(unfinished[0])).toBe(unfinished[0]);
		expect(formatRubyForDisplay(unfinished[3])).toBe(unfinished[3]);
		expect(formatRubyForDisplay(unfinished[4])).toBe(unfinished[4]);
		expect(formatRubyForDisplay(unfinished[5])).toBe("items.each do;\n    work");
	});

	it("is idempotent and preserves already-readable multiline code", () => {
		const compact = "begin;work if ready;rescue Error;recover;ensure;cleanup;end";
		const formatted = formatRubyForDisplay(compact);
		expect(formatRubyForDisplay(formatted)).toBe(formatted);

		const readable = ["module Jobs", "    while ready", "        work if enabled", "    end", "end"].join("\n");
		expect(formatRubyForDisplay(readable)).toBe(readable);
	});

	it("never changes previously committed lines while a prefix grows", () => {
		const source =
			"class Runner;items.each do |item|;if item;puts %Q[value; #{item}];else;# keep if; end\nnext;end;end;end";
		let committed = "";

		for (let length = 0; length <= source.length; length++) {
			const formatted = formatRubyForDisplay(source.slice(0, length));
			expect(formatted.startsWith(committed)).toBe(true);
			const lastBreak = formatted.lastIndexOf("\n");
			if (lastBreak >= 0) committed = formatted.slice(0, lastBreak + 1);
		}
	});
});
