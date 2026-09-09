//! Application-owned settings.

/// Release stream selected by the native self-updater.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Eq,
	PartialEq,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
	strum::VariantNames,
)]
#[strum(serialize_all = "lowercase")]
pub enum UpdateChannel {
	/// Published production releases.
	#[default]
	Stable,
	/// Published prerelease builds.
	Canary,
}

omp_con::con_enum!(UpdateChannel);

omp_con::var! {
	/// Check for omp updates on startup
	pub static CL_STARTUP_CHECK_UPDATE = cl_startup_check_update: bool {
		default: true,
		flags: archive,
		meta: {
			"ui.tab": "interaction",
			"ui.group": "Startup & Updates",
			"ui.label": "Check for Updates",
			"legacy.path": "startup.checkUpdate",
		},
	};
	/// Update channel used by omp update and the startup update check
	pub static CL_UPDATE_CHANNEL = cl_update_channel: UpdateChannel {
		default: UpdateChannel::Stable,
		flags: archive,
		meta: {
			"ui.tab": "interaction",
			"ui.group": "Startup & Updates",
			"ui.label": "Update Channel",
			"ui.option.stable": "Stable",
			"ui.option.canary": "Canary",
			"legacy.path": "update.channel",
		},
	};
}
