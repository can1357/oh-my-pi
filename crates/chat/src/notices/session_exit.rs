//! Replay projection for the durable `<session-exit>` crash-tail record.
//!
//! Clean exits deliberately project no block. Abnormal exits show only the
//! already-redacted, bounded session payload; the actor never reopens raw logs
//! or tool output while rendering.

use std::fmt::Write as _;

use omp_core::{Str, StrMut, sf};
use omp_session::{CrashTail, ExitCause, ExitStatus, SessionExit};
use omp_tui::{IntoComponent as _, dom};

use crate::cards::Component;

/// Plain semantic transcript text for an abnormal exit. Clean exits return
/// `None`, keeping routine shutdown silent across TUI, render, and export.
#[must_use]
pub fn text(exit: &SessionExit) -> Option<Str> {
	if exit.status == ExitStatus::Clean {
		return None;
	}
	let mut output = StrMut::new("");
	let _ = write!(output, "Previous session ended {}", exit.status);
	write_cause(&mut output, &exit.cause);
	output.push('.');
	for item in &exit.crash_tail {
		output.push('\n');
		write_tail(&mut output, item);
	}
	if exit.crash_tail_omitted > 0 {
		let noun = if exit.crash_tail_omitted == 1 {
			"item"
		} else {
			"items"
		};
		let _ = write!(
			output,
			"\n… +{} more active {noun} omitted by the diagnostic bound.",
			exit.crash_tail_omitted
		);
	}
	Some(output.freeze())
}

/// Semantic warning card for one abnormal durable exit.
#[must_use]
pub fn block(exit: &SessionExit) -> Option<Component> {
	text(exit)?;
	let title = match exit.status {
		ExitStatus::Interrupted => Str::new_static("Session interrupted"),
		ExitStatus::Failed => Str::new_static("Session failed"),
		ExitStatus::Crashed => Str::new_static("Session crashed"),
		ExitStatus::Clean => return None,
	};
	let mut rows = exit.crash_tail.iter().map(tail_row).collect::<Vec<_>>();
	if exit.crash_tail_omitted > 0 {
		let omitted = sf!("… +{} more active items", exit.crash_tail_omitted);
		rows.push(dom! { <row pad-x=1><text fg=muted dim>{omitted}</text></row> }.into_component());
	}
	Some(
		dom! {
			<col pad-x=1>
				<row gap=1>
					<i:warning fg=warn/>
					<text fg=warn bold>{title}</text>
				</row>
				<text fg=muted wrap=word>{cause_text(&exit.cause)}</text>
				{rows}
			</col>
		}
		.into_component(),
	)
}

fn cause_text(cause: &ExitCause) -> Str {
	let mut output = StrMut::new("");
	write_cause(&mut output, cause);
	let text = output.freeze();
	if text.is_empty() {
		Str::new_static("The prior process did not complete normal teardown.")
	} else {
		text
	}
}

fn write_cause(output: &mut StrMut, cause: &ExitCause) {
	match cause {
		ExitCause::Normal => {},
		ExitCause::Signal { signal } => {
			let _ = write!(output, " after {}", signal.name);
		},
		ExitCause::Provider { provider, model, status, detail } => {
			output.push_str(" during provider inference");
			if let Some(provider) = provider {
				let _ = write!(output, " ({provider}");
				if let Some(model) = model {
					let _ = write!(output, "/{model}");
				}
				if let Some(status) = status {
					let _ = write!(output, ", HTTP {status}");
				}
				output.push(')');
			}
			if let Some(detail) = detail {
				let _ = write!(output, ": {detail}");
			}
		},
		ExitCause::Tool { name, call_id, detail } => {
			output.push_str(" during tool execution");
			if let Some(name) = name {
				let _ = write!(output, " ({name}");
				if let Some(call_id) = call_id {
					let _ = write!(output, " {call_id}");
				}
				output.push(')');
			}
			if let Some(detail) = detail {
				let _ = write!(output, ": {detail}");
			}
		},
		ExitCause::Worker { name, exit_code, signal, detail } => {
			output.push_str(" during worker execution");
			if let Some(name) = name {
				let _ = write!(output, " ({name})");
			}
			if let Some(code) = exit_code {
				let _ = write!(output, " with exit {code}");
			}
			if let Some(signal) = signal {
				let _ = write!(output, " after {}", signal.name);
			}
			if let Some(detail) = detail {
				let _ = write!(output, ": {detail}");
			}
		},
		ExitCause::Panic { detail } => {
			output.push_str(" after an internal panic");
			if let Some(detail) = detail {
				let _ = write!(output, ": {detail}");
			}
		},
		ExitCause::Unexpected { detail } => {
			output.push_str(" without completing its durable exit record");
			if let Some(detail) = detail {
				let _ = write!(output, ": {detail}");
			}
		},
		ExitCause::Process { exit_code, detail } => {
			output.push_str(" at the process boundary");
			if let Some(code) = exit_code {
				let _ = write!(output, " with exit {code}");
			}
			if let Some(detail) = detail {
				let _ = write!(output, ": {detail}");
			}
		},
	}
}

fn write_tail(output: &mut StrMut, item: &CrashTail) {
	match item {
		CrashTail::Provider { provider, model, route, started_at_ms } => {
			let _ = write!(
				output,
				"Provider stream {provider}/{model} via {route} started at {started_at_ms} without a \
				 terminal response."
			);
		},
		CrashTail::Tool { call_id, name, intent, argument, started_at_ms } => {
			let _ = write!(output, "Pending tool {name} {call_id}");
			if let Some(argument) = argument {
				let _ = write!(output, " (`{argument}`)");
			}
			if let Some(intent) = intent {
				let _ = write!(output, " — {intent}");
			}
			let _ = write!(output, " started at {started_at_ms}.");
		},
		CrashTail::Worker { id, class, name, owner, started } => {
			let _ = write!(output, "Running {class} worker {id}");
			if let Some(name) = name {
				let _ = write!(output, " ({name})");
			}
			if let Some(owner) = owner {
				let _ = write!(output, " owned by {owner}");
			}
			if let Some(started) = started {
				let _ = write!(output, " started at {started}");
			}
			output.push('.');
		},
	}
}

fn tail_row(item: &CrashTail) -> Component {
	let mut text = StrMut::new("");
	write_tail(&mut text, item);
	let text = text.freeze();
	let kind: &'static str = item.into();
	let badge = sf!("[{kind}]");
	dom! {
		<row gap=1>
			<text fg=muted dim>{badge}</text>
			<text fg=muted wrap=word>{text}</text>
		</row>
	}
	.into_component()
}

#[cfg(test)]
mod tests {
	use omp_session::ExitSignal;

	use super::*;

	#[test]
	fn clean_exit_has_no_projection() {
		let exit = SessionExit {
			status:             ExitStatus::Clean,
			cause:              ExitCause::Normal,
			recorded_at_ms:     1,
			crash_tail:         Vec::new(),
			crash_tail_omitted: 0,
		};
		assert_eq!(text(&exit), None);
		assert!(block(&exit).is_none());
	}

	#[test]
	fn signal_and_pending_tool_are_projected_with_identity() {
		let exit = SessionExit {
			status:             ExitStatus::Interrupted,
			cause:              ExitCause::Signal { signal: ExitSignal::new("SIGTERM", Some(15)) },
			recorded_at_ms:     1,
			crash_tail:         vec![CrashTail::Tool {
				call_id:       Str::new_static("call-7"),
				name:          Str::new_static("bash"),
				intent:        Some(Str::new_static("inspect logs")),
				argument:      Some(Str::new_static("journalctl -n 20")),
				started_at_ms: 7,
			}],
			crash_tail_omitted: 0,
		};
		let text = text(&exit).expect("abnormal projection");
		assert!(text.contains("SIGTERM"));
		assert!(text.contains("Pending tool bash call-7"));
		assert!(text.contains("journalctl -n 20"));
		assert!(block(&exit).is_some());
	}
}
