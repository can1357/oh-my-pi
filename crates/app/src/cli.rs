//! Command parsing and production dispatch for the `omp` executable.

#[cfg(not(feature = "local-applefm"))]
use std::future;
use std::{
	ffi::OsString,
	fmt::{self, Display},
	io::{self, IsTerminal as _},
	net::SocketAddr,
	path::{Path, PathBuf},
	process,
	str::FromStr,
	sync::Arc,
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use clap::{Args, CommandFactory as _, FromArgMatches as _, Parser, Subcommand, ValueEnum};
use clap_complete::Shell;
use futures::StreamExt as _;
use miette::{IntoDiagnostic as _, miette};
use omp_catalog::settings::TierSetting;
use omp_core::{SecretString, Str, encoding::hex};
use omp_driver::{cleanse::CleanseArgs, compress::CompressArgs};
use omp_envd::{site::TrustedModule, worker::ExtHostSpec};
use omp_ext::config::ContributedCliValue;
const ROOT_LICENSE: &str = include_str!("../../../LICENSE");
const THIRD_PARTY_NOTICES: &str = include_str!("../../../THIRD-PARTY-NOTICES.txt");

fn write_license_output(mut output: impl io::Write) -> io::Result<()> {
	writeln!(output, "OMP License and Third-Party Notices")?;
	writeln!(output)?;
	writeln!(output, "{}", ROOT_LICENSE.trim_end())?;
	writeln!(output)?;
	writeln!(output, "{}", THIRD_PARTY_NOTICES.trim_end())
}

fn parse_cli_secret(value: &str) -> Result<SecretString, convert::Infallible> {
	Ok(SecretString::from(value))
}

use std::{convert, env, fs, time};

#[cfg(feature = "local-applefm")]
use omp_ai::local::applefm::{AppleFm, AppleFmEvent, AppleFmOptions};
use omp_ai::{
	Client,
	call::{
		CallMeta, ChatRequest, ContentPart, Message, NegotiationPolicy, Role, Sampling, Setting,
		Target,
	},
	event::ChatEvent,
	id::RequestId,
	receipt::ExecutionBudget,
	router,
};
use omp_catalog::{ModelKey, compile::compile_oracle};
use omp_driver::bridges::{AgentGoalControl, InferenceBridge};
use omp_envd::{
	exthost::{ActivationTrigger, DeclarationSet, ExtensionManifest, ServiceManifest},
	worker::HostKey,
};
use tokio::io::{AsyncWriteExt as _, stdout};

use crate::{
	acp_mode, auth_broker_cmd, auth_cli, auth_gateway_cmd, bench_cmd, chat_cmd,
	chat_cmd::{ChatPresentation, ChatStart},
	cleanse_cmd, complete_cmd,
	complete_cmd::CompletionKind,
	completions, compress_cmd, config_cmd,
	daemon::{DaemonConfig, DaemonHandle},
	dry_balance_cmd,
	endpoint::LocalEndpoint,
	ext_cli,
	ext_cli::{
		ExtArgs, ExtCommand, ExtInstallArgs, ExtLinkArgs, Scope as ExtScope, Tier as ExtTier,
	},
	gallery_cmd,
	gallery_cmd::GalleryArgs,
	gc_cmd, git_cmd,
	git_cmd::GitArgs,
	grievances_cmd, models_cmd, print_mode, profile_alias, render_cmd,
	render_cmd::RenderArgs,
	rpc_mode, say_cmd, setup_cmd, smoke_test, ssh_cmd,
	ssh_cmd::SshArgs,
	startup_notice,
	startup_notice::Eligibility,
	stats_cmd, tiny_models_cmd, update_cmd, usage_cmd,
	usage_error::CliUsageError,
	worktree_cmd,
};

/// Validated reasoning effort accepted by launch-shaped commands.
#[derive(clap::ValueEnum, Clone, Copy, Debug, Eq, PartialEq, strum::IntoStaticStr)]
#[strum(serialize_all = "lowercase")]
pub enum ThinkingLevel {
	/// Disable provider reasoning.
	Off,
	/// Smallest supported effort.
	Minimal,
	/// Low effort.
	Low,
	/// Default effort.
	Medium,
	/// High effort.
	High,
	/// Extreme effort.
	Extreme,
	/// Extra-high effort.
	XHigh,
	/// Maximum effort.
	Max,
	/// Leave effort selection to the provider.
	Auto,
}

impl FromStr for ThinkingLevel {
	type Err = String;

	fn from_str(value: &str) -> Result<Self, Self::Err> {
		let value = value.to_ascii_lowercase();
		let levels = [
			("off", Self::Off),
			("minimal", Self::Minimal),
			("low", Self::Low),
			("medium", Self::Medium),
			("high", Self::High),
			("extreme", Self::Extreme),
			("xhigh", Self::XHigh),
			("max", Self::Max),
			("auto", Self::Auto),
		];
		let matches = levels
			.into_iter()
			.filter(|(name, _)| name.starts_with(&value))
			.collect::<Vec<_>>();
		match matches.as_slice() {
			[(_, level)] => Ok(*level),
			[] if value == "inherit" => Err("`inherit` is not valid for --thinking".into()),
			[] => Err(format!("unknown thinking level `{value}`")),
			_ => Err(format!("ambiguous thinking level `{value}`")),
		}
	}
}

/// Parses `--service-tier` into the session's OpenAI-family tier setting
/// (`ai_tier_openai`). `inherit` is a subagent-only value and is rejected at
/// the CLI.
fn parse_service_tier(value: &str) -> Result<TierSetting, String> {
	use strum::VariantNames as _;
	match value.parse::<TierSetting>() {
		Ok(TierSetting::Inherit) => Err("`inherit` is not valid for --service-tier".into()),
		Ok(tier) => Ok(tier),
		Err(_) => Err(format!(
			"unknown service tier `{value}`; expected one of {}",
			TierSetting::VARIANTS
				.iter()
				.filter(|name| **name != "inherit")
				.copied()
				.collect::<Vec<_>>()
				.join(", ")
		)),
	}
}

/// Validated policy for tool approval requests.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ApprovalMode {
	/// Ask before every tool action.
	AlwaysAsk,
	/// Auto-approve workspace writes only.
	Write,
	/// Auto-approve all permitted actions.
	Yolo,
}

impl FromStr for ApprovalMode {
	type Err = String;

	fn from_str(value: &str) -> Result<Self, Self::Err> {
		match value {
			"always-ask" => Ok(Self::AlwaysAsk),
			"write" => Ok(Self::Write),
			"yolo" => Ok(Self::Yolo),
			_ => Err(format!("unknown approval mode `{value}`")),
		}
	}
}
impl From<ApprovalMode> for omp_envd::tool_settings::ApprovalMode {
	fn from(value: ApprovalMode) -> Self {
		match value {
			ApprovalMode::AlwaysAsk => Self::AlwaysAsk,
			ApprovalMode::Write => Self::Write,
			ApprovalMode::Yolo => Self::Yolo,
		}
	}
}

/// A strictly positive launch duration parsed from seconds or `s`, `m`, `h`
/// suffixes.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CliDuration(pub Duration);

impl FromStr for CliDuration {
	type Err = String;

	fn from_str(value: &str) -> Result<Self, Self::Err> {
		let value = value.trim();
		let (number, multiplier) = match value.as_bytes().last() {
			Some(b's') => (&value[..value.len() - 1], 1.0),
			Some(b'm') => (&value[..value.len() - 1], 60.0),
			Some(b'h') => (&value[..value.len() - 1], 3_600.0),
			_ => (value, 1.0),
		};
		let seconds = number
			.parse::<f64>()
			.map_err(|_| "duration must be seconds or use s, m, or h".to_owned())?
			* multiplier;
		if !seconds.is_finite() || seconds <= 0.0 {
			return Err("duration must be a finite value greater than zero".into());
		}
		Duration::try_from_secs_f64(seconds)
			.map(Self)
			.map_err(|_| "duration is too large".into())
	}
}

impl Display for CliDuration {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(formatter, "{}s", self.0.as_secs())
	}
}

/// Logical model role used to cycle a filtered catalog list.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ModelRole {
	/// First matching catalog model.
	Primary,
	/// Second matching catalog model.
	Smol,
	/// Third matching catalog model.
	Slow,
	/// Fourth matching catalog model.
	Plan,
}

impl FromStr for ModelRole {
	type Err = String;

	fn from_str(value: &str) -> Result<Self, Self::Err> {
		match value {
			"primary" => Ok(Self::Primary),
			"smol" => Ok(Self::Smol),
			"slow" => Ok(Self::Slow),
			"plan" => Ok(Self::Plan),
			_ => Err(format!("unknown model role `{value}`")),
		}
	}
}

/// Normalized comma-separated tool names accepted by launch-shaped commands.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolNames(
	/// Ordered normalized tool names.
	pub Vec<Str>,
);

impl FromStr for ToolNames {
	type Err = convert::Infallible;

	fn from_str(value: &str) -> Result<Self, Self::Err> {
		let mut names = Vec::new();
		for name in value
			.split(',')
			.map(str::trim)
			.filter(|name| !name.is_empty())
		{
			let lowercase = name.to_ascii_lowercase();
			let normalized = match lowercase.as_str() {
				"search" => "grep",
				"find" => "glob",
				name
					if omp_tools::builtin_tool_identities()
						.iter()
						.any(|tool| tool.name == name) =>
				{
					name
				},
				_ => name,
			};
			if !names
				.iter()
				.any(|candidate: &Str| candidate.as_str() == normalized)
			{
				names.push(Str::new(normalized));
			}
		}
		Ok(Self(names))
	}
}

pub mod bootstrap;
pub mod profile_bootstrap;
pub mod routing;
/// Non-empty comma-separated selector list.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectorList(
	/// Ordered selectors.
	pub Vec<Str>,
);

fn extension_setting_override(value: &str) -> Result<omp_ext::config::CliSettingOverride, String> {
	omp_ext::config::CliSettingOverride::parse(value).map_err(|error| error.to_string())
}

impl FromStr for SelectorList {
	type Err = String;

	fn from_str(value: &str) -> Result<Self, Self::Err> {
		let values = value.split(',').map(str::trim).collect::<Vec<_>>();
		if values.is_empty() || values.iter().any(|value| value.is_empty()) {
			return Err("expected a non-empty comma-separated list".into());
		}
		Ok(Self(values.into_iter().map(Str::from).collect()))
	}
}

/// Top-level parser for the production `omp` executable.
#[derive(Clone, Debug, Parser)]
#[command(
	name = "omp",
	version,
	disable_version_flag = true,
	about = "OMP coding agent and inference runtime",
	after_long_help = crate::help_extra::render()
)]
pub struct OmpCli {
	/// Enable an extension specification for this invocation.
	#[arg(
		long = "extension",
		short = 'e',
		visible_alias = "hook",
		hide = true,
		value_name = "SPEC",
		conflicts_with = "no_ext"
	)]
	pub ext:               Vec<Str>,
	/// Override one manifest-declared extension setting for this invocation.
	#[arg(long = "ext", hide = true, value_name = "ID.KEY=VALUE", value_parser = extension_setting_override)]
	pub ext_overrides:     Vec<omp_ext::config::CliSettingOverride>,
	/// Load only this local extension path for this invocation.
	#[arg(
		long = "plugin-dir",
		visible_alias = "ext-only",
		hide = true,
		value_name = "PATH",
		conflicts_with = "no_ext"
	)]
	pub ext_only:          Vec<PathBuf>,
	/// Load exactly these absolute Python modules through the trusted
	/// supervisor.
	#[arg(
		long = "trusted-extension",
		hide = true,
		value_name = "ABSOLUTE_PATH",
		value_parser = trusted_extension_path,
		conflicts_with_all = ["ext", "ext_only", "no_ext"]
	)]
	pub trusted_extension: Vec<omp_envd::site::TrustedModule>,
	/// Suppress all configured extensions for this invocation.
	#[arg(
		long = "no-ext",
		visible_alias = "no-extensions",
		hide = true,
		conflicts_with_all = ["ext", "ext_only", "trusted_extension"]
	)]
	pub no_ext:            bool,
	/// Suppress the workspace extension layer for this invocation.
	#[arg(long = "no-workspace-ext", hide = true)]
	pub no_workspace_ext:  bool,
	/// Export one durable session to a standalone HTML transcript, then exit.
	#[arg(long, global = true, value_name = "SESSION_OMS")]
	pub export:            Option<PathBuf>,
	/// Operation to run. Defaults to interactive project chat.
	#[command(subcommand)]
	pub command:           Option<Command>,
	/// Change to this project directory before dispatch.
	#[arg(long, global = true, value_name = "PATH")]
	pub cwd:               Option<PathBuf>,
	/// Permit running interactively from the home directory.
	#[arg(long, global = true)]
	pub allow_home:        bool,
	/// Render interactive chat in a native GPU window.
	#[arg(long, global = true)]
	pub gui:               bool,
	/// Print the embedded OMP license and tracked third-party notices.
	#[arg(long, global = true, exclusive = true)]
	pub license:           bool,
	/// Print the application version and exit.
	#[arg(id = "app_version", short = 'v', long = "version", global = true)]
	pub version:           bool,
	/// Select a named profile before settings and extensions are loaded.
	#[arg(skip)]
	pub profile:           Option<Str>,
	/// Install a shell wrapper for the selected profile and exit.
	#[arg(skip)]
	pub alias:             Option<Str>,
	/// Run deterministic native subsystem probes before chat startup.
	#[arg(long, global = true)]
	pub smoke_test:        bool,
	/// Open the interactive credential/model setup flow for an ACP client.
	#[arg(long = "acp-terminal-auth", global = true, hide = true)]
	pub acp_terminal_auth: bool,
	/// Typed contributed values excluded from prompt positionals.
	#[arg(skip)]
	pub contributed:       Vec<ContributedCliValue>,
}
fn omp_command(hide_launch_controls: bool) -> clap::Command {
	let command = OmpCli::command();
	if !hide_launch_controls {
		return command;
	}
	command
		.mut_arg("ext", |arg| arg.hide(true))
		.mut_arg("ext_overrides", |arg| arg.hide(true))
		.mut_arg("ext_only", |arg| arg.hide(true))
		.mut_arg("trusted_extension", |arg| arg.hide(true))
		.mut_arg("no_ext", |arg| arg.hide(true))
		.mut_arg("no_workspace_ext", |arg| arg.hide(true))
}

/// Production application commands.
/// Lock-safe storage maintenance options.
#[derive(Clone, Debug, Args)]
pub struct GcArgs {
	/// Override the profile data directory.
	#[arg(long, value_name = "PATH")]
	pub data_dir:     Option<PathBuf>,
	/// Override the session-journal directory.
	#[arg(long, value_name = "PATH")]
	pub sessions_dir: Option<PathBuf>,
	/// Apply destructive operations; omission is a dry run.
	#[arg(long)]
	pub apply:        bool,
	/// Emit machine-readable JSON.
	#[arg(long)]
	pub json:         bool,
}
/// Image blob-store inspection and maintenance options.
#[derive(Clone, Debug, Args)]
pub struct ImagesArgs {
	/// Blob-store operation.
	#[arg(value_enum)]
	pub action:  ImagesAction,
	/// Emit machine-readable JSON.
	#[arg(long)]
	pub json:    bool,
	/// Override the profile data directory containing the blob store.
	#[arg(long, value_name = "PATH")]
	pub dir:     Option<PathBuf>,
	/// Positive probe timeout in seconds.
	#[arg(long, value_name = "SECONDS")]
	pub timeout: Option<u64>,
}

/// Image blob-store operation.
#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum, serde::Serialize, strum::IntoStaticStr)]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase")]
pub enum ImagesAction {
	/// Show blob inventory and storage usage.
	Status,
	/// Verify the on-disk blob layout and every content digest.
	Doctor,
	/// Exercise a write, verified read, and cleanup against the real store.
	Probe,
}

/// Top-level extension installation shorthand.
#[derive(Clone, Debug, Args)]
pub struct InstallArgs {
	/// Local paths, signed index specifications, or marketplace references.
	#[arg(required = true, num_args = 1.., value_name = "TARGET")]
	pub targets: Vec<Str>,
	/// Emit machine-readable output.
	#[arg(long)]
	pub json:    bool,
	/// Reinstall already satisfied remote specifications.
	#[arg(long)]
	pub force:   bool,
	/// Show actions without changing extension state.
	#[arg(long)]
	pub dry_run: bool,
	/// Install-record scope.
	#[arg(long, value_enum, default_value_t = ExtScope::User)]
	pub scope:   ExtScope,
}

/// Non-interactive historical usage-statistics options.
#[derive(Clone, Debug, Args)]
pub struct StatsArgs {
	/// Emit the complete aggregate as machine-readable JSON.
	#[arg(short = 'j', long)]
	pub json:    bool,
	/// Print the human-readable aggregate (the default).
	#[arg(short = 's', long)]
	pub summary: bool,
}

/// Durable quota-history options.
#[derive(Clone, Debug, Args)]
pub struct UsageArgs {
	/// Override the profile data directory containing credentials and usage
	/// state.
	#[arg(long, value_name = "PATH")]
	pub data_dir:   Option<PathBuf>,
	/// Restrict snapshots to one provider.
	#[arg(long)]
	pub provider:   Option<Str>,
	/// Restrict snapshots to one opaque account identifier.
	#[arg(long)]
	pub account:    Option<Str>,
	/// Explicitly invalidate matching durable usage observations.
	#[arg(long)]
	pub invalidate: bool,
	/// Emit machine-readable JSON.
	#[arg(long)]
	pub json:       bool,
}

/// Benchmark workload selection.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Eq,
	PartialEq,
	ValueEnum,
	serde::Serialize,
	strum::Display,
	strum::IntoStaticStr,
)]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase")]
pub enum BenchProfile {
	/// Rotate deterministically through chat, prefill, and generation workloads.
	#[default]
	Mix,
	/// Balanced conversational latency and throughput.
	Chat,
	/// Large cache-busted input with a short response.
	Prefill,
	/// Small input with sustained output generation.
	Generation,
}

/// Normal inference benchmark options.
#[derive(Clone, Debug, Args)]
pub struct BenchArgs {
	/// Model key routed through the production inference registry.
	pub model:         Str,
	/// Override the profile data directory containing credentials.
	#[arg(long, value_name = "PATH")]
	pub data_dir:      Option<PathBuf>,
	/// Number of measured requests (defaults: mix 9, chat 10, prefill/generation
	/// 5).
	#[arg(long)]
	pub runs:          Option<u32>,
	/// Override the workload-specific maximum output tokens.
	#[arg(long)]
	pub max_tokens:    Option<u64>,
	/// Override the bundled chat or generation prompt.
	#[arg(long)]
	pub prompt:        Option<Str>,
	/// Benchmark workload.
	#[arg(long, value_enum, default_value_t)]
	pub profile:       BenchProfile,
	/// Synthetic filler bytes for prefill workloads (default: 32768).
	#[arg(long)]
	pub prefill_bytes: Option<usize>,
	/// Maximum concurrent requests.
	#[arg(long, default_value_t = 4)]
	pub par:           usize,
	/// Emit machine-readable JSON.
	#[arg(long)]
	pub json:          bool,
}

/// Deterministic OAuth account-pool simulation options.
#[derive(Clone, Debug, Args)]
pub struct DryBalanceArgs {
	/// Optional model selector; defaults to the first catalog model.
	pub model:       Option<Str>,
	/// Override the profile data directory containing credentials.
	#[arg(long, value_name = "PATH")]
	pub data_dir:    Option<PathBuf>,
	/// Number of selection samples.
	#[arg(long, default_value_t = 100)]
	pub count:       u32,
	/// Maximum live benchmark concurrency.
	#[arg(long, default_value_t = 32)]
	pub concurrency: usize,
	/// Send live completion requests after the simulation.
	#[arg(long)]
	pub bench:       bool,
	/// Emit machine-readable JSON.
	#[arg(long)]
	pub json:        bool,
}

/// Verified local tiny-model operator options.
#[derive(Clone, Debug, Args)]
pub struct TinyModelsArgs {
	/// Override the verified local-model cache root.
	#[arg(long, value_name = "PATH")]
	pub cache_dir: Option<PathBuf>,
	/// Tiny-model operation; omitted lists the catalog.
	#[command(subcommand)]
	pub command:   Option<TinyModelsCommand>,
}

/// Tiny-model catalog operations.
#[derive(Clone, Debug, Subcommand)]
pub enum TinyModelsCommand {
	/// List declared title and Mnemopi-only assets.
	List {
		/// Emit machine-readable JSON.
		#[arg(long)]
		json: bool,
	},
	/// Verify one model or every declared model.
	Verify {
		/// Stable model identifier.
		model: Option<String>,
		/// Emit machine-readable JSON.
		#[arg(long)]
		json:  bool,
	},
	/// Download one model or `all`, verify it, and atomically install it.
	Download {
		/// Stable model identifier or `all`.
		#[arg(default_value = "all")]
		model: String,
		/// Emit machine-readable JSON.
		#[arg(long)]
		json:  bool,
		/// Suppress transient progress.
		#[arg(long)]
		quiet: bool,
	},
}

/// Standalone onboarding and local-runtime setup options.
#[derive(Clone, Debug, Args)]
pub struct SetupArgs {
	/// Override the profile data directory.
	#[arg(long, value_name = "PATH")]
	pub data_dir: Option<PathBuf>,
	/// Setup operation; omitted runs onboarding.
	#[command(subcommand)]
	pub command:  Option<SetupCommand>,
}

/// Standalone setup operations.
#[derive(Clone, Debug, Subcommand)]
pub enum SetupCommand {
	/// Run provider/model onboarding.
	Wizard,
	/// Validate the supervised embedded Python runtime.
	Python {
		/// Emit machine-readable JSON.
		#[arg(long)]
		json: bool,
	},
	/// Inspect or download local STT/TTS assets.
	Speech {
		/// STT preset (`fast`, `balanced`, `turbo`, `parakeet`) or `kokoro`.
		model: Option<String>,
		/// Check every speech artifact without downloading.
		#[arg(long, short = 'c')]
		check: bool,
		/// Emit machine-readable JSON.
		#[arg(long)]
		json:  bool,
		/// Suppress transient progress.
		#[arg(long)]
		quiet: bool,
	},
}

/// Standalone Kokoro synthesis options.
#[derive(Clone, Debug, Args)]
pub struct SayArgs {
	/// Text to synthesize.
	pub text:            Option<Str>,
	/// Read text from a UTF-8 file instead of the positional argument.
	#[arg(long, value_name = "PATH", conflicts_with = "text")]
	pub file:            Option<PathBuf>,
	/// Override the profile data directory containing model assets.
	#[arg(long, value_name = "PATH")]
	pub data_dir:        Option<PathBuf>,
	/// Kokoro voice identifier.
	#[arg(long)]
	pub voice:           Option<String>,
	/// Stable local TTS model identifier.
	#[arg(long)]
	pub model:           Option<String>,
	/// Speaking-rate multiplier.
	#[arg(long, default_value_t = 1.0)]
	pub speed:           f32,
	/// Maximum approximate characters per synthesis pass.
	#[arg(long, default_value_t = 400)]
	pub max_chunk_chars: usize,
	/// Remove decoder noise for repeatable output.
	#[arg(long)]
	pub deterministic:   bool,
	/// Atomically write PCM16 WAV instead of playing through the default
	/// speaker.
	#[arg(long = "out", visible_alias = "output", short = 'o', value_name = "WAV")]
	pub output:          Option<PathBuf>,
}

/// Grievance operation selected by the positional action.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, ValueEnum)]
pub enum GrievanceAction {
	/// List the newest project findings.
	#[default]
	List,
	/// Delete one exact issue scope.
	Clean,
	/// Authenticate and upload every unacknowledged finding.
	Push,
}

/// Cross-session AutoQA grievance options.
#[derive(Clone, Debug, Args)]
pub struct GrievancesArgs {
	/// Operation to perform; bare `omp grievances` lists findings.
	#[arg(value_enum, default_value = "list")]
	pub action: GrievanceAction,
	/// Maximum number of newest findings to list.
	#[arg(short = 'n', long, default_value_t = 20)]
	pub limit:  usize,
	/// Filter list output or clean every finding for one tool/device.
	#[arg(short = 't', long)]
	pub tool:   Option<Str>,
	/// Clean one exact stable issue identifier.
	#[arg(long)]
	pub id:     Option<Str>,
	/// Clean the entire project issue inventory.
	#[arg(long)]
	pub all:    bool,
	/// Emit machine-readable JSON.
	#[arg(short = 'j', long)]
	pub json:   bool,
}

/// Stream category used by standalone TTSR matching.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, ValueEnum)]
pub enum TtsrSourceArg {
	/// Assistant visible text.
	#[default]
	Text,
	/// Assistant reasoning text.
	Thinking,
	/// Tool snapshot text.
	Tool,
}

/// Standalone TTSR options.
#[derive(Clone, Debug, Args)]
pub struct TtsrArgs {
	/// Workspace root used for rule discovery.
	#[arg(long, value_name = "PATH")]
	pub root:    Option<PathBuf>,
	/// TTSR operation; omitted lists active rules.
	#[command(subcommand)]
	pub command: Option<TtsrCommand>,
}

/// TTSR inspection and matching operations.
#[derive(Clone, Debug, Subcommand)]
pub enum TtsrCommand {
	/// List active rules.
	List {
		/// Emit machine-readable JSON.
		#[arg(long)]
		json: bool,
	},
	/// Test a snippet, file, or standard input.
	Test {
		/// Inline snippet; omit with `--file -` to read standard input.
		snippet: Option<String>,
		/// File to inspect, or `-` for standard input.
		#[arg(long, short = 'f')]
		file:    Option<PathBuf>,
		/// Restrict reported matches to one rule name.
		#[arg(long, short = 'r')]
		rule:    Option<String>,
		/// Stream category.
		#[arg(long, value_enum, default_value_t)]
		source:  TtsrSourceArg,
		/// Tool name for tool-stream matching.
		#[arg(long, default_value = "edit")]
		tool:    String,
		/// Candidate path used by glob and AST-language matching.
		#[arg(long, short = 'p')]
		path:    Option<String>,
		/// Include matched reminder content.
		#[arg(long, short = 'v')]
		verbose: bool,
		/// Emit machine-readable JSON.
		#[arg(long)]
		json:    bool,
	},
	/// Scan a directory with native walker ignore semantics.
	Scan {
		/// Directory to scan.
		#[arg(default_value = ".")]
		directory:    PathBuf,
		/// Restrict reported matches to one rule name.
		#[arg(long, short = 'r')]
		rule:         Option<String>,
		/// Ignore repository ignore files.
		#[arg(long)]
		no_gitignore: bool,
		/// Maximum bytes read from any candidate.
		#[arg(long, default_value_t = 4 * 1024 * 1024)]
		max_bytes:    u64,
		/// Emit machine-readable JSON.
		#[arg(long)]
		json:         bool,
	},
}

/// Core updater options.
#[derive(Clone, Debug, Args)]
pub struct UpdateArgs {
	/// Only report whether the selected channel has a newer release.
	#[arg(long, short = 'c', conflicts_with = "plugins")]
	pub check:     bool,
	/// Reinstall even when the selected release matches this binary.
	#[arg(long, short = 'f', conflicts_with = "plugins")]
	pub force:     bool,
	/// Upgrade extensions instead; equivalent to `omp ext upgrade`.
	#[arg(
		long,
		short = 'l',
		conflicts_with_all = ["check", "force", "canary", "stable", "index", "index_key"]
	)]
	pub plugins:   bool,
	/// Switch to the canary release channel and update.
	#[arg(long, conflicts_with_all = ["stable", "plugins", "index", "index_key"])]
	pub canary:    bool,
	/// Switch back to the stable release channel and update.
	#[arg(long, conflicts_with_all = ["canary", "plugins", "index", "index_key"])]
	pub stable:    bool,
	/// Offline/operator signed package-index override.
	#[arg(long, value_name = "JSON", conflicts_with_all = ["plugins", "canary", "stable"])]
	pub index:     Option<PathBuf>,
	/// Ed25519 key for the offline/operator index override.
	#[arg(long, value_name = "KEY", conflicts_with_all = ["plugins", "canary", "stable"])]
	pub index_key: Option<PathBuf>,
}

/// Read-only signed package registry options.
#[derive(Clone, Debug, Args)]
pub struct RegistryArgs {
	/// Offline/operator signed package-index override.
	#[arg(long, value_name = "JSON")]
	pub index:     Option<PathBuf>,
	/// Ed25519 key for the offline/operator index override.
	#[arg(long, value_name = "KEY")]
	pub index_key: Option<PathBuf>,
	/// Package identity to inspect.
	#[arg(long, default_value = "omp-cli")]
	pub package:   Str,
	/// Emit machine-readable JSON.
	#[arg(long)]
	pub json:      bool,
}

/// Standalone collaboration guest options.
#[derive(Clone, Debug, Args)]
pub struct JoinArgs {
	/// Collaboration link shared by the authoritative host.
	#[arg(value_name = "LINK")]
	pub link: Str,
}
/// Bounded checker discovery and file-disjoint repair options.
#[derive(Clone, Debug, Args)]
pub struct CleanseCliArgs {
	/// What to detect and fix; a discovery child determines exact checker argv.
	#[arg(value_name = "REQUEST")]
	pub request: Option<Str>,
	/// Maximum number of file-disjoint repair children.
	#[arg(long, short = 'n', default_value_t = 32)]
	pub agents:  usize,
	/// Repair and discovery model selector.
	#[arg(long, short = 'm', default_value = "@smol")]
	pub model:   Str,
	/// Include configured project test suites.
	#[arg(long, short = 't')]
	pub tests:   bool,
	/// Run every discovered checker without the target picker.
	#[arg(long, short = 'a')]
	pub all:     bool,
}

/// Semantic file compression options.
#[derive(Clone, Debug, Args)]
pub struct CompressCliArgs {
	/// Literal files or glob patterns to compress.
	#[arg(required = true, num_args = 1.., value_name = "FILE")]
	pub files:    Vec<Str>,
	/// Write an approved single-file draft to this path.
	#[arg(long, short = 'o')]
	pub out:      Option<PathBuf>,
	/// Overwrite every source only after its draft is approved.
	#[arg(long, short = 'i')]
	pub in_place: bool,
	/// Maximum draft rounds per file.
	#[arg(long, short = 'r', default_value_t = 3)]
	pub rounds:   u32,
	/// Files compressed concurrently.
	#[arg(long = "agents", short = 'n', default_value_t = 4)]
	pub agents:   usize,
	/// Compression model selector; absent uses the configured default.
	#[arg(long, short = 'm')]
	pub model:    Option<Str>,
}

/// Production application commands.
#[derive(Clone, Debug, Subcommand)]
pub enum Command {
	/// Install or serve the local Chrome CDP relay.
	#[command(name = "browser-relay")]
	BrowserRelay(BrowserRelayArgs),
	/// Generate one conventional commit from staged changes.
	Commit(CommitCliArgs),
	/// Start the inference gateway on a platform-native local endpoint.
	Serve(ServeArgs),
	/// Start the project environment daemon.
	Envd(EnvdArgs),
	/// Start an interactive project agent session.
	#[command(alias = "i", alias = "launch")]
	Chat(ChatArgs),
	/// Run a single prompt and stream its response to standard output.
	#[command(alias = "p")]
	Print(PrintArgs),
	/// Replay a durable session through the production transcript renderer.
	Render(RenderArgs),
	/// Run the stateful Content-Length framed RPC server on standard I/O.
	Rpc(RpcArgs),
	/// Run RPC with retained UI frame support.
	#[command(name = "rpc-ui")]
	RpcUi(RpcArgs),
	/// Run the Agent Client Protocol server over newline-delimited JSON.
	Acp(AcpArgs),
	/// Run one typed operation in process.
	Infer(InferArgs),
	/// Manage provider credentials.
	Auth(AuthArgs),
	/// Manage generated model-catalog data.
	Catalog(CatalogArgs),
	/// Run hardware-accelerated local inference.
	Local(LocalArgs),
	/// Manage Python extension resolution, trust, and site trees.
	#[command(alias = "plugin")]
	Ext(ExtArgs),
	/// Install or link extensions, classifying local paths automatically.
	Install(InstallArgs),
	/// Inspect image blob storage.
	#[command(alias = "img")]
	Images(ImagesArgs),
	/// Inspect or update the schema-validated application configuration.
	Config(ConfigArgs),
	/// Inspect and control Environment-supervised processes.
	Ps(PsArgs),
	/// Execute the canonical read tool from the command line.
	Read(ReadCliArgs),
	/// Execute the canonical web-search tool.
	#[command(alias = "q", alias = "web-search")]
	Search(SearchCliArgs),
	/// Open a persistent native shell console.
	Shell(ShellCliArgs),
	/// Reveal one provider credential through the audited operator boundary.
	Token(TokenArgs),
	/// Check or install a verified native OMP release.
	Update(UpdateArgs),
	/// Inspect the signed native package registry and platform assets.
	Registry(RegistryArgs),
	/// Inspect models from the validated embedded catalog.
	#[command(alias = "model")]
	Models(ModelsArgs),
	/// Inspect or clear Environment-owned worktrees.
	#[command(alias = "wt")]
	Worktree(WorktreeArgs),
	/// Inspect or apply lock-safe session and blob maintenance.
	Gc(GcArgs),
	/// Render native tool lifecycle cards to text or PNG fixtures.
	Gallery(GalleryArgs),
	/// Open the fullscreen Git workbench.
	#[command(
		after_long_help = "Examples:\n  omp git\n  omp git HEAD~2\n  omp git -C ~/projects/app"
	)]
	Git(GitArgs),
	/// Inspect or invalidate durable provider quota observations.
	Usage(UsageArgs),
	/// Aggregate historical usage from durable session journals.
	Stats(StatsArgs),
	/// Benchmark model chat, prefill, and generation TTFT/decode/cache
	/// performance.
	#[command(alias = "if-bench")]
	Bench(BenchArgs),
	/// Simulate account selection and optionally run a live balance benchmark.
	#[command(name = "dry-balance")]
	DryBalance(DryBalanceArgs),
	/// Manage verified local title and Mnemopi assets.
	#[command(name = "tiny-models")]
	TinyModels(TinyModelsArgs),
	/// Run onboarding, Python checks, or speech asset setup.
	Setup(SetupArgs),
	/// Synthesize text with local Kokoro and play or export it.
	Say(SayArgs),
	/// View, clean, or manually push reported tool issues.
	Grievances(GrievancesArgs),
	/// Manage scoped native SSH hosts and run bounded client operations.
	Ssh(SshArgs),
	/// Detect, repair, and verify native project diagnostics.
	Cleanse(CleanseCliArgs),
	/// Generate a static shell completion script.
	Completions {
		/// Target shell.
		#[arg(value_enum)]
		shell: CompletionShell,
	},
	/// Emit dynamic model or session completion candidates.
	#[command(name = "__complete", hide = true)]
	Complete {
		/// Candidate class.
		#[arg(value_enum)]
		kind:   CompletionKind,
		/// Optional fuzzy prefix after `--`.
		#[arg(last = true, default_value = "")]
		prefix: Str,
	},
	/// Rewrite text files into a dense telegraphic register.
	Compress(CompressCliArgs),
	/// Auth-broker verbs are retained as structured errors until a broker
	/// backend lands.
	#[command(name = "auth-broker")]
	AuthBroker(AuthBrokerArgs),
	/// Operate the credential-injecting inference gateway.
	#[command(name = "auth-gateway")]
	AuthGateway(AuthGatewayArgs),
}

/// Shell completion target.
#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
pub enum CompletionShell {
	/// Bash.
	Bash,
	/// Z shell.
	Zsh,
	/// Fish.
	Fish,
}
/// Bundled-agent materialization options.
#[derive(Clone, Debug, Args)]
pub struct AgentsArgs {
	/// Operation to perform.
	#[arg(value_enum, default_value = "unpack")]
	pub action:  AgentsAction,
	/// Overwrite existing definitions.
	#[arg(long)]
	pub force:   bool,
	/// Emit machine-readable JSON.
	#[arg(long)]
	pub json:    bool,
	/// Explicit target directory.
	#[arg(long, value_name = "PATH")]
	pub dir:     Option<PathBuf>,
	/// Write to the user discovery layer.
	#[arg(long, conflicts_with = "project")]
	pub user:    bool,
	/// Write to the project discovery layer.
	#[arg(long, conflicts_with = "user")]
	pub project: bool,
}

/// Bundled-agent operations.
#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
pub enum AgentsAction {
	/// Write bundled definitions to disk.
	Unpack,
}

/// Browser relay options.
#[derive(Clone, Debug, Args)]
pub struct BrowserRelayArgs {
	/// Relay operation.
	#[arg(value_enum, default_value = "serve")]
	pub action:   BrowserRelayAction,
	/// Loopback port.
	#[arg(long, default_value_t = 9224)]
	pub port:     u16,
	/// Loopback bind address used by the internal managed launcher.
	#[arg(long, default_value = "127.0.0.1", hide = true)]
	pub bind:     std::net::IpAddr,
	/// Run under machine-global consumer lease ownership.
	#[arg(long, hide = true)]
	pub managed:  bool,
	/// Optional extension authentication token.
	#[arg(long)]
	pub token:    Option<Str>,
	/// Extension installation directory.
	#[arg(long, value_name = "PATH")]
	pub dir:      Option<PathBuf>,
	/// Disable automatic grouping of driven tabs.
	#[arg(long)]
	pub no_group: bool,
	/// Print relay protocol diagnostics.
	#[arg(long)]
	pub verbose:  bool,
}

/// Browser relay operations.
#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
pub enum BrowserRelayAction {
	/// Run the loopback relay until interrupted.
	Serve,
	/// Materialize the Chrome extension bundle.
	Install,
}

/// Conventional commit workflow options.
#[derive(Clone, Debug, Args)]
pub struct CommitCliArgs {
	/// Push the committed branch after success.
	#[arg(long)]
	pub push:    bool,
	/// Preview the proposed commit without mutation.
	#[arg(long)]
	pub dry_run: bool,
	/// Commit generation model override.
	#[arg(long, short = 'm')]
	pub model:   Option<Str>,
}

/// Environment process supervisor options.
#[derive(Clone, Debug, Args)]
pub struct PsArgs {
	/// Supervisor operation.
	#[arg(value_enum, default_value = "list")]
	pub action:  PsAction,
	/// Process name for non-list operations.
	pub name:    Option<Str>,
	/// Emit machine-readable JSON.
	#[arg(long)]
	pub json:    bool,
	/// Disable the interactive monitor.
	#[arg(long)]
	pub plain:   bool,
	/// Include every discoverable project environment.
	#[arg(long)]
	pub all:     bool,
	/// Target another project directory.
	#[arg(long, value_name = "PATH")]
	pub dir:     Option<PathBuf>,
	/// Target a machine-global service scope.
	#[arg(long, value_name = "SERVICE")]
	pub global:  Option<Str>,
	/// Continue streaming log output.
	#[arg(long)]
	pub follow:  bool,
	/// Read logs from their retained beginning.
	#[arg(long)]
	pub head:    bool,
	/// Maximum rendered log rows.
	#[arg(long, default_value_t = 100)]
	pub lines:   u32,
	/// Regex log filter.
	#[arg(long)]
	pub grep:    Option<Str>,
	/// Grace period in seconds for stop.
	#[arg(long)]
	pub timeout: Option<u64>,
}

/// Process supervisor operations.
#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
pub enum PsAction {
	/// List processes.
	List,
	/// Describe one process.
	Info,
	/// Print one process's retained output.
	Logs,
	/// Gracefully stop one process.
	Stop,
	/// Immediately kill one process.
	Kill,
	/// Restart one process generation.
	Restart,
}
impl PsAction {
	pub(crate) const fn as_str(self) -> &'static str {
		match self {
			Self::List => "list",
			Self::Info => "info",
			Self::Logs => "logs",
			Self::Stop => "stop",
			Self::Kill => "kill",
			Self::Restart => "restart",
		}
	}
}

/// Standalone read-tool options.
#[derive(Clone, Debug, Args)]
pub struct ReadCliArgs {
	/// Path, URL, or internal URI passed to `read@2`.
	pub path: Str,
}

/// Standalone web-search options.
#[derive(Clone, Debug, Args)]
pub struct SearchCliArgs {
	/// Search query words.
	#[arg(required = true, num_args = 1..)]
	pub query:    Vec<String>,
	/// Explicit search provider.
	#[arg(long)]
	pub provider: Option<Str>,
	/// Relative recency constraint.
	#[arg(long, value_enum)]
	pub recency:  Option<SearchRecency>,
	/// Maximum returned sources.
	#[arg(long, short = 'l')]
	pub limit:    Option<u32>,
	/// Render one line per source.
	#[arg(long)]
	pub compact:  bool,
}

/// Search recency windows.
#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
pub enum SearchRecency {
	/// Previous day.
	Day,
	/// Previous week.
	Week,
	/// Previous month.
	Month,
	/// Previous year.
	Year,
}

/// Persistent shell-console options.
#[derive(Clone, Debug, Args)]
pub struct ShellCliArgs {
	/// Working directory for the console.
	#[arg(long, short = 'C')]
	pub cwd:         Option<PathBuf>,
	/// Per-command timeout in milliseconds.
	#[arg(long = "timeout", short = 't')]
	pub timeout_ms:  Option<u64>,
	/// Skip user-shell snapshot loading.
	#[arg(long)]
	pub no_snapshot: bool,
}

/// Provider credential projection options.
#[derive(Clone, Debug, Args)]
#[command(after_long_help = "Unattended credential stores require an explicit key source. Set \
                             OMP_LLM_KEY_SOURCE=local-file for an owner-only local encrypted \
                             store, or configure the platform keyring.")]
pub struct TokenArgs {
	/// Provider identifier.
	pub provider:      Str,
	/// Print the stored scalar without nested-token extraction.
	#[arg(long)]
	pub raw:           bool,
	/// Refresh renewable credentials before reveal.
	#[arg(long)]
	pub force_refresh: bool,
	/// One-based account selection.
	#[arg(long, short = 'a')]
	pub account:       Option<usize>,
	/// List active provider accounts without revealing secrets.
	#[arg(long, short = 'l')]
	pub list:          bool,
}

impl From<CompletionShell> for Shell {
	fn from(value: CompletionShell) -> Self {
		match value {
			CompletionShell::Bash => Self::Bash,
			CompletionShell::Zsh => Self::Zsh,
			CompletionShell::Fish => Self::Fish,
		}
	}
}

/// Inspect and prune Environment-owned isolated worktrees.
#[derive(Clone, Debug, Args)]
pub struct WorktreeArgs {
	/// Worktree inventory or cleanup operation.
	#[command(subcommand)]
	pub command: WorktreeCommand,
}

/// Worktree inventory and cleanup verbs.
#[derive(Clone, Debug, Subcommand)]
pub enum WorktreeCommand {
	/// List classified worktrees.
	List {
		/// Emit machine-readable JSON.
		#[arg(long)]
		json: bool,
		/// Include unregistered stray directories.
		#[arg(long)]
		all:  bool,
	},
	/// Remove orphaned worktrees, or every worktree with `--all`.
	Clear {
		/// Remove live worktrees as well as orphans.
		#[arg(long)]
		all:     bool,
		/// Report without deleting.
		#[arg(long)]
		dry_run: bool,
		/// Emit machine-readable JSON.
		#[arg(long)]
		json:    bool,
	},
}

/// Declarative root-command metadata shared by help and command normalization.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CommandSpec {
	/// Canonical root verb.
	pub name:    &'static str,
	/// Accepted aliases for the root verb.
	pub aliases: &'static [&'static str],
}

/// Complete registry for the commands implemented by this binary.
pub const COMMAND_REGISTRY: &[CommandSpec] = &[
	CommandSpec { name: "browser-relay", aliases: &[] },
	CommandSpec { name: "commit", aliases: &[] },
	CommandSpec { name: "serve", aliases: &[] },
	CommandSpec { name: "envd", aliases: &[] },
	CommandSpec { name: "chat", aliases: &["i", "launch"] },
	CommandSpec { name: "print", aliases: &["p"] },
	CommandSpec { name: "render", aliases: &[] },
	CommandSpec { name: "infer", aliases: &[] },
	CommandSpec { name: "rpc", aliases: &[] },
	CommandSpec { name: "rpc-ui", aliases: &[] },
	CommandSpec { name: "acp", aliases: &[] },
	CommandSpec { name: "auth", aliases: &[] },
	CommandSpec { name: "auth-broker", aliases: &[] },
	CommandSpec { name: "auth-gateway", aliases: &[] },
	CommandSpec { name: "catalog", aliases: &[] },
	CommandSpec { name: "local", aliases: &[] },
	CommandSpec { name: "ext", aliases: &["plugin"] },
	CommandSpec { name: "install", aliases: &[] },
	CommandSpec { name: "images", aliases: &["img"] },
	CommandSpec { name: "config", aliases: &[] },
	CommandSpec { name: "ps", aliases: &[] },
	CommandSpec { name: "read", aliases: &[] },
	CommandSpec { name: "search", aliases: &["q", "web-search"] },
	CommandSpec { name: "shell", aliases: &[] },
	CommandSpec { name: "token", aliases: &[] },
	CommandSpec { name: "update", aliases: &[] },
	CommandSpec { name: "registry", aliases: &[] },
	CommandSpec { name: "share", aliases: &[] },
	CommandSpec { name: "models", aliases: &["model"] },
	CommandSpec { name: "worktree", aliases: &["wt"] },
	CommandSpec { name: "stats", aliases: &[] },
	CommandSpec { name: "gc", aliases: &[] },
	CommandSpec { name: "gallery", aliases: &[] },
	CommandSpec { name: "git", aliases: &[] },
	CommandSpec { name: "usage", aliases: &[] },
	CommandSpec { name: "bench", aliases: &["if-bench"] },
	CommandSpec { name: "dry-balance", aliases: &[] },
	CommandSpec { name: "tiny-models", aliases: &[] },
	CommandSpec { name: "setup", aliases: &[] },
	CommandSpec { name: "say", aliases: &[] },
	CommandSpec { name: "grievances", aliases: &[] },
	CommandSpec { name: "ssh", aliases: &[] },
	CommandSpec { name: "cleanse", aliases: &[] },
	CommandSpec { name: "completions", aliases: &[] },
	CommandSpec { name: "__complete", aliases: &[] },
	CommandSpec { name: "compress", aliases: &[] },
];

/// Returns whether a root command shares the launch option surface.
fn is_launch_command(argument: &OsString) -> bool {
	matches!(
		argument.to_string_lossy().as_ref(),
		"chat" | "i" | "launch" | "print" | "p" | "rpc" | "rpc-ui" | "acp"
	)
}

/// Classifies options accepted by launch-shaped invocations.
///
/// The boolean indicates whether the bare option consumes its successor.
fn launch_option(argument: &OsString) -> Option<bool> {
	let argument = argument.to_string_lossy();
	let (name, inline) = argument
		.split_once('=')
		.map_or((argument.as_ref(), false), |(name, _)| (name, true));
	let consumes_value = matches!(
		name,
		"--cwd"
			| "--export"
			| "--ext"
			| "--ext-only"
			| "--extension"
			| "-e" | "--hook"
			| "--plugin-dir"
			| "--trusted-extension"
			| "--profile"
			| "--alias"
			| "--model"
			| "--project"
			| "--gateway"
			| "--resume"
			| "--fork"
			| "-r" | "--session"
			| "--session-dir"
			| "--thinking"
			| "--service-tier"
			| "--approval-mode"
			| "--max-time"
			| "--tools"
			| "--mode"
			| "--follow-up"
			| "--provider"
			| "--provider-session-id"
			| "--prompt-cache-key"
			| "--config"
			| "--add-dir"
			| "--smol"
			| "--slow"
			| "--plan"
			| "--models"
			| "--prewalk-into"
			| "--plan-yolo-into"
			| "--skills"
			| "--skill"
			| "--prompt-template"
			| "--theme"
			| "--use-theme"
			| "--api-key"
			| "--system-prompt"
			| "--append-system-prompt"
	);
	if consumes_value {
		return Some(!inline);
	}
	matches!(
		name,
		"--help"
			| "--version"
			| "--continue"
			| "-c" | "--no-ext"
			| "--no-extensions"
			| "--no-workspace-ext"
			| "--allow-home"
			| "--no-session"
			| "--py-eval"
			| "--print-thoughts"
			| "--acp-terminal-auth"
			| "--smoke-test"
			| "--plan-mode"
			| "--plan-yolo"
			| "--yolo"
			| "--auto-approve"
			| "--hide-thinking"
			| "--external-thinking"
			| "--from-claude"
			| "--from-codex"
			| "--prewalk"
			| "--no-prewalk"
			| "--advisor"
			| "--no-tools"
			| "--no-lsp"
			| "--no-pty"
			| "--no-skills"
			| "--no-prompt-templates"
			| "--no-context-files"
			| "--no-rules"
			| "--no-title"
	)
	.then_some(false)
}

/// Gateway serving options.
#[derive(Clone, Debug, Args)]
pub struct ServeArgs {
	/// Platform-local endpoint: a Unix socket path or Windows named-pipe name.
	#[arg(long = "endpoint", visible_aliases = ["uds", "pipe"], value_name = "LOCAL_ENDPOINT")]
	pub endpoint: LocalEndpoint,
	/// Override the directory containing daemon state.
	#[arg(long, value_name = "PATH")]
	pub data_dir: Option<PathBuf>,
}
/// Project environment-daemon options.
#[derive(Clone, Debug, Args)]
pub struct EnvdArgs {
	/// Workspace root exposed by the environment.
	#[arg(long, value_name = "PATH", default_value = ".")]
	pub root:             PathBuf,
	/// Owner-only environment socket. Defaults to `<state-dir>/env.sock`.
	#[arg(long, value_name = "PATH")]
	pub socket:           Option<PathBuf>,
	/// Document-server socket. An explicit live socket is attached; the default
	/// `<state-dir>/docserver.sock` must be unowned.
	#[arg(long, value_name = "PATH")]
	pub docserver_socket: Option<PathBuf>,
	/// Environment state directory. Defaults to a project-keyed directory under
	/// `OMP_DATA_DIR`.
	#[arg(long, value_name = "PATH")]
	pub state_dir:        Option<PathBuf>,
	/// Enable the built-in Python expression-evaluation tool.
	///
	/// This executes Python inside the environment owner's process sandbox and
	/// is disabled unless explicitly requested.
	#[arg(long)]
	pub py_eval:          bool,
	/// Seconds without connected apps before the daemon exits (0 disables).
	#[arg(long, value_name = "SECONDS", default_value_t = 900)]
	pub idle_timeout:     u64,
}
impl EnvdArgs {
	fn into_config(self) -> omp_envd::EnvdConfig {
		omp_envd::EnvdConfig {
			root:             self.root,
			socket:           self.socket,
			docserver_socket: self.docserver_socket,
			state_dir:        self.state_dir,
			py_eval:          self.py_eval,
			idle_timeout:     self.idle_timeout,
		}
	}
}

/// Typed prompt overrides shared by launch-shaped commands.
#[derive(Clone, Debug, Default, Args)]
pub struct PromptArgs {
	/// Select the prompt personality preset.
	#[arg(long, value_name = "PRESET")]
	pub personality:             Option<Str>,
	/// Surface the active model identifier in workstation facts.
	#[arg(long, value_name = "BOOL", num_args = 0..=1, default_missing_value = "true")]
	pub include_model_in_prompt: Option<bool>,
	/// Include Environment-owned workstation facts.
	#[arg(long, value_name = "BOOL", num_args = 0..=1, default_missing_value = "true")]
	pub include_workstation:     Option<bool>,
	/// Include a bounded workspace tree.
	#[arg(long, value_name = "BOOL", num_args = 0..=1, default_missing_value = "true")]
	pub include_workspace_tree:  Option<bool>,
	/// Permit Mermaid diagram rendering guidance.
	#[arg(long, value_name = "BOOL", num_args = 0..=1, default_missing_value = "true")]
	pub render_mermaid:          Option<bool>,
	/// Include enabled skills in prompt assembly.
	#[arg(
		long = "skills-enabled",
		value_name = "BOOL",
		num_args = 0..=1,
		default_missing_value = "true"
	)]
	pub skills_enabled:          Option<bool>,
	/// Replace customizable prompt slots from a file path or literal string.
	#[arg(long = "system-prompt", visible_alias = "system", value_name = "PATH_OR_TEXT")]
	pub custom_prompt:           Option<Str>,
	/// Append guidance from a file path or literal string.
	#[arg(
		long = "append-system-prompt",
		visible_aliases = ["append-prompt", "append-system"],
		value_name = "PATH_OR_TEXT"
	)]
	pub append_prompt:           Option<Str>,
	/// Explicitly bypass provider prompt items for developer and test use.
	#[arg(long)]
	pub null_prompt:             bool,
}

/// How native extension roots are composed for one launch.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum InvocationExtensionMode {
	/// Merge invocation roots with configured user and workspace roots.
	#[default]
	Merge,
	/// Use only invocation roots.
	ExplicitOnly,
	/// Disable native extension discovery for this invocation.
	Disabled,
}

/// Complete extension policy lowered from one invocation's root-global flags.
#[derive(Clone, Debug, Default)]
pub struct LaunchExtensions {
	/// Ordered local native roots supplied with `--extension`/`--plugin-dir`.
	pub native_roots: Vec<PathBuf>,
	/// Configured-root composition policy.
	pub mode:         InvocationExtensionMode,
	/// Suppress workspace extension roots while retaining the user layer.
	pub no_workspace: bool,
	/// Exact operator-trusted Python modules admitted for this invocation.
	pub trusted:      Vec<ExtHostSpec>,
	/// Declaration-owned typed CLI values delivered once at activation.
	pub contributed:  Vec<ContributedCliValue>,
	/// Inert manifest setting overrides validated during extension admission.
	pub settings:     Vec<omp_ext::config::CliSettingOverride>,
}

/// Extension controls accepted only by commands that launch an agent session.
#[derive(Clone, Debug, Default, Args)]
pub struct InvocationExtensionArgs {
	/// Enable an extension specification for this invocation.
	#[arg(
		long = "extension",
		short = 'e',
		visible_alias = "hook",
		value_name = "SPEC",
		conflicts_with = "no_ext"
	)]
	pub ext:               Vec<Str>,
	/// Override one manifest-declared extension setting for this invocation.
	#[arg(long = "ext", value_name = "ID.KEY=VALUE", value_parser = extension_setting_override)]
	pub ext_overrides:     Vec<omp_ext::config::CliSettingOverride>,
	/// Load only this local extension path for this invocation.
	#[arg(
		long = "plugin-dir",
		visible_alias = "ext-only",
		value_name = "PATH",
		conflicts_with = "no_ext"
	)]
	pub ext_only:          Vec<PathBuf>,
	/// Load exactly these absolute Python modules through the trusted
	/// supervisor.
	#[arg(
		long = "trusted-extension",
		hide = true,
		value_name = "ABSOLUTE_PATH",
		value_parser = trusted_extension_path,
		conflicts_with_all = ["ext", "ext_only", "no_ext"]
	)]
	pub trusted_extension: Vec<omp_envd::site::TrustedModule>,
	/// Suppress all configured extensions for this invocation.
	#[arg(
		long = "no-ext",
		visible_alias = "no-extensions",
		conflicts_with_all = ["ext", "ext_only", "trusted_extension"]
	)]
	pub no_ext:            bool,
	/// Suppress the workspace extension layer for this invocation.
	#[arg(long = "no-workspace-ext")]
	pub no_workspace_ext:  bool,
}

/// Interactive project-chat options.
#[derive(Clone, Debug, Args)]
pub struct ChatArgs {
	/// Extension controls for this session.
	#[command(flatten)]
	pub extensions:          InvocationExtensionArgs,
	/// Catalog model key, alias, or role.
	#[arg(long)]
	pub model:               Option<Str>,
	/// Provider preference for the selected model.
	#[arg(long)]
	pub provider:            Option<Str>,
	/// Fast/low-cost model-role selector.
	#[arg(long)]
	pub smol:                Option<Str>,
	/// Deep-reasoning model-role selector.
	#[arg(long)]
	pub slow:                Option<Str>,
	/// Planning model-role selector.
	#[arg(long)]
	pub plan:                Option<Str>,
	/// Ordered model selectors available for interactive cycling.
	#[arg(long)]
	pub models:              Option<SelectorList>,
	/// Provider session selector, never inferred from prompt text.
	#[arg(long = "provider-session-id")]
	pub provider_session:    Option<Str>,
	/// Project root whose environment and durable sessions are used.
	#[arg(long, value_name = "PATH", default_value = ".")]
	pub project:             PathBuf,
	/// Existing inference gateway endpoint. Omit to run inference in process.
	#[arg(long, value_name = "LOCAL_ENDPOINT")]
	pub gateway:             Option<LocalEndpoint>,
	/// Existing ULID session to reopen strictly.
	#[arg(long, short = 'r', visible_alias = "session", value_name = "ULID")]
	pub resume:              Option<Str>,
	/// Continue the most recent session for this terminal.
	#[arg(
		long = "continue",
		short = 'c',
		conflicts_with_all = ["resume", "fork", "no_session", "from_claude", "from_codex"]
	)]
	pub continue_session:    bool,
	/// Fork an existing session before opening the chat.
	#[arg(long, value_name = "SESSION", conflicts_with_all = ["resume", "continue_session", "no_session"])]
	pub fork:                Option<Str>,
	/// Import a Claude Code session interactively before opening the chat.
	#[arg(long = "from-claude", conflicts_with_all = ["from_codex", "resume", "continue_session", "fork", "no_session"])]
	pub from_claude:         bool,
	/// Import a Codex CLI session interactively before opening the chat.
	#[arg(long = "from-codex", conflicts_with_all = ["resume", "continue_session", "fork", "no_session"])]
	pub from_codex:          bool,
	/// Do not persist a durable session for this chat.
	#[arg(long, conflicts_with_all = ["resume", "continue_session", "fork"])]
	pub no_session:          bool,
	/// Override the native session storage directory.
	#[arg(long, value_name = "PATH")]
	pub session_dir:         Option<PathBuf>,
	/// Select provider reasoning effort with unambiguous prefix abbreviations.
	#[arg(long, value_parser = <ThinkingLevel as FromStr>::from_str)]
	pub thinking:            Option<ThinkingLevel>,
	/// Select the OpenAI-family service tier for this session.
	#[arg(long, value_parser = parse_service_tier)]
	pub service_tier:        Option<TierSetting>,
	/// Tool approval policy.
	#[arg(long)]
	pub approval_mode:       Option<ApprovalMode>,
	/// Approve every tool without asking; an explicit `--approval-mode` wins.
	#[arg(long = "auto-approve", alias = "yolo")]
	pub yolo:                bool,
	/// Stop after this strictly positive duration.
	#[arg(long)]
	pub max_time:            Option<CliDuration>,
	/// Restrict enabled tools to these normalized names.
	#[arg(long)]
	pub tools:               Option<ToolNames>,
	/// Disable every built-in tool.
	#[arg(long)]
	pub no_tools:            bool,
	/// Disable LSP tools, formatting, and diagnostics.
	#[arg(long)]
	pub no_lsp:              bool,
	/// Disable PTY-backed shell execution.
	#[arg(long)]
	pub no_pty:              bool,
	/// Enter read-only planning mode at startup.
	#[arg(long = "plan-mode")]
	pub plan_mode:           bool,
	/// Enter plan mode with one explicitly authorized mutation transition.
	#[arg(long = "plan-yolo", conflicts_with = "plan_mode")]
	pub plan_yolo:           bool,
	/// Model selector switched to once the plan-yolo plan is approved.
	#[arg(long = "plan-yolo-into", value_name = "SELECTOR", requires = "plan_yolo")]
	pub plan_yolo_into:      Option<Str>,
	/// Enter prewalk automation.
	#[arg(long)]
	pub prewalk:             bool,
	/// Disable configured prewalk automation.
	#[arg(long)]
	pub no_prewalk:          bool,
	/// Model selector used when prewalk begins.
	#[arg(long)]
	pub prewalk_into:        Option<Str>,
	/// Read-only command-stream cfg overlays in precedence order.
	#[arg(long = "config", value_name = "PATH")]
	pub config:              Vec<PathBuf>,
	/// Additional authorized workspace roots.
	#[arg(long = "add-dir", value_name = "PATH")]
	pub add_dir:             Vec<PathBuf>,
	/// Comma-separated skill glob filters.
	#[arg(long)]
	pub skills:              Option<SelectorList>,
	/// Additional skill file or directory for this invocation.
	#[arg(long = "skill", value_name = "PATH")]
	pub skill:               Vec<PathBuf>,
	/// Disable skill discovery.
	#[arg(long)]
	pub no_skills:           bool,
	/// Additional prompt-template file or directory for this invocation.
	#[arg(long = "prompt-template", value_name = "PATH")]
	pub prompt_template:     Vec<PathBuf>,
	/// Disable prompt-template discovery.
	#[arg(long)]
	pub no_prompt_templates: bool,
	/// Additional JSON theme file or directory for this invocation.
	#[arg(long = "theme", value_name = "PATH")]
	pub theme:               Vec<PathBuf>,
	/// Select a theme by registry name for this invocation.
	#[arg(long = "use-theme", value_name = "NAME")]
	pub use_theme:           Option<Str>,
	/// Disable repository context-file discovery.
	#[arg(long = "no-context-files")]
	pub no_context_files:    bool,
	/// Disable rule discovery.
	#[arg(long)]
	pub no_rules:            bool,
	/// Disable generated terminal titles.
	#[arg(long)]
	pub no_title:            bool,
	/// Enable the advisor watchdog runtime for this session.
	#[arg(long)]
	pub advisor:             bool,
	/// Ephemeral provider API key; never journaled or rendered by `Debug`.
	#[arg(long, value_parser = parse_cli_secret)]
	pub api_key:             Option<SecretString>,
	/// Ephemeral provider prompt-cache affinity.
	#[arg(long = "prompt-cache-key")]
	pub prompt_cache_key:    Option<Str>,
	#[arg(long)]
	/// Enable the built-in Python expression-evaluation tool for this chat's
	/// environment.
	pub py_eval:             bool,
	/// Detached daemon idle timeout used by isolated acceptance harnesses.
	#[arg(long, value_name = "SECONDS", hide = true)]
	pub envd_idle_timeout:   Option<u64>,
	/// Hide thinking blocks in the transcript for this invocation.
	#[arg(long = "hide-thinking")]
	pub hide_thinking:       bool,
	/// Force external thinking: provider reasoning off, hidden `think` tool on.
	/// Providers have flagged the resulting request shape as abuse risk, up to
	/// account-level enforcement.
	#[arg(long = "external-thinking")]
	pub external_thinking:   bool,
	/// Deployment-authenticated exact modules admitted by the CLI boundary.
	#[arg(skip)]
	pub extension_launch:    LaunchExtensions,
	/// Typed prompt settings and invocation overrides.
	#[command(flatten)]
	pub prompt_settings:     PromptArgs,
	/// Ordered initial messages; `@path` materializes context for the first.
	#[arg(num_args = 0..)]
	pub prompt:              Vec<Str>,
}

impl ChatArgs {
	/// Returns the default options for an interactive project chat.
	pub fn default_interactive() -> Self {
		Self {
			extensions:          InvocationExtensionArgs::default(),
			model:               None,
			provider:            None,
			smol:                None,
			slow:                None,
			plan:                None,
			models:              None,
			provider_session:    None,
			project:             ".".into(),
			gateway:             None,
			resume:              None,
			continue_session:    false,
			fork:                None,
			from_claude:         false,
			from_codex:          false,
			no_session:          false,
			session_dir:         None,
			thinking:            None,
			service_tier:        None,
			approval_mode:       None,
			yolo:                false,
			max_time:            None,
			tools:               None,
			no_tools:            false,
			no_lsp:              false,
			no_pty:              false,
			plan_mode:           false,
			plan_yolo:           false,
			plan_yolo_into:      None,
			prewalk:             false,
			no_prewalk:          false,
			prewalk_into:        None,
			config:              Vec::new(),
			add_dir:             Vec::new(),
			skills:              None,
			skill:               Vec::new(),
			no_skills:           false,
			prompt_template:     Vec::new(),
			no_prompt_templates: false,
			theme:               Vec::new(),
			use_theme:           None,
			no_context_files:    false,
			no_rules:            false,
			no_title:            false,
			advisor:             false,
			api_key:             None,
			prompt_cache_key:    None,
			py_eval:             false,
			envd_idle_timeout:   None,
			hide_thinking:       false,
			external_thinking:   false,
			extension_launch:    LaunchExtensions::default(),
			prompt_settings:     PromptArgs::default(),
			prompt:              Vec::new(),
		}
	}

	/// Effective tool approval policy: an explicit `--approval-mode` wins over
	/// the `--yolo`/`--auto-approve` shorthand.
	pub fn effective_approval(&self) -> Option<ApprovalMode> {
		self
			.approval_mode
			.or_else(|| self.yolo.then_some(ApprovalMode::Yolo))
	}
}
/// Non-interactive inference output options.
#[derive(Clone, Debug, Args)]
pub struct PrintArgs {
	/// Launch and session settings shared with interactive, RPC, and ACP modes.
	#[command(flatten)]
	pub launch:         ChatArgs,
	/// Emit newline-delimited JSON events rather than final text.
	#[arg(long, value_parser = ["text", "json"], default_value = "text")]
	pub mode:           String,
	/// Include streamed reasoning in text output.
	#[arg(long)]
	pub print_thoughts: bool,
	/// Additional user messages applied in order after the initial prompt.
	#[arg(long = "follow-up", value_name = "TEXT")]
	pub follow_ups:     Vec<Str>,
}

impl std::ops::Deref for PrintArgs {
	type Target = ChatArgs;

	fn deref(&self) -> &Self::Target {
		&self.launch
	}
}

/// Stateful headless RPC server options.
#[derive(Clone, Debug, Args)]
pub struct RpcArgs {
	/// Launch and session settings shared with interactive and print modes.
	#[command(flatten)]
	pub launch: ChatArgs,
}

impl std::ops::Deref for RpcArgs {
	type Target = ChatArgs;

	fn deref(&self) -> &Self::Target {
		&self.launch
	}
}

/// Agent Client Protocol stdio options.
#[derive(Clone, Debug, Args)]
pub struct AcpArgs {
	/// Launch and session settings shared with interactive and print modes.
	#[command(flatten)]
	pub launch: ChatArgs,
}

impl std::ops::Deref for AcpArgs {
	type Target = ChatArgs;

	fn deref(&self) -> &Self::Target {
		&self.launch
	}
}

/// Direct typed inference options.
#[derive(Clone, Debug, Args)]
pub struct InferArgs {
	/// Catalog model key.
	#[arg(long)]
	pub model:  Str,
	/// User prompt.
	#[arg(long)]
	pub prompt: Str,
}

/// Authentication command options.
#[derive(Clone, Debug, Args)]
pub struct AuthArgs {
	/// OMP data directory containing `credentials.db`.
	#[arg(long, value_name = "PATH")]
	pub data_dir: Option<PathBuf>,
	/// Authentication operation.
	#[command(subcommand)]
	pub command:  AuthCommand,
}

/// Typed authentication commands.
#[derive(Clone, Debug, Subcommand)]
pub enum AuthCommand {
	/// Begin an interactive provider login.
	Login {
		/// Target provider identifier.
		provider: Str,
	},
	/// List non-secret account summaries.
	List {
		/// Optional provider filter.
		#[arg(long)]
		provider: Option<Str>,
	},
	/// Show actionable credential status and lifecycle account selectors.
	Status {
		/// Optional provider filter.
		#[arg(long)]
		provider: Option<Str>,
	},
	/// Refresh one account.
	Refresh {
		/// Target account identifier.
		account: Str,
	},
	/// Remove one account.
	Logout {
		/// Target account identifier.
		account: Str,
	},
}

/// Application settings command tree.
#[derive(Clone, Debug, Args)]
pub struct ConfigArgs {
	/// Settings operation.
	#[command(subcommand)]
	pub command: ConfigCommand,
}

/// Writable native settings scope.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, ValueEnum)]
pub enum ConfigScope {
	/// User/profile settings.
	#[default]
	Global,
	/// Exact project `.omp/config.cfg`.
	Project,
}

/// Writable native MCP configuration scope.
#[derive(
	Clone, Copy, Debug, Default, Eq, PartialEq, ValueEnum, strum::Display, strum::IntoStaticStr,
)]
#[strum(serialize_all = "lowercase")]
pub enum McpConfigScope {
	/// User/profile-level `~/.o2/mcp.json`.
	Global,
	/// Project-owned `.omp/mcp.json`.
	#[default]
	Project,
	/// Project-root `.mcp.json`.
	Root,
}

/// Native MCP configuration operations.
#[derive(Clone, Debug, Subcommand)]
pub enum McpConfigCommand {
	/// List configured MCP servers.
	List {
		/// Restrict the listing to one native scope.
		#[arg(long, value_enum)]
		scope: Option<McpConfigScope>,
		/// Emit structured JSON.
		#[arg(long)]
		json:  bool,
	},
	/// Read one configured MCP server.
	Get {
		/// Server name.
		name: Str,
	},
	/// Add a validated MCP server from a JSON object.
	Add {
		/// Server name.
		name:   Str,
		/// MCP server JSON object.
		config: Str,
		/// Writable native scope.
		#[arg(long, value_enum, default_value_t)]
		scope:  McpConfigScope,
	},
	/// Insert or replace a validated MCP server from a JSON object.
	Update {
		/// Server name.
		name:   Str,
		/// MCP server JSON object.
		config: Str,
		/// Writable native scope.
		#[arg(long, value_enum, default_value_t)]
		scope:  McpConfigScope,
	},
	/// Remove an MCP server from one native scope.
	Remove {
		/// Server name.
		name:  Str,
		/// Writable native scope.
		#[arg(long, value_enum, default_value_t)]
		scope: McpConfigScope,
	},
	/// Enable a server, using a native override for read-only manifest sources.
	Enable {
		/// Server name.
		name: Str,
	},
	/// Disable a server, using a native override for read-only manifest sources.
	Disable {
		/// Server name.
		name: Str,
	},
}

/// Typed command-stream configuration operations.
#[derive(Clone, Debug, Subcommand)]
pub enum ConfigCommand {
	/// Convert legacy settings/keybindings and relocate data-root MCP config.
	Migrate,
	/// Print the deterministic current `config.cfg` script.
	Dump,
	/// Initialize canonical XDG roots and migrate recognized legacy storage
	/// without replacing existing destinations.
	#[command(name = "init-xdg")]
	InitXdg {
		/// Emit a machine-readable migration report.
		#[arg(long)]
		json: bool,
	},
	/// List convars with their values, defaults, and policy flags.
	List {
		/// Emit structured JSON.
		#[arg(long)]
		json: bool,
	},
	/// Read one convar.
	Get {
		/// Convar name.
		key: Str,
	},
	/// Set one convar after validating its typed value.
	Set {
		/// Convar name.
		key:   Str,
		/// Typed value.
		value: Str,
		/// Writable native scope.
		#[arg(long, value_enum, default_value_t)]
		scope: ConfigScope,
	},
	/// Restore one convar to its default in a writable cfg.
	Unset {
		/// Convar name.
		key:   Str,
		/// Writable native scope.
		#[arg(long, value_enum, default_value_t)]
		scope: ConfigScope,
	},
	/// Print a native cfg file path.
	Path {
		/// Writable native scope.
		#[arg(long, value_enum, default_value_t)]
		scope: ConfigScope,
	},
	/// Manage native MCP server configuration.
	Mcp {
		/// MCP operation.
		#[command(subcommand)]
		command: McpConfigCommand,
	},
}

/// Model catalog command tree.
#[derive(Clone, Debug, Args)]
pub struct ModelsArgs {
	/// Invocation-local extension launch controls used to compose provider
	/// declarations.
	#[command(flatten)]
	pub extensions: InvocationExtensionArgs,
	/// Catalog operation; omitted means list.
	#[command(subcommand)]
	pub command:    Option<ModelsCommand>,
	/// Optional provider/model/display-name filter for the default list
	/// operation.
	#[arg(value_name = "FILTER")]
	pub filter:     Option<Str>,
	/// Emit structured JSON for the default list operation.
	#[arg(long)]
	pub json:       bool,
	/// Pick one deterministic cycling role from matching rows.
	#[arg(long)]
	pub role:       Option<ModelRole>,
}

/// Model catalog operations.
#[derive(Clone, Debug, Subcommand)]
pub enum ModelsCommand {
	/// List catalog models, optionally narrowed by a fuzzy filter.
	#[command(alias = "ls")]
	List {
		/// Optional provider/model/display-name filter.
		filter: Option<Str>,
		/// Emit structured JSON.
		#[arg(long)]
		json:   bool,
		/// Pick one deterministic cycling role from matching rows.
		#[arg(long)]
		role:   Option<ModelRole>,
	},
	/// Search provider IDs, model keys, and display names case-insensitively.
	Find {
		/// Search text.
		pattern: Str,
		/// Emit structured JSON.
		#[arg(long)]
		json:    bool,
	},
	/// Force provider discovery refresh when a discovery backend is available.
	Refresh,
}

/// Combined provider/MCP credential-broker command tree.
#[derive(Clone, Debug, Args)]
pub struct AuthBrokerArgs {
	/// Override the profile data directory containing broker state.
	#[arg(long, value_name = "PATH")]
	pub data_dir: Option<PathBuf>,
	/// Broker operation.
	#[command(subcommand)]
	pub command:  AuthBrokerCommand,
}

/// Combined provider/MCP credential-broker operations.
#[derive(Clone, Debug, Subcommand)]
pub enum AuthBrokerCommand {
	/// Start the owner-local broker service.
	Serve {
		/// Platform-local socket or named-pipe endpoint.
		#[arg(long, value_name = "LOCAL_ENDPOINT")]
		endpoint: LocalEndpoint,
	},
	/// Print or rotate the owner-only broker token.
	Token {
		/// Replace the current bearer token.
		#[arg(long)]
		regenerate: bool,
	},
	/// Begin OAuth login for one provider.
	Login {
		/// Provider identifier.
		provider: Str,
		/// Configured SSH host alias running the remote broker.
		#[arg(long)]
		via:      Option<Str>,
		/// Print the native tunnel plan without connecting.
		#[arg(long)]
		dry_run:  bool,
	},
	/// Remove stored OAuth credentials for one provider.
	Logout {
		/// Provider identifier.
		provider: Str,
	},
	/// List available broker providers.
	List,
	/// Import credential material from a file.
	Import {
		/// Credential export path.
		path:             PathBuf,
		/// Override CLIProxyAPI type-to-provider mapping.
		#[arg(long)]
		provider:         Option<Str>,
		/// Import records marked disabled.
		#[arg(long)]
		include_disabled: bool,
		/// Validate and print the import plan without persisting.
		#[arg(long)]
		dry_run:          bool,
	},
	/// Apply store migrations and rotate every credential under the active key.
	Migrate {
		/// Report the number of credentials that would be re-encrypted.
		#[arg(long)]
		dry_run: bool,
	},
	/// Inspect broker health.
	Status,
}

/// Credential-injecting inference gateway options.
#[derive(Clone, Debug, Args)]
pub struct AuthGatewayArgs {
	/// Override the profile data directory containing gateway state.
	#[arg(long, value_name = "PATH")]
	pub data_dir: Option<PathBuf>,
	/// Gateway operation.
	#[command(subcommand)]
	pub command:  AuthGatewayCommand,
}

/// Credential-injecting gateway operations.
#[derive(Clone, Debug, Subcommand)]
pub enum AuthGatewayCommand {
	/// Start the bearer-authenticated TCP forward proxy.
	Serve {
		/// TCP bind address.
		#[arg(long, default_value = "127.0.0.1:4000", value_name = "HOST:PORT")]
		bind: SocketAddr,
	},
	/// Print or rotate the gateway bearer token.
	Token {
		/// Replace the current bearer token.
		#[arg(long)]
		regenerate: bool,
		/// Render machine-readable output.
		#[arg(long)]
		json:       bool,
	},
	/// Query the versioned gateway health handshake.
	Status {
		/// TCP gateway address.
		#[arg(long, default_value = "127.0.0.1:4000", value_name = "HOST:PORT")]
		bind: SocketAddr,
		/// Render machine-readable output.
		#[arg(long)]
		json: bool,
	},
	/// Probe every configured credential through the upstream provider.
	Check {
		/// TCP gateway address.
		#[arg(long, default_value = "127.0.0.1:4000", value_name = "HOST:PORT")]
		bind:   SocketAddr,
		/// Bypass cached health and require a live upstream HTTP probe.
		#[arg(long)]
		strict: bool,
		/// Render machine-readable output.
		#[arg(long)]
		json:   bool,
	},
}

/// Model-catalog command tree.
#[derive(Clone, Debug, Args)]
pub struct CatalogArgs {
	/// Catalog operation.
	#[command(subcommand)]
	pub command: CatalogCommand,
}

/// Model-catalog operations.
#[derive(Clone, Debug, Subcommand)]
pub enum CatalogCommand {
	/// Import catalog sources into normalized JSON.
	Import(CatalogImportArgs),
}

/// Catalog compiler inputs and normalized output.
#[derive(Clone, Debug, Args)]
pub struct CatalogImportArgs {
	/// Provider manifest TOML.
	#[arg(long, value_name = "TOML")]
	pub providers:   PathBuf,
	/// Secret-free OAuth flow manifest TOML.
	#[arg(long, value_name = "TOML")]
	pub oauth:       PathBuf,
	/// Compressed oracle model rows.
	#[arg(long, value_name = "ZST")]
	pub models:      PathBuf,
	/// Destination normalized JSON.
	#[arg(long, value_name = "JSON")]
	pub destination: PathBuf,
}

/// In-process local inference command tree.
#[derive(Clone, Debug, Args)]
pub struct LocalArgs {
	/// Local inference operation.
	#[command(subcommand)]
	pub command: LocalCommand,
}

/// Local inference operations.
#[derive(Clone, Debug, Subcommand)]
pub enum LocalCommand {
	/// Run local in-process inference.
	Infer(LocalInferArgs),
}

/// In-process Apple Foundation Models options.
#[derive(Clone, Debug, Args)]
pub struct LocalInferArgs {
	/// User prompt.
	#[arg(long)]
	pub prompt: Str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::IntoStaticStr)]
#[strum(serialize_all = "snake_case")]
enum DispatchTarget {
	BrowserRelay,
	Commit,
	Serve,
	Envd,
	Chat,
	Print,
	Render,
	Rpc,
	RpcUi,
	Acp,
	Infer,
	Auth,
	CatalogImport,
	LocalInfer,
	Ext,
	Install,
	Images,
	Config,
	Ps,
	Read,
	Search,
	ShellCli,
	Token,
	Update,
	Registry,
	Models,
	AuthBroker,
	AuthGateway,
	Worktree,
	Gc,
	Gallery,
	Git,
	Usage,
	Stats,
	Bench,
	DryBalance,
	TinyModels,
	Setup,
	Say,
	Grievances,
	Ssh,
	Cleanse,
	Completions,
	Complete,
	Compress,
}

const fn dispatch_target(command: Option<&Command>) -> DispatchTarget {
	match command {
		None | Some(Command::Chat(_)) => DispatchTarget::Chat,
		Some(Command::BrowserRelay(_)) => DispatchTarget::BrowserRelay,
		Some(Command::Commit(_)) => DispatchTarget::Commit,
		Some(Command::Print(_)) => DispatchTarget::Print,
		Some(Command::Render(_)) => DispatchTarget::Render,
		Some(Command::Rpc(_)) => DispatchTarget::Rpc,
		Some(Command::RpcUi(_)) => DispatchTarget::RpcUi,
		Some(Command::Acp(_)) => DispatchTarget::Acp,
		Some(Command::Serve(_)) => DispatchTarget::Serve,
		Some(Command::Envd(_)) => DispatchTarget::Envd,
		Some(Command::Infer(_)) => DispatchTarget::Infer,
		Some(Command::Auth(_)) => DispatchTarget::Auth,
		Some(Command::Catalog(CatalogArgs { command: CatalogCommand::Import(_) })) => {
			DispatchTarget::CatalogImport
		},
		Some(Command::Local(LocalArgs { command: LocalCommand::Infer(_) })) => {
			DispatchTarget::LocalInfer
		},
		Some(Command::Ext(_)) => DispatchTarget::Ext,
		Some(Command::Install(_)) => DispatchTarget::Install,
		Some(Command::Images(_)) => DispatchTarget::Images,
		Some(Command::Config(_)) => DispatchTarget::Config,
		Some(Command::Ps(_)) => DispatchTarget::Ps,
		Some(Command::Read(_)) => DispatchTarget::Read,
		Some(Command::Search(_)) => DispatchTarget::Search,
		Some(Command::Shell(_)) => DispatchTarget::ShellCli,
		Some(Command::Token(_)) => DispatchTarget::Token,
		Some(Command::Update(_)) => DispatchTarget::Update,
		Some(Command::Registry(_)) => DispatchTarget::Registry,
		Some(Command::Models(_)) => DispatchTarget::Models,
		Some(Command::Worktree(_)) => DispatchTarget::Worktree,
		Some(Command::Gc(_)) => DispatchTarget::Gc,
		Some(Command::Gallery(_)) => DispatchTarget::Gallery,
		Some(Command::Git(_)) => DispatchTarget::Git,
		Some(Command::Usage(_)) => DispatchTarget::Usage,
		Some(Command::Stats(_)) => DispatchTarget::Stats,
		Some(Command::Bench(_)) => DispatchTarget::Bench,
		Some(Command::DryBalance(_)) => DispatchTarget::DryBalance,
		Some(Command::TinyModels(_)) => DispatchTarget::TinyModels,
		Some(Command::Setup(_)) => DispatchTarget::Setup,
		Some(Command::Say(_)) => DispatchTarget::Say,
		Some(Command::Grievances(_)) => DispatchTarget::Grievances,
		Some(Command::Ssh(_)) => DispatchTarget::Ssh,
		Some(Command::Cleanse(_)) => DispatchTarget::Cleanse,
		Some(Command::Completions { .. }) => DispatchTarget::Completions,
		Some(Command::Complete { .. }) => DispatchTarget::Complete,
		Some(Command::Compress(_)) => DispatchTarget::Compress,
		Some(Command::AuthBroker(_)) => DispatchTarget::AuthBroker,
		Some(Command::AuthGateway(_)) => DispatchTarget::AuthGateway,
	}
}

fn chat_start(args: &mut ChatArgs) -> ChatStart {
	if args.resume.as_deref() == Some("__omp_picker__") {
		args.resume = None;
		ChatStart::SessionIndex
	} else {
		ChatStart::Session
	}
}

async fn run_interactive_chat(
	mut args: ChatArgs,
	extension_launch: LaunchExtensions,
	presentation: ChatPresentation,
) -> miette::Result<()> {
	args.extension_launch = extension_launch;
	let start = chat_start(&mut args);
	startup_notice::show_once(
		&omp_core::dirs::data_dir(None).into_diagnostic()?,
		args.model.as_ref(),
		args.thinking.map(<&'static str>::from),
		Eligibility {
			resume: args.resume.is_some() || args.continue_session || args.fork.is_some(),
			quiet:  false,
			timing: env::var_os("OMP_TIMING").is_some(),
		},
	)
	.into_diagnostic()?;
	Box::pin(chat_cmd::run(args, start, presentation)).await
}

fn extension_shorthand_args(command: ExtCommand, scope: ExtScope, json: bool) -> ExtArgs {
	ExtArgs {
		project: ".".into(),
		data_dir: None,
		store: None,
		cache: None,
		index: Vec::new(),
		index_keys: None,
		offline: false,
		locked: false,
		exclude_newer: None,
		disable: Vec::new(),
		grant: None,
		allow_build: false,
		sign_key: None,
		uv: None,
		targets: Vec::new(),
		trace: false,
		env_socket: None,
		layer: None,
		scope,
		json,
		verbose: false,
		command,
	}
}

fn looks_like_local_install_target(target: &str) -> bool {
	if target.starts_with('.') || target.starts_with('/') || target.starts_with('~') {
		return true;
	}
	let bytes = target.as_bytes();
	if bytes.len() >= 3
		&& bytes[0].is_ascii_alphabetic()
		&& bytes[1] == b':'
		&& matches!(bytes[2], b'/' | b'\\')
	{
		return true;
	}
	Path::new(target).try_exists().unwrap_or(false)
}

fn local_install_path(target: &str) -> PathBuf {
	if target == "~" {
		return omp_core::dirs::home_dir().unwrap_or_else(|| PathBuf::from(target));
	}
	if let Some(relative) = target
		.strip_prefix("~/")
		.or_else(|| target.strip_prefix("~\\"))
	{
		if let Some(home) = omp_core::dirs::home_dir() {
			return home.join(relative);
		}
	}
	PathBuf::from(target)
}

async fn install_shorthand(args: InstallArgs) -> miette::Result<()> {
	let mut remote = Vec::new();
	for target in args.targets {
		if looks_like_local_install_target(target.as_str()) {
			if args.dry_run {
				if args.json {
					println!("{}", serde_json::json!({"action":"link","target":target,"applied":false}));
				} else {
					println!("would link {}", target);
				}
				continue;
			}
			let command = ExtCommand::Link(ExtLinkArgs {
				path:       local_install_path(target.as_str()),
				tier:       ExtTier::Sandboxed,
				name:       None,
				features:   None,
				no_resolve: false,
			});
			ext_cli::run(extension_shorthand_args(command, args.scope, args.json)).await?;
		} else {
			remote.push(target);
		}
	}
	if remote.is_empty() {
		return Ok(());
	}
	let command = ExtCommand::Install(ExtInstallArgs {
		specs:          remote,
		tier:           ExtTier::Sandboxed,
		pool:           None,
		features:       None,
		capabilities:   None,
		yes:            false,
		dry_run:        args.dry_run,
		no_preresolved: false,
		target:         Vec::new(),
		no_lock:        false,
		force:          args.force,
	});
	ext_cli::run(extension_shorthand_args(command, args.scope, args.json)).await
}

fn command_extension_args(command: Option<&Command>) -> Option<&InvocationExtensionArgs> {
	match command {
		None => None,
		Some(Command::Chat(args)) => Some(&args.extensions),
		Some(Command::Print(args)) => Some(&args.launch.extensions),
		Some(Command::Rpc(args) | Command::RpcUi(args)) => Some(&args.launch.extensions),
		Some(Command::Acp(args)) => Some(&args.launch.extensions),
		Some(Command::Models(args)) => Some(&args.extensions),
		_ => None,
	}
}

fn lower_launch_extensions(
	cli: &OmpCli,
	command_args: Option<&InvocationExtensionArgs>,
) -> miette::Result<LaunchExtensions> {
	let nested_ext = command_args.map_or(&[][..], |args| args.ext.as_slice());
	let nested_ext_only = command_args.map_or(&[][..], |args| args.ext_only.as_slice());
	let nested_trusted = command_args.map_or(&[][..], |args| args.trusted_extension.as_slice());
	let nested_overrides = command_args.map_or(&[][..], |args| args.ext_overrides.as_slice());
	let nested_no_ext = command_args.is_some_and(|args| args.no_ext);
	let nested_no_workspace = command_args.is_some_and(|args| args.no_workspace_ext);
	let no_ext = cli.no_ext || nested_no_ext;
	let mode = if no_ext {
		InvocationExtensionMode::Disabled
	} else if cli.ext_only.is_empty() && nested_ext_only.is_empty() {
		InvocationExtensionMode::Merge
	} else {
		InvocationExtensionMode::ExplicitOnly
	};
	let mut native_roots = Vec::with_capacity(
		cli.ext.len() + nested_ext.len() + cli.ext_only.len() + nested_ext_only.len(),
	);
	if mode != InvocationExtensionMode::Disabled {
		for spec in cli.ext.iter().chain(nested_ext) {
			native_roots.push(invocation_extension_root(spec.as_str())?);
		}
		for root in cli.ext_only.iter().chain(nested_ext_only) {
			native_roots.push(canonical_extension_root(root)?);
		}
		native_roots.dedup();
	}
	Ok(LaunchExtensions {
		native_roots,
		mode,
		no_workspace: cli.no_workspace_ext || nested_no_workspace,
		trusted: cli
			.trusted_extension
			.iter()
			.chain(nested_trusted)
			.cloned()
			.map(trusted_extension)
			.collect(),
		contributed: cli.contributed.clone(),
		settings: cli
			.ext_overrides
			.iter()
			.chain(nested_overrides)
			.cloned()
			.collect(),
	})
}

fn invocation_extension_root(spec: &str) -> miette::Result<PathBuf> {
	let path = if let Some(path) = spec.strip_prefix("path:") {
		path
	} else if spec.split_once(':').is_some_and(|(scheme, _)| {
		scheme.len() > 1 && scheme.bytes().all(|byte| byte.is_ascii_alphabetic())
	}) {
		return Err(
			CliUsageError::new(format!(
				"invocation extension `{spec}` is not local; install signed sources with `omp ext \
				 install`"
			))
			.into(),
		);
	} else {
		spec
	};
	canonical_extension_root(Path::new(path))
}

fn canonical_extension_root(path: &Path) -> miette::Result<PathBuf> {
	let canonical = fs::canonicalize(path).map_err(|error| {
		CliUsageError::new(format!(
			"cannot resolve invocation extension `{}`: {error}",
			path.display()
		))
	})?;
	if canonical.is_dir() {
		return Ok(canonical);
	}
	if canonical.is_file()
		&& let Some(parent) = canonical.parent()
	{
		return Ok(parent.to_path_buf());
	}
	Err(
		CliUsageError::new(format!(
			"invocation extension `{}` is not a file or directory",
			path.display()
		))
		.into(),
	)
}

/// Parses the process arguments and dispatches the selected operation.
pub async fn run() -> miette::Result<()> {
	let arguments = env::args_os().collect::<Vec<_>>();
	let stdin_is_terminal = io::stdin().is_terminal() || omp_tui::tty_overridden();
	// Parse exactly once before selecting the stdin owner. In particular, RPC
	// and ACP keep their protocol stream untouched; ordinary non-TTY launches
	// read to EOF and only non-empty input promotes chat to print mode.
	let mut cli = match parse_arguments(arguments) {
		Ok(cli) => cli,
		Err(error)
			if matches!(
				error.kind(),
				clap::error::ErrorKind::DisplayHelp | clap::error::ErrorKind::DisplayVersion
			) =>
		{
			error.print().into_diagnostic()?;
			return Ok(());
		},
		Err(error) => {
			let rendered = error.to_string();
			let message = rendered.strip_prefix("error: ").unwrap_or(&rendered);
			let error = if error.kind() == clap::error::ErrorKind::InvalidSubcommand
				&& message.starts_with('`')
			{
				CliUsageError::redirect(message.to_owned())
			} else if message.starts_with("Invalid OMP profile")
				|| message.starts_with("--profile requires")
				|| message.starts_with("--alias requires")
			{
				CliUsageError::startup(message.to_owned())
			} else {
				CliUsageError::new(message.to_owned())
			};
			return Err(error.into());
		},
	};
	let piped_input = if stdin_is_terminal || !cli_accepts_piped_prompt(&cli) {
		None
	} else {
		read_piped_input().await
	};
	if piped_input.is_some() {
		promote_piped_launch(&mut cli);
	}
	dispatch_with_input(cli, piped_input).await
}

async fn read_piped_input() -> Option<Str> {
	read_nonempty_piped_input(tokio::io::stdin()).await
}

async fn read_nonempty_piped_input(mut input: impl tokio::io::AsyncRead + Unpin) -> Option<Str> {
	use tokio::io::AsyncReadExt as _;

	let mut bytes = Vec::new();
	input.read_to_end(&mut bytes).await.ok()?;
	match String::from_utf8(bytes) {
		Ok(text) => (!text.trim().is_empty()).then(|| Str::from(text)),
		Err(error) => {
			let text = String::from_utf8_lossy(error.as_bytes());
			(!text.trim().is_empty()).then(|| Str::new(text.as_ref()))
		},
	}
}

const fn command_owns_stdin(command: Option<&Command>) -> bool {
	matches!(command, Some(Command::Rpc(_) | Command::RpcUi(_) | Command::Acp(_)))
}

const fn command_accepts_piped_prompt(command: Option<&Command>) -> bool {
	matches!(command, None | Some(Command::Chat(_) | Command::Print(_)))
		&& !command_owns_stdin(command)
}

fn cli_accepts_piped_prompt(cli: &OmpCli) -> bool {
	!cli.version
		&& !cli.license
		&& !cli.smoke_test
		&& !cli.gui
		&& cli.export.is_none()
		&& cli.alias.is_none()
		&& command_accepts_piped_prompt(cli.command.as_ref())
}

fn promote_piped_launch(cli: &mut OmpCli) {
	let command = cli
		.command
		.take()
		.unwrap_or_else(|| Command::Chat(ChatArgs::default_interactive()));
	cli.command = Some(match command {
		Command::Chat(launch) => Command::Print(PrintArgs {
			launch,
			mode: "text".to_owned(),
			print_thoughts: false,
			follow_ups: Vec::new(),
		}),
		other => other,
	});
}

/// Dispatches one parsed command to its production implementation.
#[expect(
	clippy::future_not_send,
	reason = "chat dispatch preserves the thread-confined omp_tui::App future"
)]
pub async fn dispatch(cli: OmpCli) -> miette::Result<()> {
	dispatch_with_input(cli, None).await
}

#[expect(
	clippy::future_not_send,
	reason = "chat dispatch preserves the thread-confined omp_tui::App future"
)]
#[tracing::instrument(
	level = "debug",
	name = "cli_dispatch",
	skip_all,
	fields(command = <&'static str>::from(dispatch_target(cli.command.as_ref())))
)]
async fn dispatch_with_input(cli: OmpCli, piped_input: Option<Str>) -> miette::Result<()> {
	startup_notice::stop_watchdog();
	if let Some(alias) = cli.alias.as_deref() {
		let profile = cli
			.profile
			.as_deref()
			.ok_or_else(|| CliUsageError::startup("--alias requires --profile or OMP_PROFILE"))?;
		let installed = profile_alias::install(alias, profile, None).into_diagnostic()?;
		println!(
			"installed {} profile wrapper `{}` in {}",
			installed.shell,
			installed.name,
			installed.path.display()
		);
		return Ok(());
	}
	if cli.version {
		println!("{}", env!("CARGO_PKG_VERSION"));
		return Ok(());
	}
	if cli.license {
		write_license_output(io::stdout().lock()).into_diagnostic()?;
		return Ok(());
	}
	if let Some(cwd) = cli.cwd.as_deref() {
		env::set_current_dir(cwd).into_diagnostic()?;
	}
	if let Some(journal) = cli.export.as_deref() {
		let data_dir = omp_core::dirs::data_dir(None).into_diagnostic()?;
		let cwd = env::current_dir().into_diagnostic()?;
		let exported = crate::render_cmd::export_session(journal, &data_dir, &cwd)?;
		println!("Exported to: {}", exported.html.display());
		return Ok(());
	}
	if cli.smoke_test {
		return smoke_test::run().await;
	}
	let terminal_auth = cli.acp_terminal_auth;
	if !cli.allow_home
		&& (matches!(cli.command, None | Some(Command::Chat(_)))
			|| terminal_auth && matches!(cli.command, Some(Command::Acp(_))))
		&& is_home_dir()?
	{
		switch_from_home()?;
	}
	let gui = cli.gui;
	let launch_command = matches!(
		cli.command.as_ref(),
		None
			| Some(Command::Chat(_))
			| Some(Command::Print(_))
			| Some(Command::Rpc(_))
			| Some(Command::RpcUi(_))
			| Some(Command::Acp(_))
			| Some(Command::Models(_))
	);
	if !launch_command
		&& (!cli.ext.is_empty()
			|| !cli.ext_only.is_empty()
			|| !cli.trusted_extension.is_empty()
			|| cli.no_ext
			|| cli.no_workspace_ext
			|| !cli.contributed.is_empty()
			|| !cli.ext_overrides.is_empty())
	{
		return Err(
			CliUsageError::new(
				"extension launch controls are only valid for chat, print, RPC, ACP, or models",
			)
			.into(),
		);
	}
	let launch_extensions =
		lower_launch_extensions(&cli, command_extension_args(cli.command.as_ref()))?;
	let command = cli
		.command
		.unwrap_or_else(|| Command::Chat(ChatArgs::default_interactive()));
	if gui && !matches!(&command, Command::Chat(_)) {
		return Err(miette!("--gui is only supported by interactive chat"));
	}
	match command {
		Command::BrowserRelay(args) => crate::browser_relay_cmd::run(args).await,
		Command::Commit(args) => crate::commit_cmd::run(args).await,
		Command::Serve(args) => serve(args).await,
		Command::Envd(args) => {
			let project = std::fs::canonicalize(&args.root).into_diagnostic()?;
			let ctx = Arc::new(crate::process_ctx(&project)?);
			let bridges = omp_driver::bridges::builtin(
				&args.root,
				Arc::new(InferenceBridge::default()),
				AgentGoalControl::default(),
				None,
			);
			omp_envd::run(args.into_config(), ctx, bridges).await
		},
		Command::Chat(args) => {
			run_interactive_chat(
				args,
				launch_extensions,
				if gui {
					ChatPresentation::Gui
				} else {
					ChatPresentation::Terminal
				},
			)
			.await
		},
		Command::Print(mut args) => {
			args.launch.extension_launch = launch_extensions;
			print_mode::run(args, piped_input).await
		},
		Command::Render(args) => {
			render_cmd::run(args, &omp_core::dirs::data_dir(None).into_diagnostic()?)
		},
		Command::Rpc(mut args) => {
			args.launch.extension_launch = launch_extensions;
			rpc_mode::run(args, false).await
		},
		Command::RpcUi(mut args) => {
			args.launch.extension_launch = launch_extensions;
			rpc_mode::run(args, true).await
		},
		Command::Acp(mut args) => {
			if terminal_auth {
				run_interactive_chat(args.launch, launch_extensions, ChatPresentation::Terminal).await
			} else {
				args.launch.extension_launch = launch_extensions;
				acp_mode::run(args).await
			}
		},
		Command::Infer(args) => infer(args).await,
		Command::Auth(args) => auth(args).await,
		Command::Catalog(CatalogArgs { command: CatalogCommand::Import(args) }) => {
			catalog_import(&args)
		},
		Command::Local(LocalArgs { command: LocalCommand::Infer(args) }) => local_infer(args).await,
		Command::Ext(args) => ext_cli::run(args).await,
		Command::Install(args) => install_shorthand(args).await,
		Command::Images(args) => crate::images_cmd::run(args),
		Command::Config(args) => {
			config_cmd::run(&omp_core::dirs::data_dir(None).into_diagnostic()?, &args.command)
		},
		Command::Ps(args) => crate::ps_cmd::run(args).await,
		Command::Read(args) => crate::standalone_tool_cmd::read(args).await,
		Command::Search(args) => crate::standalone_tool_cmd::search(args).await,
		Command::Shell(args) => crate::shell_cmd::run(args).await,
		Command::Token(args) => crate::token_cmd::run(args).await,
		Command::Update(args) => update_cmd::run(args).await,
		Command::Registry(args) => update_cmd::registry(args),
		Command::Models(args) => models_cmd::run(&args, &launch_extensions).await,
		Command::Worktree(args) => {
			worktree_cmd::run(&omp_core::dirs::data_dir(None).into_diagnostic()?, &args)
		},
		Command::Gc(args) => gc_cmd::run(args).await,
		Command::Gallery(args) => gallery_cmd::run(args),
		Command::Git(args) => git_cmd::run(args).await,
		Command::Usage(args) => usage_cmd::run(args).await,
		Command::Stats(args) => stats_cmd::run(args),
		Command::Bench(args) => bench_cmd::run(args).await,
		Command::DryBalance(args) => dry_balance_cmd::run(args).await,
		Command::TinyModels(args) => tiny_models_cmd::run(args).await,
		Command::Setup(args) => setup_cmd::run(args).await,
		Command::Say(args) => say_cmd::run(args).await,
		Command::Grievances(args) => grievances_cmd::run(args).await,
		Command::Ssh(args) => ssh_cmd::run(args).await,
		Command::Cleanse(args) => {
			cleanse_cmd::run(CleanseArgs {
				agents:  args.agents,
				model:   args.model,
				tests:   args.tests,
				all:     args.all,
				request: args.request,
			})
			.await
		},
		Command::Completions { shell } => {
			let bytes = completions::script(shell.into());
			io::Write::write_all(&mut io::stdout(), &bytes).into_diagnostic()
		},
		Command::Complete { kind, prefix } => complete_cmd::run(kind, &prefix),
		Command::Compress(args) => {
			compress_cmd::run(CompressArgs {
				files:       args.files,
				model:       args.model,
				rounds:      args.rounds,
				concurrency: args.agents,
				out:         args.out,
				in_place:    args.in_place,
			})
			.await
		},
		Command::AuthBroker(args) => auth_broker_cmd::run(args).await,
		Command::AuthGateway(args) => auth_gateway_cmd::run(args).await,
	}
}

/// Parses process arguments after routing commands hidden behind launch
/// options and normalizing bare prompts. Stdin content is deliberately absent
/// from parsing; the process entry point assigns its single owner afterwards.
pub fn parse_from_os(arguments: impl IntoIterator<Item = OsString>) -> Result<OmpCli, clap::Error> {
	parse_arguments(arguments)
}

fn parse_arguments(arguments: impl IntoIterator<Item = OsString>) -> Result<OmpCli, clap::Error> {
	use clap::error::ErrorKind;
	let profile = profile_bootstrap::extract(arguments)
		.map_err(|error| clap::Error::raw(ErrorKind::InvalidValue, error.to_string()))?;
	omp_core::dirs::set_selected_profile(profile.profile.clone());
	let mut routed_arguments = profile.arguments;
	// Hoist a known command before extension bootstrap so launch-only roots
	// placed before a non-launch command are discarded without loading them.
	normalize_hidden_command(&mut routed_arguments);
	if let Some(message) = routing::redirect(&routed_arguments) {
		return Err(clap::Error::raw(ErrorKind::InvalidSubcommand, message.to_string()));
	}
	let mut bootstrap = bootstrap::run(routed_arguments, builtin_contribution_names())
		.map_err(|error| clap::Error::raw(ErrorKind::InvalidValue, error.to_string()))?;
	profile_bootstrap::remove_boundaries(&mut bootstrap.arguments);
	let mut arguments = bootstrap.arguments;
	normalize_hidden_command(&mut arguments);
	if let Some(index) = first_positional(&arguments) {
		if arguments[index] == "resume" {
			arguments[index] = OsString::from("chat");
			arguments.insert(index + 1, OsString::from("--resume=__omp_picker__"));
		} else if !(index == 1 && arguments[index] == "help")
			&& !is_command(&arguments[index])
			&& (matches!(arguments[index].to_str(), Some("--" | "-"))
				|| !arguments[index].to_string_lossy().starts_with('-'))
		{
			// Clap's generated root help command is special only in the leading
			// position; after launch flags, `help` is prompt text.
			arguments.insert(index, OsString::from("chat"));
		}
	}
	normalize_hidden_command(&mut arguments);
	normalize_transport_mode(&mut arguments);
	normalize_interactive_launch(&mut arguments);
	normalize_bare_resume(&mut arguments);
	let serve = first_positional(&arguments)
		.is_some_and(|index| arguments[index].to_string_lossy() == "serve");
	let matches = omp_command(serve).try_get_matches_from(arguments)?;
	let mut cli = OmpCli::from_arg_matches(&matches)?;
	if cli.license && cli.command.is_some() {
		return Err(clap::Error::raw(
			ErrorKind::ArgumentConflict,
			"--license cannot be combined with a command",
		));
	}
	cli.profile = profile.profile;
	cli.alias = profile.alias;
	cli.contributed = bootstrap.values;
	Ok(cli)
}

fn builtin_contribution_names() -> impl Iterator<Item = Str> {
	[
		"add-dir",
		"advisor",
		"alias",
		"allow-home",
		"api-key",
		"append-system-prompt",
		"approval-mode",
		"auto-approve",
		"config",
		"continue",
		"cwd",
		"export",
		"ext",
		"ext-only",
		"extension",
		"external-thinking",
		"fork",
		"from-claude",
		"from-codex",
		"gui",
		"help",
		"hide-thinking",
		"hook",
		"license",
		"max-time",
		"mode",
		"model",
		"models",
		"no-ext",
		"no-extensions",
		"no-lsp",
		"no-prewalk",
		"no-pty",
		"no-rules",
		"no-session",
		"no-skills",
		"no-title",
		"no-tools",
		"plan",
		"plan-mode",
		"plan-yolo",
		"plan-yolo-into",
		"plugin-dir",
		"prewalk",
		"prewalk-into",
		"print",
		"print-thoughts",
		"profile",
		"prompt-cache-key",
		"provider",
		"provider-session-id",
		"resume",
		"service-tier",
		"session",
		"session-dir",
		"skills",
		"slow",
		"smol",
		"system-prompt",
		"thinking",
		"tools",
		"trusted-extension",
		"version",
		"yolo",
	]
	.into_iter()
	.map(Str::new_static)
}

fn normalize_hidden_command(arguments: &mut Vec<OsString>) {
	if arguments.get(1).is_some_and(|argument| {
		matches!(argument.to_string_lossy().as_ref(), "--help" | "-h" | "--version" | "-V")
	}) {
		return;
	}
	let Some(command_index) = leading_command_index(arguments) else {
		return;
	};
	if arguments[command_index] == "-p" || arguments[command_index] == "--print" {
		arguments[command_index] = OsString::from("print");
	}
	if command_index == 1 {
		return;
	}
	let leading: Vec<OsString> = arguments.drain(1..command_index).collect();
	if is_launch_command(&arguments[1]) {
		arguments.splice(2..2, leading);
		return;
	}
	let mut kept = Vec::with_capacity(leading.len());
	let mut leading = leading.into_iter();
	while let Some(argument) = leading.next() {
		if let Some(consumes_value) = launch_option(&argument) {
			// The ambiguous short `-c` belongs to a hoisted non-launch command
			// (`omp -c update` means update --check). All long launch controls
			// are inapplicable there and are stripped.
			let retain = argument == "-c";
			if retain {
				kept.push(argument);
			}
			if consumes_value
				&& let Some(value) = leading.next()
				&& retain
			{
				kept.push(value);
			}
		} else {
			kept.push(argument);
		}
	}
	arguments.splice(2..2, kept);
}

fn leading_command_index(arguments: &[OsString]) -> Option<usize> {
	let mut index = 1;
	while index < arguments.len() {
		let argument = &arguments[index];
		if is_command(argument) || argument == "-p" || argument == "--print" {
			return Some(index);
		}
		if argument == "--" || !argument.to_string_lossy().starts_with('-') {
			return None;
		}
		index += 1 + usize::from(launch_option(argument) == Some(true));
	}
	None
}

fn first_positional(arguments: &[OsString]) -> Option<usize> {
	let mut index = 1;
	while index < arguments.len() {
		let argument = arguments[index].to_string_lossy();
		if argument == "--" || argument == "-" {
			return Some(index);
		}
		if launch_option(&arguments[index]) == Some(true) {
			index += 2;
			continue;
		}
		if argument.starts_with('-') {
			index += 1;
			continue;
		}
		return Some(index);
	}
	None
}

/// Routes a launch `--mode` transport value to its stdio server command.
///
/// `--mode rpc`, `--mode rpc-ui`, and `--mode acp` select the matching
/// transport command; `text` and `json` stay on `print`, which validates them
/// itself.
fn normalize_transport_mode(arguments: &mut Vec<OsString>) {
	let command = arguments
		.get(1)
		.map(|argument| argument.to_string_lossy().into_owned());
	let mut has_print = matches!(command.as_deref(), Some("print" | "p"));
	let has_chat = matches!(command.as_deref(), Some("chat" | "i" | "launch"));
	if !has_print && !has_chat && command.is_some_and(|command| is_command(&OsString::from(command)))
	{
		return;
	}
	if has_chat
		&& let Some(index) = arguments
			.iter()
			.enumerate()
			.skip(2)
			.find_map(|(index, argument)| (argument == "-p" || argument == "--print").then_some(index))
	{
		arguments.remove(index);
		arguments[1] = OsString::from("print");
		has_print = true;
	}
	let mut index = if has_print || has_chat { 2 } else { 1 };
	while index < arguments.len() {
		let argument = arguments[index].to_string_lossy();
		if argument == "--" {
			return;
		}
		let (name, inline) = argument
			.split_once('=')
			.map_or((argument.as_ref(), None), |(name, value)| (name, Some(value.to_owned())));
		if name == "--mode" {
			let value = match inline {
				Some(value) => value,
				None => match arguments.get(index + 1) {
					Some(value) => value.to_string_lossy().into_owned(),
					None => return,
				},
			};
			if matches!(value.as_str(), "text" | "json") {
				if has_chat {
					arguments[1] = OsString::from("print");
				}
				return;
			}
			if !matches!(value.as_str(), "rpc" | "rpc-ui" | "acp") {
				return;
			}
			let consumed = if argument.contains('=') { 1 } else { 2 };
			arguments.drain(index..index + consumed);
			if has_print || has_chat {
				arguments[1] = OsString::from(value);
			} else {
				arguments.insert(1, OsString::from(value));
			}
			return;
		}
		index +=
			1 + usize::from(!argument.contains('=') && launch_option(&arguments[index]) == Some(true));
	}
}

/// Returns whether a launch option alone should synthesize a chat command.
///
/// Root-position compatibility options already default to chat without an
/// explicit command and therefore do not participate in this predicate.
fn chat_launch_option(argument: &OsString) -> bool {
	if launch_option(argument).is_none() {
		return false;
	}
	let argument = argument.to_string_lossy();
	let name = argument
		.split_once('=')
		.map_or(argument.as_ref(), |(name, _)| name);
	!matches!(
		name,
		"--help"
			| "--version"
			| "-v" | "--cwd"
			| "--export"
			| "--ext"
			| "--ext-only"
			| "--extension"
			| "-e" | "--hook"
			| "--plugin-dir"
			| "--trusted-extension"
			| "--no-ext"
			| "--no-extensions"
			| "--no-workspace-ext"
			| "--allow-home"
			| "--smoke-test"
	)
}

/// Opens interactive chat for flag-only terminal invocations such as
/// `omp --model sonnet` or `omp -c`, which carry launch options that only a
/// launch-shaped command accepts.
fn normalize_interactive_launch(arguments: &mut Vec<OsString>) {
	if arguments.len() < 2
		|| first_positional(arguments).is_some()
		|| !arguments.iter().skip(1).any(chat_launch_option)
	{
		return;
	}
	arguments.insert(1, OsString::from("chat"));
}

fn normalize_bare_resume(arguments: &mut Vec<OsString>) {
	let mut index = 1;
	while index < arguments.len() {
		let argument = &arguments[index];
		if matches!(argument.to_str(), Some("--resume=" | "--session=")) {
			arguments[index] = OsString::from("--resume=__omp_picker__");
		} else if (argument == "--resume" || argument == "-r" || argument == "--session")
			&& arguments
				.get(index + 1)
				.is_none_or(|next| next.to_string_lossy().starts_with('-'))
		{
			arguments.insert(index + 1, OsString::from("__omp_picker__"));
			index += 1;
		}
		index += 1;
	}
}

fn is_command(argument: &OsString) -> bool {
	let argument = argument.to_string_lossy();
	COMMAND_REGISTRY
		.iter()
		.any(|entry| entry.name == argument || entry.aliases.contains(&argument.as_ref()))
}

fn trusted_extension_path(value: &str) -> Result<omp_envd::site::TrustedModule, String> {
	omp_envd::site::validate_trusted_module(Path::new(value)).map_err(|error| error.to_string())
}

/// Converts one exact operator-approved module into the deployment-owned
/// activation contract admitted by the extension supervisor.
///
/// A bare trusted module has no static OMP declaration metadata. The CLI trust
/// act authenticates its exact startup module and bytes, and explicitly allows
/// its frozen runtime registry to publish named declarations. Inter-extension
/// services and CONTROL quota classes stay empty because the trusted module
/// supplies no deployment-owned metadata for those sets.
pub fn trusted_extension(module: TrustedModule) -> ExtHostSpec {
	let encoded = hex::encode_n(module.artifact_digest.as_bytes());
	// Dashes, not dots: the id becomes a tool-revision family, whose
	// `name@family.rev` grammar reserves the dot.
	let extension_id = Str::from(format!("trusted-{}-{}", module.module, &encoded[..16]));
	let key = HostKey::new("invocation", "trusted", extension_id.clone());
	let provenance = omp_core::Provenance::new(
		Str::new_static("operator-cli"),
		extension_id,
		Str::new_static("cli"),
		module.artifact_digest,
		Str::new_static("invocation"),
		Str::new_static("trusted"),
		1,
	);
	let mut manifest = ExtensionManifest::new(
		provenance,
		module.module,
		[],
		DeclarationSet::default(),
		ServiceManifest::default(),
		[],
		[ActivationTrigger::FirstReach],
	);
	manifest.trust_runtime_declarations();
	let mut extension = ExtHostSpec::new(key, manifest);
	// A package `__init__.py` imports as its directory: the site root is the
	// directory CONTAINING the package, not the package itself.
	extension.python_site = if module
		.path
		.file_stem()
		.is_some_and(|stem| stem == "__init__")
	{
		module
			.path
			.parent()
			.and_then(Path::parent)
			.map(Path::to_path_buf)
	} else {
		module.path.parent().map(Path::to_path_buf)
	};
	extension.entry_path = Some(module.path);
	extension
}

fn is_home_dir() -> miette::Result<bool> {
	let Some(home) = env::var_os("HOME") else {
		return Ok(false);
	};
	Ok(env::current_dir().into_diagnostic()? == PathBuf::from(home))
}

fn switch_from_home() -> miette::Result<()> {
	let mut candidates = Vec::new();
	if let Some(home) = env::var_os("HOME") {
		candidates.push(PathBuf::from(home).join("tmp"));
	}
	candidates.extend([PathBuf::from("/tmp"), PathBuf::from("/var/tmp"), env::temp_dir()]);
	candidates.dedup();
	for candidate in candidates {
		if !candidate.exists() && fs::create_dir_all(&candidate).is_err() {
			continue;
		}
		if candidate.is_dir() && env::set_current_dir(&candidate).is_ok() {
			return Ok(());
		}
	}
	Err(miette!(
		"could not select a safe working directory outside HOME; pass --allow-home or --cwd"
	))
}

async fn serve(args: ServeArgs) -> miette::Result<()> {
	let config = args.data_dir.map_or_else(
		|| DaemonConfig::local(args.endpoint.clone()),
		|dir| DaemonConfig::local(args.endpoint.clone()).with_data_dir(dir),
	);
	let handle = DaemonHandle::start(config).await.into_diagnostic()?;
	handle.wait().await.into_diagnostic()?;
	Ok(())
}

async fn infer(args: InferArgs) -> miette::Result<()> {
	let data_dir = omp_core::dirs::data_dir(None).into_diagnostic()?;
	let store = omp_driver::registry::open_credential_store(data_dir.join("credentials.db"))
		.into_diagnostic()?;
	let registry = omp_driver::registry::production_registry(&data_dir, store)
		.await
		.into_diagnostic()?;
	let planner = router::Router::new(registry.clone(), time::Duration::from_secs(30));
	let meta = CallMeta {
		id:             RequestId::from(turn_id()),
		target:         Target::Model(ModelKey::from(args.model)),
		deadline:       None,
		budget:         ExecutionBudget::default(),
		session:        None,
		debug_session:  None,
		response_hooks: Default::default(),
	};
	let mut client = Client::new(registry.service(), planner, meta);
	let mut events = client
		.execute(chat_request(args.prompt))
		.await
		.into_diagnostic()?;
	let mut completed = false;
	let mut stdout = stdout();
	while let Some(event) = events.next().await {
		match event.into_diagnostic()? {
			ChatEvent::TextDelta { text, .. } => {
				stdout.write_all(text.as_bytes()).await.into_diagnostic()?;
			},
			ChatEvent::Completed(_) => completed = true,
			_ => {},
		}
	}
	if !completed {
		return Err(miette!("inference stream ended without completion"));
	}
	stdout.write_all(b"\n").await.into_diagnostic()?;
	stdout.flush().await.into_diagnostic()?;
	Ok(())
}

pub(crate) fn chat_request(prompt: Str) -> ChatRequest {
	chat_request_with_messages(
		vec![ContentPart::Text { text: prompt, proof: None }],
		Vec::new(),
		None,
	)
}

/// Builds a canonical request from typed initial attachments and ordered
/// follow-up messages, optionally prepending discovered system instructions.
pub(crate) fn chat_request_with_messages(
	initial: Vec<ContentPart>,
	follow_ups: Vec<Str>,
	system: Option<Str>,
) -> ChatRequest {
	let mut messages = Vec::with_capacity(usize::from(system.is_some()) + 1 + follow_ups.len());
	if let Some(text) = system {
		messages.push(Message {
			role:    Role::System,
			content: Arc::from([ContentPart::Text { text, proof: None }]),
			name:    None,
		});
	}
	messages.push(Message { role: Role::User, content: Arc::from(initial), name: None });
	messages.extend(follow_ups.into_iter().map(|text| Message {
		role:    Role::User,
		content: Arc::from([ContentPart::Text { text, proof: None }]),
		name:    None,
	}));
	ChatRequest {
		messages:          Arc::from(messages),
		tools:             Arc::from([]),
		hosted_tools:      Arc::from([]),
		tool_choice:       Setting::Unset,
		output:            Setting::Unset,
		reasoning:         Setting::Unset,
		verbosity:         Setting::Unset,
		cache_retention:   Setting::Unset,
		service_tier:      Setting::Unset,
		sampling:          Sampling::default(),
		max_output_tokens: None,
		top_logprobs:      None,
		safety:            Arc::from([]),
		negotiation:       NegotiationPolicy::default(),
		forced_call:       None,
	}
}

pub(crate) fn turn_id() -> String {
	let now = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.as_nanos();
	format!("omp-cli-{}-{now}", process::id())
}

async fn auth(args: AuthArgs) -> miette::Result<()> {
	let data = omp_core::dirs::data_dir(args.data_dir).into_diagnostic()?;
	auth_cli::run(data.join("credentials.db"), args.command).await
}

fn catalog_import(args: &CatalogImportArgs) -> miette::Result<()> {
	if same_path(&args.providers, &args.destination)
		|| same_path(&args.oauth, &args.destination)
		|| same_path(&args.models, &args.destination)
	{
		return Err(miette!("catalog inputs and destination must be different files"));
	}
	let providers = fs::read_to_string(&args.providers).into_diagnostic()?;
	let oauth = fs::read_to_string(&args.oauth).into_diagnostic()?;
	let models = fs::read(&args.models).into_diagnostic()?;
	let payload = compile_oracle(&providers, &models, &oauth)
		.into_diagnostic()?
		.normalized_json()
		.into_diagnostic()?;
	if let Some(parent) = args
		.destination
		.parent()
		.filter(|path| !path.as_os_str().is_empty())
	{
		fs::create_dir_all(parent).into_diagnostic()?;
	}
	fs::write(&args.destination, payload).into_diagnostic()?;
	Ok(())
}

fn same_path(left: &Path, right: &Path) -> bool {
	left == right
		|| left
			.canonicalize()
			.ok()
			.zip(right.canonicalize().ok())
			.is_some_and(|(left, right)| left == right)
}

#[cfg(feature = "local-applefm")]
async fn local_infer(args: LocalInferArgs) -> miette::Result<()> {
	let model = AppleFm::load().await.into_diagnostic()?;
	let mut events = model
		.stream(AppleFmOptions::new(args.prompt))
		.into_diagnostic()?;
	let mut completed = false;
	let mut stdout = stdout();
	while let Some(event) = events.next().await {
		match event.into_diagnostic()? {
			AppleFmEvent::Delta(text) => stdout.write_all(text.as_bytes()).await.into_diagnostic()?,
			AppleFmEvent::Finished(_) => completed = true,
		}
	}
	if !completed {
		return Err(miette!("local inference stream ended without completion"));
	}
	stdout.write_all(b"\n").await.into_diagnostic()?;
	stdout.flush().await.into_diagnostic()?;
	Ok(())
}

#[cfg(not(feature = "local-applefm"))]
fn local_infer(_args: LocalInferArgs) -> future::Ready<miette::Result<()>> {
	future::ready(Err(miette!("local inference requires the `local-applefm` feature")))
}

#[cfg(test)]
mod tests {

	use clap::error::ErrorKind;
	use omp_core::sf;

	use super::*;
	use crate::ext_cli::ExtCommand;

	fn parse(arguments: &[&str]) -> OmpCli {
		OmpCli::try_parse_from(arguments).expect("valid command")
	}

	#[test]
	fn parses_hidden_managed_relay_mode_and_ipv6_bind() {
		let Some(Command::BrowserRelay(args)) = parse(&[
			"omp",
			"browser-relay",
			"serve",
			"--managed",
			"--bind",
			"::1",
			"--port",
			"9333",
		])
		.command
		else {
			panic!("browser relay command");
		};
		assert!(args.managed);
		assert_eq!(args.bind, std::net::IpAddr::V6(std::net::Ipv6Addr::LOCALHOST));
		assert_eq!(args.port, 9333);
		let help = omp_command(false)
			.try_get_matches_from(["omp", "browser-relay", "--help"])
			.expect_err("help exits before parsing")
			.to_string();
		assert!(!help.contains("--managed"));
		assert!(!help.contains("--bind"));
	}

	#[test]
	fn parses_exclusive_embedded_license_flag() {
		let cli = parse(&["omp", "--license"]);
		assert!(cli.license);
		assert!(cli.command.is_none());
		let normalized = parse_arguments(["omp", "--license"].map(OsString::from)).expect("license");
		assert!(normalized.license);
		assert!(normalized.command.is_none());
		assert_eq!(
			parse_arguments(["omp", "--license", "bench", "provider/model"].map(OsString::from))
				.expect_err("license must be exclusive")
				.kind(),
			ErrorKind::ArgumentConflict
		);
	}

	#[test]
	fn license_output_contains_the_exact_embedded_assets() {
		let mut output = Vec::new();
		write_license_output(&mut output).expect("in-memory output");
		assert_eq!(
			String::from_utf8(output).expect("license output is UTF-8"),
			format!(
				"OMP License and Third-Party Notices\n\n{}\n\n{}\n",
				ROOT_LICENSE.trim_end(),
				THIRD_PARTY_NOTICES.trim_end()
			)
		);
	}

	#[test]
	fn parses_every_benchmark_profile_and_prefill_size() {
		for (name, expected) in [
			("mix", BenchProfile::Mix),
			("chat", BenchProfile::Chat),
			("prefill", BenchProfile::Prefill),
			("generation", BenchProfile::Generation),
		] {
			let cli = parse(&["omp", "bench", "provider/model", "--profile", name]);
			let Some(Command::Bench(args)) = cli.command else {
				panic!("bench command was not parsed");
			};
			assert_eq!(args.profile, expected);
		}
		let cli = parse(&[
			"omp",
			"bench",
			"provider/model",
			"--profile",
			"prefill",
			"--prefill-bytes",
			"4096",
		]);
		let Some(Command::Bench(args)) = cli.command else {
			panic!("bench command was not parsed");
		};
		assert_eq!(args.prefill_bytes, Some(4096));
		assert_eq!(
			OmpCli::try_parse_from(["omp", "bench", "provider/model", "--profile", "throughput",])
				.expect_err("unknown benchmark profile")
				.kind(),
			ErrorKind::InvalidValue
		);
	}

	#[cfg(unix)]
	const TEST_ENDPOINT: &str = "/tmp/omp.sock";
	#[cfg(windows)]
	const TEST_ENDPOINT: &str = r"\\.\pipe\omp-cli-test";

	#[test]
	fn bare_command_defaults_to_interactive_chat() {
		let cli = parse(&["omp"]);
		assert!(cli.command.is_none());
		assert_eq!(dispatch_target(cli.command.as_ref()), DispatchTarget::Chat);

		let args = ChatArgs::default_interactive();
		assert!(args.model.is_none());
		assert_eq!(args.project, PathBuf::from("."));
		assert!(args.gateway.is_none());
		assert!(args.resume.is_none());
		assert!(!args.py_eval);
	}

	#[test]
	fn parses_chat_without_model() {
		let Some(Command::Chat(args)) = parse(&["omp", "chat"]).command else {
			panic!("chat command");
		};
		assert!(args.model.is_none());
	}
	#[test]
	fn parses_headless_render_profile_flags() {
		let Some(Command::Render(args)) = parse(&[
			"omp",
			"render",
			"01K3A0",
			"--width",
			"96",
			"--timing",
			"--repaint",
			"3",
			"--plain",
		])
		.command
		else {
			panic!("render command");
		};
		assert_eq!(args.session.as_deref(), Some("01K3A0"));
		assert_eq!(args.width, Some(96));
		assert!(args.timing && args.plain);
		assert_eq!(args.repaint, Some(3));
		assert_eq!(dispatch_target(Some(&Command::Render(args))), DispatchTarget::Render);
	}

	#[test]
	fn parses_grievance_actions_and_selectors() {
		let Some(Command::Grievances(list)) = parse(&["omp", "grievances"]).command else {
			panic!("grievances list command");
		};
		assert_eq!(list.action, GrievanceAction::List);
		assert_eq!(list.limit, 20);
		assert_eq!(dispatch_target(Some(&Command::Grievances(list))), DispatchTarget::Grievances);

		let Some(Command::Grievances(clean)) =
			parse(&["omp", "grievances", "clean", "--id", "qa-a", "--all"]).command
		else {
			panic!("grievances clean command");
		};
		assert_eq!(clean.action, GrievanceAction::Clean);
		assert_eq!(clean.id.as_deref(), Some("qa-a"));
		assert!(clean.all);
	}
	#[test]
	fn parses_cleanse_and_compress_contracts() {
		let Some(Command::Cleanse(cleanse)) =
			parse(&["omp", "cleanse", "ts errors", "--agents", "8", "--tests"]).command
		else {
			panic!("cleanse command");
		};
		assert_eq!(cleanse.request.as_deref(), Some("ts errors"));
		assert_eq!(cleanse.agents, 8);
		assert_eq!(cleanse.model.as_str(), "@smol");
		assert!(cleanse.tests);
		assert_eq!(dispatch_target(Some(&Command::Cleanse(cleanse))), DispatchTarget::Cleanse,);

		let Some(Command::Compress(compress)) =
			parse(&["omp", "compress", "a.md", "b.md", "--in-place", "--rounds", "5"]).command
		else {
			panic!("compress command");
		};
		assert_eq!(compress.files, [Str::new("a.md"), Str::new("b.md")]);
		assert!(compress.in_place);
		assert_eq!(compress.rounds, 5);
		assert_eq!(compress.agents, 4);
		assert_eq!(dispatch_target(Some(&Command::Compress(compress))), DispatchTarget::Compress,);
	}

	#[test]
	fn parses_every_dispatch_branch() {
		let cases = [
			(&["omp", "serve", "--endpoint", TEST_ENDPOINT][..], DispatchTarget::Serve),
			(&["omp", "envd"][..], DispatchTarget::Envd),
			(
				&["omp", "chat", "--model", "provider/model", "--project", "."][..],
				DispatchTarget::Chat,
			),
			(&["omp", "rpc"][..], DispatchTarget::Rpc),
			(&["omp", "acp"][..], DispatchTarget::Acp),
			(
				&["omp", "infer", "--model", "provider/model", "--prompt", "hello"][..],
				DispatchTarget::Infer,
			),
			(&["omp", "auth", "list"][..], DispatchTarget::Auth),
			(
				&[
					"omp",
					"catalog",
					"import",
					"--providers",
					"providers.toml",
					"--oauth",
					"oauth.toml",
					"--models",
					"models.json.zst",
					"--destination",
					"catalog.json",
				][..],
				DispatchTarget::CatalogImport,
			),
			(&["omp", "local", "infer", "--prompt", "hello"][..], DispatchTarget::LocalInfer),
			(&["omp", "ext", "list"][..], DispatchTarget::Ext),
			(&["omp", "install", "publisher/example"][..], DispatchTarget::Install),
			(&["omp", "images", "status"][..], DispatchTarget::Images),
		];
		for (arguments, expected) in cases {
			assert_eq!(dispatch_target(parse(arguments).command.as_ref()), expected);
		}
	}
	#[test]
	fn parses_documented_standalone_command_surface() {
		let cases = [
			(&["omp", "browser-relay", "install"][..], DispatchTarget::BrowserRelay),
			(&["omp", "commit", "--dry-run"][..], DispatchTarget::Commit),
			(&["omp", "ps", "list", "--json"][..], DispatchTarget::Ps),
			(&["omp", "read", "src/main.rs:1-5"][..], DispatchTarget::Read),
			(&["omp", "search", "rust", "news"][..], DispatchTarget::Search),
			(&["omp", "q", "--recency", "week", "rust"][..], DispatchTarget::Search),
			(&["omp", "shell", "--timeout", "1000"][..], DispatchTarget::ShellCli),
			(&["omp", "token", "anthropic", "--list"][..], DispatchTarget::Token),
		];
		for (arguments, target) in cases {
			assert_eq!(dispatch_target(parse(arguments).command.as_ref()), target);
		}
	}
	#[test]
	fn literal_pi_launch_flag_oracle_is_reserved_by_the_cli() {
		// Literal oracle from pi
		// `packages/coding-agent/src/cli/flag-tables.ts`
		// STRING_SETTERS + OPTIONAL_FLAGS + VALUELESS_FLAGS. Short aliases are
		// represented by their long spellings because contribution names do
		// not carry dashes.
		const PI_LONG_FLAGS: &[&str] = &[
			"--cwd",
			"--config",
			"--add-dir",
			"--mode",
			"--fork",
			"--provider",
			"--model",
			"--smol",
			"--slow",
			"--plan",
			"--prewalk-into",
			"--plan-yolo-into",
			"--max-time",
			"--service-tier",
			"--api-key",
			"--system-prompt",
			"--append-system-prompt",
			"--provider-session-id",
			"--prompt-cache-key",
			"--session-dir",
			"--models",
			"--tools",
			"--thinking",
			"--export",
			"--hook",
			"--extension",
			"--trusted-extension",
			"--plugin-dir",
			"--skills",
			"--approval-mode",
			"--resume",
			"--session",
			"--help",
			"--version",
			"--allow-home",
			"--continue",
			"--from-claude",
			"--from-codex",
			"--no-session",
			"--no-tools",
			"--no-lsp",
			"--no-pty",
			"--hide-thinking",
			"--advisor",
			"--external-thinking",
			"--prewalk",
			"--no-prewalk",
			"--plan-yolo",
			"--print",
			"--print-thoughts",
			"--no-extensions",
			"--no-skills",
			"--no-rules",
			"--no-title",
			"--auto-approve",
			"--yolo",
		];
		fn collect(command: &clap::Command, flags: &mut Vec<String>) {
			for argument in command.get_arguments() {
				if let Some(long) = argument.get_long() {
					flags.push(format!("--{long}"));
				}
				for alias in argument.get_visible_aliases().into_iter().flatten() {
					flags.push(format!("--{alias}"));
				}
			}
			for child in command.get_subcommands() {
				collect(child, flags);
			}
		}
		// `--help` is Clap's generated action rather than a declared argument;
		// `--print` is normalized into the `print` command before Clap.
		let mut parsed = vec!["--help".to_owned(), "--print".to_owned(), "--yolo".to_owned()];
		collect(&omp_command(false), &mut parsed);
		let reserved = builtin_contribution_names().collect::<Vec<_>>();
		for flag in PI_LONG_FLAGS {
			let name = flag.trim_start_matches("--");
			assert!(parsed.iter().any(|parsed| parsed == flag), "pi launch flag {flag} is not parsed");
			assert!(
				reserved.iter().any(|reserved| reserved.as_str() == name),
				"pi launch flag {flag} is not reserved by omp"
			);
		}
	}

	#[test]
	fn parses_chat_composition_options() {
		let Some(Command::Chat(args)) = parse(&[
			"omp",
			"chat",
			"--model",
			"provider/model",
			"--project",
			"workspace",
			"--gateway",
			TEST_ENDPOINT,
			"--resume",
			"01ARZ3NDEKTSV4RRFFQ69G5FAV",
			"--py-eval",
			"--envd-idle-timeout",
			"2",
		])
		.command
		else {
			panic!("chat command");
		};
		assert_eq!(args.model, Some(sf!("provider/model")));
		assert_eq!(args.project, PathBuf::from("workspace"));
		assert_eq!(args.gateway.as_ref().map(LocalEndpoint::as_path), Some(Path::new(TEST_ENDPOINT)));
		assert_eq!(args.resume, Some(sf!("01ARZ3NDEKTSV4RRFFQ69G5FAV")));
		assert!(args.py_eval);
		assert_eq!(args.envd_idle_timeout, Some(2));
	}
	#[test]
	fn parses_ephemeral_inference_overrides_without_debugging_secret() {
		let conflict =
			&["omp", "print", "--continue", "--resume", "01ARZ3NDEKTSV4RRFFQ69G5FAV", "prompt"];
		assert_eq!(
			OmpCli::try_parse_from(conflict)
				.expect_err("conflicting session policy")
				.kind(),
			ErrorKind::ArgumentConflict
		);
		let Some(Command::Print(ephemeral)) =
			parse(&["omp", "print", "--no-session", "--session-dir", "sessions", "prompt"]).command
		else {
			panic!("ephemeral print command");
		};
		assert!(ephemeral.no_session);
		assert_eq!(ephemeral.session_dir, Some(PathBuf::from("sessions")));

		let Some(Command::Chat(chat)) = parse(&[
			"omp",
			"chat",
			"--model",
			"provider/model",
			"--api-key",
			"chat-secret-marker",
			"--prompt-cache-key",
			"chat-cache",
		])
		.command
		else {
			panic!("chat command");
		};
		assert!(chat.api_key.is_some());
		assert_eq!(chat.prompt_cache_key.as_deref(), Some("chat-cache"));
		assert!(!format!("{chat:?}").contains("chat-secret-marker"));

		let Some(Command::Print(print)) = parse(&[
			"omp",
			"print",
			"--model",
			"provider/model",
			"--api-key",
			"print-secret-marker",
			"--prompt-cache-key",
			"print-cache",
			"hello",
		])
		.command
		else {
			panic!("print command");
		};
		assert!(print.api_key.is_some());
		assert_eq!(print.prompt_cache_key.as_deref(), Some("print-cache"));
		assert!(!format!("{print:?}").contains("print-secret-marker"));
	}

	#[test]
	fn trusted_extension_builds_exact_startup_activation_contract() {
		let directory = tempfile::tempdir().unwrap();
		let path = directory.path().join("policy.py");
		fs::write(&path, b"activated = True\n").unwrap();
		let canonical = path.canonicalize().unwrap();

		let extension = trusted_extension(omp_envd::site::validate_trusted_module(&path).unwrap());
		assert_eq!(extension.manifest.entry, "policy");
		assert!(extension.manifest.declaration_modules.is_empty());
		assert_eq!(extension.manifest.declarations.tools().len(), 0);
		assert_eq!(extension.manifest.declarations.hooks().len(), 0);
		assert_eq!(extension.manifest.declarations.actions().len(), 0);
		assert_eq!(extension.manifest.services.provides().len(), 0);
		assert_eq!(extension.manifest.services.requires().len(), 0);
		assert!(extension.manifest.resource_limits.is_empty());
		assert!(extension.manifest.runtime_declarations_trusted());
		assert_eq!(
			extension.manifest.activation_triggers,
			[omp_envd::exthost::ActivationTrigger::FirstReach]
				.into_iter()
				.collect(),
		);
		assert_eq!(extension.python_site.as_deref(), canonical.parent());
		assert_eq!(extension.entry_path.as_deref(), Some(canonical.as_path()));
		assert_eq!(extension.key.layer(), "invocation");
		assert_eq!(extension.key.tier(), "trusted");

		let relative = OmpCli::try_parse_from(["omp", "--trusted-extension", "relative.py"])
			.expect_err("relative trusted modules must hard-fail");
		assert_eq!(relative.kind(), ErrorKind::ValueValidation);
		let missing = directory.path().join("missing.py");
		let missing = OmpCli::try_parse_from([
			OsString::from("omp"),
			OsString::from("--trusted-extension"),
			missing.into_os_string(),
		])
		.expect_err("missing trusted modules must hard-fail");
		assert_eq!(missing.kind(), ErrorKind::ValueValidation);
	}

	#[test]
	fn generic_ext_setting_parse_is_inert_until_admission() {
		let cli = parse(&["omp", "--ext", "demo.verbose=true"]);
		assert!(cli.trusted_extension.is_empty());
		let launch = lower_launch_extensions(&cli, command_extension_args(cli.command.as_ref()))
			.expect("inert launch lowering");
		assert!(launch.native_roots.is_empty());
		assert!(launch.trusted.is_empty(), "argv parsing must not compose an extension host");
		assert_eq!(launch.settings.len(), 1);
		assert_eq!(launch.settings[0].extension, "demo");
		assert_eq!(launch.settings[0].key, "verbose");
		assert_eq!(launch.settings[0].value, "true");
	}

	#[test]
	fn registered_plugin_alias_is_never_rejected_as_a_reserved_prompt_word() {
		let cli = parse_from_os(["omp", "plugin", "list"].map(OsString::from))
			.expect("plugin aliases the extension command");
		assert!(matches!(cli.command, Some(Command::Ext(_))));
		let error = parse_from_os(["omp", "list"].map(OsString::from))
			.expect_err("bare obsolete management word receives a redirect");
		assert_eq!(error.kind(), ErrorKind::InvalidSubcommand);
		let Some(Command::Chat(chat)) = parse_from_os(["omp", "--model", "list"].map(OsString::from))
			.expect("a reserved word used as a flag value is not a redirect")
			.command
		else {
			panic!("chat command");
		};
		assert_eq!(chat.model.as_deref(), Some("list"));
	}

	#[test]
	fn parses_ext_group_flags_and_subcommands() {
		let cli = parse(&[
			"omp",
			"--extension=publisher/example",
			"--ext=demo.verbose=true",
			"--plugin-dir",
			"local-ext",
			"--no-workspace-ext",
			"ext",
			"install",
			"--pool=shared",
			"--tier",
			"trusted",
			"--grant",
			"network",
			"publisher/example",
			"--",
			"literal-spec",
		]);
		assert_eq!(cli.ext, vec![sf!("publisher/example")]);
		assert_eq!(cli.ext_overrides, vec![omp_ext::config::CliSettingOverride {
			extension: sf!("demo"),
			key:       sf!("verbose"),
			value:     sf!("true"),
		}]);
		assert_eq!(cli.ext_only, vec![PathBuf::from("local-ext")]);
		assert!(cli.no_workspace_ext);
		let Some(Command::Ext(args)) = cli.command else {
			panic!("ext command");
		};
		assert_eq!(args.project, PathBuf::from("."));
		let ExtCommand::Install(install) = args.command else {
			panic!("ext install command");
		};
		assert_eq!(install.pool, Some(sf!("shared")));
		assert_eq!(install.specs, vec![sf!("publisher/example"), sf!("literal-spec")]);

		let verbose = parse_from_os(["omp", "plugin", "--verbose", "list"].map(OsString::from))
			.expect("plugin verbose");
		assert!(!verbose.version);
		let Some(Command::Ext(verbose)) = verbose.command else {
			panic!("plugin aliases the extension command");
		};
		assert!(verbose.verbose);

		let version = parse_from_os(["omp", "plugin", "-v", "list"].map(OsString::from))
			.expect("global short version");
		assert!(version.version);
		let Some(Command::Ext(version)) = version.command else {
			panic!("plugin aliases the extension command");
		};
		assert!(!version.verbose, "extension verbosity is long-only");

		for arguments in [
			&["omp", "ext", "list"][..],
			&["omp", "plugin", "list"][..],
			&["omp", "ext", "info", "example"][..],
			&["omp", "ext", "install", "example"][..],
			&["omp", "ext", "uninstall", "example"][..],
			&["omp", "ext", "link", "example-dir"][..],
			&["omp", "ext", "unlink", "example"][..],
			&["omp", "ext", "enable", "example"][..],
			&["omp", "ext", "disable", "example"][..],
			&["omp", "ext", "features", "example", "--list"][..],
			&["omp", "ext", "lock"][..],
			&["omp", "ext", "resolve", "example"][..],
			&["omp", "ext", "sync"][..],
			&["omp", "ext", "upgrade"][..],
			&["omp", "ext", "pin", "example", "1.0.0"][..],
			&["omp", "ext", "unpin", "example"][..],
			&["omp", "ext", "gc"][..],
			&["omp", "ext", "doctor"][..],
			&["omp", "ext", "trust", "example"][..],
			&["omp", "ext", "verify"][..],
			&["omp", "ext", "bundle", "extensions.ompb"][..],
			&["omp", "ext", "publish"][..],
			&["omp", "ext", "search", "example"][..],
			&["omp", "ext", "index", "list"][..],
			&["omp", "ext", "where"][..],
			&["omp", "ext", "index", "add", "primary", "https://index.example"][..],
			&["omp", "ext", "index", "remove", "primary"][..],
		] {
			assert!(matches!(parse(arguments).command, Some(Command::Ext(_))), "{arguments:?}");
		}
		let installed = parse_from_os(
			[
				"omp",
				"install",
				"--force",
				"--dry-run",
				"--scope=project",
				"publisher/example",
				"./local",
			]
			.map(OsString::from),
		)
		.expect("top-level install");
		let Some(Command::Install(args)) = installed.command else {
			panic!("install command");
		};
		assert_eq!(args.targets, [sf!("publisher/example"), sf!("./local")]);
		assert!(args.force && args.dry_run);
		assert_eq!(args.scope, ExtScope::Project);
		assert!(!looks_like_local_install_target("publisher/example"));
		assert!(looks_like_local_install_target("./local"));
		assert!(looks_like_local_install_target("~/local"));
		assert!(looks_like_local_install_target(r"C:\local"));
	}

	#[test]
	fn parses_images_actions_alias_and_flags() {
		let Some(Command::Images(args)) =
			parse(&["omp", "img", "status", "--dir", "profile"]).command
		else {
			panic!("images command");
		};
		assert_eq!(args.action, ImagesAction::Status);
		assert_eq!(args.dir, Some(PathBuf::from("profile")));

		for action in ["status", "doctor", "probe"] {
			assert!(matches!(parse(&["omp", "images", action]).command, Some(Command::Images(_))));
		}
	}

	#[test]
	fn acp_terminal_auth_flag_is_retained_for_dispatch() {
		let cli = parse(&["omp", "acp", "--acp-terminal-auth"]);
		assert!(cli.acp_terminal_auth);
		assert!(matches!(cli.command, Some(Command::Acp(_))));

		let default = parse(&["omp", "--acp-terminal-auth"]);
		assert!(default.acp_terminal_auth);
		assert!(default.command.is_none());
	}

	#[test]
	fn lowers_invocation_extension_policy_without_dropping_suppression() {
		let directory = tempfile::tempdir().expect("extension root");
		let cli = OmpCli::try_parse_from([
			OsString::from("omp"),
			OsString::from("--ext-only"),
			directory.path().as_os_str().to_owned(),
			OsString::from("--no-workspace-ext"),
			OsString::from("chat"),
		])
		.expect("invocation extension flags");
		let lowered = lower_launch_extensions(&cli, command_extension_args(cli.command.as_ref()))
			.expect("lowered launch policy");
		assert_eq!(lowered.mode, InvocationExtensionMode::ExplicitOnly);
		assert!(lowered.no_workspace);
		assert_eq!(lowered.native_roots, vec![
			directory.path().canonicalize().expect("canonical root")
		]);
	}

	#[test]
	fn plugin_dir_alias_selects_explicit_extension_mode() {
		let directory = tempfile::tempdir().expect("extension root");
		let cli = OmpCli::try_parse_from([
			OsString::from("omp"),
			OsString::from("chat"),
			OsString::from("--plugin-dir"),
			directory.path().as_os_str().to_owned(),
		])
		.expect("plugin directory");
		let lowered = lower_launch_extensions(&cli, command_extension_args(cli.command.as_ref()))
			.expect("explicit launch policy");
		assert_eq!(lowered.mode, InvocationExtensionMode::ExplicitOnly);
		assert_eq!(lowered.native_roots, vec![
			directory.path().canonicalize().expect("canonical root")
		]);
	}

	#[test]
	fn extension_launch_flags_are_only_advertised_on_launch_commands() {
		let compress_help = OmpCli::try_parse_from(["omp", "compress", "--help"])
			.expect_err("help exits through clap")
			.to_string();
		assert!(!compress_help.contains("--plugin-dir"));
		assert!(!compress_help.contains("--trusted-extension"));
		assert!(!compress_help.contains("--no-ext"));
		let compressed = parse_arguments(
			["omp", "--plugin-dir", "/tmp/demo", "compress", "file.txt"].map(OsString::from),
		)
		.expect("inapplicable leading launch controls are stripped");
		assert!(matches!(compressed.command, Some(Command::Compress(_))));

		let chat_help = OmpCli::try_parse_from(["omp", "chat", "--help"])
			.expect_err("help exits through clap")
			.to_string();
		assert!(chat_help.contains("--plugin-dir"));
		assert!(!chat_help.contains("--trusted-extension"));
		assert!(chat_help.contains("--no-extensions"));
	}

	#[test]
	fn rejects_unknown_ext_flags_as_usage_errors() {
		let error = OmpCli::try_parse_from(["omp", "ext", "list", "--unrecognized"])
			.expect_err("unknown extension flag must be rejected");
		assert_eq!(error.kind(), ErrorKind::UnknownArgument);
		assert_eq!(error.exit_code(), 2);
		assert!(error.to_string().contains("Usage:"));
	}

	#[test]
	fn disabling_flags_can_override_selected_resources() {
		let Some(Command::Chat(args)) = parse(&[
			"omp",
			"chat",
			"--tools=read,grep",
			"--no-tools",
			"--skills=git-*",
			"--no-skills",
			"--prewalk",
			"--no-prewalk",
		])
		.command
		else {
			panic!("chat command");
		};
		assert!(args.tools.is_some());
		assert!(args.no_tools);
		assert!(args.skills.is_some());
		assert!(args.no_skills);
		assert!(args.prewalk);
		assert!(args.no_prewalk);
	}

	#[test]
	fn parses_one_shot_resource_controls() {
		let cli = parse(&[
			"omp",
			"chat",
			"--no-context-files",
			"--no-prompt-templates",
			"--use-theme",
			"ocean",
			"--skill",
			"review/SKILL.md",
			"--skill",
			"debug",
			"--prompt-template",
			"review.md",
			"--theme",
			"ocean.json",
		]);
		let Some(Command::Chat(args)) = cli.command else {
			panic!("chat command");
		};
		assert!(args.no_context_files);
		assert!(args.no_prompt_templates);
		assert_eq!(args.use_theme.as_deref(), Some("ocean"));
		assert_eq!(args.skill, [PathBuf::from("review/SKILL.md"), PathBuf::from("debug")]);
		assert_eq!(args.prompt_template, [PathBuf::from("review.md")]);
		assert_eq!(args.theme, [PathBuf::from("ocean.json")]);
	}

	#[test]
	fn parses_prompt_override_surface() {
		let cli = parse(&[
			"omp",
			"chat",
			"--personality=pragmatic",
			"--include-model-in-prompt=false",
			"--include-workstation",
			"--include-workspace-tree",
			"--render-mermaid=false",
			"--skills-enabled=false",
			"--system-prompt=SYSTEM.md",
			"--append-prompt=extra",
			"--null-prompt",
		]);
		let Some(Command::Chat(args)) = cli.command else {
			panic!("chat command");
		};
		assert_eq!(args.prompt_settings.personality.as_deref(), Some("pragmatic"));
		assert_eq!(args.prompt_settings.include_model_in_prompt, Some(false));
		assert_eq!(args.prompt_settings.include_workstation, Some(true));
		assert_eq!(args.prompt_settings.include_workspace_tree, Some(true));
		assert_eq!(args.prompt_settings.render_mermaid, Some(false));
		assert_eq!(args.prompt_settings.skills_enabled, Some(false));
		assert_eq!(args.prompt_settings.custom_prompt.as_deref(), Some("SYSTEM.md"));
		assert_eq!(args.prompt_settings.append_prompt.as_deref(), Some("extra"));
		assert!(args.prompt_settings.null_prompt);
	}

	#[test]
	fn parses_every_auth_branch() {
		assert!(matches!(
			parse(&["omp", "auth", "login", "provider"]).command,
			Some(Command::Auth(AuthArgs { command: AuthCommand::Login { .. }, .. }))
		));
		assert!(matches!(
			parse(&["omp", "auth", "list", "--provider", "provider"]).command,
			Some(Command::Auth(AuthArgs { command: AuthCommand::List { provider: Some(_) }, .. }))
		));
		assert!(matches!(
			parse(&["omp", "auth", "status"]).command,
			Some(Command::Auth(AuthArgs { command: AuthCommand::Status { provider: None }, .. }))
		));
		assert!(matches!(
			parse(&["omp", "auth", "refresh", "account"]).command,
			Some(Command::Auth(AuthArgs { command: AuthCommand::Refresh { .. }, .. }))
		));
		assert!(matches!(
			parse(&["omp", "auth", "logout", "account"]).command,
			Some(Command::Auth(AuthArgs { command: AuthCommand::Logout { .. }, .. }))
		));
	}

	#[test]
	fn help_and_version_keep_their_process_exit_contract() {
		let root_help = parse_from_os(["omp", "--help"].map(OsString::from))
			.expect_err("root help")
			.to_string();
		assert!(root_help.contains("--profile <NAME>"));
		assert!(root_help.contains("--alias <COMMAND>"));
		assert!(root_help.contains("-p, --print"));
		assert!(root_help.contains("--no-extensions"));
		assert!(root_help.contains("--auto-approve"));
		assert!(!root_help.contains("--yolo"));
		assert!(root_help.contains("bash"));
		assert!(!root_help.contains("report_issue"));
		for flag in ["--version", "-v"] {
			let cli = parse_from_os(["omp", "-p", flag].map(OsString::from))
				.expect("version is global across launch forms");
			assert!(cli.version);
			assert!(matches!(cli.command, Some(Command::Print(_))));
		}
		for arguments in
			[&["omp", "--help"][..], &["omp", "help"][..], &["omp", "chat", "--help"][..]]
		{
			let error = parse_from_os(arguments.iter().map(OsString::from))
				.expect_err("help is a successful clap display");
			assert_eq!(error.kind(), ErrorKind::DisplayHelp);
			assert_eq!(error.exit_code(), 0);
		}
		let Some(Command::Chat(args)) =
			parse_from_os(["omp", "--model", "provider/model", "help"].map(OsString::from))
				.expect("help after launch flags remains prompt text")
				.command
		else {
			panic!("chat command");
		};
		assert_eq!(args.prompt, [sf!("help")]);
	}

	#[tokio::test]
	async fn empty_pipe_falls_back_without_synthesizing_print() {
		assert_eq!(read_nonempty_piped_input(&b" \n\t"[..]).await, None);
		assert_eq!(
			read_nonempty_piped_input(&b"prompt\n"[..]).await,
			Some(Str::new_static("prompt\n"))
		);
	}

	#[test]
	fn piped_launch_promotion_is_post_parse_and_protocol_safe() {
		let mut cli = parse_arguments(["omp", "first", "second"].map(OsString::from))
			.expect("interactive-shaped parse");
		assert!(matches!(cli.command, Some(Command::Chat(_))));
		promote_piped_launch(&mut cli);
		let Some(Command::Print(args)) = cli.command else {
			panic!("non-empty pipe promotes chat");
		};
		assert_eq!(args.prompt, [sf!("first"), sf!("second")]);
		assert!(command_owns_stdin(
			parse_arguments(["omp", "--mode", "rpc"].map(OsString::from))
				.expect("rpc")
				.command
				.as_ref()
		));
		assert!(command_owns_stdin(
			parse_arguments(["omp", "acp"].map(OsString::from))
				.expect("acp")
				.command
				.as_ref()
		));
	}

	#[test]
	fn normalizes_bare_prompts_and_short_print_alias() {
		let Some(Command::Chat(args)) =
			parse_from_os([OsString::from("omp"), OsString::from("explain"), OsString::from("this")])
				.expect("interactive invocation")
				.command
		else {
			panic!("chat command");
		};
		assert_eq!(args.prompt, vec![sf!("explain"), sf!("this")]);

		let Some(Command::Chat(args)) = parse_from_os(["omp", "--", "--literal"].map(OsString::from))
			.expect("root POSIX separator")
			.command
		else {
			panic!("chat command");
		};
		assert_eq!(args.prompt, vec![sf!("--literal")]);
		let Some(Command::Chat(args)) = parse_from_os(["omp", "-"].map(OsString::from))
			.expect("lone dash positional")
			.command
		else {
			panic!("chat command");
		};
		assert_eq!(args.prompt, vec![sf!("-")]);

		let Some(Command::Print(args)) =
			parse_from_os([OsString::from("omp"), OsString::from("-p"), OsString::from("explain")])
				.expect("print invocation")
				.command
		else {
			panic!("print command");
		};
		assert_eq!(args.prompt[0], sf!("explain"));
	}

	#[test]
	fn routes_print_long_alias_like_the_short_form() {
		let Some(Command::Print(args)) =
			parse_from_os(["omp", "--print", "explain"].map(OsString::from))
				.expect("print invocation")
				.command
		else {
			panic!("print command");
		};
		assert_eq!(args.prompt[0], sf!("explain"));
	}

	#[test]
	fn routes_transport_modes_to_stdio_server_commands() {
		for (arguments, target) in [
			(&["omp", "--mode", "rpc"][..], DispatchTarget::Rpc),
			(&["omp", "--mode=rpc-ui"][..], DispatchTarget::RpcUi),
			(&["omp", "--mode", "acp"][..], DispatchTarget::Acp),
			(&["omp", "--model", "provider/model", "--mode", "rpc"][..], DispatchTarget::Rpc),
		] {
			let cli =
				parse_arguments(arguments.iter().map(OsString::from)).expect("transport invocation");
			assert_eq!(dispatch_target(cli.command.as_ref()), target);
		}
		let Some(Command::Print(args)) =
			parse_from_os(["omp", "-p", "--mode=json", "hello"].map(OsString::from))
				.expect("print invocation")
				.command
		else {
			panic!("print command");
		};
		assert_eq!(args.mode, "json");
	}

	#[test]
	fn flag_only_invocations_parse_as_interactive_until_nonempty_stdin_is_known() {
		let cli = parse_arguments(["omp", "chat", "--model", "provider/model"].map(OsString::from))
			.expect("explicit chat");
		assert!(matches!(cli.command, Some(Command::Chat(_))));
		let cli = parse_arguments(["omp", "launch", "--model", "provider/model"].map(OsString::from))
			.expect("launch alias");
		assert!(matches!(cli.command, Some(Command::Chat(_))));

		let cli = parse_arguments(
			["omp", "--model", "provider/model", "--thinking", "high"].map(OsString::from),
		)
		.expect("interactive-shaped launch");
		let Some(Command::Chat(args)) = cli.command else {
			panic!("chat command");
		};
		assert_eq!(args.model, Some(sf!("provider/model")));
		assert_eq!(args.thinking, Some(ThinkingLevel::High));
		// A non-empty pipe promotes only after this parse.
		let mut cli =
			parse_arguments(["omp", "--model", "provider/model"].map(OsString::from)).expect("launch");
		promote_piped_launch(&mut cli);
		assert!(matches!(cli.command, Some(Command::Print(_))));
		// A bare invocation stays the default chat composition.
		let cli = parse_arguments([OsString::from("omp")]).expect("bare invocation");
		assert!(cli.command.is_none());
		// Root-global options alone never force a launch command.
		let cli = parse_arguments(["omp", "--gui"].map(OsString::from)).expect("gui invocation");
		assert!(cli.command.is_none());
		assert!(cli.gui);
	}

	#[test]
	fn parses_print_inline_flags_and_posix_delimiter() {
		let Some(Command::Print(args)) = parse(&[
			"omp",
			"print",
			"--model=provider/model",
			"--mode=json",
			"--print-thoughts",
			"--",
			"--literal",
		])
		.command
		else {
			panic!("print command");
		};
		assert_eq!(args.model, Some(sf!("provider/model")));
		assert_eq!(args.mode, "json");
		assert!(args.print_thoughts);
		assert_eq!(args.prompt, vec![sf!("--literal")]);
	}

	#[test]
	fn print_rejects_invalid_mode_and_unknown_flags_as_usage_errors() {
		for arguments in [
			&["omp", "print", "--mode=xml", "hello"][..],
			&["omp", "print", "--mdoe", "text", "hello"][..],
		] {
			let error = OmpCli::try_parse_from(arguments).expect_err("invalid print usage");
			assert_eq!(error.exit_code(), 2);
			assert!(error.to_string().contains("error:"));
		}
	}

	#[test]
	fn hoists_global_flags_after_the_subcommand() {
		let cli = parse(&["omp", "print", "hello", "--no-ext", "--cwd=workspace"]);
		let Some(Command::Print(args)) = &cli.command else {
			panic!("print command: {cli:?}");
		};
		assert!(args.launch.extensions.no_ext);
		assert_eq!(cli.cwd, Some(PathBuf::from("workspace")));
	}
	#[test]
	fn serve_help_hides_rejected_extension_launch_controls() {
		let serve = omp_command(true)
			.try_get_matches_from(["omp", "serve", "--help"])
			.expect_err("help exits before parsing")
			.to_string();
		for option in [
			"--extension",
			"--ext ",
			"--plugin-dir",
			"--trusted-extension",
			"--no-ext",
			"--no-workspace-ext",
		] {
			assert!(!serve.contains(option), "serve help advertised {option}");
		}
		let chat = omp_command(false)
			.try_get_matches_from(["omp", "chat", "--help"])
			.expect_err("help exits before parsing")
			.to_string();
		assert!(chat.contains("--no-extensions"));
		assert!(chat.contains("--auto-approve"));
		assert!(!chat.contains("--yolo"));
	}

	#[test]
	fn parses_plan_yolo_flags_and_requires_the_pair() {
		let Some(Command::Chat(args)) =
			parse(&["omp", "chat", "--plan-yolo", "--plan-yolo-into", "provider/model"]).command
		else {
			panic!("chat command");
		};
		assert!(args.plan_yolo);
		assert_eq!(args.plan_yolo_into, Some(sf!("provider/model")));
		let error = OmpCli::try_parse_from(["omp", "chat", "--plan-yolo-into", "provider/model"])
			.expect_err("--plan-yolo-into requires --plan-yolo");
		assert_eq!(error.exit_code(), 2);
		let error = OmpCli::try_parse_from(["omp", "chat", "--plan-mode", "--plan-yolo"])
			.expect_err("--plan-mode conflicts with --plan-yolo");
		assert_eq!(error.exit_code(), 2);
	}

	#[test]
	fn yolo_shorthand_yields_when_an_explicit_approval_mode_is_given() {
		for flag in ["--yolo", "--auto-approve"] {
			let Some(Command::Chat(args)) = parse(&["omp", "chat", flag]).command else {
				panic!("chat command");
			};
			assert!(args.yolo);
			assert_eq!(args.effective_approval(), Some(ApprovalMode::Yolo));
		}
		let Some(Command::Print(args)) =
			parse(&["omp", "print", "--approval-mode", "write", "--yolo", "hello"]).command
		else {
			panic!("print command");
		};
		assert_eq!(args.effective_approval(), Some(ApprovalMode::Write));
	}

	#[test]
	fn resume_aliases_parse_and_bare_forms_open_the_picker() {
		for arguments in [
			&["omp", "chat", "--session", "01ARZ3NDEKTSV4RRFFQ69G5FAV"][..],
			&["omp", "chat", "-r", "01ARZ3NDEKTSV4RRFFQ69G5FAV"][..],
		] {
			let cli = parse_from_os(arguments.iter().map(OsString::from)).expect("resume alias");
			let Some(Command::Chat(args)) = cli.command else {
				panic!("chat command");
			};
			assert_eq!(args.resume, Some(sf!("01ARZ3NDEKTSV4RRFFQ69G5FAV")));
		}
		for arguments in [
			&["omp", "chat", "--session"][..],
			&["omp", "chat", "-r"][..],
			&["omp", "chat", "--resume="][..],
		] {
			let cli = parse_from_os(arguments.iter().map(OsString::from)).expect("bare resume");
			let Some(Command::Chat(mut args)) = cli.command else {
				panic!("chat command");
			};
			assert_eq!(chat_start(&mut args), crate::chat_cmd::ChatStart::SessionIndex);
		}
	}

	#[test]
	fn routes_launch_options_around_launch_commands() {
		for arguments in [["omp", "--cwd", "workspace", "--model", "provider/model", "chat"], [
			"omp",
			"chat",
			"--cwd",
			"workspace",
			"--model",
			"provider/model",
		]] {
			let cli = parse_from_os(arguments.map(OsString::from)).expect("launch options");
			assert_eq!(cli.cwd, Some(PathBuf::from("workspace")));
			let Some(Command::Chat(args)) = cli.command else {
				panic!("chat command");
			};
			assert_eq!(args.model, Some(sf!("provider/model")));
		}
	}
	#[test]
	fn parses_gui_across_interactive_chat_forms() {
		for arguments in [
			&["omp", "--gui"][..],
			&["omp", "--gui", "chat"][..],
			&["omp", "chat", "--gui"][..],
			&["omp", "--model", "provider/model", "--gui", "chat"][..],
		] {
			let cli = parse_from_os(arguments.iter().map(OsString::from))
				.expect("GUI interactive chat invocation");
			assert!(cli.gui);
			assert!(matches!(cli.command, None | Some(Command::Chat(_))));
		}
	}

	#[test]
	fn strips_leading_launch_options_from_non_launch_commands_only() {
		let cli = parse_from_os(
			["omp", "--cwd=workspace", "--model", "provider/model", "config", "list", "--json"]
				.map(OsString::from),
		)
		.expect("leading launch options are inapplicable to config");
		assert!(cli.cwd.is_none());
		assert!(matches!(
			cli.command,
			Some(Command::Config(ConfigArgs { command: ConfigCommand::List { json: true } }))
		));

		let error =
			parse_from_os(["omp", "config", "list", "--model", "provider/model"].map(OsString::from))
				.expect_err("a trailing launch option still belongs to config's strict parser");
		assert_eq!(error.kind(), ErrorKind::UnknownArgument);

		let cli = parse_from_os(["omp", "--json", "models"].map(OsString::from))
			.expect("a non-launch flag before its command is retained");
		assert!(matches!(cli.command, Some(Command::Models(ModelsArgs { json: true, .. }))));
		let cli = parse_from_os(["omp", "-c", "update"].map(OsString::from))
			.expect("short command flag before update is retained");
		assert!(matches!(cli.command, Some(Command::Update(UpdateArgs { check: true, .. }))));
	}

	#[test]
	fn parses_continue_selector_and_session_modes() {
		let Some(Command::Chat(args)) =
			parse(&["omp", "chat", "--continue", "What did we discuss?", "--session-dir", "sessions"])
				.command
		else {
			panic!("chat command");
		};
		assert!(args.continue_session);
		assert_eq!(args.prompt, vec![sf!("What did we discuss?")]);
		assert_eq!(args.session_dir, Some(PathBuf::from("sessions")));
		assert!(matches!(
			parse(&["omp", "chat", "--no-session"]).command,
			Some(Command::Chat(ChatArgs { no_session: true, .. }))
		));
	}
	#[test]
	fn validates_launch_levels_tiers_and_durations() {
		let Some(Command::Print(args)) = parse(&[
			"omp",
			"print",
			"--thinking=min",
			"--service-tier=priority",
			"--approval-mode=write",
			"--max-time=2m",
			"--tools=read,write",
			"--follow-up",
			"then summarize",
			"prompt",
		])
		.command
		else {
			panic!("print command");
		};
		assert_eq!(args.thinking, Some(ThinkingLevel::Minimal));
		assert_eq!(args.service_tier, Some(TierSetting::Priority));
		assert_eq!(args.approval_mode, Some(ApprovalMode::Write));
		assert_eq!(args.max_time, Some(CliDuration(Duration::from_secs(120))));
		assert_eq!(args.follow_ups, vec![sf!("then summarize")]);
		assert_eq!(args.tools, Some(ToolNames(vec![sf!("read"), sf!("write")])));
		assert_eq!(
			"1.5m".parse::<CliDuration>().expect("fractional duration"),
			CliDuration(Duration::from_secs(90))
		);
		assert_eq!(
			"Read,search,find,read,,Publisher.Tool"
				.parse::<ToolNames>()
				.expect("compatible tool aliases"),
			ToolNames(vec![sf!("read"), sf!("grep"), sf!("glob"), sf!("Publisher.Tool")])
		);
		for arguments in [
			["omp", "print", "--thinking=inherit", "prompt"],
			["omp", "print", "--thinking=m", "prompt"],
			["omp", "print", "--max-time=0", "prompt"],
			["omp", "print", "--service-tier=fast", "prompt"],
		] {
			assert_eq!(
				OmpCli::try_parse_from(arguments)
					.expect_err("invalid value")
					.exit_code(),
				2
			);
		}
	}

	#[test]
	fn session_index_is_explicit_while_chat_starts_inline() {
		let mut chat = ChatArgs::default_interactive();
		assert_eq!(chat_start(&mut chat), crate::chat_cmd::ChatStart::Session);
		let mut picker =
			ChatArgs { resume: Some(sf!("__omp_picker__")), ..ChatArgs::default_interactive() };
		assert_eq!(chat_start(&mut picker), crate::chat_cmd::ChatStart::SessionIndex);
		assert!(picker.resume.is_none());
	}

	#[test]
	fn normalizes_global_prefixed_bare_prompts_and_resume_picker() {
		let Some(Command::Chat(args)) = parse_from_os([
			OsString::from("omp"),
			OsString::from("--cwd"),
			OsString::from("workspace"),
			OsString::from("explain"),
		])
		.expect("chat")
		.command
		else {
			panic!("chat command");
		};
		assert_eq!(args.prompt, vec![sf!("explain")]);
		let Some(Command::Chat(args)) =
			parse_from_os([OsString::from("omp"), OsString::from("resume")])
				.expect("resume")
				.command
		else {
			panic!("chat command");
		};
		assert_eq!(args.resume, Some(sf!("__omp_picker__")));
	}

	#[test]
	fn parses_config_models_and_broker_registry_entries() {
		assert!(matches!(
			parse(&["omp", "config", "init-xdg", "--json"]).command,
			Some(Command::Config(ConfigArgs { command: ConfigCommand::InitXdg { json: true } }))
		));
		assert!(matches!(
			parse(&["omp", "config", "set", "model.roles", "{\"default\":\"provider/model\"}"])
				.command,
			Some(Command::Config(_))
		));
		assert!(matches!(
			parse(&["omp", "models", "find", "model"]).command,
			Some(Command::Models(_))
		));
		assert!(matches!(
			parse(&["omp", "stats", "--json"]).command,
			Some(Command::Stats(StatsArgs { json: true, summary: false }))
		));
		assert!(matches!(
			parse(&["omp", "stats", "--summary"]).command,
			Some(Command::Stats(StatsArgs { json: false, summary: true }))
		));
		assert!(matches!(
			parse(&["omp", "update", "--check"]).command,
			Some(Command::Update(UpdateArgs { check: true, .. }))
		));
		assert!(matches!(
			parse(&["omp", "update", "--canary"]).command,
			Some(Command::Update(UpdateArgs { canary: true, stable: false, .. }))
		));
		assert!(matches!(
			parse(&["omp", "update", "--stable"]).command,
			Some(Command::Update(UpdateArgs { canary: false, stable: true, .. }))
		));
		let mut command = OmpCli::command();
		let help = command
			.find_subcommand_mut("update")
			.expect("update command")
			.render_long_help()
			.to_string();
		assert!(help.contains("--canary"));
		assert!(help.contains("Switch to the canary release channel and update"));
		assert!(help.contains("--stable"));
		assert!(help.contains("Switch back to the stable release channel and update"));
		for arguments in [
			&["omp", "update", "--canary", "--stable"][..],
			&["omp", "update", "--plugins", "--canary"][..],
			&["omp", "update", "--index", "release.json", "--stable"][..],
		] {
			assert_eq!(
				OmpCli::try_parse_from(arguments)
					.expect_err("conflicting updater controls")
					.kind(),
				ErrorKind::ArgumentConflict
			);
		}
		assert!(matches!(
			parse(&["omp", "registry", "--json"]).command,
			Some(Command::Registry(RegistryArgs { json: true, .. }))
		));
		assert!(matches!(
			parse(&["omp", "auth-broker", "status"]).command,
			Some(Command::AuthBroker(_))
		));
	}
	#[test]
	fn auth_gateway_rejects_unauthenticated_tcp_mode() {
		let error = OmpCli::try_parse_from(["omp", "auth-gateway", "serve", "--no-auth"])
			.expect_err("--no-auth must not remain accepted");
		assert_eq!(error.kind(), ErrorKind::UnknownArgument);
		assert_eq!(error.exit_code(), 2);
	}

	#[test]
	fn parses_worktree_inventory_and_pruning_flags() {
		assert!(matches!(
			parse(&["omp", "worktree", "list", "--json", "--all"]).command,
			Some(Command::Worktree(WorktreeArgs {
				command: WorktreeCommand::List { json: true, all: true },
			}))
		));
		assert!(matches!(
			parse(&["omp", "worktree", "clear", "--dry-run", "--all", "--json"]).command,
			Some(Command::Worktree(WorktreeArgs {
				command: WorktreeCommand::Clear { all: true, dry_run: true, json: true },
			}))
		));
	}

	#[test]
	fn rejects_incomplete_commands() {
		for arguments in [
			&["omp", "serve"][..],
			&["omp", "infer", "--model", "provider/model"][..],
			&["omp", "local", "infer"][..],
			&["omp", "catalog", "import", "--providers", "providers.toml", "--oauth", "oauth.toml"][..],
			&["omp", "auth", "login"][..],
		] {
			assert_eq!(
				OmpCli::try_parse_from(arguments)
					.expect_err("command must be rejected")
					.kind(),
				ErrorKind::MissingRequiredArgument
			);
		}
		// `--model` is optional now; a dangling `--gateway` fails on its
		// missing value instead of a missing required argument.
		assert_eq!(
			OmpCli::try_parse_from(["omp", "chat", "--gateway"])
				.expect_err("dangling gateway endpoint must be rejected")
				.kind(),
			ErrorKind::InvalidValue
		);
	}
}
