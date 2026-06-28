//! Init script support for shells.

use std::path::PathBuf;

use crate::{Shell, error, expansion, extensions, interp};

/// Behavior for loading profile files.
#[derive(Default)]
pub enum ProfileLoadBehavior {
	/// Load the default profile files.
	#[default]
	LoadDefault,
	/// Skip loading profile files.
	Skip,
}

impl ProfileLoadBehavior {
	/// Returns whether profile loading should be skipped.
	pub const fn skip(&self) -> bool {
		matches!(self, Self::Skip)
	}
}

/// Behavior for loading rc files.
#[derive(Default)]
pub enum RcLoadBehavior {
	/// Load the default rc files.
	#[default]
	LoadDefault,
	/// Load a custom rc file; do not load defaults.
	LoadCustom(PathBuf),
	/// Skip loading rc files.
	Skip,
}

impl RcLoadBehavior {
	/// Returns whether rc loading should be skipped.
	pub const fn skip(&self) -> bool {
		matches!(self, Self::Skip)
	}
}

impl<SE: extensions::ShellExtensions> Shell<SE> {
	/// Loads and executes standard shell configuration files (i.e., rc and
	/// profile).
	///
	/// # Arguments
	///
	/// * `profile_behavior` - Behavior for loading profile files.
	/// * `rc_behavior` - Behavior for loading rc files.
	pub async fn load_config(
		&mut self,
		profile_behavior: &ProfileLoadBehavior,
		rc_behavior: &RcLoadBehavior,
	) -> Result<(), error::Error> {
		let mut params = self.default_exec_params();
		params.process_group_policy = interp::ProcessGroupPolicy::SameProcessGroup;

		if self.options.login_shell {
			// --noprofile means skip this.
			if matches!(profile_behavior, ProfileLoadBehavior::Skip) {
				return Ok(());
			}

			//
			// Source the system profile if it exists.
			//
			// Next source the first of these that exists and is readable (if any):
			//     * ~/.bash_profile
			//     * ~/.bash_login
			//     * ~/.profile
			//
			if let Some(system_profile) = crate::sys::fs::get_system_profile_path() {
				self.source_if_exists(system_profile, &params).await?;
			}
			if let Some(home_path) = self.home_dir() {
				if self.options.sh_mode {
					self
						.source_if_exists(home_path.join(".profile").as_path(), &params)
						.await?;
				} else {
					if !self
						.source_if_exists(home_path.join(".bash_profile").as_path(), &params)
						.await?
					{
						if !self
							.source_if_exists(home_path.join(".bash_login").as_path(), &params)
							.await?
						{
							self
								.source_if_exists(home_path.join(".profile").as_path(), &params)
								.await?;
						}
					}
				}
			}
		} else {
			if self.options.interactive {
				match rc_behavior {
					_ if self.options.sh_mode => (),
					RcLoadBehavior::Skip => (),
					RcLoadBehavior::LoadCustom(rc_file) => {
						// If an explicit rc file is provided, source it.
						self.source_if_exists(rc_file, &params).await?;
					},
					RcLoadBehavior::LoadDefault => {
						//
						// Otherwise, for non-login interactive shells, load in this order:
						//
						//     system rc file (e.g. /etc/bash.bashrc on Unix)
						//     ~/.bashrc
						//
						if let Some(system_rc) = crate::sys::fs::get_system_rc_path() {
							self.source_if_exists(system_rc, &params).await?;
						}
						if let Some(home_path) = self.home_dir() {
							self
								.source_if_exists(home_path.join(".bashrc").as_path(), &params)
								.await?;
							self
								.source_if_exists(home_path.join(".brushrc").as_path(), &params)
								.await?;
						}
					},
				}
			} else {
				let env_var_name = if self.options.sh_mode {
					"ENV"
				} else {
					"BASH_ENV"
				};

				if let Some(config_path) = self.env_str(env_var_name) {
					let config_path = config_path.into_owned();
					let options = expansion::ExpanderOptions {
						brace_expand:    false,
						pathname_expand: false,
						..Default::default()
					};
					let expanded_path = expansion::basic_expand_word_with_options(
						self,
						&params,
						config_path.as_str(),
						&options,
					)
					.await?;

					if !expanded_path.is_empty() {
						self.source_if_exists(PathBuf::from(expanded_path), &params).await?;
					}
				}
			}
		}

		Ok(())
	}
}
