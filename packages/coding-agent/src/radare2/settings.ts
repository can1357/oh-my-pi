import { register } from "../config/registry";

/** Python override that imports r2pipe; blank provisions r2pipe in an omp-managed venv. */
export const cfgRadare2Python = register({
	id: "radare2.python",
	type: "string",
	default: "",
	ui: {
		tab: "tools",
		group: "radare2",
		label: "radare2 Python",
		description:
			"Python interpreter that can import r2pipe; empty uses a managed venv with r2pipe installed on first analysis",
	},
});

/** radare2 binary override; blank discovers radare2 on PATH. */
export const cfgRadare2R2Path = register({
	id: "radare2.r2Path",
	type: "string",
	default: "",
	ui: {
		tab: "tools",
		group: "radare2",
		label: "radare2 Binary",
		description:
			"Path to the radare2 executable (r2); empty uses radare2 on PATH. radare2 itself is never installed automatically",
	},
});
