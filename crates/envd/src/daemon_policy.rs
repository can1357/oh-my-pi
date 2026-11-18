//! The sandbox, approval and workspace trust policy a project environment
//! daemon enforces.
//!
//! A daemon compiles its command sandbox, its egress broker and its approval
//! posture from the control context it starts under and keeps them for its
//! whole life. A client that resolved a different policy from its own context
//! must never run its tools there: a client configured with
//! `sv_sandbox_mode off` would have its commands confined and auto-approved by
//! a daemon started under the shipped `workspace-write`, and a client expecting
//! the sandbox would run unconfined under a daemon started without one.
//!
//! The same holds for the workspace trust decision the daemon was started
//! under: it decides whether the project's MCP servers mount and whether its
//! language- and debug-server configuration loads, so a trusted and an
//! untrusted client never share a daemon.
//!
//! [`from_con`] digests everything a daemon fixes at start that decides how a
//! command is confined, wrapped or admitted, whether the daemon's `read`
//! may reach the network, and which project inputs it loads. The digest keys
//! the environment socket (`omp_env::project_state::environment_socket`), so
//! differing clients reach daemons of their own, and the daemon reports it in
//! every `ServerHello`, so a client verifies the daemon it reached before
//! attaching.
//!
//! The rest of what a daemon fixes at start is deliberately left out, so it
//! never splits clients across daemons: edit, read and grep limits, timeouts,
//! direnv, the browser it drives and the memory backend change what a tool
//! does, not how a command is confined or admitted or whether a tool reaches
//! the network by itself. The tool roster is left out as well: an attached
//! session composes its registry, and with it which tools exist, from its own
//! context (`EnvServer::open_session_host`).

use std::collections::BTreeMap;

use omp_con::Ctx;
use omp_core::{Hash32, Str};
use omp_env::project_state::DaemonPolicy;
use omp_ext::workspace_trust::WorkspaceTrust;
use serde::Serialize;

use crate::{
	admission::{ApprovalPolicy, ConfiguredApproval},
	exec_settings::{SandboxSettings, ShellSettings},
	tool_settings::ToolSettings,
};

/// Separates the policy digest from every other SHA-256 use; bump it when the
/// digested facts change meaning.
const DOMAIN: &[u8] = b"omp/envd-daemon-policy/v2\0";

/// The facts digested, in a fixed order.
#[derive(Serialize)]
struct PolicyFacts<'a> {
	/// Every `sv_sandbox_*` setting, with who set the network mode and whether
	/// the user set any of them: the posture, the broker and the failure mode
	/// of a sandbox that cannot be constructed.
	sandbox:         &'a SandboxSettings,
	/// `sv_tools_approval_mode` and who set it.
	approval:        ConfiguredApproval,
	/// `sv_tools_approval`: the per-tool overrides honoured in every mode.
	tool_approvals:  &'a BTreeMap<Str, ApprovalPolicy>,
	/// `sv_shell_command_prefix`: the wrapper the daemon's shell places before
	/// every admitted command, which a user may make a confinement layer of
	/// its own (`sandbox-exec`, `bwrap`, `timeout`).
	command_prefix:  Option<&'a str>,
	/// `sv_fetch_enabled`: whether the daemon's `read` fetches URLs.
	fetch_enabled:   bool,
	/// The workspace trust decision the daemon loads project inputs under:
	/// project MCP servers, LSP/DAP configuration, hosts and vaults.
	workspace_trust: WorkspaceTrust,
}

/// Resolves the policy a daemon composed from `ctx` for a workspace of
/// `trust` enforces.
///
/// A per-connection approval-mode flag is not part of it: each connection
/// sends its own in `ClientHello.approval_mode`.
#[must_use]
pub fn from_con(ctx: &Ctx, trust: WorkspaceTrust) -> DaemonPolicy {
	of(
		&SandboxSettings::from_con(ctx),
		&ToolSettings::from_con(ctx),
		&ShellSettings::from_con(ctx),
		trust,
	)
}

/// Resolves the policy with extra session-protected paths merged into the
/// host defaults. Paths already present leave the digest unchanged, so a
/// session whose paths match the host defaults still joins the shared daemon.
#[must_use]
pub fn from_con_with_protected_write_paths(
	ctx: &Ctx,
	trust: WorkspaceTrust,
	protected_write_paths: &[std::path::PathBuf],
) -> DaemonPolicy {
	let mut sandbox = SandboxSettings::from_con(ctx);
	for path in protected_write_paths {
		if !sandbox.protected_write_paths.contains(path) {
			sandbox.protected_write_paths.push(path.clone());
		}
	}
	of(&sandbox, &ToolSettings::from_con(ctx), &ShellSettings::from_con(ctx), trust)
}

/// Digests the policy of resolved `sandbox`, `tools` and `shell` settings,
/// before any composition-level approval-mode override, under the workspace
/// `trust`.
#[must_use]
pub(crate) fn of(
	sandbox: &SandboxSettings,
	tools: &ToolSettings,
	shell: &ShellSettings,
	trust: WorkspaceTrust,
) -> DaemonPolicy {
	let facts = PolicyFacts {
		sandbox,
		approval: tools.configured_approval(),
		tool_approvals: &tools.approval,
		command_prefix: shell.command_prefix.as_deref(),
		fetch_enabled: tools.fetch_enabled,
		workspace_trust: trust,
	};
	let mut digest = Hash32::hasher();
	digest.update(DOMAIN);
	serde_json::to_writer(&mut digest, &facts)
		.expect("policy facts have string map keys and a hasher sink never fails");
	DaemonPolicy::new(digest.finalize())
}

#[cfg(test)]
mod tests {
	use omp_con::{Kv, Value};

	use super::*;
	use crate::{
		exec_settings::{
			ExecSandboxMode, SV_SANDBOX_MODE, SV_SANDBOX_NETWORK_MODE, SandboxNetworkMode,
		},
		tool_settings::{ApprovalMode, SV_TOOLS_APPROVAL, SV_TOOLS_APPROVAL_MODE},
	};

	fn policy(configure: impl FnOnce(&Ctx)) -> DaemonPolicy {
		let ctx = Ctx::new();
		configure(&ctx);
		from_con(&ctx, WorkspaceTrust::Untrusted)
	}

	/// Equal configurations resolve one policy, and every setting a daemon
	/// fixes at start, or who set it, resolves another.
	#[test]
	fn every_sandbox_and_approval_fact_changes_the_policy() {
		let shipped = policy(|_| {});
		assert_eq!(shipped, policy(|_| {}), "the digest is deterministic");

		let variants = [
			policy(|ctx| {
				SV_SANDBOX_MODE
					.set(ctx, ExecSandboxMode::Off)
					.expect("mode");
			}),
			policy(|ctx| {
				SV_SANDBOX_MODE
					.set(ctx, ExecSandboxMode::WorkspaceWrite)
					.expect("explicit shipped mode");
			}),
			policy(|ctx| {
				SV_SANDBOX_NETWORK_MODE
					.set(ctx, SandboxNetworkMode::Open)
					.expect("network");
			}),
			policy(|ctx| {
				ctx.run("sv_sandbox_allow_localhost 1").expect("loopback");
			}),
			policy(|ctx| {
				SV_TOOLS_APPROVAL_MODE
					.set(ctx, ApprovalMode::AlwaysAsk)
					.expect("approval mode");
			}),
			policy(|ctx| {
				SV_TOOLS_APPROVAL_MODE
					.set(ctx, ApprovalMode::Yolo)
					.expect("explicit shipped approval mode");
			}),
			policy(|ctx| {
				SV_TOOLS_APPROVAL
					.set(ctx, Kv(vec![(Str::new_static("bash"), Value::Str(Str::new_static("deny")))]))
					.expect("per-tool override");
			}),
			policy(|ctx| {
				ctx.run("sv_shell_command_prefix timeout")
					.expect("command prefix");
			}),
			policy(|ctx| {
				ctx.run("sv_fetch_enabled false").expect("fetch policy");
			}),
		];
		for (index, variant) in variants.iter().enumerate() {
			assert_ne!(*variant, shipped, "variant {index} kept the shipped policy");
			for other in &variants[index + 1..] {
				assert_ne!(variant, other, "two variants share a policy");
			}
		}
	}

	/// The workspace trust decision keys the daemon: a trusted and an
	/// untrusted client of one configuration never share a daemon, and two
	/// clients of one trust do.
	#[test]
	fn workspace_trust_changes_the_policy() {
		let ctx = Ctx::new();
		let untrusted = from_con(&ctx, WorkspaceTrust::Untrusted);
		let trusted = from_con(&ctx, WorkspaceTrust::Trusted);
		assert_ne!(trusted, untrusted);
		assert_eq!(trusted, from_con(&Ctx::new(), WorkspaceTrust::Trusted));
	}

	/// Settings outside the sandbox and approval policy leave the daemon key
	/// alone, so they never split clients across daemons.
	#[test]
	fn unrelated_settings_keep_the_policy() {
		let shipped = policy(|_| {});
		assert_eq!(
			shipped,
			policy(|ctx| {
				crate::tool_settings::SV_TOOLS_READ_LINE_NUMBERS
					.set(ctx, true)
					.expect("read setting");
			})
		);
	}
	/// Host-protected paths participate in daemon identity through shared
	/// settings.
	#[test]
	fn protected_paths_participate_in_daemon_identity() {
		let ctx = Ctx::new();
		let trust = WorkspaceTrust::Untrusted;
		let config_policy = from_con(&ctx, trust);
		let mut sandbox = SandboxSettings::from_con(&ctx);
		sandbox
			.protected_write_paths
			.push(std::path::PathBuf::from("/var/run/omp-protected-test"));
		assert_ne!(
			config_policy,
			of(&sandbox, &ToolSettings::from_con(&ctx), &ShellSettings::from_con(&ctx), trust)
		);
	}

	/// `SandboxSettings::from_con` derives the host-protected paths for every
	/// local session, so a session that passes those same paths resolves the
	/// daemon `from_con` alone resolves, and does not split the shared daemon.
	#[test]
	fn session_paths_equal_to_the_host_defaults_keep_the_policy() {
		let ctx = Ctx::new();
		let trust = WorkspaceTrust::Untrusted;
		let host_defaults = SandboxSettings::from_con(&ctx).protected_write_paths;
		assert!(!host_defaults.is_empty(), "a local session derives host-protected paths");

		assert_eq!(
			from_con_with_protected_write_paths(&ctx, trust, &host_defaults),
			from_con(&ctx, trust)
		);
	}

	/// A protected path that is not valid UTF-8 digests lossily instead of
	/// panicking, and it still keys the daemon.
	#[cfg(unix)]
	#[test]
	fn non_utf8_protected_paths_digest_without_panicking() {
		use std::{ffi::OsStr, os::unix::ffi::OsStrExt as _, path::PathBuf};

		let ctx = Ctx::new();
		let trust = WorkspaceTrust::Untrusted;
		let mut sandbox = SandboxSettings::from_con(&ctx);
		sandbox
			.protected_write_paths
			.push(PathBuf::from(OsStr::from_bytes(b"/srv/omp-\xff-store")));
		let tools = ToolSettings::from_con(&ctx);
		let shell = ShellSettings::from_con(&ctx);

		let policy = of(&sandbox, &tools, &shell, trust);
		assert_eq!(policy, of(&sandbox, &tools, &shell, trust), "the digest is deterministic");
		assert_ne!(policy, from_con(&ctx, trust), "the path still keys the daemon");
	}
}
