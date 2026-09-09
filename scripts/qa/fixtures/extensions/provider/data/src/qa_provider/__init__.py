import importlib
import json
import omp

from ._qa_params import PARAMS

p = importlib.import_module("omp.provider")
ROUTE = p.RouteSpec(
    "openai", f'http://127.0.0.1:{PARAMS["port"]}/v1', p.Api.OPENAI_CHAT,
    trust=p.TrustDomain.loopback(),
)
SPEC = p.ProviderSpec(
    "qa-data", "QA Data", (ROUTE,),
    models=(p.ModelSpec("mock-chat", "Mock Chat", ("openai",),
                        context_window=128000, max_output_tokens=8192),),
)
HANDLE = p.ProviderHandle(SPEC)

@omp.tool(kind="hard")
async def hello() -> dict:
    oauth = p.OAuthSpec(
        "client", "https://login.example/token",
        p.OAuthFlow.pkce("https://login.example/auth", "http://127.0.0.1/callback"),
        scopes=("model.read",),
        placement=p.TokenPlacement.header("authorization", "Bearer "),
        principal=p.PrincipalResolution.id_token_claim("sub"),
    )
    auth = p.AuthSpec(
        p.AuthMode.OAUTH, sources=(p.CredentialSource.oauth(),), oauth=oauth,
        account_scope=p.AccountScope.PROVIDER,
    )
    discovery = p.DiscoverySpec(
        p.DiscoveryKind.OPENAI_MODELS, "/models", "models",
        pagination=p.Pagination.cursor("after"),
    )
    compat = p.CompatFlags(
        p.ToolSchemaFlavor.JSON_SCHEMA,
        p.StreamWatchdog(omp.Duration("2s"), omp.Duration("5s")),
    )
    rich_route = p.RouteSpec(
        "rich", "https://api.example/v1", p.Api.OPENAI_CHAT,
        auth=auth, discovery=discovery, compat=compat,
        limits=p.RouteLimits(max_context_tokens=32000),
        codec_profile=p.CodecProfile.STANDARD,
    )

    chat = p.ChatCaps(
        roles=frozenset({p.Role.SYSTEM, p.Role.USER, p.Role.ASSISTANT}),
        tools=p.ToolCaps(frozenset({p.ToolFeature.STRICT_SCHEMA}), 32),
        reasoning=p.ReasoningCaps(frozenset({"visible"}), (p.Effort.LOW, p.Effort.HIGH)),
        prompt_caching=p.PromptCacheCaps(frozenset({p.CacheRetention.SESSION}), 256, 4),
        hosted_tools=frozenset({p.HostedTool.WEB_SEARCH}),
        service_tiers=(p.ServiceTier("priority", 10),),
        server_state=p.ServerStateCaps(True, True, False),
        logprobs=p.LogprobCaps(5, False),
    )
    thinking = p.ThinkingSpec(
        p.ThinkingMode.EFFORT, (p.Effort.LOW, p.Effort.HIGH), p.Effort.HIGH,
    )
    context = p.ContextSpec.prefix_cache(
        retention=frozenset({p.CacheRetention.SESSION}),
        min_prefix_tokens=256,
        max_breakpoints=4,
    )
    cost = p.Cost(input="1.25", output="2.50")
    tier = p.CostTier(100000, p.Cost(input="0.75"))
    defaults = p.DiscoveryDefaults(("rich",), cost=p.Cost(tiers=(tier,)))
    model = p.ModelSpec(
        "rich-chat", "Rich Chat", ("rich",), chat=chat, thinking=thinking,
        context=context, cost=cost, input_modalities=frozenset({p.Modality.TEXT}),
    )
    declaration = p.ProviderSpec(
        "representative", "Representative", (rich_route,), (model,),
        p.ManagementSpec(frozenset({p.Operation.AUTH, p.Operation.USAGE}), True, True, True),
        defaults,
    )

    size = p.Dimensions(1024, 1024)
    image_caps = p.ImageCaps(
        frozenset({p.ImageFeature.GENERATE}), (size,), frozenset({p.ImageFormat.PNG}), 1,
    )
    image_request = p.ImageRequest("circle", size, p.ImageFormat.PNG, 2)
    blob = omp.BlobRef(bytes(32), 3)
    image_result = p.ImageResult((blob,), 17)
    speech_caps = p.SpeechCaps(
        frozenset({p.SpeechFeature.STREAMING}), ("alloy",),
        frozenset({p.AudioFormat.MP3}), (24000,),
    )
    transcription_caps = p.TranscriptionCaps(
        frozenset({p.TranscriptionFeature.LANGUAGE_HINT}),
        frozenset({p.AudioFormat.MP3}), omp.Duration("1h"),
    )
    speech_request = p.SpeechRequest("voice", "hello", "alloy", p.AudioFormat.MP3)
    speech_result = p.SpeechResult(blob, p.AudioFormat.MP3, 19)
    transcription_request = p.TranscriptionRequest("scribe", blob, "en")
    transcription_result = p.TranscriptionResult("hello", "en", 23)

    realtime_caps = p.RealtimeCaps(
        frozenset({p.RealtimeFeature.AUDIO_IN, p.RealtimeFeature.TEXT}),
        ("alloy",), frozenset({p.Transport.WEBRTC}),
    )
    detection = p.TurnDetection(
        p.RealtimeTurnDetectionMode.SEMANTIC_VAD,
        eagerness=p.RealtimeEagerness.HIGH,
    )
    realtime_request = p.RealtimeRequest(
        modalities=(p.RealtimeModality.TEXT, p.RealtimeModality.AUDIO),
        input_audio=p.Setting.require(p.AudioFormat.PCM16),
        turn_detection=p.Setting.prefer(detection),
        negotiation=p.NegotiationPolicy(
            p.EmulationPolicy.ALLOW_LOSSLESS,
            p.UnknownCapabilityPolicy.ALLOW_PREFERENCES,
            p.MismatchPolicy.DROP_PREFERRED,
        ),
    )
    realtime_session = p.RealtimeSession(
        "session", p.RealtimeEndpointRef("endpoint"),
        p.RealtimeCredentialRef("credential"), 2000000000000, p.Transport.WEBRTC,
    )

    card = p.ModelCard(
        "qa-data/mock-chat", "qa-data", "mock-chat", "Mock Chat",
        facets=frozenset({p.Facet.CHAT}),
        pricing=(p.Price(p.PriceUnit.MTOK_INPUT, 1000),),
        availability=p.Availability.AVAILABLE,
    )
    cursor = p.Cursor(b"epoch", 1)
    event = p.ModelEvent(cursor, upserted=card)
    watch = p.watch_models(cursor)

    intent = p.Intent(p.IntentKind.SERVICE_TIER, p.Fallback.ERROR, 7, "priority")
    assert p.intents.declared("qa-provider") == ()
    try:
        p.intents.set("", intent)
    except p.SpecError:
        pass
    else:
        raise AssertionError("empty intent keys must be rejected")
    error = p.ProviderError(
        "qa-data", "openai", "mock-chat", p.Operation.CHAT,
        p.ErrorKind.RATE_LIMITED, p.Retryability.AFTER_DELAY, 429,
        omp.Duration("1s"), 1, False, "limited", None,
    )
    failover = p.Failover.switch_model("qa-data/mock-chat")
    search = p.SearchPage((p.SearchResult("OMP", "https://example.test", "result", 1),), 1)
    usage = p.UsageReport((p.UsageWindow("daily", 1, 10, unit=p.UsageUnit.REQUESTS),), plan="qa")
    discovery_page = p.DiscoveryPage((model,), "next", True)
    request_draft = p.RequestDraft(
        "qa-data", "openai", "mock-chat", p.Operation.CHAT,
        {"temperature": 0}, {}, (intent,), 1, 12,
    )
    mutation = p.RequestMutation({"service_tier": "priority"}, {"x-qa": "1"})
    overlay = p.ModelOverlay(
        p.ModelRef("qa-data", "openai", "mock-chat"),
        patch=p.ModelPatch(display_name="Patched"),
    )
    alias = p.ScopedAlias(
        "qa-data", p.CatalogAlias("fast", "mock-chat", "qa", "extension"),
    )

    assert HANDLE.id == "qa-data" and isinstance(HANDLE, p.ProviderHandle)
    assert declaration.routes[0].auth.oauth.client_id == "client"
    assert model.chat.tools.maximum_tools == 32 and model.context.mode == "prefix_cache"
    assert image_caps.sizes == (size,) and image_request.count == 2
    assert image_result.images[0] == blob and image_result.cost_nanos_usd == 17
    assert speech_caps.voices == ("alloy",) and speech_result.audio == blob
    assert transcription_caps.max_duration == omp.Duration("1h")
    assert transcription_request.audio == blob and transcription_result.language == "en"
    assert realtime_caps.transports == frozenset({p.Transport.WEBRTC})
    assert realtime_request.input_audio.kind is p.SettingKind.REQUIRE
    assert realtime_session.endpoint.id == "endpoint"
    assert event.upserted is card and watch.since is cursor
    assert error.kind is p.ErrorKind.RATE_LIMITED
    assert failover.kind is p.FailoverKind.SWITCH_MODEL
    assert search.results[0].rank == 1 and usage.windows[0].limit == 10
    assert discovery_page.authoritative and request_draft.intents == (intent,)
    assert mutation.body["service_tier"] == "priority"
    assert overlay.patch.display_name == "Patched" and alias.definition.alias == "fast"
    assert speech_request.voice == "alloy" and p.ModelFallback.DENY.value == "deny"

    report = {
        "declaration": declaration.id,
        "media": [image_result.cost_nanos_usd, speech_result.cost_nanos_usd,
                  transcription_result.cost_nanos_usd],
        "realtime": realtime_session.id,
        "intent": intent.kind.value,
    }
    return json.dumps(report)
