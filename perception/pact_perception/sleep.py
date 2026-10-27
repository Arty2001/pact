"""
Stopping the machine this process is running on.

The control plane was going to do this - the Hub knows the moment a camera
arrives, which is the right signal - but a Cloudflare Worker cannot reach
Nebius: every one of their hosts is behind Cloudflare and the edge answers
522 on a call that returns 200 from anywhere else. So the decision moves to
the only thing that is both idle-aware and outside Cloudflare: the process
that would be idling.

That trades away waking up. A stopped machine cannot start itself, so
starting stays a deliberate act. Which half matters is not close: nobody
loses money by having to press start, and an instance left running over a
weekend is twenty-five dollars of nothing at all.

The grace period is longer here than it would have been in the control
plane for exactly that reason - coming back needs a person, so the cost of
stopping too eagerly is somebody's evening rather than a cold start.
"""

from __future__ import annotations

import base64
import json
import time

from .log import Logger

#: Nebius exchanges a signed assertion here. Not auth.nebius.com, which is
#: the console's own login and answers "Missing required parameter:
#: client_id" to anything a service account sends it.
_EXCHANGE = "https://auth.eu.nebius.com/oauth2/token/exchange"

#: How long nothing may arrive before the machine stops itself. Fifteen
#: minutes rather than ten: a camera that has gone quiet for a quarter of an
#: hour is a session that ended, and the cost of being wrong is a person
#: having to start this again.
IDLE_GRACE_S = 15 * 60.0


def should_stop(last_frame_at: float, now: float, grace_s: float = IDLE_GRACE_S) -> bool:
    """
    Whether this machine has had nothing to do for long enough to stop.

    One signal, deliberately: has any frame arrived. A publisher throttles a
    still screen to a slow heartbeat rather than to silence, and the motion
    gate runs after this, so frames keep coming from anything that is still
    there. Nothing at all means nothing is publishing.

    `last_frame_at` of zero means no frame has ever arrived - a machine that
    came up and was never used. That still counts, measured from the same
    clock: an instance started by mistake is exactly the one worth stopping.
    """
    if grace_s <= 0:
        return False
    return now - last_frame_at >= grace_s


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def assertion(key: dict[str, str], now: float, ttl_s: int = 300) -> str:
    """
    A short-lived JWT, signed with the service account's private key.

    No `aud` claim. Nebius documents iss, sub and exp only, and the exchange
    rejects an assertion carrying an audience it did not ask for - which is
    the kind of thing that reads as a credential problem and is not.
    """
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding

    sa, kid = key["subject-id"], key["public-key-id"]
    head = _b64(json.dumps({"alg": "RS256", "kid": kid}).encode())
    body = _b64(
        json.dumps({"iss": sa, "sub": sa, "iat": int(now), "exp": int(now) + ttl_s}).encode()
    )
    signing_input = f"{head}.{body}".encode()
    private = serialization.load_pem_private_key(key["private-key"].encode(), password=None)
    sig = private.sign(signing_input, padding.PKCS1v15(), hashes.SHA256())
    return f"{head}.{body}.{_b64(sig)}"


async def stop_self(key_json: str, instance_id: str, log: Logger) -> bool:
    """
    Trade the assertion for a token and tell Nebius to stop this instance.

    Returns whether the stop was accepted. Everything is reported rather
    than raised: a machine that failed to stop itself is a bill, not an
    outage, and the frame loop must not die over it.
    """
    import httpx

    try:
        key = json.loads(key_json)
    except Exception as err:
        log.error("service.error", detail=f"compute key is not JSON: {err}")
        return False
    if not all(k in key for k in ("subject-id", "public-key-id", "private-key")):
        log.error(
            "service.error",
            detail="compute key is missing subject-id, public-key-id or private-key",
        )
        return False

    try:
        async with httpx.AsyncClient(timeout=30.0) as http:
            res = await http.post(
                _EXCHANGE,
                data={
                    "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
                    "requested_token_type": "urn:ietf:params:oauth:token-type:access_token",
                    "subject_token_type": "urn:ietf:params:oauth:token-type:jwt",
                    "subject_token": assertion(key, time.time()),
                },
            )
            res.raise_for_status()
            token = res.json()["access_token"]

            stop = await http.post(
                "https://api.nebius.cloud/compute/v1/instances/stop",
                json={"id": instance_id},
                headers={"Authorization": f"Bearer {token}"},
            )
            # 409 is "already stopping", which is the goal rather than a
            # failure - two ticks racing each other is not an error.
            if stop.status_code not in (200, 409):
                log.error(
                    "service.error",
                    detail=f"stop refused: {stop.status_code} {stop.text[:120]}",
                )
                return False
    except Exception as err:
        log.error("service.error", detail=f"could not stop this machine: {err}")
        return False

    log.info(
        "service.stop",
        detail="nothing publishing, stopping this machine",
        instance=instance_id,
    )
    return True


class Sleeper:
    """
    Watches for an idle stretch and stops the machine once.

    Once, because the stop is not instant: Nebius acknowledges it and the
    process keeps running for a few seconds afterwards, and a tick that
    fired again in that window would send a second stop for no reason.
    """

    def __init__(self, key_json: str, instance_id: str, grace_s: float = IDLE_GRACE_S) -> None:
        self.key_json = key_json
        self.instance_id = instance_id
        self.grace_s = grace_s
        self.asked = False

    @property
    def armed(self) -> bool:
        """Both halves configured. Absent either, this does nothing at all."""
        return bool(self.key_json and self.instance_id and self.grace_s > 0)

    async def tick(self, last_frame_at: float, log: Logger, now: float | None = None) -> None:
        if not self.armed or self.asked:
            return
        if not should_stop(last_frame_at, now if now is not None else time.time(), self.grace_s):
            return
        self.asked = await stop_self(self.key_json, self.instance_id, log)
