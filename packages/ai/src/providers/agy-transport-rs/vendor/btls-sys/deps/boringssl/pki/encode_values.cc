// Copyright 2016 The Chromium Authors
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

#include "encode_values.h"

#include "parse_values.h"

#include <openssl/posix_time.h>

BSSL_NAMESPACE_BEGIN
namespace der {

namespace {

bool WriteFourDigit(uint16_t value, uint8_t out[4]) {
  if (value >= 10000) {
    return false;
  }
  out[3] = '0' + (value % 10);
  value /= 10;
  out[2] = '0' + (value % 10);
  value /= 10;
  out[1] = '0' + (value % 10);
  value /= 10;
  out[0] = '0' + value;
  return true;
}

bool WriteTwoDigit(uint8_t value, uint8_t out[2]) {
  if (value >= 100) {
    return false;
  }
  out[0] = '0' + (value / 10);
  out[1] = '0' + (value % 10);
  return true;
}

}  // namespace

bool EncodePosixTimeAsGeneralizedTime(int64_t posix_time,
                                      GeneralizedTime *generalized_time) {
  struct tm tmp_tm;
  if (!OPENSSL_posix_to_tm(posix_time, &tmp_tm)) {
    return false;
  }

  generalized_time->year = tmp_tm.tm_year + 1900;
  generalized_time->month = tmp_tm.tm_mon + 1;
  generalized_time->day = tmp_tm.tm_mday;
  generalized_time->hours = tmp_tm.tm_hour;
  generalized_time->minutes = tmp_tm.tm_min;
  generalized_time->seconds = tmp_tm.tm_sec;
  return true;
}

bool GeneralizedTimeToPosixTime(const der::GeneralizedTime &generalized,
                                int64_t *result) {
  struct tm tmp_tm;
  tmp_tm.tm_year = generalized.year - 1900;
  tmp_tm.tm_mon = generalized.month - 1;
  tmp_tm.tm_mday = generalized.day;
  tmp_tm.tm_hour = generalized.hours;
  tmp_tm.tm_min = generalized.minutes;
  tmp_tm.tm_sec = generalized.seconds;
  // BoringSSL POSIX time, like POSIX itself, does not support leap seconds.
  // Collapse to previous second.
  if (tmp_tm.tm_sec == 60) {
    tmp_tm.tm_sec = 59;
  }
  return OPENSSL_tm_to_posix(&tmp_tm, result);
}

bool EncodeGeneralizedTime(const GeneralizedTime &time,
                           uint8_t out[kGeneralizedTimeLength]) {
  if (!WriteFourDigit(time.year, out) || !WriteTwoDigit(time.month, out + 4) ||
      !WriteTwoDigit(time.day, out + 6) ||
      !WriteTwoDigit(time.hours, out + 8) ||
      !WriteTwoDigit(time.minutes, out + 10) ||
      !WriteTwoDigit(time.seconds, out + 12)) {
    return false;
  }
  out[14] = 'Z';
  return true;
}

bool EncodeUTCTime(const GeneralizedTime &time, uint8_t out[kUTCTimeLength]) {
  if (!time.InUTCTimeRange()) {
    return false;
  }

  uint16_t year = time.year - 1900;
  if (year >= 100) {
    year -= 100;
  }

  if (!WriteTwoDigit(year, out) || !WriteTwoDigit(time.month, out + 2) ||
      !WriteTwoDigit(time.day, out + 4) ||
      !WriteTwoDigit(time.hours, out + 6) ||
      !WriteTwoDigit(time.minutes, out + 8) ||
      !WriteTwoDigit(time.seconds, out + 10)) {
    return false;
  }
  out[12] = 'Z';
  return true;
}

}  // namespace der
BSSL_NAMESPACE_END
