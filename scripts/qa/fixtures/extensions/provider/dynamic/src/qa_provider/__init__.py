import omp

from ._qa_params import PARAMS

SPEC = omp.ProviderSpec(
    id="qa-dynamic",
    name="QA Dynamic",
    routes=(omp.RouteSpec(
        id="openai",
        base_url=f'http://127.0.0.1:{PARAMS["port"]}/v1',
        api=omp.Api.OPENAI_CHAT,
        trust=omp.TrustDomain.loopback(),
    ),),
    models=(omp.ModelSpec(
        id="mock-chat",
        display_name="Dynamic Mock Chat",
        routes=("openai",),
        context_window=128000,
        max_output_tokens=8192,
    ),),
)

@omp.provider(SPEC)
class DynamicProvider:
    pass
