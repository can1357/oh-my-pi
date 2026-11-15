// Generated from Bedrock code in Fiat Cryptogrpahy. Avoid editing directly.

static inline br_word_t br_full_add(br_word_t x, br_word_t y, br_word_t carry, br_word_t* _sum) {
  br_word_t carry_out, sum;
  x = x+carry;
  carry_out = (br_word_t)(x<carry);
  sum = x+y;
  carry_out = carry_out+((br_word_t)(sum<y));
  *_sum = sum;
  return carry_out;
}

static inline br_word_t br_full_sub(br_word_t x, br_word_t y, br_word_t borrow, br_word_t* _diff) {
  br_word_t out_borrow, diff;
  out_borrow = (br_word_t)(x<y);
  diff = x-y;
  out_borrow = out_borrow+((br_word_t)(diff<borrow));
  diff = diff-borrow;
  *_diff = diff;
  return out_borrow;
}

static inline br_word_t br_full_mul(br_word_t a, br_word_t b, br_word_t* _low) {
  br_word_t high, hh, lh, hl, low, second_halfword_w_oflow, n, ll, M;
  n = ((((0u-(br_word_t)1)>>27)&63)+1)>>1;
  M = ((br_word_t)1<<(n&(sizeof(br_word_t)*8-1)))-1;
  ll = (a&M)*(b&M);
  lh = (a&M)*(b>>(n&(sizeof(br_word_t)*8-1)));
  hl = (a>>(n&(sizeof(br_word_t)*8-1)))*(b&M);
  hh = (a>>(n&(sizeof(br_word_t)*8-1)))*(b>>(n&(sizeof(br_word_t)*8-1)));
  second_halfword_w_oflow = ((ll>>(n&(sizeof(br_word_t)*8-1)))+(lh&M))+(hl&M);
  high = ((hh+(lh>>(n&(sizeof(br_word_t)*8-1))))+(hl>>(n&(sizeof(br_word_t)*8-1))))+(second_halfword_w_oflow>>(n&(sizeof(br_word_t)*8-1)));
  low = (second_halfword_w_oflow<<(n&(sizeof(br_word_t)*8-1)))+(ll&M);
  *_low = low;
  return high;
}

static inline br_word_t br_value_barrier(br_word_t a) {
  /*skip*/
  return a;
}

static inline br_word_t br_declassify(br_word_t a) {
  /*skip*/
  return a;
}

static inline br_word_t br_broadcast_negative(br_word_t x) {
  br_word_t y;
  y = (br_word_t)((br_signed_t)x>>((((0u-(br_word_t)1)>>27)&63)&(sizeof(br_word_t)*8-1)));
  y = br_value_barrier(y);
  return y;
}

static inline br_word_t br_broadcast_nonzero(br_word_t x) {
  br_word_t y;
  y = br_broadcast_negative(x|(0u-x));
  return y;
}

static inline br_word_t br_cmov(br_word_t c, br_word_t vnz, br_word_t vz) {
  br_word_t r, m;
  m = br_broadcast_nonzero(c);
  r = (m&vnz)|((~m)&vz);
  return r;
}
