import * as ffi from "bun:ffi";
import { spyOn } from "bun:test";

/** Controls the fake `SetConsoleTitleW`/`GetConsoleTitleW` pair installed for a test. */
export interface WindowsConsoleTitleMock {
	/** Titles successfully passed to `SetConsoleTitleW`, oldest first. */
	readonly titles: string[];
	/** The live console title; assign it to simulate another process retitling the console. */
	current: string;
	succeeds: boolean;
	restore(): void;
}

function readWideTitle(pointer: ffi.Pointer): string {
	let title = "";
	for (let offset = 0; ; offset += Uint16Array.BYTES_PER_ELEMENT) {
		const unit = ffi.read.u16(pointer, offset);
		if (unit === 0) return title;
		title += String.fromCharCode(unit);
	}
}

function bindSymbol(symbols: object, name: string, callback: ffi.JSCallback): void {
	const definition: unknown = Reflect.get(symbols, name);
	if (!definition || typeof definition !== "object") throw new Error(`${name} binding missing`);
	Reflect.set(definition, "ptr", callback.ptr);
}

/** Installs a type-safe `kernel32.dll` FFI double until {@link WindowsConsoleTitleMock.restore} runs. */
export function mockWindowsConsoleTitle(): WindowsConsoleTitleMock {
	const callbacks: ffi.JSCallback[] = [];
	const mock: WindowsConsoleTitleMock = {
		titles: [],
		current: "",
		succeeds: false,
		restore() {
			dlopenSpy.mockRestore();
			for (const callback of callbacks) callback.close();
		},
	};
	const dlopenSpy = spyOn(ffi, "dlopen").mockImplementation((_name, symbols) => {
		const set = new ffi.JSCallback(
			(pointer: ffi.Pointer) => {
				if (!mock.succeeds) return false;
				mock.current = readWideTitle(pointer);
				mock.titles.push(mock.current);
				return true;
			},
			{ args: [ffi.FFIType.ptr], returns: ffi.FFIType.bool },
		);
		// Mirrors kernel32: copies at most `size - 1` units plus a NUL, returns
		// the copied length, and 0 for an empty title.
		const get = new ffi.JSCallback(
			(pointer: ffi.Pointer, size: number) => {
				const length = Math.min(mock.current.length, size - 1);
				const target = new Uint16Array(ffi.toArrayBuffer(pointer, 0, size * Uint16Array.BYTES_PER_ELEMENT));
				for (let i = 0; i < length; i++) target[i] = mock.current.charCodeAt(i);
				target[length] = 0;
				return length;
			},
			{ args: [ffi.FFIType.ptr, ffi.FFIType.u32], returns: ffi.FFIType.u32 },
		);
		callbacks.push(set, get);
		bindSymbol(symbols, "SetConsoleTitleW", set);
		bindSymbol(symbols, "GetConsoleTitleW", get);
		return ffi.linkSymbols(symbols);
	});
	return mock;
}
