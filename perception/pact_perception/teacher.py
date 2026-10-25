"""
The teacher. The expensive model, called almost never.

When a skill sits between its thresholds for long enough, no amount of
further waiting resolves it: the score is not a miss and not a hit, and the
state machine has nothing left to decide with. That is the moment worth
spending a vision-language call on, and it is the only moment this module
runs. On the order of a tenth of a percent of frames reach here.

Two reasons it lives in perception rather than in the Worker. It needs the
frames, and frames stay put: shipping four JPEGs to a Durable Object so it
can ship them on to Nebius would put video through a Worker that is
deliberately never in the media path. And its answer is a label, which has
to be joined to the embedding of the frame it describes - and the embeddings
are here.

The trap worth knowing: Nemotron spends on the order of a hundred tokens
reasoning before it answers, counted against the same budget. Too low a
`max_tokens` returns a 200 with empty content rather than an error, which
looks exactly like a network failure and sends you debugging the wrong
layer. The floor is 512 and `reasoning_content` is read separately, so an
empty answer can be told apart from a quiet one.
"""

from __future__ import annotations

import base64
import io
import time
from dataclasses import dataclass
from typing import Any

import httpx
from PIL import Image

from .log import Logger

BASE = "https://api.tokenfactory.nebius.com/v1"

#: Below this, reasoning consumes the budget and content comes back empty.
_MIN_MAX_TOKENS = 512

#: Published Token Factory rates for the Nemotron Super tier, per million.
_USD_IN = 0.30
_USD_OUT = 0.90

#: Four frames is the brief's number and it is a reasonable one: enough to
#: show a motion through its arc, few enough to stay cheap. Sent at modest
#: resolution because the question is "which of these two things is this",
#: not "read the label on the bottle".
FRAMES_PER_CALL = 4
_FRAME_PX = 512

_SYSTEM = (
    "You judge whether a short burst of frames from a fixed camera shows a "
    "specific thing happening. You are the tie-breaker for an automated "
    "detector that could not decide, so answer decisively when the frames "
    "support it and say unsure when they genuinely do not.\n\n"
    "Reply with exactly one line, no other text:\n"
    "  YES <confidence 0-1> <short reason>\n"
    "  NO <confidence 0-1> <short reason>\n"
    "  UNSURE <short reason>"
)


@dataclass(frozen=True, slots=True)
class Verdict:
    """What the teacher decided, and what it cost to find out."""

    answer: str
    confidence: float
    reason: str
    ms: float
    usd: float
    prompt_tokens: int
    completion_tokens: int
    reasoning_tokens: int

    @property
    def label(self) -> int | None:
        """1, 0, or None when it declined. None must not become a label."""
        if self.answer == "YES":
            return 1
        if self.answer == "NO":
            return 0
        return None


class Teacher:
    def __init__(
        self,
        api_key: str,
        log: Logger,
        model: str = "nvidia/Nemotron-3.5-Super-VL",
        timeout: float = 90.0,
    ) -> None:
        self.model = model
        self.log = log
        self._client = httpx.Client(
            base_url=BASE,
            timeout=timeout,
            headers={"Authorization": f"Bearer {api_key}"},
        )

    def adjudicate(
        self,
        label: str,
        frames: list[Image.Image],
        classes: tuple[str, ...] = (),
    ) -> Verdict | None:
        """
        Ask about one skill. Returns None if the call itself failed.

        A failed call is distinct from an UNSURE verdict: the first should be
        retried or reported, the second is a real answer that means the
        question goes to a person.
        """
        if not frames:
            return None

        question = (
            f'Do these frames show: "{label}"?'
            if not classes
            else f'These frames show one of: {", ".join(classes)}. Is it "{label}"?'
        )

        content: list[dict[str, Any]] = [{"type": "text", "text": question}]
        for frame in frames[:FRAMES_PER_CALL]:
            content.append(
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/jpeg;base64,{_jpeg_b64(frame)}"},
                }
            )

        started = time.perf_counter()
        try:
            res = self._client.post(
                "/chat/completions",
                json={
                    "model": self.model,
                    "max_tokens": _MIN_MAX_TOKENS,
                    "temperature": 0.1,
                    "messages": [
                        {"role": "system", "content": _SYSTEM},
                        {"role": "user", "content": content},
                    ],
                },
            )
            res.raise_for_status()
        except Exception as err:
            self.log.error("service.error", detail=f"teacher call failed: {err}")
            return None

        ms = (time.perf_counter() - started) * 1000.0
        body = res.json()
        message = (body.get("choices") or [{}])[0].get("message") or {}
        text = (message.get("content") or "").strip()
        reasoning = (message.get("reasoning_content") or "").strip()
        usage = body.get("usage") or {}

        prompt_tokens = int(usage.get("prompt_tokens", 0))
        completion_tokens = int(usage.get("completion_tokens", 0))
        usd = prompt_tokens / 1e6 * _USD_IN + completion_tokens / 1e6 * _USD_OUT

        if not text:
            # The signature of a budget that ran out mid-thought. Named
            # explicitly because it is indistinguishable from a network
            # problem if you only look at content.
            self.log.warn(
                "service.error",
                detail="teacher returned empty content",
                reasoning_chars=len(reasoning),
                completion_tokens=completion_tokens,
            )
            return None

        answer, confidence, reason = _parse(text)
        verdict = Verdict(
            answer=answer,
            confidence=confidence,
            reason=reason,
            ms=ms,
            usd=usd,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            reasoning_tokens=int(usage.get("reasoning_tokens", 0)),
        )
        self.log.info(
            "teacher.call",
            skill=label,
            frames=len(frames[:FRAMES_PER_CALL]),
            prompt_tokens=verdict.prompt_tokens,
            completion_tokens=verdict.completion_tokens,
            reasoning_tokens=verdict.reasoning_tokens,
            ms=round(ms, 1),
            usd=round(usd, 6),
            verdict=f"{answer} {confidence:.2f} {reason}"[:120],
        )
        return verdict

    def close(self) -> None:
        self._client.close()


def _parse(text: str) -> tuple[str, float, str]:
    """
    Pull a verdict out of one line.

    Tolerant on purpose. The prompt asks for a fixed shape and the model
    mostly obliges, but a stray "Answer:" prefix or a missing confidence
    should degrade to a usable answer rather than throw away a call that has
    already been paid for.
    """
    first = text.splitlines()[0].strip().strip("*` ")
    upper = first.upper()

    answer = "UNSURE"
    for candidate in ("YES", "NO", "UNSURE"):
        if upper.startswith(candidate) or f" {candidate} " in f" {upper} ":
            answer = candidate
            break

    confidence = 0.5
    rest = first
    for token in first.replace(",", " ").split():
        try:
            value = float(token)
        except ValueError:
            continue
        if 0.0 <= value <= 1.0:
            confidence = value
            rest = first.split(token, 1)[-1]
            break

    reason = rest.strip(" :-\t").strip()
    if answer == "UNSURE":
        confidence = 0.0
    return answer, confidence, reason or first


def _jpeg_b64(image: Image.Image) -> str:
    im = image.convert("RGB")
    im.thumbnail((_FRAME_PX, _FRAME_PX), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=85)
    return base64.b64encode(buf.getvalue()).decode()
