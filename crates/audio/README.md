# omp-audio

`omp-audio` owns OMP's platform audio boundary: low-latency mono `f32` microphone capture, gapless queued speaker playback, metering, gain, drain/abort behavior, and arbitration between speech-to-text, text-to-speech, and live voice.

## Structure

- `audio.rs` exposes the target-independent capture and playback contract.
- `device.rs` selects the direct CoreAudio, WASAPI, or runtime-loaded PulseAudio/ALSA backend; unsupported targets fail with a typed availability error.
- `coordinator.rs` owns microphone exclusion, live-voice TTS suspension, and push-to-talk ducking through idempotent RAII leases.

## Philosophy

Audio mechanics and ownership policy live here, while `omp-app` supplies production vocalizer effects. The public contract stays mono floating-point audio at the caller's logical sample rate; platform backends own hardware conversion and never leak OS types upward. The crate deliberately contains no provider transport, model inference, or WebRTC live peer.
