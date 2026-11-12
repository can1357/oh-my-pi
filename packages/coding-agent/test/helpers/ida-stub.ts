import * as path from "node:path";

/** Permissive stand-ins for idalib's modules so `worker.py` runs its real protocol loop without IDA. */
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
        pass
`;

/** Write the stub modules into `stubsDir`; put it on the worker's `PYTHONPATH`. */
export async function writeIdaStubs(stubsDir: string): Promise<void> {
	await Bun.write(path.join(stubsDir, "_omp_ida_stub.py"), STUB);
	for (const name of STUB_MODULES) await Bun.write(path.join(stubsDir, `${name}.py`), STUB_MODULE);
	await Bun.write(path.join(stubsDir, "ida_domain", "__init__.py"), STUB_DATABASE);
	await Bun.write(path.join(stubsDir, "ida_domain", "database.py"), STUB_MODULE);
	await Bun.write(path.join(stubsDir, "ida_domain", "xrefs.py"), STUB_MODULE);
}
