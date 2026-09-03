import * as ffi from "bun:ffi";
import { spyOn } from "bun:test";

/** Controls the fake `SetConsoleTitleW` implementation installed for a test. */
export interface WindowsConsoleTitleMock {
	readonly titles: string[];
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

/** Installs a type-safe `kernel32.dll` FFI double until {@link WindowsConsoleTitleMock.restore} runs. */
export function mockWindowsConsoleTitle(): WindowsConsoleTitleMock {
	let callback: ffi.JSCallback | undefined;
	const mock: WindowsConsoleTitleMock = {
		titles: [],
		succeeds: false,
		restore() {
			dlopenSpy.mockRestore();
			callback?.close();
		},
	};
	const dlopenSpy = spyOn(ffi, "dlopen").mockImplementation((_name, symbols) => {
		callback = new ffi.JSCallback(
			(pointer: ffi.Pointer) => {
				if (!mock.succeeds) return false;
				mock.titles.push(readWideTitle(pointer));
				return true;
			},
			{ args: [ffi.FFIType.ptr], returns: ffi.FFIType.bool },
		);
		const definition: unknown = Reflect.get(symbols, "SetConsoleTitleW");
		if (!definition || typeof definition !== "object") throw new Error("SetConsoleTitleW binding missing");
		Reflect.set(definition, "ptr", callback.ptr);
		return ffi.linkSymbols(symbols);
	});
	return mock;
}
