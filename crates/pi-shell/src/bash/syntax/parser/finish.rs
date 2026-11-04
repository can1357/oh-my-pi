//! Post-parse passes: here-document texts and node ids.

use alloc::vec::Vec;

use crate::bash::syntax::{ast::*, span::NodeId};

/// Walks a tree in id order, filling here-document texts and/or ids.
struct Walk<'d> {
	next: u32,
	ids:  bool,
	docs: &'d [Vec<u8>],
}

impl Walk<'_> {
	const fn id(&mut self) -> NodeId {
		let id = NodeId(self.next);
		self.next += 1;
		id
	}

	fn list(&mut self, list: &mut List) {
		for item in &mut list.items {
			self.and_or(&mut item.and_or);
		}
	}

	fn and_or(&mut self, ao: &mut AndOr) {
		if self.ids {
			ao.id = self.id();
		}
		self.pipeline(&mut ao.first);
		for (_, p) in &mut ao.rest {
			self.pipeline(p);
		}
	}

	fn pipeline(&mut self, p: &mut Pipeline) {
		if self.ids {
			p.id = self.id();
		}
		for st in &mut p.stages {
			self.command(&mut st.cmd);
		}
	}

	fn command(&mut self, cmd: &mut Command) {
		if self.ids {
			cmd.id = self.id();
		}
		match &mut cmd.kind {
			CommandKind::Simple(s) => {
				for a in &mut s.assigns {
					self.assign(a);
				}
				for w in &mut s.words {
					self.word(w);
				}
			},
			CommandKind::Brace(l) | CommandKind::Subshell(l) => self.list(l),
			CommandKind::If(i) => {
				for arm in &mut i.arms {
					self.list(&mut arm.cond);
					self.list(&mut arm.body);
				}
				if let Some(e) = &mut i.else_body {
					self.list(e);
				}
			},
			CommandKind::While(w) => {
				self.list(&mut w.cond);
				self.list(&mut w.body);
			},
			CommandKind::For(f) | CommandKind::Select(f) => {
				if let Some(words) = &mut f.words {
					for w in words {
						self.word(w);
					}
				}
				self.list(&mut f.body);
			},
			CommandKind::ArithFor(f) => self.list(&mut f.body),
			CommandKind::Case(c) => {
				self.word(&mut c.word);
				for arm in &mut c.arms {
					for p in &mut arm.patterns {
						self.word(p);
					}
					self.list(&mut arm.body);
				}
			},
			CommandKind::Arith(_) => {},
			CommandKind::Cond(e) => self.cond(e),
			CommandKind::FuncDef(f) => self.command(&mut f.body),
			CommandKind::Coproc(c) => self.command(&mut c.body),
			CommandKind::Repeat(r) => {
				self.word(&mut r.count);
				self.list(&mut r.body);
			},
			CommandKind::Try(t) => {
				self.list(&mut t.body);
				self.list(&mut t.always);
			},
			CommandKind::AnonFunc(a) => {
				self.command(&mut a.body);
				for w in &mut a.args {
					self.word(w);
				}
			},
		}
		for r in &mut cmd.redirs {
			match &mut r.target {
				RedirTarget::Word(w) => self.word(w),
				RedirTarget::HereDoc(doc) => {
					if let Some(seq) = placeholder_seq(&doc.text)
						&& let Some(text) = self.docs.get(seq as usize)
					{
						doc.text.clone_from(text);
					}
				},
			}
		}
	}

	fn cond(&mut self, e: &mut CondExpr) {
		match e {
			CondExpr::Unary { arg, .. } => self.word(arg),
			CondExpr::Binary { lhs, rhs, .. } => {
				self.word(lhs);
				self.word(rhs);
			},
			CondExpr::Word(w) => self.word(w),
			CondExpr::Not(x) | CondExpr::Group(x) => self.cond(x),
			CondExpr::And(a, b) | CondExpr::Or(a, b) => {
				self.cond(a);
				self.cond(b);
			},
		}
	}

	fn assign(&mut self, a: &mut Assign) {
		if self.ids {
			a.id = self.id();
		}
		if let Some(i) = &mut a.index {
			self.word(i);
		}
		match &mut a.value {
			AssignValue::Scalar(w) => self.word(w),
			AssignValue::Array(elems) => self.elems(elems),
		}
	}

	fn elems(&mut self, elems: &mut [ArrayElem]) {
		for e in elems {
			if let Some(k) = &mut e.key {
				self.word(k);
			}
			self.word(&mut e.value);
		}
	}

	fn word(&mut self, w: &mut Word) {
		if self.ids {
			w.id = self.id();
		}
		self.parts(&mut w.parts);
	}

	fn parts(&mut self, parts: &mut [WordPart]) {
		for p in parts {
			match p {
				WordPart::DQuote(inner) | WordPart::Locale(inner) => self.parts(inner),
				WordPart::Param(p) => {
					if let Some(Subscript::Expr(w)) = &mut p.index {
						self.word(w);
					}
					match &mut p.op {
						ParamOp::Default { word, .. }
						| ParamOp::Assign { word, .. }
						| ParamOp::Alt { word, .. } => self.word(word),
						ParamOp::Error { word: Some(word), .. } => self.word(word),
						ParamOp::Trim { pat, .. } => self.word(pat),
						ParamOp::Replace { pat, rep, .. } => {
							self.word(pat);
							if let Some(r) = rep {
								self.word(r);
							}
						},
						ParamOp::Case { pat: Some(pat), .. } => self.word(pat),
						_ => {},
					}
				},
				WordPart::Comsub(c) => self.list(&mut c.body),
				WordPart::ProcSub(p) => self.list(&mut p.body),
				WordPart::Compound(elems) => self.elems(elems),
				WordPart::Lit(_)
				| WordPart::Escaped(_)
				| WordPart::SQuote(_)
				| WordPart::AnsiC(_)
				| WordPart::Arith(_)
				| WordPart::BadSubst(_)
				| WordPart::BadComsub(_)
				| WordPart::DroppedQuote
				| WordPart::Zsh(_) => {},
			}
		}
	}
}

/// The sequence number in a pending here-document placeholder.
const fn placeholder_seq(text: &[u8]) -> Option<u32> {
	match text {
		[0xff, b'H', b'D', a, b, c, d] => Some(u32::from_le_bytes([*a, *b, *c, *d])),
		_ => None,
	}
}

/// Replace here-document placeholders with the gathered texts.
pub fn fill_docs(list: &mut List, docs: &[Vec<u8>]) {
	if docs.is_empty() {
		return;
	}
	Walk { next: 0, ids: false, docs }.list(list);
}

/// Assign preorder ids; returns the count.
pub fn assign_ids(list: &mut List) -> u32 {
	assign_ids_with_docs(list, &[])
}

/// Finalize a bash command's ids and gathered documents in one tree walk.
pub(super) fn assign_ids_with_docs(list: &mut List, docs: &[Vec<u8>]) -> u32 {
	let mut w = Walk { next: 0, ids: true, docs };
	w.list(list);
	w.next
}

/// Ids for a lone word ([`parse_text`](super::parse_text)).
pub(super) fn finish_word(word: &mut Word, docs: &[Vec<u8>]) {
	let mut w = Walk { next: 0, ids: true, docs };
	w.word(word);
}
