import { afterEach, expect, test } from "bun:test";
import { raceWithSignal } from "@oh-my-pi/pi-ai/utils/abort";

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
	unhandled.push(reason);
};

afterEach(() => {
	process.off("unhandledRejection", onUnhandled);
	unhandled.length = 0;
});

test("raceWithSignal keeps observing shared work that rejects after an already-aborted caller left", async () => {
	process.on("unhandledRejection", onUnhandled);
	const work = Promise.withResolvers<never>();
	const raced = raceWithSignal(work.promise, AbortSignal.abort(new Error("stop")));
	work.reject(new Error("late failure"));
	await expect(raced).rejects.toThrow("stop");
	const turn = Promise.withResolvers<void>();
	setImmediate(turn.resolve);
	await turn.promise;
	expect(unhandled).toEqual([]);
});
