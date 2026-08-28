/**
 * Fase 0 view: the raw protocol, unmediated.
 *
 * Kept in the shipped app rather than thrown away with the spike, because when
 * the transcript looks wrong the first question is always whether the frames
 * were wrong or the rendering was. Reachable at `#/probe`.
 */

import { useState } from "react";
import { useBridge } from "../rpc/useBridge";

export function ProbeRoute() {
	const { bridge, snapshot } = useBridge("probe");
	const [filter, setFilter] = useState("");

	const frames = filter ? snapshot.events.filter(event => event.type.includes(filter)) : snapshot.events;

	return (
		<div className="omp-probe">
			<div className="omp-probe__meta">
				<div>
					status <strong>{snapshot.status}</strong>
					{snapshot.pid ? ` · pid ${snapshot.pid}` : ""}
					{snapshot.prewarmed ? " · adopted a pre-warmed process" : ""}
				</div>
				{snapshot.ready ? (
					<div>
						protocol v{snapshot.ready.protocolVersion} · supported{" "}
						{JSON.stringify(snapshot.ready.supportedProtocolVersions)} · maxFrame {snapshot.ready.maxFrameBytes} ·
						maxReassembled {snapshot.ready.maxReassembledFrameBytes}
					</div>
				) : null}
				<div>
					{snapshot.events.length} frames · {snapshot.commands.length} slash commands
				</div>

				<div style={{ display: "flex", gap: 8, marginTop: 8 }}>
					<input
						className="omp-input"
						placeholder="filter by event type…"
						value={filter}
						onChange={event => setFilter(event.target.value)}
					/>
					<button
						type="button"
						data-component="button"
						data-size="normal"
						data-variant="primary"
						onClick={() => void bridge.prompt("Say the single word: pong").catch(() => {})}
					>
						ping
					</button>
					<button
						type="button"
						data-component="button"
						data-size="normal"
						data-variant="ghost"
						onClick={() => void bridge.getState().catch(() => {})}
					>
						get_state
					</button>
				</div>
			</div>

			{snapshot.stderr.length > 0 ? (
				<pre style={{ color: "var(--icon-critical-base)" }}>{snapshot.stderr.join("\n")}</pre>
			) : null}

			<pre>{frames.map(frame => JSON.stringify(frame)).join("\n")}</pre>
		</div>
	);
}
