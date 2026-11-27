// =============================================================================
// Type-Safe Key Identifiers
// =============================================================================

type Letter =
	| "a"
	| "b"
	| "c"
	| "d"
	| "e"
	| "f"
	| "g"
	| "h"
	| "i"
	| "j"
	| "k"
	| "l"
	| "m"
	| "n"
	| "o"
	| "p"
	| "q"
	| "r"
	| "s"
	| "t"
	| "u"
	| "v"
	| "w"
	| "x"
	| "y"
	| "z";

type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";

type KeySymbol =
	| "`"
	| "-"
	| "="
	| "["
	| "]"
	| "\\"
	| ";"
	| "'"
	| ","
	| "."
	| "/"
	| "!"
	| "@"
	| "#"
	| "$"
	| "%"
	| "^"
	| "&"
	| "*"
	| "("
	| ")"
	| "_"
	| "+"
	| "|"
	| "~"
	| "{"
	| "}"
	| ":"
	| "<"
	| ">"
	| "?";

type SpecialKey =
	| "escape"
	| "esc"
	| "enter"
	| "return"
	| "tab"
	| "space"
	| "backspace"
	| "delete"
	| "insert"
	| "clear"
	| "home"
	| "end"
	| "pageUp"
	| "pageDown"
	| "up"
	| "down"
	| "left"
	| "right"
	| "f1"
	| "f2"
	| "f3"
	| "f4"
	| "f5"
	| "f6"
	| "f7"
	| "f8"
	| "f9"
	| "f10"
	| "f11"
	| "f12";

type BaseKey = Letter | Digit | KeySymbol | SpecialKey;

/** Modifier key names as they appear in {@link KeyId} chords. */
export type ModifierName = "ctrl" | "shift" | "alt" | "super";

type ModifiedKeyId<Key extends string, RemainingModifiers extends ModifierName = ModifierName> = {
	[M in RemainingModifiers]: `${M}+${Key}` | `${M}+${ModifiedKeyId<Key, Exclude<RemainingModifiers, M>>}`;
}[RemainingModifiers];

/**
 * Union type of all valid key identifiers.
 * Provides autocomplete and catches typos at compile time.
 */
export type KeyId = BaseKey | ModifiedKeyId<BaseKey>;

/** Modifiers in the order pi-tui key event ids list them. */
const MODIFIER_ORDER: readonly ModifierName[] = ["ctrl", "alt", "shift", "super"];

/** Symbols typed with Shift on a US layout; pi-tui reports a Shift-only press of one as the bare symbol. */
const SHIFTED_SYMBOLS: ReadonlySet<string> = new Set([
	"!",
	"@",
	"#",
	"$",
	"%",
	"^",
	"&",
	"*",
	"(",
	")",
	"_",
	"+",
	"{",
	"}",
	"|",
	":",
	"<",
	">",
	"?",
	"~",
]);

/** Key names whose pi-tui id is camelCase; config chords are case-insensitive. */
const KEY_NAMES: Readonly<Record<string, string>> = {
	esc: "escape",
	return: "enter",
	pageup: "pageUp",
	pagedown: "pageDown",
};

/** Length of a `<modifier>+` prefix of `key` at `offset` (case-insensitive), or 0. */
function modifierAt(key: string, offset: number, modifier: string): number {
	const end = offset + modifier.length;
	// The modifier needs a `+` and a key after it: `ctrl+` alone is no chord, `ctrl++` is Ctrl and the plus key.
	if (key.length <= end + 1 || key[end] !== "+") return 0;
	return key.slice(offset, end).toLowerCase() === modifier ? modifier.length + 1 : 0;
}

/**
 * The pi-tui `KeyEvent` id a configured chord
 * stands for: modifiers in `ctrl+alt+shift+super` order, `esc`/`return` as
 * `escape`/`enter`, `pageUp`/`pageDown` camelCase, an uppercase letter as
 * `shift+<letter>`, and a Shift-only symbol (`shift+?`) as the symbol it
 * types (`?`). Two chords match the same key exactly when their ids are equal.
 */
export function canonicalKeyId(key: string): string {
	const modifiers = new Set<ModifierName>();
	let offset = 0;
	for (let found = true; found;) {
		found = false;
		for (const modifier of MODIFIER_ORDER) {
			const length = modifierAt(key, offset, modifier);
			if (length === 0) continue;
			modifiers.add(modifier);
			offset += length;
			found = true;
			break;
		}
	}
	const raw = key.slice(offset);
	const lower = raw.toLowerCase();
	const base = KEY_NAMES[lower] ?? lower;
	if (/^[A-Z]$/.test(raw)) modifiers.add("shift");
	if (modifiers.size === 1 && modifiers.has("shift") && SHIFTED_SYMBOLS.has(base)) return base;
	let id = "";
	for (const modifier of MODIFIER_ORDER) if (modifiers.has(modifier)) id += `${modifier}+`;
	return id + base;
}
