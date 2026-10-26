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
import re
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

#: Longest edge of a frame sent to the teacher, by surface.
#:
#: 512 is right for a camera and quietly wrong for a screen. The question
#: asked of a camera is "which of these two postures is this", which survives
#: heavy downsampling. The question asked of a screen is almost always "what
#: does that text say" - which editor, which document, which site - and at
#: 512px a 1920px desktop renders body text as a grey smear. The model then
#: answers UNSURE every time, and the failure reads as a model that cannot do
#: the task rather than as a picture that never contained the answer.
#:
#: 1024 is where screen text becomes reliably legible. It is not free: a
#: teacher call on a screen costs roughly four times the input tokens of one
#: on a camera. That is affordable precisely because escalation is rare, and
#: it would not be if this ran on every frame.
_FRAME_PX = {"camera": 512, "screen": 1024, "any": 512}

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

#: The same job, against a shared screen rather than a room.
#:
#: A separate prompt rather than a sentence bolted onto the first one,
#: because almost every instruction differs. The evidence is text and layout
#: instead of posture and motion; consecutive frames of someone reading are
#: identical rather than a movement through its arc, so stillness has to be
#: named as uninformative rather than treated as absence; and the single most
#: likely wrong answer has to be headed off explicitly - a tab or an icon for
#: the right application is not the same as the right application being used,
#: and a model asked "is this person coding" will say yes to a visible editor
#: icon unless told otherwise.
_SYSTEM_SCREEN = (
    "You judge whether screenshots of a person's shared screen show a "
    "specific activity. You are the tie-breaker for an automated detector "
    "that could not decide.\n\n"
    "Read the screen. Window titles, file names, tab labels, menu bars and "
    "the content itself are all evidence, and they matter more than the "
    "general look of the application.\n\n"
    "Two cautions. The frames may be nearly identical, because someone "
    "reading or thinking does not move - that is not evidence of absence. "
    "And something merely being OPEN, visible in a tab, or present as an "
    "icon is not the same as it being WORKED ON; judge what currently has "
    "focus and fills the screen.\n\n"
    "Reply with exactly one line, no other text:\n"
    "  YES <confidence 0-1> <short reason, quoting what you read>\n"
    "  NO <confidence 0-1> <short reason, quoting what you read>\n"
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
        surface: str = "camera",
        context: str = "",
    ) -> Verdict | None:
        """
        Ask about one skill. Returns None if the call itself failed.

        A failed call is distinct from an UNSURE verdict: the first should be
        retried or reported, the second is a real answer that means the
        question goes to a person.

        `context` is what the gate above this skill was already satisfied
        about - "a code editor is on screen" when asking whether Python is
        being written. It is worth the tokens because it narrows a broad
        question to the one that is actually undecided, and because without
        it a screen question tends to be answered from the application rather
        than from the content.
        """
        if not frames:
            return None

        question = (
            f'Do these frames show: "{label}"?'
            if not classes
            else f'These frames show one of: {", ".join(classes)}. Is it "{label}"?'
        )
        if context:
            question = f"Already established: {context}.\n{question}"

        px = _FRAME_PX.get(surface, _FRAME_PX["camera"])
        content: list[dict[str, Any]] = [{"type": "text", "text": question}]
        for frame in frames[:FRAMES_PER_CALL]:
            content.append(
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/jpeg;base64,{_jpeg_b64(frame, px)}"},
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
                        {
                            "role": "system",
                            "content": _SYSTEM_SCREEN if surface == "screen" else _SYSTEM,
                        },
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

    def propose(
        self,
        frames: list[Image.Image],
        failing: str,
        surface: str = "screen",
        n: int = 5,
    ) -> list[str]:
        """
        Write candidate labels for what these frames actually show.

        This exists because an embedding cannot be turned back into words. A
        label starts as the encoding of a sentence, and a refit moves the
        vector away from it - so when a skill stops matching there is no way
        to ask the vector what it has become, and no way to read off what it
        SHOULD have said. Something that can see the frames has to write it.

        Generating and choosing are deliberately different jobs. The teacher
        can describe a screen and cannot know which phrasing separates it
        from everything else this camera sees; the embeddings know exactly
        that and cannot write a sentence. So this returns candidates, and
        the caller scores them against real frames.
        """
        if not frames:
            return []

        px = _FRAME_PX.get(surface, _FRAME_PX["camera"])
        ask = (
            f'An automatic detector is looking for "{failing}" and is not '
            "matching these frames, which the person says it should.\n\n"
            f"Write {n} different short captions of what is actually in "
            "these frames, one per line, numbered. Rules:\n"
            "- Name the kind of thing in the plainest words. No brand or "
            "product names.\n"
            "- A bare noun phrase. No 'a photo of', no 'a screenshot of', "
            "no trailing full stop.\n"
            "- Describe what FILLS the frame, never a small detail like a "
            "button, a badge or a tab.\n"
            "- One still frame must be able to show it. Nothing about "
            "motion, sequence or intent.\n"
            "- Vary them: some broader, some more specific. Do not rephrase "
            "the same sentence five times.\n"
            "Output only the numbered lines."
        )
        content: list[dict[str, Any]] = [{"type": "text", "text": ask}]
        for frame in frames[:FRAMES_PER_CALL]:
            content.append(
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/jpeg;base64,{_jpeg_b64(frame, px)}"},
                }
            )

        started = time.perf_counter()
        try:
            res = self._client.post(
                "/chat/completions",
                json={
                    "model": self.model,
                    "max_tokens": _MIN_MAX_TOKENS,
                    "temperature": 0.6,
                    "messages": [{"role": "user", "content": content}],
                },
            )
            res.raise_for_status()
        except Exception as err:
            self.log.error("service.error", detail=f"teacher propose failed: {err}")
            return []

        body = res.json()
        message = (body.get("choices") or [{}])[0].get("message") or {}
        text = (message.get("content") or "").strip()
        usage = body.get("usage") or {}
        self.log.info(
            "teacher.call",
            skill=failing,
            detail="proposing labels",
            frames=len(frames[:FRAMES_PER_CALL]),
            prompt_tokens=int(usage.get("prompt_tokens", 0)),
            completion_tokens=int(usage.get("completion_tokens", 0)),
            ms=round((time.perf_counter() - started) * 1000.0, 1),
        )
        return _candidates(text, n)

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


def _candidates(text: str, n: int) -> list[str]:
    """
    Numbered lines, cleaned into labels.

    The house style is enforced here as well as asked for, because a model
    told not to write a trailing full stop writes one anyway often enough to
    matter, and a label is compared character for character against the one
    it replaces.
    """
    out: list[str] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        line = re.sub(r"^\s*[-*\d]+[.)]?\s*", "", line).strip()
        line = line.strip("\"'").rstrip(".").strip()
        line = re.sub(
            r"^(this is |a photo of |a screenshot of |an image of )", "", line, flags=re.I
        )
        if 10 <= len(line) <= 140 and line.lower() not in {c.lower() for c in out}:
            out.append(line)
        if len(out) >= n:
            break
    return out


def _jpeg_b64(image: Image.Image, px: int = 512) -> str:
    im = image.convert("RGB")
    im.thumbnail((px, px), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=85)
    return base64.b64encode(buf.getvalue()).decode()
