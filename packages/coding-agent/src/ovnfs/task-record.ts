import * as path from "node:path";
import { isEnoent, isRecord } from "@oh-my-pi/pi-utils";
import { removeCheckout } from "./checkouts";

/** Record of the checkout an isolation dir stands for. */
export const OVNFS_CHECKOUT_FILE = ".omp-ovnfs-checkout.json";

/** Contents of {@link OVNFS_CHECKOUT_FILE}. */
export interface CheckoutRecord {
	/** ovnfs executable that opened the checkout (it can start the daemon again). */
	command: string;
	checkout: string;
	/** The checkout on the same capture a branch commit reads its baseline from, while it exists. */
	start?: string;
}

/**
 * Remove the ovnfs checkouts a task-isolation dir records and report whether it
 * recorded one. Throws when a checkout cannot be removed (the record then stays
 * for a later retry); `omp worktree clear` calls this before deleting the dir.
 */
export async function releaseOvnfsCheckout(dir: string): Promise<boolean> {
	let record: unknown;
	try {
		record = await Bun.file(path.join(dir, OVNFS_CHECKOUT_FILE)).json();
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
	if (
		!isRecord(record) ||
		typeof record.command !== "string" ||
		typeof record.checkout !== "string" ||
		(record.start !== undefined && typeof record.start !== "string")
	) {
		throw new Error(`Invalid ovnfs isolation record in ${dir}`);
	}
	if (record.start) await removeCheckout(record.command, record.start);
	await removeCheckout(record.command, record.checkout);
	return true;
}
