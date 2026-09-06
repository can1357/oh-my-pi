# Live activity events

Interactive extensions can observe the semantic state of OMP's built-in `/live` session through the shared extension event bus. The event is intended for local presence indicators, accessibility surfaces, and other displays that do not need audio or transcript content.

## Subscribe

```ts
import {
  isLiveActivityEvent,
  LIVE_ACTIVITY_EVENT_CHANNEL,
  type ExtensionAPI,
} from "@oh-my-pi/pi-coding-agent";

export default function liveIndicator(pi: ExtensionAPI): void {
  const unsubscribe = pi.events.on(LIVE_ACTIVITY_EVENT_CHANNEL, value => {
    if (!isLiveActivityEvent(value)) return;
    renderVoiceState(value.phase, value.inputLevel, value.outputLevel);
  });

  pi.on("session_shutdown", unsubscribe);
}
```

`LIVE_ACTIVITY_EVENT_CHANNEL` is `live:activity`. The payload implements `LiveActivityEvent`:

| Field | Type | Meaning |
|---|---|---|
| `phase` | `"inactive" \| "connecting" \| "listening" \| "working" \| "speaking" \| "muted" \| "error"` | Current semantic state of the live session. |
| `inputLevel` | `number` | Normalized microphone RMS level in the inclusive range `0..1`. |
| `outputLevel` | `number` | Normalized speaker RMS level in the inclusive range `0..1`. |

## Delivery semantics

- Session start publishes `connecting`.
- Phase changes publish immediately.
- Level changes are coalesced onto the live visualizer's 80 ms animation cadence; consumers must not expect one event per audio frame.
- Unchanged snapshots are suppressed.
- Delivery is serialized independently per observer. While a handler is busy, intermediate snapshots are replaced by one latest pending snapshot, preventing concurrent callbacks and stale backlogs.
- Session teardown publishes `inactive` with both levels set to zero.
- Delivery is local and best-effort through `ExtensionAPI.events`; consumers should render the latest event rather than treating the stream as an audit log.

## Privacy and failure isolation

The payload contains scalar RMS levels only. It never includes audio samples, transcripts, session identifiers, or user identifiers. Event handlers run through the shared `EventBus` error boundary, so an observer failure cannot interrupt the live audio path.
