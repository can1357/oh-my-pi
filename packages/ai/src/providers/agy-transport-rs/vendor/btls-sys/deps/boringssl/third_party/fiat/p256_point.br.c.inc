// Generated from Bedrock code in Fiat Cryptography. Avoid editing directly.

static inline br_word_t br_broadcast_odd(br_word_t x) {
  br_word_t y;
  x = br_value_barrier(x&1);
  y = 0u-x;
  return y;
}

static inline void p256_coord_halve(br_word_t y, br_word_t x) {
  br_word_t m, mmh;
  uint8_t _br_stackalloc_mmh[32] = {0}; mmh = (br_word_t)&_br_stackalloc_mmh;
  m = br_broadcast_odd(_br_load(x));
  u256_set_p256_minushalf_conditional(mmh, m);
  u256_shr(y, x, (br_word_t)1);
  p256_coord_sub(y, y, mmh);
}

static inline br_word_t p256_point_iszero(br_word_t p_P) {
  br_word_t z, nz;
  nz = p256_coord_nonzero((p_P+32)+32);
  z = ~nz;
  return z;
}

static inline void p256_point_double(br_word_t out, br_word_t in1) {
  br_word_t t2, tmp, A, D;
  uint8_t _br_stackalloc_D[32] = {0}; D = (br_word_t)&_br_stackalloc_D;
  uint8_t _br_stackalloc_A[32] = {0}; A = (br_word_t)&_br_stackalloc_A;
  uint8_t _br_stackalloc_tmp[32] = {0}; tmp = (br_word_t)&_br_stackalloc_tmp;
  p256_coord_add(D, in1+32, in1+32);
  p256_coord_sqr(tmp, (in1+32)+32);
  p256_coord_sqr(D, D);
  p256_coord_mul((out+32)+32, (in1+32)+32, in1+32);
  p256_coord_add((out+32)+32, (out+32)+32, (out+32)+32);
  p256_coord_add(A, in1, tmp);
  p256_coord_sub(tmp, in1, tmp);
  uint8_t _br_stackalloc_t2[32] = {0}; t2 = (br_word_t)&_br_stackalloc_t2;
  p256_coord_add(t2, tmp, tmp);
  p256_coord_add(tmp, t2, tmp);
  p256_coord_sqr(out+32, D);
  p256_coord_mul(A, A, tmp);
  p256_coord_mul(D, D, in1);
  p256_coord_sqr(out, A);
  p256_coord_add(tmp, D, D);
  p256_coord_sub(out, out, tmp);
  p256_coord_sub(D, D, out);
  p256_coord_mul(D, D, A);
  p256_coord_halve(out+32, out+32);
  p256_coord_sub(out+32, D, out+32);
}

static inline br_word_t p256_point_add_nz_nz_neq(br_word_t p_out, br_word_t p_P, br_word_t p_Q) {
  br_word_t z1z1, z2z2, u1, Hsqr, ok, different_x, different_y, u2, Hcub, s1, r, h, s2;
  uint8_t _br_stackalloc_z1z1[32] = {0}; z1z1 = (br_word_t)&_br_stackalloc_z1z1;
  uint8_t _br_stackalloc_z2z2[32] = {0}; z2z2 = (br_word_t)&_br_stackalloc_z2z2;
  uint8_t _br_stackalloc_u1[32] = {0}; u1 = (br_word_t)&_br_stackalloc_u1;
  uint8_t _br_stackalloc_u2[32] = {0}; u2 = (br_word_t)&_br_stackalloc_u2;
  uint8_t _br_stackalloc_h[32] = {0}; h = (br_word_t)&_br_stackalloc_h;
  uint8_t _br_stackalloc_s1[32] = {0}; s1 = (br_word_t)&_br_stackalloc_s1;
  uint8_t _br_stackalloc_s2[32] = {0}; s2 = (br_word_t)&_br_stackalloc_s2;
  uint8_t _br_stackalloc_r[32] = {0}; r = (br_word_t)&_br_stackalloc_r;
  uint8_t _br_stackalloc_Hsqr[32] = {0}; Hsqr = (br_word_t)&_br_stackalloc_Hsqr;
  uint8_t _br_stackalloc_Hcub[32] = {0}; Hcub = (br_word_t)&_br_stackalloc_Hcub;
  p256_coord_sqr(z1z1, (p_P+32)+32);
  p256_coord_mul(u2, p_Q, z1z1);
  p256_coord_sqr(z2z2, (p_Q+32)+32);
  p256_coord_mul(u1, p_P, z2z2);
  p256_coord_sub(h, u2, u1);
  p256_coord_mul(s2, (p_P+32)+32, z1z1);
  p256_coord_mul((p_out+32)+32, h, (p_P+32)+32);
  p256_coord_mul((p_out+32)+32, (p_out+32)+32, (p_Q+32)+32);
  p256_coord_mul(s2, s2, p_Q+32);
  p256_coord_mul(s1, (p_Q+32)+32, z2z2);
  p256_coord_mul(s1, s1, p_P+32);
  p256_coord_sub(r, s2, s1);
  p256_coord_sqr(Hsqr, h);
  p256_coord_sqr(p_out, r);
  p256_coord_mul(Hcub, Hsqr, h);
  p256_coord_mul(u2, u1, Hsqr);
  different_x = p256_coord_nonzero(Hcub);
  different_y = p256_coord_nonzero(p_out);
  ok = br_value_barrier(different_x|different_y);
  p256_coord_sub(p_out, p_out, Hcub);
  p256_coord_sub(p_out, p_out, u2);
  p256_coord_sub(p_out, p_out, u2);
  p256_coord_sub(h, u2, p_out);
  p256_coord_mul(s2, Hcub, s1);
  p256_coord_mul(h, h, r);
  p256_coord_sub(p_out+32, h, s2);
  return ok;
}

static inline void p256_point_add_vartime_if_doubling(br_word_t p_out, br_word_t p_P, br_word_t p_Q) {
  br_word_t p_tmp, zeroP, zeroQ, ok, p_sel;
  zeroP = p256_point_iszero(p_P);
  zeroQ = p256_point_iszero(p_Q);
  uint8_t _br_stackalloc_p_tmp[96] = {0}; p_tmp = (br_word_t)&_br_stackalloc_p_tmp;
  ok = p256_point_add_nz_nz_neq(p_tmp, p_P, p_Q);
  ok = br_declassify((zeroP|zeroQ)|ok);
  uint8_t _br_stackalloc_p_sel[96] = {0}; p_sel = (br_word_t)&_br_stackalloc_p_sel;
  br_memset(p_sel, (br_word_t)0, (br_word_t)96);
  br_memcxor(p_sel, p_tmp, (br_word_t)96, (~zeroP)&(~zeroQ));
  br_memcxor(p_sel, p_P, (br_word_t)96, (~zeroP)&zeroQ);
  br_memcxor(p_sel, p_Q, (br_word_t)96, zeroP&(~zeroQ));
  if (ok) {
    /*skip*/
  } else {
    p256_point_double(p_sel, p_P);
  }
  br_memcpy(p_out, p_sel, (br_word_t)96);
}
