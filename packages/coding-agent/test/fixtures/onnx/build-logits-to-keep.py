"""Regenerate logits-to-keep.onnx, the fixture behind tiny-logits-to-keep.test.ts.

The graph mirrors LiquidAI's LFM3 export signature as far as this fix depends on it:
`logits_to_keep` is a *required* int64 input of shape [1], and the `logits` output is
the last `logits_to_keep` rows of the token axis, so a wrong shape, dtype, or a missing
feed all fail at `session.run()` instead of silently producing tokens.

Run it in a container so no host Python packages are installed:

    docker run --rm -v "$PWD":/out python:3.12-slim \
        sh -c 'pip install --quiet onnx && python /out/build-logits-to-keep.py'
"""

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

TOKENS = 4
OUTPUT = __file__.replace("build-logits-to-keep.py", "logits-to-keep.onnx")


def main() -> None:
    nodes = [
        # Every declared input is consumed: ORT drops graph inputs an optimizer can
        # prove unused, which would weaken the "missing input" assertion.
        helper.make_node("Cast", ["input_ids"], ["ids"], to=TensorProto.FLOAT),
        helper.make_node("Cast", ["attention_mask"], ["mask"], to=TensorProto.FLOAT),
        helper.make_node("Cast", ["position_ids"], ["pos"], to=TensorProto.FLOAT),
        helper.make_node("Mul", ["mask", "zero"], ["masked"]),
        helper.make_node("Add", ["ids", "masked"], ["with_mask"]),
        helper.make_node("Mul", ["pos", "zero"], ["positioned"]),
        helper.make_node("Add", ["with_mask", "positioned"], ["hidden"]),
        # Last `logits_to_keep` rows: starts=-k, ends=INT64_MAX, axis=1.
        helper.make_node("Neg", ["logits_to_keep"], ["neg_keep"]),
        helper.make_node("Slice", ["hidden", "neg_keep", "int64_max", "axis"], ["logits"]),
    ]
    graph = helper.make_graph(
        nodes=nodes,
        name="logits-to-keep",
        inputs=[
            helper.make_tensor_value_info("input_ids", TensorProto.INT64, [1, TOKENS]),
            helper.make_tensor_value_info("attention_mask", TensorProto.INT64, [1, TOKENS]),
            helper.make_tensor_value_info("position_ids", TensorProto.INT64, [1, TOKENS]),
            helper.make_tensor_value_info("logits_to_keep", TensorProto.INT64, [1]),
        ],
        outputs=[helper.make_tensor_value_info("logits", TensorProto.FLOAT, [1, None])],
        initializer=[
            numpy_helper.from_array(np.array([0.0], dtype=np.float32), "zero"),
            numpy_helper.from_array(np.array([np.iinfo(np.int64).max], dtype=np.int64), "int64_max"),
            numpy_helper.from_array(np.array([1], dtype=np.int64), "axis"),
        ],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)])
    # onnxruntime-node 1.30 (the version transformers.js pins) rejects anything newer
    # than IR 13, and current `onnx` releases default to 14.
    model.ir_version = 10
    onnx.checker.check_model(model)
    onnx.save(model, OUTPUT)
    print(f"wrote {OUTPUT}")


if __name__ == "__main__":
    main()
