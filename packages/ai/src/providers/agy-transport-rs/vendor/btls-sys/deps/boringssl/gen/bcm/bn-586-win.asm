; This file is generated from a similarly-named Perl script in the BoringSSL
; source tree. Do not edit by hand.

%ifdef BORINGSSL_PREFIX
%include "boringssl_prefix_symbols_nasm.inc"
%endif
%ifidn __OUTPUT_FORMAT__, win32
%ifidn __OUTPUT_FORMAT__,obj
section	code	use32 class=code align=64
%elifidn __OUTPUT_FORMAT__,win32
$@feat.00 equ 1
section	.text	code align=64
%else
section	.text	code
%endif
global	_bn_mul_add_words
align	16
_bn_mul_add_words:
L$_bn_mul_add_words_begin:
	mov	eax,DWORD [4+esp]
	mov	edx,DWORD [8+esp]
	mov	ecx,DWORD [12+esp]
	movd	mm0,DWORD [16+esp]
	pxor	mm1,mm1
	jmp	NEAR L$000maw_sse2_entry
align	16
L$001maw_sse2_unrolled:
	movd	mm3,DWORD [eax]
	paddq	mm1,mm3
	movd	mm2,DWORD [edx]
	pmuludq	mm2,mm0
	movd	mm4,DWORD [4+edx]
	pmuludq	mm4,mm0
	movd	mm6,DWORD [8+edx]
	pmuludq	mm6,mm0
	movd	mm7,DWORD [12+edx]
	pmuludq	mm7,mm0
	paddq	mm1,mm2
	movd	mm3,DWORD [4+eax]
	paddq	mm3,mm4
	movd	mm5,DWORD [8+eax]
	paddq	mm5,mm6
	movd	mm4,DWORD [12+eax]
	paddq	mm7,mm4
	movd	DWORD [eax],mm1
	movd	mm2,DWORD [16+edx]
	pmuludq	mm2,mm0
	psrlq	mm1,32
	movd	mm4,DWORD [20+edx]
	pmuludq	mm4,mm0
	paddq	mm1,mm3
	movd	mm6,DWORD [24+edx]
	pmuludq	mm6,mm0
	movd	DWORD [4+eax],mm1
	psrlq	mm1,32
	movd	mm3,DWORD [28+edx]
	add	edx,32
	pmuludq	mm3,mm0
	paddq	mm1,mm5
	movd	mm5,DWORD [16+eax]
	paddq	mm2,mm5
	movd	DWORD [8+eax],mm1
	psrlq	mm1,32
	paddq	mm1,mm7
	movd	mm5,DWORD [20+eax]
	paddq	mm4,mm5
	movd	DWORD [12+eax],mm1
	psrlq	mm1,32
	paddq	mm1,mm2
	movd	mm5,DWORD [24+eax]
	paddq	mm6,mm5
	movd	DWORD [16+eax],mm1
	psrlq	mm1,32
	paddq	mm1,mm4
	movd	mm5,DWORD [28+eax]
	paddq	mm3,mm5
	movd	DWORD [20+eax],mm1
	psrlq	mm1,32
	paddq	mm1,mm6
	movd	DWORD [24+eax],mm1
	psrlq	mm1,32
	paddq	mm1,mm3
	movd	DWORD [28+eax],mm1
	lea	eax,[32+eax]
	psrlq	mm1,32
	sub	ecx,8
	jz	NEAR L$002maw_sse2_exit
L$000maw_sse2_entry:
	test	ecx,4294967288
	jnz	NEAR L$001maw_sse2_unrolled
align	4
L$003maw_sse2_loop:
	movd	mm2,DWORD [edx]
	movd	mm3,DWORD [eax]
	pmuludq	mm2,mm0
	lea	edx,[4+edx]
	paddq	mm1,mm3
	paddq	mm1,mm2
	movd	DWORD [eax],mm1
	sub	ecx,1
	psrlq	mm1,32
	lea	eax,[4+eax]
	jnz	NEAR L$003maw_sse2_loop
L$002maw_sse2_exit:
	movd	eax,mm1
	emms
	ret
	pop	edi
	pop	esi
	pop	ebx
	pop	ebp
	ret
global	_bn_mul_words
align	16
_bn_mul_words:
L$_bn_mul_words_begin:
	mov	eax,DWORD [4+esp]
	mov	edx,DWORD [8+esp]
	mov	ecx,DWORD [12+esp]
	movd	mm0,DWORD [16+esp]
	pxor	mm1,mm1
align	16
L$004mw_sse2_loop:
	movd	mm2,DWORD [edx]
	pmuludq	mm2,mm0
	lea	edx,[4+edx]
	paddq	mm1,mm2
	movd	DWORD [eax],mm1
	sub	ecx,1
	psrlq	mm1,32
	lea	eax,[4+eax]
	jnz	NEAR L$004mw_sse2_loop
	movd	eax,mm1
	emms
	ret
	pop	edi
	pop	esi
	pop	ebx
	pop	ebp
	ret
global	_bn_sqr_add_words
align	16
_bn_sqr_add_words:
L$_bn_sqr_add_words_begin:
	mov	eax,DWORD [4+esp]
	mov	edx,DWORD [8+esp]
	mov	ecx,DWORD [12+esp]
	pxor	mm1,mm1
align	16
L$005sqr_sse2_loop:
	movd	mm0,DWORD [edx]
	movd	mm2,DWORD [eax]
	movd	mm3,DWORD [4+eax]
	pmuludq	mm0,mm0
	lea	edx,[4+edx]
	paddq	mm1,mm0
	paddq	mm1,mm2
	movd	DWORD [eax],mm1
	psrlq	mm1,32
	paddq	mm1,mm3
	movd	DWORD [4+eax],mm1
	psrlq	mm1,32
	sub	ecx,1
	lea	eax,[8+eax]
	jnz	NEAR L$005sqr_sse2_loop
	emms
	ret
	pop	edi
	pop	esi
	pop	ebx
	pop	ebp
	ret
global	_bn_add_words
align	16
_bn_add_words:
L$_bn_add_words_begin:
	push	ebp
	push	ebx
	push	esi
	push	edi
	; 
	mov	ebx,DWORD [20+esp]
	mov	esi,DWORD [24+esp]
	mov	edi,DWORD [28+esp]
	mov	ebp,DWORD [32+esp]
	xor	eax,eax
	and	ebp,4294967288
	jz	NEAR L$006aw_finish
L$007aw_loop:
	; Round 0
	mov	ecx,DWORD [esi]
	mov	edx,DWORD [edi]
	add	ecx,eax
	mov	eax,0
	adc	eax,eax
	add	ecx,edx
	adc	eax,0
	mov	DWORD [ebx],ecx
	; Round 1
	mov	ecx,DWORD [4+esi]
	mov	edx,DWORD [4+edi]
	add	ecx,eax
	mov	eax,0
	adc	eax,eax
	add	ecx,edx
	adc	eax,0
	mov	DWORD [4+ebx],ecx
	; Round 2
	mov	ecx,DWORD [8+esi]
	mov	edx,DWORD [8+edi]
	add	ecx,eax
	mov	eax,0
	adc	eax,eax
	add	ecx,edx
	adc	eax,0
	mov	DWORD [8+ebx],ecx
	; Round 3
	mov	ecx,DWORD [12+esi]
	mov	edx,DWORD [12+edi]
	add	ecx,eax
	mov	eax,0
	adc	eax,eax
	add	ecx,edx
	adc	eax,0
	mov	DWORD [12+ebx],ecx
	; Round 4
	mov	ecx,DWORD [16+esi]
	mov	edx,DWORD [16+edi]
	add	ecx,eax
	mov	eax,0
	adc	eax,eax
	add	ecx,edx
	adc	eax,0
	mov	DWORD [16+ebx],ecx
	; Round 5
	mov	ecx,DWORD [20+esi]
	mov	edx,DWORD [20+edi]
	add	ecx,eax
	mov	eax,0
	adc	eax,eax
	add	ecx,edx
	adc	eax,0
	mov	DWORD [20+ebx],ecx
	; Round 6
	mov	ecx,DWORD [24+esi]
	mov	edx,DWORD [24+edi]
	add	ecx,eax
	mov	eax,0
	adc	eax,eax
	add	ecx,edx
	adc	eax,0
	mov	DWORD [24+ebx],ecx
	; Round 7
	mov	ecx,DWORD [28+esi]
	mov	edx,DWORD [28+edi]
	add	ecx,eax
	mov	eax,0
	adc	eax,eax
	add	ecx,edx
	adc	eax,0
	mov	DWORD [28+ebx],ecx
	; 
	add	esi,32
	add	edi,32
	add	ebx,32
	sub	ebp,8
	jnz	NEAR L$007aw_loop
L$006aw_finish:
	mov	ebp,DWORD [32+esp]
	and	ebp,7
	jz	NEAR L$008aw_end
	; Tail Round 0
	mov	ecx,DWORD [esi]
	mov	edx,DWORD [edi]
	add	ecx,eax
	mov	eax,0
	adc	eax,eax
	add	ecx,edx
	adc	eax,0
	dec	ebp
	mov	DWORD [ebx],ecx
	jz	NEAR L$008aw_end
	; Tail Round 1
	mov	ecx,DWORD [4+esi]
	mov	edx,DWORD [4+edi]
	add	ecx,eax
	mov	eax,0
	adc	eax,eax
	add	ecx,edx
	adc	eax,0
	dec	ebp
	mov	DWORD [4+ebx],ecx
	jz	NEAR L$008aw_end
	; Tail Round 2
	mov	ecx,DWORD [8+esi]
	mov	edx,DWORD [8+edi]
	add	ecx,eax
	mov	eax,0
	adc	eax,eax
	add	ecx,edx
	adc	eax,0
	dec	ebp
	mov	DWORD [8+ebx],ecx
	jz	NEAR L$008aw_end
	; Tail Round 3
	mov	ecx,DWORD [12+esi]
	mov	edx,DWORD [12+edi]
	add	ecx,eax
	mov	eax,0
	adc	eax,eax
	add	ecx,edx
	adc	eax,0
	dec	ebp
	mov	DWORD [12+ebx],ecx
	jz	NEAR L$008aw_end
	; Tail Round 4
	mov	ecx,DWORD [16+esi]
	mov	edx,DWORD [16+edi]
	add	ecx,eax
	mov	eax,0
	adc	eax,eax
	add	ecx,edx
	adc	eax,0
	dec	ebp
	mov	DWORD [16+ebx],ecx
	jz	NEAR L$008aw_end
	; Tail Round 5
	mov	ecx,DWORD [20+esi]
	mov	edx,DWORD [20+edi]
	add	ecx,eax
	mov	eax,0
	adc	eax,eax
	add	ecx,edx
	adc	eax,0
	dec	ebp
	mov	DWORD [20+ebx],ecx
	jz	NEAR L$008aw_end
	; Tail Round 6
	mov	ecx,DWORD [24+esi]
	mov	edx,DWORD [24+edi]
	add	ecx,eax
	mov	eax,0
	adc	eax,eax
	add	ecx,edx
	adc	eax,0
	mov	DWORD [24+ebx],ecx
L$008aw_end:
	pop	edi
	pop	esi
	pop	ebx
	pop	ebp
	ret
global	_bn_sub_words
align	16
_bn_sub_words:
L$_bn_sub_words_begin:
	push	ebp
	push	ebx
	push	esi
	push	edi
	; 
	mov	ebx,DWORD [20+esp]
	mov	esi,DWORD [24+esp]
	mov	edi,DWORD [28+esp]
	mov	ebp,DWORD [32+esp]
	xor	eax,eax
	and	ebp,4294967288
	jz	NEAR L$009aw_finish
L$010aw_loop:
	; Round 0
	mov	ecx,DWORD [esi]
	mov	edx,DWORD [edi]
	sub	ecx,eax
	mov	eax,0
	adc	eax,eax
	sub	ecx,edx
	adc	eax,0
	mov	DWORD [ebx],ecx
	; Round 1
	mov	ecx,DWORD [4+esi]
	mov	edx,DWORD [4+edi]
	sub	ecx,eax
	mov	eax,0
	adc	eax,eax
	sub	ecx,edx
	adc	eax,0
	mov	DWORD [4+ebx],ecx
	; Round 2
	mov	ecx,DWORD [8+esi]
	mov	edx,DWORD [8+edi]
	sub	ecx,eax
	mov	eax,0
	adc	eax,eax
	sub	ecx,edx
	adc	eax,0
	mov	DWORD [8+ebx],ecx
	; Round 3
	mov	ecx,DWORD [12+esi]
	mov	edx,DWORD [12+edi]
	sub	ecx,eax
	mov	eax,0
	adc	eax,eax
	sub	ecx,edx
	adc	eax,0
	mov	DWORD [12+ebx],ecx
	; Round 4
	mov	ecx,DWORD [16+esi]
	mov	edx,DWORD [16+edi]
	sub	ecx,eax
	mov	eax,0
	adc	eax,eax
	sub	ecx,edx
	adc	eax,0
	mov	DWORD [16+ebx],ecx
	; Round 5
	mov	ecx,DWORD [20+esi]
	mov	edx,DWORD [20+edi]
	sub	ecx,eax
	mov	eax,0
	adc	eax,eax
	sub	ecx,edx
	adc	eax,0
	mov	DWORD [20+ebx],ecx
	; Round 6
	mov	ecx,DWORD [24+esi]
	mov	edx,DWORD [24+edi]
	sub	ecx,eax
	mov	eax,0
	adc	eax,eax
	sub	ecx,edx
	adc	eax,0
	mov	DWORD [24+ebx],ecx
	; Round 7
	mov	ecx,DWORD [28+esi]
	mov	edx,DWORD [28+edi]
	sub	ecx,eax
	mov	eax,0
	adc	eax,eax
	sub	ecx,edx
	adc	eax,0
	mov	DWORD [28+ebx],ecx
	; 
	add	esi,32
	add	edi,32
	add	ebx,32
	sub	ebp,8
	jnz	NEAR L$010aw_loop
L$009aw_finish:
	mov	ebp,DWORD [32+esp]
	and	ebp,7
	jz	NEAR L$011aw_end
	; Tail Round 0
	mov	ecx,DWORD [esi]
	mov	edx,DWORD [edi]
	sub	ecx,eax
	mov	eax,0
	adc	eax,eax
	sub	ecx,edx
	adc	eax,0
	dec	ebp
	mov	DWORD [ebx],ecx
	jz	NEAR L$011aw_end
	; Tail Round 1
	mov	ecx,DWORD [4+esi]
	mov	edx,DWORD [4+edi]
	sub	ecx,eax
	mov	eax,0
	adc	eax,eax
	sub	ecx,edx
	adc	eax,0
	dec	ebp
	mov	DWORD [4+ebx],ecx
	jz	NEAR L$011aw_end
	; Tail Round 2
	mov	ecx,DWORD [8+esi]
	mov	edx,DWORD [8+edi]
	sub	ecx,eax
	mov	eax,0
	adc	eax,eax
	sub	ecx,edx
	adc	eax,0
	dec	ebp
	mov	DWORD [8+ebx],ecx
	jz	NEAR L$011aw_end
	; Tail Round 3
	mov	ecx,DWORD [12+esi]
	mov	edx,DWORD [12+edi]
	sub	ecx,eax
	mov	eax,0
	adc	eax,eax
	sub	ecx,edx
	adc	eax,0
	dec	ebp
	mov	DWORD [12+ebx],ecx
	jz	NEAR L$011aw_end
	; Tail Round 4
	mov	ecx,DWORD [16+esi]
	mov	edx,DWORD [16+edi]
	sub	ecx,eax
	mov	eax,0
	adc	eax,eax
	sub	ecx,edx
	adc	eax,0
	dec	ebp
	mov	DWORD [16+ebx],ecx
	jz	NEAR L$011aw_end
	; Tail Round 5
	mov	ecx,DWORD [20+esi]
	mov	edx,DWORD [20+edi]
	sub	ecx,eax
	mov	eax,0
	adc	eax,eax
	sub	ecx,edx
	adc	eax,0
	dec	ebp
	mov	DWORD [20+ebx],ecx
	jz	NEAR L$011aw_end
	; Tail Round 6
	mov	ecx,DWORD [24+esi]
	mov	edx,DWORD [24+edi]
	sub	ecx,eax
	mov	eax,0
	adc	eax,eax
	sub	ecx,edx
	adc	eax,0
	mov	DWORD [24+ebx],ecx
L$011aw_end:
	pop	edi
	pop	esi
	pop	ebx
	pop	ebp
	ret
%else
; Work around https://bugzilla.nasm.us/show_bug.cgi?id=3392738
ret
%endif
