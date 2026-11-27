import { describe, expect, it } from "bun:test";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { mentionChipAtomizer } from "../../../src/ui/composer/mention-chips";

/** The active theme's glyph for a mention kind (`mention.<kind>`). */
const g = (kind: string) => currentTheme().symbols.symbol(`mention.${kind}`);

describe("mentionChipAtomizer", () => {
	it("atomizes local/foreign agents, git refs, and PR/issue URLs while preserving trailing punctuation", () => {
		const atomizer = mentionChipAtomizer({
			localAgentLabel: id => (id === "Scout" ? "Scout" : undefined),
			peerLabel: (pid, id) => (pid === 4812 ? (id ? `auth-refactor/${id}` : "auth-refactor") : undefined),
			sessionTitle: id => (id === "sess-1234abcd" ? "Refactor mention selector" : undefined),
		});
		const text =
			"Check agent://Scout, agent://4812/Worker, session://sess-1234abcd, git://branch/feat/auth, git://commit/a1b2c3d4e5f6, git://tag/v1.4.0, pr://3164, issue://99.";
		const tokens = atomizer(text, () => false);
		expect(tokens.map(t => ({ label: t.label, expansion: t.expansion }))).toEqual([
			{ label: `${g("agent")} Scout`, expansion: "agent://Scout" },
			{ label: `${g("peer")} auth-refactor/Worker`, expansion: "agent://4812/Worker" },
			{ label: `${g("session")} Refactor mention selector`, expansion: "session://sess-1234abcd" },
			{ label: `${g("branch")} feat/auth`, expansion: "git://branch/feat/auth" },
			{ label: `${g("commit")} a1b2c3d`, expansion: "git://commit/a1b2c3d4e5f6" },
			{ label: `${g("tag")} v1.4.0`, expansion: "git://tag/v1.4.0" },
			{ label: `${g("pr")} #3164`, expansion: "pr://3164" },
			{ label: `${g("issue")} #99`, expansion: "issue://99" },
		]);
		// Trailing commas/periods stay outside the chip spans.
		expect(text.slice(tokens[0]!.to, tokens[0]!.matchEnd)).toBe(",");
		expect(text.slice(tokens[7]!.to, tokens[7]!.matchEnd)).toBe(".");
	});

	it("disambiguates foreign peers that share a session title by falling back to #<pid>", () => {
		const atomizer = mentionChipAtomizer({
			peerLabel: () => "same-title/Worker",
		});
		const tokens = atomizer("Compare agent://1001/Worker and agent://2002/Worker ", () => false);
		expect(tokens.map(t => ({ label: t.label, expansion: t.expansion }))).toEqual([
			{ label: `${g("peer")} same-title/Worker`, expansion: "agent://1001/Worker" },
			{ label: `${g("peer")} same-title/Worker #2002`, expansion: "agent://2002/Worker" },
		]);
	});

	it("leads a card-form session title with its own icon instead of a second session glyph", () => {
		const atomizer = mentionChipAtomizer({ sessionTitle: () => "🧪 FLAKY: Fix flaky park tests" });
		expect(atomizer("see session://sess-1 ", () => false).map(t => t.label)).toEqual([
			"🧪 FLAKY: Fix flaky park tests",
		]);
	});

	it("atomizes git diffs, MCP resources, and SSH hosts", () => {
		const atomizer = mentionChipAtomizer();
		const tokens = atomizer(
			"Review git://diff git://diff/staged git://diff/main mcp://test://notes/today ssh://prod-db/ ssh://prod-db/var/log ",
			() => false,
		);
		expect(tokens.map(t => t.label)).toEqual([
			`${g("diff")} uncommitted`,
			`${g("diff")} staged`,
			`${g("diff")} vs main`,
			`${g("mcp")} today`,
			`${g("ssh")} prod-db`,
			`${g("ssh")} prod-db:var/log`,
		]);
	});

	it("skips local-execution drafts (!cmd, $ code)", () => {
		const atomizer = mentionChipAtomizer();
		expect(atomizer("!echo pr://3164 ", () => false)).toEqual([]);
		expect(atomizer("$ print('git://branch/main') ", () => false)).toEqual([]);
	});
});
