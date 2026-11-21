import os
from logging import getLogger
from pathlib import Path
from shutil import copyfile
from typing import Dict, Iterator, List, Optional, Tuple, Union, cast

import tiktoken
from tiktoken.load import load_tiktoken_bpe
from tokenizers import AddedToken
from transformers.convert_slow_tokenizer import bytes_to_unicode
from transformers.tokenization_utils import PreTrainedTokenizer

try:
    from .encoding_k3 import build_chat_segments, is_batched_conversation
except ImportError:  # pragma: no cover - supports direct file execution/import.
    from encoding_k3 import build_chat_segments, is_batched_conversation

logger = getLogger(__name__)
VOCAB_FILES_NAMES = {"vocab_file": "tiktoken.model"}


class TikTokenTokenizer(PreTrainedTokenizer):
    """
    Tokenizing and encoding/decoding text using the Tiktoken tokenizer. See megatron/tokenizer/tiktoken_tokenizer.py.

    This tokenizer inherits from [`PreTrainedTokenizer`] which contains most of the main methods. Users should refer to
    this superclass for more information regarding those methods.

    Args:
        vocab_file (`str`):
            The path to the Tiktoken model file.
        bos_token (`str` or `tokenizers.AddedToken`, *optional*, defaults to `"<|begin_of_text|>",`):
            The beginning of sequence token that was used during pretraining. Can be used a sequence classifier token.
        eos_token (`str` or `tokenizers.AddedToken`, *optional*, defaults to `"<|end_of_text|>"`):
            The end of sequence token.
        unk_token (`str` or `tokenizers.AddedToken`, *optional*, defaults to `"<|reserved_special_token_249|>"`):
            The unknown token. A token that is not in the vocabulary cannot be converted to an ID and is set to be this
            token instead. The second to last item in special_tokens.
        pad_token (`str` or `tokenizers.AddedToken`, *optional*, defaults to `"<|reserved_special_token_250|>"`):
            The token used for padding, for example when batching sequences of different lengths.
        additional_special_tokens (list of `str`, *optional*):
            A tuple or a list of additional tokens, which will be marked as `special`, meaning that they will be
            skipped when decoding if `skip_special_tokens` is set to `True`.
    """

    vocab_files_names = VOCAB_FILES_NAMES

    model_input_names = ["input_ids", "attention_mask"]

    special_tokens: Dict[str, int]

    num_reserved_special_tokens = 256

    pat_str = "|".join([
        r"""[\p{Han}]+""",
        r"""[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}&&[^\p{Han}]]*[\p{Ll}\p{Lm}\p{Lo}\p{M}&&[^\p{Han}]]+(?i:'s|'t|'re|'ve|'m|'ll|'d)?""",
        r"""[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}&&[^\p{Han}]]+[\p{Ll}\p{Lm}\p{Lo}\p{M}&&[^\p{Han}]]*(?i:'s|'t|'re|'ve|'m|'ll|'d)?""",
        r"""\p{N}{1,3}""",
        r""" ?[^\s\p{L}\p{N}]+[\r\n]*""",
        r"""\s*[\r\n]+""",
        r"""\s+(?!\S)""",
        r"""\s+""",
    ])

    def __init__(
        self,
        vocab_file,
        bos_token: Union[str, AddedToken] = "[BOS]",
        eos_token: Union[str, AddedToken] = "[EOS]",
        unk_token: Union[str, AddedToken, None] = None,
        pad_token: Union[str, AddedToken, None] = None,
        additional_special_tokens: List[str] = None,
        added_tokens_decoder: Optional[dict] = None,
        **kwargs,
    ):
        assert os.path.isfile(vocab_file), vocab_file

        if additional_special_tokens is None:
            additional_special_tokens = [
                "<|im_end|>",
                "<|im_user|>",
                "<|im_assistant|>",
                "<|start_header_id|>",
                "<|end_header_id|>",
                "[EOT]",
                "<|im_system|>",
                "<|im_middle|>",
            ]

        if added_tokens_decoder:
            special_tokens_mapping = {
                i: added_tokens_decoder[i].content
                for i in added_tokens_decoder
            }
        else:
            special_tokens_mapping = {}

        self.vocab_file = vocab_file
        mergeable_ranks = load_tiktoken_bpe(vocab_file)
        num_base_tokens = len(mergeable_ranks)
        self.special_tokens = {
            special_tokens_mapping.get(i, f"<|reserved_token_{i}|>"): i
            for i in range(num_base_tokens, num_base_tokens +
                           self.num_reserved_special_tokens)
        }

        self.model = tiktoken.Encoding(
            name=Path(vocab_file).name,
            pat_str=self.pat_str,
            mergeable_ranks=mergeable_ranks,
            special_tokens=self.special_tokens,
        )
        logger.info(f"Reloaded tiktoken model from {vocab_file}")

        self.n_words: int = self.model.n_vocab
        # BOS / EOS token IDs
        self.bos_id: int = self.special_tokens[str(bos_token)]
        self.eos_id: int = self.special_tokens[str(eos_token)]
        logger.info(
            f"#words: {self.n_words} - BOS ID: {self.bos_id} - EOS ID: {self.eos_id}"
        )

        self.pad_id: int = self.special_tokens[str(pad_token)]
        self.unk_id: int = self.special_tokens[str(unk_token)]

        self.byte_encoder = bytes_to_unicode()
        self.byte_decoder = {v: k for k, v in self.byte_encoder.items()}

        self.decoder = {}
        for i in range(self.n_words):
            # Taken from https://gist.github.com/xenova/a452a6474428de0182b17605a98631ee
            decoding = ''.join([
                self.byte_encoder[ord(char)] for char in
                self.model.decode_single_token_bytes(i).decode('latin-1')
            ])
            self.decoder[i] = decoding

        self.encoder = {}
        for i in range(self.n_words):
            if i in self.decoder:
                self.encoder[self.decoder[i]] = i

        super().__init__(
            bos_token=bos_token,
            eos_token=eos_token,
            unk_token=unk_token,
            pad_token=pad_token,
            additional_special_tokens=additional_special_tokens,
            added_tokens_decoder=added_tokens_decoder,
            **kwargs,
        )
        self.all_special_ids_set = set(self.all_special_ids)

    def _encode_text_piece(self, text: str,
                           allow_special_tokens: bool = True) -> List[int]:
        # The tiktoken tokenizer can handle <=400k chars without
        # pyo3_runtime.PanicException.
        TIKTOKEN_MAX_ENCODE_CHARS = 400_000

        # https://github.com/openai/tiktoken/issues/195
        # Here we iterate over subsequences and split if we exceed the limit
        # of max consecutive non-whitespace or whitespace characters.
        MAX_NO_WHITESPACES_CHARS = 25_000

        t: List[int] = []
        for i in range(0, len(text), TIKTOKEN_MAX_ENCODE_CHARS):
            for substr in self._split_whitespaces_or_nonwhitespaces(
                text[i:i + TIKTOKEN_MAX_ENCODE_CHARS],
                MAX_NO_WHITESPACES_CHARS,
            ):
                if allow_special_tokens:
                    t.extend(
                        # structural markers: encode <|...|> as their special token IDs
                        self.model.encode(
                            substr,
                            allowed_special="all",
                        ))
                else:
                    t.extend(
                        # user/tool text: encode any <|...|> as ordinary BPE tokens (never as control tokens)
                        self.model.encode(
                            substr,
                            disallowed_special=(),
                        ))

        return t

    def encode(self,
               text: str,
               allow_special_tokens: bool = True,
               **kwargs) -> List[int]:
        """
        Encodes a string into a list of token IDs.

        Args:
            text (str): The input string to be encoded.

        Returns:
            list[int]: A list of token IDs.
        """
        # If there are other args, we should call super().encode because there are a lot of code
        # to handle those args. supper().encode finally will call _tokenize and _convert_token_to_id.
        # NOTE: our encode method is not compatible with the super().encode method,
        #   e.g. split_special_tokens' default is True in our encode method.
        if len(kwargs) > 0:
            logger.warning(f"Calling super().encode with {kwargs}")
            return super().encode(text, **kwargs)

        assert type(text) is str
        return self._encode_text_piece(text,
                                       allow_special_tokens=allow_special_tokens)

    def decode(self, token_ids: Union[int, List[int]], **kwargs) -> str:
        """
        Decodes a list of token IDs into a string.

        Args:
            token_ids (List[int]): The list of token IDs to be decoded.

        Returns:
            str: The decoded string.
        """
        # If there are other args, we should call super().decode because there are a lot of code
        # to handle those args. supper().encode finally will call convert_tokens_to_string and _convert_id_to_token.
        if len(kwargs) > 0:
            return super().decode(token_ids, **kwargs)

        if type(token_ids) is int:
            token_ids = [token_ids]

        return self.model.decode(cast(List[int], token_ids))

    @staticmethod
    def _split_whitespaces_or_nonwhitespaces(
            s: str, max_consecutive_slice_len: int) -> Iterator[str]:
        """
        Splits the string `s` so that each substring contains no more than `max_consecutive_slice_len`
        consecutive whitespaces or consecutive non-whitespaces.
        """
        current_slice_len = 0
        current_slice_is_space = s[0].isspace() if len(s) > 0 else False
        slice_start = 0

        for i in range(len(s)):
            is_now_space = s[i].isspace()

            if current_slice_is_space ^ is_now_space:
                current_slice_len = 1
                current_slice_is_space = is_now_space
            else:
                current_slice_len += 1
                if current_slice_len > max_consecutive_slice_len:
                    yield s[slice_start:i]
                    slice_start = i
                    current_slice_len = 1
        yield s[slice_start:]

    def _encode_chat_segments(self, segments) -> List[int]:
        token_ids: List[int] = []
        for segment in segments:
            token_ids.extend(
                self._encode_text_piece(
                    segment.text,
                    allow_special_tokens=segment.allow_special,
                ))
        return token_ids

    @staticmethod
    def _truncate(ids: List[int],
                  truncation: bool = False,
                  max_length: Optional[int] = None) -> List[int]:
        if truncation and max_length is not None:
            return ids[:max_length]
        return ids

    def _format_chat_token_output(self,
                                  encoded_inputs: List[List[int]],
                                  *,
                                  is_batched: bool,
                                  padding=False,
                                  truncation: bool = False,
                                  max_length: Optional[int] = None,
                                  return_tensors=None,
                                  return_dict: bool = False):
        encoded_inputs = [
            self._truncate(ids, truncation=truncation, max_length=max_length)
            for ids in encoded_inputs
        ]

        needs_batch_encoding = (
            is_batched or padding or return_tensors is not None or return_dict)
        if not needs_batch_encoding:
            return encoded_inputs[0]

        features = [{
            "input_ids": ids,
            "attention_mask": [1] * len(ids)
        } for ids in encoded_inputs]
        batch = self.pad(features,
                         padding=padding,
                         max_length=max_length if padding else None,
                         return_attention_mask=True,
                         return_tensors=return_tensors)

        if return_dict:
            return batch
        if is_batched:
            return batch["input_ids"]
        return batch["input_ids"][0] if return_tensors is None else batch[
            "input_ids"]

    """ ----- Below are the abstract methods required by PreTrainedTokenizer ----- """

    @property
    def vocab_size(self) -> int:
        return self.n_words

    def get_vocab(self) -> Dict[str, int]:
        return self.encoder

    def _tokenize(self, text: str, **kwargs) -> List[str]:
        return [self.decoder[t] for t in self.encode(text)]

    def _convert_token_to_id(self, token: str) -> int:
        return self.encoder.get(token, self.unk_id)

    def _convert_id_to_token(self, index: int) -> str:
        return self.decoder.get(index)

    @staticmethod
    def clean_up_tokenization(out_string: str) -> str:
        return out_string

    def convert_tokens_to_string(self, tokens: List[str]) -> str:
        text = ''.join(tokens)
        text = bytearray([self.byte_decoder[c]
                          for c in text]).decode('utf-8', 'replace')
        return text

    def save_vocabulary(self,
                        save_directory: str,
                        filename_prefix: Optional[str] = None) -> Tuple[str]:
        if not os.path.isdir(save_directory):
            raise ValueError(
                f"vocabulary path ({save_directory}) should be a directory")
        out_vocab_file = os.path.join(
            save_directory,
            (filename_prefix + "-" if filename_prefix else "") +
            VOCAB_FILES_NAMES["vocab_file"])

        if os.path.abspath(self.vocab_file) != os.path.abspath(
                out_vocab_file) and os.path.isfile(self.vocab_file):
            copyfile(self.vocab_file, out_vocab_file)

        return (out_vocab_file, )

    def apply_chat_template(self,
                            conversation,
                            tools: Optional[list[dict]] = None,
                            tokenize: bool = False,
                            add_generation_prompt: bool = True,
                            thinking: bool = True,
                            padding=False,
                            truncation: bool = False,
                            max_length: Optional[int] = None,
                            return_tensors=None,
                            return_dict: bool = False,
                            **kwargs):
        # Tokenizer-level rendering reorders tool result messages to match
        # assistant tool_calls, normalizes per-call arguments and response
        # schema, then encodes the resulting XTML structure segment-by-segment.
        is_batched = is_batched_conversation(conversation)
        conversations = conversation if is_batched else [conversation]
        image_prompts = kwargs.pop("image_prompts", None)
        if is_batched and image_prompts is not None:
            raise ValueError("image_prompts is only supported for one chat.")
        
        # by default set thinking effort to max
        kwargs.setdefault("thinking_effort", "max")

        segment_batches = [
            build_chat_segments(
                messages,
                tools=tools,
                add_generation_prompt=add_generation_prompt,
                thinking=thinking,
                image_prompts=image_prompts,
                **kwargs,
            ) for messages in conversations
        ]

        if not tokenize:
            rendered = ["".join(segment.text for segment in segments)
                        for segments in segment_batches]
            return rendered if is_batched else rendered[0]

        encoded_inputs = [
            self._encode_chat_segments(segments) for segments in segment_batches
        ]
        return self._format_chat_token_output(
            encoded_inputs,
            is_batched=is_batched,
            padding=padding,
            truncation=truncation,
            max_length=max_length,
            return_tensors=return_tensors,
            return_dict=return_dict,
        )
