import { describe, expect, it } from "bun:test";
import { DEFAULT_STT_MODEL_KEY } from "@oh-my-pi/pi-coding-agent/stt/local/models";
import {
	DEFAULT_STT_TRANSCRIBER_ID,
	isSttTranscriberId,
	STT_TRANSCRIBER_OPTIONS,
	STT_TRANSCRIBER_VALUES,
} from "@oh-my-pi/pi-coding-agent/stt/transcriber-registry";

// Loading the registry pulls the transcriber implementation graph (local
// worker client, Codex provider). Before the id/option metadata moved to
// ./types, this graph cycled back through config/settings-schema and crashed
// at module load with a TDZ ReferenceError on STT_TRANSCRIBER_VALUES whenever
// the registry entered evaluation first — this file's import order is the
// repro, so simply loading it guards the cycle.
describe("stt transcriber registry", () => {
	it("lists local models plus codex and defaults to a local model", () => {
		expect(DEFAULT_STT_TRANSCRIBER_ID).toBe(DEFAULT_STT_MODEL_KEY);
		expect(STT_TRANSCRIBER_VALUES).toContain(DEFAULT_STT_MODEL_KEY);
		expect(STT_TRANSCRIBER_VALUES).toContain("codex");
		expect(STT_TRANSCRIBER_OPTIONS.map(option => option.value)).toEqual([...STT_TRANSCRIBER_VALUES]);
	});

	it("accepts codex and local model keys, rejects unknown ids", () => {
		expect(isSttTranscriberId("codex")).toBe(true);
		expect(isSttTranscriberId(DEFAULT_STT_MODEL_KEY)).toBe(true);
		expect(isSttTranscriberId("not-a-transcriber")).toBe(false);
	});
});
