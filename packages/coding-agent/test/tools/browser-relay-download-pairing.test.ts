import { expect, it } from "bun:test";
import {
	DOWNLOAD_LOOKUP_MS,
	DOWNLOAD_PAIRING_MS,
	DownloadPairing,
} from "../../../browser-relay/extension/download-pairing";

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

it("pairs a burst of reports that come before any of Chrome's items, in order", () => {
	const pairing = new DownloadPairing(() => 0);
	for (let i = 0; i < 50; i++) pairing.report(`g${i}`, URL);
	for (let i = 0; i < 50; i++) pairing.created(i, URL);
	expect([pairing.idFor("g0"), pairing.idFor("g49")]).toEqual([0, 49]);
});

it("keeps every running download's pair however many run, and drops a pair once nobody will look it up", () => {
	let now = 0;
	const pairing = new DownloadPairing(() => now);
	for (let id = 0; id < 300; id++) {
		pairing.report(`g${id}`, `${URL}?${id}`);
		pairing.created(id, `${URL}?${id}`);
	}
	expect(pairing.idFor("g0")).toBe(0);
	pairing.finished(1, "interrupted");
	expect(pairing.idFor("g1")).toBeUndefined();
	pairing.finished(2, "complete");
	now += DOWNLOAD_LOOKUP_MS + 1;
	expect(pairing.idFor("g2")).toBe(2);
	pairing.finished(3, "complete");
	expect([pairing.idFor("g2"), pairing.idFor("g3"), pairing.idFor("g0")]).toEqual([undefined, 3, 0]);
});
