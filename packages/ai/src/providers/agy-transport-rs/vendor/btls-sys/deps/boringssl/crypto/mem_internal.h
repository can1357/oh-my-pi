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

#ifndef OPENSSL_HEADER_CRYPTO_MEM_INTERNAL_H
#define OPENSSL_HEADER_CRYPTO_MEM_INTERNAL_H

#include <openssl/mem.h>

#include <algorithm>
#include <memory>
#include <type_traits>
#include <utility>

#include <openssl/err.h>
#include <openssl/span.h>


BSSL_NAMESPACE_BEGIN

// Internal allocation-dependent functions.
//
// This header is separate from crypto/internal.h because there are some files
// which must avoid |OPENSSL_malloc|, to avoid a circular dependency, but
// need other support routines in crypto/internal.h. (See
// |_BORINGSSL_PROHIBIT_OPENSSL_MALLOC|.)


// Memory allocation.

// New behaves like |new| but uses |OPENSSL_malloc| for memory allocation. It
// returns nullptr on allocation error. It only implements single-object
// allocation and not new T[n].
//
// Note: unlike |new|, this does not support non-public constructors.
template <typename T, typename... Args>
T *New(Args &&...args) {
  void *t = OPENSSL_malloc(sizeof(T));
  if (t == nullptr) {
    return nullptr;
  }
  return new (t) T(std::forward<Args>(args)...);
}

// Delete behaves like |delete| but uses |OPENSSL_free| to release memory.
//
// Note: unlike |delete| this does not support non-public destructors.
template <typename T>
void Delete(T *t) {
  if (t != nullptr) {
    t->~T();
    OPENSSL_free(t);
  }
}

// All types with kAllowUniquePtr set may be used with UniquePtr. Other types
// may be C structs which require a |BORINGSSL_MAKE_DELETER| registration.
namespace internal {
template <typename T>
struct DeleterImpl<T, std::enable_if_t<T::kAllowUniquePtr>> {
  static void Free(T *t) { Delete(t); }
};
}  // namespace internal

// MakeUnique behaves like |std::make_unique| but returns nullptr on allocation
// error.
template <typename T, typename... Args>
UniquePtr<T> MakeUnique(Args &&...args) {
  return UniquePtr<T>(New<T>(std::forward<Args>(args)...));
}


// Containers.

// Array<T> is an owning array of elements of |T|.
template <typename T>
class Array {
 public:
  using value_type = std::remove_cv_t<T>;

  // Array's default constructor creates an empty array.
  Array() {}
  Array(const Array &) = delete;
  Array(Array &&other) { *this = std::move(other); }

  ~Array() { Reset(); }

  Array &operator=(const Array &) = delete;
  Array &operator=(Array &&other) {
    Reset();
    other.Release(&data_, &size_);
    return *this;
  }

  const T *data() const { return data_; }
  T *data() { return data_; }
  size_t size() const { return size_; }
  bool empty() const { return size_ == 0; }

  const T &operator[](size_t i) const {
    BSSL_CHECK(i < size_);
    return data_[i];
  }
  T &operator[](size_t i) {
    BSSL_CHECK(i < size_);
    return data_[i];
  }

  T &front() {
    BSSL_CHECK(size_ != 0);
    return data_[0];
  }
  const T &front() const {
    BSSL_CHECK(size_ != 0);
    return data_[0];
  }
  T &back() {
    BSSL_CHECK(size_ != 0);
    return data_[size_ - 1];
  }
  const T &back() const {
    BSSL_CHECK(size_ != 0);
    return data_[size_ - 1];
  }

  T *begin() { return data_; }
  const T *begin() const { return data_; }
  T *end() { return data_ + size_; }
  const T *end() const { return data_ + size_; }

  void Reset() { Reset(nullptr, 0); }

  // Reset releases the current contents of the array and takes ownership of the
  // raw pointer supplied by the caller.
  void Reset(T *new_data, size_t new_size) {
    std::destroy_n(data_, size_);
    OPENSSL_free(data_);
    data_ = new_data;
    size_ = new_size;
  }

  // Release releases ownership of the array to a raw pointer supplied by the
  // caller.
  void Release(T **out, size_t *out_size) {
    *out = data_;
    *out_size = size_;
    data_ = nullptr;
    size_ = 0;
  }

  // Init replaces the array with a newly-allocated array of |new_size|
  // value-constructed copies of |T|. It returns true on success and false on
  // error. If |T| is a primitive type like |uint8_t|, value-construction means
  // it will be zero-initialized.
  [[nodiscard]] bool Init(size_t new_size) {
    if (!InitUninitialized(new_size)) {
      return false;
    }
    std::uninitialized_value_construct_n(data_, size_);
    return true;
  }

  // InitForOverwrite behaves like |Init| but it default-constructs each element
  // instead. This means that, if |T| is a primitive type, the array will be
  // uninitialized and thus must be filled in by the caller.
  [[nodiscard]] bool InitForOverwrite(size_t new_size) {
    if (!InitUninitialized(new_size)) {
      return false;
    }
    std::uninitialized_default_construct_n(data_, size_);
    return true;
  }

  // CopyFrom replaces the array with a newly-allocated copy of |in|. It returns
  // true on success and false on error.
  [[nodiscard]] bool CopyFrom(Span<const T> in) {
    if (!InitUninitialized(in.size())) {
      return false;
    }
    std::uninitialized_copy(in.begin(), in.end(), data_);
    return true;
  }

  // Shrink shrinks the stored size of the array to |new_size|. It crashes if
  // the new size is larger. Note this does not shrink the allocation itself.
  void Shrink(size_t new_size) {
    if (new_size > size_) {
      abort();
    }
    std::destroy_n(data_ + new_size, size_ - new_size);
    size_ = new_size;
  }

 private:
  // InitUninitialized replaces the array with a newly-allocated array of
  // |new_size| elements, but whose constructor has not yet run. On success, the
  // elements must be constructed before returning control to the caller.
  bool InitUninitialized(size_t new_size) {
    Reset();
    if (new_size == 0) {
      return true;
    }

    if (new_size > SIZE_MAX / sizeof(T)) {
      OPENSSL_PUT_ERROR(CRYPTO, ERR_R_OVERFLOW);
      return false;
    }
    data_ = reinterpret_cast<T *>(OPENSSL_malloc(new_size * sizeof(T)));
    if (data_ == nullptr) {
      return false;
    }
    size_ = new_size;
    return true;
  }

  T *data_ = nullptr;
  size_t size_ = 0;
};

// Vector<T> is a resizable array of elements of |T|.
template <typename T>
class Vector {
 public:
  Vector() = default;
  Vector(const Vector &) = delete;
  Vector(Vector &&other) { *this = std::move(other); }
  ~Vector() { clear(); }

  Vector &operator=(const Vector &) = delete;
  Vector &operator=(Vector &&other) {
    clear();
    std::swap(data_, other.data_);
    std::swap(size_, other.size_);
    std::swap(capacity_, other.capacity_);
    return *this;
  }

  const T *data() const { return data_; }
  T *data() { return data_; }
  size_t size() const { return size_; }
  bool empty() const { return size_ == 0; }

  const T &operator[](size_t i) const {
    BSSL_CHECK(i < size_);
    return data_[i];
  }
  T &operator[](size_t i) {
    BSSL_CHECK(i < size_);
    return data_[i];
  }

  T &front() {
    BSSL_CHECK(size_ != 0);
    return data_[0];
  }
  const T &front() const {
    BSSL_CHECK(size_ != 0);
    return data_[0];
  }
  T &back() {
    BSSL_CHECK(size_ != 0);
    return data_[size_ - 1];
  }
  const T &back() const {
    BSSL_CHECK(size_ != 0);
    return data_[size_ - 1];
  }

  T *begin() { return data_; }
  const T *begin() const { return data_; }
  T *end() { return data_ + size_; }
  const T *end() const { return data_ + size_; }

  void clear() {
    std::destroy_n(data_, size_);
    OPENSSL_free(data_);
    data_ = nullptr;
    size_ = 0;
    capacity_ = 0;
  }

  void pop_back() {
    BSSL_CHECK(size_ != 0);
    std::destroy_at(&data_[size_ - 1]);
    size_--;
  }

  // Push adds |elem| at the end of the internal array, growing if necessary. It
  // returns false when allocation fails.
  [[nodiscard]] bool Push(T elem) {
    if (!MaybeGrow()) {
      return false;
    }
    new (&data_[size_]) T(std::move(elem));
    size_++;
    return true;
  }

  // CopyFrom replaces the contents of the array with a copy of |in|. It returns
  // true on success and false on allocation error.
  [[nodiscard]] bool CopyFrom(Span<const T> in) {
    Array<T> copy;
    if (!copy.CopyFrom(in)) {
      return false;
    }

    clear();
    copy.Release(&data_, &size_);
    capacity_ = size_;
    return true;
  }

 private:
  // If there is no room for one more element, creates a new backing array with
  // double the size of the old one and copies elements over.
  bool MaybeGrow() {
    // No need to grow if we have room for one more T.
    if (size_ < capacity_) {
      return true;
    }
    size_t new_capacity = kDefaultSize;
    if (capacity_ > 0) {
      // Double the array's size if it's safe to do so.
      if (capacity_ > SIZE_MAX / 2) {
        OPENSSL_PUT_ERROR(CRYPTO, ERR_R_OVERFLOW);
        return false;
      }
      new_capacity = capacity_ * 2;
    }
    if (new_capacity > SIZE_MAX / sizeof(T)) {
      OPENSSL_PUT_ERROR(CRYPTO, ERR_R_OVERFLOW);
      return false;
    }
    T *new_data =
        reinterpret_cast<T *>(OPENSSL_malloc(new_capacity * sizeof(T)));
    if (new_data == nullptr) {
      return false;
    }
    size_t new_size = size_;
    std::uninitialized_move(begin(), end(), new_data);
    clear();
    data_ = new_data;
    size_ = new_size;
    capacity_ = new_capacity;
    return true;
  }

  // data_ is a pointer to |capacity_| objects of size |T|, the first |size_| of
  // which are constructed.
  T *data_ = nullptr;
  // |size_| is the number of elements stored in this Vector.
  size_t size_ = 0;
  // |capacity_| is the number of elements allocated in this Vector.
  size_t capacity_ = 0;
  // |kDefaultSize| is the default initial size of the backing array.
  static constexpr size_t kDefaultSize = 16;
};

// A PackedSize is an integer that can store values from 0 to N, represented as
// a minimal-width integer.
template <size_t N>
using PackedSize = std::conditional_t<
    N <= 0xff, uint8_t,
    std::conditional_t<N <= 0xffff, uint16_t,
                       std::conditional_t<N <= 0xffffffff, uint32_t, size_t>>>;

// An InplaceVector is like a Vector, but stores up to N elements inline in the
// object. It is inspired by std::inplace_vector in C++26.
template <typename T, size_t N>
class InplaceVector {
 public:
  using value_type = std::remove_cv_t<T>;

  InplaceVector() = default;
  InplaceVector(const InplaceVector &other) { *this = other; }
  InplaceVector(InplaceVector &&other) { *this = std::move(other); }
  ~InplaceVector() { clear(); }
  InplaceVector &operator=(const InplaceVector &other) {
    if (this != &other) {
      CopyFrom(other);
    }
    return *this;
  }
  InplaceVector &operator=(InplaceVector &&other) {
    clear();
    std::uninitialized_move(other.begin(), other.end(), data());
    size_ = other.size();
    return *this;
  }

  const T *data() const { return reinterpret_cast<const T *>(storage_); }
  T *data() { return reinterpret_cast<T *>(storage_); }
  size_t size() const { return size_; }
  static constexpr size_t capacity() { return N; }
  bool empty() const { return size_ == 0; }

  const T &operator[](size_t i) const {
    BSSL_CHECK(i < size_);
    return data()[i];
  }
  T &operator[](size_t i) {
    BSSL_CHECK(i < size_);
    return data()[i];
  }

  T &front() {
    BSSL_CHECK(size_ != 0);
    return data()[0];
  }
  const T &front() const {
    BSSL_CHECK(size_ != 0);
    return data()[0];
  }
  T &back() {
    BSSL_CHECK(size_ != 0);
    return data()[size_ - 1];
  }
  const T &back() const {
    BSSL_CHECK(size_ != 0);
    return data()[size_ - 1];
  }

  T *begin() { return data(); }
  const T *begin() const { return data(); }
  T *end() { return data() + size_; }
  const T *end() const { return data() + size_; }

  void clear() { Shrink(0); }

  void pop_back() {
    BSSL_CHECK(size_ != 0);
    Shrink(size_ - 1);
  }

  // Shrink resizes the vector to |new_size|, which must not be larger than the
  // current size. Unlike |Resize|, this can be called when |T| is not
  // default-constructible.
  void Shrink(size_t new_size) {
    BSSL_CHECK(new_size <= size_);
    std::destroy_n(data() + new_size, size_ - new_size);
    size_ = static_cast<PackedSize<N>>(new_size);
  }

  // TryResize resizes the vector to |new_size| and returns true, or returns
  // false if |new_size| is too large. Any newly-added elements are
  // value-initialized.
  [[nodiscard]] bool TryResize(size_t new_size) {
    if (new_size <= size_) {
      Shrink(new_size);
      return true;
    }
    if (new_size > capacity()) {
      return false;
    }
    std::uninitialized_value_construct_n(data() + size_, new_size - size_);
    size_ = static_cast<PackedSize<N>>(new_size);
    return true;
  }

  // TryResizeForOverwrite behaves like |TryResize|, but newly-added elements
  // are default-initialized, so POD types may contain uninitialized values that
  // the caller is responsible for filling in.
  [[nodiscard]] bool TryResizeForOverwrite(size_t new_size) {
    if (new_size <= size_) {
      Shrink(new_size);
      return true;
    }
    if (new_size > capacity()) {
      return false;
    }
    std::uninitialized_default_construct_n(data() + size_, new_size - size_);
    size_ = static_cast<PackedSize<N>>(new_size);
    return true;
  }

  // TryCopyFrom sets the vector to a copy of |in| and returns true, or returns
  // false if |in| is too large.
  [[nodiscard]] bool TryCopyFrom(Span<const T> in) {
    if (in.size() > capacity()) {
      return false;
    }
    clear();
    std::uninitialized_copy(in.begin(), in.end(), data());
    size_ = in.size();
    return true;
  }

  // TryPushBack appends |val| to the vector and returns a pointer to the
  // newly-inserted value, or nullptr if the vector is at capacity.
  [[nodiscard]] T *TryPushBack(T val) {
    if (size() >= capacity()) {
      return nullptr;
    }
    T *ret = &data()[size_];
    new (ret) T(std::move(val));
    size_++;
    return ret;
  }

  // The following methods behave like their |Try*| counterparts, but abort the
  // program on failure.
  void Resize(size_t size) { BSSL_CHECK(TryResize(size)); }
  void ResizeForOverwrite(size_t size) {
    BSSL_CHECK(TryResizeForOverwrite(size));
  }
  void CopyFrom(Span<const T> in) { BSSL_CHECK(TryCopyFrom(in)); }
  T &PushBack(T val) {
    T *ret = TryPushBack(std::move(val));
    BSSL_CHECK(ret != nullptr);
    return *ret;
  }

  template <typename Pred>
  void EraseIf(Pred pred) {
    // See if anything needs to be erased at all. This avoids a self-move.
    auto iter = std::find_if(begin(), end(), pred);
    if (iter == end()) {
      return;
    }

    // Elements before the first to be erased may be left as-is.
    size_t new_size = iter - begin();
    // Swap all subsequent elements in if they are to be kept.
    for (size_t i = new_size + 1; i < size(); i++) {
      if (!pred((*this)[i])) {
        (*this)[new_size] = std::move((*this)[i]);
        new_size++;
      }
    }

    Shrink(new_size);
  }

 private:
  alignas(T) char storage_[sizeof(T[N])];
  PackedSize<N> size_ = 0;
};


BSSL_NAMESPACE_END

#endif  // OPENSSL_HEADER_CRYPTO_MEM_INTERNAL_H
