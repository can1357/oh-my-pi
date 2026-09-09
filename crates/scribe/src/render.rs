//! Engine construction, template compilation, and pure rendering.

use std::{cmp, collections::HashMap};

use omp_core::Str;
use omp_dom::{Dom, Value as DomValue};
use smallvec::SmallVec;

use crate::{
	Props, ScopedProps, Value,
	error::{Error, HelperError, Span, TypeErrorKind},
	filters,
	parse::{self, BinOp, Expr, Node},
};

/// A filter or function callable from templates. For filters, `args[0]` is
/// the piped input followed by the written arguments. DOM-aware functions
/// receive the render-scoped authoritative tree without owning or copying it.
type HelperFn = Box<dyn Fn(&[Value], Option<&Dom>) -> Result<Value, Error> + Send + Sync>;
/// A block helper: receives evaluated arguments plus the rendered body and
/// writes its output.
type BlockFn = Box<dyn Fn(&[Value], &str, &mut String) -> Result<(), Error> + Send + Sync>;

/// The helper registry: filters, functions, and block helpers.
///
/// Built once at startup with the builtins pre-registered, then shared
/// (wrap in `Arc` to share across threads). Registered helpers MUST be
/// deterministic — rendering is pure, and callers rely on double-render
/// equality to detect volatile sources.
pub struct Engine {
	filters:   HashMap<&'static str, HelperFn>,
	functions: HashMap<&'static str, HelperFn>,
	blocks:    HashMap<&'static str, BlockFn>,
}

impl Engine {
	/// Creates an engine with the builtin filters, functions, and blocks.
	pub fn new() -> Self {
		let mut engine =
			Self { filters: HashMap::new(), functions: HashMap::new(), blocks: HashMap::new() };
		filters::install(&mut engine);
		install_dom_functions(&mut engine);
		engine
	}

	/// Registers a filter: `{{ value | name(args) }}` calls `f` with the
	/// piped value first, then the written arguments.
	pub fn add_filter(
		&mut self,
		name: &'static str,
		f: impl Fn(&[Value]) -> Result<Value, Error> + Send + Sync + 'static,
	) {
		self
			.filters
			.insert(name, Box::new(move |args, _dom| f(args)));
	}

	/// Registers a function: `{{ name(args) }}`.
	pub fn add_function(
		&mut self,
		name: &'static str,
		f: impl Fn(&[Value]) -> Result<Value, Error> + Send + Sync + 'static,
	) {
		self
			.functions
			.insert(name, Box::new(move |args, _dom| f(args)));
	}

	fn add_dom_function(
		&mut self,
		name: &'static str,
		f: impl Fn(&[Value], Option<&Dom>) -> Result<Value, Error> + Send + Sync + 'static,
	) {
		self.functions.insert(name, Box::new(f));
	}

	/// Registers a block helper: `{% name args %}body{% endname %}` calls
	/// `f` with the evaluated arguments and the rendered body.
	pub fn add_block(
		&mut self,
		name: &'static str,
		f: impl Fn(&[Value], &str, &mut String) -> Result<(), Error> + Send + Sync + 'static,
	) {
		self.blocks.insert(name, Box::new(f));
	}

	/// Compiles a static template source, validating syntax and that every
	/// referenced filter, function, and block is registered on this engine.
	pub fn compile(&self, name: &'static str, source: &'static str) -> Result<Template, Error> {
		Template::compile(self, Str::new_static(name), Str::new_static(source))
	}

	/// Compiles a runtime-supplied template from an owned name and copied
	/// source.
	pub fn compile_owned(&self, name: Str, source: &str) -> Result<Template, Error> {
		Template::compile(self, name, Str::new(source))
	}
}

impl Default for Engine {
	fn default() -> Self {
		Self::new()
	}
}

fn install_dom_functions(engine: &mut Engine) {
	engine.add_dom_function("select", |args, dom| {
		let selector = one_selector_arg("select", args)?;
		let dom = dom.ok_or_else(|| Error::helper("select", HelperError::MissingDom))?;
		let handles = dom
			.select(selector)
			.map_err(|source| Error::helper("select", source))?;
		Ok(Value::List(
			handles
				.filter_map(|handle| dom.get(handle).map(|node| node_value(handle, node)))
				.collect(),
		))
	});
	engine.add_dom_function("count", |args, dom| {
		if args.len() != 1 {
			return Err(Error::helper("count", HelperError::Arity {
				expected: 1,
				got:      args.len(),
			}));
		}
		let count = match &args[0] {
			Value::List(items) => items.len(),
			Value::Str(selector) => dom
				.ok_or_else(|| Error::helper("count", HelperError::MissingDom))?
				.count(selector)
				.map_err(|source| Error::helper("count", source))?,
			_ => return Err(Error::helper("count", HelperError::SelectorOrList)),
		};
		Ok(Value::Int(i64::try_from(count).unwrap_or(i64::MAX)))
	});
}

fn one_selector_arg<'a>(name: &'static str, args: &'a [Value]) -> Result<&'a str, Error> {
	if args.len() != 1 {
		return Err(Error::helper(name, HelperError::Arity { expected: 1, got: args.len() }));
	}
	args[0]
		.as_str()
		.ok_or_else(|| Error::helper(name, HelperError::ExpectedString))
}

fn node_value(handle: omp_dom::Handle, node: &omp_dom::Node) -> Value {
	let mut props = im::OrdMap::new();
	for (key, value) in &node.props {
		props.insert(Str::from(key.to_string()), dom_value(value));
	}
	let mut map = im::OrdMap::new();
	map.insert(Str::new_static("handle"), Value::Int(handle.get() as i64));
	map.insert(Str::new_static("tag"), Value::Str(Str::from(node.tag.to_string())));
	map.insert(Str::new_static("content"), node.content.clone().map_or(Value::None, Value::Str));
	map.insert(Str::new_static("props"), Value::Map(props));
	Value::Map(map)
}

fn dom_value(value: &DomValue) -> Value {
	match value {
		DomValue::Null => Value::None,
		DomValue::Bool(value) => Value::Bool(*value),
		DomValue::Int(value) => Value::Int(*value),
		DomValue::Float(value) => Value::Float(*value),
		DomValue::Str(value) => Value::Str(value.clone()),
		DomValue::Json(value) => {
			let parsed: serde_json::Value = serde_json::from_str(value.get())
				.expect("DOM raw JSON values are validated at construction");
			Value::from(&parsed)
		},
	}
}

/// A compiled template: name, retained source (for error snippets and
/// zero-copy text nodes), AST, and the referenced top-level prop keys.
#[derive(Debug)]
pub struct Template {
	name:   Str,
	source: Str,
	nodes:  Vec<Node>,
	keys:   Vec<Str>,
}

impl Template {
	fn compile(engine: &Engine, name: Str, source: Str) -> Result<Self, Error> {
		let nodes = parse::parse(&name, &source)?;
		validate(engine, &name, source.as_str(), &nodes)?;
		let mut keys = Vec::new();
		let mut bound = Vec::new();
		collect_keys(&nodes, &mut bound, &mut keys);
		keys.sort_unstable();
		keys.dedup();
		Ok(Self { name, source, nodes, keys })
	}

	/// The name supplied at compile time.
	pub fn name(&self) -> &str {
		self.name.as_str()
	}

	/// Renders into `out`. Pure and deterministic: output depends only on
	/// the template, the engine's registered helpers, and `props`.
	pub fn render(&self, engine: &Engine, props: &Props, out: &mut String) -> Result<(), Error> {
		self.render_inner(engine, props, None, out)
	}

	/// Renders with a borrowed authoritative session DOM available to the
	/// `select` and `count` template functions.
	pub fn render_scoped(
		&self,
		engine: &Engine,
		props: &ScopedProps<'_>,
		out: &mut String,
	) -> Result<(), Error> {
		self.render_inner(engine, props.values, Some(props.dom), out)
	}

	fn render_inner(
		&self,
		engine: &Engine,
		props: &Props,
		dom: Option<&Dom>,
		out: &mut String,
	) -> Result<(), Error> {
		let mut ctx = Ctx {
			engine,
			props,
			dom,
			name: &self.name,
			source: self.source.as_str(),
			frames: vec![Vec::new()],
		};
		render_nodes(&self.nodes, &mut ctx, out)
	}

	/// Renders to an owned string.
	pub fn render_str(&self, engine: &Engine, props: &Props) -> Result<Str, Error> {
		let mut out = String::new();
		self.render(engine, props, &mut out)?;
		Ok(Str::from(out))
	}

	/// Renders to an owned string with a borrowed authoritative session DOM.
	pub fn render_scoped_str(&self, engine: &Engine, props: &ScopedProps<'_>) -> Result<Str, Error> {
		let mut out = String::new();
		self.render_scoped(engine, props, &mut out)?;
		Ok(Str::from(out))
	}

	/// Top-level prop paths this template reads (static analysis of the
	/// AST, excluding loop variables and `set` bindings). Sorted, deduped.
	pub fn referenced_keys(
		&self,
	) -> impl DoubleEndedIterator<Item = &str> + ExactSizeIterator + Clone + '_ {
		self.keys.iter().map(Str::as_str)
	}
}

/// Compile-time check that every filter, function, and block referenced by
/// the AST is registered.
fn validate(engine: &Engine, name: &Str, source: &str, nodes: &[Node]) -> Result<(), Error> {
	for node in nodes {
		match node {
			Node::Text(_) => {},
			Node::Emit(expr) | Node::Set { value: expr, .. } => {
				validate_expr(engine, name, source, expr)?;
			},
			Node::If(arms) => {
				for arm in arms {
					if let Some(cond) = &arm.cond {
						validate_expr(engine, name, source, cond)?;
					}
					validate(engine, name, source, &arm.body)?;
				}
			},
			Node::For { iter, body, .. } => {
				validate_expr(engine, name, source, iter)?;
				validate(engine, name, source, body)?;
			},
			Node::Block { name: block, name_span, args, body } => {
				if !engine.blocks.contains_key(block.as_str()) {
					return Err(Error::type_error(
						name,
						source,
						*name_span,
						TypeErrorKind::UnknownBlock,
					));
				}
				for arg in args {
					validate_expr(engine, name, source, arg)?;
				}
				validate(engine, name, source, body)?;
			},
		}
	}
	Ok(())
}

fn validate_expr(engine: &Engine, name: &Str, source: &str, expr: &Expr) -> Result<(), Error> {
	match expr {
		Expr::Lit(..) | Expr::Var { .. } => Ok(()),
		Expr::Attr { base, .. } | Expr::Not(base) | Expr::Neg(base, _) => {
			validate_expr(engine, name, source, base)
		},
		Expr::Index { base, index, .. } => {
			validate_expr(engine, name, source, base)?;
			validate_expr(engine, name, source, index)
		},
		Expr::Bin { lhs, rhs, .. } => {
			validate_expr(engine, name, source, lhs)?;
			validate_expr(engine, name, source, rhs)
		},
		Expr::Ternary { cond, then, otherwise } => {
			validate_expr(engine, name, source, cond)?;
			validate_expr(engine, name, source, then)?;
			validate_expr(engine, name, source, otherwise)
		},
		Expr::Filter { name: filter, name_span, input, args } => {
			if !engine.filters.contains_key(filter.as_str()) {
				return Err(Error::type_error(name, source, *name_span, TypeErrorKind::UnknownFilter));
			}
			validate_expr(engine, name, source, input)?;
			for arg in args {
				validate_expr(engine, name, source, arg)?;
			}
			Ok(())
		},
		Expr::Call { name: function, name_span, args } => {
			if !engine.functions.contains_key(function.as_str()) {
				return Err(Error::type_error(
					name,
					source,
					*name_span,
					TypeErrorKind::UnknownFunction,
				));
			}
			for arg in args {
				validate_expr(engine, name, source, arg)?;
			}
			Ok(())
		},
	}
}

/// Collects root prop names read by `nodes`, skipping names bound by `for`
/// and `set` (and the implicit `loop`).
fn collect_keys(nodes: &[Node], bound: &mut Vec<Str>, keys: &mut Vec<Str>) {
	for node in nodes {
		match node {
			Node::Text(_) => {},
			Node::Emit(expr) => collect_expr_keys(expr, bound, keys),
			Node::If(arms) => {
				for arm in arms {
					if let Some(cond) = &arm.cond {
						collect_expr_keys(cond, bound, keys);
					}
					collect_keys(&arm.body, bound, keys);
				}
			},
			Node::For { var, iter, body, .. } => {
				collect_expr_keys(iter, bound, keys);
				let depth = bound.len();
				bound.push(var.clone());
				bound.push(Str::new_static("loop"));
				collect_keys(body, bound, keys);
				bound.truncate(depth);
			},
			Node::Set { name, value } => {
				collect_expr_keys(value, bound, keys);
				bound.push(name.clone());
			},
			Node::Block { args, body, .. } => {
				for arg in args {
					collect_expr_keys(arg, bound, keys);
				}
				collect_keys(body, bound, keys);
			},
		}
	}
}

fn collect_expr_keys(expr: &Expr, bound: &[Str], keys: &mut Vec<Str>) {
	match expr {
		Expr::Lit(..) => {},
		Expr::Var { name, .. } => {
			if !bound.iter().any(|entry| entry == name) {
				keys.push(name.clone());
			}
		},
		Expr::Attr { base, .. } | Expr::Not(base) | Expr::Neg(base, _) => {
			collect_expr_keys(base, bound, keys);
		},
		Expr::Index { base, index, .. } => {
			collect_expr_keys(base, bound, keys);
			collect_expr_keys(index, bound, keys);
		},
		Expr::Bin { lhs, rhs, .. } => {
			collect_expr_keys(lhs, bound, keys);
			collect_expr_keys(rhs, bound, keys);
		},
		Expr::Ternary { cond, then, otherwise } => {
			collect_expr_keys(cond, bound, keys);
			collect_expr_keys(then, bound, keys);
			collect_expr_keys(otherwise, bound, keys);
		},
		Expr::Filter { input, args, .. } => {
			collect_expr_keys(input, bound, keys);
			for arg in args {
				collect_expr_keys(arg, bound, keys);
			}
		},
		Expr::Call { args, .. } => {
			for arg in args {
				collect_expr_keys(arg, bound, keys);
			}
		},
	}
}

// ============================
// Evaluation
// ============================

/// Render-time state: registry, props, scope frames, and error context.
struct Ctx<'r> {
	engine: &'r Engine,
	props:  &'r Props,
	dom:    Option<&'r Dom>,
	name:   &'r Str,
	source: &'r str,
	frames: Vec<Vec<(Str, Value)>>,
}

impl Ctx<'_> {
	fn undefined(&self, path: Str, span: Span) -> Error {
		Error::undefined(self.name, self.source, span, path)
	}

	fn type_error(&self, span: Span, kind: TypeErrorKind) -> Error {
		Error::type_error(self.name, self.source, span, kind)
	}

	fn lookup(&self, name: &str) -> Option<&Value> {
		for frame in self.frames.iter().rev() {
			if let Some((_, value)) = frame.iter().rev().find(|(key, _)| key == name) {
				return Some(value);
			}
		}
		self.props.get(name)
	}

	fn assign(&mut self, name: Str, value: Value) {
		let frame = self
			.frames
			.last_mut()
			.expect("render always holds a root frame");
		if let Some(slot) = frame.iter_mut().find(|(key, _)| *key == name) {
			slot.1 = value;
		} else {
			frame.push((name, value));
		}
	}
}

/// An evaluated expression: a value, or a missing lookup that only becomes
/// an error at a strict sink.
enum Eval {
	Val(Value),
	Undefined { path: Str, span: Span },
}

impl Eval {
	fn truthy(&self) -> bool {
		matches!(self, Self::Val(value) if value.is_truthy())
	}

	/// Missing lookups collapse to `none` (conditions, `?.`, `and`/`or`).
	fn lenient(self) -> Value {
		match self {
			Self::Val(value) => value,
			Self::Undefined { .. } => Value::None,
		}
	}

	/// Strict sinks (emission, iteration, ordering, filters) reject missing
	/// lookups with a spanned error.
	fn required(self, ctx: &Ctx<'_>) -> Result<Value, Error> {
		match self {
			Self::Val(value) => Ok(value),
			Self::Undefined { path, span } => Err(ctx.undefined(path, span)),
		}
	}
}

fn render_nodes(nodes: &[Node], ctx: &mut Ctx<'_>, out: &mut String) -> Result<(), Error> {
	for node in nodes {
		match node {
			Node::Text(text) => out.push_str(text),
			Node::Emit(expr) => eval(expr, ctx)?.required(ctx)?.write_display(out),
			Node::If(arms) => {
				for arm in arms {
					let live = match &arm.cond {
						None => true,
						Some(cond) => eval(cond, ctx)?.truthy(),
					};
					if live {
						render_nodes(&arm.body, ctx, out)?;
						break;
					}
				}
			},
			Node::For { var, iter, body, span } => {
				let items = eval(iter, ctx)?.required(ctx)?;
				let entries: SmallVec<Value, 8> = match items {
					Value::List(items) => items.iter().cloned().collect(),
					Value::Map(entries) => entries
						.iter()
						.map(|(key, value)| {
							let mut pair = im::Vector::new();
							pair.push_back(Value::Str(key.clone()));
							pair.push_back(value.clone());
							Value::List(pair)
						})
						.collect(),
					_ => return Err(ctx.type_error(*span, TypeErrorKind::NotIterable)),
				};
				let len = entries.len();
				for (index, item) in entries.into_iter().enumerate() {
					let frame =
						vec![(var.clone(), item), (Str::new_static("loop"), loop_value(index, len))];
					ctx.frames.push(frame);
					let outcome = render_nodes(body, ctx, out);
					ctx.frames.pop();
					outcome?;
				}
			},
			Node::Set { name, value } => {
				let value = eval(value, ctx)?.lenient();
				ctx.assign(name.clone(), value);
			},
			Node::Block { name, name_span, args, body } => {
				let mut evaluated: SmallVec<Value, 4> = SmallVec::new();
				for arg in args {
					evaluated.push(eval(arg, ctx)?.required(ctx)?);
				}
				let mut rendered = String::new();
				render_nodes(body, ctx, &mut rendered)?;
				let block = ctx
					.engine
					.blocks
					.get(name.as_str())
					.ok_or_else(|| ctx.type_error(*name_span, TypeErrorKind::UnknownBlock))?;
				block(&evaluated, &rendered, out)?;
			},
		}
	}
	Ok(())
}

/// The `loop` variable for one iteration.
fn loop_value(index: usize, len: usize) -> Value {
	let mut map = im::OrdMap::new();
	map.insert(Str::new_static("index0"), Value::Int(index as i64));
	map.insert(Str::new_static("first"), Value::Bool(index == 0));
	map.insert(Str::new_static("last"), Value::Bool(index + 1 == len));
	Value::Map(map)
}

fn eval(expr: &Expr, ctx: &mut Ctx<'_>) -> Result<Eval, Error> {
	match expr {
		Expr::Lit(value) => Ok(Eval::Val(value.clone())),
		Expr::Var { name, span } => Ok(match ctx.lookup(name) {
			Some(value) => Eval::Val(value.clone()),
			None => Eval::Undefined { path: name.clone(), span: *span },
		}),
		Expr::Attr { base, name, optional, span } => {
			let base_value = eval(base, ctx)?;
			Ok(access(expr, base_value, *optional, *span, |value| match value {
				Value::Map(map) => map.get(name.as_str()).cloned(),
				_ => None,
			}))
		},
		Expr::Index { base, index, optional, span } => {
			let key = eval(index, ctx)?.required(ctx)?;
			let base_value = eval(base, ctx)?;
			Ok(access(expr, base_value, *optional, *span, |value| match (value, &key) {
				(Value::Map(map), Value::Str(key)) => map.get(key.as_str()).cloned(),
				(Value::List(items), Value::Int(index)) => usize::try_from(*index)
					.ok()
					.and_then(|index| items.get(index).cloned()),
				_ => None,
			}))
		},
		Expr::Not(inner) => Ok(Eval::Val(Value::Bool(!eval(inner, ctx)?.truthy()))),
		Expr::Neg(inner, span) => match eval(inner, ctx)?.required(ctx)? {
			Value::Int(value) => Ok(Eval::Val(Value::Int(value.wrapping_neg()))),
			Value::Float(value) => Ok(Eval::Val(Value::Float(-value))),
			_ => Err(ctx.type_error(*span, TypeErrorKind::NotNumeric)),
		},
		Expr::Bin { op, lhs, rhs, span } => eval_bin(*op, lhs, rhs, *span, ctx),
		Expr::Ternary { cond, then, otherwise } => {
			if eval(cond, ctx)?.truthy() {
				eval(then, ctx)
			} else {
				eval(otherwise, ctx)
			}
		},
		Expr::Filter { name, name_span, input, args } => {
			let input_value = eval(input, ctx)?;
			let input_value = if name == "default" {
				input_value.lenient()
			} else {
				input_value.required(ctx)?
			};
			let mut evaluated: SmallVec<Value, 4> = SmallVec::new();
			evaluated.push(input_value);
			for arg in args {
				evaluated.push(eval(arg, ctx)?.required(ctx)?);
			}
			let filter = ctx
				.engine
				.filters
				.get(name.as_str())
				.ok_or_else(|| ctx.type_error(*name_span, TypeErrorKind::UnknownFilter))?;
			Ok(Eval::Val(filter(&evaluated, ctx.dom)?))
		},
		Expr::Call { name, name_span, args } => {
			let mut evaluated: SmallVec<Value, 4> = SmallVec::new();
			for arg in args {
				evaluated.push(eval(arg, ctx)?.required(ctx)?);
			}
			let function = ctx
				.engine
				.functions
				.get(name.as_str())
				.ok_or_else(|| ctx.type_error(*name_span, TypeErrorKind::UnknownFunction))?;
			Ok(Eval::Val(function(&evaluated, ctx.dom)?))
		},
	}
}

/// Shared attribute/index resolution: undefined bases propagate (or collapse
/// to `none` when the chain is lenient); missing members become undefined
/// with the full dotted path, or `none` under `?.`.
fn access(
	expr: &Expr,
	base: Eval,
	optional: bool,
	span: Span,
	get: impl FnOnce(&Value) -> Option<Value>,
) -> Eval {
	match base {
		Eval::Undefined { path, span: base_span } => {
			if optional {
				Eval::Val(Value::None)
			} else {
				Eval::Undefined { path, span: base_span }
			}
		},
		Eval::Val(value) => match get(&value) {
			Some(found) => Eval::Val(found),
			None if optional => Eval::Val(Value::None),
			None => Eval::Undefined { path: expr.path(), span },
		},
	}
}

fn eval_bin(
	op: BinOp,
	lhs: &Expr,
	rhs: &Expr,
	span: Span,
	ctx: &mut Ctx<'_>,
) -> Result<Eval, Error> {
	match op {
		BinOp::And => {
			let left = eval(lhs, ctx)?;
			if left.truthy() {
				Ok(Eval::Val(eval(rhs, ctx)?.lenient()))
			} else {
				Ok(Eval::Val(left.lenient()))
			}
		},
		BinOp::Or => {
			let left = eval(lhs, ctx)?;
			if left.truthy() {
				Ok(Eval::Val(left.lenient()))
			} else {
				Ok(Eval::Val(eval(rhs, ctx)?.lenient()))
			}
		},
		BinOp::Eq | BinOp::Ne => {
			let left = eval(lhs, ctx)?.lenient();
			let right = eval(rhs, ctx)?.lenient();
			let equal = value_eq(&left, &right);
			Ok(Eval::Val(Value::Bool(if op == BinOp::Eq { equal } else { !equal })))
		},
		BinOp::Lt | BinOp::Le | BinOp::Gt | BinOp::Ge => {
			let left = eval(lhs, ctx)?.required(ctx)?;
			let right = eval(rhs, ctx)?.required(ctx)?;
			let ordering = value_cmp(&left, &right)
				.ok_or_else(|| ctx.type_error(span, TypeErrorKind::NotComparable))?;
			let outcome = match op {
				BinOp::Lt => ordering.is_lt(),
				BinOp::Le => ordering.is_le(),
				BinOp::Gt => ordering.is_gt(),
				_ => ordering.is_ge(),
			};
			Ok(Eval::Val(Value::Bool(outcome)))
		},
		BinOp::In => {
			let needle = eval(lhs, ctx)?.lenient();
			let haystack = eval(rhs, ctx)?.lenient();
			let found = match (&needle, &haystack) {
				(_, Value::List(items)) => items.iter().any(|item| value_eq(item, &needle)),
				(Value::Str(key), Value::Map(map)) => map.contains_key(key.as_str()),
				(Value::Str(needle), Value::Str(haystack)) => {
					haystack.as_str().contains(needle.as_str())
				},
				_ => false,
			};
			Ok(Eval::Val(Value::Bool(found)))
		},
		BinOp::Concat => {
			let left = eval(lhs, ctx)?.required(ctx)?;
			let right = eval(rhs, ctx)?.required(ctx)?;
			let mut out = String::new();
			left.write_display(&mut out);
			right.write_display(&mut out);
			Ok(Eval::Val(Value::Str(Str::from(out))))
		},
		BinOp::Add | BinOp::Sub => {
			let left = eval(lhs, ctx)?.required(ctx)?;
			let right = eval(rhs, ctx)?.required(ctx)?;
			let value = match (&left, &right) {
				(Value::Int(a), Value::Int(b)) => Value::Int(if op == BinOp::Add {
					a.wrapping_add(*b)
				} else {
					a.wrapping_sub(*b)
				}),
				(Value::Int(_) | Value::Float(_), Value::Int(_) | Value::Float(_)) => {
					let (a, b) = (as_f64(&left), as_f64(&right));
					Value::Float(if op == BinOp::Add { a + b } else { a - b })
				},
				_ => return Err(ctx.type_error(span, TypeErrorKind::NotNumeric)),
			};
			Ok(Eval::Val(value))
		},
	}
}

const fn as_f64(value: &Value) -> f64 {
	match value {
		Value::Int(value) => *value as f64,
		Value::Float(value) => *value,
		_ => 0.0,
	}
}

/// Equality with int/float coercion; other shapes use structural equality.
fn value_eq(left: &Value, right: &Value) -> bool {
	match (left, right) {
		(Value::Int(a), Value::Float(b)) | (Value::Float(b), Value::Int(a)) => *a as f64 == *b,
		_ => left == right,
	}
}

/// Ordering for numbers (coerced) and strings; `None` elsewhere.
fn value_cmp(left: &Value, right: &Value) -> Option<cmp::Ordering> {
	match (left, right) {
		(Value::Int(a), Value::Int(b)) => Some(a.cmp(b)),
		(Value::Int(_) | Value::Float(_), Value::Int(_) | Value::Float(_)) => {
			as_f64(left).partial_cmp(&as_f64(right))
		},
		(Value::Str(a), Value::Str(b)) => Some(a.as_str().cmp(b.as_str())),
		_ => None,
	}
}

#[cfg(test)]
mod tests {
	use omp_dom::{KnownTag, NodeSpec, Op, PropId, Txn, Value as DomValue};

	use super::*;
	use crate::{TypeErrorKind, list, map};

	fn render(source: &'static str, props: &Props) -> Result<Str, Error> {
		let engine = Engine::new();
		engine.compile("test", source)?.render_str(&engine, props)
	}

	fn props(entries: &[(&'static str, Value)]) -> Props {
		let mut props = Props::new();
		for (key, value) in entries {
			props.set(*key, value.clone());
		}
		props
	}

	#[test]
	fn conditionals_and_emission_compose() {
		let bag = props(&[("tools", list!["a"]), ("name", Value::from("x"))]);
		assert_eq!(render("{% if tools %}yes{% endif %}{{ name }}", &bag).unwrap(), "yesx");
	}

	#[test]
	fn dom_select_count_and_each_project_nodes_without_serialization() {
		let mut dom = Dom::new();
		let todo = dom
			.apply(&Txn {
				cause: Default::default(),
				label: None,
				ops:   vec![Op::Ins {
					parent: dom.meta(),
					after:  None,
					node:   NodeSpec::new(KnownTag::Todo),
				}],
			})
			.unwrap()
			.minted[0];
		dom.apply(&Txn {
			cause: Default::default(),
			label: None,
			ops:   vec![
				Op::Ins {
					parent: todo,
					after:  None,
					node:   NodeSpec::new(KnownTag::Item)
						.with_prop(PropId::Status, DomValue::Str(Str::new_static("pending")))
						.with_content("first"),
				},
				Op::Ins {
					parent: todo,
					after:  None,
					node:   NodeSpec::new(KnownTag::Item)
						.with_prop(PropId::Status, DomValue::Str(Str::new_static("completed")))
						.with_content("second"),
				},
			],
		})
		.unwrap();

		let engine = Engine::new();
		let template = engine
			.compile(
				"dom",
				"{{ count(\"todo item[status!=completed]\") }}/{{ count(select(\"todo item\")) }}:{% \
				 for item in select(\"todo item[status!=completed]\") %}{{ item.content }}={{ \
				 item.props.status }}{% endfor %}",
			)
			.unwrap();
		let props = Props::new();
		assert_eq!(
			template
				.render_scoped_str(&engine, &props.with_dom(&dom))
				.unwrap(),
			"1/2:first=pending"
		);
	}

	#[test]
	fn dom_functions_require_an_explicit_render_scope() {
		let engine = Engine::new();
		let template = engine.compile("dom", "{{ count(\"todo\") }}").unwrap();
		let error = template.render_str(&engine, &Props::new()).unwrap_err();
		assert!(
			matches!(error, Error::Helper { source, .. } if source.downcast_ref::<HelperError>() == Some(&HelperError::MissingDom))
		);
	}

	#[test]
	fn undefined_emission_errors_with_line_and_path() {
		let bag = props(&[("tools", list!["a"])]);
		let error = render("{% if tools %}yes{% endif %}{{ name }}", &bag).unwrap_err();
		match error {
			Error::UndefinedKey { path, line, .. } => {
				assert_eq!(path, "name");
				assert_eq!(line, 1);
			},
			other => panic!("expected UndefinedKey, got {other}"),
		}
	}

	#[test]
	fn standalone_statement_lines_disappear() {
		let bag = props(&[("t", Value::Bool(true))]);
		assert_eq!(render("a\n{% if t %}\nb\n{% endif %}\nc", &bag).unwrap(), "a\nb\nc");
	}

	#[test]
	fn standalone_comments_disappear_and_inline_comments_do_not_eat_text() {
		let bag = Props::new();
		assert_eq!(render("a\n{# gone #}\nb", &bag).unwrap(), "a\nb");
		assert_eq!(render("a {# gone #} b", &bag).unwrap(), "a  b");
	}

	#[test]
	fn explicit_trim_markers_strip_all_adjacent_whitespace() {
		let bag = props(&[("x", Value::from("v"))]);
		assert_eq!(render("a   {{- x -}}   b", &bag).unwrap(), "avb");
		assert_eq!(render("a\n\n{%- if x %}v{% endif -%}\n\nb", &bag).unwrap(), "avb");
	}

	#[test]
	fn one_trailing_template_newline_is_stripped() {
		let bag = Props::new();
		assert_eq!(render("hi\n", &bag).unwrap(), "hi");
		assert_eq!(render("hi\n\n", &bag).unwrap(), "hi\n");
	}

	#[test]
	fn if_elif_else_selects_the_first_live_arm() {
		let source = "{% if a %}A{% elif b %}B{% else %}C{% endif %}";
		assert_eq!(render(source, &props(&[("a", Value::Bool(true))])).unwrap(), "A");
		assert_eq!(render(source, &props(&[("b", Value::Int(2))])).unwrap(), "B");
		assert_eq!(render(source, &Props::new()).unwrap(), "C");
	}

	#[test]
	fn for_binds_loop_metadata_and_maps_iterate_in_key_order() {
		let bag = props(&[("items", list!["a", "b", "c"])]);
		let source = "{% for x in items %}{{ loop.index0 }}{{ x }}{% if not loop.last %},{% endif \
		              %}{% endfor %}";
		assert_eq!(render(source, &bag).unwrap(), "0a,1b,2c");
		let bag = props(&[("m", map! { "b" => 2, "a" => 1 })]);
		let source = "{% for pair in m %}{{ pair[0] }}={{ pair[1] }};{% endfor %}";
		assert_eq!(render(source, &bag).unwrap(), "a=1;b=2;");
	}

	#[test]
	fn set_is_render_scoped() {
		let bag = props(&[("x", Value::Int(1))]);
		assert_eq!(render("{% set y = x + 1 %}{{ y }}{{ y }}", &bag).unwrap(), "22");
	}

	#[test]
	fn optional_chaining_is_lenient_and_plain_access_is_strict() {
		let bag = props(&[("m", map! { "a" => 1 })]);
		assert_eq!(render("[{{ m?.missing }}]", &bag).unwrap(), "[]");
		assert_eq!(render("[{{ gone?.deep.deeper }}]", &bag).unwrap(), "[]");
		assert!(matches!(
			render("{{ m.missing }}", &bag).unwrap_err(),
			Error::UndefinedKey { path, .. } if path == "m.missing"
		));
		// Missing keys are falsy in conditions without ?.
		assert_eq!(render("{% if m.missing %}y{% else %}n{% endif %}", &bag).unwrap(), "n");
	}

	#[test]
	fn undefined_ordering_comparison_errors_even_inside_if() {
		let error = render("{% if missing > 3 %}y{% endif %}", &Props::new()).unwrap_err();
		assert!(matches!(error, Error::UndefinedKey { path, .. } if path == "missing"));
	}

	#[test]
	fn operators_cover_the_specced_grammar() {
		let bag = props(&[
			("n", Value::Int(3)),
			("f", Value::Float(3.0)),
			("s", Value::from("well")),
			("items", list!["a", "b"]),
			("m", map! { "k" => 1 }),
		]);
		assert_eq!(render("{{ n + 1 }} {{ n - 1 }} {{ -n }}", &bag).unwrap(), "4 2 -3");
		assert_eq!(render("{{ n == f }}{{ n != f }}", &bag).unwrap(), "truefalse");
		assert_eq!(render("{{ n <= 3 }}{{ n < 3 }}{{ n >= 4 }}", &bag).unwrap(), "truefalsefalse");
		assert_eq!(render("{{ s ~ \"-\" ~ n }}", &bag).unwrap(), "well-3");
		assert_eq!(
			render("{{ \"a\" in items }}{{ \"k\" in m }}{{ \"el\" in s }}{{ \"z\" in items }}", &bag)
				.unwrap(),
			"truetruetruefalse"
		);
		assert_eq!(render("{{ \"y\" if n > 2 else \"n\" }}", &bag).unwrap(), "y");
		assert_eq!(render("{{ missing or s }}", &bag).unwrap(), "well");
		assert_eq!(render("{{ n and s }}", &bag).unwrap(), "well");
		assert_eq!(render("{{ not n }}", &bag).unwrap(), "false");
		assert_eq!(render("{{ items[1] }}{{ m[\"k\"] }}", &bag).unwrap(), "b1");
	}

	#[test]
	fn iterating_a_non_collection_is_a_type_error() {
		let bag = props(&[("n", Value::Int(3))]);
		assert!(matches!(
			render("{% for x in n %}{{ x }}{% endfor %}", &bag).unwrap_err(),
			Error::Type { kind: TypeErrorKind::NotIterable, .. }
		));
	}

	#[test]
	fn raw_blocks_pass_delimiters_through() {
		let bag = Props::new();
		assert_eq!(
			render("a\n{% raw %}\n{{ literal }} {% kept %}\n{% endraw %}\nb", &bag).unwrap(),
			"a\n{{ literal }} {% kept %}\nb"
		);
	}

	#[test]
	fn default_filter_accepts_missing_and_none() {
		let bag = props(&[("v", Value::None)]);
		assert_eq!(render("{{ missing | default(\"x\") }}", &bag).unwrap(), "x");
		assert_eq!(render("{{ v | default(\"x\") }}", &bag).unwrap(), "x");
		// Any other filter rejects missing input.
		assert!(matches!(
			render("{{ missing | trim }}", &bag).unwrap_err(),
			Error::UndefinedKey { .. }
		));
	}

	#[test]
	fn unknown_helpers_fail_at_compile_time() {
		let engine = Engine::new();
		assert!(matches!(engine.compile("test", "{{ x | nope }}").unwrap_err(), Error::Type {
			kind: TypeErrorKind::UnknownFilter,
			..
		}));
		assert!(matches!(engine.compile("test", "{{ nope(1) }}").unwrap_err(), Error::Type {
			kind: TypeErrorKind::UnknownFunction,
			..
		}));
		assert!(matches!(
			engine
				.compile("test", "{% nope %}x{% endnope %}")
				.unwrap_err(),
			Error::Type { kind: TypeErrorKind::UnknownBlock, .. }
		));
	}

	#[test]
	fn syntax_errors_carry_spans() {
		let engine = Engine::new();
		assert!(matches!(engine.compile("test", "{% if x %}y").unwrap_err(), Error::Syntax {
			kind: crate::SyntaxErrorKind::UnclosedBlock,
			..
		}));
		assert!(matches!(engine.compile("test", "{% endif %}").unwrap_err(), Error::Syntax {
			kind: crate::SyntaxErrorKind::StrayEnd,
			..
		}));
		assert!(matches!(engine.compile("test", "{{ a b }}").unwrap_err(), Error::Syntax {
			kind: crate::SyntaxErrorKind::UnexpectedToken,
			line: 1,
			..
		}));
		assert!(matches!(engine.compile("test", "{{ a").unwrap_err(), Error::Syntax {
			kind: crate::SyntaxErrorKind::UnclosedTag,
			..
		}));
	}

	#[test]
	fn referenced_keys_exclude_bound_names() {
		let engine = Engine::new();
		let template = engine
			.compile(
				"test",
				"{{ alpha.deep }}{% for x in items %}{{ x }}{{ loop.first }}{{ beta }}{% endfor %}{% \
				 set y = alpha %}{{ y }}",
			)
			.unwrap();
		let keys: Vec<&str> = template.referenced_keys().collect();
		assert_eq!(keys, ["alpha", "beta", "items"]);
	}

	#[test]
	fn blocks_render_bodies_through_helpers() {
		let bag = props(&[("lang", Value::from("rs")), ("body", Value::from("fn main() {}"))]);
		assert_eq!(
			render("{% codeblock lang %}\n{{ body }}\n{% endcodeblock %}", &bag).unwrap(),
			"```rs\nfn main() {}\n```"
		);
		assert_eq!(render("{% xml \"note\" %}hi{% endxml %}", &bag).unwrap(), "<note>\nhi\n</note>");
		// Empty trimmed body elides the wrapper entirely.
		assert_eq!(render("{% xml \"note\" %}  {% endxml %}", &bag).unwrap(), "");
	}

	#[test]
	fn rendering_is_deterministic_across_calls() {
		let engine = Engine::new();
		let template = engine
			.compile("test", "{% for pair in m %}{{ pair[0] }}{% endfor %}")
			.unwrap();
		let bag = props(&[("m", map! { "c" => 1, "a" => 2, "b" => 3 })]);
		let first = template.render_str(&engine, &bag).unwrap();
		let second = template.render_str(&engine, &bag).unwrap();
		assert_eq!(first, "abc");
		assert_eq!(first, second);
	}
	#[test]
	fn compile_owned_retains_runtime_source() {
		let engine = Engine::new();
		let source = String::from("hello {{ name }}");
		let template = engine
			.compile_owned(Str::new("runtime"), &source)
			.expect("owned template");
		drop(source);
		let bag = props(&[("name", Value::from("Ada"))]);
		assert_eq!(template.render_str(&engine, &bag).unwrap(), "hello Ada");
	}
}
