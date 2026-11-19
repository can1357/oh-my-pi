import { describe, expect, it } from "bun:test";
import { SpeakableStream } from "@oh-my-pi/pi-coding-agent/tts/speakable";

/** Push each delta in order, then flush; returns per-push segments plus the flush tail. */
function speak(...deltas: string[]): { pushed: string[][]; all: string[] } {
	const stream = new SpeakableStream();
	const pushed = deltas.map(delta => stream.push(delta));
	const flushed = stream.flush();
	return { pushed, all: [...pushed.flat(), ...flushed] };
}

describe("SpeakableStream code fences", () => {
	it("silences a fenced block while speaking the prose around it", () => {
		const { all } = speak(
			"Here is the code:\n```ts\nconst x = 1;\nconsole.log(x);\n```\nAnd that is all of it now.\n",
		);
		expect(all).toEqual(["Here is the code:", "And that is all of it now."]);
	});

	it("silences a block whose opening and closing fences are split across deltas", () => {
		const { pushed, all } = speak(
			"Intro line here.\n``",
			"`ts\nconst hidden = 42;\n``",
			"`\nOutro after code block.\n",
		);
		expect(pushed[0]).toEqual(["Intro line here."]);
		expect(pushed[1]).toEqual([]);
		expect(all).toEqual(["Intro line here.", "Outro after code block."]);
	});
});

describe("SpeakableStream tables", () => {
	it("silences | rows while speaking surrounding prose", () => {
		const { all } = speak("Results below.\n| a | b |\n| --- | --- |\n| 1 | 2 |\nDone with the table now.\n");
		expect(all).toEqual(["Results below.", "Done with the table now."]);
	});
});

describe("SpeakableStream links and URLs", () => {
	it("speaks only the label of a markdown link split across deltas, with no early mid-link cut", () => {
		const { pushed, all } = speak("See [the do", "cs](https://exam", "ple.com/path) for details.\n");
		expect(pushed[0]).toEqual([]);
		expect(pushed[1]).toEqual([]);
		expect(all).toEqual(["See the docs for details."]);
	});

	it.each([
		[
			"bare https URL speaks only the host",
			"Repo lives at https://github.com/foo/bar?x for now.\n",
			"Repo lives at github.com for now.",
		],
		[
			"www URL speaks the host without the www prefix or path",
			"Visit www.example.com/path when you can.\n",
			"Visit example.com when you can.",
		],
	])("%s", (_name, input, spoken) => {
		expect(speak(input).all).toEqual([spoken]);
	});
});

describe("SpeakableStream inline markup and line markers", () => {
	it.each([
		[
			"inline code speaks the identifier without ticks",
			"Call `parseConfig` before use today.\n",
			["Call parseConfig before use today."],
		],
		[
			"bold, italic, and strikethrough markers are stripped",
			"This **bold** and *ital* and ~~struck~~ text stays.\n",
			["This bold and ital and struck text stays."],
		],
		[
			"heading markers are stripped but the title speaks",
			"## Release Notes\nBody text follows here.\n",
			["Release Notes", "Body text follows here."],
		],
		[
			"bullet markers are stripped",
			"- item one is ready\n- item two is ready\n",
			["item one is ready", "item two is ready"],
		],
		["numbered list markers speak as a numeric prefix", "1. First\n", ["1, First"]],
	])("%s", (_name, input, spoken) => {
		expect(speak(input).all).toEqual(spoken);
	});
});

describe("SpeakableStream file paths", () => {
	it("collapses a multi-directory path to its basename", () => {
		const { all } = speak("Edit packages/coding-agent/src/tts/vocalizer.ts to fix it.\n");
		expect(all).toEqual(["Edit vocalizer.ts to fix it."]);
	});

	it("leaves two-component tokens like and/or untouched", () => {
		const { all } = speak("Use and/or as needed today.\n");
		expect(all).toEqual(["Use and/or as needed today."]);
	});
});

describe("SpeakableStream streaming latency", () => {
	it("emits a completed sentence from push() itself, without waiting for the next sentence", () => {
		const stream = new SpeakableStream();
		expect(stream.push("First sentence is long enough here. ")).toEqual(["First sentence is long enough here."]);
		expect(stream.flush()).toEqual([]);
	});
});

describe("SpeakableStream silent replies", () => {
	it("yields zero segments for a reply that is only markup, whitespace, and label-less link markup", () => {
		const stream = new SpeakableStream();
		expect(stream.push("---\n\n   \n**\n![](https://x.com/a.png)\n```\nlet a = 1;\n```\n| a |\n")).toEqual([]);
		expect(stream.flush()).toEqual([]);
	});
});

describe("SpeakableStream flush and flushIdle", () => {
	it("flush() drains a trailing partial sentence that push() held back", () => {
		const stream = new SpeakableStream();
		expect(stream.push("This is a trailing partial")).toEqual([]);
		expect(stream.flush()).toEqual(["This is a trailing partial"]);
	});

	it("flushIdle() refuses a short mid-sentence fragment, which a later flush() still drains", () => {
		const stream = new SpeakableStream();
		expect(stream.push("The")).toEqual([]);
		expect(stream.flushIdle()).toEqual([]);
		expect(stream.flush()).toEqual(["The"]);
	});

	it("flushIdle() drains a short but complete thought", () => {
		const stream = new SpeakableStream();
		expect(stream.push("Done here now.")).toEqual([]);
		expect(stream.flushIdle()).toEqual(["Done here now."]);
		expect(stream.flush()).toEqual([]);
	});
});

describe("SpeakableStream segment length cap", () => {
	it("force-splits an unpunctuated 1000+ char run into <=280-char segments that preserve every word", () => {
		const run = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
		expect(run.length).toBeGreaterThan(1000);
		const { all } = speak(run);
		expect(all.length).toBeGreaterThan(1);
		for (const segment of all) expect(segment.length).toBeLessThanOrEqual(280);
		expect(all.join(" ")).toBe(run);
	});

	it("keeps a single long punctuated sentence under the cap by cutting clauses", () => {
		const sentence =
			"The overnight rehearsal gave the whole launch team a useful scare, " +
			"because the backup sensor reported a shallow dip near the intake, " +
			"the navigation laptop briefly lost its shared clock, " +
			"the deck crew found two crates mislabeled beside the winch, " +
			"the weather desk revised the noon window twice, " +
			"and the captain still wanted the first survey pass finished before the harbor traffic thickened. ";

		expect(sentence.length).toBeGreaterThan(280);
		expect(sentence.trimEnd()).toMatch(/\.$/);

		const { all } = speak(sentence);

		expect(all.length).toBeGreaterThan(1);
		for (const segment of all) expect(segment.length).toBeLessThanOrEqual(280);
		for (const segment of all.slice(0, -1)) expect(segment).toMatch(/[,;:—–]$/);
		expect(all[all.length - 1]).toMatch(/[.!?…][)\]"'»”’]?$/);
	});

	it("force-splits the first segment when the first clause boundary is past the cap", () => {
		const sentence =
			"The maintenance lead reviewed the pressure logs from every pump station while the night operator compared " +
			"the handwritten readings with the telemetry archive and the safety observer watched the intake screens for " +
			"any sign of vibration or cavitation during the cold start sequence that followed the battery swap and calibration " +
			"pass after midnight and the backup technician confirmed that the spare controller stayed online through each valve " +
			"check and relay reset, then the control room marked the trial as stable and prepared the morning report. ";
		const firstComma = sentence.indexOf(",");

		expect(sentence.length).toBeGreaterThan(280);
		expect(firstComma).toBeGreaterThan(280);

		const { all } = speak(sentence);

		expect(all.length).toBeGreaterThan(1);
		expect(all[0].length).toBeLessThanOrEqual(140);
		for (const segment of all) expect(segment.length).toBeLessThanOrEqual(280);
	});
});

describe("SpeakableStream drain segmentation", () => {
	const longParagraph =
		"Morning fog rolled over the harbor as the crew finished loading the research skiff. " +
		"The tide had been gentle all week, but the forecast called for a quick turn after noon. " +
		"Mara asked everyone to check the ropes again, confirm the battery packs were dry, and keep the spare radio close. " +
		"By the time the first buoy blinked on the horizon, the engine note had settled and a clean lane of water opened ahead.\n";

	it("drains a large newline-terminated paragraph at sentence or clause boundaries", () => {
		expect(longParagraph.length).toBeGreaterThan(280);

		const { all } = speak(longParagraph);

		expect(all.length).toBeGreaterThan(1);
		for (const segment of all) expect(segment).toMatch(/[.!?…,:;—–][)\]"'»”’]?$/);
	});
});

describe("SpeakableStream abbreviations", () => {
	it.each([
		[
			'"e.g. " near the start does not end the first segment',
			"See e.g. the docs for more. ",
			"See e.g. the docs for more.",
		],
		// The abbreviation here sits past the first-segment minimum, so only the
		// abbreviation guard (not the length floor) prevents a cut after "e.g. ".
		[
			'"e.g. " past the minimum cut length still does not split the sentence',
			"See the docs e.g. the guide for more info. ",
			"See the docs e.g. the guide for more info.",
		],
	])("%s", (_name, input, spoken) => {
		const stream = new SpeakableStream();
		expect(stream.push(input)).toEqual([spoken]);
		expect(stream.flush()).toEqual([]);
	});
});
