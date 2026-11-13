//! Combined file loading, lexing, and parsing for multiple modules,
//! as jq's linker (`src/linker.c`) does it.

pub mod konst;
pub mod lex;
pub mod parse;
mod tables;

use alloc::{string::String, vec::Vec};
pub use konst::Const;
pub use lex::Lexer;
pub use parse::Parser;
use parse::{Body, Def, Dep, Term};

#[cfg(feature = "std")]
extern crate std;

/// Storage for loaded modules.
pub type Arena = typed_arena::Arena<String>;

/// Contents `C` and path `P` of a (module) file.
///
/// This is useful for creating precise error messages.
#[derive(Clone, Debug, Default)]
pub struct File<C, P> {
    /// contents of the file
    pub code: C,
    /// path of the file
    pub path: P,
}

/// Information to resolve module/data imports.
pub struct Import<'a, P> {
    /// path of the module where the import/include directive appears
    pub parent: &'a P,
    /// whether the directive appears in the main program
    pub main: bool,
    /// relative path of the imported/included module, as given in the source
    pub path: &'a str,
    /// metadata attached to the import/include directive
    pub meta: &'a Option<Const>,
}

impl<C, P> File<C, P> {
    /// Apply a function to the contents of a file.
    pub fn map_code<C2>(self, f: impl Fn(C) -> C2) -> File<C2, P> {
        File {
            code: f(self.code),
            path: self.path,
        }
    }

    /// Apply a function to the path of a file.
    pub fn map_path<P2>(self, f: impl Fn(P) -> P2) -> File<C, P2> {
        File {
            code: self.code,
            path: f(self.path),
        }
    }
}

/// Name of a module file as jq reports it, in `$__loc__` and in error messages.
pub trait FileName {
    /// The name.
    fn file_name(&self) -> String;
}

#[cfg(feature = "std")]
impl FileName for std::path::PathBuf {
    fn file_name(&self) -> String {
        self.to_string_lossy().into_owned()
    }
}

impl FileName for () {
    fn file_name(&self) -> String {
        String::new()
    }
}

/// Error occurring during loading of a single module.
#[derive(Debug)]
pub enum Error<S> {
    /// errors that jq reports without location, such as `module not found: x`;
    /// the string is the location of the directive in the source
    Io(Vec<(S, String)>),
    /// syntax errors and other errors that jq reports while parsing
    Parse(Vec<parse::Error>),
}

type Vars<S> = Vec<(String, S, Option<Const>)>;

/// Module containing strings `S` and a body `B`.
#[derive(Default)]
pub struct Module<S, B = Vec<Def<S>>> {
    /// included and imported modules, in source order
    ///
    /// Suppose that we have [`Modules`] `mods` and the current [`Module`] is `mods[id]`.
    /// Then for every `(id_, name)` in `mods[id].mods`, we have that
    /// the included/imported module is stored in `mods[id_]` (`id_ < id`), and
    /// the module is included if `name` is `None` and imported if `name` is `Some(name)`.
    pub(crate) mods: Vec<(usize, Option<S>)>,
    /// imported data, storing path, name (always starts with `$`), and metadata
    pub(crate) vars: Vars<S>,
    /// everything that comes after metadata and includes/imports
    pub(crate) body: B,
}

/// Tree of modules containing definitions, and a main module.
pub struct Modules<S, P> {
    pub(crate) deps: Vec<(File<S, P>, Module<S>)>,
    pub(crate) main: (File<S, P>, Module<S, Term<S>>),
}

impl<S, P> Modules<S, P> {
    pub(crate) fn file_vars(&self) -> impl Iterator<Item = (&File<S, P>, &Vars<S>)> {
        let mod_vars = self.deps.iter().map(|(file, module)| (file, &module.vars));
        mod_vars.chain([(&self.main.0, &self.main.1.vars)])
    }
}

/// Errors occurring during loading of multiple modules, in the order jq reports them.
pub type Errors<S, P, E = Error<S>> = Vec<(File<S, P>, E)>;

type ReadResult<P> = Result<File<String, P>, String>;
type ReadFn<P> = fn(Import<P>) -> ReadResult<P>;

/// Combined file loader, lexer, and parser for multiple modules.
pub struct Loader<S, P, R> {
    /// loaded modules, `None` if they failed to load
    mods: Vec<(File<S, P>, Option<Module<S>>)>,
    /// function to read module file contents
    read: R,
    /// modules whose dependencies are being processed, to detect cycles
    open: Vec<P>,
    /// implicit include of the main program, such as `~/.jq`
    implicit: Option<Dep<S>>,
    errs: Errors<S, P>,
}

impl<'s, P: Default> Loader<&'s str, P, ReadFn<P>> {
    /// Initialise the loader with prelude definitions.
    ///
    /// The prelude is a special module that is implicitly included by all other modules
    /// (including the main module).
    pub fn new(prelude: impl IntoIterator<Item = Def<&'s str>>) -> Self {
        let defs = [Def::new("!empty", Vec::new(), Term::empty())];

        let prelude = Module {
            body: defs.into_iter().chain(prelude).collect(),
            ..Module::default()
        };

        Self {
            mods: Vec::from([(File::default(), Some(prelude))]),
            read: |_| Err("module loading not supported".into()),
            open: Vec::new(),
            implicit: None,
            errs: Vec::new(),
        }
    }
}

/// Apply function to every imported data file, accumulating errors.
pub fn import<S: Copy, P: Clone>(
    mods: &Modules<S, P>,
    mut f: impl FnMut(Import<P>) -> Result<(), String>,
) -> Result<(), Errors<S, P>> {
    let mut errs = Vec::new();
    let main = &mods.main.0 as *const File<S, P>;
    for (mod_file, vars) in mods.file_vars() {
        let mut mod_errs = Vec::new();
        for (path, name, meta) in vars {
            let parent = &mod_file.path;
            let import = Import { parent, main: core::ptr::eq(mod_file, main), path, meta };
            if let Err(e) = f(import) {
                mod_errs.push((*name, e));
            }
        }
        if !mod_errs.is_empty() {
            errs.push((mod_file.clone(), Error::Io(mod_errs)));
        }
    }
    errs.is_empty().then_some(()).ok_or(errs)
}

impl<S, P, R> Loader<S, P, R> {
    /// Provide a function to return the contents of included/imported module files.
    pub fn with_read<R2>(self, read: R2) -> Loader<S, P, R2> {
        let Self { mods, open, implicit, errs, .. } = self;
        Loader { mods, read, open, implicit, errs }
    }
}

impl<'s, P, R> Loader<&'s str, P, R> {
    /// Include a module implicitly in the main program, before its own directives;
    /// the metadata `{optional: true}` makes it fail silently.
    pub fn with_implicit_include(self, path: &'s str, meta: Const) -> Self {
        let dep = Dep { path: path.into(), path_span: &path[..0], name: None, meta: Some(meta) };
        Self { implicit: Some(dep), ..self }
    }
}

fn is_optional(meta: &Option<Const>) -> bool {
    matches!(meta.as_ref().and_then(|m| m.get("optional")), Some(Const::Bool(true)))
}

impl<'s, P: Clone + Eq + FileName, R: FnMut(Import<P>) -> ReadResult<P>> Loader<&'s str, P, R> {
    /// Load a set of modules, starting from a given file.
    pub fn load(
        mut self,
        arena: &'s Arena,
        file: File<&'s str, P>,
    ) -> Result<Modules<&'s str, P>, Errors<&'s str, P>> {
        let m = match parse::parse_module(file.code, "<top-level>", false) {
            Ok(m) => m,
            Err(e) => return Err(Vec::from([(file, Error::Parse(e))])),
        };
        let Body::Main(body) = m.body else {
            let msg = "Top-level program not given (try \".\")";
            return Err(Vec::from([(file, Error::Parse(Vec::from([(msg.into(), None)])))]));
        };
        let deps = self.implicit.take().into_iter().chain(m.deps).collect();
        let main = self.deps(arena, &file, true, deps).map(|(mods, vars)| Module { mods, vars, body });
        match main {
            Some(main) if self.errs.is_empty() => {
                let deps = self.mods.into_iter().map(|(f, m)| (f, m.unwrap_or_default()));
                Ok(Modules { deps: deps.collect(), main: (file, main) })
            }
            _ => Err(self.errs),
        }
    }

    /// Process the dependencies of a module, as `process_dependencies`:
    /// in reverse order, stopping at the first one that cannot be found.
    #[allow(clippy::type_complexity)]
    fn deps(
        &mut self,
        arena: &'s Arena,
        file: &File<&'s str, P>,
        main: bool,
        deps: Vec<Dep<&'s str>>,
    ) -> Option<(Vec<(usize, Option<&'s str>)>, Vars<&'s str>)> {
        // the prelude module is included implicitly in every module
        let mut mods = Vec::new();
        let mut vars = Vec::new();
        for dep in deps.into_iter().rev() {
            match dep.name {
                Some(x) if x.starts_with('$') => vars.push((dep.path, x, dep.meta)),
                name => {
                    let import = Import { parent: &file.path, main, path: &dep.path, meta: &dep.meta };
                    match self.find(arena, import) {
                        Ok(Some(mid)) => mods.push((mid, name)),
                        Ok(None) => {}
                        Err(e) if is_optional(&dep.meta) => drop(e),
                        Err(e) => {
                            let err = Error::Io(Vec::from([(dep.path_span, e)]));
                            self.errs.push((file.clone(), err));
                            return None;
                        }
                    }
                }
            }
        }
        mods.push((0, None));
        mods.reverse();
        vars.reverse();
        Some((mods, vars))
    }

    /// Load a module, returning its index if it loaded without errors.
    fn find(&mut self, arena: &'s Arena, import: Import<P>) -> Result<Option<usize>, String> {
        let file = (self.read)(import)?;

        if self.open.contains(&file.path) {
            return Err(alloc::format!("circular import of {}", file.path.file_name()));
        }
        if let Some(id) = self.mods.iter().position(|(file_, _)| file.path == file_.path) {
            return Ok(self.mods[id].1.is_some().then_some(id));
        }

        let code = &**arena.alloc(file.code);
        let file = File { path: file.path, code };
        let fname = &**arena.alloc(file.path.file_name());
        let m = match parse::parse_module(code, fname, false) {
            Ok(m) => m,
            Err(e) => {
                self.errs.push((file, Error::Parse(e)));
                return Ok(None);
            }
        };
        let Body::Defs(body) = m.body else {
            let msg = "jq: error: library should only have function definitions, not a main expression";
            self.errs.push((file, Error::Parse(Vec::from([(msg.into(), None)]))));
            return Ok(None);
        };

        // a module is stored after the modules it depends on, which are compiled first
        self.open.push(file.path.clone());
        let deps = self.deps(arena, &file, false, m.deps);
        self.open.pop();
        let module = deps.map(|(mods, vars)| Module { mods, vars, body });
        let ok = module.is_some();
        let id = self.mods.len();
        self.mods.push((file, module));
        Ok(ok.then_some(id))
    }
}

/// Metadata, imports, and definitions of a module, as jq's `modulemeta` reports them.
#[derive(Debug)]
pub struct ModuleMeta<'s> {
    /// metadata object of the `module` directive
    pub meta: Option<Const>,
    /// imports and includes, in source order
    pub deps: Vec<Dep<&'s str>>,
    /// top-level definitions as `name/arity`, without duplicates, in order of definition
    pub defs: Vec<String>,
}

/// Parse a module to obtain what `modulemeta` reports, or jq's parse errors.
pub fn module_meta<'s>(code: &'s str, fname: &'s str) -> Result<ModuleMeta<'s>, Vec<parse::Error>> {
    let m = parse::parse_module(code, fname, false)?;
    let Body::Defs(body) = m.body else {
        let msg = "jq: error: library should only have function definitions, not a main expression";
        return Err(Vec::from([(msg.into(), None)]));
    };
    let mut defs: Vec<String> = Vec::new();
    for d in body {
        let name = alloc::format!("{}/{}", d.name, d.args.len());
        if !defs.contains(&name) {
            defs.push(name);
        }
    }
    Ok(ModuleMeta { meta: m.meta, deps: m.deps, defs })
}

/// Lex a string and parse resulting tokens, returning [`None`] if any error occurred.
///
/// Example:
///
/// ~~~
/// # use jaq_core::load::parse;
/// let t = parse("[] | .[]", |p| p.term());
/// ~~~
pub fn parse<'s, T: Default, F>(s: &'s str, f: F) -> Option<T>
where
    F: for<'t> FnOnce(&mut Parser<'s, 't>) -> parse::Result<'s, 't, T>,
{
    Parser::new(s).parse(f).ok()
}

/// Return the span of a string slice `part` relative to a string slice `whole`.
///
/// The caller must ensure that `part` is fully contained inside `whole`.
pub fn span(whole: &str, part: &str) -> core::ops::Range<usize> {
    let start = part.as_ptr() as usize - whole.as_ptr() as usize;
    start..start + part.len()
}
