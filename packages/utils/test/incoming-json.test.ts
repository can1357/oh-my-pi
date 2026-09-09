import { describe, expect, it } from "bun:test";
import { IncomingDoc, IncomingJsonError } from "@oh-my-pi/pi-utils/incoming-json";
import { parseJsonWithRepair } from "@oh-my-pi/pi-utils/json-parse";

/** Whether `promise` is still unsettled after the microtask queue and one macrotask drain. */
async function pending(promise: Promise<unknown>): Promise<boolean> {
	let settled = false;
	promise.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	// One event-loop turn, not a guessed delay: pulls settle through bounded
	// microtask chains, and an unsettled pull only wakes on a later push.
	await Bun.sleep(0);
	return !settled;
}

async function failure(promise: Promise<unknown>): Promise<IncomingJsonError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(IncomingJsonError);
		return error as IncomingJsonError;
	}
	throw new Error("expected the pull to reject");
}

describe("incoming JSON cursors", () => {
	it("yields a nested key's string chunks before the enclosing object finishes", async () => {
		const { feed, doc } = IncomingDoc.channel();
		feed.push('{"meta":{"name":"hel');

		const name = doc.root().object().key("meta").object().key("name").string();
		expect(await name.nextChunk()).toBe("hel");
		const next = name.nextChunk();
		expect(await pending(next)).toBe(true);

		feed.push('lo"},"later":[1,2]}');
		expect(await next).toBe("lo");
		expect(await name.nextChunk()).toBeUndefined();
		feed.finish();
	});

	it("emits only stable decoded chunks across split escapes and surrogate pairs", async () => {
		const { feed, doc } = IncomingDoc.channel();
		feed.push('{text:"a\\');
		const text = doc.root().object().key("text").string();
		expect(await text.nextChunk()).toBe("a");

		feed.push("n\\uD83");
		expect(await text.nextChunk()).toBe("\n");
		const rest = text.nextChunk();
		expect(await pending(rest)).toBe(true);
		feed.push('D\\uDE00z"}');
		expect(await rest).toBe("😀z");
		expect(await text.nextChunk()).toBeUndefined();
		feed.finish();
	});

	it("hands out array elements as they begin and collects them once closed", async () => {
		const { feed, doc } = IncomingDoc.channel();
		feed.push("{items:[{x:1},[");
		const items = doc.root().object().key("items").array();

		const first = await items.next();
		expect(await first?.value<{ x: number }>()).toEqual({ x: 1 });
		const second = await items.next();
		expect(second).toBeDefined();
		const value = second!.value<unknown[]>();
		expect(await pending(value)).toBe(true);

		feed.push("True,None]]}");
		expect(await value).toEqual([true, null]);
		expect(await items.next()).toBeUndefined();
		feed.finish();
	});

	it("supports async iteration over elements and string chunks", async () => {
		const { feed, doc } = IncomingDoc.channel();
		feed.push('["ab');
		const elements = doc.root().array()[Symbol.asyncIterator]();
		const first = (await elements.next()).value;
		expect(first).toBeDefined();
		const chunks = first!.string()[Symbol.asyncIterator]();
		expect((await chunks.next()).value).toBe("ab");
		const rest = chunks.next();
		expect(await pending(rest)).toBe(true);
		feed.push('c","d"]');
		feed.finish();
		expect((await rest).value).toBe("c");
		expect((await chunks.next()).done).toBe(true);
		const second = (await elements.next()).value;
		expect(second).toBeDefined();
		expect(await second!.string().text()).toBe("d");
		expect((await elements.next()).done).toBe(true);
	});

	it("scalar and container pulls use the tolerant grammar", async () => {
		const { feed, doc } = IncomingDoc.channel();
		feed.push("{n:12.5, yes:True, nil:None, values:[1,'two',False]}");
		feed.finish();

		const root = doc.root().object();
		expect(await root.key("n").number()).toBe(12.5);
		expect(await root.key("yes").boolean()).toBe(true);
		expect(await root.key("nil").null()).toBeNull();
		expect(await root.key("values").array().collect<unknown>()).toEqual([1, "two", false]);
		expect(await root.key("values").kind()).toBe("array");
	});

	it("matches the final parser on comments and radix literals", async () => {
		const text = "{\"a\"/*c*/: 0x1F, // note\n 'b': 0b101}";
		const { feed, doc } = IncomingDoc.channel();
		feed.push(text);
		feed.finish();

		expect(await doc.root().value<unknown>()).toEqual(parseJsonWithRepair<unknown>(text));
		expect(await doc.root().object().key("a").number()).toBe(31);
		expect(await doc.root().object().key("b").number()).toBe(5);
	});

	it("does not commit an edge closing quote while the feed is open", async () => {
		const { feed, doc } = IncomingDoc.channel();
		feed.push("{text:'a'");

		// The closing quote sits at the buffer edge: more text may still reopen
		// it via inner-quote recovery, so the string must not end yet.
		const text = doc.root().object().key("text").string();
		expect(await text.nextChunk()).toBe("a");
		const rest = text.nextChunk();
		expect(await pending(rest)).toBe(true);

		feed.push("b'}");
		expect(await rest).toBe("'b");
		expect(await text.nextChunk()).toBeUndefined();
		feed.finish();
		expect(await doc.root().value<unknown>()).toEqual(parseJsonWithRepair<unknown>("{text:'a'b'}"));
	});

	it("defers chunks past a lone edge slash until the comment or content resolves", async () => {
		for (const [head, tail, full] of [
			['{text:"a"/', "*c*/}", '{text:"a"/*c*/}'],
			["{text:'a'/", "*c*/}", "{text:'a'/*c*/}"],
		] as const) {
			const { feed, doc } = IncomingDoc.channel();
			feed.push(head);

			const text = doc.root().object().key("text").string();
			expect(await text.nextChunk()).toBe("a");
			const rest = text.nextChunk();
			expect(await pending(rest)).toBe(true);

			feed.push(tail);
			expect(await rest).toBeUndefined();
			feed.finish();
			expect(await doc.root().value<unknown>()).toEqual(parseJsonWithRepair<unknown>(full));
		}
	});

	it("only appends to emitted chunks when an unterminated comment flips an edge close", async () => {
		const { feed, doc } = IncomingDoc.channel();
		feed.push("{text:'a'/*c");

		const text = doc.root().object().key("text").string();
		expect(await text.nextChunk()).toBe("a");
		const rest = text.nextChunk();
		expect(await pending(rest)).toBe(true);

		feed.push("*/x'}");
		expect(await rest).toBe("'/*c*/x");
		expect(await text.nextChunk()).toBeUndefined();
		feed.finish();
		expect(await doc.root().value<unknown>()).toEqual(parseJsonWithRepair<unknown>("{text:'a'/*c*/x'}"));
	});

	it("finish alone settles an edge-closed string but reports a truly unterminated one incomplete", async () => {
		{
			const { feed, doc } = IncomingDoc.channel();
			feed.push("{text:'a'");
			const text = doc.root().object().key("text").string();
			expect(await text.nextChunk()).toBe("a");
			const next = text.nextChunk();
			expect(await pending(next)).toBe(true);
			feed.finish();
			expect(await next).toBeUndefined();
		}
		{
			const { feed, doc } = IncomingDoc.channel();
			feed.push("{text:'a");
			const text = doc.root().object().key("text").string();
			expect(await text.nextChunk()).toBe("a");
			const next = text.nextChunk();
			expect(await pending(next)).toBe(true);
			feed.finish();
			expect((await failure(next)).kind).toBe("incomplete");
		}
	});

	it("a single push makes a pending chunk pull ready", async () => {
		const { feed, doc } = IncomingDoc.channel();
		feed.push("{text:'hel");
		const text = doc.root().object().key("text").string();
		expect(await text.nextChunk()).toBe("hel");
		const next = text.nextChunk();
		expect(await pending(next)).toBe(true);
		feed.push("lo");
		expect(await next).toBe("lo");
		feed.finish();
	});

	it("chunk pulls surface a mismatch for non-string values", async () => {
		const { feed, doc } = IncomingDoc.channel();
		feed.push("{text: 42}");
		feed.finish();
		const issue = await failure(doc.root().object().key("text").string().nextChunk());
		expect(issue.kind).toBe("mismatch");
		expect(issue.found).toBe("number");
	});

	it("never swallows a sibling through quote recovery", async () => {
		// The final parser rejects all four documents. Double quotes close
		// strictly in incoming, and a pulled scalar completes only once a value
		// terminator follows, so each rejected pull reports incomplete instead
		// of silently returning swallowed text (or a mislocated member).
		for (const [text, key] of [
			['{"a":"x" "b":1}', "a"],
			["{'a':'x' 'b':1}", "a"],
			['{"a":"x" "y"}', "a"],
			['{"a" "b":1}', "a"],
		] as const) {
			expect(() => parseJsonWithRepair(text)).toThrow();
			const { feed, doc } = IncomingDoc.channel();
			feed.push(text);
			feed.finish();
			expect((await failure(doc.root().object().key(key).value())).kind).toBe("incomplete");
		}

		// The recovered key spelling must not match either: the key token itself never swallows.
		{
			const { feed, doc } = IncomingDoc.channel();
			feed.push('{"a" "b":1}');
			feed.finish();
			expect((await failure(doc.root().object().key('a" "b').number())).kind).toBe("incomplete");
		}

		// Single-quoted value–value recovery is identical in the final parser, so the pull stays lenient.
		{
			const text = "{'a':'x' 'y'}";
			expect(parseJsonWithRepair<unknown>(text)).toEqual({ a: "x' 'y" });
			const { feed, doc } = IncomingDoc.channel();
			feed.push(text);
			feed.finish();
			expect(await doc.root().object().key("a").string().text()).toBe("x' 'y");
		}
	});

	it("reports a truncated string as incomplete at its path", async () => {
		const { feed, doc } = IncomingDoc.channel();
		feed.push('{message:"not done');
		const message = doc.root().object().key("message").string();
		feed.finish();
		const issue = await failure(message.text());
		expect(issue.path).toEqual(["message"]);
		expect(issue.expected).toBe("string");
		expect(issue.kind).toBe("incomplete");
	});

	it("binds the first duplicate key on cursors but the last on collection", async () => {
		const { feed, doc } = IncomingDoc.channel();
		feed.push("{dup:1, dup:2}");
		feed.finish();
		expect(await doc.root().object().key("dup").value<number>()).toBe(1);
		expect(await doc.root().object().collect<unknown>()).toEqual({ dup: 2 });
	});

	it("pulled keys are required while unpulled members are never validated", async () => {
		{
			const { feed, doc } = IncomingDoc.channel();
			feed.push("{path:'ok', unknown:[unfinished");
			feed.finish();
			expect(await doc.root().object().key("path").string().text()).toBe("ok");
			expect((await failure(doc.whole())).kind).toBe("malformed");
		}
		{
			const { feed, doc } = IncomingDoc.channel();
			feed.push("{path:'ok'}");
			feed.finish();
			const missing = await failure(doc.root().object().key("missing").value());
			expect(missing.path).toEqual(["missing"]);
			expect(missing.expected).toBe("value");
			expect(missing.kind).toBe("missing");

			const mistyped = await failure(doc.root().object().key("path").number());
			expect(mistyped.path).toEqual(["path"]);
			expect(mistyped.expected).toBe("number");
			expect(mistyped.kind).toBe("mismatch");
			expect(mistyped.found).toBe("string");
		}
		{
			const { feed, doc } = IncomingDoc.channel();
			feed.push("{meta:{count:'many'}}");
			feed.finish();
			const mistyped = await failure(doc.root().object().key("meta").object().key("count").number());
			expect(mistyped.path).toEqual(["meta", "count"]);
			expect(mistyped.expected).toBe("number");
			expect(mistyped.found).toBe("string");
		}
		{
			const { feed, doc } = IncomingDoc.channel();
			feed.push("{meta:5}");
			feed.finish();
			const mistyped = await failure(doc.root().object().key("meta").object().key("count").number());
			expect(mistyped.path).toEqual(["meta", "count"]);
			expect(mistyped.expected).toBe("object");
			expect(mistyped.found).toBe("number");
		}
	});

	it("whole-document validation is an explicit pull that recovers barewords", async () => {
		const { feed, doc } = IncomingDoc.channel();
		feed.push("{path: packages/foo/*, enabled: True}");
		feed.finish();
		expect(await doc.whole<unknown>()).toEqual({ path: "packages/foo/*", enabled: true });
		expect(await doc.root().object().key("path").value<string>()).toBe("packages/foo/*");
	});

	it("an abandoned pull leaves no state behind for later pulls", async () => {
		const { feed, doc } = IncomingDoc.channel();
		feed.push("{a:");
		const abandoned = doc.root().object().key("a").number();
		expect(await pending(abandoned)).toBe(true);

		feed.push("1,b:2}");
		feed.finish();
		expect(await abandoned).toBe(1);
		const root = doc.root().object();
		expect(await root.key("a").number()).toBe(1);
		expect(await root.key("b").number()).toBe(2);
	});

	it("distinguishes finished from aborted terminal states", async () => {
		{
			const { feed, doc } = IncomingDoc.channel();
			feed.finish();
			await doc.finished();
			expect(() => feed.push("x")).toThrow();
		}
		{
			const { feed, doc } = IncomingDoc.channel();
			feed.abort();
			expect((await failure(doc.finished())).kind).toBe("aborted");
		}
		{
			const { feed, doc } = IncomingDoc.channel();
			const missing = doc.root().object().key("missing").value();
			feed.abort();
			const issue = await failure(missing);
			expect(issue.path).toEqual(["missing"]);
			expect(issue.expected).toBe("value");
			expect(issue.kind).toBe("aborted");
			expect((await failure(doc.whole())).kind).toBe("aborted");
		}
	});

	it("rounds line pulls down to complete lines until the string closes", async () => {
		const { feed, doc } = IncomingDoc.channel();
		const text = doc.root().object().key("text").string();

		feed.push('{"text":"a\\nb');
		expect(await text.nextLine()).toBe("a\n");
		const second = text.nextLine();
		expect(await pending(second)).toBe(true);

		feed.push("\\n");
		expect(await second).toBe("b\n");

		feed.push('c"}');
		expect(await text.nextLine()).toBe("c");
		expect(await text.nextLine()).toBeUndefined();
		feed.finish();

		const lines: string[] = [];
		for await (const line of doc.root().object().key("text").string().lines()) lines.push(line);
		expect(lines).toEqual(["a\n", "b\n", "c"]);
	});

	it("serves concurrent pulls on one cursor in call order", async () => {
		const { feed, doc } = IncomingDoc.channel();
		const text = doc.root().object().key("text").string();
		const first = text.nextChunk();
		const second = text.nextChunk();
		const items = doc.root().object().key("items").array();
		const a = items.next();
		const b = items.next();
		feed.push('{"text":"x');
		expect(await first).toBe("x");
		feed.push('y","items":[1,2]}');
		feed.finish();
		expect(await second).toBe("y");
		expect(await text.nextChunk()).toBeUndefined();
		expect(await (await a)?.number()).toBe(1);
		expect(await (await b)?.number()).toBe(2);
		expect(await items.next()).toBeUndefined();
	});

	it("resumes root scans across an unterminated comment at the buffer edge", async () => {
		const { feed, doc } = IncomingDoc.channel();
		feed.push('{"a":1, /* comm');
		const root = doc.root().object();
		expect(await root.key("a").number()).toBe(1);
		const b = root.key("b").number();
		expect(await pending(b)).toBe(true);
		feed.push('ent */ "b":2}');
		feed.finish();
		expect(await b).toBe(2);
		expect(await root.key("a").number()).toBe(1);
	});

	it("iterates a large nested array without rescanning earlier elements", async () => {
		const { feed, doc } = IncomingDoc.channel();
		const count = 20_000;
		const items = doc.root().object().key("items").array();
		feed.push('{"items":[');
		let sum = 0;
		const started = performance.now();
		for (let i = 0; i < count; i++) {
			feed.push(`{"n":${i}},`);
			const element = await items.next();
			sum += await element!.object().key("n").number();
		}
		feed.push("]}");
		feed.finish();
		expect(await items.next()).toBeUndefined();
		expect(sum).toBe((count * (count - 1)) / 2);
		expect(performance.now() - started).toBeLessThan(2_000);
	});
});
