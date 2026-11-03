import { expect, it } from "bun:test";
import { DOWNLOAD_PAIRING_MS, DownloadPairing } from "../../../browser-relay/extension/download-pairing";

const URL = "https://example.com/r.csv";

it("pairs each reported download with Chrome's next item of its URL", () => {
	const pairing = new DownloadPairing(() => 0);
	pairing.report("a", URL);
	pairing.created(1, URL);
	pairing.report("b", URL);
	pairing.created(2, "https://example.com/other.csv");
	pairing.created(3, URL);
	expect([pairing.idFor("a"), pairing.idFor("b")]).toEqual([1, 3]);
	pairing.forget("a");
	expect(pairing.idFor("a")).toBeUndefined();
});

it("lets a report Chrome never made an item for expire instead of taking a later download's item", () => {
	let now = 0;
	const pairing = new DownloadPairing(() => now);
	pairing.report("refused", URL);
	now += DOWNLOAD_PAIRING_MS + 1;
	pairing.report("retry", URL);
	pairing.created(7, URL);
	expect(pairing.idFor("retry")).toBe(7);
	expect(pairing.idFor("refused")).toBeUndefined();
});
