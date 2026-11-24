/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The session picker's preview and search placeholder as Tern is sent them: the preview shows what
 * the complete listing knows once it replaces the preliminary rows, and the placeholder names the folder.
 */
import { describe, expect, test } from "bun:test";
import type { UiNode } from "@oh-my-pi/pi-tui";
import { createTestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { corpusEnvironment, describeTree } from "@oh-my-pi/pi-tui/testing/corpus";
import type { SessionSelectorEntry } from "../../../../src/modes/view-model/overlays/session-selector";
import { SessionSelector, type SessionSelectorProps } from "../../../../src/ui/overlays/pickers/session-selector";

const NOW = Date.parse("2026-11-23T12:00:00Z");

interface Described {
	readonly k: string;
	readonly p?: Record<string, unknown>;
	readonly c?: readonly Described[];
}

const preliminary: SessionSelectorEntry = {
	path: "/w/a/s.jsonl",
	id: "id",
	cwd: "",
	title: "Parity session",
	modified: new Date(NOW - 60_000),
	size: 1000,
	firstMessage: "",
	allMessagesText: "",
};
const complete: SessionSelectorEntry = {
	...preliminary,
	cwd: "/w/a",
	firstMessage: "first prompt",
	allMessagesText: "first prompt\nlast answer",
};

function mount(props: Partial<SessionSelectorProps>): { picker(): Described; dispose(): void } {
	const env = corpusEnvironment("dark");
	const term = createTestTerminal(
		() => ({
			layer: (
				<SessionSelector
					sessions={[preliminary]}
					onSelect={() => {}}
					onCancel={() => {}}
					terminalRows={30}
					now={() => NOW}
					{...props}
				/>
			),
		}),
		{ columns: 80, rows: 30 },
	);
	term.render();
	const find = (at: UiNode): UiNode | undefined =>
		at.kind === "picker"
			? at
			: at
					.children()
					.map(find)
					.find(found => found !== undefined);
	const picker = find(term.surface.layer()[0]!)!;
	return { picker: () => describeTree(picker, env) as Described, dispose: () => term.dispose() };
}

describe("session picker for Tern", () => {
	test("the preview gains the folder and the conversation when the complete listing lands", async () => {
		const listing = Promise.withResolvers<readonly SessionSelectorEntry[]>();
		const { picker, dispose } = mount({ completeSessions: listing.promise });
		try {
			const facts = (): string[] =>
				((picker().c?.find(child => child.k === "kv")?.p?.items ?? []) as { k: { t: string }[] }[]).map(
					item => item.k[0]!.t,
				);
			expect(facts()).toEqual(["Modified", "Size"]);
			expect(picker().c?.some(child => child.k === "section")).toBe(false);
			listing.resolve([complete]);
			await listing.promise;
			await Promise.resolve();
			expect(facts()).toEqual(["Folder", "Modified", "Size"]);
			const conversation = picker().c?.find(child => child.k === "section");
			expect(conversation?.p?.head).toBe("Conversation");
			expect(conversation?.c?.map(child => child.p?.text)).toEqual(["first prompt", "last answer"]);
		} finally {
			dispose();
		}
	});

	test("the placeholder names the project folder, but not under a heading of its own", () => {
		const named = mount({ projectName: "work" });
		const titled = mount({ projectName: "work", title: "Import Codex Session" });
		const bare = mount({});
		try {
			expect(named.picker().p?.placeholder).toBe("Search sessions in work…");
			expect(titled.picker().p?.placeholder).toBe("Search sessions…");
			expect(bare.picker().p?.placeholder).toBe("Search sessions…");
		} finally {
			named.dispose();
			titled.dispose();
			bare.dispose();
		}
	});
});

describe("session picker in the terminal", () => {
	function open(onDelete: (session: SessionSelectorEntry) => Promise<boolean>) {
		const term = createTestTerminal(
			() => ({
				layer: (
					<SessionSelector
						sessions={[complete]}
						onSelect={() => {}}
						onCancel={() => {}}
						onDelete={onDelete}
						terminalRows={20}
						fillHeight
						now={() => NOW}
					/>
				),
			}),
			{ columns: 60, rows: 20 },
		);
		term.render();
		const find = (at: UiNode): UiNode | undefined =>
			at.kind === "picker"
				? at
				: at
						.children()
						.map(find)
						.find(found => found !== undefined);
		term.focus(find(term.surface.layer()[0]!) ?? null);
		const screen = (): string[] => {
			term.render();
			return term.screen();
		};
		return { term, screen };
	}

	test("the delete question takes Yes or No: No keeps the session, Yes deletes it", async () => {
		const deleted: string[] = [];
		const { term, screen } = open(async session => {
			deleted.push(session.path);
			return true;
		});
		try {
			term.press("backspace");
			expect(screen().some(row => row.includes("Delete session?"))).toBe(true);
			expect(screen().some(row => row.includes("❯ Yes"))).toBe(true);
			term.press("down");
			expect(screen().some(row => row.includes("❯ No"))).toBe(true);
			term.press("enter");
			expect(deleted).toEqual([]);
			expect(screen().some(row => row.includes("❯ Parity session"))).toBe(true);

			term.press("backspace");
			term.press("enter");
			await Promise.resolve();
			expect(deleted).toEqual([complete.path]);
		} finally {
			term.dispose();
		}
	});

	test("the fullscreen frame reaches the terminal's last row with its key hints pinned there", () => {
		const { term, screen } = open(async () => true);
		try {
			const rows = screen();
			expect(rows).toHaveLength(20);
			expect(rows[0]).toStartWith("╭─ Resume Session (current folder)");
			expect(rows[17]).toContain("select · ");
			expect(rows[19]).toStartWith("╰");
			expect(rows.some(row => row.includes("just now"))).toBe(false);
			expect(rows.some(row => row.includes("1 minute ago"))).toBe(true);
		} finally {
			term.dispose();
		}
	});
});
