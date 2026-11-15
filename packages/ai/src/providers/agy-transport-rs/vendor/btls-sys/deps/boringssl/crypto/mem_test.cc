// Copyright 2025 The BoringSSL Authors
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

#include <openssl/mem.h>

#include <memory>
#include <utility>
#include <vector>

#include <gtest/gtest.h>

#include "mem_internal.h"


#if !defined(BORINGSSL_SHARED_LIBRARY)
BSSL_NAMESPACE_BEGIN
namespace {

TEST(ArrayTest, Basic) {
  Array<int> array;
  EXPECT_TRUE(array.empty());
  EXPECT_EQ(array.size(), 0u);
  const int v[] = {1, 2, 3, 4};
  ASSERT_TRUE(array.CopyFrom(v));
  EXPECT_FALSE(array.empty());
  EXPECT_EQ(array.size(), 4u);
  EXPECT_EQ(array[0], 1);
  EXPECT_EQ(array[1], 2);
  EXPECT_EQ(array[2], 3);
  EXPECT_EQ(array[3], 4);
  EXPECT_EQ(array.front(), 1);
  EXPECT_EQ(array.back(), 4);
}

TEST(ArrayTest, InitValueConstructs) {
  Array<uint8_t> array;
  ASSERT_TRUE(array.Init(10));
  EXPECT_EQ(array.size(), 10u);
  for (size_t i = 0; i < 10u; i++) {
    EXPECT_EQ(0u, array[i]);
  }
}

TEST(ArrayDeathTest, BoundsChecks) {
  Array<int> array;
  EXPECT_DEATH_IF_SUPPORTED(array.front(), "");
  EXPECT_DEATH_IF_SUPPORTED(array.back(), "");
  const int v[] = {1, 2, 3, 4};
  ASSERT_TRUE(array.CopyFrom(v));
  EXPECT_DEATH_IF_SUPPORTED(array[4], "");
}

TEST(VectorTest, Resize) {
  Vector<size_t> vec;
  ASSERT_TRUE(vec.empty());
  EXPECT_EQ(vec.size(), 0u);

  ASSERT_TRUE(vec.Push(42));
  ASSERT_TRUE(!vec.empty());
  EXPECT_EQ(vec.size(), 1u);

  // Force a resize operation to occur
  for (size_t i = 0; i < 16; i++) {
    ASSERT_TRUE(vec.Push(i + 1));
  }

  EXPECT_EQ(vec.size(), 17u);

  // Verify that expected values are still contained in vec
  for (size_t i = 0; i < vec.size(); i++) {
    EXPECT_EQ(vec[i], i == 0 ? 42 : i);
  }
  EXPECT_EQ(vec.front(), 42u);
  EXPECT_EQ(vec.back(), 16u);

  // Clearing the vector should give an empty one.
  vec.clear();
  ASSERT_TRUE(vec.empty());
  EXPECT_EQ(vec.size(), 0u);

  ASSERT_TRUE(vec.Push(42));
  ASSERT_TRUE(!vec.empty());
  EXPECT_EQ(vec.size(), 1u);
  EXPECT_EQ(vec[0], 42u);
  EXPECT_EQ(vec.front(), 42u);
  EXPECT_EQ(vec.back(), 42u);
}

TEST(VectorTest, MoveConstructor) {
  Vector<size_t> vec;
  for (size_t i = 0; i < 100; i++) {
    ASSERT_TRUE(vec.Push(i));
  }

  Vector<size_t> vec_moved(std::move(vec));
  for (size_t i = 0; i < 100; i++) {
    EXPECT_EQ(vec_moved[i], i);
  }
}

TEST(VectorTest, VectorContainingVectors) {
  // Representative example of a struct that contains a Vector.
  struct TagAndArray {
    size_t tag;
    Vector<size_t> vec;
  };

  Vector<TagAndArray> vec;
  for (size_t i = 0; i < 100; i++) {
    TagAndArray elem;
    elem.tag = i;
    for (size_t j = 0; j < i; j++) {
      ASSERT_TRUE(elem.vec.Push(j));
    }
    ASSERT_TRUE(vec.Push(std::move(elem)));
  }
  EXPECT_EQ(vec.size(), 100u);

  // Add and remove some element.
  TagAndArray extra;
  extra.tag = 1234;
  ASSERT_TRUE(extra.vec.Push(1234));
  ASSERT_TRUE(vec.Push(std::move(extra)));
  EXPECT_EQ(vec.size(), 101u);
  vec.pop_back();
  EXPECT_EQ(vec.size(), 100u);

  Vector<TagAndArray> vec_moved(std::move(vec));
  EXPECT_EQ(vec_moved.size(), 100u);
  size_t count = 0;
  for (const TagAndArray &elem : vec_moved) {
    // Test the square bracket operator returns the same value as iteration.
    EXPECT_EQ(&elem, &vec_moved[count]);

    EXPECT_EQ(elem.tag, count);
    EXPECT_EQ(elem.vec.size(), count);
    for (size_t j = 0; j < count; j++) {
      EXPECT_EQ(elem.vec[j], j);
    }
    count++;
  }
}

TEST(VectorTest, NotDefaultConstructible) {
  struct NotDefaultConstructible {
    explicit NotDefaultConstructible(size_t n) { BSSL_CHECK(array.Init(n)); }
    Array<int> array;
  };

  Vector<NotDefaultConstructible> vec;
  ASSERT_TRUE(vec.Push(NotDefaultConstructible(0)));
  ASSERT_TRUE(vec.Push(NotDefaultConstructible(1)));
  ASSERT_TRUE(vec.Push(NotDefaultConstructible(2)));
  ASSERT_TRUE(vec.Push(NotDefaultConstructible(3)));
  EXPECT_EQ(vec.size(), 4u);
  EXPECT_EQ(0u, vec[0].array.size());
  EXPECT_EQ(1u, vec[1].array.size());
  EXPECT_EQ(2u, vec[2].array.size());
  EXPECT_EQ(3u, vec[3].array.size());
}

TEST(VectorDeathTest, BoundsChecks) {
  Vector<int> vec;
  EXPECT_DEATH_IF_SUPPORTED(vec.front(), "");
  EXPECT_DEATH_IF_SUPPORTED(vec.back(), "");
  EXPECT_DEATH_IF_SUPPORTED(vec.pop_back(), "");
  ASSERT_TRUE(vec.Push(1));
  // Within bounds of the capacity, but not the vector.
  EXPECT_DEATH_IF_SUPPORTED(vec[1], "");
  // Not within bounds of the capacity either.
  EXPECT_DEATH_IF_SUPPORTED(vec[10000], "");
}

TEST(InplaceVector, Basic) {
  InplaceVector<int, 4> vec;
  EXPECT_TRUE(vec.empty());
  EXPECT_EQ(0u, vec.size());
  EXPECT_EQ(vec.begin(), vec.end());

  int data3[] = {1, 2, 3};
  ASSERT_TRUE(vec.TryCopyFrom(data3));
  EXPECT_FALSE(vec.empty());
  EXPECT_EQ(3u, vec.size());
  auto iter = vec.begin();
  EXPECT_EQ(1, vec[0]);
  EXPECT_EQ(1, *iter);
  iter++;
  EXPECT_EQ(2, vec[1]);
  EXPECT_EQ(2, *iter);
  iter++;
  EXPECT_EQ(3, vec[2]);
  EXPECT_EQ(3, *iter);
  iter++;
  EXPECT_EQ(iter, vec.end());
  EXPECT_EQ(Span(vec), Span(data3));
  EXPECT_EQ(vec.front(), 1);
  EXPECT_EQ(vec.back(), 3);

  InplaceVector<int, 4> vec2 = vec;
  EXPECT_EQ(Span(vec), Span(vec2));

  InplaceVector<int, 4> vec3;
  vec3 = vec;
  EXPECT_EQ(Span(vec), Span(vec2));

  int data4[] = {1, 2, 3, 4};
  ASSERT_TRUE(vec.TryCopyFrom(data4));
  EXPECT_EQ(Span(vec), Span(data4));

  int data5[] = {1, 2, 3, 4, 5};
  EXPECT_FALSE(vec.TryCopyFrom(data5));
  EXPECT_FALSE(vec.TryResize(5));

  // Shrink the vector.
  ASSERT_TRUE(vec.TryResize(3));
  EXPECT_EQ(Span(vec), Span(data3));

  // Enlarge it again. The new value should have been value-initialized.
  ASSERT_TRUE(vec.TryResize(4));
  EXPECT_EQ(vec[3], 0);

  // Self-assignment should not break the vector. Indirect through a pointer to
  // avoid tripping a compiler warning.
  vec.CopyFrom(data4);
  const auto *ptr = &vec;
  vec = *ptr;
  EXPECT_EQ(Span(vec), Span(data4));
}

TEST(InplaceVectorTest, ComplexType) {
  InplaceVector<std::vector<int>, 4> vec_of_vecs;
  const std::vector<int> data[] = {{1, 2, 3}, {4, 5, 6}, {7, 8, 9}};
  vec_of_vecs.CopyFrom(data);
  EXPECT_EQ(Span(vec_of_vecs), Span(data));

  vec_of_vecs.Resize(2);
  EXPECT_EQ(Span(vec_of_vecs), Span(data, 2));

  vec_of_vecs.PushBack({42});
  EXPECT_EQ(3u, vec_of_vecs.size());
  vec_of_vecs.pop_back();
  EXPECT_EQ(2u, vec_of_vecs.size());

  vec_of_vecs.Resize(4);
  EXPECT_EQ(4u, vec_of_vecs.size());
  EXPECT_EQ(vec_of_vecs[0], data[0]);
  EXPECT_EQ(vec_of_vecs[1], data[1]);
  EXPECT_TRUE(vec_of_vecs[2].empty());
  EXPECT_TRUE(vec_of_vecs[3].empty());

  // Copy-construction.
  InplaceVector<std::vector<int>, 4> vec_of_vecs2 = vec_of_vecs;
  EXPECT_EQ(4u, vec_of_vecs2.size());
  EXPECT_EQ(vec_of_vecs2[0], data[0]);
  EXPECT_EQ(vec_of_vecs2[1], data[1]);
  EXPECT_TRUE(vec_of_vecs2[2].empty());
  EXPECT_TRUE(vec_of_vecs2[3].empty());

  // Copy-assignment.
  InplaceVector<std::vector<int>, 4> vec_of_vecs3;
  vec_of_vecs3 = vec_of_vecs;
  EXPECT_EQ(4u, vec_of_vecs3.size());
  EXPECT_EQ(vec_of_vecs3[0], data[0]);
  EXPECT_EQ(vec_of_vecs3[1], data[1]);
  EXPECT_TRUE(vec_of_vecs3[2].empty());
  EXPECT_TRUE(vec_of_vecs3[3].empty());

  // Move-construction.
  InplaceVector<std::vector<int>, 4> vec_of_vecs4 = std::move(vec_of_vecs);
  EXPECT_EQ(4u, vec_of_vecs4.size());
  EXPECT_EQ(vec_of_vecs4[0], data[0]);
  EXPECT_EQ(vec_of_vecs4[1], data[1]);
  EXPECT_TRUE(vec_of_vecs4[2].empty());
  EXPECT_TRUE(vec_of_vecs4[3].empty());

  // The elements of the original vector should have been moved-from.
  EXPECT_EQ(4u, vec_of_vecs.size());
  for (const auto &vec : vec_of_vecs) {
    EXPECT_TRUE(vec.empty());
  }

  // Move-assignment.
  InplaceVector<std::vector<int>, 4> vec_of_vecs5;
  vec_of_vecs5 = std::move(vec_of_vecs4);
  EXPECT_EQ(4u, vec_of_vecs5.size());
  EXPECT_EQ(vec_of_vecs5[0], data[0]);
  EXPECT_EQ(vec_of_vecs5[1], data[1]);
  EXPECT_TRUE(vec_of_vecs5[2].empty());
  EXPECT_TRUE(vec_of_vecs5[3].empty());

  // The elements of the original vector should have been moved-from.
  EXPECT_EQ(4u, vec_of_vecs4.size());
  for (const auto &vec : vec_of_vecs4) {
    EXPECT_TRUE(vec.empty());
  }

  std::vector<int> v = {42};
  vec_of_vecs5.Resize(3);
  EXPECT_TRUE(vec_of_vecs5.TryPushBack(v));
  EXPECT_EQ(v, vec_of_vecs5[3]);
  EXPECT_FALSE(vec_of_vecs5.TryPushBack(v));
}

TEST(InplaceVectorTest, MoveOnly) {
  InplaceVector<std::unique_ptr<int>, 4> vec;
  vec.PushBack(std::make_unique<int>(0));
  vec.PushBack(std::make_unique<int>(1));
  vec.PushBack(std::make_unique<int>(2));
  EXPECT_EQ(vec.size(), 3u);
  EXPECT_EQ(*vec[0], 0);
  EXPECT_EQ(*vec[1], 1);
  EXPECT_EQ(*vec[2], 2);

  // Move-construct
  InplaceVector<std::unique_ptr<int>, 4> vec2 = std::move(vec);
  EXPECT_EQ(vec2.size(), 3u);
  EXPECT_EQ(*vec2[0], 0);
  EXPECT_EQ(*vec2[1], 1);
  EXPECT_EQ(*vec2[2], 2);
  EXPECT_EQ(vec.size(), 3u);
  EXPECT_EQ(vec[0], nullptr);
  EXPECT_EQ(vec[1], nullptr);
  EXPECT_EQ(vec[2], nullptr);

  // Move-assign
  vec = std::move(vec2);
  EXPECT_EQ(vec.size(), 3u);
  EXPECT_EQ(*vec[0], 0);
  EXPECT_EQ(*vec[1], 1);
  EXPECT_EQ(*vec[2], 2);
  EXPECT_EQ(vec2.size(), 3u);
  EXPECT_EQ(vec2[0], nullptr);
  EXPECT_EQ(vec2[1], nullptr);
  EXPECT_EQ(vec2[2], nullptr);
}

TEST(InplaceVectorTest, EraseIf) {
  // Test that EraseIf never causes a self-move, and also correctly works with
  // a move-only type that cannot be default-constructed.
  class NoSelfMove {
   public:
    explicit NoSelfMove(int v) : v_(std::make_unique<int>(v)) {}
    NoSelfMove(NoSelfMove &&other) { *this = std::move(other); }
    NoSelfMove &operator=(NoSelfMove &&other) {
      BSSL_CHECK(this != &other);
      v_ = std::move(other.v_);
      return *this;
    }

    int value() const { return *v_; }

   private:
    std::unique_ptr<int> v_;
  };

  InplaceVector<NoSelfMove, 8> vec;
  auto reset = [&] {
    vec.clear();
    for (int i = 0; i < 8; i++) {
      vec.PushBack(NoSelfMove(i));
    }
  };
  auto expect = [&](const std::vector<int> &expected) {
    ASSERT_EQ(vec.size(), expected.size());
    for (size_t i = 0; i < vec.size(); i++) {
      SCOPED_TRACE(i);
      EXPECT_EQ(vec[i].value(), expected[i]);
    }
  };

  reset();
  vec.EraseIf([](const auto &) { return false; });
  expect({0, 1, 2, 3, 4, 5, 6, 7});

  reset();
  vec.EraseIf([](const auto &) { return true; });
  expect({});

  reset();
  vec.EraseIf([](const auto &v) { return v.value() < 4; });
  expect({4, 5, 6, 7});

  reset();
  vec.EraseIf([](const auto &v) { return v.value() >= 4; });
  expect({0, 1, 2, 3});

  reset();
  vec.EraseIf([](const auto &v) { return v.value() % 2 == 0; });
  expect({1, 3, 5, 7});

  reset();
  vec.EraseIf([](const auto &v) { return v.value() % 2 == 1; });
  expect({0, 2, 4, 6});

  reset();
  vec.EraseIf([](const auto &v) { return 2 <= v.value() && v.value() <= 5; });
  expect({0, 1, 6, 7});

  reset();
  vec.EraseIf([](const auto &v) { return v.value() == 0; });
  expect({1, 2, 3, 4, 5, 6, 7});

  reset();
  vec.EraseIf([](const auto &v) { return v.value() == 4; });
  expect({0, 1, 2, 3, 5, 6, 7});

  reset();
  vec.EraseIf([](const auto &v) { return v.value() == 7; });
  expect({0, 1, 2, 3, 4, 5, 6});
}

TEST(InplaceVectorDeathTest, BoundsChecks) {
  InplaceVector<int, 4> vec;
  // The vector is currently empty.
  EXPECT_DEATH_IF_SUPPORTED(vec[0], "");
  EXPECT_DEATH_IF_SUPPORTED(vec.front(), "");
  EXPECT_DEATH_IF_SUPPORTED(vec.back(), "");
  EXPECT_DEATH_IF_SUPPORTED(vec.pop_back(), "");
  int data[] = {1, 2, 3};
  vec.CopyFrom(data);
  // Some more out-of-bounds elements.
  EXPECT_DEATH_IF_SUPPORTED(vec[3], "");
  EXPECT_DEATH_IF_SUPPORTED(vec[4], "");
  EXPECT_DEATH_IF_SUPPORTED(vec[1000], "");
  // The vector cannot be resized past the capacity.
  EXPECT_DEATH_IF_SUPPORTED(vec.Resize(5), "");
  EXPECT_DEATH_IF_SUPPORTED(vec.ResizeForOverwrite(5), "");
  int too_much_data[] = {1, 2, 3, 4, 5};
  EXPECT_DEATH_IF_SUPPORTED(vec.CopyFrom(too_much_data), "");
  vec.Resize(4);
  EXPECT_DEATH_IF_SUPPORTED(vec.PushBack(42), "");
}

}  // namespace
BSSL_NAMESPACE_END
#endif  // !BORINGSSL_SHARED_LIBRARY
