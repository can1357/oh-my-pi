/**
 * tmux attachment report parsing.
 *
 * This parse is the whole decision behind `Terminal.hasAudience`, and so
 * behind whether a pane keeps its full frame rate. Every row below was read
 * off a real tmux 3.8 server; the shapes are not invented.
 *
 * Contract this test defends: only a report that positively shows nobody
 * attached, for a pane this process owns, may answer `false`. Everything else
 * answers `undefined`, which the renderer treats as watched.
 */
import { describe, expect, it } from "bun:test";
import { parseTmuxAttachmentReport } from "../src/tmux";

const OWNED = () => true;
const FOREIGN = () => false;

describe("parseTmuxAttachmentReport", () => {
	it.each([
		["detached, ungrouped (group field empty)", "0\t\t/dev/pts/4", false],
		["own session attached", "1\t\t/dev/pts/4", true],
		["own session attached, resolved through a grouped sibling", "0\t1\t/dev/pts/4", true],
		["grouped, nobody attached", "0\t0\t/dev/pts/4", false],
		["only the grouped sibling attached", "1\t1\t/dev/pts/4", true],
		["several clients", "3\t3\t/dev/pts/4", true],
	])("%s", (_name, report, expected) => {
		expect(parseTmuxAttachmentReport(report, OWNED)).toBe(expected);
	});

	it.each([
		["a pane the server no longer has still exits 0, with empty fields", "\t\t"],
		["no counts at all", "\t\t/dev/pts/4"],
		["a tmux that printed nothing", ""],
		["an unparseable count with no pane tty", "yes"],
		["a report missing its pane tty", "0\t0"],
	])("cannot establish an empty audience: %s", (_name, report) => {
		expect(parseTmuxAttachmentReport(report, OWNED)).toBeUndefined();
	});

	it("refuses a pane that is not this process's terminal", () => {
		// `TMUX`/`TMUX_PANE` are inherited by anything a pane launches, so a GUI
		// terminal started from a detached pane must not read that pane's empty
		// audience as its own window's.
		expect(parseTmuxAttachmentReport("0\t0\t/dev/pts/4", FOREIGN)).toBeUndefined();
		expect(parseTmuxAttachmentReport("1\t1\t/dev/pts/4", FOREIGN)).toBeUndefined();
	});

	it("passes the reported pane tty to the ownership check, trimmed", () => {
		const seen: string[] = [];
		parseTmuxAttachmentReport("0\t0\t /dev/pts/9 ", tty => {
			seen.push(tty);
			return true;
		});
		expect(seen).toEqual(["/dev/pts/9"]);
	});
});
