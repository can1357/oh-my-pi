//! Small convar projections used by surviving standalone driver services.

use std::{
	io,
	path::{Path, PathBuf},
};

use omp_con::Ctx;
use omp_core::Str;
pub use omp_envd::host_settings::SV_WORKTREE_BASE;
use serde::{Deserialize, Serialize};

/// Standalone sharing backend.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Eq,
	PartialEq,
	Deserialize,
	Serialize,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
	strum::VariantNames,
)]
#[strum(serialize_all = "lowercase", ascii_case_insensitive)]
pub enum ShareStore {
	/// Encrypted HTTP object store.
	#[default]
	Http,
	/// Authenticated GitHub gist.
	Gist,
}
omp_con::con_enum!(ShareStore);

omp_con::var! {
	/// Enables skill commands.
	pub static SV_SKILLS_ENABLE_SKILL_COMMANDS = sv_skills_enable_skill_commands: bool {
		default: true,
		flags: archive,
		meta: {
			"legacy.path": "skills.enableSkillCommands",
		},
	};
	/// Enables user-level Codex skills.
	pub static SV_SKILLS_ENABLE_CODEX_USER = sv_skills_enable_codex_user: bool {
		default: false,
		flags: archive,
		meta: {
			"legacy.path": "skills.enableCodexUser",
		},
	};
	/// Enables user-level Claude skills.
	pub static SV_SKILLS_ENABLE_CLAUDE_USER = sv_skills_enable_claude_user: bool {
		default: false,
		flags: archive,
		meta: {
			"legacy.path": "skills.enableClaudeUser",
		},
	};
	/// Enables project-level Claude skills.
	pub static SV_SKILLS_ENABLE_CLAUDE_PROJECT = sv_skills_enable_claude_project: bool {
		default: true,
		flags: archive,
		meta: {
			"legacy.path": "skills.enableClaudeProject",
		},
	};
	/// Enables user-level native skills.
	pub static SV_SKILLS_ENABLE_PI_USER = sv_skills_enable_pi_user: bool {
		default: true,
		flags: archive,
		meta: {
			"legacy.path": "skills.enablePiUser",
		},
	};
	/// Enables project-level native skills.
	pub static SV_SKILLS_ENABLE_PI_PROJECT = sv_skills_enable_pi_project: bool {
		default: true,
		flags: archive,
		meta: {
			"legacy.path": "skills.enablePiProject",
		},
	};
	/// Enables user-level agent skills.
	pub static SV_SKILLS_ENABLE_AGENTS_USER = sv_skills_enable_agents_user: bool {
		default: true,
		flags: archive,
		meta: {
			"legacy.path": "skills.enableAgentsUser",
		},
	};
	/// Enables project-level agent skills.
	pub static SV_SKILLS_ENABLE_AGENTS_PROJECT = sv_skills_enable_agents_project: bool {
		default: true,
		flags: archive,
		meta: {
			"legacy.path": "skills.enableAgentsProject",
		},
	};
	/// Share viewer/upload base used by /share (encrypted blob upload + viewer; links are
	/// `<base>/<id>#<key>`).
	pub static SV_SHARE_SERVER = sv_share_server: Str {
		default: Str::new_static("https://share.omp.dev"),
		flags: archive,
		meta: {
			"ui.tab": "interaction",
			"ui.group": "Collab",
			"ui.label": "Share Server",
			"legacy.path": "share.serverUrl",
		},
	};
	/// Where /share uploads the encrypted session blob.
	pub static SV_SHARE_STORE = sv_share_store: ShareStore {
		default: ShareStore::Http,
		flags: archive,
		meta: {
			"ui.tab": "interaction",
			"ui.group": "Collab",
			"ui.label": "Share Store",
			"ui.option.http": "Encrypted Blob",
			"ui.option.http.desc": "Upload to the share server (no GitHub account needed; avoids gist API rate limits)",
			"ui.option.gist": "GitHub Gist",
			"ui.option.gist.desc": "Push to a secret gist (needs authenticated gh), falling back to the share server",
			"legacy.path": "share.store",
		},
	};
	/// Run the secret obfuscator over /share snapshots before upload (uses the secrets.* config).
	pub static SV_SHARE_REDACT_SECRETS = sv_share_redact_secrets: bool {
		default: true,
		flags: archive,
		meta: {
			"ui.tab": "interaction",
			"ui.group": "Collab",
			"ui.label": "Share Secret Redaction",
			"legacy.path": "export.shareRedactSecrets",
			"legacy.path": "share.redactSecrets",
		},
	};
	/// Name shown to other collab participants (default: OS username).
	pub static CL_COLLAB_DISPLAY_NAME = cl_collab_display_name: Str {
		default: Str::default(),
		flags: archive,
		meta: {
			"ui.tab": "interaction",
			"ui.group": "Collab",
			"ui.label": "Display Name",
			"legacy.path": "collab.displayName",
		},
	};
}

/// Share redaction projection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExportSettings {
	/// Remove secret values before sealing.
	pub share_redact_secrets: bool,
}

/// Share transport projection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ShareSettings {
	/// Service endpoint.
	pub server_url: Str,
	/// Storage backend.
	pub store:      ShareStore,
}

/// Collaboration identity projection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CollabSettings {
	display_name: Str,
}

impl CollabSettings {
	/// Returns the configured name, or the local login name.
	#[must_use]
	pub fn resolved_display_name(&self) -> Str {
		if self.display_name.is_empty() {
			std::env::var("USER").map_or_else(|_| Str::new_static("guest"), Str::new)
		} else {
			self.display_name.clone()
		}
	}
}

/// Environment-owned worktree placement.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct WorktreeSettings {
	/// Optional base directory.
	pub base: Option<PathBuf>,
}

/// Complete projection required by standalone commands.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Settings {
	/// Collaboration settings.
	pub collab:   CollabSettings,
	/// Worktree placement.
	pub worktree: WorktreeSettings,
	/// Share redaction policy.
	pub export:   ExportSettings,
	/// Share transport policy.
	pub share:    ShareSettings,
}

impl Settings {
	/// Projects settings from the effective convar context.
	#[must_use]
	pub fn from_con(ctx: &Ctx) -> Self {
		let worktree = {
			let value = SV_WORKTREE_BASE.get(ctx);
			(!value.is_empty()).then(|| PathBuf::from(value.as_str()))
		};
		Self {
			collab:   CollabSettings { display_name: CL_COLLAB_DISPLAY_NAME.get(ctx) },
			worktree: WorktreeSettings { base: worktree },
			export:   ExportSettings { share_redact_secrets: SV_SHARE_REDACT_SECRETS.get(ctx) },
			share:    ShareSettings {
				server_url: SV_SHARE_SERVER.get(ctx),
				store:      SV_SHARE_STORE.get(ctx),
			},
		}
	}

	/// Resolves extension overlays. Extension configuration itself owns the
	/// overlay schema; this projection contributes no hidden settings layer.
	pub fn extension_scopes(
		&self,
		overlays: Vec<omp_ext::config::ScopedOverlay>,
	) -> Result<Vec<omp_ext::config::ScopedOverlay>, io::Error> {
		Ok(overlays)
	}
}

/// Loads the user (profile) `config.cfg` into a convar context and projects
/// settings — the same file `omp config set` and `writecfg` write.
pub fn current() -> Result<Settings, io::Error> {
	current_for_project(None)
}

/// Loads settings for one project, with `<project>/.omp/config.cfg` layered
/// after the user cfg. Cfg files are user data: unknown statements are
/// reported and skipped, never fatal.
pub fn current_for_project(project: Option<&Path>) -> Result<Settings, io::Error> {
	let files = crate::cfg::CfgFiles::new(project).map_err(io::Error::other)?;
	let ctx = Ctx::new();
	ctx.exec_configs(&files, None).map_err(io::Error::other)?;
	Ok(Settings::from_con(&ctx))
}

/// Reads the workspace extension overlay without introducing a settings schema.
pub fn workspace_extension_overlay(
	_project: &Path,
) -> Result<Vec<omp_ext::config::ScopedOverlay>, io::Error> {
	Ok(Vec::new())
}
