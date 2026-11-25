import { expect, test } from "bun:test";
import { mirror } from "../src/sync";

test("keeps polling until the remote list settles", async () => {
	let polls = 0;
	const fetchList = async () => {
		polls++;
		return Array.from({ length: Math.min(polls, 18) }, (_, index) => `item-${index}`);
	};
	const list = await mirror(fetchList);
	expect(list).toHaveLength(18);
	expect(polls).toBe(19);
}, 20_000);
