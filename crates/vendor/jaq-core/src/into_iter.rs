//! Functions and types for `IntoIterator` and `FnOnce() -> Iterator`.

#[derive(Clone)]
pub struct Delay<F>(F);

impl<I: Iterator, F: FnOnce() -> I> IntoIterator for Delay<F> {
    type Item = I::Item;
    type IntoIter = I;
    fn into_iter(self) -> Self::IntoIter {
        self.0()
    }
}

#[derive(Clone)]
pub enum Either<L, R> {
    L(L),
    R(R),
}

pub struct EitherIter<L, R>(Either<L, R>);

impl<L: Iterator, R: Iterator<Item = L::Item>> Iterator for EitherIter<L, R> {
    type Item = L::Item;
    fn next(&mut self) -> Option<Self::Item> {
        match &mut self.0 {
            Either::L(l) => l.next(),
            Either::R(r) => r.next(),
        }
    }
    fn size_hint(&self) -> (usize, Option<usize>) {
        match &self.0 {
            Either::L(l) => l.size_hint(),
            Either::R(r) => r.size_hint(),
        }
    }
}

impl<L: IntoIterator, R: IntoIterator<Item = L::Item>> IntoIterator for Either<L, R> {
    type Item = L::Item;
    type IntoIter = EitherIter<L::IntoIter, R::IntoIter>;
    fn into_iter(self) -> Self::IntoIter {
        EitherIter(match self {
            Self::L(l) => Either::L(l.into_iter()),
            Self::R(r) => Either::R(r.into_iter()),
        })
    }
}

pub fn collect_if_once<I: Iterator, F: FnOnce() -> I + Clone>(
    f: F,
) -> Either<core::iter::Once<I::Item>, Delay<F>> {
    let mut iter = f.clone()();
    if iter.size_hint().1 == Some(1) {
        if let Some(x) = iter.next() {
            assert!(iter.next().is_none());
            return Either::L(core::iter::once(x));
        }
    }
    Either::R(Delay(f))
}
