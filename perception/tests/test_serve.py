"""
The encoder's HTTP face, against its own client.

`RemoteEmbedder` and `serve` are two halves of one wire format written at
different times, and nothing in the type system holds them together: the
client reads `vector`, the server writes it, and a rename on either side
would be discovered on a GPU instance at two in the morning rather than
here. So the test drives the real client against the real handler and lets
them disagree if they are going to.

The encoder itself is a stub. What is under test is the contract, not the
model - and a test that needs four gigabytes of weights is a test nobody
runs.
"""

from __future__ import annotations

import threading
from collections.abc import Iterator
from http.server import ThreadingHTTPServer

import numpy as np
import pytest
from PIL import Image

from pact_perception.embed import RemoteEmbedder, StubEmbedder
from pact_perception.log import Logger
from pact_perception.serve import Handler


@pytest.fixture
def url() -> Iterator[str]:
    """A real server on a real socket, torn down after the test."""
    embedder = StubEmbedder()
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    httpd.embedder = embedder
    # Quiet: the log writes to stdout and pytest captures it, but a failing
    # test is easier to read without a hundred embed.done lines in it.
    httpd.log = Logger(room="test", level="error")
    httpd.daemon_threads = True
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_address[1]}"
    finally:
        httpd.shutdown()
        httpd.server_close()


def a_frame() -> Image.Image:
    rng = np.random.default_rng(7)
    return Image.fromarray(rng.integers(0, 255, (384, 384, 3), dtype=np.uint8))


def test_the_client_can_read_what_the_server_writes(url: str) -> None:
    """The one that matters: both halves of the wire format, together."""
    client = RemoteEmbedder(url, encoder_id="stub/none@384")
    try:
        out = client.encode_image(a_frame())
        assert out.vector.shape == (StubEmbedder().dim,)
        # The client L2-normalises what it receives, so a unit vector back is
        # the evidence that a real vector arrived rather than zeros.
        assert np.isclose(float(np.linalg.norm(out.vector)), 1.0, atol=1e-5)
        assert out.ms > 0
    finally:
        client.close()


def test_text_round_trips_as_a_batch(url: str) -> None:
    client = RemoteEmbedder(url, encoder_id="stub/none@384")
    try:
        vectors = client.encode_text(["a person at a sink", "a dark code editor"])
        assert vectors.shape == (2, StubEmbedder().dim)
        # Two different sentences are two different directions, even from a
        # stub. Identical rows would mean the batch collapsed somewhere.
        assert not np.allclose(vectors[0], vectors[1])
    finally:
        client.close()


def test_an_empty_batch_is_not_an_error(url: str) -> None:
    # The registry fill asks for the labels it is missing, and sometimes it
    # is missing none. A 400 there would read as the endpoint being broken.
    client = RemoteEmbedder(url, encoder_id="stub/none@384")
    try:
        assert client.encode_text([]).size == 0
    finally:
        client.close()


def test_health_names_the_encoder(url: str) -> None:
    """
    A vector is only meaningful against a weight vector from the same
    encoder, and wrongness there is silent - the numbers look fine and mean
    nothing. So the endpoint says which encoder it is before anyone trusts
    it, and says it without needing a model loaded.
    """
    import httpx

    body = httpx.get(f"{url}/health", timeout=10).json()
    assert body["ok"] is True
    assert body["encoderId"] == "stub/none@384"
    assert body["dim"] == StubEmbedder().dim
    # A stub has no device. /health must still answer: a health check that
    # crashes on the embedder used in tests is not a health check.
    assert body["device"] == "unknown"


def test_a_corrupt_frame_is_the_callers_problem(url: str) -> None:
    """
    400, not 500. Perception drops a bad frame and keeps sampling; a 500
    would have it treat one corrupt JPEG as a dead endpoint and fall back,
    which is a far more expensive mistake than a lost frame.
    """
    import httpx

    res = httpx.post(
        f"{url}/embed/image",
        content=b"not a jpeg",
        headers={"Content-Type": "image/jpeg"},
        timeout=10,
    )
    assert res.status_code == 400


def test_the_shapes_that_should_be_refused(url: str) -> None:
    import httpx

    assert httpx.post(f"{url}/embed/text", content=b"{", timeout=10).status_code == 400
    bad = httpx.post(f"{url}/embed/text", json={"texts": "a string"}, timeout=10)
    assert bad.status_code == 400
    assert httpx.post(f"{url}/embed/text", json={"texts": [1, 2]}, timeout=10).status_code == 400
    assert httpx.get(f"{url}/nope", timeout=10).status_code == 404
    assert httpx.post(f"{url}/nope", json={}, timeout=10).status_code == 404


def test_an_oversized_body_is_refused_before_it_is_decoded(url: str) -> None:
    # Five megabytes of anything is a mistake or a probe. Decoding it would
    # cost the device time the real frames are queueing for.
    import httpx

    res = httpx.post(
        f"{url}/embed/image",
        content=b"\x00" * (5 * 1024 * 1024),
        headers={"Content-Type": "image/jpeg"},
        timeout=20,
    )
    assert res.status_code == 413
