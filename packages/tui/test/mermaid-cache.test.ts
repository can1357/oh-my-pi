import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as mermaidAscii from "@oh-my-pi/pi-utils/mermaid-ascii";
import { clearMermaidCache, resolveMermaidAscii } from "../src/theme/mermaid-cache";

describe("resolveMermaidAscii resize selection", () => {
	const renders: string[] = [];

	beforeEach(() => {
		renders.length = 0;
		clearMermaidCache();
		vi.spyOn(mermaidAscii, "renderMermaidAsciiSafe").mockImplementation((source, options) => {
			const direction = options?.direction ?? "authored";
			renders.push(`${source}:${direction}`);
			if (source === "bad") return null;
			if (source === "wide-authored") {
				if (direction === "authored") return "AUTHORED-ALSO-WIDE\nsecond\nthird";
				if (direction === "TD") return "td\ntd\ntd";
				return "left-to-right";
			}
			if (source === "colored") {
				if (direction === "authored") return "\u001b[31mabcd\u001b[0m";
				if (direction === "TD") return "too-wide-for-four";
				return "z";
			}
			return "direction-ignored-and-wide";
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps the authored layout when no width is given", () => {
		expect(resolveMermaidAscii("wide-authored")).toBe("AUTHORED-ALSO-WIDE\nsecond\nthird");
		expect(renders).toEqual(["wide-authored:authored"]);
	});

	it("picks the shortest fitting orientation, then switches when a resize makes it overflow", () => {
		expect(resolveMermaidAscii("wide-authored", { maxWidth: 30 })).toBe("left-to-right");
		expect(renders).toEqual(["wide-authored:authored", "wide-authored:TD", "wide-authored:LR"]);

		expect(resolveMermaidAscii("wide-authored", { maxWidth: 10 })).toBe("td\ntd\ntd");
		expect(renders).toHaveLength(3);
	});

	it("uses the narrowest layout only when nothing fits", () => {
		expect(resolveMermaidAscii("wide-authored", { maxWidth: 1 })).toBe("td\ntd\ntd");
	});

	it("measures themed ASCII without counting ANSI", () => {
		expect(resolveMermaidAscii("colored", { maxWidth: 4 })).toBe("\u001b[31mabcd\u001b[0m");
	});

	it("returns null without trying orientations when the source fails", () => {
		expect(resolveMermaidAscii("bad", { maxWidth: 80 })).toBeNull();
		expect(renders).toEqual(["bad:authored"]);
	});

	it("renders diagrams that ignore direction only as authored", () => {
		const sources = [
			"sequenceDiagram\nAlice->>Bob: hi",
			"classDiagram\nclass A",
			"erDiagram\nA ||--o{ B : rel",
			"xychart-beta\nbar [1, 2]",
			"xychart\nbar [1, 2]",
		];
		for (const source of sources) {
			renders.length = 0;
			clearMermaidCache();
			expect(resolveMermaidAscii(source, { maxWidth: 4 })).toBe("direction-ignored-and-wide");
			expect(renders).toEqual([`${source}:authored`]);
		}
	});

	it("skips the forced render that repeats a flowchart's authored direction", () => {
		const cases: Array<[string, string[]]> = [
			["flowchart TD\nA --> B", ["LR"]],
			["graph tb\nA --> B", ["LR"]],
			["flowchart LR\nA --> B", ["TD"]],
			["graph RL\nA --> B", ["TD"]],
			["flowchart BT\nA --> B", ["TD", "LR"]],
			["stateDiagram-v2\n[*] --> A", ["TD", "LR"]],
		];
		for (const [source, forced] of cases) {
			renders.length = 0;
			clearMermaidCache();
			resolveMermaidAscii(source, { maxWidth: 4 });
			expect(renders).toEqual([`${source}:authored`, ...forced.map(direction => `${source}:${direction}`)]);
		}
	});
});
