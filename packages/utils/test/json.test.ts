import { describe, expect, it } from "bun:test";
import * as vm from "node:vm";
import {
	jsonDeepEquals,
	stableStringifyJson,
	stringifyDeepJson,
	stringifyJson,
	stringifyJsonIteratively,
} from "@oh-my-pi/pi-utils/json";
import { nestsDeeperThan } from "@oh-my-pi/pi-utils/nested-walk";
import { nestedChain } from "../../ai/test/helpers/deep-nesting";

describe("stableStringifyJson", () => {
	it("canonicalizes nested object key order while preserving array order", () => {
		const left = { settings: { beta: 2, alpha: { z: true, a: false } }, args: ["--b", "--a"] };
		const right = { args: ["--b", "--a"], settings: { alpha: { a: false, z: true }, beta: 2 } };

		expect(stableStringifyJson(left)).toBe(stableStringifyJson(right));
		expect(stableStringifyJson({ args: ["--a", "--b"] })).not.toBe(stableStringifyJson({ args: ["--b", "--a"] }));
	});

	it("preserves __proto__ as an ordinary own JSON key", () => {
		const value: unknown = JSON.parse('{"__proto__":{"x":1}}');

		expect(stableStringifyJson(value)).toBe('{"__proto__":{"x":1}}');
		expect(stableStringifyJson(value)).not.toBe(stableStringifyJson({}));
	});

	it("rejects a top-level value JSON cannot serialize", () => {
		expect(() => stableStringifyJson(undefined)).toThrow("Value is not JSON-serializable");
	});
});

describe("stringifyJson", () => {
	it("serializes bigint values as decimal strings", () => {
		expect(stringifyJson({ n: 10n })).toBe('{"n":"10"}');
	});

	it("serializes bigints produced by toJSON", () => {
		expect(stringifyJson({ o: { toJSON: () => 5n } })).toBe('{"o":"5"}');
	});

	it("coerces bigints that follow a stateful serializer", () => {
		let calls = 0;
		const value = { a: { toJSON: () => ++calls }, b: 1n };
		expect(stringifyJson(value)).toBe('{"a":2,"b":"1"}');
	});

	it("still throws TypeError for non-serializable values", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(() => stringifyJson(circular)).toThrow(TypeError);
	});

	it("rethrows non-TypeError serializer failures without retrying", () => {
		let calls = 0;
		const failing = {
			toJSON: () => {
				calls++;
				throw new RangeError("boom");
			},
		};
		expect(() => stringifyJson({ x: failing })).toThrow(RangeError);
		expect(calls).toBe(1);
	});
});

/** What `fn` throws, so two writers' errors compare by kind and message. */
function thrown(fn: () => unknown): unknown {
	try {
		fn();
	} catch (error) {
		return error instanceof Error ? [error.constructor.name, error.message] : error;
	}
	return "nothing thrown";
}

/** What `write` gives for each of `cases`, by name: its text, or what it throws, so two writers compare case by case. */
function outcomes(
	cases: Readonly<Record<string, unknown>>,
	write: (value: unknown) => string | undefined,
): Record<string, unknown> {
	const results: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(cases)) {
		let text: string | undefined;
		const error = thrown(() => {
			text = write(value);
		});
		results[name] = { text, error };
	}
	return results;
}

/**
 * `[1, 2]` behind a proxy that reports `length` as its length. Reading more
 * than eight elements throws, so a writer that misreads the length fails at
 * once instead of writing `null` until memory runs out.
 */
function arrayReporting(length: unknown): unknown[] {
	let reads = 0;
	return new Proxy([1, 2], {
		get(target, key, receiver) {
			if (key === "length") return length;
			if (typeof key === "string" && /^\d+$/.test(key) && ++reads > 8) {
				throw new Error("read past the reported length");
			}
			return Reflect.get(target, key, receiver);
		},
	});
}

/**
 * A value `levels` containers deep whose levels take turns among the shapes
 * `JSON.stringify` treats apart: values it leaves out of an object and writes
 * `null` in an array, `toJSON(key)` returning a container or `undefined`, a
 * hole, boxed primitives and a `Date`, integer-like keys it writes first, a
 * getter, symbol and inherited keys it skips, and strings it escapes.
 */
function deepValue(levels: number): unknown {
	let value: unknown = 'leaf \u2028 "quoted" \\ \ud800';
	for (let level = 0; level < levels; level++) {
		const child = value;
		switch ((level * 7 + 3) % 8) {
			case 0:
				value = {
					[`k${level}`]: child,
					u: undefined,
					f: () => level,
					s: Symbol("s"),
					n: level / 3,
					t: `tab\t${level}`,
				};
				break;
			case 1:
				value = [child, undefined, () => level, Symbol("s"), Number.NaN, -0, Number.POSITIVE_INFINITY];
				break;
			case 2:
				value = { toJSON: (key: string) => ({ key, inner: child }) };
				break;
			case 3: {
				const sparse: unknown[] = [];
				sparse[1] = child;
				value = sparse;
				break;
			}
			case 4:
				value = {
					"2": child,
					b: new Number(level),
					a: new String("x"),
					d: new Date(level),
					"1": new Boolean(true),
				};
				break;
			case 5:
				value = {
					get g() {
						return child;
					},
					[Symbol("hidden")]: level,
				};
				break;
			case 6:
				value = { omitted: { toJSON: () => undefined }, kept: child, list: [{ toJSON: () => undefined }] };
				break;
			default:
				value = Object.assign(Object.create({ inherited: level }), { own: child, [String(level)]: null });
		}
	}
	return value;
}

// The RPC encoder writes a frame through `stringifyDeepJson`; a byte that differs from
// `JSON.stringify`'s is a frame the client parses to a different value than the host sent.
describe("stringifyJsonIteratively", () => {
	const otherRealm = vm.createContext({});
	const fromOtherRealm = (source: string): unknown => vm.runInContext(source, otherRealm);

	it("writes JSON.stringify's bytes for each kind of value", () => {
		const shared = { x: 1 };
		const callable = Object.assign(() => 1, { toJSON: () => "callable" });
		// Values a `toJSON` returns that have a `toJSON` of their own, which `JSON.stringify` does not call.
		const callableWithToJSON = Object.assign(() => 1, { toJSON: () => "called again" });
		const boxWithToJSON = Object.assign(new Number(5), { toJSON: (key: string) => `box ${key}` });
		const hole: unknown[] = [0];
		hole[2] = 2;
		const cases: Record<string, unknown> = {
			// Written by `JSON.stringify` itself once the walk reaches them: one row of them inside a container.
			scalars: ['a "quoted" \\ \n \u2028 \ud800 string', 1.5e300, -0, null],
			notFinite: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
			booleans: [true, false],
			undefined,
			boxed: [new Number(3), new String("s"), new Boolean(false), new Number(-0), new Number(Number.NaN)],
			boxedRoot: new String("root"),
			boxedInOtherRealm: {
				number: fromOtherRealm("new Number(7)"),
				string: fromOtherRealm('new String("ab")'),
				boolean: fromOtherRealm("new Boolean(false)"),
			},
			boxedRootInOtherRealm: fromOtherRealm('new String("root")'),
			boxedWithObjectPrototype: {
				number: Object.setPrototypeOf(new Number(3), Object.prototype),
				string: Object.setPrototypeOf(new String("s"), Object.prototype),
				boolean: Object.setPrototypeOf(new Boolean(true), Object.prototype),
			},
			boxedOverrides: [
				Object.assign(new Number(1), { valueOf: () => 7 }),
				Object.assign(new String("s"), { toString: () => "t" }),
				Object.assign(new Boolean(false), { valueOf: () => true }),
			],
			boxedSymbol: { a: Object(Symbol("s")), keyed: Object.assign(Object(Symbol("s")), { k: [1] }) },
			numberPrototypeObject: { a: Object.assign(Object.create(Number.prototype), { x: 1 }) },
			boxWithToJSON: { a: boxWithToJSON },
			empty: { object: {}, array: [] },
			keyOrder: { b: 1, 2: 2, a: 3, 1: 4 },
			escapedKeys: { 'a"b': 1, "\n": 2, "\u2028": 3 },
			protoKey: JSON.parse('{"__proto__":{"x":1}}'),
			omittedInObject: { u: undefined, f: () => 1, s: Symbol("s"), kept: 1 },
			nullInArray: [undefined, () => 1, Symbol("s"), 1],
			hole,
			toJSONKey: { a: { toJSON: (key: string) => `key ${key}` }, list: [{ toJSON: (key: string) => key }] },
			toJSONContainer: { a: { toJSON: () => ({ nested: [1, { toJSON: () => 2 }] }) } },
			toJSONUndefined: { gone: { toJSON: () => undefined }, list: [{ toJSON: () => undefined }] },
			toJSONRoot: { toJSON: (key: string) => ({ root: key }) },
			toJSONReturnsCallableWithToJSON: {
				a: { toJSON: () => callableWithToJSON },
				list: [{ toJSON: () => callableWithToJSON }],
			},
			toJSONRootReturnsCallableWithToJSON: { toJSON: () => callableWithToJSON },
			toJSONReturnsBoxWithToJSON: { a: { toJSON: () => boxWithToJSON } },
			callableToJSON: { callable },
			date: new Date(0),
			symbolKey: { [Symbol("x")]: 1, a: 2 },
			hidden: Object.defineProperty({ shown: 1 }, "hidden", { value: 2, enumerable: false }),
			getter: {
				get computed() {
					return [1, 2];
				},
			},
			inherited: Object.assign(Object.create({ inherited: 1 }), { own: 2 }),
			collections: [new Map([[1, 2]]), new Set([1])],
			typedArray: new Uint8Array([1, 2]),
			buffer: Buffer.from("ab"),
			sharedNotCycle: { a: shared, b: [shared, shared] },
		};
		expect(outcomes(cases, stringifyJsonIteratively)).toEqual(outcomes(cases, value => JSON.stringify(value)));
	});

	it("throws JSON.stringify's errors for a cycle, a bigint and a throwing toJSON", () => {
		const list: unknown[] = [];
		const cycle = { a: list };
		list.push(cycle);
		const failing = {
			x: {
				toJSON: () => {
					throw new RangeError("boom");
				},
			},
		};
		const cases: Record<string, unknown> = {
			cycle,
			bigint: { n: 1n },
			boxedBigInt: [Object(1n)],
			boxedBigIntInOtherRealm: { a: fromOtherRealm("Object(1n)") },
			bigintFromValueOf: { a: Object.assign(new Number(1), { valueOf: () => 1n }) },
			failing,
		};
		expect(outcomes(cases, stringifyJsonIteratively)).toEqual(outcomes(cases, value => JSON.stringify(value)));
	});

	// With `BigInt.prototype.toJSON` installed (as a host that sends bigints as text does), a bigint
	// a `toJSON` returns would be written as that text where `JSON.stringify` throws.
	it("calls no toJSON on the bigint a toJSON returns, as JSON.stringify does", () => {
		Object.defineProperty(BigInt.prototype, "toJSON", { configurable: true, writable: true, value: () => "big" });
		try {
			const cases: Record<string, unknown> = {
				returned: { a: { toJSON: () => 5n } },
				own: { n: 1n, boxed: Object(1n) },
			};
			expect(outcomes(cases, stringifyJsonIteratively)).toEqual(outcomes(cases, value => JSON.stringify(value)));
		} finally {
			Reflect.deleteProperty(BigInt.prototype, "toJSON");
		}
	});

	// An array proxy reporting a length that is not a whole number made the writer write `,null`
	// until the process ran out of memory.
	it("reads an array's length as JSON.stringify does", () => {
		const lengths: Record<string, unknown> = {
			string: "2",
			fraction: 2.5,
			negative: -1,
			notANumber: Number.NaN,
			bigint: 2n,
		};
		const arrays = (): Record<string, unknown> =>
			Object.fromEntries(Object.entries(lengths).map(([name, length]) => [name, arrayReporting(length)]));
		expect(outcomes(arrays(), stringifyJsonIteratively)).toEqual(outcomes(arrays(), value => JSON.stringify(value)));
	});

	// A session line holds a bigint an extension hook put in an entry as its decimal string; a deep
	// line is written by this writer, which threw for it, so the entry could not be written at all.
	it("writes a bigint as stringifyJson does when asked to, and still throws for a boxed one", () => {
		const cases: Record<string, unknown> = {
			bigint: { n: 1n, list: [2n, { m: -3n }] },
			root: 4n,
			boxedBigInt: [Object(1n)],
		};
		expect(outcomes(cases, value => stringifyJsonIteratively(value, { bigintAsString: true }))).toEqual(
			outcomes(cases, value => stringifyJson(value)),
		);
	});

	// Every shape of `deepValue` appears 500 times and the text crosses the writer's chunk join many
	// times; deeper, Bun's `JSON.stringify` takes seconds (its time grows with the square of the
	// depth), so the 100,000-deep chain below tests the writer alone.
	it("writes JSON.stringify's bytes for a generated value 4,000 levels deep", () => {
		const value = deepValue(4_000);
		expect(stringifyJsonIteratively(value) === JSON.stringify(value)).toBe(true);
	});
});

// RPC `get_tree` of a session longer than about 10,000 entries nests each one under its parent,
// past where `JSON.stringify` runs out of stack; without the fallback the command fails.
describe("stringifyDeepJson", () => {
	it("writes a 100,000-deep chain that JSON.stringify cannot", () => {
		let chain: unknown = { id: "leaf", children: [] };
		let expected = '{"id":"leaf","children":[]}';
		for (let index = 0; index < 100_000; index++) {
			chain = { id: `n${index}`, children: [chain] };
			expected = `{"id":"n${index}","children":[${expected}]}`;
		}
		expect(() => JSON.stringify(chain)).toThrow(RangeError);
		expect(stringifyDeepJson(chain) === expected).toBe(true);
	}, 60_000);

	it("throws TypeError for a cycle below the depth JSON.stringify reaches", () => {
		const bottom: Record<string, unknown> = { id: "bottom" };
		let chain: Record<string, unknown> = bottom;
		for (let index = 0; index < 100_000; index++) chain = { child: chain };
		bottom.loop = chain;
		expect(thrown(() => stringifyDeepJson(chain))).toEqual([
			"TypeError",
			"JSON.stringify cannot serialize cyclic structures.",
		]);
	}, 60_000);

	it("writes a bigint at the bottom of a 100,000-deep chain as its decimal string when asked to", () => {
		let chain: unknown = { n: 7n };
		let expected = '{"n":"7"}';
		for (let index = 0; index < 100_000; index++) {
			chain = { child: chain };
			expected = `{"child":${expected}}`;
		}
		expect(stringifyDeepJson(chain, { bigintAsString: true }) === expected).toBe(true);
	}, 60_000);

	// The /dump request JSON is indented for a reader; indented, a value's text grows with the square of its depth
	// (30,000 levels is a 1.8 GB string), and past 40,000 levels `JSON.stringify` throws.
	it("indents as JSON.stringify does, and writes a value nested past 1,000 levels without indentation", () => {
		const shallow = { a: [1, { b: "c" }], d: null };
		expect(stringifyDeepJson(shallow, { space: 2 })).toBe(JSON.stringify(shallow, undefined, 2));
		let deep: unknown = { leaf: 1n };
		for (let index = 0; index < 50_000; index++) deep = { next: deep };
		expect(
			stringifyDeepJson(deep, { space: 2, bigintAsString: true }) ===
				stringifyJsonIteratively(deep, { bigintAsString: true }),
		).toBe(true);
	}, 20_000);

	// Bun's `JSON.stringify` spends 1.5 s or more running out of stack on a value 40,000 levels deep before the
	// fallback writes it again, calling each getter ahead of the overflow a second time; a caller that writes the
	// same messages again and again paid that on every write. Given `space` past 1,000 levels, `probeDepth` past
	// 10,000, or `deep`, the value goes to the iterative writer alone.
	it("writes a value it routes to the iterative writer once, its getters read once", () => {
		for (const options of [{ space: 2 }, { probeDepth: true }, { deep: true }]) {
			let reads = 0;
			const value = {
				get count() {
					return ++reads;
				},
				tree: nestedChain(),
			};
			expect(stringifyDeepJson(value, options) === stringifyJsonIteratively({ count: 1, tree: nestedChain() })).toBe(
				true,
			);
			expect(reads).toBe(1);
		}
		// Past 1,000 levels given `space`, and at any depth given `deep`, without indentation.
		const middle = nestedChain(undefined, 5_000);
		expect(stringifyDeepJson(middle, { space: 2 }) === stringifyJsonIteratively(middle)).toBe(true);
		const shallow = { a: [1, { b: "c" }], d: null };
		expect(stringifyDeepJson(shallow, { deep: true, space: 2 })).toBe(JSON.stringify(shallow));
	}, 20_000);

	// The depth check runs before `JSON.stringify` walks the value: a getter it read would run twice (an Anthropic
	// request sent `{"x":2}`), one behind a `toJSON` that `JSON.stringify` never reads would throw, and an array's
	// replaced iterator, which `JSON.stringify` never calls, would throw.
	it("checks the depth without calling a getter, reading past a toJSON or iterating an array", () => {
		const cases: Record<string, () => unknown> = {
			getter: () => {
				let reads = 0;
				return {
					get x() {
						return ++reads;
					},
				};
			},
			behindToJson: () => ({
				toJSON: () => ({ shown: true }),
				get hidden(): never {
					throw new Error("hidden getter");
				},
			}),
			iterator: () => {
				const list = [1, { a: 2 }];
				Object.defineProperty(list, Symbol.iterator, {
					value: () => {
						throw new TypeError("iterator called");
					},
				});
				return list;
			},
		};
		// Fresh values for each writer, so neither sees a getter the other already read.
		const fresh = (): Record<string, unknown> =>
			Object.fromEntries(Object.entries(cases).map(([name, make]) => [name, make()]));
		for (const options of [{ probeDepth: true }, { space: 2 }]) {
			expect(outcomes(fresh(), value => stringifyDeepJson(value, options))).toEqual(
				outcomes(fresh(), value => JSON.stringify(value, undefined, options.space)),
			);
		}
	});

	// Only the engine's stack overflow is written again: a RangeError a `toJSON` throws is `JSON.stringify`'s
	// error, where writing again called the `toJSON` a second time and wrote what that returned.
	it("throws the RangeError a toJSON throws without calling it again", () => {
		let calls = 0;
		const value = {
			toJSON: () => {
				calls++;
				if (calls === 1) throw new RangeError("first call");
				return 7;
			},
		};

		expect(thrown(() => stringifyDeepJson(value))).toEqual(["RangeError", "first call"]);
		expect(calls).toBe(1);
	});
});

// `JSON.stringify` writes what an object's `toJSON` returns only when that `toJSON` is a function, and writes any other
// `toJSON` key as a key like the rest; JSON carries such keys (`"toJSON": null`). A check that took every object with a
// `toJSON` key as shallow sent a value deep below one to a `JSON.stringify` that runs out of stack.
describe("nestsDeeperThan", () => {
	it("goes into an object whose toJSON is not a function, and into none whose toJSON is one", () => {
		const deep = nestedChain();
		class Wrapped {
			toJSON(): string {
				return "wrapped";
			}
		}
		const cases: Record<string, unknown> = {
			dataKey: { toJSON: null, next: deep },
			inheritedDataKey: Object.assign(Object.create({ toJSON: "inherited" }), { next: deep }),
			// Not called: the writer that walks the value next reads each getter once, as `JSON.stringify` does.
			getter: {
				get toJSON(): never {
					throw new Error("toJSON getter called");
				},
				next: deep,
			},
			shallowDataKey: { toJSON: null, next: { leaf: "bottom" } },
			callable: { toJSON: () => "own", next: deep },
			inheritedCallable: Object.assign(new Wrapped(), { next: deep }),
			callableInArray: [{ toJSON: () => "own", next: deep }],
		};
		expect(Object.entries(cases).map(([name, value]) => [name, nestsDeeperThan(value, 10_000)])).toEqual([
			["dataKey", true],
			["inheritedDataKey", true],
			["getter", true],
			["shallowDataKey", false],
			["callable", false],
			["inheritedCallable", false],
			["callableInArray", false],
		]);
	});

	// A proxy's traps are its owner's code. `JSON.stringify` calls a proxy's `get`, `ownKeys` and
	// `getOwnPropertyDescriptor` traps but never `has`, so a check that asked a proxy whether it has a `toJSON`
	// threw before the writer, which writes it, could run.
	it("goes into no proxy, so one whose has trap throws is left to the writer", () => {
		const throwingHas = <T extends object>(target: T): T =>
			new Proxy(target, {
				has() {
					throw new Error("has trap called");
				},
			});
		const value = { input: throwingHas({ path: "a.ts", lines: [1, 2] }), list: throwingHas([{ a: 1 }]) };

		// A plain object one level down would answer true.
		expect(nestsDeeperThan(value, 1)).toBe(false);
		expect(nestsDeeperThan({ input: { path: "a.ts" } }, 1)).toBe(true);
		expect(stringifyDeepJson(value, { probeDepth: true })).toBe(
			'{"input":{"path":"a.ts","lines":[1,2]},"list":[{"a":1}]}',
		);
		expect(stringifyDeepJson(value, { space: 2 })).toBe(JSON.stringify(value, undefined, 2));
	});
});

// Session code compares messages (a reload, the fallback model's fit, an RPC terminal frame, an Anthropic
// request) by `Bun.deepEquals`, which recurses; an answer that differs from its answer changes what those
// callers decide.
describe("jsonDeepEquals", () => {
	const symbol = Symbol("s");
	const shared = { x: 1 };
	const hole: unknown[] = [1];
	hole[2] = 3;
	const selfCycle = (): Record<string, unknown> => {
		const node: Record<string, unknown> = { a: 1 };
		node.self = node;
		return node;
	};
	// Two objects like `selfCycle`'s, each referring to the other.
	const pairCycle = (): Record<string, unknown> => {
		const first: Record<string, unknown> = { a: 1 };
		first.self = { a: 1, self: first };
		return first;
	};
	const arrayCycle = (): unknown[] => {
		const list: unknown[] = [1];
		list.push(list);
		return list;
	};
	const backReference = (): Record<string, unknown> => {
		const child: Record<string, unknown> = { name: "child" };
		const parent = { child };
		child.parent = parent;
		return parent;
	};
	const cases: Record<string, readonly [unknown, unknown]> = {
		// A value no walk goes into is compared by `Bun.deepEquals`: one row for each way an `===` or a walk of its keys
		// would answer otherwise, each inside a container the walk goes into.
		nan: [{ v: Number.NaN }, { v: Number.NaN }],
		negativeZero: [{ v: 0 }, { v: -0 }],
		dateDiffers: [{ v: new Date(0) }, { v: new Date(1) }],
		undefinedAndNull: [{ a: undefined }, { a: null }],
		holeAndUndefined: [hole, [1, undefined, 3]],
		holeAndNull: [hole, [1, null, 3]],
		trailingUndefined: [[1], [1, undefined]],
		sharedAndCopies: [
			{ a: shared, b: shared },
			{ a: { x: 1 }, b: { x: 1 } },
		],
		keyOrder: [
			{ a: 1, b: 2 },
			{ b: 2, a: 1 },
		],
		undefinedProperty: [{ a: 1, u: undefined }, { a: 1 }],
		nestedUndefinedProperty: [{ a: { u: undefined } }, { a: {} }],
		symbolKeyDiffers: [
			{ a: 1, [symbol]: 1 },
			{ a: 1, [symbol]: 2 },
		],
		symbolKeyMissing: [{ a: 1, [symbol]: 1 }, { a: 1 }],
		arrayAndObject: [[1, 2], { 0: 1, 1: 2 }],
		nullPrototypeAndPlain: [Object.assign(Object.create(null), { a: 1 }), { a: 1 }],
		hidden: [Object.defineProperty({ a: 1 }, "h", { value: 2, enumerable: false }), { a: 1 }],
		arrayExtraKey: [Object.assign([1], { p: 1 }), [1]],
		nestedDiffers: [{ a: [{ b: [1, 2] }] }, { a: [{ b: [1, 3] }] }],
		nestedEqual: [{ a: [{ b: [1, { c: "x" }] }] }, { a: [{ b: [1, { c: "x" }] }] }],
		extraKey: [{ a: 1 }, { a: 1, b: 2 }],
		// A live value (a tool's `details`, say) can refer to itself, which JSON cannot.
		selfCycles: [selfCycle(), selfCycle()],
		arrayCycles: [arrayCycle(), arrayCycle()],
		backReferences: [backReference(), backReference()],
		cycleShapes: [selfCycle(), pairCycle()],
		cycleOneLevelDown: [selfCycle(), { a: 1, self: selfCycle() }],
	};
	const answers = (equals: (a: unknown, b: unknown) => boolean): Record<string, readonly [boolean, boolean]> =>
		Object.fromEntries(Object.entries(cases).map(([name, [a, b]]) => [name, [equals(a, b), equals(b, a)]]));

	it("answers as Bun.deepEquals does for each kind of value, both ways round", () => {
		expect(answers(jsonDeepEquals)).toEqual(answers((a, b) => Bun.deepEquals(a, b)));
	});

	// A transcript line nests millions of levels; `Bun.deepEquals` runs out of stack near 16,000.
	it("compares values nested 50,000 levels", () => {
		const chain = (bottom: unknown): unknown => {
			let node = bottom;
			for (let level = 0; level < 50_000; level++) node = level % 2 === 0 ? { next: node } : [node];
			return node;
		};
		expect(jsonDeepEquals(chain({ leaf: "a" }), chain({ leaf: "a" }))).toBe(true);
		expect(jsonDeepEquals(chain({ leaf: "a" }), chain({ leaf: "b" }))).toBe(false);
	});

	// A cycle sits as deep as a transcript line nests, past where `Bun.deepEquals` runs out of stack.
	it("answers cycles 50,000 levels long as Bun.deepEquals answers short ones", () => {
		// `length` objects each holding the next, the last holding the first.
		const ring = (length: number): Record<string, unknown> => {
			const first: Record<string, unknown> = {};
			let node = first;
			for (let index = 1; index < length; index++) {
				const next: Record<string, unknown> = {};
				node.next = next;
				node = next;
			}
			node.next = first;
			return first;
		};
		expect([jsonDeepEquals(ring(2), ring(2)), jsonDeepEquals(ring(2), ring(1))]).toEqual([
			Bun.deepEquals(ring(2), ring(2)),
			Bun.deepEquals(ring(2), ring(1)),
		]);
		expect(jsonDeepEquals(ring(50_000), ring(50_000))).toBe(true);
		expect(jsonDeepEquals(ring(50_000), ring(25_000))).toBe(false);
	});
});
