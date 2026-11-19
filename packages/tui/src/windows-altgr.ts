/**
 * Recover AltGr text that Windows console hosts drop under the kitty keyboard protocol.
 *
 * The kitty encoder shipped in Windows Terminal / OpenConsole before
 * microsoft/terminal#20052 reports AltGr+key as Alt (or Ctrl+Alt) plus the
 * layout's *unmodified* base key, without the produced text: Hungarian
 * AltGr+F arrives as `CSI 102;3u` instead of `[`. The byte stream is then
 * indistinguishable from a real Alt+F shortcut, so the character is lost and
 * the chord fires `alt+f` bindings instead.
 *
 * Recovery reads two pieces of local state the bytes lack:
 *  - whether Right Alt (AltGr) is physically held, via `GetAsyncKeyState`;
 *  - what the active keyboard layout's AltGr layer produces for the base key,
 *    via `ToUnicodeEx`.
 *
 * Layouts without an AltGr layer (US, UK, ...) resolve to an empty table once and
 * short-circuit every later event. The per-layout table is built once and cached;
 * it is rebuilt only when the foreground window reports a different layout handle.
 *
 * Known limitation: AltGr keys that produce a dead key on the active layout have no
 * table entry (`ToUnicodeEx` reports them as pending composition, not text), so those
 * chords keep reaching Alt bindings.
 */
import { dlopen, FFIType, type Library, type Pointer, ptr } from "bun:ffi";
import { parseKittySequence } from "./keys";

const KITTY_MOD_SHIFT = 1;
const KITTY_MOD_ALT = 2;
const KITTY_MOD_CTRL = 4;
const KITTY_LOCK_MASK = 64 | 128;

const VK_SHIFT = 0x10;
const VK_CONTROL = 0x11;
const VK_MENU = 0x12;
const VK_LSHIFT = 0xa0;
const VK_LCONTROL = 0xa2;
const VK_RMENU = 0xa5;
const MAPVK_VK_TO_VSC = 0;
/** `ToUnicodeEx` flag: do not change the kernel keyboard state (keeps pending dead keys intact). */
const TOUNICODE_NO_STATE_CHANGE = 0x4;

const USER32_SYMBOLS = {
	GetForegroundWindow: { args: [], returns: FFIType.ptr },
	GetWindowThreadProcessId: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	GetKeyboardLayout: { args: [FFIType.u32], returns: FFIType.ptr },
	GetAsyncKeyState: { args: [FFIType.i32], returns: FFIType.i16 },
	MapVirtualKeyExW: { args: [FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.u32 },
	ToUnicodeEx: {
		args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.u32, FFIType.ptr],
		returns: FFIType.i32,
	},
} as const;

type User32 = Library<typeof USER32_SYMBOLS>;

/** AltGr layer of one keyboard layout: `"<baseCodepoint>:<shift 0|1>"` → produced text. */
type AltGrTable = Map<string, string>;
/** Keyboard layout handle (`HKL`) as `bun:ffi` surfaces pointer-sized values. */
export type KeyboardLayoutHandle = Pointer | bigint;

let user32: User32 | null | undefined;
let cachedLayout: { hkl: KeyboardLayoutHandle | null; table: AltGrTable } | undefined;

function getUser32(): User32 | null {
	if (user32 !== undefined) return user32;
	try {
		user32 = dlopen("user32.dll", USER32_SYMBOLS);
	} catch {
		user32 = null;
	}
	return user32;
}

function tableKey(baseCodepoint: number, shift: boolean): string {
	return `${baseCodepoint}:${shift ? 1 : 0}`;
}

function isPrintableText(text: string): boolean {
	for (const ch of text) {
		const cp = ch.codePointAt(0)!;
		if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) return false;
	}
	return text.length > 0;
}

/**
 * Enumerate the layout's AltGr layer. Keys are the lowercased unmodified character
 * of each virtual key — the same "base key" the kitty encoder reports.
 */
function buildAltGrTable(lib: User32, hkl: KeyboardLayoutHandle): AltGrTable {
	const table: AltGrTable = new Map();
	const keyState = new Uint8Array(256);
	const buffer = new Uint16Array(8);

	const translate = (vk: number, scan: number, modifiers: readonly number[]): string | undefined => {
		keyState.fill(0);
		for (const modifier of modifiers) keyState[modifier] = 0x80;
		const count = lib.symbols.ToUnicodeEx(
			vk,
			scan,
			// Fresh pointers per call: JSC may relocate small typed-array backing stores.
			ptr(keyState),
			ptr(buffer),
			buffer.length,
			TOUNICODE_NO_STATE_CHANGE,
			hkl,
		);
		// Negative = dead key; zero = no translation.
		if (count <= 0) return undefined;
		const text = String.fromCharCode(...buffer.subarray(0, count));
		return isPrintableText(text) ? text : undefined;
	};

	const altGr = [VK_CONTROL, VK_LCONTROL, VK_MENU, VK_RMENU];
	const altGrShift = [...altGr, VK_SHIFT, VK_LSHIFT];
	for (let vk = 0x20; vk <= 0xfe; vk++) {
		// Skip Windows/menu keys and the sided modifiers: they have no text layer.
		if ((vk >= 0x5b && vk <= 0x5f) || (vk >= VK_LSHIFT && vk <= VK_RMENU)) continue;
		const scan = lib.symbols.MapVirtualKeyExW(vk, MAPVK_VK_TO_VSC, hkl);
		if (scan === 0) continue;
		const base = translate(vk, scan, []);
		if (base === undefined) continue;
		const baseCodepoint = base.toLowerCase().codePointAt(0)!;
		for (const shift of [false, true]) {
			const key = tableKey(baseCodepoint, shift);
			if (table.has(key)) continue;
			const produced = translate(vk, scan, shift ? altGrShift : altGr);
			if (produced !== undefined) table.set(key, produced);
		}
	}
	return table;
}

function activeLayoutTable(lib: User32): AltGrTable {
	// The console process has no window of its own; the layout that produced the
	// keystroke belongs to the terminal window that currently holds focus.
	const hwnd = lib.symbols.GetForegroundWindow();
	const thread = hwnd ? lib.symbols.GetWindowThreadProcessId(hwnd, null) : 0;
	const hkl = lib.symbols.GetKeyboardLayout(thread);
	if (cachedLayout && cachedLayout.hkl === hkl) return cachedLayout.table;
	const table: AltGrTable = hkl ? buildAltGrTable(lib, hkl) : new Map();
	cachedLayout = { hkl, table };
	return table;
}

/**
 * AltGr layer of an explicit layout handle (`HKL`), keyed `"<baseCodepoint>:<shift 0|1>"`.
 * Test seam: lets a harness inspect a loaded layout without making it the active one.
 */
export function readAltGrLayer(hkl: KeyboardLayoutHandle): ReadonlyMap<string, string> {
	const lib = getUser32();
	return lib && hkl ? buildAltGrTable(lib, hkl) : new Map();
}

/** Local keyboard state the translator reads; injectable so tests need no live desktop. */
export interface AltGrHost {
	/** AltGr layer of the layout that produced the keystroke, keyed like {@link readAltGrLayer}. */
	activeLayer(): ReadonlyMap<string, string>;
	/** Whether Right Alt (AltGr) is held, or was within the last {@link RIGHT_ALT_LATCH_MS}. */
	isRightAltDown(): boolean;
}

const EMPTY_LAYER: ReadonlyMap<string, string> = new Map();

/**
 * How long an observed Right Alt press keeps counting as held. Key state is sampled
 * at processing time, and one stdin read can carry several queued AltGr repeats that
 * are dispatched synchronously after the key is released; the latch keeps that tail
 * typing text. Far shorter than any release-then-Left-Alt chord a person can press.
 */
export const RIGHT_ALT_LATCH_MS = 30;

/** Wrap a raw Right Alt probe so a press stays observed for {@link RIGHT_ALT_LATCH_MS}. */
export function createRightAltLatch(isDownNow: () => boolean, now: () => number): () => boolean {
	let lastSeenDown = Number.NEGATIVE_INFINITY;
	return () => {
		const at = now();
		if (isDownNow()) {
			lastSeenDown = at;
			return true;
		}
		return at - lastSeenDown <= RIGHT_ALT_LATCH_MS;
	};
}

const win32Host: AltGrHost = {
	activeLayer() {
		const lib = getUser32();
		return lib ? activeLayoutTable(lib) : EMPTY_LAYER;
	},
	isRightAltDown: createRightAltLatch(() => {
		const lib = getUser32();
		return lib !== null && (lib.symbols.GetAsyncKeyState(VK_RMENU) & 0x8000) !== 0;
	}, performance.now.bind(performance)),
};

/**
 * Translate a kitty CSI-u Alt/Ctrl+Alt chord into the text AltGr produced, or
 * `undefined` when the sequence is not an AltGr keystroke on the active layout.
 *
 * Only call this on native Windows ConPTY hosts with the kitty protocol active.
 */
export function translateWindowsAltGrSequence(data: string, host: AltGrHost = win32Host): string | undefined {
	if (!data.endsWith("u")) return undefined;
	const parsed = parseKittySequence(data);
	if (!parsed || parsed.eventType === 3) return undefined;
	const modifier = parsed.modifier & ~KITTY_LOCK_MASK;
	// AltGr surfaces as Alt (fake LeftCtrl filtered) or Ctrl+Alt, optionally with Shift.
	if ((modifier & KITTY_MOD_ALT) === 0) return undefined;
	if ((modifier & ~(KITTY_MOD_ALT | KITTY_MOD_CTRL | KITTY_MOD_SHIFT)) !== 0) return undefined;
	// Functional keys (kitty PUA range) and C0 controls never carry AltGr text.
	if (parsed.codepoint < 0x20 || (parsed.codepoint >= 0xe000 && parsed.codepoint <= 0xf8ff)) return undefined;

	try {
		// Layouts without an AltGr layer (US, UK, ...) stop here: Alt chords stay shortcuts.
		const layer = host.activeLayer();
		if (layer.size === 0) return undefined;
		// Table keys are lowercased base characters; normalize hosts that report uppercase.
		const base = String.fromCodePoint(parsed.codepoint).toLowerCase().codePointAt(0)!;
		const text = layer.get(tableKey(base, (modifier & KITTY_MOD_SHIFT) !== 0));
		if (text === undefined) return undefined;
		// Left Alt+key shares the exact bytes; only a held Right Alt means AltGr.
		return host.isRightAltDown() ? text : undefined;
	} catch {
		return undefined;
	}
}
