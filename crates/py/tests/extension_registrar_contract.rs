//! Director and Component declaration proof for the Python extension surface.

use omp_py::{Engine, pyo3::ffi::c_str};

#[test]
fn python_extensions_project_directors_and_components() {
	let engine = Engine::builder().init().expect("embedded Python boots");
	engine
		.attach(|py| {
			py.run(
				c_str!(
					r#"
import omp
from omp._registry import registry

registry.configure_manifest(
    extension="acme/registrar",
    trust_runtime_declarations=True,
)

@omp.director("continue-once", claims=("loop",), binds={"ai_fastmode": True})
class ContinueOnce:
    def on_yield(self, event):
        return "continue"

@omp.component("ext-state", interested=("turn.start@1", "patch@1"))
def ext_state(entry, dom):
    return (("set", "ext-state", "seen", True),)

registry.freeze()
from omp._registry import project_control_registry
payload = project_control_registry()
assert payload["directors"] == [{
    "binds": {"ai_fastmode": True},
    "callable": {"$omp.callable": "__main__.ContinueOnce"},
    "claims": ["loop"],
    "id": "continue-once",
    "trigger": "lazy",
}]
assert payload["components"] == [{
    "callable": {"$omp.callable": "__main__.ext_state"},
    "id": "ext-state",
    "interested": ["turn.start@1", "patch@1"],
    "trigger": "lazy",
}]
"#
				),
				None,
				None,
			)
		})
		.expect("Python extension registrar projection");
}
