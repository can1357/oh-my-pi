// Copyright 2017 The BoringSSL Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

#ifndef OPENSSL_HEADER_SSL_SPAN_H
#define OPENSSL_HEADER_SSL_SPAN_H

#include <openssl/base.h>   // IWYU pragma: export

#if !defined(BORINGSSL_NO_CXX)

extern "C++" {

#include <stdlib.h>

#include <algorithm>
#include <limits>
#include <string_view>
#include <type_traits>

#if __has_include(<version>)
#include <version>
#endif

#if defined(__cpp_lib_ranges) && __cpp_lib_ranges >= 201911L
#include <ranges>
#endif

BSSL_NAMESPACE_BEGIN
inline constexpr size_t dynamic_extent = std::numeric_limits<size_t>::max();

template <typename T, size_t N = dynamic_extent>
class Span;
BSSL_NAMESPACE_END

#if defined(__cpp_lib_ranges) && __cpp_lib_ranges >= 201911L
// Mark `Span` as satisfying the `view` and `borrowed_range` concepts. This
// should be done before the definition of `Span`, so that any inlined calls to
// range functionality use the correct specializations.
template <typename T, size_t N>
inline constexpr bool std::ranges::enable_view<bssl::Span<T, N>> = true;
template <typename T, size_t N>
inline constexpr bool std::ranges::enable_borrowed_range<bssl::Span<T, N>> =
    true;
#endif

BSSL_NAMESPACE_BEGIN

namespace internal {
template <typename T>
class SpanBase {
  // Put comparison operator implementations into a base class with const T, so
  // they can be used with any type that implicitly converts into a Span.
  static_assert(std::is_const<T>::value,
                "Span<T> must be derived from SpanBase<const T>");

  friend bool operator==(Span<T> lhs, Span<T> rhs) {
    return std::equal(lhs.begin(), lhs.end(), rhs.begin(), rhs.end());
  }

  friend bool operator!=(Span<T> lhs, Span<T> rhs) { return !(lhs == rhs); }
};

// Container class to store the size of a span at runtime or compile time.
template <typename T, size_t N>
class SpanStorage : private SpanBase<const T> {
 public:
  constexpr SpanStorage(T *data, size_t size) : data_(data) {
    BSSL_CHECK(size == N);
  }
  constexpr T *data() const { return data_; }
  constexpr size_t size() const { return N; }

 private:
  T *data_;
};

template <typename T>
class SpanStorage<T, dynamic_extent> : private SpanBase<const T> {
 public:
  constexpr SpanStorage(T *data, size_t size) : data_(data), size_(size) {}
  constexpr T *data() const { return data_; }
  constexpr size_t size() const { return size_; }

 private:
  T *data_;
  size_t size_;
};

// Heuristically test whether C is a container type that can be converted into
// a Span<T> by checking for data() and size() member functions.
template <typename C, typename T>
using EnableIfContainer = std::enable_if_t<
    std::is_convertible_v<decltype(std::declval<C>().data()), T *> &&
    std::is_integral_v<decltype(std::declval<C>().size())>>;

// A fake type used to be able to SFINAE between two different container
// constructors - by giving one this as a second default argument, and one not.
struct AllowRedeclaringConstructor {};

}  // namespace internal

// A Span<T> is a non-owning reference to a contiguous array of objects of type
// |T|. Conceptually, a Span is a simple a pointer to |T| and a count of
// elements accessible via that pointer. The elements referenced by the Span can
// be mutated if |T| is mutable.
//
// A Span can be constructed from container types implementing |data()| and
// |size()| methods. If |T| is constant, construction from a container type is
// implicit. This allows writing methods that accept data from some unspecified
// container type:
//
// // Foo views data referenced by v.
// void Foo(bssl::Span<const uint8_t> v) { ... }
//
// std::vector<uint8_t> vec;
// Foo(vec);
//
// For mutable Spans, conversion is explicit:
//
// // FooMutate mutates data referenced by v.
// void FooMutate(bssl::Span<uint8_t> v) { ... }
//
// FooMutate(bssl::Span<uint8_t>(vec));
//
// You can also use C++17 class template argument deduction to construct Spans
// in order to deduce the type of the Span automatically.
//
// FooMutate(bssl::Span(vec));
//
// Note that Spans have value type semantics. They are cheap to construct and
// copy, and should be passed by value whenever a method would otherwise accept
// a reference or pointer to a container or array.
template <typename T, size_t N>
class Span : public internal::SpanStorage<T, N> {
 public:
  using element_type = T;
  using value_type = std::remove_cv_t<T>;
  using size_type = size_t;
  using difference_type = ptrdiff_t;
  using pointer = T *;
  using const_pointer = const T *;
  using reference = T &;
  using const_reference = const T &;
  using iterator = T *;
  using const_iterator = const T *;

  template <typename U = T,
            typename = std::enable_if_t<N == 0 || N == dynamic_extent, U>>
  constexpr Span() : internal::SpanStorage<T, N>(nullptr, 0) {}

  // NOTE: This constructor may abort() at runtime if len differs from the
  // compile-time size, if any.
  constexpr Span(T *ptr, size_t len) : internal::SpanStorage<T, N>(ptr, len) {}

  template <size_t NA,
            typename = std::enable_if_t<N == NA || N == dynamic_extent>>
  // NOLINTNEXTLINE(google-explicit-constructor): same as std::span.
  constexpr Span(T (&array)[NA]) : internal::SpanStorage<T, N>(array, NA) {}

  // TODO(crbug.com/457351017): Add tests for these c'tors.
  template <size_t NA, typename U,
            typename = internal::EnableIfContainer<std::array<U, NA>, T>,
            typename = std::enable_if_t<N == NA || N == dynamic_extent>>
  // NOLINTNEXTLINE(google-explicit-constructor): same as std::span.
  constexpr Span(std::array<U, NA> &array)
      : internal::SpanStorage<T, N>(array.data(), NA) {}

  template <size_t NA, typename U,
            typename = internal::EnableIfContainer<const std::array<U, NA>, T>,
            typename = std::enable_if_t<N == NA || N == dynamic_extent>>
  // NOLINTNEXTLINE(google-explicit-constructor): same as std::span.
  constexpr Span(const std::array<U, NA> &array)
      : internal::SpanStorage<T, N>(array.data(), NA) {}

  template <
      size_t NA, typename U,
      typename = std::enable_if_t<std::is_convertible_v<U (*)[], T (*)[]>>,
      typename = std::enable_if_t<N == dynamic_extent || N == NA>>
  // NOLINTNEXTLINE(google-explicit-constructor): same as std::span.
  constexpr Span(Span<U, NA> other)
      : internal::SpanStorage<T, N>(other.data(), other.size()) {}

  template <typename C, typename = internal::EnableIfContainer<C, T>,
            typename = std::enable_if_t<std::is_const<T>::value, C>,
            typename = std::enable_if_t<N == dynamic_extent, C>>
  // NOLINTNEXTLINE(google-explicit-constructor): same as std::span.
  constexpr Span(const C &container)
      : internal::SpanStorage<T, N>(container.data(), container.size()) {}

  // NOTE: This constructor may abort() at runtime if the container's length
  // differs from the compile-time size, if any.
  template <typename C, typename = internal::EnableIfContainer<C, T>,
            typename = std::enable_if_t<std::is_const<T>::value, C>,
            typename = std::enable_if_t<N != dynamic_extent, C>>
  constexpr explicit Span(const C &container,
                          internal::AllowRedeclaringConstructor = {})
      : internal::SpanStorage<T, N>(container.data(), container.size()) {}

  // NOTE: This constructor may abort() at runtime if the container's length
  // differs from the compile-time size, if any.
  template <typename C, typename = internal::EnableIfContainer<C, T>,
            typename = std::enable_if_t<!std::is_const<T>::value, C>>
  constexpr explicit Span(C &container)
      : internal::SpanStorage<T, N>(container.data(), container.size()) {}

  using internal::SpanStorage<T, N>::data;
  using internal::SpanStorage<T, N>::size;
  constexpr bool empty() const { return size() == 0; }

  constexpr iterator begin() const { return data(); }
  constexpr const_iterator cbegin() const { return data(); }
  constexpr iterator end() const { return data() + size(); }
  constexpr const_iterator cend() const { return end(); }

  constexpr T &front() const {
    BSSL_CHECK(size() != 0);
    return data()[0];
  }
  constexpr T &back() const {
    BSSL_CHECK(size() != 0);
    return data()[size() - 1];
  }

  constexpr T &operator[](size_t i) const {
    BSSL_CHECK(i < size());
    return data()[i];
  }
  T &at(size_t i) const { return (*this)[i]; }

 private:
  static constexpr size_t SubspanOutLen(size_t size, size_t pos, size_t len) {
    // NOTE: This differs from std::span's subspan length in that this one
    // performs clipping.
    //
    // For std::span, this would be:
    //
    // len != dynamic_extent ? len : size - pos
    return std::min(size - pos, len);
  }
  static constexpr size_t SubspanTypeOutLen(size_t size, size_t pos,
                                            size_t len) {
    // NOTE: This differs from std::span's subspan length in that this one
    // performs clipping, and thus has to return dynamic extent whenever the
    // input span has dynamic extent.
    //
    // For std::span, this would be:
    //
    // len != dynamic_extent
    //   ? len
    //   : (size != dynamic_extent ? size - pos : dynamic_extent)
    if (size == dynamic_extent) {
      return dynamic_extent;
    }
    return SubspanOutLen(size, pos, len);
  }

 public:
  // NOTE: This method may abort() at runtime if pos is out of range.
  constexpr Span<T> subspan(size_t pos = 0, size_t len = dynamic_extent) const {
    // absl::Span throws an exception here. Note std::span and Chromium
    // base::span additionally forbid pos + len being out of range, with a
    // special case at npos/dynamic_extent, while absl::Span::subspan clips
    // the span. For now, we align with absl::Span in case we switch to it in
    // the future.
    BSSL_CHECK(pos <= size());
    return Span<T>(data() + pos, SubspanOutLen(size(), pos, len));
  }

  // NOTE: This method may abort() at runtime if len is out of range.
  template <size_t pos, size_t len = dynamic_extent>
  constexpr Span<T, SubspanTypeOutLen(N, pos, len)> subspan() const {
    // absl::Span throws an exception here. Note std::span and Chromium
    // base::span additionally forbid pos + len being out of range, with a
    // special case at npos/dynamic_extent, while absl::Span::subspan clips
    // the span. For now, we align with absl::Span in case we switch to it in
    // the future.
    //
    // Removing clipping however will allow making the return type have a
    // static extent whenever len is static, which matches std::span and
    // could improve efficiency.
    BSSL_CHECK(pos <= size());
    return Span<T, SubspanTypeOutLen(N, pos, len)>(data() + pos,
                                                   std::min(size() - pos, len));
  }

  // NOTE: This method may abort() at runtime if len is out of range.
  constexpr Span<T> first(size_t len) const {
    BSSL_CHECK(len <= size());
    return Span<T>(data(), len);
  }

  // NOTE: This method may abort() at runtime if len is out of range.
  template <size_t len>
  constexpr Span<T, len> first() const {
    BSSL_CHECK(len <= size());
    return Span<T, len>(data(), len);
  }

  // NOTE: This method may abort() at runtime if len is out of range.
  constexpr Span<T> last(size_t len) const {
    BSSL_CHECK(len <= size());
    return Span<T>(data() + size() - len, len);
  }

  // NOTE: This method may abort() at runtime if len is out of range.
  template <size_t len>
  constexpr Span<T, len> last() const {
    BSSL_CHECK(len <= size());
    return Span<T, len>(data() + size() - len, len);
  }
};

template <typename T>
Span(T *, size_t) -> Span<T>;
template <typename T, size_t size>
Span(T (&array)[size]) -> Span<T, size>;
template <typename T, size_t size>
Span(std::array<T, size> &array) -> Span<T, size>;
template <typename T, size_t size>
Span(const std::array<T, size> &array) -> Span<const T, size>;
template <
    typename C,
    typename T = std::remove_pointer_t<decltype(std::declval<C>().data())>,
    typename = internal::EnableIfContainer<C, T>>
Span(C &) -> Span<T>;

template <typename T>
constexpr Span<T> MakeSpan(T *ptr, size_t size) {
  return Span<T>(ptr, size);
}

template <typename C>
constexpr auto MakeSpan(C &c) -> decltype(MakeSpan(c.data(), c.size())) {
  return MakeSpan(c.data(), c.size());
}

template <typename T, size_t N>
constexpr Span<T, N> MakeSpan(T (&array)[N]) {
  return array;
}

template <typename T>
constexpr Span<const T> MakeConstSpan(T *ptr, size_t size) {
  return Span<const T>(ptr, size);
}

template <typename C>
constexpr auto MakeConstSpan(const C &c)
    -> decltype(MakeConstSpan(c.data(), c.size())) {
  return MakeConstSpan(c.data(), c.size());
}

template <typename T, size_t size>
constexpr Span<const T, size> MakeConstSpan(T (&array)[size]) {
  return array;
}

inline Span<const uint8_t> StringAsBytes(std::string_view s) {
  return MakeConstSpan(reinterpret_cast<const uint8_t *>(s.data()), s.size());
}

inline std::string_view BytesAsStringView(bssl::Span<const uint8_t> b) {
  return std::string_view(reinterpret_cast<const char *>(b.data()), b.size());
}

BSSL_NAMESPACE_END

}  // extern C++

#endif  // !defined(BORINGSSL_NO_CXX)

#endif  // OPENSSL_HEADER_SSL_SPAN_H
