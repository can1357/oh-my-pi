// Copyright 2005-2016 The OpenSSL Project Authors. All Rights Reserved.
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

#include <openssl/ssl.h>

#include <assert.h>
#include <limits.h>
#include <string.h>

#include <openssl/err.h>
#include <openssl/mem.h>
#include <openssl/nid.h>

#include "../crypto/internal.h"
#include "internal.h"


BSSL_NAMESPACE_BEGIN

DTLS1_STATE::DTLS1_STATE()
    : has_change_cipher_spec(false),
      outgoing_messages_complete(false),
      flight_has_reply(false),
      handshake_write_overflow(false),
      handshake_read_overflow(false),
      sending_flight(false),
      sending_ack(false),
      pending_flush(false),
      queued_key_update(QueuedKeyUpdate::kNone) {}

DTLS1_STATE::~DTLS1_STATE() {}

bool DTLS1_STATE::Init() {
  // Set up the initial epochs.
  read_epoch.aead = SSLAEADContext::CreateNullCipher();
  write_epoch.aead = SSLAEADContext::CreateNullCipher();
  if (read_epoch.aead == nullptr || write_epoch.aead == nullptr) {
    return false;
  }

  return true;
}

bool dtls1_new(SSL *ssl) {
  if (!tls_new(ssl)) {
    return false;
  }
  UniquePtr<DTLS1_STATE> d1 = MakeUnique<DTLS1_STATE>();
  if (!d1 || !d1->Init()) {
    tls_free(ssl);
    return false;
  }

  ssl->d1 = d1.release();
  return true;
}

void dtls1_free(SSL *ssl) {
  tls_free(ssl);

  if (ssl == nullptr) {
    return;
  }

  Delete(ssl->d1);
  ssl->d1 = nullptr;
}

void DTLSTimer::StartMicroseconds(OPENSSL_timeval now, uint64_t microseconds) {
  uint64_t seconds = microseconds / 1000000;
  microseconds %= 1000000;

  now.tv_usec += microseconds;
  if (now.tv_usec >= 1000000) {
    now.tv_usec -= 1000000;
    seconds++;
  }

  if (now.tv_sec > UINT64_MAX - seconds) {
    Stop();
    return;
  }
  now.tv_sec += seconds;
  expire_time_ = now;
}

void DTLSTimer::Stop() { expire_time_ = {0, 0}; }

bool DTLSTimer::IsExpired(OPENSSL_timeval now) const {
  return MicrosecondsRemaining(now) == 0;
}

bool DTLSTimer::IsSet() const {
  return expire_time_.tv_sec != 0 || expire_time_.tv_usec != 0;
}

uint64_t DTLSTimer::MicrosecondsRemaining(OPENSSL_timeval now) const {
  if (!IsSet()) {
    return kNever;
  }

  if (now.tv_sec > expire_time_.tv_sec ||
      (now.tv_sec == expire_time_.tv_sec &&
       now.tv_usec >= expire_time_.tv_usec)) {
    return 0;
  }

  uint64_t sec = expire_time_.tv_sec - now.tv_sec;
  uint32_t usec;
  if (expire_time_.tv_usec >= now.tv_usec) {
    usec = expire_time_.tv_usec - now.tv_usec;
  } else {
    sec--;
    usec = expire_time_.tv_usec + 1000000 - now.tv_usec;
  }

  // If remaining time is less than 15 ms, return 0 to prevent issues because of
  // small divergences with socket timeouts.
  if (sec == 0 && usec < 15000) {
    return 0;
  }

  if (sec > UINT64_MAX / 1000000) {
    return kNever;
  }
  sec *= 1000000;
  if (sec > UINT64_MAX - usec) {
    return kNever;
  }
  return sec + usec;
}

void dtls1_stop_timer(SSL *ssl) {
  ssl->d1->num_timeouts = 0;
  ssl->d1->retransmit_timer.Stop();
  ssl->d1->timeout_duration_ms = ssl->initial_timeout_duration_ms;
}

BSSL_NAMESPACE_END

using namespace bssl;

void DTLSv1_set_initial_timeout_duration(SSL *ssl, uint32_t duration_ms) {
  ssl->initial_timeout_duration_ms = duration_ms;
}

int DTLSv1_get_timeout(const SSL *ssl, struct timeval *out) {
  if (!SSL_is_dtls(ssl)) {
    return 0;
  }

  OPENSSL_timeval now = ssl_ctx_get_current_time(ssl->ctx.get());
  uint64_t remaining_usec =
      ssl->d1->retransmit_timer.MicrosecondsRemaining(now);
  remaining_usec =
      std::min(remaining_usec, ssl->d1->ack_timer.MicrosecondsRemaining(now));
  if (remaining_usec == DTLSTimer::kNever) {
    return 0;  // No timeout is set.
  }

  uint64_t remaining_sec = remaining_usec / 1000000;
  remaining_usec %= 1000000;

  // |timeval| uses |time_t|, which may be 32-bit.
  const auto kTvSecMax = std::numeric_limits<decltype(out->tv_sec)>::max();
  if (remaining_sec > static_cast<uint64_t>(kTvSecMax)) {
    out->tv_sec = kTvSecMax;  // Saturate the output.
    out->tv_usec = 999999;
  } else {
    out->tv_sec = static_cast<decltype(out->tv_sec)>(remaining_sec);
  }
  out->tv_usec = remaining_usec;
  return 1;
}

int DTLSv1_handle_timeout(SSL *ssl) {
  ssl_reset_error_state(ssl);

  if (!SSL_is_dtls(ssl)) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_SHOULD_NOT_HAVE_BEEN_CALLED);
    return -1;
  }

  if (!ssl->d1->ack_timer.IsSet() && !ssl->d1->retransmit_timer.IsSet()) {
    // No timers are running. Don't bother querying the clock.
    return 0;
  }

  OPENSSL_timeval now = ssl_ctx_get_current_time(ssl->ctx.get());
  bool any_timer_expired = false;
  if (ssl->d1->ack_timer.IsExpired(now)) {
    any_timer_expired = true;
    ssl->d1->sending_ack = true;
    ssl->d1->ack_timer.Stop();
  }

  if (ssl->d1->retransmit_timer.IsExpired(now)) {
    any_timer_expired = true;
    ssl->d1->sending_flight = true;
    ssl->d1->retransmit_timer.Stop();

    ssl->d1->num_timeouts++;
    // Reduce MTU after 2 unsuccessful retransmissions.
    if (ssl->d1->num_timeouts > DTLS1_MTU_TIMEOUTS &&
        !(SSL_get_options(ssl) & SSL_OP_NO_QUERY_MTU)) {
      long mtu = BIO_ctrl(ssl->wbio.get(), BIO_CTRL_DGRAM_GET_FALLBACK_MTU, 0,
                          nullptr);
      if (mtu >= 0 && mtu <= (1 << 30) && (unsigned)mtu >= dtls1_min_mtu()) {
        ssl->d1->mtu = (unsigned)mtu;
      }
    }
  }

  if (!any_timer_expired) {
    return 0;
  }

  return dtls1_flush(ssl);
}
