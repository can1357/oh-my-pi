# Inference

Extension code reaches for inference when it needs a model result, a view of the model catalog, or a provider integration that the host can route safely. You issue ordinary model work through `omp.agents`; `omp.provider` describes providers, routes, capabilities, media requests, catalog updates, and cold-path callbacks.

A minimal model call is an awaited `omp.agents.completion()`:

```python
import omp


async def title_for(text: str) -> str:
    result = await omp.agents.completion(
        f"Write a short title for this text:\n\n{text}",
        role="smol",
        max_output_tokens=24,
    )
    return result.text
```

The returned completion is settled: its `text`, selected `model`, fallback status, and `usage` belong to the same completed request.

## Call a model from a device

A device that can spend inference must declare an inference effect envelope. Keep the envelope no larger than the body needs.

```python
import omp


@omp.device(
    "release_title",
    summary="Suggest a title for release notes",
    effects=omp.Effects(
        inference=omp.InferenceEffects(max_requests=1, max_usd=0.02)
    ),
)
async def release_title(notes: str) -> str:
    completion = await omp.agents.completion(
        f"Return one release title, with no punctuation:\n\n{notes}",
        role="smol",
        max_output_tokens=32,
        deadline=omp.Duration("8s"),
        labels={"feature": "release-title"},
    )
    return completion.text
```

`completion()` is the model-request entry point; `omp.provider` does not expose a raw chat or token stream. This separation keeps provider declarations from granting ambient authority to spend inference.

You may supply a plain string or a sequence of `TextPart` and `BlobPart` values. `choices` and `schema` are mutually exclusive. For a side-channel answer that can read the current conversation without appending to it, use `context="thread"`; in that mode the prompt must be text, the session model is fixed, and `role`, `system`, `choices`, `schema`, and `max_output_tokens` are unavailable.

See the [`omp.agents` reference](../reference/omp.agents.md) for the full completion contract and the [devices guide](devices.md) for effect authorization.

## Select models by role and capability

A stateless completion selects a model by `role`, such as the default `"smol"`. The host resolves that role against policy, availability, and the merged catalog. A thread-context completion instead uses the current session model.

Inspect the merged catalog before offering a capability-dependent action:

```python
from omp.provider import Facet, models


async def image_models() -> list[str]:
    cards = await models()
    return [card.id for card in cards if Facet.IMAGE_GEN in card.facets]
```

A [`ModelCard`](../reference/omp.provider.md#ompprovidermodelcard) reports its provider, facets, input and output modalities, reasoning support, effort ladder, token limits, price components, availability, provenance, and additional properties. Treat `ModelCard.id` as the resolved catalog identifier. The declarative [`ModelRef`](../reference/omp.provider.md#ompprovidermodelref) identifies a provider/API/model tuple in catalog structures; it is not an argument to `omp.agents.completion()`.

For capability negotiation within requests, contribute typed [`Intent`](../reference/omp.provider.md#ompproviderintent) values. A requirement should use an unsupported behavior that matches your failure needs; a preference permits host arbitration and adjustment.

```python
from omp.provider import Fallback, Intent, IntentKind, intents

intents.set(
    "structured-release-output",
    Intent(
        kind=IntentKind.STRICT,
        on_unsupported=Fallback.ERROR,
        priority=100,
    ),
)
```

Intent contributions are keyed. Calling `set()` replaces your contribution for that key, and `clear()` removes it. `declared()` intentionally does not speculate about host-accepted state and therefore returns an empty tuple.

## Consume catalog events

`watch_models()` is the streaming API in this module. It yields ordered changes to the merged model catalog; it does not stream generated tokens.

```python
from omp.provider import watch_models


async def print_catalog_changes() -> None:
    async for event in watch_models():
        if event.upserted is not None:
            print("upsert", event.upserted.id)
        elif event.removed_id is not None:
            print("remove", event.removed_id)
        else:
            print("reset")
```

Each event contains exactly one of `upserted`, `removed_id`, or `reset`, plus a `Cursor`. Save the most recently processed cursor if your consumer needs to resume within the host catalog epoch:

```python
from omp.provider import Cursor, watch_models


async def resume_catalog(cursor: Cursor) -> Cursor:
    latest = cursor
    async for event in watch_models(since=cursor):
        apply_model_event(event)
        latest = event.cursor
    return latest
```

The stream ends when the host closes it. A reset tells you to rebuild local derived state rather than treating the event as an individual removal.

## Register a provider

Most integrations are immutable data. Declare a `ProviderSpec` at import time, with one or more `RouteSpec` values and any bundled `ModelSpec` values:

```python
from omp.provider import (
    Api,
    AuthMode,
    AuthSpec,
    CredentialSource,
    ModelSpec,
    ProviderSpec,
    RouteSpec,
    provider,
)

ACME = ProviderSpec(
    id="acme",
    name="Acme Models",
    routes=(
        RouteSpec(
            id="chat",
            base_url="https://api.acme.example/v1",
            api=Api.OPENAI_CHAT,
            auth=AuthSpec(
                mode=AuthMode.BEARER,
                sources=(CredentialSource.env("ACME_API_KEY"),),
            ),
        ),
    ),
    models=(
        ModelSpec(
            id="acme-small",
            display_name="Acme Small",
            routes=("chat",),
        ),
    ),
)

acme = provider(ACME)
```

Use the returned `ProviderHandle` for host-owned lifecycle operations such as `await acme.models()`, `await acme.is_authenticated()`, `await acme.replace(new_spec)`, and `await acme.retract()`.

When static facts are insufficient, use the handle as a class decorator and register provider-scoped hooks on the implementation. The exposed callback payloads cover login, refresh, signing, pre-request mutation, model discovery, error recovery, usage projection, and search parsing. Keep request encoding and token processing out of Python.

```python
import omp
from omp.provider import DiscoveryPage, DiscoveryQuery, ProviderSpec


@omp.provider(ACME)
class AcmeProvider:
    @omp.hook("models_discover", provider="acme")
    async def discover(self, query: DiscoveryQuery) -> DiscoveryPage:
        return DiscoveryPage(models=())
```

> **Note** Calling `provider(ACME)` and then decorating a class with the same declaration would register it twice. Choose the data-only call or the decorator form.

### Providers are extensible; codecs and transports are selected

You can register provider data and cold-path callbacks. You cannot implement a new wire codec or transport in Python. `RouteSpec.api` must select a member of the closed [`Api`](../reference/omp.provider.md#ompproviderapi) enum, and `RouteSpec.transport` must select a member of [`Transport`](../reference/omp.provider.md#ompprovidertransport). For a local HTTP endpoint, pair a loopback URL with `TrustDomain.loopback()`; plaintext non-loopback routes are rejected.

This boundary still permits custom endpoints that speak a supported protocol. For a genuinely different wire protocol, run a separately governed bridge that exposes one of the supported route contracts rather than placing per-token translation in extension code.

## Route typed media operations

`ProviderHandle.request()` exposes the four frozen host-routed operations in this Python surface: image generation, speech synthesis, transcription, and realtime session establishment. The request type must match the `Operation` exactly.

```python
from omp.provider import Dimensions, ImageFormat, ImageRequest, Operation


async def make_cover(acme) -> tuple[object, ...]:
    result = await acme.request(
        Operation.GENERATE_IMAGE,
        ImageRequest(
            prompt="A geometric book cover in navy and cream",
            dimensions=Dimensions(1024, 1024),
            format=ImageFormat.PNG,
        ),
    )
    return result.images
```

Passing a chat, embedding, search, or other operation to this method raises `ValueError`; those operations use their owning high-level APIs.

## Account for usage

For model calls made by your extension, read the settled receipt on `Completion.usage`:

```python
result = await omp.agents.completion("Classify: ready", choices=("yes", "no"))
print(result.usage.input_tokens)
print(result.usage.output_tokens)
print(result.usage.requests)
print(result.usage.cost_usd)
print(result.usage.wall)
```

For a provider whose quota or billing window cannot be derived by the host, implement `provider_usage` and return a typed report:

```python
import omp
from omp.provider import UsageQuery, UsageReport, UsageUnit, UsageWindow


@omp.hook("provider_usage", provider="acme")
async def acme_usage(query: UsageQuery) -> UsageReport | None:
    payload = await fetch_acme_usage(query)
    if payload is None:
        return None
    return UsageReport(
        windows=(
            UsageWindow(
                id="monthly-tokens",
                used=payload.used,
                limit=payload.limit,
                resets_at_ms=payload.resets_at_ms,
                unit=UsageUnit.TOKENS,
            ),
        ),
        observed_at_ms=payload.observed_at_ms,
    )
```

`UsageQuery.api_key` is a callback-scoped `Secret` when the hook is allowed to call the provider. Do not log it or place it in provider CONTROL data. Use integer `nanos_usd` for exact provider price and balance values; one US dollar is 1,000,000,000 nano-USD.

## Next steps

- Use the exhaustive [`omp.provider` reference](../reference/omp.provider.md) when authoring route, model, callback, or media values.
- Read [agents and sessions](agents-and-sessions.md) for supervised and conversational inference.
- Read [regimes and policy](regimes-and-policy.md) before relying on paid or network effects.
- Read [hooks](hooks.md) for callback phases, filters, failure behavior, and composition.
