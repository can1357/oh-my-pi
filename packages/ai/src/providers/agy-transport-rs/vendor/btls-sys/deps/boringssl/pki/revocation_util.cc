// Copyright 2019 The Chromium Authors
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

#include "revocation_util.h"

#include "encode_values.h"
#include "parse_values.h"

BSSL_NAMESPACE_BEGIN

namespace {

constexpr int64_t kMinValidTime = -62167219200;  // 0000-01-01 00:00:00 UTC
constexpr int64_t kMaxValidTime = 253402300799;  // 9999-12-31 23:59:59 UTC

}  // namespace

bool CheckRevocationDateValid(const der::GeneralizedTime &this_update,
                              const der::GeneralizedTime *next_update,
                              int64_t verify_time_epoch_seconds,
                              std::optional<int64_t> max_age_seconds) {
  if (verify_time_epoch_seconds > kMaxValidTime ||
      verify_time_epoch_seconds < kMinValidTime ||
      (max_age_seconds.has_value() &&
       (max_age_seconds.value() > kMaxValidTime ||
        max_age_seconds.value() < 0))) {
    return false;
  }
  der::GeneralizedTime verify_time;
  if (!der::EncodePosixTimeAsGeneralizedTime(verify_time_epoch_seconds,
                                             &verify_time)) {
    return false;
  }

  if (this_update > verify_time) {
    return false;  // Response is not yet valid.
  }

  if (next_update && (*next_update <= verify_time)) {
    return false;  // Response is no longer valid.
  }

  if (max_age_seconds.has_value()) {
    der::GeneralizedTime earliest_this_update;
    if (!der::EncodePosixTimeAsGeneralizedTime(
            verify_time_epoch_seconds - max_age_seconds.value(),
            &earliest_this_update)) {
      return false;
    }
    if (this_update < earliest_this_update) {
      return false;  // Response is too old.
    }
  }

  return true;
}

BSSL_NAMESPACE_END
