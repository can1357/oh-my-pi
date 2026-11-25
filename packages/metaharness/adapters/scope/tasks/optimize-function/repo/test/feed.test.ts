import { expect, test } from "bun:test";
import { CATALOGUE } from "../src/catalogue";
import { importFeed, PAGE_PAUSE_MS } from "../src/feed";

const PAGE_SIZE = 5;
const PAGES = 16;

test("pulls every page and keeps to the supplier's rate limit", async () => {
	const requested: number[] = [];
	const fetchPage = async (page: number) => {
		requested.push(page);
		return page < PAGES ? CATALOGUE.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) : [];
	};
	const started = Date.now();
	const names = await importFeed(fetchPage);
	expect(names).toEqual(CATALOGUE.slice(0, PAGES * PAGE_SIZE));
	expect(requested).toEqual(Array.from({ length: PAGES + 1 }, (_, page) => page));
	expect(Date.now() - started).toBeGreaterThanOrEqual(PAGES * PAGE_PAUSE_MS - 50);
}, 20_000);
