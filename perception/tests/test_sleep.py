"""
Stopping the machine this process runs on.

The decision is pure and the acting is not, so the decision is what gets
tested. Being wrong in one direction costs somebody's evening - they have
to start it again by hand - and being wrong in the other costs money for
as long as nobody notices, which on a weekend is the whole weekend.
"""

from __future__ import annotations

import json

from pact_perception.sleep import IDLE_GRACE_S, Sleeper, assertion, should_stop

NOW = 1_700_000_000.0


def test_a_live_feed_is_never_stopped() -> None:
    # The expensive mistake. A frame two seconds ago is a camera that is
    # still there, whatever else is true.
    assert should_stop(NOW - 2, NOW) is False


def test_it_waits_out_the_whole_grace() -> None:
    assert should_stop(NOW - IDLE_GRACE_S + 1, NOW) is False
    assert should_stop(NOW - IDLE_GRACE_S, NOW) is True


def test_a_machine_nothing_ever_reached_still_stops() -> None:
    # Started by mistake, or started for a demo that never happened. That is
    # exactly the instance worth stopping, so "never" counts as idle rather
    # than as a special case to skip.
    assert should_stop(0.0, NOW) is True


def test_a_grace_of_zero_disables_it() -> None:
    # Not "stop immediately". Somebody setting this to zero means to turn
    # the behaviour off, and the alternative reading stops the machine on
    # the first tick.
    assert should_stop(0.0, NOW, grace_s=0) is False


def test_it_does_nothing_without_both_halves() -> None:
    assert Sleeper("", "computeinstance-x").armed is False
    assert Sleeper('{"a":1}', "").armed is False
    assert Sleeper('{"a":1}', "computeinstance-x").armed is True


def test_a_failed_stop_does_not_latch() -> None:
    """
    A stop that failed must leave the sleeper willing to try again. Latching
    on a failure would turn one bad minute into a machine that bills until
    somebody notices - which is the exact outcome this file exists to stop.
    """
    import asyncio

    from pact_perception.log import Logger

    s = Sleeper("not json at all", "computeinstance-x", grace_s=1.0)
    log = Logger(room="test", level="error")
    # Driven directly: this project carries no async pytest plugin, and one
    # coroutine does not justify a dependency.
    asyncio.run(s.tick(0.0, log, now=NOW))
    # The key was unreadable, so the stop failed and it stays unasked -
    # a failure must not latch the machine into never trying again.
    assert s.asked is False


def test_the_assertion_carries_no_audience() -> None:
    """
    Nebius documents iss, sub and exp only. An assertion with an audience it
    did not ask for is rejected, and the rejection reads as a credential
    problem rather than as a claim problem.
    """
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    # 2048 here: Nebius wants 4096 in production, but this never leaves the
    # test and a 4096-bit keygen is seconds of nothing on every run.
    pem = (
        rsa.generate_private_key(public_exponent=65537, key_size=2048)
        .private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
        .decode()
    )
    tok = assertion(
        {"subject-id": "serviceaccount-abc", "public-key-id": "publickey-def", "private-key": pem},
        NOW,
    )
    head, body, sig = tok.split(".")

    def dec(part: str) -> dict:
        return json.loads(__import__("base64").urlsafe_b64decode(part + "=" * (-len(part) % 4)))

    assert dec(head) == {"alg": "RS256", "kid": "publickey-def"}
    claims = dec(body)
    assert "aud" not in claims
    assert claims["iss"] == claims["sub"] == "serviceaccount-abc"
    assert claims["exp"] - claims["iat"] == 300
    assert len(sig) > 100
