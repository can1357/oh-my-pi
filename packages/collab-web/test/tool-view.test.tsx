import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolView } from "../src/tool-render/ToolView";

it("renders just the intent label before and after execution metadata arrives", () => {
	const raw = "Checking http.py:42: Did Retry-After override the timer?";
	for (const props of [
		{ args: { i: raw }, running: true },
		{ intent: raw, result: { content: [] } },
	]) {
		const html = renderToStaticMarkup(<ToolView name="bash" defaultOpen {...props} />);
		expect(html).toContain('class="tv-intent">Checking http.py:42</div>');
		expect(html).not.toContain("Retry-After");
	}
});

describe("ToolView bash tool commands", () => {
	it("renders one nested view per execute record beside the bash card", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="bash"
				defaultOpen
				args={{ command: "generate_image 'alpine lake' && resolve 'ok'" }}
				result={{
					content: [],
					details: {
						toolCommands: [
							{
								tool: "generate_image",
								mode: "execute",
								exitCode: 0,
								args: { subject: "alpine lake" },
								inner: { images: [{ data: "aW1hZ2U=", mimeType: "image/png" }] },
							},
							{
								tool: "resolve",
								mode: "execute",
								exitCode: 0,
								args: { reason: "ok" },
								inner: {
									action: "apply",
									reason: "ok",
									sourceToolName: "ast_edit",
									label: "ast_edit: edit foo.ts",
								},
							},
						],
					},
				}}
			/>,
		);

		expect(html).toContain('class="tv-name">bash<');
		expect(html).toContain('class="tv-name">generate_image<');
		expect(html).toContain('class="tv-name">resolve<');
		// Each nested card is fed its own record: the summary reads `args`, the card model `inner`.
		expect(html).toContain("alpine lake");
		expect(html).toContain("tv-badge--ok");
	});

	it("renders a help record as a one-line command", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="bash"
				defaultOpen
				args={{ command: "ls" }}
				result={{
					content: [],
					details: { toolCommands: [{ tool: "generate_image", mode: "help", exitCode: 0 }] },
				}}
			/>,
		);

		expect(html).toContain("generate_image --help");
		expect(html).not.toContain('class="tv-name">generate_image<');
	});

	it("renders a write card plainly when its details carry stray toolCommands", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="write"
				defaultOpen
				args={{ path: "src/out.ts", content: "x" }}
				result={{
					content: [],
					details: {
						toolCommands: [
							{
								tool: "generate_image",
								mode: "execute",
								exitCode: 0,
								args: { subject: "should not render" },
								inner: { images: [{ data: "aW1hZ2U=", mimeType: "image/png" }] },
							},
						],
					},
				}}
			/>,
		);

		expect(html).toContain('class="tv-name">write<');
		expect(html).toContain("src/out.ts");
		expect(html).not.toContain("generate_image");
		expect(html).not.toContain("should not render");
		expect(html).not.toContain("data:image/png;base64");
	});

	it("defaults a running reject call to discard before details arrive", () => {
		const html = renderToStaticMarkup(<ToolView name="reject" defaultOpen running args={{ reason: "" }} />);

		expect(html).toContain("proposed → rejected");
	});

	it("keeps historical top-level resolve cards working from args.action", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="resolve"
				defaultOpen
				args={{ action: "apply", reason: "ok" }}
				result={{ content: [], details: { sourceToolName: "ast_edit", label: "edit foo.ts" } }}
			/>,
		);

		expect(html).toContain("proposed → resolved");
		expect(html).toContain("tv-badge--ok");
	});
});

/** The card each record's inner details feeds when its nested view is expanded. */
describe("ToolView tool command record cards", () => {
	it("renders a generate_image record's inner images", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="generate_image"
				defaultOpen
				args={{ subject: "alpine lake" }}
				result={{ content: [], details: { images: [{ data: "aW1hZ2U=", mimeType: "image/png" }] } }}
			/>,
		);

		expect(html).toContain("alpine lake");
		expect(html).toContain('src="data:image/png;base64,aW1hZ2U="');
	});

	it("renders a resolve record's inner apply details", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="resolve"
				defaultOpen
				args={{ reason: "looks correct" }}
				result={{
					content: [{ type: "text", text: "Applied 1 replacement in 1 file." }],
					details: {
						action: "apply",
						reason: "looks correct",
						sourceToolName: "ast_edit",
						label: "ast_edit: edit foo.ts",
					},
				}}
			/>,
		);

		expect(html).toContain("proposed → resolved");
		expect(html).toContain("tv-badge--ok");
		expect(html).toContain("ast_edit: edit foo.ts");
		// The historical args-only path once left the badge as a warn "?".
		expect(html).not.toContain('tv-badge--warn">?');
	});

	it("renders a reject record's inner discard details", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="reject"
				defaultOpen
				args={{ reason: "not right" }}
				result={{
					content: [{ type: "text", text: "Discarded pending action." }],
					details: { action: "discard", reason: "not right", sourceToolName: "edit" },
				}}
			/>,
		);

		expect(html).toContain("proposed → rejected");
		expect(html).toContain("tv-badge--warn");
		// Not the generic JSON dump.
		expect(html).not.toContain("tv-out-title");
	});

	it("renders a propose record's inner plan metadata", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="propose"
				defaultOpen
				args={{ title: "ship it" }}
				result={{
					content: [{ type: "text", text: "Plan ready for review." }],
					details: { planFilePath: "local://ship-it-plan.md", title: "ship it", planExists: true },
				}}
			/>,
		);

		expect(html).toContain("plan proposed");
		expect(html).toContain("local://ship-it-plan.md");
	});
});

describe("ToolView wait renderer", () => {
	it("renders every received wait message without falling back to JSON", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="wait"
				defaultOpen
				args={{}}
				result={{
					content: [{ type: "text", text: "[42] Worker: ready\n\n[43] Reviewer: looks good" }],
					details: {
						op: "wait",
						waited: [
							{ id: "42", from: "Worker", to: "Main", body: "ready", ts: 0 },
							{ id: "43", from: "Reviewer", to: "Main", body: "looks good", ts: 1 },
						],
					},
				}}
			/>,
		);
		expect(html).toContain("← Worker");
		expect(html).toContain("ready");
		expect(html).toContain("← Reviewer");
		expect(html).toContain("looks good");
		expect(html).not.toContain("tv-out-title");
	});

	it("renders settled wait job output", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="wait"
				defaultOpen
				args={{}}
				result={{
					content: [],
					details: {
						op: "wait",
						jobs: [
							{
								id: "a1b2",
								type: "bash",
								status: "completed",
								label: "build",
								durationMs: 25,
								resultText: "Built",
								errorText: "",
							},
						],
					},
				}}
			/>,
		);
		expect(html).toContain("Built");
		expect(html).toContain("1 done");
	});
});

describe("ToolView task renderer", () => {
	it("renders batch items by name with their task or numbered steps", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="task"
				defaultOpen
				args={{
					context: "# Goal\nship it",
					tasks: [
						{ name: "Fixer", agent: "task", task: "Patch the parser.", solutionSpace: "one fix" },
						{
							name: "Auditor",
							agent: "scout",
							steps: ["Map the callers.", "Report risky ones."],
							solutionSpace: "open",
						},
					],
				}}
			/>,
		);

		expect(html).toContain("Fixer");
		expect(html).toContain("Patch the parser.");
		expect(html).toContain("2 steps");
		expect(html).toContain("step 1/2");
		expect(html).toContain("Map the callers.");
		expect(html).toContain("step 2/2");
		expect(html).toContain("Report risky ones.");
		expect(html).toContain("2 tasks");
	});

	it("labels a flat stepped spawn by its first step when unnamed", () => {
		const html = renderToStaticMarkup(
			<ToolView name="task" args={{ agent: "task", steps: ["\n  Read the spec.\nThen more", "Write it."] }} />,
		);

		expect(html).toContain("Read the spec.");
		expect(html).not.toContain("Then more");
	});
});

describe("ToolView ask renderer", () => {
	const form = `<form>
<fieldset><legend>Storage backend</legend>
<label><input type="radio" name="db" value="sqlite" checked> SQLite</label>
<label><input type="radio" name="db" value="pg"> Postgres</label>
</fieldset>
<fieldset><legend>Notes &amp; caveats</legend><textarea name="notes"></textarea></fieldset>
</form>`;

	it("outlines a pending form by its legends and named field count", () => {
		const html = renderToStaticMarkup(<ToolView name="ask" defaultOpen args={{ html: form }} />);

		expect(html).toContain("Storage backend");
		expect(html).toContain("Notes &amp; caveats");
		expect(html).toContain("2 fields");
	});

	it("pairs each question with its answer and flags timed-out submissions", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="ask"
				defaultOpen
				args={{ html: form }}
				result={{
					content: [{ type: "text", text: 'User answers:\n{"db":"pg","notes":""}' }],
					details: {
						answers: [
							{ name: "db", question: "Storage backend", answer: "Postgres" },
							{ name: "notes", question: "Notes & caveats", answer: "" },
						],
						timedOut: true,
					},
				}}
			/>,
		);

		expect(html).toContain("<span>Postgres</span>");
		expect(html).toContain("(no answer)");
		expect(html).toContain("auto-selected after timeout");
	});

	it("renders selected option notes under the matching answer", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="ask"
				defaultOpen
				args={{ html: form }}
				result={{
					content: [],
					details: {
						answers: [
							{ name: "notes", question: "Notes & caveats", answer: "none" },
							{ name: "db", question: "Storage backend", answer: "SQLite, Postgres, managed" },
						],
						notes: [
							{ name: "db", question: "Storage backend", option: "Postgres, managed", text: "Team standard" },
							{ name: "db", question: "Storage backend", option: 12, text: "ignored malformed note" },
						],
					},
				}}
			/>,
		);

		expect(html).toContain("✎ Postgres, managed: Team standard");
		expect(html.indexOf("Team standard")).toBeGreaterThan(html.lastIndexOf("Storage backend"));
		expect(html).not.toContain("ignored malformed note");
	});

	it("falls back to the result text when details carry no answers", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="ask"
				defaultOpen
				args={{ html: "<form></form>" }}
				result={{ content: [{ type: "text", text: "The form needs at least one named control." }], isError: true }}
			/>,
		);

		expect(html).toContain("at least one named control");
	});
});

describe("ToolView web_search renderer", () => {
	it("shows each source's cleaned excerpt instead of the numbered listing when there is no answer", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="web_search"
				defaultOpen
				args={{ query: "bun expect" }}
				result={{
					content: [{ type: "text", text: "[1] Src One\n    https://example.com/a\n    LISTING_ONLY_MARKER" }],
					details: {
						response: {
							provider: "parallel",
							sources: [
								{ title: "Src One", url: "https://example.com/a", snippet: "\n  first\t excerpt\n```\nsecond" },
							],
						},
					},
				}}
			/>,
		);

		expect(html).not.toContain("LISTING_ONLY_MARKER");
		expect(html).toContain('<span class="tv-excerpt">first excerpt</span><span class="tv-excerpt">second</span>');
	});
});

describe("ToolView edit checkoutNotice", () => {
	it("renders checkoutNotice on single-file and multi-file edit cards", () => {
		const single = renderToStaticMarkup(
			<ToolView
				name="edit"
				defaultOpen
				args={{ path: "/repo/linked/lesson.txt" }}
				result={{
					content: [],
					details: {
						path: "/repo/linked/lesson.txt",
						checkoutNotice: "Edited worktree: preview (session: main)",
						diff: "-before\n+after",
					},
				}}
			/>,
		);
		expect(single).toContain("Edited worktree: preview (session: main)");

		const multi = renderToStaticMarkup(
			<ToolView
				name="edit"
				defaultOpen
				args={{ input: "" }}
				result={{
					content: [],
					details: {
						diff: "-a\n+b",
						perFileResults: [
							{ path: "/repo/main/local.txt", diff: "-a\n+b" },
							{
								path: "/repo/linked/lesson.txt",
								checkoutNotice: "Edited worktree: preview (session: main)",
								diff: "-before\n+after",
							},
						],
					},
				}}
			/>,
		);
		expect(multi).toContain("Edited worktree: preview (session: main)");
	});
});
