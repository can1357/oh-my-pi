// Copyright 2022 The Chromium Authors
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

#include "mock_signature_verify_cache.h"

#include <algorithm>

BSSL_NAMESPACE_BEGIN

MockSignatureVerifyCache::MockSignatureVerifyCache() = default;

MockSignatureVerifyCache::~MockSignatureVerifyCache() = default;

void MockSignatureVerifyCache::Store(const std::string &key,
                                     SignatureVerifyCache::Value value) {
  cache_.insert_or_assign(key, value);
  stores_++;
}

SignatureVerifyCache::Value MockSignatureVerifyCache::Check(
    const std::string &key) {
  auto iter = cache_.find(key);
  if (iter == cache_.end()) {
    misses_++;
    return SignatureVerifyCache::Value::kUnknown;
  }
  hits_++;
  return iter->second;
}

BSSL_NAMESPACE_END
