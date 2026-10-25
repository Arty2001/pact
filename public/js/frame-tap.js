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
 * The same, for a shared screen, and much shorter on purpose.
 *
 * The motion gate is built on an assumption that is true of a room and false
 * of a screen: that stillness means nothing is happening. An empty room is
 * worth nothing and a motionless screen is worth a great deal, because
 * reading a document for twenty minutes looks identical to a screensaver and
 * is exactly the behaviour a goal wants to credit. Gating it would make the
 * system go quiet during precisely the thing it is supposed to be watching.
 *
 * So a screen is never truly gated. It falls back to this slow heartbeat,
 * which keeps a still screen costing about a fifth of what an active one
 * does rather than costing nothing and seeing nothing.
 */
const SCREEN_IDLE_MS = 5_000;

/**
 * Longest edge of an uploaded frame, by surface.
 *
 * 640 is right for a camera: the encoder works at a few hundred pixels
 * square, so anything more is bandwidth spent on detail that is resized away
 * before it is looked at. It is wrong for a screen, and quietly so. The cheap
 * embedding does not care either way, but escalation does - the teacher's
 * whole job on a screen is to read what is on it, and at 640px a 1920px
 * desktop renders body text as a grey smear. The model then answers UNSURE
 * forever, which reads as a model that cannot do the task rather than as a
 * picture that never contained the answer.
 */
const MAX_EDGE = { camera: 640, screen: 1280 };

/**
 * JPEG quality, by surface. Screens are cheaper per pixel than photographs -
 * flat colour and sharp edges compress well - but they are also four times
 * the area here, so this claws back some of the bandwidth that buys.
 */
const QUALITY = { camera: 0.8, screen: 0.7 };

/**
 * Fraction of changed cells that counts as movement, by surface.
 *
 * A camera needs a real threshold because a camera is never quite still:
 * sensor noise and a flickering light move a few cells constantly, and 0.012
 * is what separates that from a person crossing the room.
 *
 * A screen has no sensor and therefore no noise. A changed cell is a cell
 * that genuinely changed, so the threshold drops to roughly one cell in a
 * thousand - about one cell of the 32x32 grid. Keeping the camera's figure
 * here would classify typing and scrolling as stillness, because editing a
 * line of text moves a small part of the screen very distinctly rather than
 * a large part of it faintly, which is the opposite of what the measure was
 * tuned for.
 */
const THRESHOLD = { camera: 0.012, screen: 0.001 };

/**
 * A hidden tab is a stopped tab, and nothing about it looks broken.
 *
 * Chrome clamps setTimeout in a background tab to once a second, then to
 * roughly once a minute after five minutes hidden. The camera stays on the
 * wall the whole time because that is a WebSocket the browser keeps open, so
 * every indicator says healthy while no frames are being sent at all. The
 * failure is especially cruel here: switching to the goals page to watch
 * your reps count is exactly what stops them counting.
 *
 * There is no way to opt out of the throttling, so the honest move is to
 * detect it and say so.
 */
const HIDDEN_GRACE_MS = 4_000;

/**
 * Uploads allowed in flight at once.
 *
 * Capture and upload are decoupled because a round trip to the edge is about
 * 130ms, and awaiting it inside the sample loop capped the publisher near
 * 7.5 fps however fast the encoder was - just under what a rep counter
 * needs, and entirely an artefact of how the loop was written. Letting a few
 * overlap removes that ceiling; letting unlimited overlap would turn a slow
 * network into unbounded memory and a growing backlog of stale frames.
 */
const MAX_IN_FLIGHT = 3;

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
   * @param {"camera"|"screen"} surface  what is being shared
   */
  constructor(video, room, surface = "camera") {
    this.video = video;
    this.room = room;
    /**
     * Nothing downstream can tell a screenshot from a photograph reliably,
     * and the whole pipeline behaves differently for each, so the one place
     * that knows for certain says so rather than letting it be inferred.
     */
    this.surface = surface === "screen" ? "screen" : "camera";

    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    this.small = document.createElement("canvas");
    this.small.width = this.small.height = GRID;
    this.smallCtx = this.small.getContext("2d", { willReadFrequently: true });

    this.prev = null;
    this.seq = 0;
    this.timer = null;
    this.undelivered = 0;
    this.threshold = THRESHOLD[this.surface];

    /** Requested by perception, which knows what the skills need. */
    this.hz = 0.5;

    this.stats = { sampled: 0, gated: 0, sent: 0, lastMoved: 0, delivered: 0, dropped: 0 };
    this.lastSentAt = 0;
    this.hiddenSince = 0;
    this.inFlight = 0;

    document.addEventListener("visibilitychange", () => {
      this.hiddenSince = document.hidden ? Date.now() : 0;
      // Coming back should resume immediately rather than waiting out a
      // throttled timer that may be a minute long.
      if (!document.hidden) this.start();
    });
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

  /** True while this tab is hidden and therefore being throttled. */
  get throttled() {
    return this.hiddenSince > 0 && Date.now() - this.hiddenSince > HIDDEN_GRACE_MS;
  }

  /** Seconds since a frame actually reached a worker, or null if never. */
  get staleFor() {
    return this.lastSentAt === 0 ? null : (Date.now() - this.lastSentAt) / 1000;
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

    // A still screen is still worth looking at, so its gate is a slowdown
    // rather than a stop. A still room is worth nothing, so its gate stays
    // the hard stop it was built to be.
    const quiet = this.surface === "screen" ? SCREEN_IDLE_MS : HEARTBEAT_MS;
    const stale = Date.now() - this.lastSentAt > quiet;
    if (moved < this.threshold && !stale) {
      this.stats.gated++;
      return;
    }

    const scale = Math.min(1, MAX_EDGE[this.surface] / Math.max(v.videoWidth, v.videoHeight));
    this.canvas.width = Math.round(v.videoWidth * scale);
    this.canvas.height = Math.round(v.videoHeight * scale);
    this.ctx.drawImage(v, 0, 0, this.canvas.width, this.canvas.height);

    const blob = await new Promise((r) =>
      this.canvas.toBlob(r, "image/jpeg", QUALITY[this.surface]),
    );
    if (!blob) return;

    // Dropping a frame beats queueing it. A backlog would deliver pictures of
    // a squat that finished seconds ago, and a state machine reading them
    // would time the dwell against the wrong clock entirely.
    if (this.inFlight >= MAX_IN_FLIGHT) {
      this.stats.dropped++;
      return;
    }

    this.seq++;
    this.lastSentAt = Date.now();
    this.inFlight++;
    // Deliberately not awaited: the next frame is due on a schedule, not
    // when the edge finishes replying.
    void this.upload(blob, this.seq).finally(() => {
      this.inFlight--;
    });
  }

  async upload(blob, seq) {
    let res;
    try {
      res = await fetch(`/api/frames/${encodeURIComponent(this.room)}`, {
        method: "POST",
        headers: {
          "Content-Type": "image/jpeg",
          "X-Frame-Seq": String(seq),
          "X-Frame-Surface": this.surface,
        },
        body: blob,
      });
    } catch {
      this.undelivered++;
      return;
    }
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
