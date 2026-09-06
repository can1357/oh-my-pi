import { beforeAll, describe, expect, it } from "bun:test";
import { TreeSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tree-selector";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { assistantMsg, userMsg } from "../../utilities";

/** A session with one answered branch and one abandoned prompt hanging off the root. */
function sessionWithAnEmptyBranch() {
	const session = SessionManager.inMemory();
	const idRoot = session.appendMessage(userMsg("root"));
	session.appendMessage(assistantMsg("answered"));
	session.branch(idRoot);
	session.appendMessage(userMsg("Or are they something else?"));
	session.branch(idRoot);
	return session;
}

function render(session: SessionManager, includeArchived: boolean, onToggle?: () => void): string {
	const tree = session.getTree({ includeArchived });
	const selector = new TreeSelectorComponent(
		tree,
		session.getLeafId(),
		60,
		() => {},
		() => {},
		undefined,
		"all",
		{ showing: includeArchived, onToggle },
	);
	return Bun.stripANSI(selector.render(120).join("\n"));
}

describe("tree selector with archived branches", () => {
	beforeAll(async () => {
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	});

	it("hides an archived branch and shows it again when asked", async () => {
		const session = sessionWithAnEmptyBranch();
		expect(render(session, false)).toContain("Or are they something else?");

		await session.archiveEmptyBranches();

		expect(render(session, false)).not.toContain("Or are they something else?");
		expect(render(session, true)).toContain("Or are they something else?");
	});

	it("announces which mode it is in", async () => {
		const session = sessionWithAnEmptyBranch();
		await session.archiveEmptyBranches();

		expect(render(session, false)).toContain("Alt+R: show archived");
		const revealed = render(session, true);
		expect(revealed).toContain("[showing archived]");
		expect(revealed).toContain("Alt+R: hide");
	});

	it("asks the caller for a fresh tree when Alt+R is pressed", async () => {
		const session = sessionWithAnEmptyBranch();
		await session.archiveEmptyBranches();

		let toggled = 0;
		const tree = session.getTree();
		const selector = new TreeSelectorComponent(
			tree,
			session.getLeafId(),
			60,
			() => {},
			() => {},
			undefined,
			"all",
			{ showing: false, onToggle: () => toggled++ },
		);
		// Alt+R — the archived rows are not in this component's list at all, so the
		// only correct response is to hand the decision back to the controller.
		selector.handleInput("\x1br");

		expect(toggled).toBe(1);
	});

	it("hands the highlighted branch to the caller on Shift+A", async () => {
		const session = sessionWithAnEmptyBranch();
		const leafId = session.getLeafId() as string;
		const archived: string[] = [];
		const selector = new TreeSelectorComponent(
			session.getTree(),
			leafId,
			60,
			() => {},
			() => {},
			undefined,
			"all",
			{ showing: false, onArchiveToggle: id => archived.push(id) },
		);
		selector.handleInput("A");

		expect(archived).toEqual([leafId]);
	});

	it("types a capital A into the search instead of archiving mid-search", async () => {
		const session = sessionWithAnEmptyBranch();
		const archived: string[] = [];
		const selector = new TreeSelectorComponent(
			session.getTree(),
			session.getLeafId(),
			60,
			() => {},
			() => {},
			undefined,
			"all",
			{ showing: false, onArchiveToggle: id => archived.push(id) },
		);
		selector.handleInput("r");
		selector.handleInput("A");

		expect(archived).toEqual([]);
		expect(Bun.stripANSI(selector.render(120).join("\n"))).toContain("rA");
	});

	it("offers restore as well as archive once archived rows are showing", async () => {
		const session = sessionWithAnEmptyBranch();
		await session.archiveEmptyBranches();

		expect(render(session, false)).toContain("Shift+A: archive");
		expect(render(session, true)).toContain("Shift+A: archive/restore");
	});

	it("never renders the archive bookkeeping record as a row", async () => {
		const session = sessionWithAnEmptyBranch();
		await session.archiveEmptyBranches();

		const revealed = render(session, true);
		for (const line of revealed.split("\n")) {
			expect(line).not.toMatch(/^[\s│├└─›]*•\s*$/);
		}
	});
});
