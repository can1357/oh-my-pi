import { beforeAll, describe, expect, it } from "bun:test";
import type { Component } from "@oh-my-pi/pi-tui";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { COMPOSER_DEFAULTS, Composer, type StickyPromptPresentation } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { VirtualTerminal } from "./virtual-terminal";

class Rows implements Component {
	constructor(readonly rows: readonly string[]) {}

	isTranscriptBlockFinalized(): boolean {
		return true;
	}

	render(_width?: number): readonly string[] {
		return this.rows;
	}
}

class CountingActiveRows extends Rows {
	#currentRows: readonly string[];
	renderCalls = 0;

	constructor(rows: readonly string[]) {
		super(rows);
		this.#currentRows = rows;
	}

	override isTranscriptBlockFinalized(): boolean {
		return false;
	}

	override render(_width?: number): readonly string[] {
		this.renderCalls++;
		return this.#currentRows;
	}

	replaceRows(rows: readonly string[]): void {
		this.#currentRows = rows;
	}
}

class ClickableRows extends Rows {
	getClickFocusAgentIds(): string[] {
		return ["AgentClick"];
	}
}

function addTurn(transcript: TranscriptContainer, name: string) {
	const prompt = new UserMessageComponent(`${name} PROMPT`);
	const response = new Rows(Array.from({ length: 24 }, (_value, index) => `${name} response ${index}`));
	transcript.addChild(prompt);
	transcript.addChild(response);
	return { prompt, response };
}

function createComposer(stickyPrompt: StickyPromptPresentation, rows = 12, columns = 80) {
	const terminal = new VirtualTerminal(columns, rows);
	const composer = new Composer({
		terminal,
		preferences: { ...COMPOSER_DEFAULTS, quiet: true, stickyPrompt },
	});
	composer.start();
	return { composer };
}

function text(rows: readonly string[]): string {
	return Bun.stripANSI(rows.join("\n"));
}

describe("composer sticky transcript viewport", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it("reconciles the painted sticky prompt with the final response owner", () => {
		const { composer } = createComposer("viewport", 18, 36);
		const transcript = new TranscriptContainer();
		const firstPrompt = new UserMessageComponent("FIRST PROMPT " + "first prompt details ".repeat(12));
		const firstResponse = new Rows(Array.from({ length: 6 }, (_value, index) => `FIRST response ${index}`));
		const secondPrompt = new UserMessageComponent("SECOND PROMPT");
		const secondResponse = new Rows(Array.from({ length: 24 }, (_value, index) => `SECOND response ${index}`));
		transcript.addChild(firstPrompt);
		transcript.addChild(firstResponse);
		transcript.addChild(secondPrompt);
		transcript.addChild(secondResponse);
		composer.setRuntimeChildren([transcript]);
		try {
			const full = transcript.renderScrollableViewport(
				36,
				1000,
				{ now: 0, tick: 0 },
				{
					offsetFromTail: 0,
					measuredRows: 0,
					width: 0,
				},
			);
			const firstResponseSpan = full.spans.find(span => span.component === firstResponse)!;
			const initialOffset = full.cursor.measuredRows - firstResponseSpan.start - 5 - 18;
			const initialProjection = transcript.renderScrollableViewport(
				36,
				18,
				{ now: 0, tick: 0 },
				{
					offsetFromTail: initialOffset,
					measuredRows: full.cursor.measuredRows,
					width: 36,
				},
			);
			expect(initialProjection.prompt).toBe(firstPrompt);
			expect(initialProjection.promptVisible).toBe(false);
			composer.renderFrame({ columns: 36, rows: 18 });
			composer.toStart();
			composer.renderFrame({ columns: 36, rows: 18 });
			composer.scrollTranscriptRows(firstResponseSpan.start + 5);
			const rendered = composer.renderFrame({ columns: 36, rows: 18 }).viewport.map(row => Bun.stripANSI(row));
			expect(rendered).toHaveLength(18);
			const firstVisibleResponse = rendered.find(row => /(?:FIRST|SECOND) response/.test(row));
			if (firstVisibleResponse === undefined) throw new Error("Expected a visible response row");
			const promptRowIndex = rendered.findIndex(row => row.includes("SECOND PROMPT"));
			const responseRowIndex = rendered.indexOf(firstVisibleResponse);
			expect(firstVisibleResponse.startsWith("SECOND response")).toBe(true);
			expect(promptRowIndex).toBeGreaterThanOrEqual(0);
			expect(promptRowIndex).toBeLessThan(responseRowIndex);
			expect(rendered.filter(row => row.includes("SECOND PROMPT"))).toHaveLength(1);

			expect(rendered.some(row => row.includes("FIRST PROMPT"))).toBe(false);
		} finally {
			composer.stop();
		}
	});

	it("reuses active transcript rows across sticky-header projection passes in one frame", () => {
		const { composer } = createComposer("viewport", 12);
		const transcript = new TranscriptContainer();
		const prompt = new UserMessageComponent("ACTIVE PROMPT");
		const response = new CountingActiveRows(
			Array.from({ length: 24 }, (_value, index) => `active response ${index}`),
		);
		transcript.addChild(prompt);
		transcript.addChild(response);
		composer.setRuntimeChildren([transcript]);
		try {
			const full = transcript.renderScrollableViewport(
				80,
				1000,
				{ now: 0, tick: 0 },
				{
					offsetFromTail: 0,
					measuredRows: 0,
					width: 0,
				},
			);
			const responseSpan = full.spans.find(span => span.component === response)!;
			composer.renderFrame({ columns: 80, rows: 12 });
			composer.toStart();
			composer.renderFrame({ columns: 80, rows: 12 });
			composer.scrollTranscriptRows(responseSpan.start + 5);
			response.renderCalls = 0;
			composer.renderFrame({ columns: 80, rows: 12 });
			expect(response.renderCalls).toBe(1);
			composer.toEnd();
			response.replaceRows(["updated active response"]);
			response.renderCalls = 0;
			const nextFrame = composer.renderFrame({ columns: 80, rows: 12 });
			expect(text(nextFrame.viewport)).toContain("updated active response");
			expect(response.renderCalls).toBe(1);
		} finally {
			composer.stop();
		}
	});

	it("keeps a transcript row when sticky prompt reservation would exhaust the viewport", () => {
		const { composer } = createComposer("viewport", 1);
		const transcript = new TranscriptContainer();
		transcript.addChild(new UserMessageComponent("ONE ROW PROMPT"));
		transcript.addChild(new Rows(["one row response"]));
		composer.setRuntimeChildren([transcript]);
		try {
			const oneRowFrame = composer.renderFrame({ columns: 80, rows: 1 });
			expect(text(oneRowFrame.viewport)).toContain("one row response");
			expect(text(oneRowFrame.viewport)).not.toContain("ONE ROW PROMPT");
			expect(composer.renderFrame({ columns: 80, rows: 0 }).viewport).toEqual([]);
		} finally {
			composer.stop();
		}
	});

	it("keeps prompt text in a one-row sticky header", () => {
		const { composer } = createComposer("viewport", 2);
		const transcript = new TranscriptContainer();
		transcript.addChild(new UserMessageComponent("TWO ROW PROMPT"));
		transcript.addChild(new Rows(["two row response"]));
		composer.setRuntimeChildren([transcript]);
		try {
			const frame = composer.renderFrame({ columns: 80, rows: 2 });
			const rendered = frame.viewport.map(row => Bun.stripANSI(row));
			expect(rendered).toHaveLength(2);
			expect(rendered[0]).toContain("TWO ROW PROMPT");
			expect(rendered[1]).toContain("two row response");
		} finally {
			composer.stop();
		}
	});

	it("defaults sticky prompt presentation off and exposes transcript navigation", () => {
		const composer = new Composer({ terminal: new VirtualTerminal(80, 12) });
		try {
			expect(composer.stickyPrompt).toBe("off");
			expect(composer.scrollTranscriptRows(-1)).toBe(false);
			expect(composer.page(-1)).toBe(false);
			expect(composer.toStart()).toBe(false);
			expect(composer.toEnd()).toBe(false);
			expect(composer.scrollTranscriptRows).toBeFunction();
			expect(composer.page).toBeFunction();
			expect(composer.toStart).toBeFunction();
			expect(composer.toEnd).toBeFunction();
		} finally {
			composer.stop();
		}
	});

	it("keeps fixed chrome and pins the prompt that owns a scrolled response window", () => {
		const { composer } = createComposer("viewport", 12);
		const transcript = new TranscriptContainer();
		const first = addTurn(transcript, "FIRST");
		const second = addTurn(transcript, "SECOND");
		composer.setRuntimeChildren([new Rows(["TOP CHROME"]), transcript, new Rows(["BOTTOM CHROME"])]);
		try {
			const all = transcript.renderScrollableViewport(
				80,
				1000,
				{ now: 0, tick: 0 },
				{
					offsetFromTail: 0,
					measuredRows: 0,
					width: 0,
				},
			);
			const firstResponse = all.spans.find(span => span.component === first.response)!;
			const secondResponse = all.spans.find(span => span.component === second.response)!;
			composer.renderFrame({ columns: 80, rows: 12 });
			composer.toStart();
			composer.renderFrame({ columns: 80, rows: 12 });

			composer.scrollTranscriptRows(firstResponse.start + 5);
			const firstFrame = composer.renderFrame({ columns: 80, rows: 12 });
			const firstText = text(firstFrame.viewport);
			expect(firstFrame.history).toBeUndefined();
			expect(firstText).toContain("TOP CHROME");
			expect(firstText).toContain("BOTTOM CHROME");
			expect(firstText).toContain("FIRST PROMPT");
			expect(firstText).toContain("FIRST response");
			expect(firstText).not.toContain("SECOND PROMPT");
			expect(firstFrame.viewport.join("\n")).not.toContain("\x1b]133;");

			composer.scrollTranscriptRows(secondResponse.start - firstResponse.start);
			const secondFrame = composer.renderFrame({ columns: 80, rows: 12 });
			const secondText = text(secondFrame.viewport);
			expect(secondFrame.history).toBeUndefined();
			expect(secondText).toContain("SECOND PROMPT");
			expect(secondText).toContain("SECOND response");
			expect(secondText).not.toContain("FIRST PROMPT");
		} finally {
			composer.stop();
		}
	});

	it("limits a pinned multiline prompt to one third of available viewport rows", () => {
		const { composer } = createComposer("viewport", 12);
		const transcript = new TranscriptContainer();
		const prompt = new UserMessageComponent(
			Array.from({ length: 10 }, (_value, index) => `CAP PROMPT LINE ${index}`).join("\n"),
		);
		const response = new Rows(Array.from({ length: 24 }, (_value, index) => `cap response ${index}`));
		transcript.addChild(prompt);
		transcript.addChild(response);
		composer.setRuntimeChildren([new Rows(["FIXED CHROME"]), transcript]);
		try {
			const all = transcript.renderScrollableViewport(
				80,
				1000,
				{ now: 0, tick: 0 },
				{
					offsetFromTail: 0,
					measuredRows: 0,
					width: 0,
				},
			);
			const responseSpan = all.spans.find(span => span.component === response)!;
			composer.renderFrame({ columns: 80, rows: 12 });
			composer.toStart();
			composer.renderFrame({ columns: 80, rows: 12 });
			composer.scrollTranscriptRows(responseSpan.start + 5);
			const frame = composer.renderFrame({ columns: 80, rows: 12 });
			const rendered = text(frame.viewport);
			expect(rendered).toContain("CAP PROMPT LINE 0");
			expect(rendered).not.toContain("CAP PROMPT LINE 2");
		} finally {
			composer.stop();
		}
	});

	it("does not duplicate a prompt that is already visible in the transcript window", () => {
		const { composer } = createComposer("viewport", 10);
		const transcript = new TranscriptContainer();
		const second = addTurn(transcript, "SECOND");
		composer.setRuntimeChildren([transcript]);
		try {
			const all = transcript.renderScrollableViewport(
				80,
				1000,
				{ now: 0, tick: 0 },
				{
					offsetFromTail: 0,
					measuredRows: 0,
					width: 0,
				},
			);
			const promptSpan = all.spans.find(span => span.component === second.prompt)!;
			composer.renderFrame({ columns: 80, rows: 10 });
			composer.toStart();
			composer.renderFrame({ columns: 80, rows: 10 });
			composer.scrollTranscriptRows(promptSpan.start);
			const frame = composer.renderFrame({ columns: 80, rows: 10 });
			expect((text(frame.viewport).match(/SECOND PROMPT/g) ?? []).length).toBe(1);
		} finally {
			composer.stop();
		}
	});

	it("preserves native history pressure in terminal presentation mode", () => {
		const renderPressure = (stickyPrompt: "off" | "terminal") => {
			const { composer } = createComposer(stickyPrompt, 6);
			const transcript = new TranscriptContainer();
			transcript.addChild(new Rows(Array.from({ length: 20 }, (_value, index) => `terminal row ${index}`)));
			composer.setRuntimeChildren([transcript]);
			try {
				return composer.renderFrame({ columns: 80, rows: 6 });
			} finally {
				composer.stop();
			}
		};
		const baseline = renderPressure("off");
		const terminal = renderPressure("terminal");
		expect(baseline.history?.rows).toContain("terminal row 0");
		expect(terminal).toEqual(baseline);
	});

	it("follows appended finalized rows only while the viewport cursor is at the tail", () => {
		const { composer } = createComposer("viewport", 3);
		const transcript = new TranscriptContainer();
		transcript.addChild(new Rows(["tail row 0", "tail row 1", "tail row 2"]));
		composer.setRuntimeChildren([transcript]);
		try {
			composer.renderFrame({ columns: 80, rows: 3 });
			transcript.addChild(new Rows(["tail row 3"]));
			const frame = composer.renderFrame({ columns: 80, rows: 3 });
			expect(frame.history).toBeUndefined();
			expect(text(frame.viewport)).toContain("tail row 3");
			expect(text(frame.viewport)).not.toContain("tail row 0");
		} finally {
			composer.stop();
		}
	});

	it("keeps the visible historical rows anchored while finalized output is appended", () => {
		const { composer } = createComposer("viewport", 5);
		const transcript = new TranscriptContainer();
		transcript.addChild(new Rows(Array.from({ length: 30 }, (_value, index) => `history row ${index}`)));
		composer.setRuntimeChildren([transcript]);
		try {
			const viewport = { columns: 80, rows: 5 };
			composer.renderFrame(viewport);
			composer.toStart();
			composer.renderFrame(viewport);
			composer.scrollTranscriptRows(10);
			const before = text(composer.renderFrame(viewport).viewport);
			expect(before).toContain("history row 10");

			transcript.addChild(new Rows(["appended history A", "appended history B"]));
			const afterFrame = composer.renderFrame(viewport);
			expect(afterFrame.history).toBeUndefined();
			expect(text(afterFrame.viewport)).toBe(before);
		} finally {
			composer.stop();
		}
	});

	it("releases archived rows for a one-time native history flush", () => {
		const { composer } = createComposer("viewport", 4);
		const transcript = new TranscriptContainer();
		transcript.addChild(new Rows(["flush row 0", "flush row 1", "flush row 2", "flush row 3"]));
		composer.setRuntimeChildren([transcript]);
		try {
			const viewportFrame = composer.renderFrame({ columns: 80, rows: 4 });
			expect(viewportFrame.history).toBeUndefined();
			composer.beginHistoryFlush();
			const flushFrame = composer.renderFrame({ columns: 80, rows: 4 });
			expect(flushFrame.history?.rows.filter(row => row.startsWith("flush row "))).toEqual([
				"flush row 0",
				"flush row 1",
				"flush row 2",
				"flush row 3",
			]);
			composer.acknowledgeHistory(flushFrame.history!.id);
			expect(composer.renderFrame({ columns: 80, rows: 4 }).history).toBeUndefined();
		} finally {
			composer.stop();
		}
	});

	it("retires the startup header under viewport pressure and flushes the full transcript", () => {
		const terminal = new VirtualTerminal(80, 3);
		const acceptedHistoryBatches: string[][] = [];
		const composer = new Composer({
			terminal,
			preferences: { ...COMPOSER_DEFAULTS, quiet: false, stickyPrompt: "viewport" },
			tuiOptions: {
				onPaint: paint => {
					if (paint.history.length > 0) acceptedHistoryBatches.push([...paint.history]);
				},
			},
		});
		composer.setHeaderExtras([new Rows(["VIEWPORT STARTUP HEADER"])], []);
		composer.start({ playWelcomeIntro: false });

		const transcript = new TranscriptContainer();
		transcript.addChild(
			new Rows(["viewport transcript row 0", "viewport transcript row 1", "viewport transcript row 2"]),
		);
		composer.setRuntimeChildren([transcript]);
		composer.ui.renderNow();

		const history = acceptedHistoryBatches.flat();
		expect(history).toContain("VIEWPORT STARTUP HEADER");
		expect(history).not.toContain("viewport transcript row 0");
		expect(transcript.blockStates()).toEqual(["archived"]);
		const viewport = text(terminal.getViewport());
		for (let row = 0; row < 3; row++) expect(viewport).toContain(`viewport transcript row ${row}`);

		const resizedViewport = text(composer.renderResizeFrame({ columns: 80, rows: 80 }));
		expect(resizedViewport).toContain("VIEWPORT STARTUP HEADER");
		composer.stop();
		const shellTranscript = Bun.stripANSI(terminal.getScrollBuffer().join("\n"));
		const expectedRows = [
			"VIEWPORT STARTUP HEADER",
			"viewport transcript row 0",
			"viewport transcript row 1",
			"viewport transcript row 2",
		];
		let previousRow = -1;
		for (const row of expectedRows) {
			const rowIndex = shellTranscript.indexOf(row);
			expect(shellTranscript.split(row).length - 1).toBe(1);
			expect(rowIndex).toBeGreaterThan(previousRow);
			previousRow = rowIndex;
		}
	});

	it("counts settled viewport rows when later output pressures the startup header", () => {
		const acceptedHistoryBatches: string[][] = [];
		const composer = new Composer({
			terminal: new VirtualTerminal(80, 4),
			preferences: { ...COMPOSER_DEFAULTS, quiet: true, stickyPrompt: "viewport" },
			tuiOptions: {
				onPaint: paint => {
					if (paint.history.length > 0) acceptedHistoryBatches.push([...paint.history]);
				},
			},
		});
		composer.setHeaderExtras([new Rows(["CUMULATIVE HEADER"])], []);
		composer.start({ playWelcomeIntro: false });
		const transcript = new TranscriptContainer();
		transcript.addChild(new Rows(["cumulative row 0"]));
		composer.setRuntimeChildren([transcript]);
		try {
			composer.ui.renderNow();
			expect(acceptedHistoryBatches).toHaveLength(0);
			expect(transcript.blockStates()).toEqual(["settled"]);

			transcript.addChild(new Rows(["cumulative row 1"]));
			transcript.addChild(new Rows(["cumulative row 2"]));
			composer.ui.renderNow();
			expect(acceptedHistoryBatches.flat()).toContain("CUMULATIVE HEADER");
			expect(transcript.blockStates()).toEqual(["archived", "archived", "archived"]);
		} finally {
			composer.stop();
		}
	});

	it("replays a retired header when reset switches terminal history into viewport mode", () => {
		const terminal = new VirtualTerminal(80, 4);
		const acceptedHistoryBatches: string[][] = [];
		const composer = new Composer({
			terminal,
			preferences: { ...COMPOSER_DEFAULTS, quiet: true, stickyPrompt: "terminal" },
			tuiOptions: {
				onPaint: paint => {
					if (paint.history.length > 0) acceptedHistoryBatches.push([...paint.history]);
				},
			},
		});
		composer.setHeaderExtras([new Rows(["RESET TRANSITION HEADER"])], []);
		composer.start({ playWelcomeIntro: false });
		const transcript = new TranscriptContainer();
		for (let row = 0; row < 12; row++) transcript.addChild(new Rows([`reset transition row ${row}`]));
		composer.setRuntimeChildren([transcript]);
		for (let frame = 0; frame < 16; frame++) composer.ui.renderNow();

		expect(acceptedHistoryBatches.flat()).toContain("RESET TRANSITION HEADER");
		expect(transcript.blockStates()).toContain("committed");

		const priorBatchCount = acceptedHistoryBatches.length;
		composer.setPreferences({ stickyPrompt: "viewport" });
		composer.ui.resetDisplay();
		const replay = acceptedHistoryBatches.slice(priorBatchCount).flat();

		expect(replay).toContain("RESET TRANSITION HEADER");
		expect(replay).toContain("reset transition row 0");
		expect(transcript.blockStates().some(state => state === "archived" || state === "committed")).toBe(true);
		composer.stop();
	});

	it("flushes each archived semantic turn exactly once into native shell history on shutdown", () => {
		const terminal = new VirtualTerminal(80, 4);
		const acceptedHistoryBatches: string[][] = [];
		const composer = new Composer({
			terminal,
			preferences: { ...COMPOSER_DEFAULTS, quiet: true, stickyPrompt: "viewport" },
			tuiOptions: {
				onPaint: paint => {
					if (paint.history.length > 0) acceptedHistoryBatches.push([...paint.history]);
				},
			},
		});
		composer.setHeaderExtras([new Rows(["SHUTDOWN HEADER"])], []);
		composer.start({ playWelcomeIntro: false });

		const transcript = new TranscriptContainer();
		for (let turn = 0; turn < 3; turn++) {
			transcript.addChild(new UserMessageComponent(`SHUTDOWN PROMPT ${turn}`, { semanticResponseGrouping: true }));
			transcript.addChild(
				new Rows(Array.from({ length: 4 }, (_value, row) => `SHUTDOWN RESPONSE ${turn} ROW ${row}`)),
			);
		}
		composer.setRuntimeChildren([transcript]);
		composer.ui.renderNow();
		expect(transcript.blockStates()).toEqual(Array.from({ length: 6 }, () => "archived"));
		expect(acceptedHistoryBatches.flat().filter(Boolean)).toEqual(["SHUTDOWN HEADER"]);

		composer.stop();
		expect(transcript.blockStates()).toEqual(Array.from({ length: 6 }, () => "committed"));
		expect(acceptedHistoryBatches).toHaveLength(2);

		const accepted = acceptedHistoryBatches.flat().join("\n");
		for (const marker of ["A", "B", "C", "D;0"]) {
			expect(accepted.split(`\x1b]133;${marker}\x07`).length - 1).toBe(3);
		}
		const shellTranscript = Bun.stripANSI(terminal.getScrollBuffer().join("\n"));
		const expectedRows = ["SHUTDOWN HEADER"];
		for (let turn = 0; turn < 3; turn++) {
			expectedRows.push(`SHUTDOWN PROMPT ${turn}`);
			for (let row = 0; row < 4; row++) expectedRows.push(`SHUTDOWN RESPONSE ${turn} ROW ${row}`);
		}
		let previousRow = -1;
		for (const row of expectedRows) {
			const rowIndex = shellTranscript.indexOf(row);
			expect(shellTranscript.split(row).length - 1).toBe(1);
			expect(rowIndex).toBeGreaterThan(previousRow);
			previousRow = rowIndex;
		}
	});

	it("moves wheel navigation by the requested three transcript rows", () => {
		const { composer } = createComposer("viewport", 6);
		const transcript = new TranscriptContainer();
		transcript.addChild(new Rows(Array.from({ length: 40 }, (_value, index) => `wheel row ${index}`)));
		composer.setRuntimeChildren([transcript]);
		try {
			const before = composer.renderFrame({ columns: 80, rows: 6 });
			const beforeLast = [...text(before.viewport).matchAll(/wheel row (\d+)/g)]
				.map(match => Number(match[1]))
				.at(-1);
			expect(beforeLast).toBeDefined();
			expect(composer.scrollTranscriptRows(-3)).toBe(true);
			const after = composer.renderFrame({ columns: 80, rows: 6 });
			const afterLast = [...text(after.viewport).matchAll(/wheel row (\d+)/g)].map(match => Number(match[1])).at(-1);
			expect(afterLast).toBe(beforeLast! - 3);
		} finally {
			composer.stop();
		}
	});

	it("accumulates older requests through cold history discovery to the exact start", () => {
		const { composer } = createComposer("viewport", 8);
		const transcript = new TranscriptContainer();
		for (let index = 0; index < 512; index++) transcript.addChild(new Rows([`cold row ${index}`]));
		composer.setRuntimeChildren([transcript]);
		try {
			let frame = composer.renderFrame({ columns: 80, rows: 8 });
			const beforeRows = [...text(frame.viewport).matchAll(/cold row (\d+)/g)].map(match => Number(match[1]));
			expect(beforeRows.at(-1)).toBe(511);
			expect(composer.scrollTranscriptRows(-3)).toBe(true);
			expect(composer.scrollTranscriptRows(-3)).toBe(true);
			expect(composer.page(-1)).toBe(true);

			frame = composer.renderFrame({ columns: 80, rows: 8 });
			const afterRows = [...text(frame.viewport).matchAll(/cold row (\d+)/g)].map(match => Number(match[1]));
			expect(afterRows.at(-1)).toBeLessThan(beforeRows.at(-1)! - 3);
			expect(composer.toStart()).toBe(true);
			expect(composer.toStart()).toBe(true);
			frame = composer.renderFrame({ columns: 80, rows: 8 });
			expect(text(frame.viewport)).toContain("cold row 0");
			expect(composer.scrollTranscriptRows(-3)).toBe(false);
			expect(composer.page(-1)).toBe(false);
			expect(composer.toStart()).toBe(false);
		} finally {
			composer.stop();
		}
	});

	it("pages, reaches both transcript ends, and resets its cursor across viewport mode changes", () => {
		const { composer } = createComposer("off", 6);
		const transcript = new TranscriptContainer();
		transcript.addChild(new Rows(Array.from({ length: 20 }, (_value, index) => `navigation row ${index}`)));
		composer.setRuntimeChildren([transcript]);
		try {
			composer.setPreferences({ stickyPrompt: "viewport" });
			let frame = composer.renderFrame({ columns: 80, rows: 6 });
			expect(frame.history).toBeUndefined();
			expect(text(frame.viewport)).toContain("navigation row 19");
			expect(composer.page(1)).toBe(false);
			expect(composer.scrollTranscriptRows(1)).toBe(false);
			expect(composer.toEnd()).toBe(false);

			expect(composer.page(-1)).toBe(true);
			frame = composer.renderFrame({ columns: 80, rows: 6 });
			expect(text(frame.viewport)).toContain("navigation row 8");
			expect(composer.page(1)).toBe(true);
			frame = composer.renderFrame({ columns: 80, rows: 6 });
			expect(text(frame.viewport)).toContain("navigation row 19");

			expect(composer.toStart()).toBe(true);
			frame = composer.renderFrame({ columns: 80, rows: 6 });
			expect(text(frame.viewport)).toContain("navigation row 0");
			expect(composer.toStart()).toBe(false);
			expect(composer.scrollTranscriptRows(-1)).toBe(false);
			expect(composer.toEnd()).toBe(true);
			frame = composer.renderFrame({ columns: 80, rows: 6 });
			expect(text(frame.viewport)).toContain("navigation row 19");
			expect(composer.toEnd()).toBe(false);

			expect(composer.toStart()).toBe(true);
			frame = composer.renderFrame({ columns: 80, rows: 6 });
			expect(text(frame.viewport)).toContain("navigation row 0");

			composer.setPreferences({ stickyPrompt: "terminal" });
			frame = composer.renderFrame({ columns: 80, rows: 6 });
			expect(frame.history?.rows).toContain("navigation row 0");
			if (frame.history !== undefined) composer.acknowledgeHistory(frame.history.id);
			expect(composer.scrollTranscriptRows(-1)).toBe(false);
			expect(composer.page(-1)).toBe(false);
			expect(composer.toStart()).toBe(false);
			expect(composer.toEnd()).toBe(false);
			composer.setPreferences({ stickyPrompt: "viewport" });
			frame = composer.renderFrame({ columns: 80, rows: 6 });
			expect(frame.history).toBeUndefined();
			expect(text(frame.viewport)).toContain("navigation row 19");
			expect(text(frame.viewport)).not.toContain("navigation row 0");
		} finally {
			composer.stop();
		}
	});

	it("uses the scrollable projection for resize frames and remeasures changed widths", () => {
		const { composer } = createComposer("viewport", 9);
		const transcript = new TranscriptContainer();
		const prompt = new UserMessageComponent("RESIZE PROMPT with enough words to wrap at a narrow terminal width");
		const response = new Rows(Array.from({ length: 30 }, (_value, index) => `resize response ${index}`));
		transcript.addChild(prompt);
		transcript.addChild(response);
		composer.setRuntimeChildren([transcript]);
		try {
			const all = transcript.renderScrollableViewport(
				80,
				1000,
				{ now: 0, tick: 0 },
				{
					offsetFromTail: 0,
					measuredRows: 0,
					width: 0,
				},
			);
			const responseSpan = all.spans.find(span => span.component === response)!;
			composer.renderFrame({ columns: 80, rows: 9 });
			composer.toStart();
			composer.renderFrame({ columns: 80, rows: 9 });
			composer.scrollTranscriptRows(responseSpan.start + 5);
			composer.renderFrame({ columns: 80, rows: 9 });
			const resized = composer.renderResizeFrame({ columns: 24, rows: 9 });
			expect(text(resized)).toContain("RESIZE PROMPT");
			expect(text(resized)).toContain("resize response");
			expect(text(resized)).not.toContain("resize response 29");
			expect(resized.join("\n")).not.toContain("\x1b]133;");
		} finally {
			composer.stop();
		}
	});

	it("shifts click hit-testing below the marker-free sticky prompt rows", () => {
		const { composer } = createComposer("viewport", 10);
		const transcript = new TranscriptContainer();
		const prompt = new UserMessageComponent("CLICK PROMPT");
		const response = new ClickableRows(Array.from({ length: 24 }, (_value, index) => `click response ${index}`));
		transcript.addChild(prompt);
		transcript.addChild(response);
		composer.setRuntimeChildren([transcript]);
		try {
			const all = transcript.renderScrollableViewport(
				80,
				1000,
				{ now: 0, tick: 0 },
				{
					offsetFromTail: 0,
					measuredRows: 0,
					width: 0,
				},
			);
			const responseSpan = all.spans.find(span => span.component === response)!;
			composer.renderFrame({ columns: 80, rows: 10 });
			composer.toStart();
			composer.renderFrame({ columns: 80, rows: 10 });
			composer.scrollTranscriptRows(responseSpan.start + 5);
			const frame = composer.renderFrame({ columns: 80, rows: 10 });
			const responseRow = frame.viewport.findIndex(row => row.includes("click response"));
			expect(responseRow).toBeGreaterThan(0);
			expect(composer.viewportClickCandidates(responseRow)).toEqual(["AgentClick"]);
		} finally {
			composer.stop();
		}
	});
});
