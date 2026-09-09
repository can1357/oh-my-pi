//! Shared markup grammar for the `dom!` and `view!` macros.
//!
//! Parses a single-root element tree with attributes, `{expr}` interpolation,
//! string children, and child-level `for`, `if`, and `match` control flow.
//! Lowering backends live in [`crate::dom`] and [`crate::view`].

use proc_macro2::{Delimiter, Group, Span, TokenStream as TokenStream2, TokenTree};
use quote::quote;
use syn::{Arm, Expr, ExprForLoop, ExprIf, ExprMatch, LitInt, LitStr, parse2};

pub struct Element {
	pub(crate) name:     Name,
	pub(crate) attrs:    Vec<Attr>,
	pub(crate) children: Vec<Child>,
}

pub struct Name {
	pub(crate) text: String,
	pub(crate) span: Span,
	pub(crate) icon: Option<String>,
}

pub struct Attr {
	pub(crate) name:  String,
	pub(crate) span:  Span,
	pub(crate) value: AttrValue,
}

pub enum AttrValue {
	Flag,
	String(LitStr),
	Expr(TokenStream2),
	Bare(LitStr),
}

pub enum Child {
	Element(Element),
	Expr(TokenStream2),
	String(LitStr),
	Control(Control),
}

pub enum Control {
	For(ForControl),
	If(IfControl),
	Match(MatchControl),
}

pub struct ForControl {
	pub(crate) head: TokenStream2,
	pub(crate) body: Vec<Child>,
}

pub struct IfControl {
	pub(crate) branches:  Vec<IfBranch>,
	pub(crate) else_body: Option<Vec<Child>>,
}

pub struct IfBranch {
	pub(crate) head: TokenStream2,
	pub(crate) body: Vec<Child>,
}

pub struct MatchControl {
	pub(crate) head: TokenStream2,
	pub(crate) arms: Vec<MatchArm>,
}

pub struct MatchArm {
	pub(crate) prefix: TokenStream2,
	pub(crate) body:   Vec<Child>,
}

pub struct Parser {
	tokens: Vec<TokenTree>,
	at:     usize,
}

impl Parser {
	pub(crate) fn new(input: TokenStream2) -> Self {
		Self { tokens: input.into_iter().collect(), at: 0 }
	}

	pub(crate) fn peek(&self) -> Option<&TokenTree> {
		self.tokens.get(self.at)
	}

	fn next(&mut self) -> Option<TokenTree> {
		let token = self.tokens.get(self.at).cloned()?;
		self.at += 1;
		Some(token)
	}

	fn punct(&self, ch: char) -> bool {
		matches!(self.peek(), Some(TokenTree::Punct(punct)) if punct.as_char() == ch)
	}

	fn keyword(&self, keyword: &str) -> bool {
		matches!(self.peek(), Some(TokenTree::Ident(ident)) if ident == keyword)
	}

	fn take_punct(&mut self, ch: char) -> Option<Span> {
		if !self.punct(ch) {
			return None;
		}
		let span = self.peek().expect("punctuation was just checked").span();
		self.at += 1;
		Some(span)
	}

	fn expect_punct(&mut self, ch: char, message: &str) -> syn::Result<Span> {
		self.take_punct(ch).ok_or_else(|| {
			let span = self.peek().map_or_else(Span::call_site, TokenTree::span);
			syn::Error::new(span, message)
		})
	}

	fn word(&mut self, message: &str) -> syn::Result<(String, Span)> {
		match self.next() {
			Some(TokenTree::Ident(ident)) => Ok((ident.to_string(), ident.span())),
			Some(token) => Err(syn::Error::new(token.span(), message)),
			None => Err(syn::Error::new(Span::call_site(), message)),
		}
	}

	fn finish_dashed(&mut self, mut value: String, message: &str) -> syn::Result<String> {
		while self.take_punct('-').is_some() {
			let (part, _) = self.word(message)?;
			value.push('-');
			value.push_str(&part);
		}
		Ok(value)
	}

	fn dashed_name(&mut self, message: &str) -> syn::Result<(String, Span)> {
		let (name, span) = self.word(message)?;
		let name = self.finish_dashed(name, "expected a word after `-`")?;
		Ok((name, span))
	}

	fn tag_name(&mut self) -> syn::Result<Name> {
		let (text, span) = self.dashed_name("expected a tag name")?;
		if self.take_punct(':').is_some() {
			if text != "i" {
				return Err(syn::Error::new(span, "only `i:name` icon shorthand may contain `:`"));
			}
			let (icon, _) = self.dashed_name("expected an icon name after `i:`")?;
			return Ok(Name { text: "i".into(), span, icon: Some(icon) });
		}
		Ok(Name { text, span, icon: None })
	}

	pub(crate) fn element(&mut self) -> syn::Result<Element> {
		self.expect_punct('<', "expected `<` to start an element")?;
		if self.punct('/') {
			let span = self.peek().expect("slash was just checked").span();
			return Err(syn::Error::new(span, "unexpected closing tag"));
		}

		let name = self.tag_name()?;
		let mut attrs = Vec::new();
		let self_closing = loop {
			if self.take_punct('>').is_some() {
				break false;
			}
			if self.take_punct('/').is_some() {
				self.expect_punct('>', "expected `>` after `/`")?;
				break true;
			}
			if self.peek().is_none() {
				return Err(syn::Error::new(name.span, "unterminated opening tag"));
			}
			attrs.push(self.attr()?);
		};

		if self_closing {
			return Ok(Element { name, attrs, children: Vec::new() });
		}

		let mut children = Vec::new();
		loop {
			let Some(_) = self.peek() else {
				return Err(syn::Error::new(name.span, format!("unclosed tag <{}>", name.text)));
			};
			if self.punct('<')
				&& matches!(
					self.tokens.get(self.at + 1),
					Some(TokenTree::Punct(punct)) if punct.as_char() == '/'
				) {
				self.at += 2;
				let close = self.tag_name()?;
				self.expect_punct('>', "expected `>` after closing tag")?;
				if close.text != name.text || close.icon.as_deref() != name.icon.as_deref() {
					let expected = name
						.icon
						.as_ref()
						.map_or_else(|| name.text.clone(), |icon| format!("i:{icon}"));
					let found = close
						.icon
						.as_ref()
						.map_or_else(|| close.text.clone(), |icon| format!("i:{icon}"));
					return Err(syn::Error::new(
						close.span,
						format!("mismatched closing tag: expected </{expected}>, found </{found}>"),
					));
				}
				break;
			}
			children.push(self.child()?);
		}

		Ok(Element { name, attrs, children })
	}

	fn fragment(mut self) -> syn::Result<Vec<Child>> {
		let mut children = Vec::new();
		while self.peek().is_some() {
			children.push(self.child()?);
		}
		Ok(children)
	}

	fn child(&mut self) -> syn::Result<Child> {
		let Some(token) = self.peek() else {
			return Err(syn::Error::new(Span::call_site(), "expected a child"));
		};
		if self.punct('<') {
			return self.element().map(Child::Element);
		}
		if self.keyword("for") {
			return self.for_control().map(Child::Control);
		}
		if self.keyword("if") {
			return self.if_control().map(Child::Control);
		}
		if self.keyword("match") {
			return self.match_control().map(Child::Control);
		}

		match token {
			TokenTree::Group(group) if group.delimiter() == Delimiter::Brace => {
				let Some(TokenTree::Group(group)) = self.next() else {
					unreachable!("peeked group changed");
				};
				Ok(Child::Expr(parse_expr_group(group)?))
			},
			TokenTree::Literal(_) => {
				let token = self.next().expect("peeked literal changed");
				Ok(Child::String(string_literal(
					token,
					"text content must be a string literal or {expr}",
				)?))
			},
			_ => Err(syn::Error::new(
				token.span(),
				"text content must be a string literal or {expr}, or control flow",
			)),
		}
	}

	fn control_head(
		&mut self,
		start: usize,
		valid: impl Fn(TokenStream2) -> bool,
		message: &str,
	) -> syn::Result<(TokenStream2, Group)> {
		for end in start + 1..self.tokens.len() {
			let TokenTree::Group(group) = &self.tokens[end] else {
				continue;
			};
			if group.delimiter() != Delimiter::Brace {
				continue;
			}
			let head = self.tokens[start..end]
				.iter()
				.cloned()
				.collect::<TokenStream2>();
			if !valid(quote!(#head {})) {
				continue;
			}
			self.at = end + 1;
			return Ok((head, group.clone()));
		}
		Err(syn::Error::new(self.tokens[start].span(), message))
	}

	fn for_control(&mut self) -> syn::Result<Control> {
		let start = self.at;
		let (head, body) = self.control_head(
			start,
			|tokens| parse2::<ExprForLoop>(tokens).is_ok(),
			"expected `for pattern in expression { children }`",
		)?;
		Ok(Control::For(ForControl { head, body: parse_child_group(body)? }))
	}

	fn if_control(&mut self) -> syn::Result<Control> {
		let mut branches = Vec::new();
		let mut else_body = None;
		loop {
			let start = self.at;
			let (head, body) = self.control_head(
				start,
				|tokens| parse2::<ExprIf>(tokens).is_ok(),
				"expected `if condition { children }`",
			)?;
			branches.push(IfBranch { head, body: parse_child_group(body)? });
			if !self.keyword("else") {
				break;
			}
			let else_span = self.next().expect("peeked else changed").span();
			if self.keyword("if") {
				continue;
			}
			let Some(TokenTree::Group(body)) = self.next() else {
				return Err(syn::Error::new(else_span, "expected `if` or `{ children }` after `else`"));
			};
			if body.delimiter() != Delimiter::Brace {
				return Err(syn::Error::new(body.span(), "expected `{ children }` after `else`"));
			}
			else_body = Some(parse_child_group(body)?);
			break;
		}
		Ok(Control::If(IfControl { branches, else_body }))
	}

	fn match_control(&mut self) -> syn::Result<Control> {
		let start = self.at;
		let (head, body) = self.control_head(
			start,
			|tokens| parse2::<ExprMatch>(tokens).is_ok(),
			"expected `match expression { pattern => children }`",
		)?;
		let arms = Self::new(body.stream()).match_arms()?;
		Ok(Control::Match(MatchControl { head, arms }))
	}

	fn match_arms(mut self) -> syn::Result<Vec<MatchArm>> {
		let mut arms = Vec::new();
		while self.peek().is_some() {
			if self.take_punct(',').is_some() {
				if self.peek().is_none() {
					break;
				}
				return Err(syn::Error::new(
					self.peek().expect("checked next match arm").span(),
					"expected a match pattern after `,`",
				));
			}
			let start = self.at;
			let arrow = (start..self.tokens.len().saturating_sub(1))
				.find(|&at| {
					matches!(&self.tokens[at], TokenTree::Punct(punct) if punct.as_char() == '=')
						&& matches!(&self.tokens[at + 1], TokenTree::Punct(punct) if punct.as_char() == '>')
				})
				.ok_or_else(|| {
					syn::Error::new(self.tokens[start].span(), "expected `=>` after match pattern")
				})?;
			let prefix = self.tokens[start..arrow]
				.iter()
				.cloned()
				.collect::<TokenStream2>();
			parse2::<Arm>(quote!(#prefix => (),)).map_err(|error| {
				syn::Error::new(self.tokens[start].span(), format!("invalid match arm: {error}"))
			})?;
			self.at = arrow + 2;
			let body = self.match_arm_body()?;
			arms.push(MatchArm { prefix, body });
			self.take_punct(',');
		}
		Ok(arms)
	}

	fn match_arm_body(&mut self) -> syn::Result<Vec<Child>> {
		let Some(token) = self.peek() else {
			return Err(syn::Error::new(Span::call_site(), "expected children after `=>`"));
		};
		if let TokenTree::Group(group) = token
			&& group.delimiter() == Delimiter::Brace
		{
			let Some(TokenTree::Group(group)) = self.next() else {
				unreachable!("peeked group changed");
			};
			return parse_child_group(group);
		}
		Ok(vec![self.child()?])
	}

	fn attr(&mut self) -> syn::Result<Attr> {
		let (name, span) = self.dashed_name("expected an attribute name")?;
		let value = if self.take_punct('=').is_none() {
			AttrValue::Flag
		} else {
			self.attr_value()?
		};
		Ok(Attr { name, span, value })
	}

	fn attr_value(&mut self) -> syn::Result<AttrValue> {
		let Some(token) = self.next() else {
			return Err(syn::Error::new(Span::call_site(), "expected an attribute value"));
		};
		match token {
			TokenTree::Group(group) if group.delimiter() == Delimiter::Brace => {
				Ok(AttrValue::Expr(parse_expr_group(group)?))
			},
			TokenTree::Group(group) => {
				Err(syn::Error::new(group.span(), "quote this value or use `{expr}`"))
			},
			TokenTree::Ident(ident) => {
				let span = ident.span();
				let value = self
					.finish_dashed(ident.to_string(), "expected a word after `-` in attribute value")?;
				Ok(AttrValue::Bare(LitStr::new(&value, span)))
			},
			TokenTree::Literal(literal) => {
				let literal_token = TokenTree::Literal(literal.clone());
				if let Ok(value) = parse2::<LitStr>(literal_token.clone().into()) {
					return Ok(AttrValue::String(value));
				}
				let integer = parse2::<LitInt>(literal_token.into())
					.map_err(|_| syn::Error::new(literal.span(), "quote this value"))?;
				if !integer.suffix().is_empty() {
					return Err(syn::Error::new(literal.span(), "quote this value"));
				}
				let mut value = literal.to_string();
				if self.take_punct('%').is_some() {
					value.push('%');
				}
				Ok(AttrValue::Bare(LitStr::new(&value, literal.span())))
			},
			other => Err(syn::Error::new(other.span(), "quote this value")),
		}
	}
}

pub fn parse_expr_group(group: Group) -> syn::Result<TokenStream2> {
	let tokens = group.stream();
	if tokens.is_empty() {
		return Err(syn::Error::new(group.span(), "expected an expression inside braces"));
	}
	parse2::<Expr>(tokens.clone())?;
	Ok(tokens)
}

pub fn parse_child_group(group: Group) -> syn::Result<Vec<Child>> {
	let tokens = group.stream();
	match Parser::new(tokens).fragment() {
		Ok(children) => Ok(children),
		Err(markup_error) => {
			let expression = TokenStream2::from(TokenTree::Group(group));
			if parse2::<Expr>(expression.clone()).is_ok() {
				Ok(vec![Child::Expr(expression)])
			} else {
				Err(markup_error)
			}
		},
	}
}

pub fn string_literal(token: TokenTree, message: &str) -> syn::Result<LitStr> {
	let span = token.span();
	parse2::<LitStr>(token.into()).map_err(|_| syn::Error::new(span, message))
}
