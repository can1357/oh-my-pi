import { parseDuration } from "./duration";

/** Waits for a duration string such as `1500ms` or `2s`. */
export function sleepFor(text: string): Promise<void> {
	return Bun.sleep(parseDuration(text));
}
