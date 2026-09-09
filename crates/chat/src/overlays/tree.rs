//! `/tree` branch explorer as an observer-local [`Panel`] (ADR 0005). The
//! journal arrives as a parent-linked entry list
//! ([`TreeEntry`]); structural entries (`turn.start`, `stream`, `patch`, …)
//! fold into the nearest message row so the tree shows turns rather than raw
//! entries, and Enter asks the console to `rewind` to the row (ADR 0014).
//!
//! The shared filterable select owns type-to-search. Left out on
//! purpose: `Shift+L` labels, `Ctrl+O` / `Alt+D/T/U/L/A` filter modes, and
//! `Shift+Enter` summarize (no console command backs them); `Alt+↑/↓` turn
//! jumps (the host decodes `Alt+Up` as `RestoreQueue` and drops `Alt+Down`).
//! Added: `Ctrl/Alt+←/→` fold and unfold from [`PanelAction`].

use std::collections::HashMap;

use omp_core::{Str, StrMut, sf};
use omp_journal::{EntryId, kind};
use omp_tui::{Border, Frame, Icon, Key, MouseReport, Size, Ui, UiContext, UiEvent, dom};

use super::{Panel, PanelAction, PanelAnchor, PanelCx, PanelEvent, services::TreeEntry};

/// Panel title.
const TITLE: &str = "Session Tree";
/// Panel chords, plus the fold chord.
const HINT: &str = "Enter: switch. PgUp/PgDn (←/→): page. Home/End: first/last item. Ctrl+←/→: \
                    fold/unfold. Type to search. Esc: close";
/// Empty-tree row.
const EMPTY: &str = "No entries found";
/// Top and bottom borders, the rule, and the hint row.
const CHROME_ROWS: u16 = 4;
/// The shared filterable select's search row.
const SELECT_HEADER_ROWS: u16 = 1;
/// Border plus `pad-x=1` on both sides.
const INSET: u16 = 4;
/// Content budget guarding deep gutters.
const MIN_CONTENT_COLS: u16 = 24;
const OVERHEAD_COLS: u16 = 4;
/// Preview cap.
const TEXT_LIMIT: usize = 200;
/// Marker on the row whose folded chain holds the head.
const HEAD_MARK: &str = " (head)";

/// One displayed tree node: a message, or a structural branch point.
struct Node {
	/// The shown entry.
	id:       EntryId,
	/// Entry Enter rewinds to: the head when it folded into this row,
	/// else the tail of the structural chain under [`Node::id`].
	target:   EntryId,
	kind:     Str,
	text:     Str,
	live:     bool,
	head:     bool,
	parent:   Option<usize>,
	children: Vec<usize>,
}

/// A `│` column left behind by an ancestor connector.
#[derive(Clone, Copy)]
struct Gutter {
	position: u16,
	show:     bool,
}

/// One pre-order row with its connector geometry.
struct Row {
	node:               usize,
	indent:             u16,
	show_connector:     bool,
	is_last:            bool,
	gutters:            Vec<Gutter>,
	virtual_root_child: bool,
}

/// Retained `/tree` selector.
pub struct TreePanel {
	nodes:          Vec<Node>,
	rows:           Vec<Row>,
	/// Row indices not hidden under a folded ancestor, ascending.
	visible:        Vec<usize>,
	folded:         Vec<bool>,
	/// Index into [`TreePanel::visible`].
	cursor:         usize,
	multiple_roots: bool,
	ui:             Ui,
	ctx:            UiContext,
	query:          Str,
	width:          u16,
	list_rows:      u16,
	dirty:          bool,
}

impl TreePanel {
	/// Opens the selector over the host journal tree. Fails when the feed
	/// is unavailable or holds no entries.
	pub fn open(cx: &PanelCx<'_>) -> Result<Self, Str> {
		let entries = cx
			.services
			.journal_tree()
			.map_err(|error| Str::new(error.to_string()))?;
		if entries.is_empty() {
			return Err(Str::new_static(EMPTY));
		}
		Self::from_entries(&entries, cx.viewport, cx.ui)
	}

	fn from_entries(entries: &[TreeEntry], viewport: Size, ctx: &UiContext) -> Result<Self, Str> {
		let nodes = build_nodes(entries);
		if nodes.is_empty() {
			return Err(Str::new_static(EMPTY));
		}
		let (rows, multiple_roots) = flatten(&nodes);
		let folded = vec![false; nodes.len()];
		let mut panel = Self {
			cursor: rows
				.iter()
				.position(|row| nodes[row.node].head)
				.unwrap_or(rows.len() - 1),
			visible: (0..rows.len()).collect(),
			folded,
			nodes,
			rows,
			multiple_roots,
			ui: Ui::from_root(dom! { <col/> }, viewport.width, ctx.clone()),
			ctx: ctx.clone(),
			query: Str::default(),
			width: viewport.width,
			list_rows: Self::rows_for(viewport.height),
			dirty: true,
		};
		panel.rebuild();
		Ok(panel)
	}

	/// Keeps at least five rows, half the
	/// viewport, never past the shared select header and panel chrome.
	fn rows_for(height: u16) -> u16 {
		(height / 2)
			.max(5)
			.min(height.saturating_sub(CHROME_ROWS + SELECT_HEADER_ROWS))
			.max(1)
	}

	/// Entry id the cursor row rewinds to.
	#[must_use]
	pub fn selected(&self) -> Option<EntryId> {
		self
			.visible
			.get(self.cursor)
			.map(|&row| self.nodes[self.rows[row].node].target)
	}

	fn move_cursor(&mut self, cursor: usize) -> PanelEvent {
		let clamped = cursor.min(self.visible.len().saturating_sub(1));
		if clamped != self.cursor {
			self.cursor = clamped;
			self.dirty = true;
		}
		PanelEvent::Consumed
	}

	fn refresh_visible(&mut self) {
		let row = self.visible[self.cursor];
		self.visible.clear();
		for (index, row) in self.rows.iter().enumerate() {
			let mut parent = self.nodes[row.node].parent;
			let hidden = loop {
				match parent {
					Some(node) if self.folded[node] => break true,
					Some(node) => parent = self.nodes[node].parent,
					None => break false,
				}
			};
			if !hidden {
				self.visible.push(index);
			}
		}
		self.cursor = self.visible.binary_search(&row).unwrap_or_else(|next| next);
		self.dirty = true;
	}

	fn fold_up(&mut self) -> PanelEvent {
		let Some(&row) = self.visible.get(self.cursor) else {
			return PanelEvent::Consumed;
		};
		let node = self.rows[row].node;
		if !self.nodes[node].children.is_empty() && !self.folded[node] {
			self.folded[node] = true;
			self.refresh_visible();
			return PanelEvent::Consumed;
		}
		let Some(parent) = self.nodes[node].parent else {
			return PanelEvent::Consumed;
		};
		let Some(parent_row) = self.rows.iter().position(|row| row.node == parent) else {
			return PanelEvent::Consumed;
		};
		match self.visible.binary_search(&parent_row) {
			Ok(cursor) => self.move_cursor(cursor),
			Err(_) => PanelEvent::Consumed,
		}
	}

	fn unfold_down(&mut self) -> PanelEvent {
		let Some(&row) = self.visible.get(self.cursor) else {
			return PanelEvent::Consumed;
		};
		let node = self.rows[row].node;
		if self.folded[node] {
			self.folded[node] = false;
			self.refresh_visible();
			return PanelEvent::Consumed;
		}
		if self.nodes[node].children.is_empty() {
			return PanelEvent::Consumed;
		}
		// Pre-order: the first displayed child is the next row.
		self.move_cursor(self.cursor + 1)
	}

	fn rebuild(&mut self) {
		self.dirty = false;
		let width = self.width.saturating_sub(INSET);
		let list_rows = self.list_rows.saturating_add(SELECT_HEADER_ROWS);
		let content_reserve = MIN_CONTENT_COLS.max(width / 2);
		let max_indent_levels = (width
			.saturating_sub(content_reserve)
			.saturating_sub(OVERHEAD_COLS)
			/ 3)
			.max(1);

		let options = self
			.visible
			.iter()
			.enumerate()
			.map(|(index, &row_idx)| {
				let row = &self.rows[row_idx];
				let node = &self.nodes[row.node];
				let charset = self.ctx.charset;
				let prefix = self.gutter_prefix(row, max_indent_levels);
				let marker = if node.live {
					sf!("{} ", Icon::MarkdownBullet.glyph(charset))
				} else {
					Str::default()
				};
				let fold = if self.folded[row.node] {
					charset.expander(false)
				} else {
					""
				};
				let (label_fg, label, content) = entry_display(node);
				let content_fg = if node.live && !node.text.is_empty() {
					"fg"
				} else {
					"muted"
				};
				let head = if node.head { HEAD_MARK } else { "" };
				let label_fg = if node.live { label_fg } else { "muted" };
				let search_label = sf!("{label} {content}");
				let value = sf!("{row_idx}");
				let selected = index == self.cursor;
				let icon = sf!("{marker}{fold}");

				(
					value,
					search_label,
					selected,
					prefix,
					icon,
					label_fg,
					label,
					content_fg,
					content,
					head,
				)
			})
			.collect::<Vec<_>>();

		let tree = dom! {
			<box border=round title={TITLE} pad-x=1>
				<col>
					<select id="tree" filter={self.query.clone()} h={list_rows}>
						for (value, search_label, selected, prefix, icon, label_fg, label, content_fg, content, head) in options {
							<option value={value} label={search_label} selected={selected}>
								<td truncate grow>
									<pre fg=muted>{prefix}</pre>
									<pre fg=accent>{icon}</pre>
									<pre fg={label_fg}>{label}</pre>
									<pre fg={content_fg}>{content}</pre>
									<pre fg=accent>{head}</pre>
								</td>
							</option>
						}
					</select>
					<hr border=round/>
					<text fg=muted truncate>{HINT}</text>
				</col>
			</box>
		};
		self.ui = Ui::from_root(tree, self.width, self.ctx.clone());
	}

	fn cursor_to(&mut self, value: &str) {
		if let Ok(row_idx) = value.parse::<usize>() {
			if let Ok(pos) = self.visible.binary_search(&row_idx) {
				self.cursor = pos;
			} else if let Some(pos) = self.visible.iter().position(|&r| r == row_idx) {
				self.cursor = pos;
			}
		}
	}

	fn route(&mut self, event: UiEvent) -> PanelEvent {
		match event {
			UiEvent::Cancel => PanelEvent::Close,
			UiEvent::Changed { id, value } if id.as_str() == "tree" => {
				self.cursor_to(&value);
				self
					.selected()
					.map_or(PanelEvent::Close, |id| PanelEvent::Finish(sf!("rewind {id}")))
			},
			UiEvent::Highlighted { id, value } if id.as_str() == "tree" => {
				self.cursor_to(&value);
				PanelEvent::Consumed
			},
			UiEvent::Filtered { id, query, value } if id.as_str() == "tree" => {
				self.query = query;
				if let Some(value) = value.as_deref() {
					self.cursor_to(value);
				}
				self.dirty = true;
				PanelEvent::Consumed
			},
			_ => PanelEvent::Consumed,
		}
	}

	/// Three cells per indent level with
	/// ancestor gutters and this row's connector at their positions; older
	/// levels compress behind a leading `…` past `max_indent_levels`.
	fn gutter_prefix(&self, row: &Row, max_indent_levels: u16) -> Str {
		let (branch, last, vertical) = self.ctx.charset.guides(Border::Square);
		let display_indent = if self.multiple_roots {
			row.indent.saturating_sub(1)
		} else {
			row.indent
		};
		let has_connector = row.show_connector && !row.virtual_root_child;
		let connector: Vec<char> = if has_connector {
			if row.is_last { last } else { branch }.chars().collect()
		} else {
			Vec::new()
		};
		let horizontal = branch.chars().nth(1).unwrap_or(' ');
		let vertical = vertical.chars().next().unwrap_or(' ');
		let rendered_indent = display_indent.min(max_indent_levels);
		let scroll_offset = display_indent - rendered_indent;
		let connector_level = if has_connector {
			rendered_indent.checked_sub(1)
		} else {
			None
		};
		let total = usize::from(rendered_indent) * 3;
		let mut prefix = StrMut::with_capacity(total * 3);
		for cell in 0..total {
			let level = (cell / 3) as u16;
			let original = level + scroll_offset;
			let slot = cell % 3;
			// Leftmost cell marks ancestors compressed off-screen.
			let glyph = if cell == 0 && scroll_offset > 0 {
				'…'
			} else if let Some(gutter) = row
				.gutters
				.iter()
				.find(|gutter| gutter.position == original)
			{
				if slot == 0 && gutter.show {
					vertical
				} else {
					' '
				}
			} else if connector_level == Some(level) {
				match slot {
					0 => connector.first().copied().unwrap_or(' '),
					1 => connector.get(1).copied().unwrap_or(horizontal),
					_ => connector.get(2).copied().unwrap_or(' '),
				}
			} else {
				' '
			};
			prefix.push(glyph);
		}
		prefix.freeze()
	}
}

impl Panel for TreePanel {
	fn id(&self) -> &'static str {
		"tree"
	}

	fn anchor(&self) -> PanelAnchor {
		PanelAnchor::Center
	}

	fn action(&mut self, action: PanelAction) -> PanelEvent {
		match action {
			PanelAction::FoldUp => self.fold_up(),
			PanelAction::UnfoldDown => self.unfold_down(),
			_ => PanelEvent::Ignored,
		}
	}

	fn key(&mut self, key: Key) -> PanelEvent {
		let key = match key {
			Key::Left => Key::Up,
			Key::Right => Key::Down,
			other => other,
		};
		if self.query.is_empty()
			&& ((key == Key::Up && self.cursor == 0)
				|| (key == Key::Down && self.cursor + 1 == self.visible.len()))
		{
			return PanelEvent::Consumed;
		}
		let event = self.ui.handle_key(key);
		self.route(event)
	}

	fn paste(&mut self, text: &str) -> PanelEvent {
		let event = self.ui.handle_paste(text);
		self.route(event)
	}

	fn mouse(&mut self, report: MouseReport) -> PanelEvent {
		let event = self
			.ui
			.handle_mouse_with_mods(report.col, report.row, report.kind, report.mods);
		self.route(event)
	}

	fn frame(&mut self, viewport: Size) -> &Frame {
		let list_rows = Self::rows_for(viewport.height);
		if viewport.width != self.width || list_rows != self.list_rows {
			self.width = viewport.width;
			self.list_rows = list_rows;
			self.dirty = true;
		}
		if self.dirty {
			self.rebuild();
		}
		self.ui.frame()
	}
}

/// Contracts the entry DAG to displayed nodes: user turns, assistant
/// messages, and root-level structural branch points. Every other entry
/// folds into the nearest shown ancestor; a fork at a folded entry
/// (rewinding before a turn forks at
/// the previous receipt) hangs its branches off the owning row, whose
/// rewind target is then that fork entry.
fn build_nodes(entries: &[TreeEntry]) -> Vec<Node> {
	let index: HashMap<EntryId, usize> = entries
		.iter()
		.enumerate()
		.map(|(index, entry)| (entry.id, index))
		.collect();
	let mut children = vec![Vec::new(); entries.len()];
	let mut roots = Vec::new();
	for (child, entry) in entries.iter().enumerate() {
		match entry.parent.and_then(|parent| index.get(&parent)) {
			Some(&parent) if parent != child => children[parent].push(child),
			_ => roots.push(child),
		}
	}
	let message = |index: usize| {
		let entry = &entries[index];
		entry.kind == kind::MSG_USER || entry.kind == kind::MSG_ASSISTANT_START
	};
	let mut nodes: Vec<Node> = Vec::new();
	let mut stack: Vec<(usize, Option<usize>)> =
		roots.iter().rev().map(|&root| (root, None)).collect();
	while let Some((index, owner)) = stack.pop() {
		let entry = &entries[index];
		let shown = message(index) || (owner.is_none() && children[index].len() > 1);
		let owner = if shown {
			let node = nodes.len();
			nodes.push(Node {
				id:       entry.id,
				target:   entry.id,
				kind:     entry.kind.clone(),
				text:     entry.text.clone(),
				live:     entry.live,
				head:     entry.head,
				parent:   owner,
				children: Vec::new(),
			});
			if let Some(owner) = owner {
				nodes[owner].children.push(node);
			}
			Some(node)
		} else {
			if let Some(owner) = owner
				&& entry.head
			{
				nodes[owner].head = true;
				nodes[owner].target = entry.id;
			}
			owner
		};
		for &child in children[index].iter().rev() {
			stack.push((child, owner));
		}
	}
	for node in &mut nodes {
		if node.head {
			continue;
		}
		let mut current = index[&node.id];
		while let [next] = children[current][..] {
			if message(next) || entries[next].kind == kind::TURN_START {
				break;
			}
			current = next;
		}
		node.target = entries[current].id;
	}
	nodes
}

/// Flattens to pre-order rows, with the
/// live branch first at every fork, connector geometry per row.
fn flatten(nodes: &[Node]) -> (Vec<Row>, bool) {
	struct Item {
		node:               usize,
		indent:             u16,
		show_connector:     bool,
		is_last:            bool,
		gutters:            Vec<Gutter>,
		virtual_root_child: bool,
	}
	let mut roots: Vec<usize> = (0..nodes.len())
		.filter(|&node| nodes[node].parent.is_none())
		.collect();
	roots.sort_by_key(|&root| !nodes[root].live);
	let multiple_roots = roots.len() > 1;
	let mut stack: Vec<Item> = roots
		.iter()
		.enumerate()
		.rev()
		.map(|(position, &root)| Item {
			node:               root,
			indent:             u16::from(multiple_roots),
			show_connector:     multiple_roots,
			is_last:            position + 1 == roots.len(),
			gutters:            Vec::new(),
			virtual_root_child: multiple_roots,
		})
		.collect();
	let mut rows = Vec::with_capacity(nodes.len());
	while let Some(item) = stack.pop() {
		let node = &nodes[item.node];
		let multiple_children = node.children.len() > 1;
		let mut ordered = node.children.clone();
		ordered.sort_by_key(|&child| !nodes[child].live);
		let child_indent = if multiple_children || item.virtual_root_child {
			item.indent + 1
		} else {
			item.indent
		};
		let connector_displayed = item.show_connector && !item.virtual_root_child;
		let display_indent = if multiple_roots {
			item.indent.saturating_sub(1)
		} else {
			item.indent
		};
		let mut child_gutters = item.gutters.clone();
		if connector_displayed {
			child_gutters
				.push(Gutter { position: display_indent.saturating_sub(1), show: !item.is_last });
		}
		for (position, &child) in ordered.iter().enumerate().rev() {
			stack.push(Item {
				node:               child,
				indent:             child_indent,
				show_connector:     multiple_children,
				is_last:            position + 1 == ordered.len(),
				gutters:            child_gutters.clone(),
				virtual_root_child: false,
			});
		}
		rows.push(Row {
			node:               item.node,
			indent:             item.indent,
			show_connector:     item.show_connector,
			is_last:            item.is_last,
			gutters:            item.gutters,
			virtual_root_child: item.virtual_root_child,
		});
	}
	(rows, multiple_roots)
}

/// Returns `(label color, label, content)`.
fn entry_display(node: &Node) -> (&'static str, Str, Str) {
	let text = normalize(&node.text);
	if node.kind == kind::MSG_USER {
		("accent", Str::new_static("user: "), text)
	} else if node.kind == kind::MSG_ASSISTANT_START {
		let content = if text.is_empty() {
			Str::new_static("(no content)")
		} else {
			text
		};
		("success", Str::new_static("assistant: "), content)
	} else {
		("muted", sf!("[{}]", node.kind), text)
	}
}

/// Normalizes newlines and tabs to spaces, trims, and caps the result.
fn normalize(text: &str) -> Str {
	let mut out = StrMut::with_capacity(text.len().min(TEXT_LIMIT));
	for ch in text.chars().take(TEXT_LIMIT) {
		out.push(if matches!(ch, '\n' | '\t') { ' ' } else { ch });
	}
	Str::new(out.as_str().trim())
}

#[cfg(test)]
mod tests {
	use std::sync::Arc;

	use omp_con::Ctx;
	use omp_dom::Dom;
	use omp_tui::{cell_width, frame_text};

	use super::*;
	use crate::overlays::services::{NoServices, ServiceResult, Services};

	fn id(n: u32) -> EntryId {
		sf!("01ARZ3NDEKTSV4RRFFQ69G5{n:03}").parse().expect("ulid")
	}

	fn entry(n: u32, parent: Option<u32>, kind: &str, text: &str, live: bool) -> TreeEntry {
		TreeEntry {
			id: id(n),
			parent: parent.map(id),
			kind: Str::new(kind),
			text: Str::new(text),
			live,
			head: false,
		}
	}

	/// turn 1 (user/assistant), then a fork under the first assistant:
	/// the live branch (turn 2) and a dead branch (turn 3). Head is the
	/// receipt closing turn 2.
	fn forked() -> Vec<TreeEntry> {
		let mut entries = vec![
			entry(1, None, kind::JOURNAL, "", true),
			entry(2, Some(1), kind::TURN_START, "", true),
			entry(3, Some(2), kind::MSG_USER, "hello\nworld", true),
			entry(4, Some(3), kind::MSG_ASSISTANT_START, "hi there", true),
			entry(5, Some(4), kind::STREAM, "", true),
			entry(6, Some(5), kind::MSG_ASSISTANT_END, "", true),
			entry(7, Some(6), kind::TURN_RECEIPT, "", true),
			// live branch
			entry(8, Some(7), kind::TURN_START, "", true),
			entry(9, Some(8), kind::MSG_USER, "second question", true),
			entry(10, Some(9), kind::MSG_ASSISTANT_START, "second answer", true),
			entry(11, Some(10), kind::MSG_ASSISTANT_END, "", true),
			entry(12, Some(11), kind::TURN_RECEIPT, "", true),
			// dead branch off the same receipt
			entry(13, Some(7), kind::TURN_START, "", false),
			entry(14, Some(13), kind::MSG_USER, "abandoned question", false),
			entry(15, Some(14), kind::MSG_ASSISTANT_START, "abandoned answer", false),
		];
		entries[11].head = true;
		entries
	}

	fn panel(entries: &[TreeEntry]) -> TreePanel {
		TreePanel::from_entries(entries, Size::new(60, 20), &UiContext::default()).expect("tree")
	}

	fn lines(panel: &mut TreePanel, size: Size) -> Vec<String> {
		frame_text(panel.frame(size))
			.lines()
			.map(str::to_owned)
			.collect()
	}

	struct FakeTree(Vec<TreeEntry>);

	impl Services for FakeTree {
		fn journal_tree(&self) -> ServiceResult<Vec<TreeEntry>> {
			Ok(self.0.clone())
		}
	}

	#[test]
	fn open_reads_the_journal_tree_and_rejects_empty_or_unavailable_feeds() {
		let dom = Dom::new();
		let con = Ctx::new();
		let ui = UiContext::default();
		let viewport = Size::new(60, 20);
		let none: Arc<dyn Services> = Arc::new(NoServices);
		let cx = PanelCx { dom: &dom, con: &con, ui: &ui, viewport, services: &none };
		let unavailable = TreePanel::open(&cx).err().expect("no feed");
		assert!(unavailable.contains("journal tree"), "{unavailable}");
		let empty: Arc<dyn Services> = Arc::new(FakeTree(Vec::new()));
		let cx = PanelCx { dom: &dom, con: &con, ui: &ui, viewport, services: &empty };
		assert_eq!(TreePanel::open(&cx).err().expect("empty").as_str(), EMPTY);
		let feed: Arc<dyn Services> = Arc::new(FakeTree(forked()));
		let cx = PanelCx { dom: &dom, con: &con, ui: &ui, viewport, services: &feed };
		let panel = TreePanel::open(&cx).expect("tree");
		assert_eq!(panel.id(), "tree");
		assert_eq!(panel.anchor(), PanelAnchor::Center);
		assert_eq!(panel.selected(), Some(id(12)), "cursor opens on the head row");
	}

	#[test]
	fn structural_entries_fold_into_turn_rows_with_chain_tail_targets() {
		let panel = panel(&forked());
		let kinds: Vec<&str> = panel
			.rows
			.iter()
			.map(|row| panel.nodes[row.node].kind.as_str())
			.collect();
		assert_eq!(kinds, vec![
			kind::MSG_USER,
			kind::MSG_ASSISTANT_START,
			kind::MSG_USER,
			kind::MSG_ASSISTANT_START,
			kind::MSG_USER,
			kind::MSG_ASSISTANT_START,
		]);
		let targets: Vec<EntryId> = panel
			.rows
			.iter()
			.map(|row| panel.nodes[row.node].target)
			.collect();
		// user rows target themselves; the first assistant row folds
		// stream/end/receipt and stops before the next turn.start; the
		// live second assistant row carries the head.
		assert_eq!(targets, vec![id(3), id(7), id(9), id(12), id(14), id(15)]);
		assert!(panel.nodes[panel.rows[3].node].head);
		assert!(!panel.nodes[panel.rows[5].node].live);
	}

	#[test]
	fn renders_both_branches_with_gutters_bullets_and_the_head_marker() {
		let mut panel = panel(&forked());
		let text = lines(&mut panel, Size::new(60, 20));
		assert!(text[0].contains("Session Tree"), "title missing:\n{}", text.join("\n"));
		let body = text.join("\n");
		assert!(body.contains("6/6"), "standard select search row missing:\n{body}");
		assert!(body.contains("• user: hello world"), "{body}");
		assert!(body.contains("• assistant: hi there"), "{body}");
		assert!(body.contains("├─ • user: second question"), "{body}");
		assert!(body.contains("│  • assistant: second answer (head)"), "{body}");
		assert!(body.contains("└─ user: abandoned question"), "{body}");
		assert!(body.contains("   assistant: abandoned answer"), "{body}");
		assert!(body.contains("❯ "), "cursor missing:\n{body}");
		assert!(body.contains("Enter: switch."), "hint missing:\n{body}");
		// Head row is selected on open: cursor glyph lands on it.
		let head_row = text
			.iter()
			.find(|line| line.contains("(head)"))
			.expect("head row");
		assert!(head_row.contains("❯ "), "{head_row}");
	}

	#[test]
	fn navigation_clamps_and_enter_rewinds_to_the_cursor_row() {
		let mut panel = panel(&forked());
		assert_eq!(panel.cursor, 3);
		assert_eq!(panel.key(Key::Home), PanelEvent::Consumed);
		assert_eq!(panel.selected(), Some(id(3)));
		assert_eq!(panel.key(Key::Up), PanelEvent::Consumed);
		assert_eq!(panel.cursor, 0, "clamped at the top");
		assert_eq!(panel.key(Key::Down), PanelEvent::Consumed);
		assert_eq!(panel.key(Key::Enter), PanelEvent::Finish(sf!("rewind {}", id(7))));
		assert_eq!(panel.key(Key::End), PanelEvent::Consumed);
		assert_eq!(panel.cursor, 5);
		assert_eq!(panel.key(Key::Down), PanelEvent::Consumed);
		assert_eq!(panel.cursor, 5, "clamped at the bottom");
		assert_eq!(panel.key(Key::PageDown), PanelEvent::Consumed);
		assert_eq!(panel.cursor, 5);
		assert_eq!(panel.key(Key::PageUp), PanelEvent::Consumed);
		assert_eq!(panel.cursor, 0);
		assert_eq!(panel.key(Key::Enter), PanelEvent::Finish(sf!("rewind {}", id(3))));
		assert_eq!(panel.key(Key::Char('x')), PanelEvent::Consumed);
		assert_eq!(panel.query.as_str(), "x", "typing belongs to the shared filterable select");
		assert_eq!(panel.key(Key::Esc), PanelEvent::Consumed, "first Esc clears the filter");
		assert!(panel.query.is_empty());
		assert_eq!(panel.key(Key::Esc), PanelEvent::Close, "second Esc closes the overlay");
	}

	#[test]
	fn fold_hides_the_subtree_and_unfold_restores_it() {
		let mut panel = panel(&forked());
		// Row 1 (first assistant) owns the fork.
		panel.key(Key::Home);
		panel.key(Key::Down);
		assert_eq!(panel.action(PanelAction::FoldUp), PanelEvent::Consumed);
		assert_eq!(panel.visible, vec![0, 1]);
		assert_eq!(panel.cursor, 1);
		let text = lines(&mut panel, Size::new(60, 20)).join("\n");
		assert!(text.contains("hi there"), "{text}");
		assert!(!text.contains("second question"), "folded rows leaked:\n{text}");
		assert!(text.contains("▸ "), "fold marker missing:\n{text}");
		assert_eq!(panel.key(Key::Down), PanelEvent::Consumed);
		assert_eq!(panel.cursor, 1, "cursor cannot enter the folded subtree");
		// FoldUp on a folded row jumps to its parent.
		assert_eq!(panel.action(PanelAction::FoldUp), PanelEvent::Consumed);
		assert_eq!(panel.cursor, 0);
		// UnfoldDown on an open row moves to its first child.
		assert_eq!(panel.action(PanelAction::UnfoldDown), PanelEvent::Consumed);
		assert_eq!(panel.cursor, 1);
		assert_eq!(panel.action(PanelAction::UnfoldDown), PanelEvent::Consumed);
		assert_eq!(panel.visible, vec![0, 1, 2, 3, 4, 5]);
		assert_eq!(panel.cursor, 1);
		let text = lines(&mut panel, Size::new(60, 20)).join("\n");
		assert!(text.contains("second question"), "{text}");
		assert!(text.contains("abandoned question"), "{text}");
		assert_eq!(panel.action(PanelAction::Rename), PanelEvent::Ignored);
	}

	#[test]
	fn window_follows_the_cursor_on_short_viewports() {
		let mut entries = vec![entry(1, None, kind::TURN_START, "", true)];
		for n in 2..=20 {
			entries.push(entry(n, Some(n - 1), kind::MSG_USER, &format!("message {n}"), true));
		}
		entries.last_mut().expect("entries").head = true;
		let mut panel = panel(&entries);
		let text = lines(&mut panel, Size::new(60, 12)).join("\n");
		assert!(text.contains("message 20 (head)"), "head row missing:\n{text}");
		assert!(!text.contains("message 2 "), "window did not scroll:\n{text}");
		assert!(text.contains("19/19"), "shared select count missing:\n{text}");
		panel.key(Key::Home);
		let text = lines(&mut panel, Size::new(60, 12)).join("\n");
		assert!(text.contains("message 2 "), "{text}");
		assert!(!text.contains("message 20"), "{text}");
	}

	#[test]
	fn long_previews_clip_to_the_row_width() {
		let entries = vec![entry(1, None, kind::MSG_USER, &"x".repeat(120), true)];
		let mut panel = panel(&entries);
		let text = lines(&mut panel, Size::new(40, 10));
		let row = text
			.iter()
			.find(|line| line.contains("user:"))
			.expect("user row");
		assert!(row.ends_with("…│") || row.contains("…"), "{row}");
		assert!(cell_width(row) <= 40, "{row}");
	}
}
