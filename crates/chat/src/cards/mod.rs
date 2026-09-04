//! Typed tool-card registry over materialized tool element state.

pub mod apply_patch;
pub mod ask;
pub mod ast_edit;
pub mod ast_grep;
pub mod bash;
pub mod browser;
pub mod computer;
pub mod context_gauge;
pub mod debug;
pub mod edit;
pub mod eval;
pub(crate) mod fixtures;
mod generic;
pub mod github;
pub mod glob;
pub mod goal;
pub mod grep;
pub mod hub;
pub mod lsp;
pub mod memory;
pub mod read;
pub mod report_issue;
pub mod resolve;
pub mod task;
pub mod think;
pub mod todo;
pub mod utility;
pub mod web_search;
mod workpool;
pub mod write;

use std::{collections::BTreeMap, fmt::Write as _, sync::Arc, time::Duration};

pub use generic::GenericCard;
use omp_core::{Str, StrMut, sf};
use omp_dom::{Node, PropId};
use omp_tool::{ArgPath, CallOutcome};
use omp_tui::{Graphics, IntoComponent as _, UiContext, dom};
use serde::de::DeserializeOwned;
use smallvec::SmallVec;

/// A boxed retained TUI component.
pub type Component = Box<dyn omp_tui::Component>;

/// Inline tool-result image column cap (`tui.maxInlineImageColumns` default);
/// the layout further bounds it by the card's width.
pub(crate) const INLINE_IMAGE_MAX_COLS: u16 = 100;
/// Inline tool-result image row cap (`tui.maxInlineImageRows` default, the
/// explicit bound when it is tighter than 60% of the viewport).
pub(crate) const INLINE_IMAGE_MAX_ROWS: u16 = 20;

/// Whether the terminal renders real inline images: Kitty, Sixel, or iTerm2
/// graphics.
pub(crate) const fn inline_images(ui: &UiContext) -> bool {
	!matches!(ui.graphics, Graphics::Cells)
}

/// Builds an absolute `file://` target for a project-relative card path.
pub(crate) fn file_link(path: &str) -> Str {
	std::path::absolute(path)
		.map_or_else(|_| sf!("file://{path}"), |absolute| sf!("file://{}", absolute.display()))
}

/// `[Image: <name> [<mime>] <WxH>]`, the text stand-in for a result image
/// the terminal cannot draw.
pub(crate) fn image_placeholder(
	mime: &str,
	dimensions: Option<(u32, u32)>,
	filename: Option<&str>,
) -> Str {
	let mut text = String::from("[Image:");
	if let Some(name) = filename.filter(|name| !name.is_empty()) {
		text.push(' ');
		text.push_str(name);
	}
	text.push_str(" [");
	text.push_str(mime);
	text.push(']');
	if let Some((width, height)) = dimensions {
		text.push_str(&sf!(" {width}x{height}"));
	}
	text.push(']');
	Str::new(text)
}

/// A tool-result image: the image itself through `<img>` when the terminal
/// supports a graphics protocol, else the text placeholder in tool-output
/// color.
pub(crate) fn result_image(
	src: &Str,
	mime: &str,
	filename: Option<&str>,
	ui: &UiContext,
) -> Component {
	if inline_images(ui) {
		dom! { <img src={src.clone()} w={INLINE_IMAGE_MAX_COLS} max-rows={INLINE_IMAGE_MAX_ROWS}/> }
			.into_component()
	} else {
		dom! { <text fg=muted>{image_placeholder(mime, None, filename)}</text> }.into_component()
	}
}

/// Tool lifecycle state derived from the tool element's `status` property.
///
/// The string form is the canonical session-DOM spelling; the DOM's
/// terminal-failure spellings (`cancelled`, `aborted`) and every unknown
/// running spelling fold onto [`Self::Failed`] and [`Self::InProgress`].
#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::EnumString, strum::IntoStaticStr)]
pub enum CardStatus {
	/// The provider is still streaming tool arguments.
	#[strum(serialize = "arguments")]
	StreamingArgs,
	/// The tool is executing.
	#[strum(serialize = "running")]
	InProgress,
	/// The tool settled successfully.
	#[strum(serialize = "ok")]
	Done,
	/// The tool faulted or was aborted.
	#[strum(to_string = "error", serialize = "cancelled", serialize = "aborted")]
	Failed,
}

impl CardStatus {
	/// Derives a card status from the session-DOM lifecycle spelling.
	#[must_use]
	pub fn from_dom(status: &str) -> Self {
		status.parse().unwrap_or(Self::InProgress)
	}

	/// Returns the canonical session-DOM spelling.
	#[must_use]
	pub fn as_str(self) -> &'static str {
		self.into()
	}
}

/// Borrowed state of one tool element and its standard child elements.
pub struct CardView<'a> {
	/// Tool input state.
	pub input:   &'a Node,
	/// Successful result state, when present.
	pub result:  Option<&'a Node>,
	/// Terminal diagnostic state, when present. This is the last error/fault
	/// diagnostic and is the only diagnostic that describes call failure.
	pub diag:    Option<&'a Node>,
	/// Non-error diagnostics in journal order. Harness-owned output bounding
	/// lives here and never changes the call's success/failure presentation.
	pub notices: SmallVec<&'a Node, 2>,
	/// Usage state, when present.
	pub usage:   Option<&'a Node>,
	/// Tool lifecycle status.
	pub status:  CardStatus,
	/// Accumulated ordered output of a running call: the open stream the
	/// dispatcher binds to the `<result>` text (ADR 0008 tool output
	/// streaming; `Dom::stream_text`). `None` once the stream closes and the
	/// settled result materializes into `result`.
	pub output:  Option<&'a str>,
	/// Presentation-clock instant the observer first saw the call executing
	/// `None` while streaming arguments or once
	/// settled. Cards paint a live elapsed badge against
	/// [`omp_tui::PaintCtx::now`] from it.
	pub started: Option<Duration>,
}

impl CardView<'_> {
	/// Returns the streamed or committed argument text.
	#[must_use]
	pub fn args_text(&self) -> Option<&str> {
		node_text(self.input)
	}

	/// Deserializes the streamed or committed arguments into the tool's
	/// canonical parameter type.
	#[must_use]
	pub fn input<P: DeserializeOwned>(&self) -> Option<P> {
		let raw = node_data(self.input).or_else(|| self.args_text())?;
		omp_tool::decode_params(raw).ok()
	}

	/// Parses the streamed or committed arguments as JSON.
	#[must_use]
	pub fn args_json(&self) -> Option<serde_json::Value> {
		serde_json::from_str(self.args_text()?).ok()
	}

	/// Returns the successful result's model-facing text.
	#[must_use]
	pub fn result_text(&self) -> Option<&str> {
		self.result.and_then(node_text)
	}

	/// Deserializes the successful result into the tool's canonical payload
	/// type: the journaled `CallOutcome::Ok` truth (ADR 0008: the element
	/// carries the payload). The bounded projection (`data` / text — the
	/// once-bounded prompt parts, ADR 0009) is only consulted when the
	/// element carries no typed outcome (a foreign or extension tool whose
	/// result is its projection), never as an override of one.
	#[must_use]
	pub fn result<T: DeserializeOwned>(&self) -> Option<T> {
		let node = self.result?;
		match node_outcome(node, PropId::Outcome) {
			Some(raw) => outcome_value::<T>(raw, "ok"),
			None => parse_either::<T>(node),
		}
	}

	/// The successful result's raw journaled payload as untyped JSON.
	///
	/// Dedicated cards should prefer [`Self::result`] with their concrete
	/// payload. This seam is for extension and dynamic-device cards whose
	/// payload type is not linked into `omp-chat`.
	#[must_use]
	pub fn outcome_json(&self) -> Option<serde_json::Value> {
		let node = self.result?;
		outcome_value(node_outcome(node, PropId::Outcome)?, "ok")
	}

	/// The terminal fault's raw journaled payload as untyped JSON.
	///
	/// Generic and dynamic-device cards use this to select human fields
	/// without ever printing the protocol envelope itself.
	#[must_use]
	pub fn fault_json(&self) -> Option<serde_json::Value> {
		let node = self.diag?;
		match node_outcome(node, PropId::Fault) {
			Some(raw) => outcome_value(raw, "faulted"),
			None => parse_either(node),
		}
	}

	/// The successful result's model-facing projection parsed as JSON: the
	/// bounded text when it is JSON, else the settled payload. Wrapper
	/// tools whose payload embeds the JSON their cards read (`hub`
	/// `Response::text`) decode the typed payload and unwrap it themselves;
	/// this is the untyped fallback for tools without a card contract.
	#[must_use]
	pub fn result_json(&self) -> Option<serde_json::Value> {
		let node = self.result?;
		self
			.result_text()
			.and_then(|text| serde_json::from_str(text).ok())
			.or_else(|| outcome_value(node_outcome(node, PropId::Outcome)?, "ok"))
	}

	/// Deserializes the terminal diagnostic into the tool's canonical fault
	/// type: the settled `CallOutcome::Faulted` truth, else a bare fault in
	/// `data` or the text for elements without a journaled outcome.
	#[must_use]
	pub fn fault<F: DeserializeOwned>(&self) -> Option<F> {
		let node = self.diag?;
		match node_outcome(node, PropId::Fault) {
			Some(raw) => outcome_value::<F>(raw, "faulted"),
			None => parse_either::<F>(node),
		}
	}
}

/// Live elapsed badge for a running call: dim ` Ns` after a muted ` · `,
/// counting whole seconds from
/// [`CardView::started`] on the shared clock. Absent unless the call is
/// executing and the projection recorded when it started, so gallery and
/// settled cards paint no badge.
pub(crate) fn elapsed_badge(view: &CardView<'_>) -> Option<Component> {
	if view.status != CardStatus::InProgress {
		return None;
	}
	let since = u64::try_from(view.started?.as_millis()).unwrap_or(u64::MAX);
	Some(
		dom! { <row gap=1><text fg=muted>{"·"}</text><time kind=elapsed dim ms={since}/></row> }
			.into_component(),
	)
}

/// Determines the `lang.*` icon name a file path is painted with in edit,
/// write, and file-list rows.
///
/// The key is the text after the last `.` of the file name (so `.gitignore`
/// resolves as `gitignore`), else the whole lowercased file name for
/// extensionless files such as `Dockerfile` and `justfile`. Languages
/// recognised but without an icon (`zig`, `perl`, …) paint `lang.default`;
/// unrecognised paths paint `lang.text`.
pub(crate) fn path_language_icon(path: &str) -> &'static str {
	let name = path
		.rsplit(['/', '\\'])
		.next()
		.unwrap_or(path)
		.to_ascii_lowercase();
	let key = if name.starts_with(".env.") {
		"env"
	} else if name.starts_with("dockerfile.") {
		"dockerfile"
	} else {
		name.rsplit('.').next().unwrap_or(&name)
	};
	match key {
		"ts" | "cts" | "mts" | "tsx" => "typescript",
		"js" | "jsx" | "mjs" | "cjs" => "javascript",
		"rs" => "rust",
		"go" => "go",
		"c" | "h" => "c",
		"cpp" | "cc" | "cxx" | "hh" | "hpp" | "hxx" | "cu" | "ino" => "cpp",
		"py" | "pyi" => "python",
		"rb" | "rbw" | "gemspec" => "ruby",
		"lua" => "lua",
		"sh" | "bash" | "zsh" | "ksh" | "bats" | "tmux" | "cgi" | "fcgi" | "command" | "tool"
		| "fish" | "ps1" | "psm1" | "justfile" => "shell",
		"php" => "php",
		"java" => "java",
		"kt" | "ktm" | "kts" => "kotlin",
		"cs" => "csharp",
		"html" | "htm" | "xhtml" | "vue" | "svelte" | "astro" => "html",
		"css" | "scss" | "sass" | "less" => "css",
		"json" => "json",
		"yaml" | "yml" => "yaml",
		"toml" => "toml",
		"xml" | "xsl" | "xslt" | "svg" | "plist" => "xml",
		"ini" => "ini",
		"md" | "markdown" | "mdx" | "mdc" | "mkd" | "mdown" => "markdown",
		"sql" => "sql",
		"dockerfile" | "containerfile" => "docker",
		"swift" => "swift",
		"jl" => "julia",
		"txt" | "text" => "text",
		"log" => "log",
		"csv" => "csv",
		"tsv" => "tsv",
		"cfg" | "conf" | "config" | "properties" | "gitignore" | "gitattributes" | "gitmodules"
		| "editorconfig" | "npmrc" | "prettierrc" | "eslintrc" | "prettierignore"
		| "eslintignore" => "conf",
		"env" => "env",
		"zig" | "pl" | "pm" | "perl" | "scala" | "sc" | "sbt" | "groovy" | "clj" | "cljc"
		| "cljs" | "edn" | "el" | "fs" | "vb" | "jsonc" | "rst" | "adoc" | "tex" | "graphql"
		| "gql" | "proto" | "tf" | "hcl" | "tfvars" | "nix" | "ex" | "exs" | "erl" | "hrl" | "hs"
		| "ml" | "mli" | "r" | "dart" | "elm" | "v" | "nim" | "cr" | "d" | "pas" | "pp" | "lisp"
		| "lsp" | "rkt" | "scm" | "bat" | "cmd" | "tla" | "tlaplus" | "m" | "mm" | "sol" | "odin"
		| "star" | "bzl" | "sv" | "svh" | "vh" | "vim" | "ipynb" | "hbs" | "hsb" | "handlebars"
		| "diff" | "patch" | "makefile" | "mk" | "mak" | "cmake" => "default",
		_ => "text",
	}
}

/// The value of string field `key` in still-streaming (possibly unterminated)
/// JSON arguments: the decoded text following `"key":"` up to its closing
/// quote or the end of what has arrived, so a card can name its target
/// before the provider closes the object. JSON escapes are decoded so a
/// multi-line brief splits on real newlines; a torn escape at the end is
/// dropped.
pub(crate) fn partial_string(json: &str, key: &str) -> Option<Str> {
	let marker = sf!("\"{key}\":\"");
	let start = json.find(marker.as_str())? + marker.len();
	let mut out = String::new();
	let mut chars = json[start..].chars();
	while let Some(ch) = chars.next() {
		match ch {
			'"' => break,
			'\\' => match chars.next() {
				Some('n') => out.push('\n'),
				Some('t') => out.push('\t'),
				Some('r') => out.push('\r'),
				Some('b') => out.push('\u{8}'),
				Some('f') => out.push('\u{c}'),
				Some('u') => {
					let Some(hex) = chars.as_str().get(..4) else {
						break;
					};
					let code = u32::from_str_radix(hex, 16).ok().and_then(char::from_u32);
					out.push(code.unwrap_or('\u{fffd}'));
					chars = chars.as_str()[4..].chars();
				},
				Some(other) => out.push(other),
				None => break,
			},
			other => out.push(other),
		}
	}
	Some(Str::from(out))
}

/// The first `limit` lines and a `… N more lines` marker when more follow.
pub(crate) fn preview_lines(text: &str, limit: usize) -> Str {
	let total = text.lines().count();
	if total <= limit {
		return Str::new(text);
	}
	let mut out = text.lines().take(limit).collect::<Vec<_>>().join("\n");
	out.push_str(&sf!("\n… {} more lines", total - limit));
	Str::new(out)
}

pub(crate) fn typed_input<P>(view: &CardView<'_>) -> Option<serde_json::Value>
where
	P: DeserializeOwned + serde::Serialize,
{
	view
		.input::<P>()
		.and_then(|value| serde_json::to_value(value).ok())
		.or_else(|| view.args_json())
}

/// The typed payload re-encoded as JSON for cards that read it by field.
///
/// This intentionally never falls back to projection JSON. Typed cards consume
/// the journaled outcome; wrapper cards that deliberately consume a textual
/// projection call [`CardView::result_json`] themselves.
pub(crate) fn typed_result<T>(view: &CardView<'_>) -> Option<serde_json::Value>
where
	T: DeserializeOwned + serde::Serialize,
{
	view
		.result::<T>()
		.and_then(|value| serde_json::to_value(value).ok())
}

/// Parses `data`, then the text, independently: live `data` is the
/// prompt-part array, which is never a payload, while the text may be one.
fn parse_either<T: DeserializeOwned>(node: &Node) -> Option<T> {
	node_data(node)
		.and_then(|raw| serde_json::from_str(raw).ok())
		.or_else(|| node_text(node).and_then(|raw| serde_json::from_str(raw).ok()))
}

/// Human-readable text for a failed call: the tool fault's `message` (else
/// its JSON), or the harness-owned prose for an abort / rejected argument
/// (`Abort::render`), read from the journaled `CallOutcome` envelope.
pub(crate) fn typed_fault<F>(view: &CardView<'_>) -> Option<Str>
where
	F: DeserializeOwned + serde::Serialize,
{
	if let Some(raw) = view.diag.and_then(|node| node_outcome(node, PropId::Fault)) {
		if let Ok(outcome) = serde_json::from_str::<CallOutcome<serde_json::Value, F>>(raw) {
			return Some(match outcome {
				// A tool fault: its `message`, else the fold's bounded human
				// text (the prompt-parts projection), never the raw fault JSON
				// when a bounded rendering exists.
				CallOutcome::Faulted(fault) => {
					let value = serde_json::to_value(fault).ok()?;
					match value.get("message").and_then(serde_json::Value::as_str) {
						Some(message) => Str::new(message),
						None => view
							.diag
							.and_then(node_text)
							.filter(|text| !text.is_empty() && !text.trim_start().starts_with(['{', '[']))
							.map_or_else(|| fault_message(&value), Str::new),
					}
				},
				CallOutcome::Aborted { abort, .. } => abort.render(),
				CallOutcome::ArgsRejected(issue) => sf!(
					"invalid argument{}: expected {}",
					issue
						.path
						.iter()
						.map(|segment| match segment {
							ArgPath::Key(key) => format!(".{key}"),
							ArgPath::Index(index) => format!("[{index}]"),
						})
						.collect::<String>(),
					issue.expected
				),
				CallOutcome::Ok(_) => return None,
			});
		}
	}
	let value = serde_json::to_value(view.fault::<F>()?).ok()?;
	Some(fault_message(&value))
}

fn fault_message(value: &serde_json::Value) -> Str {
	if let Some(message) = value
		.get("message")
		.or_else(|| value.get("error"))
		.and_then(serde_json::Value::as_str)
		.filter(|message| !message.is_empty())
	{
		return Str::new(message);
	}
	if let Some(kind) = value
		.get("kind")
		.or_else(|| value.get("code"))
		.and_then(serde_json::Value::as_str)
		.filter(|kind| !kind.is_empty())
	{
		return Str::new(kind.replace(['_', '-'], " "));
	}
	if let Some(message) = value.as_str().filter(|message| !message.is_empty()) {
		return Str::new(message);
	}
	Str::new_static("tool failed")
}

/// The journaled `CallOutcome` envelope (`{"kind":…,"value":…}`) the fold
/// stores on a settled `<result>` (`outcome`) or `<diag>` (`fault`).
fn node_outcome(node: &Node, prop: PropId) -> Option<&str> {
	match node.prop(&prop.into())? {
		omp_dom::Value::Json(value) => Some(value.get()),
		_ => None,
	}
}

/// Unwraps the `value` of a `CallOutcome` envelope whose `kind` is `kind`.
///
/// Cards apply no size limit of their own (ADR 0009: output is bounded once,
/// by dispatch, which spills over-limit outcomes to the CAS as
/// `CallOutcomeDetails` and journals the `<diag kind=truncated>` address);
/// whatever the element carries inline is what the card renders.
fn outcome_value<T: DeserializeOwned>(raw: &str, kind: &str) -> Option<T> {
	#[derive(serde::Deserialize)]
	struct Envelope<'a> {
		kind:  &'a str,
		#[serde(default)]
		value: Option<Box<serde_json::value::RawValue>>,
	}
	let envelope: Envelope<'_> = serde_json::from_str(raw).ok()?;
	if envelope.kind != kind {
		return None;
	}
	serde_json::from_str(envelope.value?.get()).ok()
}

fn node_data(node: &Node) -> Option<&str> {
	match node.prop(&PropId::Data.into())? {
		omp_dom::Value::Json(value) => Some(value.get()),
		_ => None,
	}
}

fn node_text(node: &Node) -> Option<&str> {
	node
		.prop(&PropId::Text.into())
		.and_then(omp_dom::Value::as_str)
		.filter(|text| !text.is_empty())
		.or(node.content.as_deref())
}

/// Renders a harness diagnostic without exposing its serialized protocol
/// object. Output bounding is an informational artifact continuation, not a
/// tool failure (ADR 0009).
fn render_notice(node: &Node) -> Option<Component> {
	let value = node_data(node)
		.and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
		.unwrap_or(serde_json::Value::Null);
	let data_text = |key| value.get(key).and_then(serde_json::Value::as_str);
	let prop_text = |prop: PropId| node.prop(&prop.into()).and_then(omp_dom::Value::as_str);

	let severity = prop_text(PropId::Severity)
		.or_else(|| data_text("severity"))
		.unwrap_or("info");
	if severity == "error" {
		return None;
	}
	let kind = prop_text(PropId::Kind)
		.or_else(|| data_text("kind"))
		.unwrap_or_default();
	let message = prop_text(PropId::Text)
		.filter(|text| !text.is_empty())
		.or_else(|| {
			data_text("text")
				.or_else(|| data_text("message"))
				.filter(|text| !text.is_empty())
		})
		.map(Str::new)
		.or_else(|| (kind == "output_bounded").then(|| Str::new_static("Output was bounded")))
		.or_else(|| (!kind.is_empty()).then(|| Str::from(kind.replace(['_', '-'], " "))))?;
	let continuation = prop_text(PropId::Continuation).or_else(|| data_text("continuation"));
	let artifact = prop_text(PropId::Recovery)
		.or_else(|| data_text("artifact"))
		.or_else(|| data_text("recovery"));
	let omitted = match node.prop(&PropId::Omitted.into()) {
		Some(omp_dom::Value::Int(count)) => u64::try_from(*count).ok(),
		_ => value
			.get("omitted")
			.and_then(|omitted| omitted.get("count"))
			.and_then(serde_json::Value::as_u64),
	};
	let unit = prop_text(PropId::Unit).or_else(|| {
		value
			.get("omitted")
			.and_then(|omitted| omitted.get("unit"))
			.and_then(serde_json::Value::as_str)
	});

	let mut content = StrMut::from(message);
	if let Some(count) = omitted {
		let _ = write!(content, " ({count} {} not shown)", unit.unwrap_or("items"));
	}
	if let Some(continuation) = continuation {
		let _ = write!(content, "\nContinue with {continuation}");
	}
	if let Some(artifact) = artifact {
		let _ = write!(content, "\n\n[Read {artifact} for full output]({artifact})");
	}
	let tone = if matches!(severity, "warn" | "warning") {
		"warn"
	} else {
		"info"
	};
	dom! { <callout kind={tone}>{content.freeze()}</callout> }
		.into_component()
		.into()
}

/// One typed renderer for a tool identity.
pub trait Card: Send + Sync {
	/// Tool name handled by this renderer.
	fn tool(&self) -> &'static str;

	/// Builds retained semantic markup for the current element state.
	fn render(&self, el: &CardView<'_>, expanded: bool, ui: &UiContext) -> Component;
}

/// Tool-identity keyed card renderer registry with a generic fallback.
#[derive(Clone)]
pub struct CardRegistry {
	cards:    BTreeMap<&'static str, Arc<dyn Card>>,
	fallback: Arc<GenericCard>,
}

impl CardRegistry {
	/// Builds the standard registry. Tool-specific cards extend this seam.
	#[must_use]
	pub fn standard() -> Self {
		let mut registry = Self { cards: BTreeMap::new(), fallback: Arc::new(GenericCard) };
		registry.register(apply_patch::ApplyPatchCard);
		registry.register(ask::AskCard);
		registry.register(ast_edit::AstEditCard);
		registry.register(ast_grep::AstGrepCard);
		registry.register(bash::BashCard);
		registry.register(browser::BrowserCard);
		registry.register(computer::ComputerCard);
		registry.register(context_gauge::ContextGaugeCard);
		registry.register(debug::DebugCard);
		registry.register(edit::EditCard);
		registry.register(eval::EvalCard);
		registry.register(github::GithubCard);
		registry.register(glob::GlobCard);
		registry.register(goal::GoalCard);
		registry.register(grep::GrepCard);
		registry.register(hub::HubCard);
		registry.register(lsp::LspCard);
		registry.register(memory::RecallCard);
		registry.register(memory::ReflectCard);
		registry.register(memory::RetainCard);
		registry.register(read::ReadCard);
		registry.register(report_issue::ReportIssueCard);
		registry.register(resolve::RejectCard);
		registry.register(resolve::ResolveCard);
		registry.register(task::TaskCard);
		registry.register(think::ThinkCard);
		registry.register(todo::TodoCard);
		registry.register(utility::CheckpointCard);
		registry.register(utility::ImageGenCard);
		registry.register(utility::LearnCard);
		registry.register(utility::ManageSkillCard);
		registry.register(utility::MemoryEditCard);
		registry.register(utility::RewindCard);
		registry.register(utility::SecurityScanCard);
		registry.register(utility::TtsCard);
		registry.register(utility::YieldCard);
		registry.register(web_search::WebSearchCard);
		registry.register(write::WriteCard);
		registry
	}

	/// Registers or replaces one typed card.
	pub fn register<C: Card + 'static>(&mut self, card: C) {
		self.cards.insert(card.tool(), Arc::new(card));
	}

	/// Returns whether a tool identity has a dedicated typed card.
	#[must_use]
	pub fn contains(&self, tool: &str) -> bool {
		self.cards.contains_key(tool)
	}

	/// Renders one tool, falling back to the generic element-state card.
	#[must_use]
	pub fn render(
		&self,
		tool: &str,
		view: &CardView<'_>,
		expanded: bool,
		ui: &UiContext,
	) -> Component {
		let card = self.cards.get(tool).map_or_else(
			|| self.fallback.render_named(tool, view, expanded, ui),
			|card| card.render(view, expanded, ui),
		);
		let notices = view
			.notices
			.iter()
			.filter_map(|node| render_notice(node))
			.collect::<Vec<_>>();
		if notices.is_empty() {
			card
		} else {
			dom! { <col>{card}{notices}</col> }.into_component()
		}
	}
}

impl Default for CardRegistry {
	fn default() -> Self {
		Self::standard()
	}
}
