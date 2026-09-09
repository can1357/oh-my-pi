//! Agent-owned product variables read by the kernel and its host surfaces
//! through the effective control plane.

use omp_core::Str;

/// Whether image attachments and `Read.question` media reach the model.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Eq,
	PartialEq,
	strum::EnumString,
	strum::IntoStaticStr,
	strum::VariantNames,
)]
#[strum(serialize_all = "lowercase")]
pub enum VisionMode {
	/// Images flow when the route accepts image input, else they are
	/// replaced by their descriptions.
	#[default]
	Auto,
	/// Images always flow.
	On,
	/// Images are always replaced by their descriptions.
	Off,
}

omp_con::con_enum!(VisionMode);

omp_con::var! {
	/// Selected model route.
	pub static AI_MODEL = ai_model: Str {
		default: Str::new_static(""),
		flags: archive | session,
	};
	/// Model route for task subagents; empty inherits `ai_model`.
	pub static AI_TASK_MODEL = ai_task_model: Str {
		default: Str::new_static(""),
		flags: archive | session,
	};
	/// Selected model reasoning level (`off`, `minimal`, `low`, `medium`,
	/// `high`, `xhigh`, `max`). Routes that cannot honor a level clamp it
	/// (ADR 0017).
	pub static AI_THINKING = ai_thinking: Str {
		default: Str::new_static("high"),
		suggest: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		flags: archive | session,
	};
	/// Enables the low-latency model path.
	pub static AI_FASTMODE = ai_fastmode: bool {
		default: false,
		flags: archive | session,
	};
	/// Controls the inspect_image tool, which delegates image understanding to
	/// a vision-capable model. `auto` exposes it only when the active model
	/// lacks native image input; `on` always exposes it; `off` never does.
	pub static AI_VISION = ai_vision: VisionMode {
		default: VisionMode::Auto,
		flags: archive | session,
		meta: {
			"ui.tab": "tools",
			"ui.group": "Available Tools",
			"ui.label": "Inspect Image",
			"ui.option.auto": "Auto (only for models without vision)",
			"ui.option.on": "On",
			"ui.option.off": "Off",
			"legacy.path": "inspect_image.mode",
		},
	};
	/// Mode prompt rendered into the system prompt while engaged: names
	/// `prompts/modes/<name>.md` (`plan`, `vibe`, `autoresearch`); empty
	/// renders none. Bound by Directors, so the value derives from the live
	/// `<meta><directors>` stack (ADR 0015).
	pub static AI_PROMPT_MODE = ai_prompt_mode: Str {
		default: Str::new_static(""),
		suggest: ["plan", "vibe", "autoresearch"],
		flags: session,
	};
	/// Context-window fraction at which context maintenance begins.
	pub static AI_COMPACT_THRESHOLD = ai_compact_threshold: f64 {
		default: 0.80,
		min: 0.0,
		max: 1.0,
		flags: archive | session,
		meta: {
			"ui.tab": "context",
			"ui.group": "Compaction",
			"ui.label": "Compaction Threshold",
			"ui.unit": "percent",
			"ui.option.0.1": "10%",
			"ui.option.0.1.desc": "Extremely early maintenance",
			"ui.option.0.2": "20%",
			"ui.option.0.2.desc": "Very early maintenance",
			"ui.option.0.3": "30%",
			"ui.option.0.3.desc": "Early maintenance",
			"ui.option.0.4": "40%",
			"ui.option.0.4.desc": "Moderately early maintenance",
			"ui.option.0.5": "50%",
			"ui.option.0.5.desc": "Halfway point",
			"ui.option.0.6": "60%",
			"ui.option.0.6.desc": "Moderate context usage",
			"ui.option.0.7": "70%",
			"ui.option.0.7.desc": "Balanced",
			"ui.option.0.75": "75%",
			"ui.option.0.75.desc": "Slightly aggressive",
			"ui.option.0.8": "80%",
			"ui.option.0.8.desc": "Typical threshold",
			"ui.option.0.85": "85%",
			"ui.option.0.85.desc": "Aggressive context usage",
			"ui.option.0.9": "90%",
			"ui.option.0.9.desc": "Very aggressive",
			"ui.option.0.95": "95%",
			"ui.option.0.95.desc": "Near context limit",
			"legacy.path": "compaction.thresholdPercent",
		},
	};
	/// List available skills in the system prompt; disable to save context and
	/// toggle per-session with /skillful.
	pub static AI_SKILLFUL = ai_skillful: bool {
		default: true,
		flags: archive | session,
		meta: {
			"ui.tab": "model",
			"ui.group": "Prompt",
			"ui.label": "List Skills in Prompt",
			"legacy.path": "skillful",
		},
	};
	/// Host approval policy.
	pub static SV_APPROVAL_MODE = sv_approval_mode: Str {
		default: Str::new_static("on-request"),
		flags: archive | session | replicated,
	};
	/// Advertised tool allowlist: stable tool names the model may see this
	/// request (`--tools`, Director binds such as Vibe's `[read todo]`).
	/// Empty advertises every registered tool.
	pub static SV_TOOLS = sv_tools: Vec<Str> {
		default: Vec::new(),
		flags: archive | session | replicated,
	};
}

/// How many queued steering asides one safe point consumes.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Eq,
	PartialEq,
	strum::EnumString,
	strum::IntoStaticStr,
	strum::VariantNames,
)]
#[strum(serialize_all = "kebab-case")]
pub enum SteeringMode {
	/// One interjection per safe point; the rest wait for the next one.
	#[default]
	OneAtATime,
	/// Every queued interjection lands at the first safe point.
	All,
}

omp_con::con_enum!(SteeringMode);

omp_con::var! {
	/// How to process queued messages while the agent is working.
	pub static AI_STEERING_MODE = ai_steering_mode: SteeringMode {
		default: SteeringMode::OneAtATime,
		flags: archive | session,
		meta: {
			"ui.tab": "interaction",
			"ui.group": "Input",
			"ui.label": "Steering Mode",
			"legacy.path": "steeringMode",
		},
	};
}

/// Tool names the effective `sv_tools` allowlist advertises; `None` means
/// every registered tool.
#[must_use]
pub fn tool_allowlist(con: Option<&omp_con::Ctx>) -> Option<Vec<Str>> {
	let roster = SV_TOOLS.get(con?);
	(!roster.is_empty()).then_some(roster)
}
