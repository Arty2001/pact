/* ===========================================================================
   The frame tap, and the motion gate that runs in front of it.

   Two jobs, and the second one is the interesting one.

   The tap exists because perception cannot pull from the SFU. Doing that
   would mean decoding WebRTC in Python, with a codec the publisher chose and
   we do not control. The browser already holds the decoded stream in a video
   element, so a canvas and one POST replaces a whole media stack. It is also
   what lets a phone anywhere reach a perception service running in a cloud
   that the phone cannot address.

   The gate is the part that makes it cheap. L0 is the only level in the whole
   design that skips real work: every skill below it is a dot product against
   an embedding already paid for, so skipping skills saves microseconds, while
   skipping the embedding saves the entire cost of the frame. Running that
   test here rather than on the server means an empty room does not just avoid
   inference, it never sends the bytes at all. Nothing is cheaper than a
   request that was not made.

   The measure is the fraction of cells that changed on a 32x32 greyscale
   thumbnail, which is the same arithmetic perception uses on recorded folders
   so that live and replay agree. The downscale is the algorithm rather than
   an optimisation: at that size a person crossing the room moves a large
   share of the cells while sensor noise and a flickering light move almost
   none, and at full resolution the two are indistinguishable.
   =========================================================================== */

/** Side of the comparison thumbnail. Must match perception's gate. */
const GRID = 32;

/** Per-cell 0..1 change below this is sensor noise, not movement. */
const NOISE_FLOOR = 0.08;

/** Longest we will go without sending anything, so a still room stays alive. */
const HEARTBEAT_MS = 30_000;

/**
 * After this many consecutive posts that reached nobody, slow right down.
 * Perception may simply not be running, and a publisher that keeps uploading
 * into a void is the one thing worse than one that is not uploading at all.
 */
const IDLE_AFTER_UNDELIVERED = 3;
const IDLE_PERIOD_MS = 10_000;

export class FrameTap {
  /**
   * @param {HTMLVideoElement} video  the live preview, already playing
   * @param {string} room             which room these frames belong to
   */
  constructor(video, room) {
    this.video = video;
    this.room = room;

    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    this.small = document.createElement("canvas");
    this.small.width = this.small.height = GRID;
    this.smallCtx = this.small.getContext("2d", { willReadFrequently: true });

    this.prev = null;
    this.seq = 0;
    this.timer = null;
    this.undelivered = 0;
    this.threshold = 0.012;

    /** Requested by perception, which knows what the skills need. */
    this.hz = 0.5;

    this.stats = { sampled: 0, gated: 0, sent: 0, lastMoved: 0, delivered: 0 };
    this.lastSentAt = 0;
  }

  start() {
    this.stop();
    this.tick();
  }

  stop() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * True once several posts in a row have reached nobody.
   *
   * Worth surfacing rather than only backing off quietly. Publishing and
   * analysing are separate things that can each be up without the other, so
   * "my camera is on the wall" tells you nothing about whether anything is
   * watching it, and a goal that silently never advances is the single most
   * confusing way for this system to fail.
   */
  get unwatched() {
    return this.undelivered >= IDLE_AFTER_UNDELIVERED;
  }

  /** Perception asks for a rate; the browser owns the clock and obeys. */
  setRate(hz) {
    this.hz = Math.max(0.1, Math.min(hz, 15));
  }

  tick = async () => {
    const period = this.undelivered >= IDLE_AFTER_UNDELIVERED
      ? IDLE_PERIOD_MS
      : 1000 / this.hz;

    try {
      await this.sample();
    } catch {
      // A frame we could not grab is not worth stopping the publisher for.
    }
    this.timer = setTimeout(this.tick, period);
  };

  async sample() {
    const v = this.video;
    if (!v.videoWidth) return;

    this.stats.sampled++;

    // The gate reads the downscaled copy directly off the video, so a frame
    // that fails it never costs a full-size draw or a JPEG encode.
    this.smallCtx.drawImage(v, 0, 0, GRID, GRID);
    const cur = this.luma(this.smallCtx.getImageData(0, 0, GRID, GRID).data);

    const moved = this.prev === null ? 1 : fractionChanged(this.prev, cur);
    this.prev = cur;
    this.stats.lastMoved = moved;

    const stale = Date.now() - this.lastSentAt > HEARTBEAT_MS;
    if (moved < this.threshold && !stale) {
      this.stats.gated++;
      return;
    }

    // Cap the long edge. The encoder works at a few hundred pixels square, so
    // sending 1280x720 would spend bandwidth on detail that is resized away
    // before it is ever looked at.
    const scale = Math.min(1, 640 / Math.max(v.videoWidth, v.videoHeight));
    this.canvas.width = Math.round(v.videoWidth * scale);
    this.canvas.height = Math.round(v.videoHeight * scale);
    this.ctx.drawImage(v, 0, 0, this.canvas.width, this.canvas.height);

    const blob = await new Promise((r) => this.canvas.toBlob(r, "image/jpeg", 0.8));
    if (!blob) return;

    this.seq++;
    this.lastSentAt = Date.now();

    const res = await fetch(`/api/frames/${encodeURIComponent(this.room)}`, {
      method: "POST",
      headers: { "Content-Type": "image/jpeg", "X-Frame-Seq": String(this.seq) },
      body: blob,
    });

    if (!res.ok) {
      this.undelivered++;
      return;
    }
    const { delivered, hz } = await res.json();
    this.stats.sent++;
    this.stats.delivered = delivered;
    this.undelivered = delivered > 0 ? 0 : this.undelivered + 1;

    // Perception knows what the eligible skills need; we only know how to
    // obey. A gate is fine at 0.5 fps and a rep counter is blind below 4, so
    // this is what makes a counter possible at all.
    if (typeof hz === "number" && hz > 0) this.setRate(hz);
  }

  /** RGBA bytes to a Float32Array of luma in 0..1. */
  luma(rgba) {
    const out = new Float32Array(GRID * GRID);
    for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
      out[p] = (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) / 255;
    }
    return out;
  }
}

function fractionChanged(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > NOISE_FLOOR) n++;
  }
  return n / a.length;
}
