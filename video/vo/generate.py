"""
Render the scratch voiceover, one file per beat.

Separate files rather than one long track: each beat drops onto its own
Sequence so a line can be re-recorded without re-cutting the film, and the
measured duration of each file is what the timeline is fitted to.

The synthesiser's endpoint drops a request every so often and returns no
audio at all rather than an error worth reading, so each line is retried and
a zero-byte result is treated as a failure. Without that, one flaky call
leaves a silent beat in the render and nothing says so.
"""

import asyncio
import pathlib
import sys

import edge_tts

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from lines import LINES, RATE, VOICE  # noqa: E402

OUT = pathlib.Path(__file__).parent.parent / "public" / "vo"
ATTEMPTS = 5


async def render(key: str, text: str) -> None:
    target = OUT / f"{key}.mp3"
    for attempt in range(1, ATTEMPTS + 1):
        try:
            await edge_tts.Communicate(text, VOICE, rate=RATE).save(str(target))
            # The endpoint sometimes returns a VALID but truncated file - a
            # couple of seconds of a twenty second line - which a byte floor
            # waves through and which then renders as a beat that goes quiet
            # halfway. These files are a constant 6 kB per second, so the
            # word count gives an expected length to check against.
            size = target.stat().st_size
            expect = len(text.split()) * 0.33 * 6000
            if size >= expect * 0.65:
                print(f"{key}  {size // 1024} KB  ~{size / 6000:.1f}s")
                return
            raise RuntimeError(f"truncated: {size / 6000:.1f}s, expected ~{expect / 6000:.1f}s")
        except Exception as err:  # noqa: BLE001 - any failure is worth retrying
            if attempt == ATTEMPTS:
                raise
            print(f"{key}  attempt {attempt} failed ({err}), retrying")
            await asyncio.sleep(1.5 * attempt)


async def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for key, text in LINES:
        await render(key, text)


asyncio.run(main())
