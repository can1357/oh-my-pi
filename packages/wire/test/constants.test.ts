import { describe, expect, it } from "bun:test";
import {
	COLLAB_PROMPT_MESSAGE_TYPE,
	COLLAB_PROTO,
	DEFAULT_RELAY_URL,
	ENVELOPE_HEADER_LENGTH,
	ROOM_ID_BYTES,
} from "../src";

describe("collab wire constants", () => {
	it("exports the protocol constants consumed by host, guest, and relay links", () => {
		expect(COLLAB_PROTO).toBe(2);
		expect(COLLAB_PROMPT_MESSAGE_TYPE).toBe("collab-prompt");
		expect(ENVELOPE_HEADER_LENGTH).toBe(4);
		expect(ROOM_ID_BYTES).toBe(16);
		expect(DEFAULT_RELAY_URL).toBe("wss://my.omp.sh");
	});
});
