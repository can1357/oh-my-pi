//! Post-parse passes: here-document texts and node ids.

use alloc::vec::Vec;

use crate::bash::syntax::{ast::*, span::NodeId};

/// A gathered document's bash text and the input that produced it.
#[derive(Default)]
pub(super) struct GatheredDoc {
	pub text:   Vec<u8>,
	pub source: Option<HereDocSource>,
}

/// Walks a tree in id order, filling here-document texts and/or ids.
struct Walk<'d> {
	next:      u32,
	ids:       bool,
	docs:      &'d [GatheredDoc],
	doc_texts: &'d [Vec<u8>],
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
					if let Some(seq) = placeholder_seq(&doc.text) {
						if let Some(gathered) = self.docs.get(seq as usize) {
							doc.text.clone_from(&gathered.text);
							doc.source.clone_from(&gathered.source);
						} else if let Some(text) = self.doc_texts.get(seq as usize) {
							doc.text.clone_from(text);
						}
					}
					if let Some(delimiter) = &mut doc.delimiter {
						self.word(delimiter);
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
			CondExpr::Not { expr, .. } | CondExpr::Group { expr, .. } => self.cond(expr),
			CondExpr::And(terms, _) | CondExpr::Or(terms, _) => {
				for term in terms {
					self.cond(term);
				}
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
				| WordPart::DroppedQuote(_)
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

/// Replace bash here-document placeholders with their text and recorded input.
pub(super) fn fill_docs(list: &mut List, docs: &[GatheredDoc]) {
	if docs.is_empty() {
		return;
	}
	Walk { next: 0, ids: false, docs, doc_texts: &[] }.list(list);
}

/// Fill documents from zsh's text-only gatherer without inventing positions.
pub(crate) fn fill_doc_texts(list: &mut List, docs: &[Vec<u8>]) {
	if docs.is_empty() {
		return;
	}
	Walk { next: 0, ids: false, docs: &[], doc_texts: docs }.list(list);
}

/// Assign preorder ids; returns the count.
pub fn assign_ids(list: &mut List) -> u32 {
	assign_ids_with_docs(list, &[])
}

/// Finalize a bash command's ids and gathered documents in one tree walk.
pub(super) fn assign_ids_with_docs(list: &mut List, docs: &[GatheredDoc]) -> u32 {
	let mut w = Walk { next: 0, ids: true, docs, doc_texts: &[] };
	w.list(list);
	w.next
}

/// Ids for a lone word ([`parse_text`](super::parse_text)).
pub(super) fn finish_word(word: &mut Word, docs: &[GatheredDoc]) {
	let mut w = Walk { next: 0, ids: true, docs, doc_texts: &[] };
	w.word(word);
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::bash::syntax::{Features, NO_ALIASES, Parser};

	#[test]
	fn document_source_preserves_unstripped_bytes_and_real_closer() {
		let src = b"cat <<-'END'\n\t$(echo x)\\\ny\n\tEND\n";
		let mut parser = Parser::new(src, Features::NONE, NO_ALIASES);
		let command = parser.next_command().unwrap().unwrap();
		let cmd = &command.list.items[0].and_or.first.stages[0].cmd;
		let RedirTarget::HereDoc(doc) = &cmd.redirs[0].target else {
			panic!()
		};
		let recorded = serde_json::to_value(doc).unwrap();
		assert_eq!(
			doc.delimiter.as_ref().unwrap().span.recorded(),
			Some(crate::bash::syntax::Span::new(7, 12))
		);
		assert_eq!(recorded["source"]["span"], serde_json::json!({"lo": 13, "hi": 28}));
		assert_eq!(recorded["source"]["raw"], serde_json::json!(b"\t$(echo x)\\\ny\n\t"));
		assert_eq!(recorded["source"]["close"], serde_json::json!({"lo": 28, "hi": 31}));
		assert_eq!(recorded["source"]["close_line"], 27);
		assert_eq!(doc.text, b"$(echo x)\\\ny\n");
	}

	#[test]
	fn document_source_omits_unread_closer_and_virtual_newline() {
		let mut parser = Parser::new(b"cat <<END\nlast", Features::NONE, NO_ALIASES);
		let command = parser.next_command().unwrap().unwrap();
		let cmd = &command.list.items[0].and_or.first.stages[0].cmd;
		let RedirTarget::HereDoc(doc) = &cmd.redirs[0].target else {
			panic!()
		};
		let recorded = serde_json::to_value(doc).unwrap();
		assert_eq!(recorded["source"]["span"], serde_json::json!({"lo": 10, "hi": 14}));
		assert_eq!(recorded["source"]["raw"], serde_json::json!(b"last"));
		assert_eq!(recorded["source"]["close"], serde_json::Value::Null);
		assert_eq!(recorded["source"]["close_line"], serde_json::Value::Null);
		assert_eq!(doc.text, b"last\n");
		assert_eq!(
			command.warnings[0].bash_msg,
			b"warning: here-document at line 1 delimited by end-of-file (wanted `END')"
		);
	}

	#[test]
	fn document_source_keeps_alias_bytes_without_the_injected_space() {
		struct Alias;
		impl crate::bash::syntax::AliasLookup for Alias {
			fn alias(&self, name: &[u8]) -> Option<&[u8]> {
				(name == b"doc").then_some(&b"cat <<EOF\nhello\nEOF"[..])
			}
		}
		let mut parser = Parser::new(b"doc\n", Features::NONE, &Alias);
		let command = parser.next_command().unwrap().unwrap();
		let cmd = &command.list.items[0].and_or.first.stages[0].cmd;
		let RedirTarget::HereDoc(doc) = &cmd.redirs[0].target else {
			panic!()
		};
		let source = doc.source.as_ref().unwrap();
		assert_eq!(source.raw, b"hello\n");
		assert_eq!(source.span, crate::bash::syntax::Span::new(3, 3));
		assert_eq!(source.close, Some(crate::bash::syntax::Span::new(3, 3)));
		assert!(source.flat);
		assert_eq!(doc.text, b"hello\n");
	}

	#[test]
	fn document_closer_records_a_continued_delimiter_extent() {
		let mut parser = Parser::new(b"cat <<EOF\nx\nE\\\nOF\n", Features::NONE, NO_ALIASES);
		let command = parser.next_command().unwrap().unwrap();
		let cmd = &command.list.items[0].and_or.first.stages[0].cmd;
		let RedirTarget::HereDoc(doc) = &cmd.redirs[0].target else {
			panic!()
		};
		let source = doc.source.as_ref().unwrap();
		assert_eq!(source.raw, b"x\n");
		assert_eq!(source.span, crate::bash::syntax::Span::new(10, 12));
		assert_eq!(source.close, Some(crate::bash::syntax::Span::new(12, 17)));
	}
}
