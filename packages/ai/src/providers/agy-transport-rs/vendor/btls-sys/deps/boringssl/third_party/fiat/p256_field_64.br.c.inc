// Generated from Bedrock code in Fiat Cryptography. Avoid editing directly.

static inline br_word_t shrd(br_word_t lo, br_word_t hi, br_word_t n) {
  br_word_t res;
  res = lo>>(n&(sizeof(br_word_t)*8-1));
  if (n) {
    res = (hi<<((((((0u-(br_word_t)1)>>27)&63)+1)-n)&(sizeof(br_word_t)*8-1)))|res;
  } else {
    /*skip*/
  }
  return res;
}

static inline void p256_coord_add(br_word_t p_out, br_word_t p_x, br_word_t p_y) {
  br_word_t r4, carry, t0, t1, t2, borrow, t3, r0, r1, r2, r3;
  carry = br_full_add(_br_load(p_x), _br_load(p_y), (br_word_t)0, &t0);
  carry = br_full_add(_br_load(p_x+8), _br_load(p_y+8), carry, &t1);
  carry = br_full_add(_br_load((p_x+8)+8), _br_load((p_y+8)+8), carry, &t2);
  carry = br_full_add(_br_load(((p_x+8)+8)+8), _br_load(((p_y+8)+8)+8), carry, &t3);
  borrow = br_full_sub(t0, (br_word_t)0xffffffffffffffff, (br_word_t)0, &r0);
  borrow = br_full_sub(t1, (br_word_t)0xffffffff, borrow, &r1);
  borrow = br_full_sub(t2, (br_word_t)0, borrow, &r2);
  borrow = br_full_sub(t3, (br_word_t)0xffffffff00000001, borrow, &r3);
  borrow = br_full_sub(carry, (br_word_t)0, borrow, &r4);
  r0 = br_cmov(borrow, t0, r0);
  r1 = br_cmov(borrow, t1, r1);
  r2 = br_cmov(borrow, t2, r2);
  r3 = br_cmov(borrow, t3, r3);
  _br_store(p_out, r0);
  _br_store(p_out+8, r1);
  _br_store((p_out+8)+8, r2);
  _br_store(((p_out+8)+8)+8, r3);
}

static inline void p256_coord_sub(br_word_t out, br_word_t x, br_word_t y) {
  br_word_t borrow, t0, t1, t2, t3, mask, carry, r0, r1, r2, r3;
  borrow = br_full_sub(_br_load(x), _br_load(y), (br_word_t)0, &t0);
  borrow = br_full_sub(_br_load(x+8), _br_load(y+8), borrow, &t1);
  borrow = br_full_sub(_br_load((x+8)+8), _br_load((y+8)+8), borrow, &t2);
  borrow = br_full_sub(_br_load(((x+8)+8)+8), _br_load(((y+8)+8)+8), borrow, &t3);
  mask = br_value_barrier(0u-borrow);
  carry = br_full_add(t0, mask, (br_word_t)0, &r0);
  carry = br_full_add(t1, mask&0xffffffff, carry, &r1);
  carry = br_full_add(t2, (br_word_t)0, carry, &r2);
  carry = br_full_add(t3, mask&0xffffffff00000001, carry, &r3);
  _br_store(out, r0);
  _br_store(out+8, r1);
  _br_store((out+8)+8, r2);
  _br_store(((out+8)+8)+8, r3);
}

static inline br_word_t p256_coord_nonzero(br_word_t p_x) {
  br_word_t nz;
  nz = br_broadcast_nonzero((((_br_load(p_x))|(_br_load(p_x+8)))|(_br_load((p_x+8)+8)))|(_br_load(((p_x+8)+8)+8)));
  return nz;
}

static inline void u256_shr(br_word_t p_out, br_word_t p_x, br_word_t n) {
  br_word_t x0, x1, x2, x3, y0, y1, y2, y3;
  x0 = _br_load(p_x);
  x1 = _br_load(p_x+8);
  x2 = _br_load((p_x+8)+8);
  x3 = _br_load(((p_x+8)+8)+8);
  y0 = shrd(x0, x1, n);
  y1 = shrd(x1, x2, n);
  y2 = shrd(x2, x3, n);
  y3 = x3>>(n&(sizeof(br_word_t)*8-1));
  _br_store(p_out, y0);
  _br_store(p_out+8, y1);
  _br_store((p_out+8)+8, y2);
  _br_store(((p_out+8)+8)+8, y3);
}

static inline void u256_set_p256_minushalf_conditional(br_word_t p_out, br_word_t mask) {
  br_word_t mh0, mh1, mh2, mh3;
  mh0 = 0u-(br_word_t)1;
  mh1 = mh0>>((br_word_t)33&(sizeof(br_word_t)*8-1));
  mh2 = mh0<<((br_word_t)63&(sizeof(br_word_t)*8-1));
  mh3 = (mh0<<((br_word_t)32&(sizeof(br_word_t)*8-1)))>>1;
  _br_store(p_out, mask&mh0);
  _br_store(p_out+8, mask&mh1);
  _br_store((p_out+8)+8, mask&mh2);
  _br_store(((p_out+8)+8)+8, mask&mh3);
}
