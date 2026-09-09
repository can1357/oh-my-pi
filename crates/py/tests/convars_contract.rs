//! Focused embedded proof for Python dynamic convar declarations and
//! observation.

use omp_py::{Engine, pyo3::ffi::c_str};

#[test]
fn convars_contract() {
	let engine = Engine::builder().init().expect("embedded Python boots");
	engine
		.attach(|py| {
			py.run(
				c_str!(
					r#"
import asyncio

import omp


class ConvarBackend:
    def __init__(self):
        self.values = {"sv_test": ("bool", True, 0)}
        self.changes = asyncio.Queue()
        self.declarations = []

    async def request(self, operation, arguments):
        if operation == "omp.convars.declare":
            self.declarations.append(arguments)
            name = f"ext::dev.example.demo::{arguments['key']}"
            self.values[name] = (arguments["kind"], arguments["default"], 0)
            return {
                "name": name,
                "kind": arguments["kind"],
                "value": arguments["default"],
                "sequence": 0,
            }
        if operation == "omp.convars.get":
            kind, value, sequence = self.values[arguments["name"]]
            return {
                "name": arguments["name"],
                "kind": kind,
                "value": value,
                "sequence": sequence,
            }
        if operation == "omp.convars.observe":
            if arguments["after"] is None:
                kind, value, sequence = self.values[arguments["name"]]
            else:
                name, kind, value, sequence = await self.changes.get()
                assert name == arguments["name"]
            return {
                "name": arguments["name"],
                "kind": kind,
                "value": value,
                "sequence": sequence,
            }
        raise AssertionError(f"unexpected operation: {operation}")


async def exercise():
    backend = ConvarBackend()
    omp._install_control_backend(backend)

    declared = await omp.convars.declare(
        "enabled",
        kind="boolean",
        default=False,
        description="Enable demo behavior",
        ui={
            "tab": "tools",
            "group": "Extensions",
            "label": "Demo behavior",
            "description": "Enable the demo extension",
        },
    )
    assert backend.declarations[-1]["ui"] == {
        "tab": "tools",
        "group": "Extensions",
        "label": "Demo behavior",
        "description": "Enable the demo extension",
    }
    assert declared == omp.convars.Snapshot(
        "ext::dev.example.demo::enabled", "boolean", False, 0
    )

    harness = await omp.convars.get("sv_test")
    assert harness.value is True
    assert harness.kind == "bool"

    changes = omp.convars.observe("ext::dev.example.demo::enabled")
    current = await anext(changes)
    assert current.value is False
    await backend.changes.put(
        ("ext::dev.example.demo::enabled", "boolean", True, 1)
    )
    changed = await anext(changes)
    assert changed.value is True
    assert changed.sequence == 1

    try:
        await omp.convars.declare("mode", kind="enum", default="safe")
    except ValueError:
        pass
    else:
        raise AssertionError("enum declaration without values was accepted")


asyncio.run(exercise())
"#
				),
				None,
				None,
			)
		})
		.expect("Python convar contract holds");
}
