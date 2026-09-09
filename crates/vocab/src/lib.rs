//! Canonical markup vocabulary used by `omp_tui::Prop` and `dom!` lowering.
//!
//! The macros provide one callback-style row source so all consumers expand the
//! same canonical list and cannot drift.

use core::{fmt, str::FromStr};

use omp_core::Str;
use serde::{Deserialize, Deserializer, Serialize, Serializer, de};
use strum::{Display, EnumString, IntoStaticStr, VariantArray};

/// Invokes `$callback!` with every well-known property row.
///
/// Grammar mirrors `define_props!`:
///
/// ```text
/// #[doc] Variant("markup-name") [@ setter | => field: Type [getter spec]];
/// ```
#[macro_export]
macro_rules! for_each_prop {
	($callback:ident) => {
		$callback! {
			/// Space between adjacent children.
			Gap("gap") => gap: u16 [default u16 = 0; "Returns the inter-child spacing, defaulting to zero."];
			/// Shorthand padding applied to both axes.
			Pad("pad") @ set_pad;
			/// Horizontal inner padding.
			PadX("pad-x") => pad_x: u16;
			/// Vertical inner padding.
			PadY("pad-y") => pad_y: u16;
			/// Flexible share of remaining layout space.
			Grow("grow") => grow: Toggle<f32> [toggle f32; "Returns the flexible growth weight, with a bare flag meaning one."];
			/// Preferred width in cells or percent.
			W("w") => w: Dim [copy Dim; "Returns the preferred width as a cell or percentage dimension."];
			/// Minimum width or numeric field value.
			Min("min") => min: Number;
			/// Maximum width or numeric field value.
			Max("max") => max: Number;
			/// Preferred height in rows.
			H("h") => h: u16 [copy u16; "Returns the preferred height in rows."];
			/// Border glyph family.
			Border("border") => border: Border [copy Border; "Returns the selected border glyph family."];
			/// Border color or gradient.
			Bc("bc") => bc: PropColor;
			/// Alternate name for the border color or gradient.
			Edge("edge") => edge: PropColor;
			/// Extends the background through border cells.
			Bleed("bleed") => bleed: bool [default bool = false; "Reports whether the background extends through the border."];
			/// Excludes the subtree's text from host-driven selection and copy.
			NoSelect("noselect") => noselect: bool [default bool = false; "Reports whether the subtree opts out of host text selection."];
			/// Terminal shell-integration zone the component's rows form (`prompt`: OSC 133 prompt zone).
			Zone("zone") => zone: Str;
			/// Display title for a container or step.
			Title("title") => title: Str [ref Str; "Returns the user-facing component title."];
			/// Horizontal placement of the border title.
			TitleAlign("title-align") => title_align: Align [default Align = Align::Start; "Returns the border-title placement, defaulting to the start edge."];
			/// Horizontal rule cells retained before a start-aligned border title.
			TitlePad("title-pad") => title_pad: u16 [default u16 = 1; "Returns the requested rule count before a start-aligned border title."];
			/// Display footer on a framed container's bottom edge.
			Footer("footer") => footer: Str [ref Str; "Returns the footer shown on a framed container's bottom border."];
			/// Horizontal placement of the border footer.
			FooterAlign("footer-align") => footer_align: Align [default Align = Align::Start; "Returns the border-footer placement, defaulting to the start edge."];
			/// Noun used by a row-clamped container's overflow summary.
			Overflow("overflow") => overflow: Str [ref Str; "Returns the noun used by the overflow summary."];
			/// Separator inserted between visible row children.
			Sep("sep") => sep: Str [ref Str; "Returns the separator inserted between visible row children."];
			/// Horizontal content alignment.
			Align("align") => align: Align [default Align = Align::Start; "Returns horizontal alignment, defaulting to the start edge."];
			/// Vertical content alignment.
			VAlign("valign") => valign: VAlign [copy VAlign; "Returns the configured vertical alignment."];
			/// Distribution of children along the layout axis.
			Justify("justify") => justify: Justify;
			/// Foreground color, theme token, or gradient.
			Fg("fg") => fg: PropColor;
			/// Background color, theme token, or gradient.
			Bg("bg") => bg: PropColor;
			/// Shorthand background color, theme token, or gradient.
			On("on") => on: PropColor;
			/// Enables bold text.
			Bold("bold") => bold: bool;
			/// Enables dim text.
			Dim("dim") => dim: bool;
			/// Enables italic text.
			Italic("italic") => italic: bool;
			/// Enables underlined text.
			Underline("underline") => underline: bool;
			/// Draws a curly underline (typo-squiggle shape).
			Undercurl("undercurl") => undercurl: bool;
			/// Swaps foreground and background colors.
			Reverse("reverse") => reverse: bool;
			/// Enables struck-through text.
			Strike("strike") => strike: bool;
			/// Enables wrapping rows; on text, a value selects the wrapping mode.
			Wrap("wrap") => wrap: WrapValue;
			/// Visual treatment for an interactive control.
			Variant("variant") => variant: Str;
			/// Marks an interactive control as selected or enabled.
			Active("active") => active: bool;
			/// Theme token or CSS color used as a control's semantic base color;
			/// doubles as the foreground when `fg` is absent.
			Color("color") => color: PropColor;
			/// Enables text truncation.
			Truncate("truncate") => truncate: Toggle<Truncate> [toggle Truncate; "Returns the configured truncation side, if truncation is enabled."];
			/// Crops transparent image margins before cell sampling.
			Trim("trim") => trim: bool;
			/// Stable identifier used by updates and conditions.
			Id("id") => id: Str [ref Str; "Returns the stable component identifier."];
			/// Visibility condition referencing another component value.
			When("when") => when: Str;
			/// Initial or submitted field value.
			Value("value") => value: Scalar;
			/// Stable application-facing key for a tree node.
			Key("key") => key: Str;
			/// Space-delimited choices for a selection field.
			Options("options") => options: Str;
			/// User-facing field or item label.
			Label("label") => label: Str;
			/// Root-phase numbering style.
			Numbering("numbering") => numbering: Str;
			/// Dim leading segment rendered before a tree node label.
			Prefix("prefix") => prefix: Str;
			/// Right-aligned annotation on a tree node row.
			Annotation("annotation") => annotation: Str;
			/// Color of a tree-node annotation.
			AnnotationColor("annotation-color") => annotation_color: PropColor;
			/// Optional trailing tree-node action chip label and event value.
			Action("action") => action: Str;
			/// Color of a tree-node action chip.
			ActionColor("action-color") => action_color: PropColor;
			/// Supporting description for an option.
			Desc("desc") => desc: Str;
			/// Field control kind.
			Kind("kind") => kind: Str;
			/// Numeric increment or wizard step metadata.
			Step("step") => step: i64;
			/// Enables multiple selection.
			Multi("multi") => multi: bool;
			/// Uses compact magnitude formatting.
			Compact("compact") => compact: bool [default bool = false; "Reports whether compact magnitude formatting is enabled."];
			/// Marks a read-only choice as selected.
			Selected("selected") => selected: bool [default bool = false; "Reports whether a read-only choice is selected."];
			/// Enables interactive option filtering.
			Filter("filter") => filter: FilterValue;
			/// Allows values outside the listed options.
			Custom("custom") => custom: bool;
			/// Obscures input contents.
			Mask("mask") => mask: bool;
			/// Initial checked state for a checkbox.
			Checked("checked") => checked: bool;
			/// Reference character limit used by the remaining-character counter.
			Limit("limit") => limit: u16 [copy u16; "Returns the configured input character limit."];
			/// Maximum retained preview depth.
			MaxDepth("max-depth") => max_depth: u16 [copy u16; "Returns the configured preview depth cap."];
			/// Maximum retained text character count.
			MaxChars("max-chars") => max_chars: u16 [copy u16; "Returns the configured text character cap."];
			/// Draws a focus-sensitive leading rail beside editable text.
			Rail("rail") => rail: bool;
			/// Maximum component content height in physical rows.
			MaxRows("max-rows") => max_rows: u16 [copy u16; "Returns the configured physical-row cap."];
			/// Side removed by a character limit.
			TruncateFrom("truncate-from") => truncate_from: Truncate [default Truncate = Truncate::End; "Returns the side removed by a character limit."];
			/// Enables line-number gutters.
			Numbers("numbers") => numbers: bool [default bool = false; "Reports whether line-number gutters are enabled."];
			/// First displayed line number.
			Start("start") => start: u64 [default u64 = 1; "Returns the first displayed line number, defaulting to one."];
			/// Marks an option as the recommended default.
			Recommended("recommended") => recommended: bool;
			/// Expands a tree node initially.
			Open("open") => open: bool;
			/// Requires a nonempty field value.
			Required("required") => required: bool;
			/// Pattern that a field value must satisfy.
			Match("match") => match_pattern: Str;
			/// Image or external content source.
			Src("src") => src: Str;
			/// OSC 8 hyperlink target applied to text descendants.
			Href("href") => href: Str [ref Str; "Returns the hyperlink target attached to text."];
			/// Source file path whose extension selects diff syntax highlighting.
			Path("path") => path: Str [ref Str; "Returns the source file path used to infer a language."];
			/// Leading icon name.
			Icon("icon") => icon: Str;
			/// Compact status label.
			Badge("badge") => badge: Str;
			/// Emits a submit event when activated.
			Submit("submit") => submit: bool;
			/// Emits a cancel event when activated.
			Cancel("cancel") => cancel: bool;
			/// Requires a second activation before committing.
			Confirm("confirm") => confirm: bool;
			/// Hint shown by an empty input.
			Placeholder("placeholder") => placeholder: Str;
			/// Gradient direction in screen degrees.
			Angle("angle") => angle: Angle [default u16 = 0; "Returns the normalized gradient direction in screen degrees."];
			/// Applies accent styling to an action.
			Accent("accent") => accent: bool;
			/// Selects vertical rendering where supported.
			Vertical("vertical") => vertical: bool;
			/// Transition duration for animatable properties.
			Anim("anim") => anim: Toggle<Ms<200>> [toggle Duration; "Returns the transition duration, with a bare flag selecting 200ms."];
			/// Easing curve applied to `anim` transitions.
			Ease("ease") => ease: Easing [default Easing = Easing::EaseOut; "Returns the easing curve, defaulting to ease-out."];
			/// Gradient rotation period.
			Spin("spin") => spin: Toggle<Ms<3000>> [toggle Duration; "Returns the gradient rotation period, with a bare flag selecting 3s."];
			/// Border color or gradient applied while the pointer rests on the component.
			Hover("hover") => hover: PropColor;
			/// Rows the component rises toward while hovered.
			Lift("lift") => lift: Toggle<u16> [toggle_default u16 = 0; "Returns rows of hover elevation, with a bare flag meaning one."];
			/// Opts the component into the keyboard focus ring.
			Focus("focus") => focus: bool;
			/// Tree guide connector family; a bare flag selects the square set.
			Guides("guides") => guides: Toggle<Border> [toggle Border; "Returns the tree guide connector family; a bare flag means square."];
			/// Task lifecycle state on a todo item.
			Status("status") => status: Str;
			/// Millisecond timestamp or duration.
			Ms("ms") => ms: u64 [copy u64; "Returns the configured millisecond value."];
			/// Added-item count.
			Added("added") => added: u64 [copy u64; "Returns the added-item count."];
			/// Removed-item count.
			Removed("removed") => removed: u64 [copy u64; "Returns the removed-item count."];
			/// Operation count.
			Ops("ops") => ops: u64 [copy u64; "Returns the operation count."];
			/// Sweep period of the brightness crest across text content.
			Shimmer("shimmer") => shimmer: Toggle<Ms<2000>> [toggle Duration; "Returns the shimmer period, with a bare flag selecting 2s."];
			/// Catch-up horizon for progressively revealed streamed text.
			Reveal("reveal") => reveal: Toggle<Ms<250>> [toggle Duration; "Returns the reveal horizon, with a bare flag selecting 250ms."];
			/// Marks content as an incomplete stream whose final-only repairs must stay disabled.
			Partial("partial") => partial: bool [default bool = false; "Returns whether the content is still streaming."];
			/// Number of unchanged lines retained around each diff change.
			Context("context") => context: u16 [copy u16; "Returns the configured diff context-line count."];
			/// Draws the diff pane's density minimap.
			Minimap("minimap") => minimap: bool;
		}
	}
}

/// Invokes `$callback!` with every typed component tag row.
///
/// `icon` is absent by design; `dom!` still handles it with special-cased
/// behavior.
#[macro_export]
macro_rules! for_each_component {
	($callback:ident) => {
		$callback! {
			box => Boxed;
			text => TextLeaf;
			pre => Pre;
			md => Markdown;
			latex => Latex;
			callout => Callout;
			col => Col;
			row => Row;
			hr => Hr;
			spacer => Spacer;
			select => Select;
			table => Table;
			radio => Radio;
			segmented => Segmented;
			checkbox => Checkbox;
			spinner => Spinner;
			strike => Strike;
			status => Status;
			input => Input;
			button => Button;
			scroll => Scroll;
			tabs => Tabs;
			tree => Tree;
			todo => Todo;
			form => Form;
			progress => Progress;
			qr => Qr;
			time => Time;
			img => Img;
			diff => DiffView;
			logo => Logo;
			editor => EditorPane;
			wizard => Wizard;
		}
	};
}

/// Closed, structural element names in the session tree.
#[derive(
	Clone,
	Copy,
	Debug,
	Display,
	EnumString,
	Eq,
	Hash,
	IntoStaticStr,
	Ord,
	PartialEq,
	PartialOrd,
	VariantArray,
)]
#[strum(serialize_all = "kebab-case")]
pub enum KnownTag {
	/// Session document root.
	Session,
	/// Journal-derived durable state.
	Meta,
	/// Transcript body.
	Body,
	/// Controller input queues.
	Queues,
	/// Todo component.
	Todo,
	/// One todo item.
	Item,
	/// Background work component.
	Jobs,
	/// One background job.
	Job,
	/// Director stack component.
	Directors,
	/// One engaged director.
	Director,
	/// Console-variable component.
	Con,
	/// One console variable.
	Var,
	/// Compaction boundary and summary state.
	Compaction,
	/// Explicit turn container.
	Turn,
	/// User message.
	User,
	/// Assistant message.
	Assistant,
	/// Developer message.
	Developer,
	/// Journaled notice.
	Notice,
	/// Steering queue.
	Steering,
	/// Deferred prompts queue.
	Prompts,
	/// One deferred prompt.
	Prompt,
	/// One child agent.
	Subagent,
	/// Tool input.
	Input,
	/// Tool result.
	Result,
	/// Tool diagnostic.
	Diag,
	/// Usage accounting.
	Usage,
}

impl KnownTag {
	/// Every structural tag in stable declaration order.
	pub const ALL: &'static [Self] = <Self as VariantArray>::VARIANTS;
}

/// A session-tree element name.
///
/// Built-in structural names are closed in [`KnownTag`]. Tool names use the
/// custom form so adding a tool does not expand the structural vocabulary.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum Tag {
	/// A structural element.
	Known(KnownTag),
	/// A tool-name element.
	Custom(Str),
}

impl Tag {
	/// Returns the markup name.
	#[must_use]
	pub fn as_str(&self) -> &str {
		match self {
			Self::Known(tag) => <&'static str>::from(*tag),
			Self::Custom(name) => name.as_str(),
		}
	}
}

impl From<KnownTag> for Tag {
	fn from(value: KnownTag) -> Self {
		Self::Known(value)
	}
}

impl FromStr for Tag {
	type Err = core::convert::Infallible;

	fn from_str(value: &str) -> Result<Self, Self::Err> {
		if let Some(name) = value.strip_prefix("tool:") {
			return Ok(Self::Custom(Str::new(name)));
		}
		Ok(KnownTag::from_str(value).map_or_else(|_| Self::Custom(Str::new(value)), Self::Known))
	}
}

impl fmt::Display for Tag {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter.write_str(self.as_str())
	}
}

impl Serialize for Tag {
	fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
	where
		S: Serializer,
	{
		match self {
			Self::Known(tag) => serializer.serialize_str(<&'static str>::from(*tag)),
			Self::Custom(name) => {
				serializer.collect_str(&SerializedCustom { prefix: "tool:", name: name.as_str() })
			},
		}
	}
}

impl<'de> Deserialize<'de> for Tag {
	fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
	where
		D: Deserializer<'de>,
	{
		let value = Str::deserialize(deserializer)?;
		Self::from_str(value.as_str()).map_err(de::Error::custom)
	}
}

/// Closed, well-known session-tree property names.
#[derive(
	Clone,
	Copy,
	Debug,
	Display,
	EnumString,
	Eq,
	Hash,
	IntoStaticStr,
	Ord,
	PartialEq,
	PartialOrd,
	VariantArray,
)]
#[strum(serialize_all = "kebab-case")]
pub enum PropId {
	/// Stable journal or tool identity.
	Id,
	/// Lifecycle status.
	Status,
	/// Schema revision.
	Rev,
	/// Model-facing tool intent.
	I,
	/// Diagnostic severity.
	Severity,
	/// Model identity.
	Model,
	/// Provider identity.
	Provider,
	/// Resolved route identity.
	Route,
	/// Inference stop reason.
	StopReason,
	/// Text content.
	Text,
	/// Model thinking content.
	Thinking,
	/// Name or key.
	Name,
	/// Semantic kind.
	Kind,
	/// Whether an element is engaged.
	Engaged,
	/// Stream identifier.
	Sid,
	/// Filesystem or resource path.
	Path,
	/// Line range or count.
	Lines,
	/// Journal entry that caused the node.
	Cause,
	/// Tool arguments.
	Args,
	/// Tool outcome.
	Outcome,
	/// Tool fault.
	Fault,
	/// Structured update data.
	Data,
	/// Tool call identifier.
	CallId,
	/// Input token count.
	TokensIn,
	/// Output token count.
	TokensOut,
	/// Cost in nano-US dollars.
	CostNanoUsd,
	/// Prompt-cache tokens read.
	CacheRead,
	/// Prompt-cache tokens written.
	CacheWrite,
	/// Milliseconds from request start to the first streamed token.
	TtftMs,
	/// Milliseconds from request start to completion.
	DurationMs,
	/// Provider premium-request units billed for one request, in millionths
	/// (`1_000_000` = one request).
	PremiumRequests,
	/// Compaction boundary.
	Boundary,
	/// Content-addressed summary.
	Summary,
	/// Maintenance method that produced a summary (compaction, handoff, …).
	Method,
	/// Context tokens before a maintenance step.
	TokensBefore,
	/// Context tokens after a maintenance step.
	TokensAfter,
	/// Ordered snapcompact frame references retained by a compaction.
	Frames,
	/// Number of snapcompact frames retained by a compaction.
	FrameCount,
	/// Human-readable warning attached to an element.
	Warning,
	/// Message author attribution (a collaboration guest, an agent).
	Author,
	/// Whether a user message was synthesized by an agent rather than typed.
	Synthetic,
	/// Turn ordinal.
	Turn,
	/// Element ordinal.
	Order,
	/// Active tool revision.
	Revision,
	/// Human-readable detail.
	Detail,
	/// Whether work is live.
	Live,
	/// Result byte count.
	Bytes,
	/// Process exit code.
	Exit,
	/// Terminating signal.
	Signal,
	/// Operation name.
	Op,
	/// Tool or job deadline.
	Until,
	/// Selector text.
	Selector,
	/// Literal value.
	Value,
	/// Display label.
	Label,
	/// Usage node handle.
	Usage,
	/// MIME type.
	Mime,
	/// Content-addressed blob.
	Blob,
	/// Whether data was truncated.
	Truncated,
	/// Full-result recovery address.
	Recovery,
	/// Selector or argument that fetches the next slice of a bounded result.
	Continuation,
	/// Count of content elided from an inline result.
	Omitted,
	/// Unit of an elided count (lines, rows, entries, …).
	Unit,
}

impl PropId {
	/// Every well-known property in stable declaration order.
	pub const ALL: &'static [Self] = <Self as VariantArray>::VARIANTS;
}

/// A property key, closed for engine semantics and extensible for tool data.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum PropKey {
	/// A well-known engine property.
	Known(PropId),
	/// A tool-defined property.
	Custom(Str),
}

impl PropKey {
	/// Returns the logical property name without the custom wire prefix.
	#[must_use]
	pub fn as_str(&self) -> &str {
		match self {
			Self::Known(prop) => <&'static str>::from(*prop),
			Self::Custom(name) => name.as_str(),
		}
	}
}

impl From<PropId> for PropKey {
	fn from(value: PropId) -> Self {
		Self::Known(value)
	}
}

impl FromStr for PropKey {
	type Err = core::convert::Infallible;

	fn from_str(value: &str) -> Result<Self, Self::Err> {
		if let Some(name) = value.strip_prefix("custom:") {
			return Ok(Self::Custom(Str::new(name)));
		}
		Ok(PropId::from_str(value).map_or_else(|_| Self::Custom(Str::new(value)), Self::Known))
	}
}

impl fmt::Display for PropKey {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter.write_str(self.as_str())
	}
}

impl Serialize for PropKey {
	fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
	where
		S: Serializer,
	{
		match self {
			Self::Known(prop) => serializer.serialize_str(<&'static str>::from(*prop)),
			Self::Custom(name) => {
				serializer.collect_str(&SerializedCustom { prefix: "custom:", name: name.as_str() })
			},
		}
	}
}

struct SerializedCustom<'a> {
	prefix: &'static str,
	name:   &'a str,
}

impl fmt::Display for SerializedCustom<'_> {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter.write_str(self.prefix)?;
		formatter.write_str(self.name)
	}
}

impl<'de> Deserialize<'de> for PropKey {
	fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
	where
		D: Deserializer<'de>,
	{
		let value = Str::deserialize(deserializer)?;
		Self::from_str(value.as_str()).map_err(de::Error::custom)
	}
}

#[cfg(test)]
mod tests {
	use core::str::FromStr as _;

	use super::{KnownTag, PropId};

	#[test]
	fn known_tags_round_trip_through_strum() {
		for &tag in KnownTag::ALL {
			let name = <&'static str>::from(tag);
			assert_eq!(KnownTag::from_str(name), Ok(tag));
			assert_eq!(tag.to_string(), name);
		}
	}

	#[test]
	fn known_properties_round_trip_through_strum() {
		for &prop in PropId::ALL {
			let name = <&'static str>::from(prop);
			assert_eq!(PropId::from_str(name), Ok(prop));
			assert_eq!(prop.to_string(), name);
		}
	}
}
