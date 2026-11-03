import { types } from "node:util";

const isPromise = types.isPromise;

/**
 * The one place a thrown or rejected value becomes text.
 *
 * Such a value can come from any code, and describing it runs that code: a
 * getter, a `toString`, a Proxy trap. That code can throw, answer differently
 * on a second read, return something that is not text, return something
 * enormous, or replace the built-ins a description would call next.
 * {@link describeError} reads each property of the value at most once, each
 * inside its own `try`, through built-ins captured when this module loaded,
 * bounds every string it keeps, and returns plain data. Every reporter takes
 * the {@link DescribedError} it returns, which nothing else can make, so a
 * reporter cannot read the value a second time.
 *
 * What it cannot bound: a getter or trap that never returns blocks the thread
 * that reads it, as any code that never returns does.
 */

// Captured before any cell, tool or consumer code runs in this realm: code a
// value runs can replace the globals, and a description that called the
// replacements would run that code again or get no text back.
const reflectApply = Reflect.apply;
const reflectGet = Reflect.get;
const reflectGetPrototypeOf = Reflect.getPrototypeOf;
const isArray = Array.isArray;
const toText = String;
const stringSlice = String.prototype.slice;
const promiseThen = Promise.prototype.then;
// `Error.isError` reads an internal slot: it recognises an error of any realm and runs none of its code.
const errorIsErrorBuiltin: unknown = reflectGet(Error, "isError");
const errorIsError =
	typeof errorIsErrorBuiltin === "function"
		? (value: unknown): boolean => reflectApply(errorIsErrorBuiltin, Error, [value]) === true
		: undefined;

declare const describedBrand: unique symbol;

/** A built-in error class a value's prototype chain can lead to. */
export type ErrorClassName =
	| "Error"
	| "AggregateError"
	| "EvalError"
	| "RangeError"
	| "ReferenceError"
	| "SyntaxError"
	| "TypeError"
	| "URIError";

/**
 * Plain data describing a thrown or rejected value. Only {@link describeError}
 * makes one: the brand exists only in the type, and no other module can name it.
 * Every field is an own property, present even when `undefined`.
 */
export interface DescribedError {
	readonly [describedBrand]: true;
	/** The nearest built-in error class on the value's prototype chain, `"Error"` for an error from another realm, `undefined` when it is not an error. */
	readonly errorClass: ErrorClassName | undefined;
	/** An error's `name`, when it is text. */
	readonly name: string | undefined;
	/**
	 * An error's `message`, or any other value's string form. When neither can
	 * be read as text: `[object Error]`, `[object Array]`, `[object Function]` or
	 * `[object Object]`, chosen without running any of the value's code, or, for
	 * a revoked Proxy, a sentence that names its type.
	 */
	readonly message: string;
	/** An error's `stack`, when it is text. */
	readonly stack: string | undefined;
	/** An error's `code`, when it is text. */
	readonly code: string | undefined;
	/** An error's `syscall`, when it is text. */
	readonly syscall: string | undefined;
}

/** Characters kept of a message or a stack; longer text keeps its start and its end. */
export const DESCRIBED_TEXT_LIMIT = 64 * 1024;
/** Characters kept of a name, a code or a syscall. */
const DESCRIBED_FIELD_LIMIT = 1024;
/** Prototypes followed before a chain counts as no error at all: a Proxy can make the chain endless. */
const PROTOTYPE_DEPTH_LIMIT = 64;

const ERROR_PROTOTYPES: readonly object[] = [
	Error.prototype,
	AggregateError.prototype,
	EvalError.prototype,
	RangeError.prototype,
	ReferenceError.prototype,
	SyntaxError.prototype,
	TypeError.prototype,
	URIError.prototype,
];
const ERROR_CLASS_NAMES: readonly ErrorClassName[] = [
	"Error",
	"AggregateError",
	"EvalError",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
	"TypeError",
	"URIError",
];

/**
 * Whether `prototype` is on `value`'s prototype chain, as `instanceof` decides
 * with the default `Symbol.hasInstance`, and never throws. It follows at most
 * {@link PROTOTYPE_DEPTH_LIMIT} links: a Proxy's `getPrototypeOf` trap can
 * return a new Proxy every time, which makes `instanceof` loop forever. A trap
 * that throws means no.
 */
export function inheritsFrom(value: unknown, prototype: object): boolean {
	return walkPrototypes(value, proto => proto === prototype) !== undefined;
}

/** The nearest built-in error class on `value`'s prototype chain; bounded like {@link inheritsFrom}. Never throws. */
export function errorClassOf(value: unknown): ErrorClassName | undefined {
	let found: ErrorClassName | undefined;
	walkPrototypes(value, proto => {
		for (let index = 0; index < ERROR_PROTOTYPES.length; index++) {
			if (proto === ERROR_PROTOTYPES[index]) {
				found = ERROR_CLASS_NAMES[index];
				return true;
			}
		}
		return false;
	});
	return found;
}

/**
 * Whether `value`'s prototype chain leads to a built-in error class, as
 * `value instanceof Error` decides, bounded like {@link inheritsFrom}, or it is
 * an error from another realm; never throws. It proves only that much: a Proxy
 * can pass and still throw on any read, so read such a value through
 * {@link describeError}.
 */
export function isErrorValue(value: unknown): value is Error {
	return errorClassOf(value) !== undefined || isNativeError(value);
}

/** The first prototype on `value`'s chain that `matches`, within the depth limit. */
function walkPrototypes(value: unknown, matches: (proto: object) => boolean): object | undefined {
	if (value === null || (typeof value !== "object" && typeof value !== "function")) return undefined;
	try {
		// A Proxy's `getPrototypeOf` trap may return a rejected promise as the prototype.
		let proto = reflectGetPrototypeOf(value);
		observeRejection(proto);
		for (let depth = 0; proto !== null && depth < PROTOTYPE_DEPTH_LIMIT; depth++) {
			if (matches(proto)) return proto;
			proto = reflectGetPrototypeOf(proto);
			observeRejection(proto);
		}
	} catch (thrown) {
		// A Proxy's `getPrototypeOf` trap threw; what it threw may be a rejected promise.
		observeRejection(thrown);
	}
	return undefined;
}

/** `text`, or its start and end around a note of how much was left out. */
function bounded(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const half = limit >> 1;
	const head = reflectApply(stringSlice, text, [0, half]) as string;
	const tail = reflectApply(stringSlice, text, [text.length - half]) as string;
	return `${head}… [${text.length - 2 * half} characters omitted] …${tail}`;
}

/**
 * `object[key]`, read once. A read that yields a native promise has it observed
 * ({@link observeQuietly}), so a getter that returns a rejected promise cannot
 * leave a rejection unhandled because it was described.
 */
function readField(object: object, key: string): unknown {
	const field: unknown = reflectGet(object, key);
	observeRejection(field);
	return field;
}

/**
 * Marks a native promise's rejection as handled, through the built-in `then`
 * captured at load. Applied to everything a description reads or catches: the
 * described value, each field read, each throw. Both callbacks ignore their
 * value, so observing a fulfilled promise forwards nothing into a child, and a
 * rejection whose reason is itself a rejected promise has that reason observed
 * too. A promise whose `constructor` or species refuses even that stays
 * unobserved; such a promise is outside what a description can handle. Never
 * throws.
 */
export function observeRejection(value: unknown): void {
	if (!isPromise(value)) return;
	try {
		reflectApply(promiseThen, value, [ignoreFulfilment, observeRejection]);
	} catch {
		// The promise's `constructor` getter or species constructor threw.
	}
}

function ignoreFulfilment(): void {}

/** `object[key]` when it is text, read once; `undefined` when it is not text or reading it throws. */
function textProperty(object: object, key: string, limit: number): string | undefined {
	try {
		const field = readField(object, key);
		return typeof field === "string" ? bounded(field, limit) : undefined;
	} catch (thrown) {
		observeRejection(thrown);
		return undefined;
	}
}

/** `String(value)` when it returns text; `undefined` when it throws or does not. */
function convertedText(value: unknown): string | undefined {
	try {
		const text: unknown = toText(value);
		return typeof text === "string" ? bounded(text, DESCRIBED_TEXT_LIMIT) : undefined;
	} catch (thrown) {
		observeRejection(thrown);
		return undefined;
	}
}

/**
 * What to call a value whose text cannot be read. It runs none of the value's
 * code and reads none of its properties: a conversion that failed may already
 * have read `Symbol.toStringTag` once, so `Object.prototype.toString` would read
 * it again.
 */
function fallbackText(value: unknown, errorClass: ErrorClassName | undefined): string {
	if (typeof value === "function") return "[object Function]";
	if (errorClass !== undefined) return "[object Error]";
	try {
		if (isArray(value)) return "[object Array]";
	} catch {
		// Only a revoked Proxy makes `Array.isArray` throw.
		return `a thrown ${typeof value} that cannot be converted to text`;
	}
	return "[object Object]";
}

/**
 * Describes any thrown or rejected value, and never throws. An error (a value
 * whose prototype chain leads to a built-in error class, or one from another
 * realm that `Error.isError` recognises) has its `message`, `name`, `stack`,
 * `code` and `syscall` read once each. A primitive is converted with
 * `String()`. An object or a function, including an error's `message` that is
 * one, is not converted at all: converting it runs its code without bound, as
 * `Error.prototype.toString` on a value whose `name` or `message` is the value
 * itself, which reads that getter again until the stack overflows. Each string
 * kept is at most {@link DESCRIBED_TEXT_LIMIT} characters.
 */
export function describeError(value: unknown): DescribedError {
	// A thrown or rejected value can itself be a rejected promise; describing it observes it.
	observeRejection(value);
	let errorClass = errorClassOf(value);
	// An error made in another realm (a `node:vm` context, say) has that realm's prototypes.
	if (errorClass === undefined && isNativeError(value)) errorClass = "Error";
	let message: string | undefined;
	let name: string | undefined;
	let stack: string | undefined;
	let code: string | undefined;
	let syscall: string | undefined;
	if (errorClass !== undefined) {
		const error = value as object;
		try {
			const field = readField(error, "message");
			message = typeof field === "string" ? bounded(field, DESCRIBED_TEXT_LIMIT) : primitiveText(field);
		} catch (thrown) {
			// The message getter or a Proxy trap threw; what it threw may be a rejected promise.
			observeRejection(thrown);
		}
		name = textProperty(error, "name", DESCRIBED_FIELD_LIMIT);
		stack = textProperty(error, "stack", DESCRIBED_TEXT_LIMIT);
		code = textProperty(error, "code", DESCRIBED_FIELD_LIMIT);
		syscall = textProperty(error, "syscall", DESCRIBED_FIELD_LIMIT);
	} else {
		message = primitiveText(value);
	}
	const description = {
		errorClass,
		name,
		message: message ?? fallbackText(value, errorClass),
		stack,
		code,
		syscall,
	};
	return description as DescribedError;
}

/** `String(value)` for a primitive; `undefined` for an object or a function, which it does not convert. */
function primitiveText(value: unknown): string | undefined {
	if (value !== null && (typeof value === "object" || typeof value === "function")) return undefined;
	return convertedText(value);
}

/** Whether `value` is a genuine error object of any realm. Runs no code of the value; a Proxy is not one. */
function isNativeError(value: unknown): boolean {
	try {
		return errorIsError !== undefined && errorIsError(value);
	} catch {
		return false;
	}
}
