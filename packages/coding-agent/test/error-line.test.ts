import { describe, expect, it } from "bun:test";
import { sanitizeErrorLine } from "@oh-my-pi/pi-coding-agent/modes/components/error-block";
import { TRUNCATE_LENGTHS } from "@oh-my-pi/pi-coding-agent/tools/render-utils";

describe("safe error lines", () => {
	it("shortens multiple quoted home paths without splitting a home directory containing spaces", () => {
		const home = "/home/Alice  Smith";
		const line = sanitizeErrorLine(`EACCES: rename '${home}/old file' -> "${home}/new file"`, undefined, home);
		expect(line).toContain("EACCES");
		expect(line).toContain("'~/old file'");
		expect(line).toContain('"~/new file"');
		expect(line).not.toContain(home);
	});

	it("leaves sibling paths and URL paths intact while shortening local paths", () => {
		const line = sanitizeErrorLine(
			"EACCES /home/alice/file /home/alice-other/file https://host/home/alice/file HTTPS://host/?path=/home/alice/file",
			TRUNCATE_LENGTHS.RECAP,
			"/home/alice",
		);
		expect(line).toContain("EACCES ~/file");
		expect(line).toContain("/home/alice-other/file");
		expect(line).toContain("https://host/home/alice/file");
		expect(line).toContain("HTTPS://host/?path=/home/alice/file");
	});

	it("recognizes Windows home paths case-insensitively with native and mixed separators", () => {
		const line = sanitizeErrorLine(
			String.raw`EACCES 'c:\USERS\Alice Smith\old' -> "C:/Users\alice smith/new" C:\Users\Alice Smith-other\file`,
			TRUNCATE_LENGTHS.RECAP,
			String.raw`C:\Users\Alice Smith`,
		);
		expect(line).toContain(String.raw`'~\old'`);
		expect(line).toContain('"~/new"');
		expect(line).toContain(String.raw`C:\Users\Alice Smith-other\file`);
		expect(line).not.toContain(String.raw`c:\USERS\Alice Smith\old`);
	});

	it("recognizes mixed-separator UNC home paths without rewriting sibling shares", () => {
		const line = sanitizeErrorLine(
			String.raw`EACCES '//HOST/Users\Alice/file' \\host\Users\Alice-other\file`,
			undefined,
			String.raw`\\host\Users\Alice`,
		);
		expect(line).toContain("'~/file'");
		expect(line).toContain(String.raw`\\host\Users\Alice-other\file`);
	});

	it("strips terminal commands before styling and bounds a single row without losing the error code", () => {
		const line = sanitizeErrorLine(
			new Error(
				`\x1b[31mEACCES\x1b[0m\x1b]8;;https://host\x07 /home/alice/file\x1b]8;;\x07\r\nretry\t${"界".repeat(200)}\x00\x7f`,
			),
			undefined,
			"/home/alice",
		);
		expect(line).toContain("EACCES ~/file retry");
		expect(line).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
		expect(line).not.toContain("https://host");
		expect(Bun.stringWidth(line)).toBeLessThanOrEqual(TRUNCATE_LENGTHS.LINE);
		expect(Bun.stringWidth(sanitizeErrorLine("EACCES /home/alice/file", 8, "/home/alice"))).toBeLessThanOrEqual(8);
	});
});
