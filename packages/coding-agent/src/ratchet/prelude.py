def _make_ratchet():
    def _paths(value):
        if value is None:
            return None
        return [value] if isinstance(value, str) else list(value)

    async def _call(flow, action, params):
        response = await _omp_prelude(
            "ratchet",
            {
                **{key: value for key, value in params.items() if value is not None},
                "flow": flow,
                "action": action,
            },
        )
        if isinstance(response, str):
            return {}
        if not isinstance(response, dict):
            raise RuntimeError("ratchet returned an invalid response")
        text = response.get("text")
        if isinstance(text, str) and text:
            print(text)
        return response.get("details")

    class _Flow:
        __slots__ = ("flow",)

        def __init__(self, flow):
            self.flow = flow

        def __repr__(self):
            return f"ratchet({self.flow!r})"

        async def init(self, *, cases, harness, change, off_limits=None, command=None):
            return await _call(
                self.flow,
                "init",
                {
                    "cases": _paths(cases),
                    "harness": _paths(harness),
                    "change": _paths(change),
                    "off_limits": _paths(off_limits),
                    "command": command,
                },
            )

        async def plan(self, *, goal=None, reps=None, stop=None, command=None, prices=None):
            return await _call(
                self.flow,
                "plan",
                {"goal": goal, "reps": reps, "stop": stop, "command": command, "prices": prices},
            )

        async def split(self, cases, *, test_fraction=None, seed=None):
            return await _call(
                self.flow, "split", {"cases": dict(cases), "test_fraction": test_fraction, "seed": seed}
            )

        async def approve(self, stage, *, question, preview):
            return await _call(self.flow, "approve", {"stage": stage, "question": question, "preview": preview})

        async def check(self, variant):
            return await _call(self.flow, "check", {"variant": variant})

        async def gate(self, variant, *, change=None):
            return await _call(self.flow, "gate", {"variant": variant, "change": change})

        async def train(self, variant):
            return await _call(self.flow, "train", {"variant": variant})

        async def status(self):
            return await _call(self.flow, "status", {})

    def ratchet(flow):
        return _Flow(flow)

    return ratchet


ratchet = _make_ratchet()
del _make_ratchet
