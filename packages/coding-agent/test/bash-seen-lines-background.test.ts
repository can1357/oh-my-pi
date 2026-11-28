import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { createSession, footers, SOURCE, textOutput } from "./helpers/bash-seen-lines";

const EDITED = SOURCE.replace("line 35: value_35", "line 35: changed");

function sessionSettings(autoBackground: boolean): Record<string, unknown> {
	return {
		"async.enabled": true,
		"bash.autoBackground.enabled": autoBackground,
		// Far past any test command: a command always finishes within the foreground wait.
		"bash.autoBackground.thresholdMs": 60_000,
	};
}

type BashContext = Parameters<BashTool["execute"]>[4];

// D25: only a result handed straight back as the call's tool result credits its rows. A managed job's text reaches
// the model later as a follow-up; crediting it inside the job would let an edit anchor rows the model has not seen.
describe("bash seen lines with managed jobs", () => {
	let cwd: string;
	let file: string;
	let manager: AsyncJobManager;
	let session: ToolSession;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bash-seen-lines-bg-"));
		file = path.join(cwd, "values.txt");
		await Bun.write(file, SOURCE);
		manager = new AsyncJobManager({});
		session = createSession(cwd, { asyncJobManager: manager, settings: sessionSettings(true) });
	});

	afterEach(async () => {
		await manager.dispose();
		await removeWithRetries(cwd);
	});

	async function edit(input: string): Promise<string> {
		return textOutput(await new EditTool(session, "hashline").execute("edit", { input }));
	}

	/** A tag for values.txt from a read that does not show line 35. */
	async function tagWithoutLine35(): Promise<string> {
		const read = textOutput(await new ReadTool(session).execute("read", { path: "values.txt:30-31" }));
		const header = read.split("\n")[0];
		expect(header).toMatch(/^\[values\.txt#[0-9A-F]{4}\]$/);
		return header;
	}

	async function expectLine35Unseen(): Promise<void> {
		const header = await tagWithoutLine35();
		expect(await edit(`${header}\nPUT 35.=35:\n+line 35: changed\n`)).toContain("never displayed");
		expect(await Bun.file(file).text()).toBe(SOURCE);
	}

	it("credits a command that finishes within the auto-background wait", async () => {
		const result = await new BashTool(session).execute("bash", { command: "grep -n 'value_35$' values.txt" });
		expect(result.details?.async).toBeUndefined();
		const output = textOutput(result);
		expect(output).toContain("35:line 35: value_35");
		const [footer, ...rest] = footers(output);
		expect(rest).toEqual([]);
		expect(footer).toMatchObject({ path: "values.txt", lines: "35" });

		await edit(`${footer.header}\nPUT 35.=35:\n+line 35: changed\n`);
		expect(await Bun.file(file).text()).toBe(EDITED);
	});

	it("credits nothing in an auto-background wait read by a program", async () => {
		const result = await new BashTool(session).execute(
			"bash",
			{ command: "grep -n 'value_35$' values.txt" },
			undefined,
			undefined,
			{ programmatic: true } as unknown as BashContext,
		);
		expect(result.details?.async).toBeUndefined();
		expect(textOutput(result).trimEnd()).toBe("35:line 35: value_35");
		expect(result.details?.editTags).toBeUndefined();
		await expectLine35Unseen();
	});

	// D9/D12: a timed-out result shows rows but never credits them. Timeouts reach the model only on the direct path
	// (the auto-background wait ends a second before the timeout), so this session runs commands directly.
	it("credits nothing in a timed-out direct run", async () => {
		session = createSession(cwd, { asyncJobManager: manager, settings: sessionSettings(false) });
		const result = await new BashTool(session).execute("bash", {
			command: "grep -n 'value_35$' values.txt; sleep 5",
			timeout: 1,
		});
		expect(result.details?.async).toBeUndefined();
		expect(result.details?.timedOut).toBe(true);
		const output = textOutput(result);
		expect(output).toContain("35:line 35: value_35");
		expect(footers(output)).toEqual([]);
		expect(result.details?.editTags).toBeUndefined();
		await expectLine35Unseen();
	}, 10_000);

	it("credits nothing in an explicit async job", async () => {
		const started = await new BashTool(session).execute("bash", {
			command: "grep -n 'value_35$' values.txt",
			async: true,
		});
		const jobId = started.details?.async?.jobId;
		if (!jobId) throw new Error("expected a background job");
		await manager.waitForAll();
		const job = manager.getJob(jobId);
		expect(job?.status).toBe("completed");
		const text = job?.resultText ?? "";
		expect(text).toContain("35:line 35: value_35");
		expect(text).not.toContain("[values.txt#");
		expect(footers(text)).toEqual([]);
		await expectLine35Unseen();
	});
});
