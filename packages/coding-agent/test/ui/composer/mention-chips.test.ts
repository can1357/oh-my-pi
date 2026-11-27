import { describe, expect, it } from "bun:test";
import { mentionChipAtomizer } from "../../../src/ui/composer/mention-chips";

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
			{ label: "● Scout", expansion: "agent://Scout" },
			{ label: "⇄ auth-refactor/Worker", expansion: "agent://4812/Worker" },
			{ label: "💬 Refactor mention selector", expansion: "session://sess-1234abcd" },
			{ label: "⎇ feat/auth", expansion: "git://branch/feat/auth" },
			{ label: "○ a1b2c3d", expansion: "git://commit/a1b2c3d4e5f6" },
			{ label: "⚑ v1.4.0", expansion: "git://tag/v1.4.0" },
			{ label: "⑂ #3164", expansion: "pr://3164" },
			{ label: "⊙ #99", expansion: "issue://99" },
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
			{ label: "⇄ same-title/Worker", expansion: "agent://1001/Worker" },
			{ label: "⇄ same-title/Worker #2002", expansion: "agent://2002/Worker" },
		]);
	});

	it("atomizes git diffs, MCP resources, and SSH hosts", () => {
		const atomizer = mentionChipAtomizer();
		const tokens = atomizer(
			"Review git://diff git://diff/staged git://diff/main mcp://test://notes/today ssh://prod-db/ ssh://prod-db/var/log ",
			() => false,
		);
		expect(tokens.map(t => t.label)).toEqual([
			"± uncommitted",
			"± staged",
			"± vs main",
			"⌁ today",
			"⇢ prod-db",
			"⇢ prod-db:var/log",
		]);
	});

	it("skips local-execution drafts (!cmd, $ code)", () => {
		const atomizer = mentionChipAtomizer();
		expect(atomizer("!echo pr://3164 ", () => false)).toEqual([]);
		expect(atomizer("$ print('git://branch/main') ", () => false)).toEqual([]);
	});
});
