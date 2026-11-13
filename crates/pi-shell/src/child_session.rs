//! Which session and terminal a spawned child may hold.
//!
//! The embedded shell's spawner detaches every external into its own session
//! and process group (`crate::host::PiHost`): pi never runs a child that can
//! reach its controlling terminal. [`child_session_action`] states the policy
//! for a shell that does own a terminal (interactive job control), which
//! pi-natives' terminal code follows.

/// What to do with the child's controlling-tty/session ownership immediately
/// before spawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChildSessionAction {
	/// Call `setsid()` so the child cannot stop the parent through
	/// SIGTTIN/SIGTTOU on the inherited tty.
	DetachSession,
	/// Move the child to the foreground of its tty so it participates in
	/// interactive job control.
	TakeForeground,
	/// Leave session/foreground state alone.
	None,
}

/// Decide whether to detach the child's session, foreground it, or do
/// nothing.
///
/// A child whose stdin is **not** a terminal always detaches, even when it is
/// a stage of a multi-command pipeline: an interactive program in a pipeline
/// (`zsh -i ... | awk`) would otherwise open `/dev/tty`, `tcsetpgrp` itself
/// to the foreground, and leave the host stopped on its next tty read.
/// `setsid()` puts each stage in its own session with no controlling tty, so
/// it cannot reach `/dev/tty` at all.
///
/// `_in_pipeline_group` is not consulted: a pipeline stage that legitimately
/// needs the shared tty group has terminal stdin and is handled by the
/// `child_stdin_is_terminal` arm before pipeline membership would matter.
/// Foregrounding is gated on `new_pg && child_stdin_is_terminal`.
#[must_use]
pub const fn child_session_action(
	new_pg: bool,
	child_stdin_is_terminal: bool,
	_in_pipeline_group: bool,
) -> ChildSessionAction {
	if new_pg && child_stdin_is_terminal {
		return ChildSessionAction::TakeForeground;
	}
	if child_stdin_is_terminal {
		return ChildSessionAction::None;
	}
	ChildSessionAction::DetachSession
}

#[cfg(test)]
mod tests {
	use super::*;

	/// An interactive shell, leading its own pgroup, terminal stdin: foreground.
	#[test]
	fn interactive_with_terminal_stdin_takes_foreground() {
		assert_eq!(child_session_action(true, true, false), ChildSessionAction::TakeForeground,);
		// Terminal foregrounding wins even when this is the first stage of a
		// pipeline; no detach is attempted.
		assert_eq!(child_session_action(true, true, true), ChildSessionAction::TakeForeground,);
	}

	/// The shell leading a new pgroup with non-terminal stdin always detaches —
	/// including the first stage of a pipeline. `setsid()` keeps the child
	/// off the host's controlling tty; the spawn path skips
	/// `process_group(...)` for detached children, so later stages no longer
	/// try to `setpgid`-join a leader that has moved sessions (the historical
	/// EPERM hazard).
	#[test]
	fn non_terminal_stdin_detaches_regardless_of_pipeline() {
		assert_eq!(child_session_action(true, false, false), ChildSessionAction::DetachSession,);
		assert_eq!(child_session_action(true, false, true), ChildSessionAction::DetachSession,);
	}

	/// A non-interactive shell, terminal stdin, no pipeline: nothing to do.
	#[test]
	fn non_interactive_with_terminal_stdin_does_nothing() {
		assert_eq!(child_session_action(false, true, false), ChildSessionAction::None,);
	}

	/// A non-interactive shell, terminal stdin, joining a pipeline pgroup:
	/// nothing to do (parent already wired pgroup membership).
	#[test]
	fn non_interactive_terminal_stdin_in_pipeline_does_nothing() {
		assert_eq!(child_session_action(false, true, true), ChildSessionAction::None,);
	}

	/// **Embedded host bug fix.** A non-interactive shell, non-terminal stdin,
	/// no pipeline pgroup: detach so the child cannot SIGTTIN/SIGTTOU the
	/// host. This is the case that regressed before this fix and is the
	/// motivating bug for PR #895.
	#[test]
	fn embedded_host_with_non_terminal_stdin_detaches() {
		assert_eq!(child_session_action(false, false, false), ChildSessionAction::DetachSession,);
	}

	/// **Pipeline tty-safety.** A non-interactive shell, non-terminal stdin
	/// (pipe), and a multi-command pipeline: detach. An interactive child in
	/// a pipeline (`zsh -i ... | awk`) would otherwise open `/dev/tty`,
	/// `tcsetpgrp` itself to the foreground, and leave the host stopped on
	/// its next tty read (`suspended (tty input)`). Each stage gets its own
	/// session instead; the embedded host cancels via the descendant tree,
	/// not a shared pgroup, and pipes are session-independent.
	#[test]
	fn pipeline_stage_with_non_terminal_stdin_detaches() {
		assert_eq!(child_session_action(false, false, true), ChildSessionAction::DetachSession,);
	}
}
