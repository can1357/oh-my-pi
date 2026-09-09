use std::borrow::Cow;

use omp_core::{IntoStr, Str, StrMut};

use super::{overflow_plan, paint_overflow_footer};
use crate::{
	component::{Component, PaintCtx, Slot, next_slot},
	context::UiContext,
	frame::{Rect, Style},
	markup::Border,
	props::{Prop, PropValue, Props},
};

#[derive(Debug)]
struct Node {
	name:      String,
	directory: bool,
	children:  Vec<Self>,
}

impl Node {
	fn new(name: &str, directory: bool) -> Self {
		Self { name: name.to_owned(), directory, children: Vec::new() }
	}
}

#[derive(Debug)]
struct Root {
	heading:  Option<String>,
	children: Vec<Node>,
}

#[derive(Debug)]
struct FileRow {
	label:     String,
	directory: bool,
	heading:   bool,
	gutters:   Vec<bool>,
	last:      bool,
}

/// A compact, folded hierarchy of newline-delimited paths backing `<files>`.
///
/// Input order is stable and duplicate paths are discarded. Parsing and row
/// folding are cached until more body text is appended.
pub struct Files {
	props: Props,
	slot:  Slot,
	body:  Str,
	rows:  Vec<FileRow>,
	dirty: bool,
}

impl Files {
	/// Creates an empty file hierarchy.
	pub fn new() -> Self {
		Self {
			props: Props::new(),
			slot:  next_slot(),
			body:  Str::default(),
			rows:  Vec::new(),
			dirty: true,
		}
	}

	/// Sets one file-list property.
	pub fn with(mut self, prop: Prop, value: impl Into<PropValue>) -> Self {
		self.props.set(prop, value);
		self
	}

	/// Appends newline-delimited path text.
	pub fn text(mut self, text: impl IntoStr) -> Self {
		let text = text.into_str();
		if !self.body.is_empty() && !self.body.ends_with('\n') && !text.starts_with('\n') {
			append(&mut self.body, "\n");
		}
		append(&mut self.body, &text);
		self.dirty = true;
		self
	}

	fn rebuild(&mut self) {
		if !self.dirty {
			return;
		}
		let mut roots: Vec<Root> = Vec::new();
		for raw in self
			.body
			.lines()
			.map(str::trim)
			.filter(|line| !line.is_empty())
		{
			let normalized = if raw.contains('\\') {
				Cow::Owned(raw.replace('\\', "/"))
			} else {
				Cow::Borrowed(raw)
			};
			if is_url_like(&normalized) {
				let root = if let Some(index) = roots.iter().position(|root| root.heading.is_none()) {
					&mut roots[index]
				} else {
					roots.push(Root { heading: None, children: Vec::new() });
					roots.last_mut().expect("root was just inserted")
				};
				insert_path(&mut root.children, &[normalized.as_ref()], false);
				continue;
			}
			let directory = normalized.ends_with('/');
			let path = normalized.trim_end_matches('/');
			if path.is_empty() {
				continue;
			}
			let (heading, rest) = split_root(path);
			let root = if let Some(index) = roots
				.iter()
				.position(|root| root.heading.as_deref() == heading)
			{
				&mut roots[index]
			} else {
				roots.push(Root { heading: heading.map(str::to_owned), children: Vec::new() });
				roots.last_mut().expect("root was just inserted")
			};
			let parts: Vec<&str> = rest.split('/').filter(|part| !part.is_empty()).collect();
			if !parts.is_empty() {
				insert_path(&mut root.children, &parts, directory);
			}
		}
		self.rows.clear();
		for root in roots {
			if let Some(heading) = root.heading {
				self.rows.push(FileRow {
					label:     heading,
					directory: true,
					heading:   true,
					gutters:   Vec::new(),
					last:      false,
				});
			}
			flatten(root.children, &mut Vec::new(), &mut self.rows);
		}
		self.dirty = false;
	}

	#[cfg(test)]
	fn labels(&mut self) -> Vec<&str> {
		self.rebuild();
		self.rows.iter().map(|row| row.label.as_str()).collect()
	}
}

impl Default for Files {
	fn default() -> Self {
		Self::new()
	}
}

impl Component for Files {
	fn props(&self) -> &Props {
		&self.props
	}

	fn props_mut(&mut self) -> &mut Props {
		&mut self.props
	}

	fn slot(&self) -> Slot {
		self.slot
	}

	fn measure(&mut self, _ctx: &UiContext) -> (u16, u16) {
		self.rebuild();
		let natural = self
			.rows
			.iter()
			.map(|row| row.label.len().saturating_add(row.gutters.len() * 2 + 3))
			.max()
			.unwrap_or(1);
		(1, u16::try_from(natural).unwrap_or(u16::MAX))
	}

	fn height(&mut self, _ctx: &UiContext, _width: u16) -> u16 {
		self.rebuild();
		let natural = u16::try_from(self.rows.len()).unwrap_or(u16::MAX);
		overflow_plan(&self.props, natural, u16::MAX).map_or(natural, |plan| {
			plan
				.content_rows
				.saturating_add(u16::from(!plan.noun.is_empty()))
		})
	}

	fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
		self.rebuild();
		let natural = u16::try_from(self.rows.len()).unwrap_or(u16::MAX);
		let plan = overflow_plan(&self.props, natural, rect.height);
		let content_rows = plan.map_or(rect.height, |plan| plan.content_rows);
		let (branch, last, cont) = pc.ctx.charset.guides(Border::Square);
		let guide_style = Style::new().fg(pc.ctx.theme.muted);
		let text_style = self.props.style(&pc.ctx.theme);
		let visible = usize::from(content_rows.min(pc.clip.saturating_sub(rect.y)));
		for (offset, row) in self.rows.iter().take(visible).enumerate() {
			let y = rect.y.saturating_add(offset as u16);
			let mut x = rect.x;
			if !row.heading {
				for &more in &row.gutters {
					x = pc
						.frame
						.put(x, y, if more { cont } else { "  " }, guide_style);
				}
				x = pc
					.frame
					.put(x, y, if row.last { last } else { branch }, guide_style);
				x = pc.frame.put(x, y, " ", guide_style);
			}
			let style = if row.heading {
				text_style.fg(pc.ctx.theme.accent).bold()
			} else if row.directory {
				text_style.bold()
			} else {
				text_style
			};
			pc.frame.put(x, y, &row.label, style);
		}
		if let Some(plan) = plan {
			paint_overflow_footer(pc, rect, plan);
		}
	}
}

fn split_root(path: &str) -> (Option<&str>, &str) {
	if let Some(rest) = path.strip_prefix('/') {
		return (Some("/"), rest);
	}
	(None, path)
}

fn is_url_like(path: &str) -> bool {
	let Some((scheme, _)) = path.split_once("://") else {
		return false;
	};
	let mut bytes = scheme.bytes();
	matches!(bytes.next(), Some(first) if first.is_ascii_alphabetic())
		&& bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'.' | b'-'))
}

fn insert_path(nodes: &mut Vec<Node>, parts: &[&str], directory_leaf: bool) {
	let name = parts[0];
	let leaf = parts.len() == 1;
	if let Some(index) = nodes.iter().position(|node| node.name == name) {
		if leaf {
			nodes[index].directory |= directory_leaf;
		} else {
			nodes[index].directory = true;
			insert_path(&mut nodes[index].children, &parts[1..], directory_leaf);
		}
		return;
	}
	let mut node = Node::new(name, !leaf || directory_leaf);
	if !leaf {
		insert_path(&mut node.children, &parts[1..], directory_leaf);
	}
	nodes.push(node);
}

fn flatten(nodes: Vec<Node>, trail: &mut Vec<bool>, rows: &mut Vec<FileRow>) {
	let count = nodes.len();
	for (index, mut node) in nodes.into_iter().enumerate() {
		let last = index + 1 == count;
		while node.directory && node.children.len() == 1 {
			let child = node.children.remove(0);
			node.name.push('/');
			node.name.push_str(&child.name);
			node.children = child.children;
			node.directory = child.directory;
		}
		rows.push(FileRow {
			label: node.name,
			directory: node.directory,
			heading: false,
			gutters: trail.clone(),
			last,
		});
		if !node.children.is_empty() {
			trail.push(!last);
			flatten(node.children, trail, rows);
			trail.pop();
		}
	}
}
fn append(target: &mut Str, suffix: &str) {
	if suffix.is_empty() {
		return;
	}
	let mut joined = StrMut::with_capacity(target.len().saturating_add(suffix.len()));
	joined.push_str(target);
	joined.push_str(suffix);
	*target = joined.freeze();
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn normalizes_deduplicates_folds_and_preserves_order() {
		let mut files =
			Files::new().text("src\\lib\\mod.rs\nREADME\nsrc/lib/mod.rs\nsrc/bin/main.rs\nempty/\n");
		assert_eq!(files.labels(), ["src", "lib/mod.rs", "bin/main.rs", "README", "empty"]);
		assert!(files.rows.last().unwrap().directory);
	}

	#[test]
	fn keeps_absolute_and_url_roots_distinct() {
		let mut files = Files::new().text("/tmp/a\nhttps://host/x/y\n/root\nhttps://host/z\n");
		assert_eq!(files.labels(), ["/", "tmp/a", "root", "https://host/x/y", "https://host/z"]);
	}
	#[test]
	fn only_valid_scheme_urls_are_kept_whole() {
		let mut files = Files::new().text("git+ssh://host/a/b\nnot_a_url://x/y\n");
		assert_eq!(files.labels(), ["git+ssh://host/a/b", "not_a_url:/x/y"]);
	}

	#[test]
	fn reports_natural_rows_for_external_overflow_clamping() {
		let mut files = Files::new().text("a\nb\nc\n");
		files.rebuild();
		assert_eq!(files.rows.len(), 3);
		files.props.set(Prop::MaxRows, 2_u16);
		files.props.set(Prop::Overflow, "files");
		let plan = overflow_plan(&files.props, 3, u16::MAX).unwrap();
		assert_eq!((plan.content_rows, plan.omitted, plan.noun), (1, 2, "files"));
	}
}
