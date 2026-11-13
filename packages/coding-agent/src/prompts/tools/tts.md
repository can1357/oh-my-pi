Generate a speech audio file from text and write it to output_path.

Models are selected through the speech role and its fallback chain:
- local-inference: on-device neural TTS (Kokoro-82M via the bundled ONNX runtime)
  - no network; always WAV/PCM16
  - voice set by tts.localVoice — {{localVoices}}
- xai-tts: xAI Grok Voice; MP3 or WAV
  - built-in voices: {{xaiVoices}}; custom voice IDs accepted
- openai-speech: the selected model's compatible cloud endpoint; MP3 or WAV
  - voice_id is forwarded when set; otherwise the model's configured default voice, if any

Ordering and output:
- MP3 request: unconfigured cloud candidates are tried before unconfigured local candidates; explicitly configured speech candidates keep their order.
- Chain reaches local for a non-WAV path → output is written to the sibling .wav file.
- Cloud codec is inferred from the output_path suffix; a model that returns only the other codec (e.g. WAV-only) writes the sibling file with that extension.
- Max {{maxLength}} characters.
