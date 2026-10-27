"""
The encoder, behind HTTP.

`RemoteEmbedder` has always been able to talk to an encoder somewhere else;
this is the other half of that conversation. The split it enables is the one
the architecture wants: the stateful work - a WebRTC subscription, per-room
calibration, the state machines and their dwell timers - stays next to the
cameras, and the one genuinely stateless step runs wherever there is a GPU.

A frame in, eleven hundred and fifty-two numbers out. Nothing is remembered
between requests, which is what makes this the only part of perception that
can live on a serverless endpoint at all.

    python -m pact_perception.serve --port 8080

No web framework. The whole surface is three routes and the work is a matmul
on a GPU, so a framework would add a dependency, a startup cost and a layer
of indirection to save about forty lines of argument parsing. The standard
library's threading server is also the right shape here: requests queue
behind one device, and more concurrency than a couple of threads would only
contend for it.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from PIL import Image

from .embed import Embedder, LocalEmbedder, usable_cpus
from .log import Logger

#: Refuse a body larger than this. A 384px JPEG is tens of kilobytes, so
#: anything near a megabyte is a mistake or a probe, and decoding it would
#: cost the GPU time the real frames are queueing for.
_MAX_BODY = 4 * 1024 * 1024


class Handler(BaseHTTPRequestHandler):
    """One request. The encoder and the log come from the server."""

    protocol_version = "HTTP/1.1"

    # The base class writes its own access log to stderr, one unstructured
    # line per request, which would drown the structured log this project
    # actually reads. Silenced rather than reformatted: every request already
    # emits an embed.done with its timing.
    def log_message(self, fmt: str, *args: Any) -> None:
        return

    @property
    def embedder(self) -> Embedder:
        return self.server.embedder  # type: ignore[attr-defined]

    @property
    def log(self) -> Logger:
        return self.server.log  # type: ignore[attr-defined]

    def do_GET(self) -> None:
        if self.path != "/health":
            self._send(404, {"error": "not found"})
            return
        # What the caller needs to know before trusting a vector: which
        # encoder produced it. A score computed against a weight vector from
        # a different encoder is meaningless, and silently so - the numbers
        # look fine and mean nothing.
        self._send(
            200,
            {
                "ok": True,
                "encoderId": self.embedder.encoder_id,
                "dim": self.embedder.dim,
                "device": getattr(self.embedder, "device", "unknown"),
                # Reported because getting this wrong is invisible: the
                # encoder simply runs slower than the machine it is on.
                "threads": getattr(self.embedder, "threads", 0),
            },
        )

    def do_POST(self) -> None:
        body = self._read()
        if body is None:
            return
        if self.path == "/embed/image":
            self._image(body)
        elif self.path == "/embed/text":
            self._text(body)
        else:
            self._send(404, {"error": "not found"})

    # --------------------------------------------------------------- routes

    def _image(self, body: bytes) -> None:
        try:
            image = Image.open(io.BytesIO(body))
            image.load()
        except Exception as err:
            # A bad frame is the caller's problem, not an outage. Answering
            # 400 lets perception drop it and keep sampling; a 500 would have
            # it treat a corrupt JPEG as a dead endpoint.
            self.log.warn("service.error", detail=f"undecodable image: {err}")
            self._send(400, {"error": "could not decode the image"})
            return

        started = time.perf_counter()
        try:
            out = self.embedder.encode_image(image)
        except Exception as err:
            self.log.error("service.error", detail=f"encode_image failed: {err}")
            self._send(500, {"error": "encode failed"})
            return

        self.log.debug("embed.done", ms=round(out.ms, 1), dim=int(out.vector.shape[-1]))
        self._send(
            200,
            {"vector": out.vector.tolist(), "ms": round((time.perf_counter() - started) * 1000, 1)},
        )

    def _text(self, body: bytes) -> None:
        try:
            texts = json.loads(body).get("texts")
        except Exception:
            self._send(400, {"error": "body must be JSON"})
            return
        if not isinstance(texts, list) or not all(isinstance(s, str) for s in texts):
            self._send(400, {"error": "texts must be a list of strings"})
            return
        if not texts:
            self._send(200, {"vectors": []})
            return

        try:
            vectors = self.embedder.encode_text(texts)
        except Exception as err:
            self.log.error("service.error", detail=f"encode_text failed: {err}")
            self._send(500, {"error": "encode failed"})
            return

        self.log.info(
            "embed.done", ms=0, dim=int(vectors.shape[-1]), detail=f"{len(texts)} label(s)"
        )
        self._send(200, {"vectors": [v.tolist() for v in vectors]})

    # ---------------------------------------------------------------- plumbing

    def _read(self) -> bytes | None:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            self._send(411, {"error": "Content-Length is required"})
            return None
        if length > _MAX_BODY:
            self._send(413, {"error": "body too large"})
            return None
        return self.rfile.read(length)

    def _send(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def serve(host: str, port: int, embedder: Embedder, log: Logger) -> None:
    httpd = ThreadingHTTPServer((host, port), Handler)
    httpd.embedder = embedder  # type: ignore[attr-defined]
    httpd.log = log  # type: ignore[attr-defined]
    # Threads die with the process. A request still in flight when the
    # endpoint is told to stop is a frame perception will resend anyway.
    httpd.daemon_threads = True
    log.info(
        "service.start",
        detail="encoder serving",
        host=host,
        port=port,
        encoder_id=embedder.encoder_id,
        device=getattr(embedder, "device", "unknown"),
    )
    try:
        httpd.serve_forever()
    finally:
        httpd.server_close()
        log.info("service.stop", detail="encoder stopped")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    # PORT from the environment first: every serverless runtime assigns one
    # and expects the process to listen on it rather than on a port of its
    # own choosing.
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8080")))
    ap.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"))
    ap.add_argument("--model", default=os.environ.get("PACT_MODEL", "c-radio_v3-b"))
    ap.add_argument("--adaptor", default=os.environ.get("PACT_ADAPTOR", "siglip2"))
    ap.add_argument("--resolution", type=int, default=int(os.environ.get("PACT_RESOLUTION", "384")))
    ap.add_argument("--device", default=os.environ.get("PACT_DEVICE", "auto"))
    ap.add_argument("--level", default=os.environ.get("PACT_LEVEL", "info"))
    a = ap.parse_args()

    # OpenMP and MKL keep their own pools and read these at import time, so
    # they are set before the encoder is built. torch.set_num_threads alone
    # leaves them at the host's core count, which is the same contention the
    # cgroup fix exists to stop - just one layer down where it is harder to
    # see.
    cpus = str(usable_cpus())
    os.environ.setdefault("OMP_NUM_THREADS", cpus)
    os.environ.setdefault("MKL_NUM_THREADS", cpus)

    log = Logger(room="encoder", level=a.level)
    # Loaded before the socket opens, deliberately. A serverless endpoint
    # that accepts requests while four gigabytes are still loading reports
    # itself healthy and then times out every caller for a minute.
    log.info("service.start", detail="loading the encoder")
    embedder = LocalEmbedder(
        version=a.model, adaptor=a.adaptor, resolution=a.resolution, device=a.device
    )
    serve(a.host, a.port, embedder, log)


if __name__ == "__main__":
    main()
