/**
 * Puppeteer-style key names (`Enter`, `ArrowLeft`, `KeyA`, `Shift`, `a`, `Control+a`)
 * as Tern trusted-input steps (`{"type":"key","action","key","code","mods"}`).
 */
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

/** A modifier as Tern's input steps name it. */
export type TernModifier = "shift" | "ctrl" | "alt" | "meta";

/** One trusted input step of Tern's `input` op. */
export type TernInputStep =
	| {
			type: "mouse";
			action: "move" | "down" | "up";
			x: number;
			y: number;
			button?: "left" | "right" | "middle";
			clicks?: number;
			mods?: TernModifier[];
	  }
	| { type: "wheel"; x: number; y: number; dx: number; dy: number; mods?: TernModifier[] }
	| { type: "key"; action: "down" | "up"; key: string; code?: string; text?: string; mods?: TernModifier[] }
	| { type: "text"; text: string };

/** A resolved key: its DOM `key`, DOM `code` when known, and the modifier it is. */
export interface TernKey {
	key: string;
	code?: string;
	modifier?: TernModifier;
}

const MODIFIERS: Record<string, TernModifier> = {
	Shift: "shift",
	ShiftLeft: "shift",
	ShiftRight: "shift",
	Control: "ctrl",
	ControlLeft: "ctrl",
	ControlRight: "ctrl",
	Alt: "alt",
	AltLeft: "alt",
	AltRight: "alt",
	Meta: "meta",
	MetaLeft: "meta",
	MetaRight: "meta",
};

/** DOM key values of the named keys that differ from their Puppeteer names. */
const NAMED: Record<string, TernKey> = {
	"\r": { key: "Enter", code: "Enter" },
	"\n": { key: "Enter", code: "Enter" },
	"\t": { key: "Tab", code: "Tab" },
	" ": { key: " ", code: "Space" },
	Space: { key: " ", code: "Space" },
	NumpadEnter: { key: "Enter", code: "NumpadEnter" },
	NumpadAdd: { key: "+", code: "NumpadAdd" },
	NumpadSubtract: { key: "-", code: "NumpadSubtract" },
	NumpadMultiply: { key: "*", code: "NumpadMultiply" },
	NumpadDivide: { key: "/", code: "NumpadDivide" },
	NumpadDecimal: { key: ".", code: "NumpadDecimal" },
};

/** Named DOM keys omp passes through unchanged. */
const PASS_THROUGH_KEYS =
	/^(?:Enter|Tab|Backspace|Delete|Escape|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Insert|CapsLock|ContextMenu|F(?:[1-9]|1\d|2[0-4]))$/;

/** Resolve one Puppeteer key name. Throws a ToolError for names Tern cannot type. */
export function ternKey(name: string): TernKey {
	if (typeof name !== "string" || name.length === 0) throw new ToolError("Key name must be a non-empty string");
	const modifier = MODIFIERS[name];
	if (modifier) {
		const base = name.replace(/(?:Left|Right)$/, "");
		return { key: base, code: name === base ? `${base}Left` : name, modifier };
	}
	const named = NAMED[name];
	if (named) return named;
	if (PASS_THROUGH_KEYS.test(name)) return { key: name, code: name };
	const letter = /^Key([A-Z])$/.exec(name);
	if (letter) return { key: letter[1]!.toLowerCase(), code: name };
	const digit = /^(Digit|Numpad)(\d)$/.exec(name);
	if (digit) return { key: digit[2]!, code: name };
	if ([...name].length === 1) {
		const code = /^[a-z]$/i.test(name) ? `Key${name.toUpperCase()}` : /^\d$/.test(name) ? `Digit${name}` : undefined;
		return code ? { key: name, code } : { key: name };
	}
	throw new ToolError(`Unknown key ${JSON.stringify(name)} for the Tern browser backend`);
}

/**
 * Split `Control+Shift+a` into its keys; a lone `+` (or a name without `+`)
 * is one key.
 */
export function splitKeyCombo(combo: string): string[] {
	if (combo.length <= 1 || !combo.includes("+")) return [combo];
	const parts = combo.split("+");
	if (parts.at(-1) === "") {
		parts.pop();
		parts[parts.length - 1] = "+";
	}
	return parts.filter(part => part.length > 0);
}

/** The key value a press produces with `mods` held (Shift upper-cases letters). */
function effectiveKey(key: TernKey, mods: readonly TernModifier[]): string {
	return mods.includes("shift") && /^[a-z]$/.test(key.key) ? key.key.toUpperCase() : key.key;
}

/** Key-down step for `key` with `mods` held. */
export function keyDownStep(key: TernKey, mods: readonly TernModifier[]): TernInputStep {
	const value = effectiveKey(key, mods);
	return { type: "key", action: "down", key: value, ...(key.code ? { code: key.code } : {}), mods: [...mods] };
}

/** Key-up step for `key` with `mods` held. */
export function keyUpStep(key: TernKey, mods: readonly TernModifier[]): TernInputStep {
	const value = effectiveKey(key, mods);
	return { type: "key", action: "up", key: value, ...(key.code ? { code: key.code } : {}), mods: [...mods] };
}

/**
 * Steps pressing `combo` (`Enter`, `a`, `Control+a`) with `held` modifiers
 * already down: modifiers of the combo go down first and up last.
 */
export function pressSteps(combo: string, held: readonly TernModifier[]): TernInputStep[] {
	const keys = splitKeyCombo(combo).map(ternKey);
	const mods = [...held];
	const steps: TernInputStep[] = [];
	for (const key of keys) {
		steps.push(keyDownStep(key, mods));
		if (key.modifier && !mods.includes(key.modifier)) mods.push(key.modifier);
	}
	for (let index = keys.length - 1; index >= 0; index--) {
		const key = keys[index]!;
		if (key.modifier) {
			const at = mods.indexOf(key.modifier);
			if (at >= 0 && !held.includes(key.modifier)) mods.splice(at, 1);
		}
		steps.push(keyUpStep(key, mods));
	}
	return steps;
}

/**
 * Steps typing `text` like a keyboard: printable ASCII and Enter/Tab as key
 * presses (so key handlers see them), anything else as inserted text.
 */
export function typeSteps(text: string, held: readonly TernModifier[]): TernInputStep[] {
	const steps: TernInputStep[] = [];
	for (const character of text) {
		if (character === "\n" || character === "\r" || character === "\t" || /^[\x20-\x7e]$/.test(character)) {
			steps.push(...pressSteps(character, held));
		} else {
			steps.push({ type: "text", text: character });
		}
	}
	return steps;
}
