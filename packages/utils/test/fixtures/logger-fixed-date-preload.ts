const NativeDate = globalThis.Date;

function fixtureNow(): number {
	const value = process.env.OMP_LOGGER_TEST_NOW;
	if (!value) throw new Error("OMP_LOGGER_TEST_NOW is required");
	const parsed = NativeDate.parse(value);
	if (!Number.isFinite(parsed)) throw new Error(`invalid OMP_LOGGER_TEST_NOW: ${value}`);
	return parsed;
}

class FixedDate extends NativeDate {
	constructor(value?: string | number) {
		super(value === undefined ? fixtureNow() : value);
	}

	static override now(): number {
		return fixtureNow();
	}
}

globalThis.Date = FixedDate as DateConstructor;
