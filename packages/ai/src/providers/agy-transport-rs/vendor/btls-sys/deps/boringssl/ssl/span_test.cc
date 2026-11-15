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

#include <stdio.h>
#include <vector>

#include <gtest/gtest.h>

#include <openssl/ssl.h>

BSSL_NAMESPACE_BEGIN
namespace {

template <size_t N>
static void TestCtor(Span<int, N> s, const int *ptr, size_t size) {
  EXPECT_EQ(s.data(), ptr);
  EXPECT_EQ(s.size(), size);
}

template <size_t N>
static void TestConstCtor(Span<const int, N> s, const int *ptr, size_t size) {
  EXPECT_EQ(s.data(), ptr);
  EXPECT_EQ(s.size(), size);
}

template <class T, size_t N>
constexpr static bool IsRuntimeSized(Span<T, N>) {
  return N == dynamic_extent;
}

TEST(SpanTest, CompileTimeSizes) {
  static_assert(sizeof(Span<int, 4>) == sizeof(int *));
  static_assert(sizeof(Span<int>) == sizeof(std::pair<int *, size_t>));
}

TEST(SpanTest, CtorEmpty) {
  Span<int> s;
  TestCtor(s, nullptr, 0);
}

TEST(SpanTest, CtorEmptyCompileTIme) {
  Span<int, 0> s;
  TestCtor(s, nullptr, 0);
}

TEST(SpanTest, CtorFromPtrAndSize) {
  std::vector<int> v = {7, 8, 9, 10};
  Span<int> s(v.data(), v.size());
  TestCtor(s, v.data(), v.size());
  TestConstCtor<dynamic_extent>(Span<int>(v.data(), v.size()), v.data(),
                                v.size());
}

TEST(SpanTest, CtorFromPtrAndSizeCompileTime) {
  std::vector<int> v = {7, 8, 9, 10};
  Span<int, 4> s(v.data(), v.size());
  TestCtor(s, v.data(), v.size());
  TestConstCtor<4>(Span<int, 4>(v.data(), v.size()), v.data(), v.size());
}

TEST(SpanTest, ConstCtorFromVector) {
  std::vector<int> v = {1, 2};
  // Const ctor is implicit.
  TestConstCtor<dynamic_extent>(v, v.data(), v.size());
}

TEST(SpanTest, ConstCtorFromVectorCompileTime) {
  std::vector<int> v = {1, 2};
  // Static extent constructor can only be invoked explicitly.
  TestConstCtor<2>(Span<const int, 2>(v), v.data(), v.size());
}

TEST(SpanTest, CtorFromVector) {
  std::vector<int> v = {1, 2};
  // Mutable is explicit.
  Span<int> s(v);
  TestCtor(s, v.data(), v.size());
}

TEST(SpanTest, CtorFromVectorCompileTime) {
  std::vector<int> v = {1, 2};
  // Mutable is explicit.
  Span<int, 2> s(v);
  TestCtor(s, v.data(), v.size());
}

TEST(SpanTest, CtorConstFromArray) {
  int v[] = {10, 11};
  // Array ctor is implicit for const and mutable T.
  TestConstCtor<dynamic_extent>(v, v, 2);
  TestCtor<dynamic_extent>(v, v, 2);
}

TEST(SpanTest, CtorConstFromArrayCompileTime) {
  int v[] = {10, 11};
  // Array ctor is implicit for const and mutable T.
  TestConstCtor<2>(v, v, 2);
  TestCtor<2>(v, v, 2);
}

TEST(SpanTest, Compare) {
  int v[] = {10, 11};
  int w[] = {10, 11};
  int x[] = {11, 10, 11};
  Span<int> sv = v;
  Span<int> sw = w;
  Span<int> sx = x;
  EXPECT_TRUE(sv == sw);
  EXPECT_FALSE(sv != sw);
  EXPECT_FALSE(sv == sx);
  EXPECT_TRUE(sv != sx);
}

TEST(SpanTest, CompareCompileTime) {
  int v[] = {10, 11};
  int w[] = {10, 11};
  int x[] = {11, 10, 11};
  Span<int, 2> sv = v;
  Span<int, 2> sw = w;
  Span<int, 3> sx = x;
  EXPECT_TRUE(sv == sw);
  EXPECT_FALSE(sv != sw);
  EXPECT_FALSE(sv == sx);
  EXPECT_TRUE(sv != sx);
}

TEST(SpanTest, MakeSpan) {
  std::vector<int> v = {100, 200, 300};
  EXPECT_TRUE(IsRuntimeSized(MakeSpan(v)));
  TestCtor(MakeSpan(v), v.data(), v.size());
  TestCtor(MakeSpan(v.data(), v.size()), v.data(), v.size());
  TestConstCtor<dynamic_extent>(MakeSpan(v.data(), v.size()), v.data(),
                                v.size());
  TestConstCtor<dynamic_extent>(MakeSpan(v), v.data(), v.size());
}

TEST(SpanTest, MakeSpanCompileTime) {
  int v[3] = {100, 200, 300};
  EXPECT_FALSE(IsRuntimeSized(MakeSpan(v)));
  TestCtor(MakeSpan(v), v, 3);
  TestConstCtor<3>(MakeSpan(v), v, 3);
}

TEST(SpanTest, MakeConstSpan) {
  std::vector<int> v = {100, 200, 300};
  EXPECT_TRUE(IsRuntimeSized(MakeConstSpan(v)));
  TestConstCtor(MakeConstSpan(v), v.data(), v.size());
  TestConstCtor(MakeConstSpan(v.data(), v.size()), v.data(), v.size());
  // But not:
  // TestConstCtor(MakeSpan(v), v.data(), v.size());
}

TEST(SpanTest, MakeConstSpanCompileTime) {
  int v[3] = {100, 200, 300};
  EXPECT_FALSE(IsRuntimeSized(MakeConstSpan(v)));
  TestConstCtor(MakeConstSpan(v), v, 3);
  // But not:
  // TestConstCtor(MakeSpan(v), v.data(), v.size());
}

TEST(SpanTest, Accessor) {
  std::vector<int> v({42, 23, 5, 101, 80});
  Span<int> s(v);
  for (size_t i = 0; i < s.size(); ++i) {
    EXPECT_EQ(s[i], v[i]);
    EXPECT_EQ(s.at(i), v.at(i));
  }
  EXPECT_EQ(s.begin(), v.data());
  EXPECT_EQ(s.end(), v.data() + v.size());
}

TEST(SpanTest, AccessorCompiletime) {
  std::vector<int> v({42, 23, 5, 101, 80});
  Span<int, 5> s(v.data(), v.size());
  for (size_t i = 0; i < s.size(); ++i) {
    EXPECT_EQ(s[i], v[i]);
    EXPECT_EQ(s.at(i), v.at(i));
  }
  EXPECT_EQ(s.begin(), v.data());
  EXPECT_EQ(s.end(), v.data() + v.size());
}

TEST(SpanTest, ConstExpr) {
  static constexpr int v[] = {1, 2, 3, 4};
  constexpr bssl::Span<const int> span1(v);
  static_assert(span1.size() == 4u, "wrong size");
  static_assert(IsRuntimeSized(span1), "unexpectedly compile-time sized");
  constexpr bssl::Span<const int> span2 = MakeConstSpan(v);
  static_assert(span2.size() == 4u, "wrong size");
  static_assert(IsRuntimeSized(span2), "unexpectedly compile-time sized");
  static_assert(span2.subspan(1).size() == 3u, "wrong size");
  static_assert(IsRuntimeSized(span2.subspan(1)),
                "unexpectedly compile-time sized");
  static_assert(IsRuntimeSized(span2.subspan<1>()),
                "unexpectedly compile-time sized");
  static_assert(span2.first(1).size() == 1u, "wrong size");
  static_assert(IsRuntimeSized(span2.first(1)),
                "unexpectedly compile-time sized");
  static_assert(!IsRuntimeSized(span2.first<1>()),
                "unexpectedly runtime sized");
  static_assert(span2.last(1).size() == 1u, "wrong size");
  static_assert(IsRuntimeSized(span2.last(1)),
                "unexpectedly compile-time sized");
  static_assert(!IsRuntimeSized(span2.last<1>()), "unexpectedly runtime sized");
  static_assert(span2[0] == 1, "wrong value");
}

TEST(SpanTest, ConstExprCompileTime) {
  static constexpr int v[] = {1, 2, 3, 4};
  constexpr bssl::Span<const int, 4> span1(v);
  static_assert(span1.size() == 4u, "wrong size");
  static_assert(!IsRuntimeSized(span1), "unexpectedly runtime sized");
  constexpr bssl::Span<const int, 4> span2 = MakeConstSpan(v);
  static_assert(span2.size() == 4u, "wrong size");
  static_assert(!IsRuntimeSized(span2), "unexpectedly runtime sized");
  static_assert(span2.subspan(1).size() == 3u, "wrong size");
  static_assert(IsRuntimeSized(span2.subspan(1)),
                "unexpectedly compile-time sized");
  static_assert(!IsRuntimeSized(span2.subspan<1>()),
                "unexpectedly runtime sized");
  static_assert(span2.first(1).size() == 1u, "wrong size");
  static_assert(IsRuntimeSized(span2.first(1)),
                "unexpectedly compile-time sized");
  static_assert(!IsRuntimeSized(span2.first<1>()),
                "unexpectedly runtime sized");
  static_assert(span2.last(1).size() == 1u, "wrong size");
  static_assert(IsRuntimeSized(span2.last(1)),
                "unexpectedly compile-time sized");
  static_assert(!IsRuntimeSized(span2.last<1>()), "unexpectedly runtime sized");
  static_assert(span2[0] == 1, "wrong value");
}

TEST(SpanDeathTest, BoundsChecks) {
  // Make an array that's larger than we need, so that a failure to bounds check
  // won't crash.
  const int v[] = {1, 2, 3, 4};
  Span<const int> span(v, 3);
  // Out of bounds access.
  EXPECT_DEATH_IF_SUPPORTED(span[3], "");
  EXPECT_DEATH_IF_SUPPORTED(span.subspan(4), "");
  EXPECT_DEATH_IF_SUPPORTED(span.first(4), "");
  EXPECT_DEATH_IF_SUPPORTED(span.last(4), "");
  // Accessing an empty span.
  Span<const int> empty(v, 0);
  EXPECT_DEATH_IF_SUPPORTED(empty[0], "");
  EXPECT_DEATH_IF_SUPPORTED(empty.front(), "");
  EXPECT_DEATH_IF_SUPPORTED(empty.back(), "");
}

TEST(SpanDeathTest, BoundsChecksCompileTime) {
  // Make an array that's larger than we need, so that a failure to bounds check
  // won't crash.
  const int v[] = {1, 2, 3, 4};
  Span<const int, 3> span(v, 3);
  // Out of bounds access.
  EXPECT_DEATH_IF_SUPPORTED(span[3], "");
  EXPECT_DEATH_IF_SUPPORTED(span.subspan(4), "");
  EXPECT_DEATH_IF_SUPPORTED(span.first(4), "");
  EXPECT_DEATH_IF_SUPPORTED(span.last(4), "");
  // Accessing an empty span.
  Span<const int, 0> empty(v, 0);
  EXPECT_DEATH_IF_SUPPORTED(empty[0], "");
  EXPECT_DEATH_IF_SUPPORTED(empty.front(), "");
  EXPECT_DEATH_IF_SUPPORTED(empty.back(), "");
}

}  // namespace
BSSL_NAMESPACE_END
