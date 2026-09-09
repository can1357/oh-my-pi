# omp-ai

`omp-ai` is OMP's typed public contract for model inference. It gives every supported operation—from chat and embeddings through media, realtime, discovery, usage, authentication, and allowlisted native wire access—a concrete request and output type over one closed Tower service envelope.

The crate keeps the public edge statically typed while the provider center is erased once at service construction. Calls are cheap to clone because operation payloads are shared, streams and sessions retain explicit ownership, errors are structured and secret-free, and receipts account for every attempt, recovery, usage dimension, and integer monetary unit. Provider identity and capability vocabulary come from `omp-catalog`; this crate does not infer policy from provider or model strings.

## Local TTS (Kokoro)

The optional local TTS backend runs Kokoro-82M text-to-speech inference on [candle](https://github.com/huggingface/candle), with Metal acceleration on macOS. Its model pipeline combines an ALBERT text encoder, duration and prosody predictors with bidirectional LSTMs, and an iSTFTNet vocoder. It performs pure inference without downloading models or accessing the network: callers provide checkpoint weights and voice embeddings as candle tensors. The implementation is derived from Kyle Kelley's MIT-licensed `voice-kokoro` crate and includes modifications by Stencil Labs; see [NOTICE](NOTICE) and the retained [license](src/local/tts/kokoro/LICENSE).
