//! Lists, and-or lists and pipelines.
//!
//! | kind       | children       | fields                                       |
//! |------------|----------------|----------------------------------------------|
//! | `List`     | items          |                                              |
//! | `Item`     | `[and_or]`     | `x`: separator ([`Sep`] code)                |
//! | `AndOr`    | pipelines      | span                                         |
//! | `Pipeline` | stage commands | span; `x`: 0, or 1 + code of the connector   |
//! |            |                | before it; flags `BANG`, `TIME`, `TIME_POSIX` |

use super::{
	Code, Id, K, Mark, Node, Seq, Tree, flag,
	shape::{
		AndOr as AndOrS, Command as CommandS, Item as ItemS, List as ListS, Pipeline as PipelineS,
	},
	view,
};
use crate::bash::syntax::{
	ast::{AndOrOp, Sep, Time},
	span::{NodeId, Span},
};

const ITEM_AND_OR: usize = 0;

const BANG: u8 = 1;
const TIME: u8 = 2;
const TIME_POSIX: u8 = 4;

view!(
	/// A sequence of and-or lists with their terminators.
	List: List,
	/// One and-or list and the separator that followed it.
	ListItem: Item,
	/// `p1 && p2 || p3`.
	AndOr: AndOr,
	/// `[time [-p]] [!] cmd1 | cmd2 |& cmd3`.
	Pipeline: Pipeline,
);

// ─── building ──────────────────────────────────────────────────────────

impl Tree {
	pub fn list(&mut self, items: &[Id<ItemS>]) -> Id<ListS> {
		let run = self.run(items);
		Id::new(self.push_over(Node::new(K::List), run))
	}

	/// A list of the items collected since `mark`.
	pub fn list_at(&mut self, mark: Mark<ItemS>) -> Id<ListS> {
		Id::new(self.close(Node::new(K::List), mark))
	}

	/// Collect the items of list `l` at `mark` (a list continued from
	/// another).
	pub fn kid_items(&mut self, mark: Mark<ItemS>, l: Id<ListS>) {
		debug_assert!(mark.0 <= self.scratch.len(), "a mark above the scratch stack");
		let n = self.nodes[l.index() as usize];
		self
			.scratch
			.extend_from_slice(&self.kids[n.a as usize..(n.a + n.b) as usize]);
	}

	pub fn item(&mut self, and_or: Id<AndOrS>, sep: Sep) -> Id<ItemS> {
		let n = Node { x: sep.code(), ..Node::new(K::Item) };
		Id::new(self.push_with(n, &[and_or.index()]))
	}

	/// An and-or list of pipelines (connectors set on all but the first).
	pub fn and_or(&mut self, span: Span, pipelines: &[Id<PipelineS>]) -> Id<AndOrS> {
		let run = self.run(pipelines);
		Id::new(self.push_over(Node::spanning(K::AndOr, span), run))
	}

	/// An and-or list of the pipelines collected since `mark`.
	pub fn and_or_at(&mut self, span: Span, mark: Mark<PipelineS>) -> Id<AndOrS> {
		Id::new(self.close(Node::spanning(K::AndOr, span), mark))
	}

	pub fn pipeline(
		&mut self,
		span: Span,
		bang: bool,
		time: Option<Time>,
		stages: &[Id<CommandS>],
	) -> Id<PipelineS> {
		let run = self.run(stages);
		Id::new(self.push_over(pipeline_node(span, bang, time), run))
	}

	/// A pipeline of the stages collected since `mark`.
	pub fn pipeline_at(
		&mut self,
		span: Span,
		bang: bool,
		time: Option<Time>,
		mark: Mark<CommandS>,
	) -> Id<PipelineS> {
		Id::new(self.close(pipeline_node(span, bang, time), mark))
	}

	/// Mark pipeline `p` as following `op` in its and-or list.
	pub fn set_connector(&mut self, p: Id<PipelineS>, op: AndOrOp) {
		self.nodes[p.index() as usize].x = 1 + op.code();
	}

	/// Mark pipeline `p` negated (`!`).
	pub fn set_bang(&mut self, p: Id<PipelineS>) {
		self.nodes[p.index() as usize].flags |= BANG;
	}

	/// Mark pipeline `p` timed (zsh `time`, no `-p`), starting at `lo`.
	pub fn set_timed(&mut self, p: Id<PipelineS>, lo: u32) {
		let n = &mut self.nodes[p.index() as usize];
		n.flags = (n.flags | TIME) & !TIME_POSIX;
		n.lo = lo;
	}

	/// The one-item list around pipeline `p`.
	pub fn pipeline_list(&mut self, p: Id<PipelineS>) -> Id<ListS> {
		let span = self.span_of(p.index());
		let ao = self.and_or(span, &[p]);
		let item = self.item(ao, Sep::None);
		self.list(&[item])
	}

	/// The lone pipeline of list `l` (one item, no separator, one
	/// pipeline).
	pub fn lone_pipeline(&self, l: Id<ListS>) -> Option<Id<PipelineS>> {
		let item = List::of(self, l).items().one()?;
		if item.sep() != Sep::None {
			return None;
		}
		item.and_or().pipelines().one().map(Pipeline::handle)
	}

	/// The lone stage of pipeline `p`, when it has no `!`, `time` or `|&`.
	pub fn lone_stage(&self, p: Id<PipelineS>) -> Option<Id<CommandS>> {
		let p = Pipeline::of(self, p);
		if p.bang() || p.time().is_some() {
			return None;
		}
		let c = p.stages().one()?;
		(!c.pipe_stderr()).then(|| c.handle())
	}

	pub(super) fn span_of(&self, i: u32) -> Span {
		let n = self.node(i);
		Span::new(n.lo, n.hi)
	}
}

fn pipeline_node(span: Span, bang: bool, time: Option<Time>) -> Node {
	let flags = flag(bang, BANG)
		| flag(time.is_some(), TIME)
		| flag(time.is_some_and(|t| t.posix), TIME_POSIX);
	Node { flags, ..Node::spanning(K::Pipeline, span) }
}

// ─── reading ───────────────────────────────────────────────────────────

impl<'t> List<'t> {
	pub fn items(self) -> Seq<'t, ListItem<'t>> {
		self.0.seq(0)
	}
}

impl<'t> ListItem<'t> {
	pub fn and_or(self) -> AndOr<'t> {
		AndOr(self.0.must(ITEM_AND_OR, "and-or list"))
	}

	pub fn sep(self) -> Sep {
		Sep::of(self.0.n().x)
	}
}

impl<'t> AndOr<'t> {
	pub fn id(self) -> NodeId {
		self.0.id()
	}

	pub fn span(self) -> Span {
		self.0.span()
	}

	pub fn first(self) -> Pipeline<'t> {
		Pipeline(self.0.must(0, "pipeline"))
	}

	/// The pipelines after the first, with their connectors.
	pub fn rest(
		self,
	) -> impl ExactSizeIterator<Item = (AndOrOp, Pipeline<'t>)> + DoubleEndedIterator + 't {
		self.0.seq::<Pipeline<'t>>(1).iter().map(|p| {
			(
				p.connector()
					.expect("a pipeline after the first has a connector"),
				p,
			)
		})
	}

	/// Every pipeline, the first included.
	pub fn pipelines(self) -> Seq<'t, Pipeline<'t>> {
		self.0.seq(0)
	}
}

impl<'t> Pipeline<'t> {
	pub fn id(self) -> NodeId {
		self.0.id()
	}

	pub fn span(self) -> Span {
		self.0.span()
	}

	pub fn bang(self) -> bool {
		self.0.flag(BANG)
	}

	pub fn time(self) -> Option<Time> {
		self
			.0
			.flag(TIME)
			.then(|| Time { posix: self.0.flag(TIME_POSIX) })
	}

	/// The connector before this pipeline in its and-or list.
	pub fn connector(self) -> Option<AndOrOp> {
		self.0.n().x.checked_sub(1).map(AndOrOp::of)
	}

	/// The stages' commands.
	pub fn stages(self) -> Seq<'t, super::Command<'t>> {
		self.0.seq(0)
	}
}
