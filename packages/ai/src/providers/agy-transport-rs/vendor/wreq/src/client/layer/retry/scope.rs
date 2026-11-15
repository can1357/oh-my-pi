use std::sync::Arc;

use super::Req;

pub trait Scope: Send + Sync + 'static {
    fn applies_to(&self, req: &super::Req) -> bool;
}

// I think scopes likely make the most sense being to hosts.
// If that's the case, then it should probably be easiest to check for
// the host. Perhaps also considering the ability to add more things
// to scope off in the future...

// For Future Whoever: making a blanket impl for any closure sounds nice,
// but it causes inference issues at the call site. Every closure would
// need to include `: ReqRep` in the arguments.
//
// An alternative is to make things like `ScopeFn`. Slightly more annoying,
// but also more forwards-compatible. :shrug:

pub struct ScopeFn<F>(pub(crate) F);

impl<F> Scope for ScopeFn<F>
where
    F: Fn(&Req) -> bool + Send + Sync + 'static,
{
    fn applies_to(&self, req: &Req) -> bool {
        (self.0)(req)
    }
}

/// Defines the scope of requests that are eligible for retry.
#[derive(Clone)]
pub(crate) enum Scoped {
    /// All requests are eligible for retry regardless of their properties.
    Unscoped,
    /// Use custom logic to determine if a request is eligible for retry.
    Dyn(Arc<dyn Scope>),
}

impl Scoped {
    /// Checks if the given request falls within the retry scope.
    pub(super) fn applies_to(&self, req: &super::Req) -> bool {
        let ret = match self {
            Scoped::Unscoped => true,
            Scoped::Dyn(s) => s.applies_to(req),
        };
        trace!("retry in scope: {ret}");
        ret
    }
}
