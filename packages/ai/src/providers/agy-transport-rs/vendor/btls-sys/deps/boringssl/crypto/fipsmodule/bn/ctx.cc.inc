// Copyright 2000-2016 The OpenSSL Project Authors. All Rights Reserved.
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

#include <openssl/bn.h>

#include <assert.h>
#include <string.h>

#include <utility>

#include <openssl/err.h>
#include <openssl/mem.h>

#include "../../mem_internal.h"


struct bignum_ctx {
  ~bignum_ctx() {
    // All |BN_CTX_start| calls must be matched with |BN_CTX_end|, otherwise the
    // function may use more memory than expected, potentially without bound if
    // done in a loop. Assert that all |BIGNUM|s have been released.
    assert(used_ == 0 || error_);
  }

  // bignums_ is the stack of |BIGNUM|s managed by this |BN_CTX|.
  bssl::Vector<bssl::UniquePtr<BIGNUM>> bignums_;
  // stack_ is the stack of |BN_CTX_start| frames. It is the value of |used_| at
  // the time |BN_CTX_start| was called.
  bssl::Vector<size_t> stack_;
  // used_ is the number of |BIGNUM|s from |bignums_| that have been used.
  size_t used_ = 0;
  // error_ is whether any operation on this |BN_CTX| failed. All subsequent
  // operations will fail.
  bool error_ = false;
  // defer_error_ is whether an operation on this |BN_CTX| has failed, but no
  // error has been pushed to the queue yet. This is used to defer errors from
  // |BN_CTX_start| to |BN_CTX_get|.
  bool defer_error_ = false;
} /* BN_CTX */;

BN_CTX *BN_CTX_new(void) { return bssl::New<BN_CTX>(); }

void BN_CTX_free(BN_CTX *ctx) { bssl::Delete(ctx); }

void BN_CTX_start(BN_CTX *ctx) {
  if (ctx->error_) {
    // Once an operation has failed, |ctx->stack| no longer matches the number
    // of |BN_CTX_end| calls to come. Do nothing.
    return;
  }

  if (!ctx->stack_.Push(ctx->used_)) {
    ctx->error_ = true;
    // |BN_CTX_start| cannot fail, so defer the error to |BN_CTX_get|.
    ctx->defer_error_ = true;
    ERR_clear_error();
  }
}

BIGNUM *BN_CTX_get(BN_CTX *ctx) {
  // Once any operation has failed, they all do.
  if (ctx->error_) {
    if (ctx->defer_error_) {
      OPENSSL_PUT_ERROR(BN, BN_R_TOO_MANY_TEMPORARY_VARIABLES);
      ctx->defer_error_ = false;
    }
    return nullptr;
  }

  if (ctx->used_ == ctx->bignums_.size()) {
    bssl::UniquePtr<BIGNUM> bn(BN_new());
    if (bn == nullptr || !ctx->bignums_.Push(std::move(bn))) {
      OPENSSL_PUT_ERROR(BN, BN_R_TOO_MANY_TEMPORARY_VARIABLES);
      ctx->error_ = true;
      return nullptr;
    }
  }

  BIGNUM *ret = ctx->bignums_[ctx->used_].get();
  BN_zero(ret);
  // This is bounded by |ctx->bignums_.size()|, so it cannot overflow.
  ctx->used_++;
  return ret;
}

void BN_CTX_end(BN_CTX *ctx) {
  if (ctx->error_) {
    // Once an operation has failed, |ctx->stack_| no longer matches the number
    // of |BN_CTX_end| calls to come. Do nothing.
    return;
  }

  assert(!ctx->stack_.empty());
  ctx->used_ = ctx->stack_.back();
  ctx->stack_.pop_back();
}
