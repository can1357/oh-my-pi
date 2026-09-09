//! `dom!` markup lowering: lowers the shared markup grammar into `omp_tui`
//! component-builder calls.

use proc_macro2::{Ident, Span, TokenStream as TokenStream2};
use quote::{format_ident, quote};
use syn::LitStr;

use crate::markup::{Attr, AttrValue, Child, Control, Element, Parser};

/// Expands the `dom!` body into component-builder calls.
pub fn expand(input: TokenStream2) -> syn::Result<TokenStream2> {
	let mut parser = Parser::new(input);
	let root = parser.element()?;
	if let Some(token) = parser.peek() {
		return Err(syn::Error::new(token.span(), "expected a single root element"));
	}
	lower_element(&root)
}

#[derive(Clone, Copy)]
struct EditorPaths(u8);

impl EditorPaths {
	const EMPTY: Self = Self(1);
	const NONE: Self = Self(0);

	fn add(self, element: &Element) -> syn::Result<Self> {
		let kind = if element.name.text == "status" { 2 } else { 1 };
		let mut next = 0;
		for state in 0_u8..4 {
			let path = 1_u8 << state;
			if self.0 & path == 0 {
				continue;
			}
			if state & kind != 0 {
				return Err(syn::Error::new(
					element.name.span,
					"editor takes at most one input child and one <status>",
				));
			}
			next |= 1_u8 << (state | kind);
		}
		Ok(Self(next))
	}

	const fn union(self, other: Self) -> Self {
		Self(self.0 | other.0)
	}
}

fn validate_editor_children(children: &[Child]) -> syn::Result<()> {
	validate_editor_sequence(EditorPaths::EMPTY, children).map(|_| ())
}

fn validate_editor_sequence(
	mut paths: EditorPaths,
	children: &[Child],
) -> syn::Result<EditorPaths> {
	for child in children {
		paths = match child {
			Child::Element(element) => paths.add(element)?,
			Child::Control(control) => validate_editor_control(paths, control)?,
			Child::Expr(_) | Child::String(_) => paths,
		};
	}
	Ok(paths)
}

fn validate_editor_control(paths: EditorPaths, control: &Control) -> syn::Result<EditorPaths> {
	match control {
		Control::For(control) => {
			if let Some(element) = first_editor_element(&control.body) {
				return Err(syn::Error::new(
					element.name.span,
					"editor cannot produce input or <status> children from a for loop",
				));
			}
			Ok(paths)
		},
		Control::If(control) => {
			let mut next = if control.else_body.is_some() {
				EditorPaths::NONE
			} else {
				paths
			};
			for branch in &control.branches {
				next = next.union(validate_editor_sequence(paths, &branch.body)?);
			}
			if let Some(children) = &control.else_body {
				next = next.union(validate_editor_sequence(paths, children)?);
			}
			Ok(next)
		},
		Control::Match(control) => {
			if control.arms.is_empty() {
				return Ok(paths);
			}
			let mut next = EditorPaths::NONE;
			for arm in &control.arms {
				next = next.union(validate_editor_sequence(paths, &arm.body)?);
			}
			Ok(next)
		},
	}
}

fn first_editor_element(children: &[Child]) -> Option<&Element> {
	children.iter().find_map(|child| match child {
		Child::Element(element) => Some(element),
		Child::Expr(_) | Child::String(_) => None,
		Child::Control(Control::For(control)) => first_editor_element(&control.body),
		Child::Control(Control::If(control)) => control
			.branches
			.iter()
			.find_map(|branch| first_editor_element(&branch.body))
			.or_else(|| control.else_body.as_deref().and_then(first_editor_element)),
		Child::Control(Control::Match(control)) => control
			.arms
			.iter()
			.find_map(|arm| first_editor_element(&arm.body)),
	})
}

fn lower_element(element: &Element) -> syn::Result<TokenStream2> {
	if is_data_tag(&element.name.text) {
		return Err(syn::Error::new(
			element.name.span,
			format!("<{}> is only valid inside its owning component", element.name.text),
		));
	}

	let mut output = lower_constructor(element);
	for attr in &element.attrs {
		if element.name.text != "icon" || attr.name != "name" {
			output = lower_attr(output, attr)?;
		}
	}

	if is_text_tag(&element.name.text) {
		for child in &element.children {
			output = lower_child(output, ChildTarget::Text(&element.name.text), child)?;
		}
		return Ok(output);
	}
	if element.name.text == "editor" {
		validate_editor_children(&element.children)?;
		for child in &element.children {
			output = lower_child(output, ChildTarget::Editor, child)?;
		}
		return Ok(output);
	}

	for child in &element.children {
		output = lower_child(output, ChildTarget::Owner(&element.name.text), child)?;
	}
	Ok(output)
}

fn lower_constructor(element: &Element) -> TokenStream2 {
	if let Some(icon) = &element.name.icon {
		let icon = LitStr::new(icon, element.name.span);
		return quote!(::omp_tui::components::Icon::named(#icon));
	}

	if element.name.text == "icon" {
		let name = attr_named(&element.attrs, "name").map_or_else(|| quote!(""), attr_tokens);
		return quote!(::omp_tui::components::Icon::named(#name));
	}

	if let Some(component) = component_type(&element.name.text) {
		let component = format_ident!("{component}", span = element.name.span);
		quote!(::omp_tui::components::#component::new())
	} else {
		let name = LitStr::new(&element.name.text, element.name.span);
		quote!(::omp_tui::components::CustomElement::new(#name))
	}
}

fn lower_attrs(mut output: TokenStream2, attrs: &[Attr]) -> syn::Result<TokenStream2> {
	for attr in attrs {
		output = lower_attr(output, attr)?;
	}
	Ok(output)
}

fn lower_attr(output: TokenStream2, attr: &Attr) -> syn::Result<TokenStream2> {
	if matches!(attr.name.as_str(), "gradient" | "dir") {
		return Err(syn::Error::new(
			attr.span,
			"gradient and dir were replaced by fg=/bg= and angle=",
		));
	}
	let name = LitStr::new(&attr.name, attr.span);
	let value = attr_tokens(attr);
	if let Some(prop) = prop_variant(&attr.name) {
		let prop = format_ident!("{prop}", span = attr.span);
		Ok(quote!(#output.with(::omp_tui::Prop::#prop, #value)))
	} else {
		Ok(quote!(#output.with_custom(#name, #value)))
	}
}

fn attr_tokens(attr: &Attr) -> TokenStream2 {
	match &attr.value {
		AttrValue::Flag => quote!(true),
		AttrValue::String(value) | AttrValue::Bare(value) => quote!(#value),
		AttrValue::Expr(value) => quote!(#value),
	}
}

#[derive(Clone, Copy)]
enum ChildTarget<'a> {
	Owner(&'a str),
	Text(&'a str),
	Editor,
	DataRecord,
	StatusSegment,
	TreeNode,
	TodoTask,
	Pane,
	TableRow,
}

fn lower_child(
	output: TokenStream2,
	target: ChildTarget<'_>,
	child: &Child,
) -> syn::Result<TokenStream2> {
	match child {
		Child::Control(control) => lower_control(output, target, control),
		Child::Expr(expr) => match target {
			ChildTarget::Owner(_) | ChildTarget::Pane => Ok(quote!(#output.child(#expr))),
			ChildTarget::Text(_) => Ok(quote!(#output.text(#expr))),
			ChildTarget::Editor => {
				let span = expr
					.clone()
					.into_iter()
					.next()
					.map_or_else(Span::call_site, |token| token.span());
				Err(syn::Error::new(span, "editor takes element children only"))
			},
			ChildTarget::DataRecord
			| ChildTarget::StatusSegment
			| ChildTarget::TreeNode
			| ChildTarget::TodoTask => Ok(quote!(#output.label(#expr))),
			ChildTarget::TableRow => {
				let span = expr
					.clone()
					.into_iter()
					.next()
					.map_or_else(Span::call_site, |token| token.span());
				Err(syn::Error::new(span, "<tr> takes <td> children only"))
			},
		},
		Child::String(text) => match target {
			ChildTarget::Owner(_) | ChildTarget::Pane => Ok(quote!(#output.child(#text))),
			ChildTarget::Text(_) => Ok(quote!(#output.text(#text))),
			ChildTarget::Editor => {
				Err(syn::Error::new(text.span(), "editor takes element children only"))
			},
			ChildTarget::DataRecord
			| ChildTarget::StatusSegment
			| ChildTarget::TreeNode
			| ChildTarget::TodoTask => Ok(quote!(#output.label(#text))),
			ChildTarget::TableRow => {
				Err(syn::Error::new(text.span(), "<tr> takes <td> children only"))
			},
		},
		Child::Element(element) => match target {
			ChildTarget::Owner(owner) if is_data_tag(&element.name.text) => {
				lower_data_child(output, owner, element)
			},
			ChildTarget::DataRecord if element.name.text == "td" => {
				let cell = lower_table_cell(element)?;
				Ok(quote!(#output.cell(#cell)))
			},
			ChildTarget::TableRow if element.name.text == "td" => {
				let cell = lower_table_cell(element)?;
				Ok(quote!(#output.cell(#cell)))
			},
			ChildTarget::TableRow => {
				Err(syn::Error::new(element.name.span, "<tr> takes <td> children only"))
			},
			ChildTarget::Owner(_) | ChildTarget::DataRecord | ChildTarget::Pane => {
				let element = lower_element(element)?;
				Ok(quote!(#output.child(#element)))
			},
			ChildTarget::Text(owner) => Err(syn::Error::new(
				element.name.span,
				format!("elements are not allowed inside <{owner}>; use a string literal or {{expr}}"),
			)),
			ChildTarget::Editor if element.name.text == "status" => {
				let element = lower_element(element)?;
				Ok(quote!(#output.status(#element)))
			},
			ChildTarget::Editor => {
				let element = lower_element(element)?;
				Ok(quote!(#output.input(#element)))
			},
			ChildTarget::StatusSegment => Err(syn::Error::new(
				element.name.span,
				"elements are not allowed inside <segment>; use a string literal or braced expression",
			)),
			ChildTarget::TreeNode if element.name.text == "node" => {
				let nested = lower_tree_node(element)?;
				Ok(quote!(#output.node(#nested)))
			},
			ChildTarget::TodoTask if element.name.text == "task" => {
				let nested = lower_todo_task(element)?;
				Ok(quote!(#output.task(#nested)))
			},
			ChildTarget::TreeNode | ChildTarget::TodoTask => {
				let element = lower_element(element)?;
				Ok(quote!(#output.child(#element)))
			},
		},
	}
}

fn lower_control(
	output: TokenStream2,
	target: ChildTarget<'_>,
	control: &Control,
) -> syn::Result<TokenStream2> {
	let builder = format_ident!("__omp_tui_layout", span = Span::mixed_site());
	let statements = lower_control_statements(&builder, target, control)?;
	if control_adds_children(control) {
		Ok(quote!({
			let mut #builder = #output;
			#statements
			#builder
		}))
	} else {
		Ok(quote!({
			let #builder = #output;
			#statements
			#builder
		}))
	}
}

fn lower_control_statements(
	builder: &Ident,
	target: ChildTarget<'_>,
	control: &Control,
) -> syn::Result<TokenStream2> {
	match control {
		Control::For(control) => {
			let head = &control.head;
			let body = lower_child_statements(builder, target, &control.body)?;
			Ok(quote!(#head { #body }))
		},
		Control::If(control) => {
			let mut output = TokenStream2::new();
			for (index, branch) in control.branches.iter().enumerate() {
				let head = &branch.head;
				let body = lower_child_statements(builder, target, &branch.body)?;
				if index == 0 {
					output.extend(quote!(#head { #body }));
				} else {
					output.extend(quote!(else #head { #body }));
				}
			}
			if let Some(children) = &control.else_body {
				let body = lower_child_statements(builder, target, children)?;
				output.extend(quote!(else { #body }));
			}
			Ok(output)
		},
		Control::Match(control) => {
			let head = &control.head;
			let mut arms = TokenStream2::new();
			for arm in &control.arms {
				let prefix = &arm.prefix;
				let body = lower_child_statements(builder, target, &arm.body)?;
				arms.extend(quote!(#prefix => { #body },));
			}
			Ok(quote!(#head { #arms }))
		},
	}
}

fn lower_child_statements(
	builder: &Ident,
	target: ChildTarget<'_>,
	children: &[Child],
) -> syn::Result<TokenStream2> {
	let mut statements = TokenStream2::new();
	for child in children {
		let statement = match child {
			Child::Control(control) => lower_control_statements(builder, target, control)?,
			Child::Element(_) | Child::Expr(_) | Child::String(_) => {
				let next = lower_child(quote!(#builder), target, child)?;
				quote!(#builder = #next;)
			},
		};
		statements.extend(statement);
	}
	Ok(statements)
}

fn control_adds_children(control: &Control) -> bool {
	match control {
		Control::For(control) => children_add(&control.body),
		Control::If(control) => {
			control
				.branches
				.iter()
				.any(|branch| children_add(&branch.body))
				|| control.else_body.as_deref().is_some_and(children_add)
		},
		Control::Match(control) => control.arms.iter().any(|arm| children_add(&arm.body)),
	}
}

fn children_add(children: &[Child]) -> bool {
	children.iter().any(|child| match child {
		Child::Control(control) => control_adds_children(control),
		Child::Element(_) | Child::Expr(_) | Child::String(_) => true,
	})
}

fn lower_data_child(
	output: TokenStream2,
	owner: &str,
	data: &Element,
) -> syn::Result<TokenStream2> {
	let valid_owner = matches!(
		(owner, data.name.text.as_str()),
		("select" | "segmented", "option")
			| ("status", "segment")
			| ("tabs", "tab")
			| ("tree", "node")
			| ("todo", "task")
			| ("form", "field")
			| ("wizard", "step")
			| ("table", "tr")
	);
	if !valid_owner {
		return Err(syn::Error::new(
			data.name.span,
			format!("<{}> is not valid inside <{owner}>", data.name.text),
		));
	}

	match data.name.text.as_str() {
		"option" => {
			let item = lower_data_record("SelectOption", data)?;
			Ok(quote!(#output.option(#item)))
		},
		"segment" => {
			let item = lower_status_segment(data)?;
			Ok(quote!(#output.segment(#item)))
		},
		"field" => {
			let item = lower_data_record("Field", data)?;
			Ok(quote!(#output.field(#item)))
		},
		"node" => {
			let item = lower_tree_node(data)?;
			Ok(quote!(#output.node(#item)))
		},
		"task" => {
			let item = lower_todo_task(data)?;
			Ok(quote!(#output.task(#item)))
		},
		"tab" => lower_named_pane(output, "pane", data),
		"step" => lower_named_pane(output, "step", data),
		"tr" => {
			let item = lower_table_row(data)?;
			Ok(quote!(#output.row(#item)))
		},
		_ => unreachable!("all data-only tags were matched"),
	}
}

fn lower_data_record(kind: &str, data: &Element) -> syn::Result<TokenStream2> {
	let kind = format_ident!("{kind}", span = data.name.span);
	let mut output = quote!(::omp_tui::components::#kind::new());
	output = lower_attrs(output, &data.attrs)?;
	for child in &data.children {
		output = lower_child(output, ChildTarget::DataRecord, child)?;
	}
	Ok(output)
}
fn lower_status_segment(data: &Element) -> syn::Result<TokenStream2> {
	let mut output = quote!(::omp_tui::components::Segment::new());
	output = lower_attrs(output, &data.attrs)?;
	for child in &data.children {
		output = lower_child(output, ChildTarget::StatusSegment, child)?;
	}
	Ok(output)
}

fn lower_tree_node(data: &Element) -> syn::Result<TokenStream2> {
	let mut output = quote!(::omp_tui::components::TreeNode::new());
	output = lower_attrs(output, &data.attrs)?;
	for child in &data.children {
		output = lower_child(output, ChildTarget::TreeNode, child)?;
	}
	Ok(output)
}

fn lower_todo_task(data: &Element) -> syn::Result<TokenStream2> {
	let mut output = quote!(::omp_tui::components::TodoTask::new());
	output = lower_attrs(output, &data.attrs)?;
	for child in &data.children {
		output = lower_child(output, ChildTarget::TodoTask, child)?;
	}
	Ok(output)
}

fn lower_table_row(data: &Element) -> syn::Result<TokenStream2> {
	let mut output = quote!(::omp_tui::components::TableRow::new());
	output = lower_attrs(output, &data.attrs)?;
	for child in &data.children {
		output = lower_child(output, ChildTarget::TableRow, child)?;
	}
	Ok(output)
}

fn lower_table_cell(data: &Element) -> syn::Result<TokenStream2> {
	let mut output = quote!(::omp_tui::components::TableCell::new());
	output = lower_attrs(output, &data.attrs)?;
	for child in &data.children {
		output = lower_child(output, ChildTarget::Pane, child)?;
	}
	Ok(output)
}

fn lower_named_pane(
	output: TokenStream2,
	method: &str,
	data: &Element,
) -> syn::Result<TokenStream2> {
	let method = format_ident!("{method}", span = data.name.span);
	let title = attr_named(&data.attrs, "title")
		.or_else(|| attr_named(&data.attrs, "label"))
		.map_or_else(|| quote!(""), attr_tokens);
	let mut body = quote!(::omp_tui::components::Col::new());
	for attr in &data.attrs {
		if attr.name != "title" && attr.name != "label" {
			body = lower_attr(body, attr)?;
		}
	}
	for child in &data.children {
		body = lower_child(body, ChildTarget::Pane, child)?;
	}
	Ok(quote!(#output.#method(#title, #body)))
}

fn attr_named<'a>(attrs: &'a [Attr], name: &str) -> Option<&'a Attr> {
	attrs.iter().find(|attr| attr.name == name)
}

fn is_text_tag(name: &str) -> bool {
	matches!(
		name,
		"text" | "pre" | "md" | "latex" | "callout" | "qr" | "spinner" | "strike" | "diff"
	)
}

fn is_data_tag(name: &str) -> bool {
	matches!(name, "option" | "segment" | "tab" | "node" | "task" | "field" | "step" | "tr" | "td")
}

macro_rules! prop_rows {
	($(
		$(#[$meta:meta])*
		$variant:ident($name:literal)
		$(@ $setter:ident)?
		$(=> $field:ident: $type:ty $([$($getter:tt)+])?)?;
	)+) => {
		[$(($name, stringify!($variant)),)+]
	};
}
const PROPS: &[(&str, &str)] = &omp_vocab::for_each_prop! { prop_rows };

fn prop_variant(name: &str) -> Option<&'static str> {
	let dashed = name.replace('_', "-");
	PROPS
		.iter()
		.find_map(|&(attr, variant)| (attr == dashed).then_some(variant))
}

macro_rules! component_rows {
	($($tag:ident => $type:ident;)+) => {
		[$((stringify!($tag), stringify!($type)),)+]
	};
}
const COMPONENTS: &[(&str, &str)] = &omp_vocab::for_each_component! { component_rows };

fn component_type(name: &str) -> Option<&'static str> {
	COMPONENTS
		.iter()
		.find_map(|&(tag, component)| (name == tag).then_some(component))
}

#[cfg(test)]
mod tests {
	use syn::{Expr, parse2};

	use super::*;

	#[test]
	fn prop_table_matches_vocabulary() {
		let mut names = omp_core::FastHashSet::default();
		let mut variants = omp_core::FastHashSet::default();
		for &(name, variant) in PROPS {
			assert!(names.insert(name), "duplicate attr name {name:?}");
			assert!(variants.insert(variant), "duplicate prop variant {variant:?}");
		}
		assert_eq!(prop_variant("valign"), Some("VAlign"));
		assert_eq!(prop_variant("noselect"), Some("NoSelect"));
		assert_eq!(prop_variant("minimap"), Some("Minimap"));
	}

	#[test]
	fn component_table_matches_vocabulary() {
		let mut tags = omp_core::FastHashSet::default();
		let mut components = omp_core::FastHashSet::default();
		for &(tag, component) in COMPONENTS {
			assert!(tags.insert(tag), "duplicate tag {tag:?}");
			assert!(components.insert(component), "duplicate component {component:?}");
		}
		assert_eq!(component_type("box"), Some("Boxed"));
		assert_eq!(component_type("editor"), Some("EditorPane"));
	}

	#[test]
	fn lowers_previously_untabled_props_typed() {
		let actual =
			expand(quote! { <text max-chars=80 sep=", ">{x}</text> }).expect("example should expand");
		let expected = quote! {
			::omp_tui::components::TextLeaf::new()
				.with(::omp_tui::Prop::MaxChars, "80")
				.with(::omp_tui::Prop::Sep, ", ")
				.text(x)
		};
		assert_eq!(actual.to_string(), expected.to_string());
	}

	#[test]
	fn lowers_plan_example() {
		let actual = expand(quote! {
			<box bg=yellow><row><col fg=blue><i:new/><text italic>{x}</text></col></row></box>
		})
		.expect("example should expand");
		let expected = quote! {
			::omp_tui::components::Boxed::new()
				.with(::omp_tui::Prop::Bg, "yellow")
				.child(::omp_tui::components::Row::new()
					.child(::omp_tui::components::Col::new()
						.with(::omp_tui::Prop::Fg, "blue")
						.child(::omp_tui::components::Icon::named("new"))
						.child(::omp_tui::components::TextLeaf::new()
							.with(::omp_tui::Prop::Italic, true)
							.text(x))))
		};
		assert_eq!(actual.to_string(), expected.to_string());
	}

	#[test]
	fn lowers_gradient_values_through_fg_bg_and_angle() {
		let actual = expand(quote! {
			<box bg="magenta..cyan" angle=45><text fg="yellow..red">"hi"</text></box>
		})
		.expect("gradient attributes should expand");
		let expected = quote! {
			::omp_tui::components::Boxed::new()
				.with(::omp_tui::Prop::Bg, "magenta..cyan")
				.with(::omp_tui::Prop::Angle, "45")
				.child(::omp_tui::components::TextLeaf::new()
					.with(::omp_tui::Prop::Fg, "yellow..red")
					.text("hi"))
		};
		assert_eq!(actual.to_string(), expected.to_string());
	}

	#[test]
	fn rejects_legacy_gradient_attributes() {
		for input in [quote!(<pre gradient="accent..info">"x"</pre>), quote!(<pre dir=h>"x"</pre>)] {
			let error = expand(input).expect_err("legacy gradient syntax must fail");
			assert!(error.to_string().contains("replaced by fg=/bg= and angle="));
		}
	}

	#[test]
	fn accepts_dash_names_percent_and_expr_values() {
		let actual = expand(quote!(<user-card pad-x=2 w=50% data-id={id}/>)).expect("valid layout");
		let expected = quote! {
			::omp_tui::components::CustomElement::new("user-card")
				.with(::omp_tui::Prop::PadX, "2")
				.with(::omp_tui::Prop::W, "50%")
				.with_custom("data-id", id)
		};
		assert_eq!(actual.to_string(), expected.to_string());
	}

	#[test]
	fn accepts_dashed_bare_values() {
		let actual = expand(quote!(<box ease=in-out lift=2/>)).expect("dashed values should expand");
		let expected = quote! {
			::omp_tui::components::Boxed::new()
				.with(::omp_tui::Prop::Ease, "in-out")
				.with(::omp_tui::Prop::Lift, "2")
		};
		assert_eq!(actual.to_string(), expected.to_string());
	}

	#[test]
	fn accepts_dashed_icon_shorthand() {
		for input in [quote!(<i:log-in/>), quote!(<i:log-in></i:log-in>)] {
			let actual = expand(input).expect("dashed icon shorthand should expand");
			let expected = quote!(::omp_tui::components::Icon::named("log-in"));
			assert_eq!(actual.to_string(), expected.to_string());
		}
	}

	#[test]
	fn lowers_typed_data_children() {
		let actual = expand(quote! {
			<select><option value=a>"Alpha"<md>"preview"</md></option></select>
		})
		.expect("data child should expand");
		let expected = quote! {
			::omp_tui::components::Select::new()
				.option(::omp_tui::components::SelectOption::new()
					.with(::omp_tui::Prop::Value, "a")
					.label("Alpha")
					.child(::omp_tui::components::Markdown::new().text("preview")))
		};
		assert_eq!(actual.to_string(), expected.to_string());
	}

	#[test]
	fn compact_control_tags_and_options_lower_to_typed_builders() {
		let actual = expand(quote! {
			<row><segmented id=view value=path><option value=path icon=view-path label="Path"/></segmented><checkbox id=amend checked label="Amend"/></row>
		})
		.expect("compact controls should expand");
		let expected = quote! {
			::omp_tui::components::Row::new()
				.child(::omp_tui::components::Segmented::new()
					.with(::omp_tui::Prop::Id, "view")
					.with(::omp_tui::Prop::Value, "path")
					.option(::omp_tui::components::SelectOption::new()
						.with(::omp_tui::Prop::Value, "path")
						.with(::omp_tui::Prop::Icon, "view-path")
						.with(::omp_tui::Prop::Label, "Path")))
				.child(::omp_tui::components::Checkbox::new()
					.with(::omp_tui::Prop::Id, "amend")
					.with(::omp_tui::Prop::Checked, true)
					.with(::omp_tui::Prop::Label, "Amend"))
		};
		assert_eq!(actual.to_string(), expected.to_string());
	}

	#[test]
	fn editor_children_lower_to_status_and_input_builders() {
		let actual = expand(quote! {
			<editor value="hi"><status><segment>{"S1"}</segment></status><input id=body/></editor>
		})
		.expect("editor element children should expand");
		let expected = quote! {
			::omp_tui::components::EditorPane::new()
				.with(::omp_tui::Prop::Value, "hi")
				.status(::omp_tui::components::Status::new()
					.segment(::omp_tui::components::Segment::new().label("S1")))
				.input(::omp_tui::components::Input::new()
					.with(::omp_tui::Prop::Id, "body"))
		};
		assert_eq!(actual.to_string(), expected.to_string());
	}

	#[test]
	fn editor_rejects_non_elements_and_extra_input_children() {
		for input in [quote!(<editor>{"text"}</editor>), quote!(<editor>"text"</editor>)] {
			let error = expand(input).expect_err("editor text children must fail");
			assert!(
				error
					.to_string()
					.contains("editor takes element children only")
			);
		}
		let error = expand(quote!(<editor><input/><button/></editor>))
			.expect_err("a second input child must fail");
		assert!(
			error
				.to_string()
				.contains("editor takes at most one input child and one <status>")
		);
	}

	#[test]
	fn editor_accepts_mutually_exclusive_control_flow_children() {
		expand(quote! {
			<editor>
				<status/>
				if custom {
					<input/>
				} else if alternate {
					<button/>
				} else {
					<row/>
				}
			</editor>
		})
		.expect("exclusive branches should contribute at most one editor input");
	}

	#[test]
	fn editor_rejects_duplicates_across_control_flow_paths() {
		for input in [
			quote!(<editor>if custom { <input/><button/> }</editor>),
			quote!(<editor><input/> if custom { <button/> }</editor>),
			quote!(<editor>if custom { <input/> } <button/></editor>),
			quote!(<editor>match mode {
				Mode::A => { <status/><status/> },
				_ => {},
			}</editor>),
		] {
			let error = expand(input).expect_err("one reachable path contains duplicate editor slots");
			assert!(
				error
					.to_string()
					.contains("editor takes at most one input child and one <status>")
			);
		}
	}

	#[test]
	fn editor_rejects_children_from_for_loops() {
		let error = expand(quote!(<editor>for item in items { <input value={item}/> }</editor>))
			.expect_err("an editor loop could produce the same slot more than once");
		assert!(
			error
				.to_string()
				.contains("editor cannot produce input or <status> children from a for loop")
		);
	}
	#[test]
	fn status_macro_lowers_segments() {
		let actual = expand(quote! {
			<status><segment fg=green data-kind={kind}>{"alpha"}</segment></status>
		})
		.expect("status segment should expand");
		let expected = quote! {
			::omp_tui::components::Status::new()
				.segment(::omp_tui::components::Segment::new()
					.with(::omp_tui::Prop::Fg, "green")
					.with_custom("data-kind", kind)
					.label("alpha"))
		};
		assert_eq!(actual.to_string(), expected.to_string());
	}

	#[test]
	fn rejects_segment_outside_status() {
		let error =
			expand(quote!(<segment>{"alpha"}</segment>)).expect_err("orphan segment must fail");
		assert!(
			error
				.to_string()
				.contains("only valid inside its owning component")
		);
	}

	#[test]
	fn lowers_for_if_else_and_match_children() {
		let expanded = expand(quote! {
			<col>
				for item in items {
					<text>{item}</text>
				}
				if ready {
					<text>"ready"</text>
				} else if waiting {
					<text>"waiting"</text>
				} else {
					<text>"idle"</text>
				}
				match state {
					State::One => <row/>,
					State::Many(value) if value > 1 => {
						<text>{value}</text>
						<spacer/>
					},
					_ => {},
				}
			</col>
		})
		.expect("control flow should expand");
		parse2::<Expr>(expanded).expect("expanded control flow should be a Rust expression");
	}

	#[test]
	fn points_out_mismatched_closer() {
		let error = expand(quote!(<row></col>)).expect_err("closer should not match");
		assert!(error.to_string().contains("mismatched closing tag"));
	}

	#[test]
	fn rejects_bare_text() {
		let error = expand(quote!(<text>hello</text>)).expect_err("bare text loses whitespace");
		assert!(
			error
				.to_string()
				.contains("text content must be a string literal or {expr}")
		);
	}
}
