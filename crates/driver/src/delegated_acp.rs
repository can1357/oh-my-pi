//! ACP launch profiles for third-party agent CLIs (ADR 0043).
//!
//! ACP has no sandbox parameter, so each CLI is made to enforce the delegated
//! policy through its own launch arguments, environment and session setup. A
//! profile fixes all of that in code; the operator chooses only **whether** a
//! CLI is enabled (its program convar) and, for dsh, which model route it uses.
//! A project cfg cannot touch any of it: every variable here is
//! `flags: archive` with no `PROJECT` flag.
//!
//! Every program convar defaults to empty, which means "not enabled". Nothing
//! is registered, spawned or probed until the operator names a program.
//!
//! | CLI   | Enforcement the profile asks for                                   | Evidence |
//! |-------|--------------------------------------------------------------------|----------|
//! | dsh   | `DSH_PERMISSION_MODE=read-only` (its sandbox preset)               | shell write denied; permission request raised and denied |
//! | Devin | `session/set_mode ask` (declines tool use itself)                  | shell write not performed |
//! | Grok  | `--sandbox read-only` (Seatbelt/Landlock; fails open, see below) and `--permission-mode default` (asks over ACP) | shell write blocked outside `/tmp`, `/var/tmp`, `~/.grok`; permission request raised and denied |
//!
//! Recorded transcripts: `docs/research/acp-handshakes/`.
//!
//! # Grok caveats
//!
//! Grok documents that child-process network blocking is Linux-only, and that
//! a *built-in* sandbox profile which fails to apply (for instance when the
//! process already runs inside another Seatbelt sandbox) warns and continues
//! without enforcement. Both are vendor statements, not checked here. The
//! `read-only` profile also leaves `/tmp`, `/var/tmp` and `~/.grok` writable
//! (observed: a write under `/tmp` succeeds). Enable Grok only for workspaces
//! outside those paths.
//!
//! The network posture the ACP client declares is not independently verified
//! for any of the three CLIs.

use std::ffi::OsString;

use omp_agent::delegated::ExecutorId;
use omp_con::Ctx;
use omp_core::Str;
use omp_envd::{
	acp_client::{AcpExecutor, AcpProfile, LoginNotice},
	child_env::ChildEnv,
};

omp_con::var! {
	/// Program (path or name on `$PATH`) that starts dsh. Empty leaves dsh
	/// disabled. Operator-controlled; a project cfg cannot set it.
	pub static SV_DELEGATED_DSH_PROGRAM = sv_delegated_dsh_program: Str {
		default: Str::new_static(""),
		flags: archive,
	};
}

omp_con::var! {
	/// dsh model route, such as `deepseek-account`. Applied only when
	/// `sv_delegated_dsh_model` is set too; otherwise dsh keeps its own default.
	pub static SV_DELEGATED_DSH_ROUTE = sv_delegated_dsh_route: Str {
		default: Str::new_static(""),
		flags: archive,
	};
}

omp_con::var! {
	/// dsh model name on the route, such as `deepseek-flash`.
	pub static SV_DELEGATED_DSH_MODEL = sv_delegated_dsh_model: Str {
		default: Str::new_static(""),
		flags: archive,
	};
}

omp_con::var! {
	/// Program (path or name on `$PATH`) that starts Devin. Empty leaves Devin
	/// disabled. Operator-controlled; a project cfg cannot set it.
	pub static SV_DELEGATED_DEVIN_PROGRAM = sv_delegated_devin_program: Str {
		default: Str::new_static(""),
		flags: archive,
	};
}

omp_con::var! {
	/// Program (path or name on `$PATH`) that starts Grok. Empty leaves Grok
	/// disabled. Operator-controlled; a project cfg cannot set it.
	pub static SV_DELEGATED_GROK_PROGRAM = sv_delegated_grok_program: Str {
		default: Str::new_static(""),
		flags: archive,
	};
}

/// Executor id of the dsh profile.
pub const DSH_ID: ExecutorId = ExecutorId::new_static("dsh");
/// Executor id of the Devin profile.
pub const DEVIN_ID: ExecutorId = ExecutorId::new_static("devin");
/// Executor id of the Grok profile.
pub const GROK_ID: ExecutorId = ExecutorId::new_static("grok");

/// Devin's typed missing-login notification, sent before its bare `-32000`.
const DEVIN_STOPPED_METHOD: &str = "_cognition.ai/agent_stopped";
/// The `cause` Devin reports when its login is missing.
const DEVIN_AUTH_CAUSE: &str = "auth_required";

/// The ACP executors the operator has enabled, in a fixed order.
#[must_use]
pub fn enabled_executors(ctx: &Ctx) -> Vec<AcpExecutor> {
	let mut out = Vec::new();
	if let Some(program) = enabled(&SV_DELEGATED_DSH_PROGRAM.get(ctx)) {
		let route = SV_DELEGATED_DSH_ROUTE.get(ctx);
		let model = SV_DELEGATED_DSH_MODEL.get(ctx);
		out.push(
			AcpExecutor::new(program, ["--profile", "acp"])
				.with_id(DSH_ID)
				.with_profile(dsh_profile(&route, &model))
				.with_env(dsh_env(&std::env::vars_os().collect::<Vec<_>>())),
		);
	}
	if let Some(program) = enabled(&SV_DELEGATED_DEVIN_PROGRAM.get(ctx)) {
		out.push(
			AcpExecutor::new(program, ["acp"])
				.with_id(DEVIN_ID)
				.with_profile(devin_profile()),
		);
	}
	if let Some(program) = enabled(&SV_DELEGATED_GROK_PROGRAM.get(ctx)) {
		// `--no-auto-update` precedes the subcommand: Grok replaces its own binary
		// on launch otherwise. `--permission-mode default` overrides an operator
		// `always-approve` in `~/.grok/config.toml`, so tool use asks over ACP.
		out.push(
			AcpExecutor::new(program, [
				"--no-auto-update",
				"--sandbox",
				"read-only",
				"--permission-mode",
				"default",
				"agent",
				"--no-leader",
				"stdio",
			])
			.with_id(GROK_ID),
		);
	}
	out
}

/// The program a convar names, or `None` when it is empty (not enabled).
fn enabled(program: &Str) -> Option<OsString> {
	(!program.is_empty()).then(|| OsString::from(program.as_str()))
}

/// dsh enforces its policy through `DSH_PERMISSION_MODE` (see [`dsh_env`]); the
/// profile only selects the model route, and only when the operator named both
/// halves of it. dsh reports a missing credential as a generic internal error,
/// so it has no login notice and that failure stays `Internal`.
fn dsh_profile(route: &str, model: &str) -> AcpProfile {
	let mut profile = AcpProfile::default();
	if !route.is_empty() && !model.is_empty() {
		// dsh's `model` option takes the pair as compact JSON text.
		if let Ok(value) = serde_json::to_string(&[route, model]) {
			profile
				.config_options
				.push((Str::new_static("model"), Str::from(value)));
		}
	}
	profile
}

/// dsh's environment: the ambient set, its own home (the user's login lives
/// there), and the read-only permission preset. The preset is set last, so an
/// inherited value cannot weaken it.
fn dsh_env(parent: &[(OsString, OsString)]) -> ChildEnv {
	ChildEnv::ambient_from(parent.iter().cloned())
		.with_inherited_from(["DSH_HOME"], parent.iter().cloned())
		.with_set("DSH_PERMISSION_MODE", "read-only")
}

/// Devin's `ask` mode declines tool use itself. Its login failure arrives as a
/// typed `agent_stopped` notice ahead of a bare `-32000`.
fn devin_profile() -> AcpProfile {
	AcpProfile {
		session_mode:   Some(Str::new_static("ask")),
		config_options: Vec::new(),
		login_notice:   Some(LoginNotice {
			method: Str::new_static(DEVIN_STOPPED_METHOD),
			cause:  Str::new_static(DEVIN_AUTH_CAUSE),
		}),
	}
}

#[cfg(test)]
mod tests {
	use omp_con::{ConError, Source};

	use super::*;

	fn ids(ctx: &Ctx) -> Vec<ExecutorId> {
		enabled_executors(ctx)
			.iter()
			.map(|e| {
				omp_agent::delegated::DelegatedExecutor::capabilities(e)
					.executor
					.clone()
			})
			.collect()
	}

	#[test]
	fn nothing_is_enabled_until_the_operator_names_a_program() {
		assert!(enabled_executors(&Ctx::new()).is_empty());
	}

	#[test]
	fn each_enabled_cli_registers_once_under_its_own_id_in_a_deterministic_order() {
		let ctx = Ctx::new();
		ctx.exec("sv_delegated_grok_program /opt/grok", Source::Console)
			.unwrap();
		ctx.exec("sv_delegated_devin_program /opt/devin", Source::Console)
			.unwrap();
		assert_eq!(ids(&ctx), vec![DEVIN_ID, GROK_ID]);
		ctx.exec("sv_delegated_dsh_program /opt/dsh", Source::Console)
			.unwrap();
		let registered_ids = ids(&ctx);
		let unique_ids: std::collections::HashSet<_> = registered_ids.iter().cloned().collect();
		assert_eq!(unique_ids, std::collections::HashSet::from([DSH_ID, DEVIN_ID, GROK_ID]));
		assert_eq!(registered_ids.len(), unique_ids.len());
		assert_eq!(registered_ids, ids(&ctx));
	}

	#[test]
	fn a_project_cfg_cannot_enable_a_cli_or_change_its_route() {
		let ctx = Ctx::new();
		for line in [
			"sv_delegated_dsh_program /tmp/evil",
			"sv_delegated_dsh_route evil",
			"sv_delegated_dsh_model evil",
			"sv_delegated_devin_program /tmp/evil",
			"sv_delegated_grok_program /tmp/evil",
		] {
			let err = ctx
				.exec(line, Source::Project(Str::new_static("config.cfg")))
				.unwrap_err();
			assert!(matches!(err, ConError::ProjectVarDenied { .. }), "{line}: {err:?}");
		}
		assert!(enabled_executors(&ctx).is_empty());
	}

	#[test]
	fn dsh_model_is_sent_as_one_compact_json_pair_only_when_both_halves_are_set() {
		let both = dsh_profile("deepseek-account", "deepseek-flash");
		assert_eq!(both.config_options, vec![(
			Str::new_static("model"),
			Str::from(r#"["deepseek-account","deepseek-flash"]"#),
		)]);
		assert!(
			dsh_profile("deepseek-account", "")
				.config_options
				.is_empty()
		);
		assert!(dsh_profile("", "deepseek-flash").config_options.is_empty());
	}

	#[test]
	fn dsh_environment_cannot_be_loosened_by_the_parent() {
		let parent = [
			("PATH", "/usr/bin"),
			("DSH_HOME", "/home/u/.dsh"),
			("DSH_PERMISSION_MODE", "danger-full-access"),
			("DEEPSEEK_API_KEY", "sk-secret"),
		]
		.map(|(k, v)| (OsString::from(k), OsString::from(v)));
		let env = dsh_env(&parent);
		let get = |name: &str| {
			env.iter()
				.find(|(k, _)| *k == std::ffi::OsStr::new(name))
				.map(|(_, v)| v.to_os_string())
		};
		assert_eq!(get("DSH_PERMISSION_MODE"), Some(OsString::from("read-only")));
		assert_eq!(get("DSH_HOME"), Some(OsString::from("/home/u/.dsh")));
		assert_eq!(get("PATH"), Some(OsString::from("/usr/bin")));
		assert_eq!(get("DEEPSEEK_API_KEY"), None);
	}

	#[test]
	fn devin_asks_to_decline_tools_and_names_its_login_notice() {
		let profile = devin_profile();
		assert_eq!(profile.session_mode, Some(Str::new_static("ask")));
		let notice = profile
			.login_notice
			.expect("devin has a typed login notice");
		assert_eq!(notice.method.as_str(), "_cognition.ai/agent_stopped");
		assert_eq!(notice.cause.as_str(), "auth_required");
	}
}
