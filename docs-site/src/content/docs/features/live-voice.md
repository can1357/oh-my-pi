---
title: Live Voice
description: Realtime spoken conversation with Codex through the `/live` command — mic capture, playback, barge-in, and streaming transcripts.
coverage: B
---

`/live` starts a realtime voice conversation with a Codex-backed model (`gpt-live-1-codex`) over a WebRTC audio call. You speak, the assistant answers out loud, and the conversation streams into the terminal as live transcripts. Spoken requests can be handed to your normal agent session, so the live model can call tools, run commands, and delegate to subagents while you keep talking.

## Starting live voice

Type `/live` in the input box, or press `Ctrl+L` (the `app.live.toggle` keybinding, which does the same thing). The editor is replaced by a live visualizer showing the call phase, audio levels, and the running transcript.

| Action | How |
| --- | --- |
| Start / stop | `/live` again, or press `Ctrl+L` again |
| Mute the microphone | Toggle mute from the visualizer |

:::note
Live voice requires a Codex provider credential. Without one, the session fails with `No Codex OAuth credential is available for a live call.` — sign in with the Codex provider first.
:::

## During a session

- **Mic capture.** Audio is captured from the microphone at 16 kHz and streamed to the call. The visualizer shows input and output levels.
- **Transcript stream.** User and assistant transcripts stream in as they are recognized and finalize when a turn completes.
- **Barge-in.** Speaking while the assistant is talking interrupts it: while output audio is active, quiet input is treated as echo and suppressed, but speech above the level of the current output is pushed through immediately.
- **Delegation.** When the live model decides it needs to do work in your repository, the request is sent to the agent session as a normal turn. The phase switches to `working` while the session runs tools and subagents, progress is streamed back to the call, and the final response is spoken.

The call phases shown in the visualizer are `connecting`, `listening`, `working`, `speaking`, `muted`, and `error`.

## Voice

The `live.voice` setting selects the assistant's voice (default: `sol`). Accepted values: `arbor`, `breeze`, `cove`, `ember`, `juniper`, `maple`, `sol`, `spruce`, `vale`.

## See also

- [Voice (STT/TTS)](/oh-my-pi/features/voice/) — local text-to-speech and the `stt.*`/`tts.*` settings
- [Slash Commands](/oh-my-pi/reference/slash-commands/) — `/live` and the other built-in commands
