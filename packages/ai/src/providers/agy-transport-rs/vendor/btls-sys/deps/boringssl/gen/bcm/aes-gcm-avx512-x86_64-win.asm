; This file is generated from a similarly-named Perl script in the BoringSSL
; source tree. Do not edit by hand.

%ifidn __OUTPUT_FORMAT__, win64
default	rel
%define XMMWORD
%define YMMWORD
%define ZMMWORD
%define _CET_ENDBR

%ifdef BORINGSSL_PREFIX
%include "boringssl_prefix_symbols_nasm.inc"
%endif
section	.rdata rdata align=8
ALIGN	64


$L$bswap_mask:
	DQ	0x08090a0b0c0d0e0f,0x0001020304050607








$L$gfpoly:
	DQ	1,0xc200000000000000


$L$gfpoly_and_internal_carrybit:
	DQ	1,0xc200000000000001


$L$ctr_pattern:
	DQ	0,0
	DQ	1,0
	DQ	2,0
	DQ	3,0


$L$inc_4blocks:
	DQ	4,0

section	.text code align=64

global	gcm_init_vpclmulqdq_avx512

ALIGN	32
gcm_init_vpclmulqdq_avx512:


_CET_ENDBR

	lea	r8,[((256-64))+rcx]



	vpshufd	xmm3,XMMWORD[rdx],0x4e
















	vpshufd	xmm0,xmm3,0xd3
	vpsrad	xmm0,xmm0,31
	vpaddq	xmm3,xmm3,xmm3

	vpternlogd	xmm3,xmm0,XMMWORD[$L$gfpoly_and_internal_carrybit],0x78


	vbroadcasti32x4	zmm5,ZMMWORD[$L$gfpoly]








	vpclmulqdq	xmm0,xmm3,xmm3,0x00
	vpclmulqdq	xmm4,xmm3,xmm3,0x11
	vpclmulqdq	xmm1,xmm5,xmm0,0x01
	vpshufd	xmm0,xmm0,0x4e
	vpxor	xmm1,xmm1,xmm0
	vpclmulqdq	xmm0,xmm5,xmm1,0x01
	vpshufd	xmm1,xmm1,0x4e
	vpternlogd	xmm4,xmm1,xmm0,0x96



	vinserti128	ymm3,ymm4,xmm3,1
	vinserti128	ymm4,ymm4,xmm4,1


	vpclmulqdq	ymm0,ymm3,ymm4,0x00
	vpclmulqdq	ymm1,ymm3,ymm4,0x01
	vpclmulqdq	ymm2,ymm3,ymm4,0x10
	vpxord	ymm1,ymm1,ymm2
	vpclmulqdq	ymm2,ymm5,ymm0,0x01
	vpshufd	ymm0,ymm0,0x4e
	vpternlogd	ymm1,ymm0,ymm2,0x96
	vpclmulqdq	ymm4,ymm3,ymm4,0x11
	vpclmulqdq	ymm0,ymm5,ymm1,0x01
	vpshufd	ymm1,ymm1,0x4e
	vpternlogd	ymm4,ymm1,ymm0,0x96

	vinserti64x4	zmm3,zmm4,ymm3,1
	vshufi64x2	zmm4,zmm4,zmm4,0


	vmovdqu8	ZMMWORD[r8],zmm3




	mov	eax,3
$L$precompute_next:
	sub	r8,64
	vpclmulqdq	zmm0,zmm3,zmm4,0x00
	vpclmulqdq	zmm1,zmm3,zmm4,0x01
	vpclmulqdq	zmm2,zmm3,zmm4,0x10
	vpxord	zmm1,zmm1,zmm2
	vpclmulqdq	zmm2,zmm5,zmm0,0x01
	vpshufd	zmm0,zmm0,0x4e
	vpternlogd	zmm1,zmm0,zmm2,0x96
	vpclmulqdq	zmm3,zmm3,zmm4,0x11
	vpclmulqdq	zmm0,zmm5,zmm1,0x01
	vpshufd	zmm1,zmm1,0x4e
	vpternlogd	zmm3,zmm1,zmm0,0x96

	vmovdqu8	ZMMWORD[r8],zmm3
	dec	eax
	jnz	NEAR $L$precompute_next

	vzeroupper
	ret



global	gcm_gmult_vpclmulqdq_avx512

ALIGN	32
gcm_gmult_vpclmulqdq_avx512:

$L$SEH_begin_gcm_gmult_vpclmulqdq_avx512_1:
_CET_ENDBR
	sub	rsp,24
$L$SEH_prologue_gcm_gmult_vpclmulqdq_avx512_2:
	vmovdqa	XMMWORD[rsp],xmm6
$L$SEH_prologue_gcm_gmult_vpclmulqdq_avx512_3:

$L$SEH_endprologue_gcm_gmult_vpclmulqdq_avx512_4:

	vmovdqu	xmm0,XMMWORD[rcx]
	vmovdqu	xmm1,XMMWORD[$L$bswap_mask]
	vmovdqu	xmm2,XMMWORD[((256-16))+rdx]
	vmovdqu	xmm3,XMMWORD[$L$gfpoly]
	vpshufb	xmm0,xmm0,xmm1

	vpclmulqdq	xmm4,xmm0,xmm2,0x00
	vpclmulqdq	xmm5,xmm0,xmm2,0x01
	vpclmulqdq	xmm6,xmm0,xmm2,0x10
	vpxord	xmm5,xmm5,xmm6
	vpclmulqdq	xmm6,xmm3,xmm4,0x01
	vpshufd	xmm4,xmm4,0x4e
	vpternlogd	xmm5,xmm4,xmm6,0x96
	vpclmulqdq	xmm0,xmm0,xmm2,0x11
	vpclmulqdq	xmm4,xmm3,xmm5,0x01
	vpshufd	xmm5,xmm5,0x4e
	vpternlogd	xmm0,xmm5,xmm4,0x96


	vpshufb	xmm0,xmm0,xmm1
	vmovdqu	XMMWORD[rcx],xmm0


	vmovdqa	xmm6,XMMWORD[rsp]
	add	rsp,24
	ret
$L$SEH_end_gcm_gmult_vpclmulqdq_avx512_5:


global	gcm_ghash_vpclmulqdq_avx512

ALIGN	32
gcm_ghash_vpclmulqdq_avx512:

$L$SEH_begin_gcm_ghash_vpclmulqdq_avx512_1:
_CET_ENDBR
	sub	rsp,136
$L$SEH_prologue_gcm_ghash_vpclmulqdq_avx512_2:
	vmovdqa	XMMWORD[rsp],xmm6
$L$SEH_prologue_gcm_ghash_vpclmulqdq_avx512_3:
	vmovdqa	XMMWORD[16+rsp],xmm7
$L$SEH_prologue_gcm_ghash_vpclmulqdq_avx512_4:
	vmovdqa	XMMWORD[32+rsp],xmm8
$L$SEH_prologue_gcm_ghash_vpclmulqdq_avx512_5:
	vmovdqa	XMMWORD[48+rsp],xmm9
$L$SEH_prologue_gcm_ghash_vpclmulqdq_avx512_6:
	vmovdqa	XMMWORD[64+rsp],xmm10
$L$SEH_prologue_gcm_ghash_vpclmulqdq_avx512_7:
	vmovdqa	XMMWORD[80+rsp],xmm11
$L$SEH_prologue_gcm_ghash_vpclmulqdq_avx512_8:
	vmovdqa	XMMWORD[96+rsp],xmm12
$L$SEH_prologue_gcm_ghash_vpclmulqdq_avx512_9:
	vmovdqa	XMMWORD[112+rsp],xmm13
$L$SEH_prologue_gcm_ghash_vpclmulqdq_avx512_10:

$L$SEH_endprologue_gcm_ghash_vpclmulqdq_avx512_11:




	vmovdqu	xmm4,XMMWORD[$L$bswap_mask]
	vmovdqu	xmm10,XMMWORD[$L$gfpoly]


	vmovdqu	xmm5,XMMWORD[rcx]
	vpshufb	xmm5,xmm5,xmm4


	cmp	r9,64
	jb	NEAR $L$aad_blockbyblock



	vshufi64x2	zmm4,zmm4,zmm4,0
	vshufi64x2	zmm10,zmm10,zmm10,0


	vmovdqu8	zmm9,ZMMWORD[((256-64))+rdx]

	cmp	r9,256
	jb	NEAR $L$aad_loop_1x


	vmovdqu8	zmm6,ZMMWORD[((256-256))+rdx]
	vmovdqu8	zmm7,ZMMWORD[((256-192))+rdx]
	vmovdqu8	zmm8,ZMMWORD[((256-128))+rdx]


$L$aad_loop_4x:
	vmovdqu8	zmm0,ZMMWORD[r8]
	vmovdqu8	zmm1,ZMMWORD[64+r8]
	vmovdqu8	zmm2,ZMMWORD[128+r8]
	vmovdqu8	zmm3,ZMMWORD[192+r8]
	vpshufb	zmm0,zmm0,zmm4
	vpxord	zmm0,zmm0,zmm5
	vpshufb	zmm1,zmm1,zmm4
	vpshufb	zmm2,zmm2,zmm4
	vpshufb	zmm3,zmm3,zmm4
	vpclmulqdq	zmm5,zmm0,zmm6,0x00
	vpclmulqdq	zmm11,zmm1,zmm7,0x00
	vpclmulqdq	zmm12,zmm2,zmm8,0x00
	vpxord	zmm5,zmm5,zmm11
	vpclmulqdq	zmm13,zmm3,zmm9,0x00
	vpternlogd	zmm5,zmm12,zmm13,0x96
	vpclmulqdq	zmm11,zmm0,zmm6,0x01
	vpclmulqdq	zmm12,zmm1,zmm7,0x01
	vpclmulqdq	zmm13,zmm2,zmm8,0x01
	vpternlogd	zmm11,zmm12,zmm13,0x96
	vpclmulqdq	zmm12,zmm3,zmm9,0x01
	vpclmulqdq	zmm13,zmm0,zmm6,0x10
	vpternlogd	zmm11,zmm12,zmm13,0x96
	vpclmulqdq	zmm12,zmm1,zmm7,0x10
	vpclmulqdq	zmm13,zmm2,zmm8,0x10
	vpternlogd	zmm11,zmm12,zmm13,0x96
	vpclmulqdq	zmm13,zmm10,zmm5,0x01
	vpclmulqdq	zmm12,zmm3,zmm9,0x10
	vpxord	zmm11,zmm11,zmm12
	vpshufd	zmm5,zmm5,0x4e
	vpclmulqdq	zmm0,zmm0,zmm6,0x11
	vpclmulqdq	zmm1,zmm1,zmm7,0x11
	vpclmulqdq	zmm2,zmm2,zmm8,0x11
	vpternlogd	zmm11,zmm5,zmm13,0x96
	vpclmulqdq	zmm3,zmm3,zmm9,0x11
	vpternlogd	zmm0,zmm1,zmm2,0x96
	vpclmulqdq	zmm12,zmm10,zmm11,0x01
	vpxord	zmm5,zmm0,zmm3
	vpshufd	zmm11,zmm11,0x4e
	vpternlogd	zmm5,zmm11,zmm12,0x96
	vextracti32x4	xmm0,zmm5,1
	vextracti32x4	xmm1,zmm5,2
	vextracti32x4	xmm2,zmm5,3
	vpxord	xmm5,xmm5,xmm0
	vpternlogd	xmm5,xmm2,xmm1,0x96

	add	r8,256
	sub	r9,256
	cmp	r9,256
	jae	NEAR $L$aad_loop_4x


	cmp	r9,64
	jb	NEAR $L$aad_large_done
$L$aad_loop_1x:
	vmovdqu8	zmm0,ZMMWORD[r8]
	vpshufb	zmm0,zmm0,zmm4
	vpxord	zmm5,zmm5,zmm0
	vpclmulqdq	zmm0,zmm5,zmm9,0x00
	vpclmulqdq	zmm1,zmm5,zmm9,0x01
	vpclmulqdq	zmm2,zmm5,zmm9,0x10
	vpxord	zmm1,zmm1,zmm2
	vpclmulqdq	zmm2,zmm10,zmm0,0x01
	vpshufd	zmm0,zmm0,0x4e
	vpternlogd	zmm1,zmm0,zmm2,0x96
	vpclmulqdq	zmm5,zmm5,zmm9,0x11
	vpclmulqdq	zmm0,zmm10,zmm1,0x01
	vpshufd	zmm1,zmm1,0x4e
	vpternlogd	zmm5,zmm1,zmm0,0x96

	vextracti32x4	xmm0,zmm5,1
	vextracti32x4	xmm1,zmm5,2
	vextracti32x4	xmm2,zmm5,3
	vpxord	xmm5,xmm5,xmm0
	vpternlogd	xmm5,xmm2,xmm1,0x96

	add	r8,64
	sub	r9,64
	cmp	r9,64
	jae	NEAR $L$aad_loop_1x

$L$aad_large_done:


$L$aad_blockbyblock:
	test	r9,r9
	jz	NEAR $L$aad_done
	vmovdqu	xmm9,XMMWORD[((256-16))+rdx]
$L$aad_loop_blockbyblock:
	vmovdqu	xmm0,XMMWORD[r8]
	vpshufb	xmm0,xmm0,xmm4
	vpxor	xmm5,xmm5,xmm0
	vpclmulqdq	xmm0,xmm5,xmm9,0x00
	vpclmulqdq	xmm1,xmm5,xmm9,0x01
	vpclmulqdq	xmm2,xmm5,xmm9,0x10
	vpxord	xmm1,xmm1,xmm2
	vpclmulqdq	xmm2,xmm10,xmm0,0x01
	vpshufd	xmm0,xmm0,0x4e
	vpternlogd	xmm1,xmm0,xmm2,0x96
	vpclmulqdq	xmm5,xmm5,xmm9,0x11
	vpclmulqdq	xmm0,xmm10,xmm1,0x01
	vpshufd	xmm1,xmm1,0x4e
	vpternlogd	xmm5,xmm1,xmm0,0x96

	add	r8,16
	sub	r9,16
	jnz	NEAR $L$aad_loop_blockbyblock

$L$aad_done:

	vpshufb	xmm5,xmm5,xmm4
	vmovdqu	XMMWORD[rcx],xmm5

	vzeroupper
	vmovdqa	xmm6,XMMWORD[rsp]
	vmovdqa	xmm7,XMMWORD[16+rsp]
	vmovdqa	xmm8,XMMWORD[32+rsp]
	vmovdqa	xmm9,XMMWORD[48+rsp]
	vmovdqa	xmm10,XMMWORD[64+rsp]
	vmovdqa	xmm11,XMMWORD[80+rsp]
	vmovdqa	xmm12,XMMWORD[96+rsp]
	vmovdqa	xmm13,XMMWORD[112+rsp]
	add	rsp,136
	ret
$L$SEH_end_gcm_ghash_vpclmulqdq_avx512_12:


global	aes_gcm_enc_update_vaes_avx512

ALIGN	32
aes_gcm_enc_update_vaes_avx512:

$L$SEH_begin_aes_gcm_enc_update_vaes_avx512_1:
_CET_ENDBR
	push	rsi
$L$SEH_prologue_aes_gcm_enc_update_vaes_avx512_2:
	push	rdi
$L$SEH_prologue_aes_gcm_enc_update_vaes_avx512_3:
	push	r12
$L$SEH_prologue_aes_gcm_enc_update_vaes_avx512_4:

	mov	rsi,QWORD[64+rsp]
	mov	rdi,QWORD[72+rsp]
	mov	r12,QWORD[80+rsp]
	sub	rsp,160
$L$SEH_prologue_aes_gcm_enc_update_vaes_avx512_5:
	vmovdqa	XMMWORD[rsp],xmm6
$L$SEH_prologue_aes_gcm_enc_update_vaes_avx512_6:
	vmovdqa	XMMWORD[16+rsp],xmm7
$L$SEH_prologue_aes_gcm_enc_update_vaes_avx512_7:
	vmovdqa	XMMWORD[32+rsp],xmm8
$L$SEH_prologue_aes_gcm_enc_update_vaes_avx512_8:
	vmovdqa	XMMWORD[48+rsp],xmm9
$L$SEH_prologue_aes_gcm_enc_update_vaes_avx512_9:
	vmovdqa	XMMWORD[64+rsp],xmm10
$L$SEH_prologue_aes_gcm_enc_update_vaes_avx512_10:
	vmovdqa	XMMWORD[80+rsp],xmm11
$L$SEH_prologue_aes_gcm_enc_update_vaes_avx512_11:
	vmovdqa	XMMWORD[96+rsp],xmm12
$L$SEH_prologue_aes_gcm_enc_update_vaes_avx512_12:
	vmovdqa	XMMWORD[112+rsp],xmm13
$L$SEH_prologue_aes_gcm_enc_update_vaes_avx512_13:
	vmovdqa	XMMWORD[128+rsp],xmm14
$L$SEH_prologue_aes_gcm_enc_update_vaes_avx512_14:
	vmovdqa	XMMWORD[144+rsp],xmm15
$L$SEH_prologue_aes_gcm_enc_update_vaes_avx512_15:

$L$SEH_endprologue_aes_gcm_enc_update_vaes_avx512_16:
%ifdef BORINGSSL_DISPATCH_TEST
EXTERN	BORINGSSL_function_hit
	mov	BYTE[((BORINGSSL_function_hit+7))],1
%endif

	vbroadcasti32x4	zmm8,ZMMWORD[$L$bswap_mask]
	vbroadcasti32x4	zmm31,ZMMWORD[$L$gfpoly]



	vmovdqu	xmm10,XMMWORD[r12]
	vpshufb	xmm10,xmm10,xmm8
	vbroadcasti32x4	zmm12,ZMMWORD[rsi]
	vpshufb	zmm12,zmm12,zmm8



	mov	r10d,DWORD[240+r9]
	lea	r10d,[((-20))+r10*4]




	lea	r11,[96+r10*4+r9]
	vbroadcasti32x4	zmm13,ZMMWORD[r9]
	vbroadcasti32x4	zmm14,ZMMWORD[r11]


	vpaddd	zmm12,zmm12,ZMMWORD[$L$ctr_pattern]


	vbroadcasti32x4	zmm11,ZMMWORD[$L$inc_4blocks]



	cmp	r8,256
	jb	NEAR $L$crypt_loop_4x_done__func1


	vmovdqu8	zmm27,ZMMWORD[((256-256))+rdi]
	vmovdqu8	zmm28,ZMMWORD[((256-192))+rdi]
	vmovdqu8	zmm29,ZMMWORD[((256-128))+rdi]
	vmovdqu8	zmm30,ZMMWORD[((256-64))+rdi]




	vpshufb	zmm0,zmm12,zmm8
	vpaddd	zmm12,zmm12,zmm11
	vpshufb	zmm1,zmm12,zmm8
	vpaddd	zmm12,zmm12,zmm11
	vpshufb	zmm2,zmm12,zmm8
	vpaddd	zmm12,zmm12,zmm11
	vpshufb	zmm3,zmm12,zmm8
	vpaddd	zmm12,zmm12,zmm11


	vpxord	zmm0,zmm0,zmm13
	vpxord	zmm1,zmm1,zmm13
	vpxord	zmm2,zmm2,zmm13
	vpxord	zmm3,zmm3,zmm13

	lea	rax,[16+r9]
$L$vaesenc_loop_first_4_vecs__func1:
	vbroadcasti32x4	zmm9,ZMMWORD[rax]
	vaesenc	zmm0,zmm0,zmm9
	vaesenc	zmm1,zmm1,zmm9
	vaesenc	zmm2,zmm2,zmm9
	vaesenc	zmm3,zmm3,zmm9

	add	rax,16
	cmp	r11,rax
	jne	NEAR $L$vaesenc_loop_first_4_vecs__func1
	vpxord	zmm4,zmm14,ZMMWORD[rcx]
	vpxord	zmm5,zmm14,ZMMWORD[64+rcx]
	vpxord	zmm6,zmm14,ZMMWORD[128+rcx]
	vpxord	zmm7,zmm14,ZMMWORD[192+rcx]
	vaesenclast	zmm4,zmm0,zmm4
	vaesenclast	zmm5,zmm1,zmm5
	vaesenclast	zmm6,zmm2,zmm6
	vaesenclast	zmm7,zmm3,zmm7
	vmovdqu8	ZMMWORD[rdx],zmm4
	vmovdqu8	ZMMWORD[64+rdx],zmm5
	vmovdqu8	ZMMWORD[128+rdx],zmm6
	vmovdqu8	ZMMWORD[192+rdx],zmm7

	add	rcx,256
	add	rdx,256
	sub	r8,256
	cmp	r8,256
	jb	NEAR $L$ghash_last_ciphertext_4x__func1

	vbroadcasti32x4	zmm15,ZMMWORD[((-144))+r11]
	vbroadcasti32x4	zmm16,ZMMWORD[((-128))+r11]
	vbroadcasti32x4	zmm17,ZMMWORD[((-112))+r11]
	vbroadcasti32x4	zmm18,ZMMWORD[((-96))+r11]
	vbroadcasti32x4	zmm19,ZMMWORD[((-80))+r11]
	vbroadcasti32x4	zmm20,ZMMWORD[((-64))+r11]
	vbroadcasti32x4	zmm21,ZMMWORD[((-48))+r11]
	vbroadcasti32x4	zmm22,ZMMWORD[((-32))+r11]
	vbroadcasti32x4	zmm23,ZMMWORD[((-16))+r11]

$L$crypt_loop_4x__func1:



	vpshufb	zmm0,zmm12,zmm8
	vpaddd	zmm12,zmm12,zmm11
	vpshufb	zmm1,zmm12,zmm8
	vpaddd	zmm12,zmm12,zmm11
	vpshufb	zmm2,zmm12,zmm8
	vpaddd	zmm12,zmm12,zmm11
	vpshufb	zmm3,zmm12,zmm8
	vpaddd	zmm12,zmm12,zmm11


	vpxord	zmm0,zmm0,zmm13
	vpxord	zmm1,zmm1,zmm13
	vpxord	zmm2,zmm2,zmm13
	vpxord	zmm3,zmm3,zmm13

	cmp	r10d,24
	jl	NEAR $L$aes128__func1
	je	NEAR $L$aes192__func1

	vbroadcasti32x4	zmm9,ZMMWORD[((-208))+r11]
	vaesenc	zmm0,zmm0,zmm9
	vaesenc	zmm1,zmm1,zmm9
	vaesenc	zmm2,zmm2,zmm9
	vaesenc	zmm3,zmm3,zmm9

	vbroadcasti32x4	zmm9,ZMMWORD[((-192))+r11]
	vaesenc	zmm0,zmm0,zmm9
	vaesenc	zmm1,zmm1,zmm9
	vaesenc	zmm2,zmm2,zmm9
	vaesenc	zmm3,zmm3,zmm9

$L$aes192__func1:
	vbroadcasti32x4	zmm9,ZMMWORD[((-176))+r11]
	vaesenc	zmm0,zmm0,zmm9
	vaesenc	zmm1,zmm1,zmm9
	vaesenc	zmm2,zmm2,zmm9
	vaesenc	zmm3,zmm3,zmm9

	vbroadcasti32x4	zmm9,ZMMWORD[((-160))+r11]
	vaesenc	zmm0,zmm0,zmm9
	vaesenc	zmm1,zmm1,zmm9
	vaesenc	zmm2,zmm2,zmm9
	vaesenc	zmm3,zmm3,zmm9

$L$aes128__func1:




	prefetcht0	[((512+0))+rcx]
	prefetcht0	[((512+64))+rcx]
	prefetcht0	[((512+128))+rcx]
	prefetcht0	[((512+192))+rcx]




	vpshufb	zmm4,zmm4,zmm8
	vpxord	zmm4,zmm4,zmm10
	vpshufb	zmm5,zmm5,zmm8
	vpshufb	zmm6,zmm6,zmm8

	vaesenc	zmm0,zmm0,zmm15
	vaesenc	zmm1,zmm1,zmm15
	vaesenc	zmm2,zmm2,zmm15
	vaesenc	zmm3,zmm3,zmm15

	vpshufb	zmm7,zmm7,zmm8
	vpclmulqdq	zmm10,zmm4,zmm27,0x00
	vpclmulqdq	zmm24,zmm5,zmm28,0x00
	vpclmulqdq	zmm25,zmm6,zmm29,0x00

	vaesenc	zmm0,zmm0,zmm16
	vaesenc	zmm1,zmm1,zmm16
	vaesenc	zmm2,zmm2,zmm16
	vaesenc	zmm3,zmm3,zmm16

	vpxord	zmm10,zmm10,zmm24
	vpclmulqdq	zmm26,zmm7,zmm30,0x00
	vpternlogd	zmm10,zmm25,zmm26,0x96
	vpclmulqdq	zmm24,zmm4,zmm27,0x01

	vaesenc	zmm0,zmm0,zmm17
	vaesenc	zmm1,zmm1,zmm17
	vaesenc	zmm2,zmm2,zmm17
	vaesenc	zmm3,zmm3,zmm17

	vpclmulqdq	zmm25,zmm5,zmm28,0x01
	vpclmulqdq	zmm26,zmm6,zmm29,0x01
	vpternlogd	zmm24,zmm25,zmm26,0x96
	vpclmulqdq	zmm25,zmm7,zmm30,0x01

	vaesenc	zmm0,zmm0,zmm18
	vaesenc	zmm1,zmm1,zmm18
	vaesenc	zmm2,zmm2,zmm18
	vaesenc	zmm3,zmm3,zmm18

	vpclmulqdq	zmm26,zmm4,zmm27,0x10
	vpternlogd	zmm24,zmm25,zmm26,0x96
	vpclmulqdq	zmm25,zmm5,zmm28,0x10
	vpclmulqdq	zmm26,zmm6,zmm29,0x10

	vaesenc	zmm0,zmm0,zmm19
	vaesenc	zmm1,zmm1,zmm19
	vaesenc	zmm2,zmm2,zmm19
	vaesenc	zmm3,zmm3,zmm19

	vpternlogd	zmm24,zmm25,zmm26,0x96
	vpclmulqdq	zmm26,zmm31,zmm10,0x01
	vpclmulqdq	zmm25,zmm7,zmm30,0x10
	vpxord	zmm24,zmm24,zmm25

	vaesenc	zmm0,zmm0,zmm20
	vaesenc	zmm1,zmm1,zmm20
	vaesenc	zmm2,zmm2,zmm20
	vaesenc	zmm3,zmm3,zmm20

	vpshufd	zmm10,zmm10,0x4e
	vpclmulqdq	zmm4,zmm4,zmm27,0x11
	vpclmulqdq	zmm5,zmm5,zmm28,0x11
	vpclmulqdq	zmm6,zmm6,zmm29,0x11

	vaesenc	zmm0,zmm0,zmm21
	vaesenc	zmm1,zmm1,zmm21
	vaesenc	zmm2,zmm2,zmm21
	vaesenc	zmm3,zmm3,zmm21

	vpternlogd	zmm24,zmm10,zmm26,0x96
	vpclmulqdq	zmm7,zmm7,zmm30,0x11
	vpternlogd	zmm4,zmm5,zmm6,0x96
	vpclmulqdq	zmm25,zmm31,zmm24,0x01

	vaesenc	zmm0,zmm0,zmm22
	vaesenc	zmm1,zmm1,zmm22
	vaesenc	zmm2,zmm2,zmm22
	vaesenc	zmm3,zmm3,zmm22

	vpxord	zmm10,zmm4,zmm7
	vpshufd	zmm24,zmm24,0x4e
	vpternlogd	zmm10,zmm24,zmm25,0x96

	vaesenc	zmm0,zmm0,zmm23
	vaesenc	zmm1,zmm1,zmm23
	vaesenc	zmm2,zmm2,zmm23
	vaesenc	zmm3,zmm3,zmm23


	vextracti32x4	xmm4,zmm10,1
	vextracti32x4	xmm5,zmm10,2
	vextracti32x4	xmm6,zmm10,3
	vpxord	xmm10,xmm10,xmm4
	vpternlogd	xmm10,xmm6,xmm5,0x96

	vpxord	zmm4,zmm14,ZMMWORD[rcx]
	vpxord	zmm5,zmm14,ZMMWORD[64+rcx]
	vpxord	zmm6,zmm14,ZMMWORD[128+rcx]
	vpxord	zmm7,zmm14,ZMMWORD[192+rcx]
	vaesenclast	zmm4,zmm0,zmm4
	vaesenclast	zmm5,zmm1,zmm5
	vaesenclast	zmm6,zmm2,zmm6
	vaesenclast	zmm7,zmm3,zmm7
	vmovdqu8	ZMMWORD[rdx],zmm4
	vmovdqu8	ZMMWORD[64+rdx],zmm5
	vmovdqu8	ZMMWORD[128+rdx],zmm6
	vmovdqu8	ZMMWORD[192+rdx],zmm7

	add	rcx,256
	add	rdx,256
	sub	r8,256
	cmp	r8,256
	jae	NEAR $L$crypt_loop_4x__func1
$L$ghash_last_ciphertext_4x__func1:
	vpshufb	zmm4,zmm4,zmm8
	vpxord	zmm4,zmm4,zmm10
	vpshufb	zmm5,zmm5,zmm8
	vpshufb	zmm6,zmm6,zmm8
	vpshufb	zmm7,zmm7,zmm8
	vpclmulqdq	zmm10,zmm4,zmm27,0x00
	vpclmulqdq	zmm24,zmm5,zmm28,0x00
	vpclmulqdq	zmm25,zmm6,zmm29,0x00
	vpxord	zmm10,zmm10,zmm24
	vpclmulqdq	zmm26,zmm7,zmm30,0x00
	vpternlogd	zmm10,zmm25,zmm26,0x96
	vpclmulqdq	zmm24,zmm4,zmm27,0x01
	vpclmulqdq	zmm25,zmm5,zmm28,0x01
	vpclmulqdq	zmm26,zmm6,zmm29,0x01
	vpternlogd	zmm24,zmm25,zmm26,0x96
	vpclmulqdq	zmm25,zmm7,zmm30,0x01
	vpclmulqdq	zmm26,zmm4,zmm27,0x10
	vpternlogd	zmm24,zmm25,zmm26,0x96
	vpclmulqdq	zmm25,zmm5,zmm28,0x10
	vpclmulqdq	zmm26,zmm6,zmm29,0x10
	vpternlogd	zmm24,zmm25,zmm26,0x96
	vpclmulqdq	zmm26,zmm31,zmm10,0x01
	vpclmulqdq	zmm25,zmm7,zmm30,0x10
	vpxord	zmm24,zmm24,zmm25
	vpshufd	zmm10,zmm10,0x4e
	vpclmulqdq	zmm4,zmm4,zmm27,0x11
	vpclmulqdq	zmm5,zmm5,zmm28,0x11
	vpclmulqdq	zmm6,zmm6,zmm29,0x11
	vpternlogd	zmm24,zmm10,zmm26,0x96
	vpclmulqdq	zmm7,zmm7,zmm30,0x11
	vpternlogd	zmm4,zmm5,zmm6,0x96
	vpclmulqdq	zmm25,zmm31,zmm24,0x01
	vpxord	zmm10,zmm4,zmm7
	vpshufd	zmm24,zmm24,0x4e
	vpternlogd	zmm10,zmm24,zmm25,0x96
	vextracti32x4	xmm4,zmm10,1
	vextracti32x4	xmm5,zmm10,2
	vextracti32x4	xmm6,zmm10,3
	vpxord	xmm10,xmm10,xmm4
	vpternlogd	xmm10,xmm6,xmm5,0x96

$L$crypt_loop_4x_done__func1:

	test	r8,r8
	jz	NEAR $L$done__func1




















	mov	rax,r8
	neg	rax
	and	rax,-16
	lea	rsi,[256+rax*1+rdi]
	vpxor	xmm4,xmm4,xmm4
	vpxor	xmm5,xmm5,xmm5
	vpxor	xmm6,xmm6,xmm6

	cmp	r8,64
	jb	NEAR $L$partial_vec__func1

$L$crypt_loop_1x__func1:



	vpshufb	zmm0,zmm12,zmm8
	vpaddd	zmm12,zmm12,zmm11
	vpxord	zmm0,zmm0,zmm13
	lea	rax,[16+r9]
$L$vaesenc_loop_tail_full_vec__func1:
	vbroadcasti32x4	zmm9,ZMMWORD[rax]
	vaesenc	zmm0,zmm0,zmm9
	add	rax,16
	cmp	r11,rax
	jne	NEAR $L$vaesenc_loop_tail_full_vec__func1
	vaesenclast	zmm0,zmm0,zmm14


	vmovdqu8	zmm1,ZMMWORD[rcx]
	vpxord	zmm0,zmm0,zmm1
	vmovdqu8	ZMMWORD[rdx],zmm0


	vmovdqu8	zmm30,ZMMWORD[rsi]
	vpshufb	zmm0,zmm0,zmm8
	vpxord	zmm0,zmm0,zmm10
	vpclmulqdq	zmm7,zmm0,zmm30,0x00
	vpclmulqdq	zmm1,zmm0,zmm30,0x01
	vpclmulqdq	zmm2,zmm0,zmm30,0x10
	vpclmulqdq	zmm3,zmm0,zmm30,0x11
	vpxord	zmm4,zmm4,zmm7
	vpternlogd	zmm5,zmm1,zmm2,0x96
	vpxord	zmm6,zmm6,zmm3

	vpxor	xmm10,xmm10,xmm10

	add	rsi,64
	add	rcx,64
	add	rdx,64
	sub	r8,64
	cmp	r8,64
	jae	NEAR $L$crypt_loop_1x__func1

	test	r8,r8
	jz	NEAR $L$reduce__func1

$L$partial_vec__func1:




	mov	rax,-1
	bzhi	rax,rax,r8
	kmovq	k1,rax
	add	r8,15
	and	r8,-16
	mov	rax,-1
	bzhi	rax,rax,r8
	kmovq	k2,rax



	vpshufb	zmm0,zmm12,zmm8
	vpxord	zmm0,zmm0,zmm13
	lea	rax,[16+r9]
$L$vaesenc_loop_tail_partialvec__func1:
	vbroadcasti32x4	zmm9,ZMMWORD[rax]
	vaesenc	zmm0,zmm0,zmm9
	add	rax,16
	cmp	r11,rax
	jne	NEAR $L$vaesenc_loop_tail_partialvec__func1
	vaesenclast	zmm0,zmm0,zmm14


	vmovdqu8	zmm1{k1}{z},[rcx]
	vpxord	zmm0,zmm0,zmm1
	vmovdqu8	ZMMWORD[rdx]{k1},zmm0













	vmovdqu8	zmm30{k2}{z},[rsi]
	vmovdqu8	zmm1{k1}{z},zmm0
	vpshufb	zmm0,zmm1,zmm8
	vpxord	zmm0,zmm0,zmm10
	vpclmulqdq	zmm7,zmm0,zmm30,0x00
	vpclmulqdq	zmm1,zmm0,zmm30,0x01
	vpclmulqdq	zmm2,zmm0,zmm30,0x10
	vpclmulqdq	zmm3,zmm0,zmm30,0x11
	vpxord	zmm4,zmm4,zmm7
	vpternlogd	zmm5,zmm1,zmm2,0x96
	vpxord	zmm6,zmm6,zmm3


$L$reduce__func1:

	vpclmulqdq	zmm0,zmm31,zmm4,0x01
	vpshufd	zmm4,zmm4,0x4e
	vpternlogd	zmm5,zmm4,zmm0,0x96
	vpclmulqdq	zmm0,zmm31,zmm5,0x01
	vpshufd	zmm5,zmm5,0x4e
	vpternlogd	zmm6,zmm5,zmm0,0x96

	vextracti32x4	xmm0,zmm6,1
	vextracti32x4	xmm1,zmm6,2
	vextracti32x4	xmm2,zmm6,3
	vpxord	xmm10,xmm6,xmm0
	vpternlogd	xmm10,xmm2,xmm1,0x96


$L$done__func1:

	vpshufb	xmm10,xmm10,xmm8
	vmovdqu	XMMWORD[r12],xmm10

	vzeroupper
	vmovdqa	xmm6,XMMWORD[rsp]
	vmovdqa	xmm7,XMMWORD[16+rsp]
	vmovdqa	xmm8,XMMWORD[32+rsp]
	vmovdqa	xmm9,XMMWORD[48+rsp]
	vmovdqa	xmm10,XMMWORD[64+rsp]
	vmovdqa	xmm11,XMMWORD[80+rsp]
	vmovdqa	xmm12,XMMWORD[96+rsp]
	vmovdqa	xmm13,XMMWORD[112+rsp]
	vmovdqa	xmm14,XMMWORD[128+rsp]
	vmovdqa	xmm15,XMMWORD[144+rsp]
	add	rsp,160
	pop	r12
	pop	rdi
	pop	rsi
	ret
$L$SEH_end_aes_gcm_enc_update_vaes_avx512_17:


global	aes_gcm_dec_update_vaes_avx512

ALIGN	32
aes_gcm_dec_update_vaes_avx512:

$L$SEH_begin_aes_gcm_dec_update_vaes_avx512_1:
_CET_ENDBR
	push	rsi
$L$SEH_prologue_aes_gcm_dec_update_vaes_avx512_2:
	push	rdi
$L$SEH_prologue_aes_gcm_dec_update_vaes_avx512_3:
	push	r12
$L$SEH_prologue_aes_gcm_dec_update_vaes_avx512_4:

	mov	rsi,QWORD[64+rsp]
	mov	rdi,QWORD[72+rsp]
	mov	r12,QWORD[80+rsp]
	sub	rsp,160
$L$SEH_prologue_aes_gcm_dec_update_vaes_avx512_5:
	vmovdqa	XMMWORD[rsp],xmm6
$L$SEH_prologue_aes_gcm_dec_update_vaes_avx512_6:
	vmovdqa	XMMWORD[16+rsp],xmm7
$L$SEH_prologue_aes_gcm_dec_update_vaes_avx512_7:
	vmovdqa	XMMWORD[32+rsp],xmm8
$L$SEH_prologue_aes_gcm_dec_update_vaes_avx512_8:
	vmovdqa	XMMWORD[48+rsp],xmm9
$L$SEH_prologue_aes_gcm_dec_update_vaes_avx512_9:
	vmovdqa	XMMWORD[64+rsp],xmm10
$L$SEH_prologue_aes_gcm_dec_update_vaes_avx512_10:
	vmovdqa	XMMWORD[80+rsp],xmm11
$L$SEH_prologue_aes_gcm_dec_update_vaes_avx512_11:
	vmovdqa	XMMWORD[96+rsp],xmm12
$L$SEH_prologue_aes_gcm_dec_update_vaes_avx512_12:
	vmovdqa	XMMWORD[112+rsp],xmm13
$L$SEH_prologue_aes_gcm_dec_update_vaes_avx512_13:
	vmovdqa	XMMWORD[128+rsp],xmm14
$L$SEH_prologue_aes_gcm_dec_update_vaes_avx512_14:
	vmovdqa	XMMWORD[144+rsp],xmm15
$L$SEH_prologue_aes_gcm_dec_update_vaes_avx512_15:

$L$SEH_endprologue_aes_gcm_dec_update_vaes_avx512_16:

	vbroadcasti32x4	zmm8,ZMMWORD[$L$bswap_mask]
	vbroadcasti32x4	zmm31,ZMMWORD[$L$gfpoly]



	vmovdqu	xmm10,XMMWORD[r12]
	vpshufb	xmm10,xmm10,xmm8
	vbroadcasti32x4	zmm12,ZMMWORD[rsi]
	vpshufb	zmm12,zmm12,zmm8



	mov	r10d,DWORD[240+r9]
	lea	r10d,[((-20))+r10*4]




	lea	r11,[96+r10*4+r9]
	vbroadcasti32x4	zmm13,ZMMWORD[r9]
	vbroadcasti32x4	zmm14,ZMMWORD[r11]


	vpaddd	zmm12,zmm12,ZMMWORD[$L$ctr_pattern]


	vbroadcasti32x4	zmm11,ZMMWORD[$L$inc_4blocks]



	cmp	r8,256
	jb	NEAR $L$crypt_loop_4x_done__func2


	vmovdqu8	zmm27,ZMMWORD[((256-256))+rdi]
	vmovdqu8	zmm28,ZMMWORD[((256-192))+rdi]
	vmovdqu8	zmm29,ZMMWORD[((256-128))+rdi]
	vmovdqu8	zmm30,ZMMWORD[((256-64))+rdi]

	vbroadcasti32x4	zmm15,ZMMWORD[((-144))+r11]
	vbroadcasti32x4	zmm16,ZMMWORD[((-128))+r11]
	vbroadcasti32x4	zmm17,ZMMWORD[((-112))+r11]
	vbroadcasti32x4	zmm18,ZMMWORD[((-96))+r11]
	vbroadcasti32x4	zmm19,ZMMWORD[((-80))+r11]
	vbroadcasti32x4	zmm20,ZMMWORD[((-64))+r11]
	vbroadcasti32x4	zmm21,ZMMWORD[((-48))+r11]
	vbroadcasti32x4	zmm22,ZMMWORD[((-32))+r11]
	vbroadcasti32x4	zmm23,ZMMWORD[((-16))+r11]

$L$crypt_loop_4x__func2:
	vmovdqu8	zmm4,ZMMWORD[rcx]
	vmovdqu8	zmm5,ZMMWORD[64+rcx]
	vmovdqu8	zmm6,ZMMWORD[128+rcx]
	vmovdqu8	zmm7,ZMMWORD[192+rcx]



	vpshufb	zmm0,zmm12,zmm8
	vpaddd	zmm12,zmm12,zmm11
	vpshufb	zmm1,zmm12,zmm8
	vpaddd	zmm12,zmm12,zmm11
	vpshufb	zmm2,zmm12,zmm8
	vpaddd	zmm12,zmm12,zmm11
	vpshufb	zmm3,zmm12,zmm8
	vpaddd	zmm12,zmm12,zmm11


	vpxord	zmm0,zmm0,zmm13
	vpxord	zmm1,zmm1,zmm13
	vpxord	zmm2,zmm2,zmm13
	vpxord	zmm3,zmm3,zmm13

	cmp	r10d,24
	jl	NEAR $L$aes128__func2
	je	NEAR $L$aes192__func2

	vbroadcasti32x4	zmm9,ZMMWORD[((-208))+r11]
	vaesenc	zmm0,zmm0,zmm9
	vaesenc	zmm1,zmm1,zmm9
	vaesenc	zmm2,zmm2,zmm9
	vaesenc	zmm3,zmm3,zmm9

	vbroadcasti32x4	zmm9,ZMMWORD[((-192))+r11]
	vaesenc	zmm0,zmm0,zmm9
	vaesenc	zmm1,zmm1,zmm9
	vaesenc	zmm2,zmm2,zmm9
	vaesenc	zmm3,zmm3,zmm9

$L$aes192__func2:
	vbroadcasti32x4	zmm9,ZMMWORD[((-176))+r11]
	vaesenc	zmm0,zmm0,zmm9
	vaesenc	zmm1,zmm1,zmm9
	vaesenc	zmm2,zmm2,zmm9
	vaesenc	zmm3,zmm3,zmm9

	vbroadcasti32x4	zmm9,ZMMWORD[((-160))+r11]
	vaesenc	zmm0,zmm0,zmm9
	vaesenc	zmm1,zmm1,zmm9
	vaesenc	zmm2,zmm2,zmm9
	vaesenc	zmm3,zmm3,zmm9

$L$aes128__func2:




	prefetcht0	[((512+0))+rcx]
	prefetcht0	[((512+64))+rcx]
	prefetcht0	[((512+128))+rcx]
	prefetcht0	[((512+192))+rcx]




	vpshufb	zmm4,zmm4,zmm8
	vpxord	zmm4,zmm4,zmm10
	vpshufb	zmm5,zmm5,zmm8
	vpshufb	zmm6,zmm6,zmm8

	vaesenc	zmm0,zmm0,zmm15
	vaesenc	zmm1,zmm1,zmm15
	vaesenc	zmm2,zmm2,zmm15
	vaesenc	zmm3,zmm3,zmm15

	vpshufb	zmm7,zmm7,zmm8
	vpclmulqdq	zmm10,zmm4,zmm27,0x00
	vpclmulqdq	zmm24,zmm5,zmm28,0x00
	vpclmulqdq	zmm25,zmm6,zmm29,0x00

	vaesenc	zmm0,zmm0,zmm16
	vaesenc	zmm1,zmm1,zmm16
	vaesenc	zmm2,zmm2,zmm16
	vaesenc	zmm3,zmm3,zmm16

	vpxord	zmm10,zmm10,zmm24
	vpclmulqdq	zmm26,zmm7,zmm30,0x00
	vpternlogd	zmm10,zmm25,zmm26,0x96
	vpclmulqdq	zmm24,zmm4,zmm27,0x01

	vaesenc	zmm0,zmm0,zmm17
	vaesenc	zmm1,zmm1,zmm17
	vaesenc	zmm2,zmm2,zmm17
	vaesenc	zmm3,zmm3,zmm17

	vpclmulqdq	zmm25,zmm5,zmm28,0x01
	vpclmulqdq	zmm26,zmm6,zmm29,0x01
	vpternlogd	zmm24,zmm25,zmm26,0x96
	vpclmulqdq	zmm25,zmm7,zmm30,0x01

	vaesenc	zmm0,zmm0,zmm18
	vaesenc	zmm1,zmm1,zmm18
	vaesenc	zmm2,zmm2,zmm18
	vaesenc	zmm3,zmm3,zmm18

	vpclmulqdq	zmm26,zmm4,zmm27,0x10
	vpternlogd	zmm24,zmm25,zmm26,0x96
	vpclmulqdq	zmm25,zmm5,zmm28,0x10
	vpclmulqdq	zmm26,zmm6,zmm29,0x10

	vaesenc	zmm0,zmm0,zmm19
	vaesenc	zmm1,zmm1,zmm19
	vaesenc	zmm2,zmm2,zmm19
	vaesenc	zmm3,zmm3,zmm19

	vpternlogd	zmm24,zmm25,zmm26,0x96
	vpclmulqdq	zmm26,zmm31,zmm10,0x01
	vpclmulqdq	zmm25,zmm7,zmm30,0x10
	vpxord	zmm24,zmm24,zmm25

	vaesenc	zmm0,zmm0,zmm20
	vaesenc	zmm1,zmm1,zmm20
	vaesenc	zmm2,zmm2,zmm20
	vaesenc	zmm3,zmm3,zmm20

	vpshufd	zmm10,zmm10,0x4e
	vpclmulqdq	zmm4,zmm4,zmm27,0x11
	vpclmulqdq	zmm5,zmm5,zmm28,0x11
	vpclmulqdq	zmm6,zmm6,zmm29,0x11

	vaesenc	zmm0,zmm0,zmm21
	vaesenc	zmm1,zmm1,zmm21
	vaesenc	zmm2,zmm2,zmm21
	vaesenc	zmm3,zmm3,zmm21

	vpternlogd	zmm24,zmm10,zmm26,0x96
	vpclmulqdq	zmm7,zmm7,zmm30,0x11
	vpternlogd	zmm4,zmm5,zmm6,0x96
	vpclmulqdq	zmm25,zmm31,zmm24,0x01

	vaesenc	zmm0,zmm0,zmm22
	vaesenc	zmm1,zmm1,zmm22
	vaesenc	zmm2,zmm2,zmm22
	vaesenc	zmm3,zmm3,zmm22

	vpxord	zmm10,zmm4,zmm7
	vpshufd	zmm24,zmm24,0x4e
	vpternlogd	zmm10,zmm24,zmm25,0x96

	vaesenc	zmm0,zmm0,zmm23
	vaesenc	zmm1,zmm1,zmm23
	vaesenc	zmm2,zmm2,zmm23
	vaesenc	zmm3,zmm3,zmm23


	vextracti32x4	xmm4,zmm10,1
	vextracti32x4	xmm5,zmm10,2
	vextracti32x4	xmm6,zmm10,3
	vpxord	xmm10,xmm10,xmm4
	vpternlogd	xmm10,xmm6,xmm5,0x96

	vpxord	zmm4,zmm14,ZMMWORD[rcx]
	vpxord	zmm5,zmm14,ZMMWORD[64+rcx]
	vpxord	zmm6,zmm14,ZMMWORD[128+rcx]
	vpxord	zmm7,zmm14,ZMMWORD[192+rcx]
	vaesenclast	zmm4,zmm0,zmm4
	vaesenclast	zmm5,zmm1,zmm5
	vaesenclast	zmm6,zmm2,zmm6
	vaesenclast	zmm7,zmm3,zmm7
	vmovdqu8	ZMMWORD[rdx],zmm4
	vmovdqu8	ZMMWORD[64+rdx],zmm5
	vmovdqu8	ZMMWORD[128+rdx],zmm6
	vmovdqu8	ZMMWORD[192+rdx],zmm7

	add	rcx,256
	add	rdx,256
	sub	r8,256
	cmp	r8,256
	jae	NEAR $L$crypt_loop_4x__func2
$L$crypt_loop_4x_done__func2:

	test	r8,r8
	jz	NEAR $L$done__func2




















	mov	rax,r8
	neg	rax
	and	rax,-16
	lea	rsi,[256+rax*1+rdi]
	vpxor	xmm4,xmm4,xmm4
	vpxor	xmm5,xmm5,xmm5
	vpxor	xmm6,xmm6,xmm6

	cmp	r8,64
	jb	NEAR $L$partial_vec__func2

$L$crypt_loop_1x__func2:



	vpshufb	zmm0,zmm12,zmm8
	vpaddd	zmm12,zmm12,zmm11
	vpxord	zmm0,zmm0,zmm13
	lea	rax,[16+r9]
$L$vaesenc_loop_tail_full_vec__func2:
	vbroadcasti32x4	zmm9,ZMMWORD[rax]
	vaesenc	zmm0,zmm0,zmm9
	add	rax,16
	cmp	r11,rax
	jne	NEAR $L$vaesenc_loop_tail_full_vec__func2
	vaesenclast	zmm0,zmm0,zmm14


	vmovdqu8	zmm1,ZMMWORD[rcx]
	vpxord	zmm0,zmm0,zmm1
	vmovdqu8	ZMMWORD[rdx],zmm0


	vmovdqu8	zmm30,ZMMWORD[rsi]
	vpshufb	zmm0,zmm1,zmm8
	vpxord	zmm0,zmm0,zmm10
	vpclmulqdq	zmm7,zmm0,zmm30,0x00
	vpclmulqdq	zmm1,zmm0,zmm30,0x01
	vpclmulqdq	zmm2,zmm0,zmm30,0x10
	vpclmulqdq	zmm3,zmm0,zmm30,0x11
	vpxord	zmm4,zmm4,zmm7
	vpternlogd	zmm5,zmm1,zmm2,0x96
	vpxord	zmm6,zmm6,zmm3

	vpxor	xmm10,xmm10,xmm10

	add	rsi,64
	add	rcx,64
	add	rdx,64
	sub	r8,64
	cmp	r8,64
	jae	NEAR $L$crypt_loop_1x__func2

	test	r8,r8
	jz	NEAR $L$reduce__func2

$L$partial_vec__func2:




	mov	rax,-1
	bzhi	rax,rax,r8
	kmovq	k1,rax
	add	r8,15
	and	r8,-16
	mov	rax,-1
	bzhi	rax,rax,r8
	kmovq	k2,rax



	vpshufb	zmm0,zmm12,zmm8
	vpxord	zmm0,zmm0,zmm13
	lea	rax,[16+r9]
$L$vaesenc_loop_tail_partialvec__func2:
	vbroadcasti32x4	zmm9,ZMMWORD[rax]
	vaesenc	zmm0,zmm0,zmm9
	add	rax,16
	cmp	r11,rax
	jne	NEAR $L$vaesenc_loop_tail_partialvec__func2
	vaesenclast	zmm0,zmm0,zmm14


	vmovdqu8	zmm1{k1}{z},[rcx]
	vpxord	zmm0,zmm0,zmm1
	vmovdqu8	ZMMWORD[rdx]{k1},zmm0













	vmovdqu8	zmm30{k2}{z},[rsi]

	vpshufb	zmm0,zmm1,zmm8
	vpxord	zmm0,zmm0,zmm10
	vpclmulqdq	zmm7,zmm0,zmm30,0x00
	vpclmulqdq	zmm1,zmm0,zmm30,0x01
	vpclmulqdq	zmm2,zmm0,zmm30,0x10
	vpclmulqdq	zmm3,zmm0,zmm30,0x11
	vpxord	zmm4,zmm4,zmm7
	vpternlogd	zmm5,zmm1,zmm2,0x96
	vpxord	zmm6,zmm6,zmm3


$L$reduce__func2:

	vpclmulqdq	zmm0,zmm31,zmm4,0x01
	vpshufd	zmm4,zmm4,0x4e
	vpternlogd	zmm5,zmm4,zmm0,0x96
	vpclmulqdq	zmm0,zmm31,zmm5,0x01
	vpshufd	zmm5,zmm5,0x4e
	vpternlogd	zmm6,zmm5,zmm0,0x96

	vextracti32x4	xmm0,zmm6,1
	vextracti32x4	xmm1,zmm6,2
	vextracti32x4	xmm2,zmm6,3
	vpxord	xmm10,xmm6,xmm0
	vpternlogd	xmm10,xmm2,xmm1,0x96


$L$done__func2:

	vpshufb	xmm10,xmm10,xmm8
	vmovdqu	XMMWORD[r12],xmm10

	vzeroupper
	vmovdqa	xmm6,XMMWORD[rsp]
	vmovdqa	xmm7,XMMWORD[16+rsp]
	vmovdqa	xmm8,XMMWORD[32+rsp]
	vmovdqa	xmm9,XMMWORD[48+rsp]
	vmovdqa	xmm10,XMMWORD[64+rsp]
	vmovdqa	xmm11,XMMWORD[80+rsp]
	vmovdqa	xmm12,XMMWORD[96+rsp]
	vmovdqa	xmm13,XMMWORD[112+rsp]
	vmovdqa	xmm14,XMMWORD[128+rsp]
	vmovdqa	xmm15,XMMWORD[144+rsp]
	add	rsp,160
	pop	r12
	pop	rdi
	pop	rsi
	ret
$L$SEH_end_aes_gcm_dec_update_vaes_avx512_17:


section	.pdata rdata align=4
ALIGN	4
	DD	$L$SEH_begin_gcm_gmult_vpclmulqdq_avx512_1 wrt ..imagebase
	DD	$L$SEH_end_gcm_gmult_vpclmulqdq_avx512_5 wrt ..imagebase
	DD	$L$SEH_info_gcm_gmult_vpclmulqdq_avx512_0 wrt ..imagebase

	DD	$L$SEH_begin_gcm_ghash_vpclmulqdq_avx512_1 wrt ..imagebase
	DD	$L$SEH_end_gcm_ghash_vpclmulqdq_avx512_12 wrt ..imagebase
	DD	$L$SEH_info_gcm_ghash_vpclmulqdq_avx512_0 wrt ..imagebase

	DD	$L$SEH_begin_aes_gcm_enc_update_vaes_avx512_1 wrt ..imagebase
	DD	$L$SEH_end_aes_gcm_enc_update_vaes_avx512_17 wrt ..imagebase
	DD	$L$SEH_info_aes_gcm_enc_update_vaes_avx512_0 wrt ..imagebase

	DD	$L$SEH_begin_aes_gcm_dec_update_vaes_avx512_1 wrt ..imagebase
	DD	$L$SEH_end_aes_gcm_dec_update_vaes_avx512_17 wrt ..imagebase
	DD	$L$SEH_info_aes_gcm_dec_update_vaes_avx512_0 wrt ..imagebase


section	.xdata rdata align=8
ALIGN	4
$L$SEH_info_gcm_gmult_vpclmulqdq_avx512_0:
	DB	1
	DB	$L$SEH_endprologue_gcm_gmult_vpclmulqdq_avx512_4-$L$SEH_begin_gcm_gmult_vpclmulqdq_avx512_1
	DB	3
	DB	0
	DB	$L$SEH_prologue_gcm_gmult_vpclmulqdq_avx512_3-$L$SEH_begin_gcm_gmult_vpclmulqdq_avx512_1
	DB	104
	DW	0
	DB	$L$SEH_prologue_gcm_gmult_vpclmulqdq_avx512_2-$L$SEH_begin_gcm_gmult_vpclmulqdq_avx512_1
	DB	34

	DW	0
$L$SEH_info_gcm_ghash_vpclmulqdq_avx512_0:
	DB	1
	DB	$L$SEH_endprologue_gcm_ghash_vpclmulqdq_avx512_11-$L$SEH_begin_gcm_ghash_vpclmulqdq_avx512_1
	DB	18
	DB	0
	DB	$L$SEH_prologue_gcm_ghash_vpclmulqdq_avx512_10-$L$SEH_begin_gcm_ghash_vpclmulqdq_avx512_1
	DB	216
	DW	7
	DB	$L$SEH_prologue_gcm_ghash_vpclmulqdq_avx512_9-$L$SEH_begin_gcm_ghash_vpclmulqdq_avx512_1
	DB	200
	DW	6
	DB	$L$SEH_prologue_gcm_ghash_vpclmulqdq_avx512_8-$L$SEH_begin_gcm_ghash_vpclmulqdq_avx512_1
	DB	184
	DW	5
	DB	$L$SEH_prologue_gcm_ghash_vpclmulqdq_avx512_7-$L$SEH_begin_gcm_ghash_vpclmulqdq_avx512_1
	DB	168
	DW	4
	DB	$L$SEH_prologue_gcm_ghash_vpclmulqdq_avx512_6-$L$SEH_begin_gcm_ghash_vpclmulqdq_avx512_1
	DB	152
	DW	3
	DB	$L$SEH_prologue_gcm_ghash_vpclmulqdq_avx512_5-$L$SEH_begin_gcm_ghash_vpclmulqdq_avx512_1
	DB	136
	DW	2
	DB	$L$SEH_prologue_gcm_ghash_vpclmulqdq_avx512_4-$L$SEH_begin_gcm_ghash_vpclmulqdq_avx512_1
	DB	120
	DW	1
	DB	$L$SEH_prologue_gcm_ghash_vpclmulqdq_avx512_3-$L$SEH_begin_gcm_ghash_vpclmulqdq_avx512_1
	DB	104
	DW	0
	DB	$L$SEH_prologue_gcm_ghash_vpclmulqdq_avx512_2-$L$SEH_begin_gcm_ghash_vpclmulqdq_avx512_1
	DB	1
	DW	17

$L$SEH_info_aes_gcm_enc_update_vaes_avx512_0:
	DB	1
	DB	$L$SEH_endprologue_aes_gcm_enc_update_vaes_avx512_16-$L$SEH_begin_aes_gcm_enc_update_vaes_avx512_1
	DB	25
	DB	0
	DB	$L$SEH_prologue_aes_gcm_enc_update_vaes_avx512_15-$L$SEH_begin_aes_gcm_enc_update_vaes_avx512_1
	DB	248
	DW	9
	DB	$L$SEH_prologue_aes_gcm_enc_update_vaes_avx512_14-$L$SEH_begin_aes_gcm_enc_update_vaes_avx512_1
	DB	232
	DW	8
	DB	$L$SEH_prologue_aes_gcm_enc_update_vaes_avx512_13-$L$SEH_begin_aes_gcm_enc_update_vaes_avx512_1
	DB	216
	DW	7
	DB	$L$SEH_prologue_aes_gcm_enc_update_vaes_avx512_12-$L$SEH_begin_aes_gcm_enc_update_vaes_avx512_1
	DB	200
	DW	6
	DB	$L$SEH_prologue_aes_gcm_enc_update_vaes_avx512_11-$L$SEH_begin_aes_gcm_enc_update_vaes_avx512_1
	DB	184
	DW	5
	DB	$L$SEH_prologue_aes_gcm_enc_update_vaes_avx512_10-$L$SEH_begin_aes_gcm_enc_update_vaes_avx512_1
	DB	168
	DW	4
	DB	$L$SEH_prologue_aes_gcm_enc_update_vaes_avx512_9-$L$SEH_begin_aes_gcm_enc_update_vaes_avx512_1
	DB	152
	DW	3
	DB	$L$SEH_prologue_aes_gcm_enc_update_vaes_avx512_8-$L$SEH_begin_aes_gcm_enc_update_vaes_avx512_1
	DB	136
	DW	2
	DB	$L$SEH_prologue_aes_gcm_enc_update_vaes_avx512_7-$L$SEH_begin_aes_gcm_enc_update_vaes_avx512_1
	DB	120
	DW	1
	DB	$L$SEH_prologue_aes_gcm_enc_update_vaes_avx512_6-$L$SEH_begin_aes_gcm_enc_update_vaes_avx512_1
	DB	104
	DW	0
	DB	$L$SEH_prologue_aes_gcm_enc_update_vaes_avx512_5-$L$SEH_begin_aes_gcm_enc_update_vaes_avx512_1
	DB	1
	DW	20
	DB	$L$SEH_prologue_aes_gcm_enc_update_vaes_avx512_4-$L$SEH_begin_aes_gcm_enc_update_vaes_avx512_1
	DB	192
	DB	$L$SEH_prologue_aes_gcm_enc_update_vaes_avx512_3-$L$SEH_begin_aes_gcm_enc_update_vaes_avx512_1
	DB	112
	DB	$L$SEH_prologue_aes_gcm_enc_update_vaes_avx512_2-$L$SEH_begin_aes_gcm_enc_update_vaes_avx512_1
	DB	96

	DW	0
$L$SEH_info_aes_gcm_dec_update_vaes_avx512_0:
	DB	1
	DB	$L$SEH_endprologue_aes_gcm_dec_update_vaes_avx512_16-$L$SEH_begin_aes_gcm_dec_update_vaes_avx512_1
	DB	25
	DB	0
	DB	$L$SEH_prologue_aes_gcm_dec_update_vaes_avx512_15-$L$SEH_begin_aes_gcm_dec_update_vaes_avx512_1
	DB	248
	DW	9
	DB	$L$SEH_prologue_aes_gcm_dec_update_vaes_avx512_14-$L$SEH_begin_aes_gcm_dec_update_vaes_avx512_1
	DB	232
	DW	8
	DB	$L$SEH_prologue_aes_gcm_dec_update_vaes_avx512_13-$L$SEH_begin_aes_gcm_dec_update_vaes_avx512_1
	DB	216
	DW	7
	DB	$L$SEH_prologue_aes_gcm_dec_update_vaes_avx512_12-$L$SEH_begin_aes_gcm_dec_update_vaes_avx512_1
	DB	200
	DW	6
	DB	$L$SEH_prologue_aes_gcm_dec_update_vaes_avx512_11-$L$SEH_begin_aes_gcm_dec_update_vaes_avx512_1
	DB	184
	DW	5
	DB	$L$SEH_prologue_aes_gcm_dec_update_vaes_avx512_10-$L$SEH_begin_aes_gcm_dec_update_vaes_avx512_1
	DB	168
	DW	4
	DB	$L$SEH_prologue_aes_gcm_dec_update_vaes_avx512_9-$L$SEH_begin_aes_gcm_dec_update_vaes_avx512_1
	DB	152
	DW	3
	DB	$L$SEH_prologue_aes_gcm_dec_update_vaes_avx512_8-$L$SEH_begin_aes_gcm_dec_update_vaes_avx512_1
	DB	136
	DW	2
	DB	$L$SEH_prologue_aes_gcm_dec_update_vaes_avx512_7-$L$SEH_begin_aes_gcm_dec_update_vaes_avx512_1
	DB	120
	DW	1
	DB	$L$SEH_prologue_aes_gcm_dec_update_vaes_avx512_6-$L$SEH_begin_aes_gcm_dec_update_vaes_avx512_1
	DB	104
	DW	0
	DB	$L$SEH_prologue_aes_gcm_dec_update_vaes_avx512_5-$L$SEH_begin_aes_gcm_dec_update_vaes_avx512_1
	DB	1
	DW	20
	DB	$L$SEH_prologue_aes_gcm_dec_update_vaes_avx512_4-$L$SEH_begin_aes_gcm_dec_update_vaes_avx512_1
	DB	192
	DB	$L$SEH_prologue_aes_gcm_dec_update_vaes_avx512_3-$L$SEH_begin_aes_gcm_dec_update_vaes_avx512_1
	DB	112
	DB	$L$SEH_prologue_aes_gcm_dec_update_vaes_avx512_2-$L$SEH_begin_aes_gcm_dec_update_vaes_avx512_1
	DB	96

	DW	0
%else
; Work around https://bugzilla.nasm.us/show_bug.cgi?id=3392738
ret
%endif
