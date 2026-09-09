//! Focused provider CONTROL contract proof.

use omp_py::{Engine, pyo3::ffi::c_str};

#[test]
fn provider_control_contract() {
	let engine = Engine::builder().init().expect("embedded Python boots");
	engine
		.attach(|py| {
			py.run(
				c_str!(
					r#"
import asyncio
import importlib

import omp
provider_module = importlib.import_module("omp.provider")
from omp._registry import freeze_declarations

route = omp.RouteSpec(
    "primary",
    "local://contract-provider",
    omp.Api.LOCAL,
    transport=omp.Transport.LOCAL,
)
image_model = omp.ModelSpec(
    "image-v1",
    "Image v1",
    ("primary",),
    operations=frozenset({omp.Operation.GENERATE_IMAGE}),
)
spec = omp.ProviderSpec(
    "dev.contract.provider",
    "Contract Provider",
    (route,),
    models=(image_model,),
)
handle = omp.provider(spec)

@handle
class ProviderCallbacks:
    @omp.hook("models_discover")
    async def discover(self, query):
        return {"provider": query["provider"]}

snapshot = freeze_declarations()
provider_rows = provider_module._sealed_provider_declarations()
assert provider_rows[0]["id"] == spec.id
assert provider_rows[0]["activation"] == "eager-prompt"
assert provider_rows[0]["callbacks"][0]["when"]["provider"] == [spec.id]
assert snapshot.providers

class Backend:
    def __init__(self):
        self.calls = []
        self.effects = []

    def intent_effect(self, operation, arguments):
        self.effects.append((operation, arguments))

    async def request(self, operation, arguments):
        self.calls.append((operation, arguments))
        if operation == "omp.provider.models":
            return [{
                "id": "dev.contract.provider/image-v1",
                "provider": "dev.contract.provider",
                "model": "image-v1",
                "name": "Image v1",
                "facets": ["image_gen"],
                "outputs": ["image"],
            }]
        if operation == "omp.provider.is_authenticated":
            return True
        if operation == "omp.provider.request":
            return {
                "images": [{"hash": "00" * 32, "size": 3}],
                "cost_nanos_usd": 17,
            }
        if operation in {"omp.provider.replace", "omp.provider.retract"}:
            return None
        raise AssertionError(operation)

async def exercise():
    backend = Backend()
    token = omp._control_backend.set(backend)
    try:
        cards = await handle.models()
        assert cards[0].facets == frozenset({omp.Facet.IMAGE_GEN})
        assert await handle.is_authenticated()
        result = await handle.request(
            omp.Operation.GENERATE_IMAGE,
            omp.ImageRequest(
                "draw a circle",
                omp.Dimensions(32, 32),
                omp.ImageFormat.PNG,
            ),
        )
        assert isinstance(result, omp.ImageResult)
        assert result.images[0] == omp.BlobRef(bytes(32), 3)
        await handle.replace(spec)
    finally:
        omp._control_backend.reset(token)

asyncio.run(exercise())
callback_name = provider_rows[0]["callbacks"][0]["name"]
assert asyncio.run(
    provider_module.dispatch_provider_callback(
        spec.id, callback_name, {"provider": spec.id}
    )
) == {"provider": spec.id}
"#
				),
				None,
				None,
			)
		})
		.expect("provider contracts hold");
}
