//! Application-supplied data feeds for dashboards and account commands.
//!
//! The chat actor is a projection over the session DOM (ADR 0005): facts
//! that live outside the journal — provider quotas, the kernel's tool
//! roster, extension and MCP status, stored OAuth accounts, on-disk
//! sessions, marketplace plugins — reach panels only through this seam.
//! The application implements [`Services`] once over `omp-ai`,
//! `omp-envd`, `omp-driver`, and `omp-cache`; the chat crate never depends
//! on those engines. Every method has a default that reports the feature
//! as unavailable, so a headless or test host needs no implementation.

use std::{path::PathBuf, sync::Arc, time::Duration};

use flume::{Receiver, Sender};
use omp_core::Str;
use thiserror::Error;

use crate::history::HistoryEntry;

/// Why a service request could not be served.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum ServiceError {
	/// The application did not wire this feed (a headless or test host).
	#[error("{0} is unavailable in this host")]
	Unavailable(&'static str),
	/// The feed exists but the request failed.
	#[error("{0}")]
	Failed(Str),
}

impl ServiceError {
	/// Wraps any error as a failed request.
	pub fn failed(error: impl std::fmt::Display) -> Self {
		Self::Failed(Str::new(error.to_string()))
	}
}

/// Result of a service request.
pub type ServiceResult<T> = Result<T, ServiceError>;

/// Completion of an asynchronous service request: the host polls it from
/// a panel's `tick`, never blocking the actor.
pub type Pending<T> = Receiver<ServiceResult<T>>;

/// Route whose exact active account usage the status actor requests.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActiveUsageRequest {
	/// Provider identifier from the live route.
	pub provider: Str,
	/// Model identifier from the live route.
	pub model:    Str,
}

/// Non-secret identity of the exact account serving a route.
///
/// Every available identifier is retained so accounts sharing an email or a
/// provider-native id cannot share a status cache accidentally.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AccountIdentity {
	/// Provider identifier.
	pub provider:            Str,
	/// Stable broker account identifier.
	pub account:             Str,
	/// Broker principal identity, when available.
	pub principal:           Option<Str>,
	/// Provider-native account identifier.
	pub provider_account_id: Option<Str>,
	/// Provider account email.
	pub email:               Option<Str>,
	/// Provider project identifier.
	pub project_id:          Option<Str>,
	/// Provider organization identifier.
	pub organization_id:     Option<Str>,
}

/// Usage windows for the exact account serving [`ActiveUsageRequest`].
///
/// The application resolves account affinity and provider/model/tier scope
/// before returning this DTO. The actor must never aggregate sibling accounts.
#[derive(Clone, Debug, PartialEq)]
pub struct ActiveAccountUsage {
	/// Requested route; stale asynchronous deliveries are rejected against it.
	pub request:   ActiveUsageRequest,
	/// Exact account identity used by the provider fetch.
	pub identity:  AccountIdentity,
	/// Selected model/account tier or plan label.
	pub tier:      Option<Str>,
	/// Five-hour request window.
	pub five_hour: Option<crate::status_band::UsageWindow>,
	/// Daily request window.
	pub daily:     Option<crate::status_band::UsageWindow>,
	/// Seven-day request window.
	pub seven_day: Option<crate::status_band::UsageWindow>,
	/// Monthly request window.
	pub monthly:   Option<crate::status_band::UsageWindow>,
}

/// One quota window on a provider account.
#[derive(Clone, Debug, PartialEq)]
pub struct UsageWindow {
	/// Window label (`5h`, `weekly`, `daily`).
	pub label:     Str,
	/// Fraction of the window consumed, `0.0..=1.0`.
	pub fraction:  f64,
	/// Time until the window resets, when the provider reports one.
	pub resets_in: Option<Duration>,
	/// Health of this window.
	pub status:    UsageStatus,
}

/// Health of a usage window or account card.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UsageStatus {
	/// Under the warning threshold.
	Ok,
	/// Near exhaustion.
	Warning,
	/// Exhausted until reset.
	Exhausted,
	/// No usage recorded.
	Idle,
	/// The provider could not be queried.
	Unknown,
}

/// One account eligible for `/usage reset` confirmation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResetAccountRow {
	/// Selector sent back to the controller (`provider:account`).
	pub target:    Str,
	/// Human-readable account label.
	pub label:     Str,
	/// Saved resets available to spend.
	pub available: u32,
	/// Whether this account currently serves the provider.
	pub active:    bool,
}

/// One provider account's quota card.
#[derive(Clone, Debug, PartialEq)]
pub struct UsageAccount {
	/// Provider identifier.
	pub provider: Str,
	/// Human-readable provider name.
	pub title:    Str,
	/// Account labels sharing this card.
	pub accounts: Vec<Str>,
	/// Quota windows, most granular first.
	pub windows:  Vec<UsageWindow>,
	/// Query failure, when the provider could not be reached.
	pub error:    Option<Str>,
}

/// One `/stats` grouping row (by model or by folder).
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct StatsGroup {
	/// Model route or project folder.
	pub key:           Str,
	/// Provider requests.
	pub requests:      u64,
	/// Cost in nano-dollars over priced requests.
	pub cost_nano_usd: u64,
	/// Requests without a price.
	pub unpriced:      u64,
	/// Input tokens.
	pub input_tokens:  u64,
	/// Output tokens.
	pub output_tokens: u64,
	/// Cache-read tokens.
	pub cache_read:    u64,
	/// Cache-write tokens.
	pub cache_write:   u64,
}

/// One `/stats` tool row.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct StatsTool {
	/// Tool name.
	pub tool:   Str,
	/// Calls.
	pub calls:  u64,
	/// Faulted calls.
	pub errors: u64,
}

/// Historical usage over every stored session: the `stats.db` overall
/// summary plus by-model and by-folder breakdowns.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StatsReport {
	/// Journal files that were re-read by this sync.
	pub synced:            u64,
	/// Journal files indexed in total.
	pub files:             u64,
	/// Provider requests.
	pub requests:          u64,
	/// Requests that ended with an error.
	pub errors:            u64,
	/// Input tokens.
	pub input_tokens:      u64,
	/// Output tokens.
	pub output_tokens:     u64,
	/// Cache-read tokens.
	pub cache_read:        u64,
	/// Cache-write tokens.
	pub cache_write:       u64,
	/// Cost in nano-dollars over priced requests.
	pub cost_nano_usd:     u64,
	/// Requests without a price.
	pub unpriced:          u64,
	/// Mean inference duration.
	pub avg_duration_ms:   Option<u64>,
	/// Mean time to first token.
	pub avg_ttft_ms:       Option<u64>,
	/// Output tokens per second.
	pub tokens_per_second: Option<f64>,
	/// Top models by requests.
	pub by_model:          Vec<StatsGroup>,
	/// Top folders by requests.
	pub by_folder:         Vec<StatsGroup>,
	/// Tool calls by tool.
	pub tools:             Vec<StatsTool>,
}

/// One ephemeral kernel notification recorded for `/trace`: what the
/// journal does not carry (retries, inference starts, tool readiness).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TraceEvent {
	/// Unix milliseconds when the kernel published it.
	pub at_ms: u64,
	/// Short event label.
	pub label: Str,
}

/// One day of local cost activity for the heatmap.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct UsageDay {
	/// Day start, milliseconds since the Unix epoch (UTC).
	pub day_ms:        u64,
	/// Cost in nano-dollars.
	pub cost_nano_usd: u64,
	/// Inference requests.
	pub requests:      u64,
}

/// Everything the usage dashboard shows.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct UsageReport {
	/// When the provider quotas were last fetched (Unix milliseconds).
	pub checked_at_ms: Option<u64>,
	/// Provider quota cards.
	pub accounts:      Vec<UsageAccount>,
	/// Daily activity, oldest first.
	pub activity:      Vec<UsageDay>,
	/// Why `activity` is empty when the host has no local cost history;
	/// `None` means the heatmap is authoritative.
	pub activity_note: Option<Str>,
	/// Preformatted per-account detail report.
	pub detail:        Str,
}

/// One kernel-registered tool.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolRow {
	/// Tool name.
	pub name:        Str,
	/// Tool description (first line is the summary).
	pub description: Str,
	/// Schema revision.
	pub rev:         u32,
	/// Trust tier, when the registry assigns one.
	pub tier:        Option<Str>,
	/// Whether the tool is active in the current session roster.
	pub active:      bool,
	/// Where the tool comes from (`builtin`, `mcp:<server>`, `ext:<name>`).
	pub source:      Str,
}

/// One configured SSH host.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SshHostRow {
	/// Host alias.
	pub name:   Str,
	/// `user@host:port`.
	pub target: Str,
	/// Scope the declaration lives in (`project` or `user`).
	pub scope:  Str,
	/// Authentication policy (`agent` or the key path).
	pub auth:   Str,
}

/// Where an extension row comes from.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExtensionKind {
	/// MCP server.
	Mcp,
	/// Built-in extension shipped with the binary.
	Builtin,
	/// Python extension loaded by envd.
	Python,
	/// Marketplace plugin.
	Plugin,
}

impl ExtensionKind {
	/// Tab label.
	#[must_use]
	pub const fn label(self) -> &'static str {
		match self {
			Self::Mcp => "mcp",
			Self::Builtin => "builtin",
			Self::Python => "python",
			Self::Plugin => "plugin",
		}
	}
}

/// Runtime health of an extension or MCP server.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExtensionStatus {
	/// Starting or handshaking.
	Connecting,
	/// Loaded and serving.
	Ready,
	/// Cleanly stopped.
	Disconnected,
	/// Failed to load or crashed.
	Failed,
	/// Disabled by configuration.
	Disabled,
}

/// One extension dashboard row.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExtensionRow {
	/// Stable identifier.
	pub id:          Str,
	/// Display name.
	pub name:        Str,
	/// Source kind (dashboard tab).
	pub kind:        ExtensionKind,
	/// Runtime health.
	pub status:      ExtensionStatus,
	/// Whether configuration enables it.
	pub enabled:     bool,
	/// Implementation name and version, when reported.
	pub version:     Option<Str>,
	/// Free-form description.
	pub description: Option<Str>,
	/// Tools it registers.
	pub tools:       Vec<Str>,
	/// Resources it exposes (MCP).
	pub resources:   Vec<Str>,
	/// Prompts it exposes (MCP).
	pub prompts:     Vec<Str>,
	/// Last error, when failed.
	pub error:       Option<Str>,
}

/// One stored provider account.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AccountRow {
	/// Stable account identifier.
	pub id:            Str,
	/// Provider identifier.
	pub provider:      Str,
	/// Human-readable provider name.
	pub provider_name: Str,
	/// Account label (email or account id).
	pub label:         Str,
	/// Secondary detail (plan, expiry).
	pub detail:        Str,
	/// Credential kind (`oauth`, `api-key`).
	pub kind:          Str,
	/// Whether this account currently serves the provider.
	pub active:        bool,
}

/// One runtime-supplied option in the curated settings selector.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SettingsChoice {
	/// Stored convar spelling.
	pub value:       Str,
	/// Human label.
	pub label:       Str,
	/// Optional explanatory copy.
	pub description: Str,
}

/// Runtime rosters used by settings controls whose choices cannot be static.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct SettingsInventory {
	/// Themes discovered from command-line and user/project theme directories.
	pub themes:          Vec<SettingsChoice>,
	/// Built-in and extension-provided composer shapes.
	pub composer_shapes: Vec<SettingsChoice>,
	/// Thinking levels supported by the active model.
	pub thinking_levels: Vec<SettingsChoice>,
	/// Provider ids available to the active catalog.
	pub providers:       Vec<Str>,
}

/// One provider offered by `/login` and `/setup`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderRow {
	/// Provider identifier.
	pub id:        Str,
	/// Human-readable provider name.
	pub name:      Str,
	/// Whether the provider supports interactive OAuth sign-in.
	pub oauth:     bool,
	/// Whether a credential is already stored.
	pub logged_in: bool,
}

/// An in-flight interactive login.
///
/// The driver pushes what the dialog must show; the dialog feeds pasted
/// callback URLs or codes back through `input`; `done` settles once.
pub struct LoginFlow {
	/// Provider being signed in.
	pub provider:      Str,
	/// Human-readable provider name for the title.
	pub provider_name: Str,
	/// Dialog updates from the driver, in order.
	pub events:        Receiver<LoginEvent>,
	/// Pasted redirect URL or verification code.
	pub input:         Sender<Str>,
	/// Final outcome with a user-facing message.
	pub done:          Pending<Str>,
	/// Aborts the flow when the dialog is cancelled.
	pub cancel:        Sender<()>,
}

/// One login dialog update.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LoginEvent {
	/// Open (or show) this authorization URL.
	OpenUrl {
		/// Authorization URL.
		url:      Str,
		/// Whether the driver launched a browser itself.
		launched: bool,
	},
	/// Show a device code to enter at `verification_url`.
	DeviceCode {
		/// User code.
		code:             Str,
		/// Where to enter it.
		verification_url: Str,
	},
	/// Ask the user to paste a callback URL or code.
	Prompt {
		/// Prompt label.
		label: Str,
	},
	/// Informational line.
	Info(Str),
}

/// One journal entry as the tree selector sees it: only user turns,
/// assistant messages, and branch points carry
/// text; everything else is a structural link.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TreeEntry {
	/// Journal entry id.
	pub id:     omp_journal::EntryId,
	/// Parent entry on the tree: the explicit `prior` when the entry
	/// branched, else the preceding entry in the file.
	pub parent: Option<omp_journal::EntryId>,
	/// Journal kind name (`turn.start`, `msg.user`, `msg.assistant.start`, …).
	pub kind:   Str,
	/// Preview text for user/assistant messages; empty for structure.
	pub text:   Str,
	/// Whether the entry is on the live chain that ends at the head.
	pub live:   bool,
	/// Whether this entry is the current head.
	pub head:   bool,
}

/// One update from a `/btw` side answer.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SideEvent {
	/// Streamed answer text.
	Delta(Str),
	/// The answer finished.
	Done,
	/// The side kernel failed.
	Error(Str),
}

/// External coding-agent transcript source supported by the native importer.
#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::Display, strum::EnumString)]
#[strum(ascii_case_insensitive)]
pub enum ForeignSessionSource {
	/// Claude Code JSONL transcripts.
	#[strum(to_string = "Claude", serialize = "claude")]
	Claude,
	/// OpenAI Codex rollout JSONL transcripts.
	#[strum(to_string = "Codex", serialize = "codex")]
	Codex,
}

/// Lightweight foreign transcript metadata used by the import picker. The
/// complete transcript remains app-owned until the user confirms a row.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForeignSessionRow {
	/// Source that owns this transcript.
	pub source:        ForeignSessionSource,
	/// Stable source-local session identity.
	pub id:            Str,
	/// Source transcript path.
	pub path:          PathBuf,
	/// Project directory recorded by the source.
	pub cwd:           PathBuf,
	/// Source-provided title, when present.
	pub title:         Option<Str>,
	/// Creation time, Unix milliseconds.
	pub created_ms:    u64,
	/// Last modification, Unix milliseconds.
	pub modified_ms:   u64,
	/// User + assistant message count, when cheaply available.
	pub messages:      u32,
	/// First user message used for filtering and untitled rows.
	pub first_message: Option<Str>,
}

/// One on-disk session.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionRow {
	/// Stable session id (journal stem).
	pub id:          Str,
	/// Journal path.
	pub path:        PathBuf,
	/// Title, when named.
	pub title:       Option<Str>,
	/// Creation time, Unix milliseconds.
	pub created_ms:  u64,
	/// Last modification, Unix milliseconds.
	pub modified_ms: u64,
	/// User + assistant message count.
	pub messages:    u32,
	/// Parent session id for subagent children.
	pub parent:      Option<Str>,
	/// Agent class name for subagent children.
	pub agent:       Option<Str>,
	/// Whether the session is pinned to the top of the resume list.
	pub pinned:      bool,
}

/// One agent definition.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentRow {
	/// Agent class name.
	pub name:        Str,
	/// Where it is defined (`bundled`, `project`, `user`).
	pub source:      Str,
	/// One-line description.
	pub description: Str,
	/// Model pattern bound to the agent, when configured.
	pub model:       Option<Str>,
	/// Tools the agent may use; empty means the full roster.
	pub tools:       Vec<Str>,
	/// Whether the agent is enabled for spawning.
	pub enabled:     bool,
	/// Path of its definition file, when on disk.
	pub path:        Option<PathBuf>,
}

/// One marketplace plugin.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginRow {
	/// Stable plugin id.
	pub id:          Str,
	/// Display name.
	pub name:        Str,
	/// Version tag.
	pub version:     Option<Str>,
	/// Description.
	pub description: Str,
	/// Marketplace the plugin comes from.
	pub marketplace: Str,
	/// Whether it is installed.
	pub installed:   bool,
	/// Whether it is enabled.
	pub enabled:     bool,
	/// Installation scope (`user`, `project`); empty when not installed.
	pub scope:       Str,
	/// Whether a project-scope install shadows this user-scope entry.
	pub shadowed:    bool,
}

/// One configured marketplace source.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketplaceSource {
	/// Catalog name.
	pub name: Str,
	/// Source URI it was added from (`owner/repo`, URL, or path).
	pub uri:  Str,
}

/// Marketplace state.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PluginsReport {
	/// Configured marketplace sources.
	pub marketplaces: Vec<Str>,
	/// Known plugins, installed first.
	pub plugins:      Vec<PluginRow>,
	/// Configured marketplace sources with their URIs; the same set as
	/// `marketplaces`, in the same order.
	pub sources:      Vec<MarketplaceSource>,
}

/// Collaboration lifecycle operation sent through the controller command
/// stream. The actor never owns relay or journal authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CollabOp {
	/// Host a fresh room and publish editor/viewer links.
	Start {
		/// Whether the advertised primary link is read-only.
		read_only: bool,
		/// Optional relay origin; the public relay is used when absent.
		relay:     Option<Str>,
	},
	/// Join an existing room as a remote replica.
	Join {
		/// Compact or browser collaboration link.
		link: Str,
		/// Optional participant display name.
		name: Option<Str>,
	},
	/// Leave or close the current room.
	Leave,
	/// Read current collaboration state without changing it.
	Status,
}

/// Local role in a collaboration room.
#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::Display)]
#[strum(serialize_all = "lowercase")]
pub enum CollabRole {
	/// This process owns the authoritative journal.
	Host,
	/// This process consumes a remote replica.
	Guest,
}

/// One collaboration participant row.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CollabParticipant {
	/// Relay peer identity; zero is the local host.
	pub id:        u32,
	/// Sanitized visible name.
	pub name:      Str,
	/// Whether the participant owns the session.
	pub host:      bool,
	/// Whether mutation controls are disabled.
	pub read_only: bool,
}

/// Typed collaboration state returned by the runtime owner.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CollabState {
	/// Local role, absent when disconnected.
	pub role:         Option<CollabRole>,
	/// Human connection state (`connecting`, `connected`, …).
	pub connection:   Str,
	/// Writable guest link while hosting.
	pub editor_link:  Option<Str>,
	/// Read-only guest link while hosting.
	pub viewer_link:  Option<Str>,
	/// Authenticated presence rows.
	pub participants: Vec<CollabParticipant>,
	/// Concise command response.
	pub line:         Str,
}

/// Settled collaboration controller operation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CollabOutcome {
	/// Operation that settled.
	pub op:     CollabOp,
	/// Current state or typed service failure.
	pub result: ServiceResult<CollabState>,
}

/// `/memory` subcommands.
#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::EnumString, strum::Display)]
#[strum(serialize_all = "lowercase")]
pub enum MemoryOp {
	/// Show the injected memory payload.
	View,
	/// Show bank counts.
	Stats,
	/// Run bank diagnostics.
	Diagnose,
	/// Clear the memory bank.
	Clear,
	/// Enqueue a consolidation pass.
	Enqueue,
}

/// `/cleanse [request] [--all]` options.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct CleanseRequest {
	/// Free-form checker request; `None` runs discovered checkers.
	pub request: Option<Str>,
	/// Run every discovered checker.
	pub all:     bool,
	/// Include configured project tests.
	pub tests:   bool,
}

/// Settled cleanse run.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CleanseOutcome {
	/// Terminal status word (`clean`, `unresolved`, `unsupported`, `cancelled`).
	pub status:    Str,
	/// One-paragraph summary for the panel.
	pub summary:   Str,
	/// Remaining file groups (`path: N issues`), at most 50.
	pub remainder: Vec<Str>,
}

/// An in-flight cleanse run.
pub struct CleanseRun {
	/// Final outcome.
	pub done:   Pending<CleanseOutcome>,
	/// Cancels the run (Esc in the side panel).
	pub cancel: Sender<()>,
}

/// One `/ssh add` declaration.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SshHostSpec {
	/// Host alias.
	pub alias:    Str,
	/// DNS name or address.
	pub address:  Str,
	/// Remote account.
	pub user:     Str,
	/// SSH port.
	pub port:     u16,
	/// `SHA256:` host-key fingerprint.
	pub host_key: Str,
	/// Private key path; `None` uses the agent.
	pub key:      Option<PathBuf>,
	/// `true` writes the project scope (`.omp/hosts.toml`), else the user
	/// scope.
	pub project:  bool,
}

/// `/mcp` subcommands.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum McpOp {
	/// `list`: every configured and discovered server with its state.
	List,
	/// `test <name>`: connect, list tools, report.
	Test(Str),
	/// `reload`: re-read the native configs and respawn the runtime tools.
	Reload,
	/// `reconnect <name>`: manual reconnect clearing the circuit breaker.
	Reconnect(Str),
	/// `enable <name>` / `disable <name>`: flip the persisted switch.
	SetEnabled(Str, bool),
	/// `remove <name> [--scope project|user]`.
	Remove(Str, McpScope),
	/// `add <name> [--scope project|user] [--url <url>] [-- <command…>]`.
	Add(McpAdd),
	/// `reauth <name>`: run a fresh OAuth grant.
	Reauth(Str),
	/// `unauth <name>`: drop the stored OAuth grant.
	Unauth(Str),
	/// `resources`: resources offered by connected servers.
	Resources,
	/// `prompts`: prompts offered by connected servers.
	Prompts,
	/// `notifications`: notification capabilities and subscriptions.
	Notifications,
	/// `smithery-search`: authenticated registry search.
	SmitherySearch(SmitherySearch),
	/// `smithery-login`: browser/device authorization and private key
	/// persistence.
	SmitheryLogin,
	/// `smithery-logout`: delete the persisted Smithery key.
	SmitheryLogout,
	/// `smithery-connect`: resolve, authorize, persist, and mount one registry
	/// result.
	SmitheryConnect(SmitheryConnect),
}

/// Authenticated Smithery registry query.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SmitherySearch {
	/// Search terms.
	pub keyword:  Str,
	/// Config scope used by a subsequent connect command.
	pub scope:    McpScope,
	/// Bounded result count.
	pub limit:    usize,
	/// Preserve Smithery semantic ranking instead of identity filtering.
	pub semantic: bool,
}

/// Smithery registry result to connect and persist.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SmitheryConnect {
	/// Qualified registry identity (`namespace/server`, with optional leading
	/// `@`).
	pub target: Str,
	/// Config scope receiving the MCP declaration.
	pub scope:  McpScope,
	/// Optional local config name; otherwise the qualified identity is
	/// normalized.
	pub name:   Option<Str>,
}

/// Which MCP config file a mutation targets.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, strum::Display, strum::EnumString)]
#[strum(serialize_all = "lowercase")]
pub enum McpScope {
	/// `.omp/mcp.json` in the project.
	#[default]
	Project,
	/// The user data directory's `mcp.json`.
	User,
}

/// One `/mcp add` declaration.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct McpAdd {
	/// Server name.
	pub name:    Str,
	/// Target config.
	pub scope:   McpScope,
	/// Remote endpoint (`--url`); exclusive with `command`.
	pub url:     Option<Str>,
	/// Stdio command line (after `--`).
	pub command: Vec<Str>,
}

/// An in-flight `/mcp` operation.
pub struct McpRun {
	/// Report text once settled.
	pub done:   Pending<Str>,
	/// Cancels the operation (Esc while `/mcp test` connects).
	pub cancel: Option<Sender<()>>,
}

/// A worktree `/wt` moved the session into.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorktreeInfo {
	/// Checkout path.
	pub path:   PathBuf,
	/// Branch checked out there.
	pub branch: Str,
}

/// Which stored sessions the session picker lists: current project or every
/// project.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, strum::Display, strum::EnumString)]
#[strum(serialize_all = "lowercase")]
pub enum SessionScope {
	/// Sessions started in the current project directory.
	#[default]
	Project,
	/// Sessions from every project directory.
	All,
}

/// One scored internal-URL completion row.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UrlCompletion {
	/// Resource-relative value, e.g. `humanizer` for `skill://humanizer`.
	pub value:       Str,
	/// Optional short label; the value is shown when absent.
	pub label:       Option<Str>,
	/// Short description shown beside the value.
	pub description: Str,
	/// Provider score; higher ranks first.
	pub score:       u32,
}

/// A live or parked agent's transcript as the controller hands it to the
/// hub viewer: a detached snapshot plus, for a running kernel, the ordered
/// event stream following it (ADR 0005: the actor never reads a journal).
pub struct AgentView {
	/// Detached DOM snapshot of the child session.
	pub snapshot: omp_dom::Snapshot,
	/// Ordered events following `snapshot`; `None` for a parked agent whose
	/// journal is closed.
	pub events:   Option<Receiver<omp_dom::Event>>,
}

/// Stable native debug operation selected by `/debug`.
#[derive(
	Clone, Copy, Debug, Eq, PartialEq, strum::Display, strum::EnumString, strum::IntoStaticStr,
)]
#[strum(serialize_all = "kebab-case")]
pub enum DebugAction {
	/// Open the session artifact directory.
	OpenArtifacts,
	/// Capture current native scheduling evidence and create a report bundle.
	Performance,
	/// Write and open a flamegraph from recent work scheduling events.
	Work,
	/// Create an immediate session report bundle.
	Dump,
	/// Capture process memory facts and create a report bundle.
	Memory,
	/// Show bounded recent process logs.
	Logs,
	/// Show host system facts.
	System,
	/// Show negotiated terminal facts.
	Terminal,
	/// Exercise typed terminal presentation protocols.
	Protocols,
	/// Show the bounded, redacted, session-scoped provider SSE stream.
	RawSse,
	/// Export the visible TUI transcript.
	Transcript,
	/// Remove expired unreferenced artifact cache entries.
	ClearCache,
}

/// Negotiated presentation facts supplied to terminal debug operations.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DebugTerminal {
	/// Current cell viewport.
	pub viewport:   omp_tui::Size,
	/// Character-set tier.
	pub charset:    Str,
	/// Graphics protocol tier.
	pub graphics:   Str,
	/// Appearance selected by terminal detection.
	pub appearance: Str,
}

/// Facts supplied to one debug operation by the projection host.
#[derive(Clone, Debug)]
pub struct DebugRequest {
	/// Operation to execute.
	pub action:     DebugAction,
	/// Visible transcript, used only by [`DebugAction::Transcript`].
	pub transcript: Str,
	/// Already-negotiated presentation facts.
	pub terminal:   DebugTerminal,
}

/// One sanitized provider SSE frame crossing the application/services seam.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DebugSseFrame {
	/// Monotonic process-local sequence.
	pub sequence: u64,
	/// Provider event name.
	pub event:    Str,
	/// Irreversibly redacted bounded frame payload.
	pub payload:  Str,
}

/// Result of a real application debug operation.
pub enum DebugOutput {
	/// A completed operation rendered as a report.
	Report {
		/// Panel title.
		title: &'static str,
		/// Markdown body.
		body:  Str,
	},
	/// Live session-scoped provider stream.
	RawSse {
		/// Frames retained when the viewer opened.
		initial: Vec<DebugSseFrame>,
		/// Subsequent frames; bounded so a slow viewer never blocks inference.
		events:  Receiver<DebugSseFrame>,
	},
	/// The typed terminal protocol probe component.
	ProtocolProbe {
		/// Capability summary shown beneath the live samples.
		summary: Str,
		/// Temporary PNG used to exercise the negotiated graphics path.
		image:   PathBuf,
	},
}

/// One application-state mutation a dashboard asks the controller for
/// (`HostCommand::Service`). Panels never call the mutating owner directly
/// (ADR 0005; ADR 0014: one control stream).
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Mutation {
	/// Enable or disable one extension by id.
	SetExtensionEnabled {
		/// Extension id.
		id:      Str,
		/// Desired state.
		enabled: bool,
	},
	/// `/reload-plugins`: reload every extension runtime from disk.
	ReloadExtensions,
	/// Enable or disable one agent definition.
	SetAgentEnabled {
		/// Agent definition name.
		name:    Str,
		/// Desired state.
		enabled: bool,
	},
	/// Enable or disable an installed plugin.
	SetPluginEnabled {
		/// Plugin id.
		id:      Str,
		/// Desired state.
		enabled: bool,
	},
	/// Install a marketplace plugin.
	InstallPlugin {
		/// Plugin id.
		id: Str,
	},
	/// Uninstall a plugin.
	UninstallPlugin {
		/// Plugin id.
		id: Str,
	},
	/// Delete one stored account.
	Logout {
		/// Stored account.
		account: AccountRow,
	},
	/// Pin or unpin a stored account as the one the session uses for its
	/// provider.
	PinAccount {
		/// Stored account.
		account: AccountRow,
		/// Desired state.
		pinned:  bool,
	},
	/// Pin or unpin a stored session in the resume list.
	PinSession {
		/// Session id.
		id:     Str,
		/// Desired state.
		pinned: bool,
	},
	/// Rename a stored session in the index (session picker Ctrl+R).
	RenameSession {
		/// Session id.
		id:    Str,
		/// New title.
		title: Str,
	},
	/// Delete a stored session file (session picker Ctrl+D).
	DeleteSession {
		/// Session id.
		id: Str,
	},
	/// `/usage reset`: spend one saved rate-limit reset on `account`.
	ResetUsage {
		/// Account selector (`provider:account` or `active`).
		target: Str,
	},
}

impl Mutation {
	/// Whether this mutation can change which account serves the active
	/// route or the quota snapshot shown for it.
	#[must_use]
	pub const fn affects_active_account_usage(&self) -> bool {
		matches!(self, Self::Logout { .. } | Self::PinAccount { .. } | Self::ResetUsage { .. })
	}

	/// Short verb for status lines (`enabled`, `installed`, …).
	#[must_use]
	pub const fn verb(&self) -> &'static str {
		match self {
			Self::SetExtensionEnabled { enabled: true, .. }
			| Self::SetAgentEnabled { enabled: true, .. }
			| Self::SetPluginEnabled { enabled: true, .. } => "enabled",
			Self::SetExtensionEnabled { enabled: false, .. }
			| Self::SetAgentEnabled { enabled: false, .. }
			| Self::SetPluginEnabled { enabled: false, .. } => "disabled",
			Self::ReloadExtensions => "reloaded",
			Self::InstallPlugin { .. } => "installed",
			Self::UninstallPlugin { .. } => "uninstalled",
			Self::Logout { .. } => "logged out",
			Self::PinAccount { pinned: true, .. } | Self::PinSession { pinned: true, .. } => "pinned",
			Self::PinAccount { pinned: false, .. } | Self::PinSession { pinned: false, .. } => {
				"unpinned"
			},
			Self::RenameSession { .. } => "renamed",
			Self::DeleteSession { .. } => "deleted",
			Self::ResetUsage { .. } => "reset",
		}
	}
}

/// Settled [`Mutation`], posted back by the controller (`Outcome::Service`).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServiceOutcome {
	/// The request that settled.
	pub mutation: Mutation,
	/// Status line on success, else why it failed.
	pub result:   ServiceResult<Str>,
}

/// The application's mutating owner. Held by the controller only; the
/// actor reaches it exclusively through `HostCommand::Service`.
pub trait Mutations: Send + Sync {
	/// Runs one mutation; the receiver settles with a status line.
	fn apply(&self, mutation: Mutation) -> ServiceResult<Pending<Str>>;
}

/// A controller with no mutating owner (tests, `omp render`).
#[derive(Clone, Copy, Debug, Default)]
pub struct NoMutations;

impl Mutations for NoMutations {
	fn apply(&self, _mutation: Mutation) -> ServiceResult<Pending<Str>> {
		Err(ServiceError::Unavailable("mutations"))
	}
}

/// Application-supplied read feeds for commands and dashboards. Every
/// method defaults to [`ServiceError::Unavailable`]. Mutations live on
/// [`Mutations`], which only the controller holds.
pub trait Services: Send + Sync {
	/// Runtime choice rosters for the curated settings selector.
	fn settings_inventory(&self) -> ServiceResult<SettingsInventory> {
		Ok(SettingsInventory::default())
	}

	/// Resolves a runtime theme choice for observer-local preview.
	fn theme(&self, _name: &str) -> ServiceResult<Option<Arc<omp_tui::JsonTheme>>> {
		Ok(None)
	}

	/// Provider quotas and local cost activity. Quota refreshes contact
	/// every provider, so the report settles asynchronously.
	fn usage(&self) -> ServiceResult<Pending<UsageReport>> {
		Err(ServiceError::Unavailable("usage"))
	}

	/// Usage for the exact account serving `request`.
	///
	/// Implementations resolve account affinity and fetch on their runtime;
	/// this call only returns a receiver and never performs provider I/O on
	/// the actor or paint thread.
	fn active_account_usage(
		&self,
		_request: ActiveUsageRequest,
	) -> ServiceResult<Pending<Option<ActiveAccountUsage>>> {
		Err(ServiceError::Unavailable("active account usage"))
	}

	/// Accounts with saved Codex reset credits. The controller performs the
	/// network refresh; the actor only receives immutable selector rows.
	fn reset_accounts(&self) -> ServiceResult<Pending<Vec<ResetAccountRow>>> {
		Err(ServiceError::Unavailable("saved reset accounts"))
	}

	/// The kernel's registered tools.
	fn tools(&self) -> ServiceResult<Vec<ToolRow>> {
		Err(ServiceError::Unavailable("tool roster"))
	}

	/// Extension and MCP server status.
	fn extensions(&self) -> ServiceResult<Vec<ExtensionRow>> {
		Err(ServiceError::Unavailable("extensions"))
	}

	/// Stored provider accounts.
	fn accounts(&self) -> ServiceResult<Vec<AccountRow>> {
		Err(ServiceError::Unavailable("stored accounts"))
	}

	/// Providers that can be signed in.
	fn providers(&self) -> ServiceResult<Vec<ProviderRow>> {
		Err(ServiceError::Unavailable("provider roster"))
	}

	/// Starts an interactive login for `provider`.
	fn login(&self, _provider: &str) -> ServiceResult<LoginFlow> {
		Err(ServiceError::Unavailable("login"))
	}

	/// Exports the live session; `None` picks the default path beside the
	/// journal. Returns the written path.
	fn export(
		&self,
		_dom: &omp_dom::Dom,
		_path: Option<&std::path::Path>,
	) -> ServiceResult<PathBuf> {
		Err(ServiceError::Unavailable("export"))
	}

	/// On-disk sessions in `scope`, newest first.
	fn sessions(&self, _scope: SessionScope) -> ServiceResult<Vec<SessionRow>> {
		Err(ServiceError::Unavailable("session index"))
	}

	/// Foreign transcripts available for one-shot import, newest first.
	/// Implementations read only lightweight source metadata here; complete
	/// conversion starts only after the picker confirms a row.
	fn foreign_sessions(
		&self,
		_source: ForeignSessionSource,
	) -> ServiceResult<Vec<ForeignSessionRow>> {
		Err(ServiceError::Unavailable("foreign session index"))
	}

	/// The transcript of agent `id` (a `<meta><jobs>` child): a live
	/// kernel's snapshot plus its patch stream, or a parked agent's
	/// journal-derived snapshot. Settles asynchronously because a live
	/// kernel services the subscription at its next safe point.
	fn agent_view(&self, _id: &str) -> ServiceResult<Pending<AgentView>> {
		Err(ServiceError::Unavailable("agent transcripts"))
	}

	/// Id (journal stem) of the live session, for `/pin` without an
	/// argument. `Failed` when the session is in-memory only.
	fn live_session_id(&self) -> ServiceResult<Str> {
		Err(ServiceError::Unavailable("live session id"))
	}

	/// Durable prompts newest first, across projects and sessions.
	fn history_recent(&self, _limit: usize) -> ServiceResult<Vec<HistoryEntry>> {
		Err(ServiceError::Unavailable("prompt history"))
	}

	/// Durable prompts matching every query token, ranked by recency.
	fn history_search(&self, _query: &str, _limit: usize) -> ServiceResult<Vec<HistoryEntry>> {
		Err(ServiceError::Unavailable("prompt history"))
	}

	/// Session IDs whose latest prompt provenance matches `query`, newest first.
	fn history_matching_session_ids(&self, _query: &str, _limit: usize) -> ServiceResult<Vec<Str>> {
		Err(ServiceError::Unavailable("prompt history"))
	}

	/// Records an accepted composer submission with controller-owned project
	/// and live-session provenance.
	fn history_add(&self, _prompt: &str) -> ServiceResult<()> {
		Err(ServiceError::Unavailable("prompt history"))
	}

	/// Current collaboration role, links, and presence.
	fn collaboration(&self) -> ServiceResult<CollabState> {
		Err(ServiceError::Unavailable("collaboration"))
	}

	/// Reads a session-local artifact (`local://PLAN.md`) as text.
	fn read_local(&self, _url: &str) -> ServiceResult<Str> {
		Err(ServiceError::Unavailable("local artifacts"))
	}

	/// Session-local artifact URLs matching a suffix (`-plan.md`, `.md`),
	/// newest first.
	fn list_local(&self, _suffix: &str) -> ServiceResult<Vec<Str>> {
		Err(ServiceError::Unavailable("local artifacts"))
	}

	/// Writes a session-local artifact `name` (`paste-1.md`, no directory
	/// segments) and returns its `local://` URL.
	fn write_local(&self, _name: &str, _content: &str) -> ServiceResult<Str> {
		Err(ServiceError::Unavailable("local artifacts"))
	}

	/// Internal-URL completions for the composer: `input` is the whole token
	/// being
	/// typed (`skill://pro`); every row's `value` is resource-relative
	/// (`provider`, not `skill://provider`). Served by the Environment's
	/// resource catalog (`skill://`, `rule://`, `local://`, `omp://`,
	/// `memory://`, `agent://`, `artifact://`, …).
	fn url_completions(
		&self,
		_input: &str,
		_max_results: usize,
	) -> ServiceResult<Vec<UrlCompletion>> {
		Err(ServiceError::Unavailable("internal url completion"))
	}

	/// The live session's journal as a branch DAG (`/tree`): every entry
	/// with its parent link, so the tree selector can draw forks.
	fn journal_tree(&self) -> ServiceResult<Vec<TreeEntry>> {
		Err(ServiceError::Unavailable("journal tree"))
	}

	/// `/btw`: answers a side question on a tool-less child kernel seeded
	/// with `context`, streaming text deltas then one terminal event.
	fn btw(&self, _question: &str, _context: &str) -> ServiceResult<Receiver<SideEvent>> {
		Err(ServiceError::Unavailable("side questions"))
	}

	/// Agent definitions available to `task`.
	fn agents(&self) -> ServiceResult<Vec<AgentRow>> {
		Err(ServiceError::Unavailable("agent definitions"))
	}

	/// Marketplace sources and plugins.
	fn plugins(&self) -> ServiceResult<PluginsReport> {
		Err(ServiceError::Unavailable("marketplace"))
	}

	/// Adds a marketplace source.
	fn add_marketplace(&self, _source: &str) -> ServiceResult<Str> {
		Err(ServiceError::Unavailable("marketplace sources"))
	}

	/// Removes a marketplace source.
	fn remove_marketplace(&self, _name: &str) -> ServiceResult<Str> {
		Err(ServiceError::Unavailable("marketplace sources"))
	}

	/// `/marketplace update [name]`: re-fetches one or every catalog; the
	/// receiver settles with a status line.
	fn update_marketplace(&self, _name: Option<&str>) -> ServiceResult<Pending<Str>> {
		Err(ServiceError::Unavailable("marketplace update"))
	}

	/// `/marketplace upgrade [name@marketplace]`: upgrades one or every
	/// outdated plugin; the receiver settles with a status line.
	fn upgrade_plugins(&self, _spec: Option<&str>) -> ServiceResult<Pending<Str>> {
		Err(ServiceError::Unavailable("plugin upgrade"))
	}

	/// `/memory` operations; returns the text to show.
	fn memory(&self, _op: MemoryOp) -> ServiceResult<Str> {
		Err(ServiceError::Unavailable("memory bank"))
	}

	/// Release notes shipped with the binary (markdown).
	fn changelog(&self) -> ServiceResult<Str> {
		Err(ServiceError::Unavailable("changelog"))
	}

	/// Configured SSH hosts.
	fn ssh_hosts(&self) -> ServiceResult<Vec<SshHostRow>> {
		Err(ServiceError::Unavailable("ssh hosts"))
	}

	/// Adds or replaces one SSH host declaration; returns the status line.
	fn ssh_add(&self, _spec: &SshHostSpec) -> ServiceResult<Str> {
		Err(ServiceError::Unavailable("ssh hosts"))
	}

	/// Removes one SSH host declaration; returns the status line.
	fn ssh_remove(&self, _alias: &str, _project: bool) -> ServiceResult<Str> {
		Err(ServiceError::Unavailable("ssh hosts"))
	}

	/// Seals and uploads a share snapshot; settles with the viewer URL.
	fn share(&self, _snapshot: serde_json::Value) -> ServiceResult<Pending<Str>> {
		Err(ServiceError::Unavailable("share"))
	}

	/// Starts a cleanse run over the project.
	fn cleanse(&self, _request: CleanseRequest) -> ServiceResult<CleanseRun> {
		Err(ServiceError::Unavailable("cleanse"))
	}

	/// The session's working directory (`/dirs`, `/add-dir`, `/move`
	/// resolve relative paths against it).
	fn project_dir(&self) -> ServiceResult<PathBuf> {
		Err(ServiceError::Unavailable("project directory"))
	}

	/// `/wt [branch]`: forks the checkout into a new linked worktree on
	/// `branch`, carrying uncommitted changes along.
	fn create_worktree(&self, _branch: &str) -> ServiceResult<WorktreeInfo> {
		Err(ServiceError::Unavailable("worktrees"))
	}

	/// `/dump`: writes the next LLM request as JSON to a temp file and
	/// returns its path.
	fn dump_request(&self, _dom: &omp_dom::Dom) -> ServiceResult<PathBuf> {
		Err(ServiceError::Unavailable("request dump"))
	}

	/// `/restart`: marks the process for re-exec with its launch flags once
	/// the host hands the terminal back.
	fn request_restart(&self) -> ServiceResult<()> {
		Err(ServiceError::Unavailable("restart"))
	}

	/// `/mcp …`: runs one MCP management operation; the run settles with
	/// the report text.
	fn mcp(&self, _op: McpOp) -> ServiceResult<McpRun> {
		Err(ServiceError::Unavailable("mcp"))
	}

	/// `/stats`: syncs the usage index from every stored journal and
	/// settles with the aggregate report.
	fn stats(&self) -> ServiceResult<Pending<StatsReport>> {
		Err(ServiceError::Unavailable("usage statistics"))
	}

	/// `/trace`: the kernel notifications recorded since launch, oldest
	/// first (bounded by the application).
	fn trace_events(&self) -> ServiceResult<Vec<TraceEvent>> {
		Err(ServiceError::Unavailable("kernel trace"))
	}

	/// Executes one native debug operation through the application owner.
	fn debug(&self, _request: DebugRequest) -> ServiceResult<DebugOutput> {
		Err(ServiceError::Unavailable("debug services"))
	}

	/// Writes the current session's bounded redacted raw-SSE ring to a file.
	fn dump_raw_sse(&self) -> ServiceResult<PathBuf> {
		Err(ServiceError::Unavailable("raw SSE dump"))
	}
}

/// A host with no application feeds (tests, `omp render`).
#[derive(Clone, Copy, Debug, Default)]
pub struct NoServices;

impl Services for NoServices {}
