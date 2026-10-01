import { log } from "../log";

const keys: string[] = [];
const KEEP = 3;

export function rotateKeys(newKey: string): string[] {
	keys.unshift(newKey);
	const dropped = keys.splice(KEEP);
	log.info("keys rotated", { active: keys.length, dropped: dropped.length });
	return keys;
}
