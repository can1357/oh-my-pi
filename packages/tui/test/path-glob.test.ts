import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expandPathGlobAt } from "@oh-my-pi/pi-tui/path-glob";

const scratch: string[] = [];

/** A temp tree holding `service/pixivfe/` and `service/notes.md`. */
function makeTree(): string {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "path-glob-"));
	scratch.push(base);
	fs.mkdirSync(path.join(base, "service", "pixivfe"), { recursive: true });
	fs.writeFileSync(path.join(base, "service", "notes.md"), "# notes\n");
	return base;
}

function expand(line: string, base: string): ReturnType<typeof expandPathGlobAt> {
	return expandPathGlobAt(line, line.length, base);
}

afterEach(() => {
	for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("expandPathGlobAt", () => {
	it("replaces a glob matching one directory with that path and a trailing separator", () => {
		const base = makeTree();
		const expansion = expand("/cd */pixivfe", base);

		expect(expansion?.replacement).toBe(`service/pixivfe${path.sep}`);
		// The token starts after `/cd `, so the rest of the draft survives the expansion.
		expect(expansion?.start).toBe(4);
	});

	it("keeps an absolute token absolute", () => {
		const base = makeTree();
		const expansion = expand(`${base}/ser*/notes.md`, base);

		expect(expansion?.replacement).toBe(`${base}/service/notes.md`);
	});

	it("leaves a glob with several matches to the completion popup", () => {
		const base = makeTree();
		fs.writeFileSync(path.join(base, "service", "other.md"), "# other\n");

		expect(expand("*/pixivfe", base)).not.toBeNull();
		expect(expand("ser*/*.md", base)).toBeNull();
	});

	it("leaves a glob that matches nothing alone", () => {
		const base = makeTree();
		expect(expand("*/pixivfe2", base)).toBeNull();
	});

	it("ignores a token that carries no glob", () => {
		const base = makeTree();
		expect(expand("/cd service", base)).toBeNull();
	});

	it("ignores a URL query, whose `?` is not a path glob", () => {
		const base = makeTree();
		expect(expand("https://example.com/?q=pixivfe", base)).toBeNull();
	});

	it("refuses a home of another user", () => {
		const base = makeTree();
		expect(expand("~root/pixivfe*", base)).toBeNull();
	});
});
