import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import { executeBash } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { PipeStreams } from "@oh-my-pi/pi-natives";
import { JobWidgetRuntime, PipeTextSources } from "../../src/job-widgets";

describe("PipeTextSources", () => {
	it("keeps a pipe carrying binary data out of the widget's lines and stage", async () => {
		const streams = new PipeStreams();
		const command = "printf 'compiled\\n' | cat; printf 'ustar\\0\\0\\0\\n\\377\\376\\n' | cat >/dev/null";
		const result = await executeBash(command, { cwd: os.tmpdir(), timeout: 5000, streams });
		expect(result.exitCode).toBe(0);

		const runtime = new JobWidgetRuntime(undefined, Date.now());
		runtime.ingest(new PipeTextSources(streams).list(), true);
		const view = runtime.view({ label: command, authoring: false, lineStage: true });

		expect(view.stage).toBe("compiled");
		expect(runtime.totalLines).toBe(1);
		expect(runtime.samples().map(sample => sample.id)).toEqual(["pipe:1"]);
	});
});
