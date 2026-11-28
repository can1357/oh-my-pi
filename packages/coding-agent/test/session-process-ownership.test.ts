import { describe, expect, it } from "bun:test";
import { ownedTagged } from "@oh-my-pi/pi-coding-agent/exec/session-processes";
import type { TaggedProcess } from "@oh-my-pi/pi-natives";

function proc(pid: number, startedAt: number, envValue?: string): TaggedProcess {
	return { pid, ppid: 1, startedAt, command: `cmd ${pid}`, ignoresHangup: false, stopped: false, envValue };
}

describe("ownedTagged", () => {
	const session = "s1";

	it("keeps this process's own tags and leaves a live foreign owner's processes alone", () => {
		const own = proc(10, 1_000, `${session}@${process.pid}`);
		const foreign = proc(11, 1_000, `${session}@4242`);
		const liveOwner = proc(4242, 500);
		expect(ownedTagged(session, [own, foreign], () => [liveOwner])).toEqual([own]);
	});

	it("adopts the processes of an owner that is gone, or whose pid now names a later process", () => {
		const orphan = proc(12, 1_000, `${session}@5151`);
		const reused = proc(13, 1_000, `${session}@6161`);
		const laterHolder = proc(6161, 2_000);
		expect(ownedTagged(session, [orphan, reused], () => [laterHolder])).toEqual([orphan, reused]);
	});

	it("ignores tags of another session or without an owner pid", () => {
		const other = proc(14, 1_000, `${session}x@${process.pid}`);
		const legacy = proc(15, 1_000, session);
		const malformed = proc(16, 1_000, `${session}@abc`);
		expect(ownedTagged(session, [other, legacy, malformed], () => [])).toEqual([]);
	});
});
