import * as path from "node:path";
import { $which } from "@oh-my-pi/pi-utils";
import type { WorkerRuntime } from "../../src/disasm/backend";

const STUB = `
class _Any:
    def __init__(self, *args, **kwargs):
        pass
    def __call__(self, *args, **kwargs):
        return _Any()
    def __getattr__(self, name):
        return _Any()
    def __iter__(self):
        return iter(())
    def __bool__(self):
        return False
    def hook(self):
        return True

def module_getattr(name):
    if name.startswith("__"):
        raise AttributeError(name)
    return type(name, (_Any,), {})
`;
const STUB_MODULE = "from _omp_ida_stub import _Any, module_getattr as __getattr__\n";
const STUB_MODULES = [
	"idapro",
	"ida_auto",
	"ida_bytes",
	"ida_funcs",
	"ida_hexrays",
	"ida_idaapi",
	"ida_idp",
	"ida_lines",
	"ida_loader",
	"ida_nalt",
	"ida_name",
	"ida_segment",
	"ida_typeinf",
	"ida_ua",
	"ida_xref",
	"idautils",
];
const STUB_DATABASE = `${STUB_MODULE}
class Database(_Any):
    module = "stub.bin"
    format = "stub"
    architecture = "metapc"
    bitness = 64

    @classmethod
    def open(cls, *args, **kwargs):
        return cls()

    def close(self, save=False):
        import os
        destination = os.environ.get("OMP_IDA_STUB_SAVE")
        if save and destination:
            with open(destination, "w") as output:
                output.write(str(getattr(self, "persisted", None)))
`;

/** Python fixture running the shipped IDA protocol without IDA; optional savePath observes persisted exec state. */
export async function createIdaWorkerRuntime(dir: string, options: { savePath?: string } = {}): Promise<WorkerRuntime> {
	const stubs = path.join(dir, "stubs");
	await Bun.write(path.join(stubs, "_omp_ida_stub.py"), STUB);
	for (const name of STUB_MODULES) await Bun.write(path.join(stubs, `${name}.py`), STUB_MODULE);
	await Bun.write(path.join(stubs, "ida_pro.py"), "IDA_SDK_VERSION = 950\n");
	await Bun.write(path.join(stubs, "ida_domain", "__init__.py"), STUB_DATABASE);
	await Bun.write(path.join(stubs, "ida_domain", "database.py"), STUB_MODULE);
	await Bun.write(path.join(stubs, "ida_domain", "xrefs.py"), STUB_MODULE);
	const env: Record<string, string> = {};
	for (const key in process.env) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	env.PYTHONPATH = stubs;
	env.PYTHONUNBUFFERED = "1";
	env.PYTHONIOENCODING = "utf-8";
	if (options.savePath) env.OMP_IDA_STUB_SAVE = options.savePath;
	return { pythonPath: Bun.env.PYTHON ?? ($which("python3") ? "python3" : "python"), env };
}
