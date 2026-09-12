import { describe, expect, it } from "bun:test";
import { matchActionKey } from "../src/keys";

describe("matchActionKey", () => {
	it("matches navigation and action keys accurately", () => {
		// Up / Down
		expect(matchActionKey("\x1b[A")).toBe("up");
		expect(matchActionKey("\x1bOA")).toBe("up");
		expect(matchActionKey("k")).toBe("up");

		expect(matchActionKey("\x1b[B")).toBe("down");
		expect(matchActionKey("\x1bOB")).toBe("down");
		expect(matchActionKey("j")).toBe("down");

		// Enter
		expect(matchActionKey("\r")).toBe("enter");
		expect(matchActionKey("\n")).toBe("enter");

		// Toggles
		expect(matchActionKey("a")).toBe("toggle_attention");
		expect(matchActionKey("A")).toBe("toggle_attention");
		expect(matchActionKey("h")).toBe("toggle_healthy");
		expect(matchActionKey("H")).toBe("toggle_healthy");
		expect(matchActionKey("r")).toBe("refresh");
		expect(matchActionKey("R")).toBe("refresh");

		// Close / Escape
		expect(matchActionKey("q")).toBe("close");
		expect(matchActionKey("Q")).toBe("close");
		expect(matchActionKey("\x03")).toBe("close");
		expect(matchActionKey("\x1b")).toBe("escape");

		// Paging
		expect(matchActionKey("\x1b[5~")).toBe("page_up");
		expect(matchActionKey("\x1b[6~")).toBe("page_down");
		expect(matchActionKey("\x1b[H")).toBe("home");
		expect(matchActionKey("\x1b[F")).toBe("end");

		// Unknown
		expect(matchActionKey("z")).toBe("unknown");
	});
});
