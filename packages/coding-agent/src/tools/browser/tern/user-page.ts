/**
 * Pages omp opens in Tern for the user to look at, not for the agent to drive
 * (the `/stats` and `omp stats` dashboards). Tern's browser op `open` with
 * `how` docks a browser block by the pane omp runs in (a split beside or below
 * it, or in its place until the page closes), then `release` hands the block
 * to the user: no agent card in other tabs, no page kept live out of sight.
 * Outside a Tern pane, or when Tern cannot open the page, callers fall back to
 * the system browser.
 */
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { resolveTernPane } from "./kind";
import { TernError, TernSocketClient } from "./wire";

/** Where {@link openTernPage} docks the page by omp's pane: Tern's `how`. */
export type TernPagePlacement = "beside" | "below" | "over";

/** How long Tern gets to answer an `open`; it gives up on a page itself after 10 s. */
const OPEN_TIMEOUT_MS = 15_000;
const OP_TIMEOUT_MS = 5_000;
/** How often {@link TernPage.closed} asks Tern whether the block is still there. */
const POLL_MS = 500;

/** A browser block omp opened in Tern and handed to the user. */
export class TernPage {
	readonly block: number;
	readonly #socketPath: string;
	#client: TernSocketClient;

	constructor(client: TernSocketClient, block: number) {
		this.#client = client;
		this.#socketPath = client.socketPath;
		this.block = block;
	}

	/**
	 * Resolves once the block is gone (the user closed it). Tern pushes nothing,
	 * so this polls `state`; a dropped connection or a Tern with no window keeps
	 * waiting, since the block outlives both.
	 */
	async closed(): Promise<void> {
		for (;;) {
			await Bun.sleep(POLL_MS);
			try {
				await this.#request({ op: "state", block: this.block });
			} catch (error) {
				if (error instanceof TernError && error.kind === "not_found") return;
			}
		}
	}

	/** Close the block (one already gone is no error) and drop the connection. */
	async close(): Promise<void> {
		try {
			await this.#request({ op: "close", block: this.block });
		} catch (error) {
			if (!(error instanceof TernError && error.kind === "not_found")) {
				logger.debug("Could not close the Tern page", { block: this.block, error: String(error) });
			}
		} finally {
			this.disconnect();
		}
	}

	/** Drop the connection to Tern; the block stays. */
	disconnect(): void {
		this.#client.close();
	}

	/** One op over the connection, replacing it once it dropped (a closed client never reopens). */
	async #request(op: Record<string, unknown>): Promise<unknown> {
		try {
			await this.#client.connect();
			return await this.#client.request(op, { timeoutMs: OP_TIMEOUT_MS });
		} catch (error) {
			if (error instanceof TernError && (error.kind === "closed" || error.kind === "connect")) {
				this.#client.close();
				this.#client = new TernSocketClient({ socketPath: this.#socketPath });
			}
			throw error;
		}
	}
}

/**
 * Open `url` in a Tern browser block docked `how` by the pane omp runs in and
 * hand it to the user; it takes the focus. Null outside a Tern pane or when
 * this Tern cannot open it (no window, the pane in another window, Tern
 * unreachable): open the system browser then.
 */
export async function openTernPage(url: string, how: TernPagePlacement): Promise<TernPage | null> {
	const pane = resolveTernPane();
	if (!pane) return null;
	const client = new TernSocketClient({ socketPath: pane.socketPath });
	try {
		await client.connect();
		const opened = await client.request({ op: "open", owner: pane.pane, url, how }, { timeoutMs: OPEN_TIMEOUT_MS });
		if (!isRecord(opened) || typeof opened.block !== "number") {
			throw new TernError("protocol", "Tern answered open without a block");
		}
		const block = opened.block;
		await client.request({ op: "release", block }, { timeoutMs: OP_TIMEOUT_MS }).catch(error => {
			logger.debug("Tern kept driving the page omp opened", { block, error: String(error) });
		});
		return new TernPage(client, block);
	} catch (error) {
		logger.debug("Tern could not open the page; using the system browser", { url, how, error: String(error) });
		client.close();
		return null;
	}
}
