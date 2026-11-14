import { afterEach, expect, test } from "bun:test";
import { raceAbortSignal } from "@oh-my-pi/pi-coding-agent/mcp/oauth-reauth";

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
	unhandled.push(reason);
};

afterEach(() => {
	process.off("unhandledRejection", onUnhandled);
	unhandled.length = 0;
});

test("raceAbortSignal keeps observing work that rejects after an already-aborted caller left", async () => {
	process.on("unhandledRejection", onUnhandled);
	const work = Promise.withResolvers<never>();
	const raced = raceAbortSignal(work.promise, AbortSignal.abort(), () => new Error("login cancelled"));
	work.reject(new Error("late discovery failure"));
	await expect(raced).rejects.toThrow("login cancelled");
	const turn = Promise.withResolvers<void>();
	setImmediate(turn.resolve);
	await turn.promise;
	expect(unhandled).toEqual([]);
});
