#include "vision.h"

#include <stdio.h>
#include <string.h>

#include <stdlib.h>

#include "esp_camera.h"
#include "esp_log.h"
#include "esp_timer.h"

static const char *TAG = "vision";

/* Detector grid. 40x30 on QVGA gives 8x8 pixel cells.
 *
 * Four times finer than the 20x15 this started with, because that was too
 * coarse for the actual job: someone standing across the room covered only
 * 8-12 cells, barely above the noise floor, and a single cell spanned 2.5
 * degrees so the aim could not be more precise than that either. Each cell
 * still averages 16 samples - the sampling step halves with the cell size -
 * so the per-cell noise is unchanged. */
#define GW 40
#define GH 30
#define GN (GW * GH)

/* Floor for how far a cell must sit from the background model to count as
   part of a person, and for how much it must change to count as moving.
   From scoring against recorded footage of a bright room: at 12, 719 frames
   of empty room produced zero detections while a person was found in about
   80% of frames.
 *
 * A FLOOR, not the value. Sensor noise depends heavily on the scene - the
 * same thresholds that were right for a sunlit kitchen lit 280 of 1200
 * cells on dark curtains, because in low light the sensor gains up and
 * every cell dances. A fixed threshold has to be wrong in one direction or
 * the other, so the real threshold is measured from the frame itself each
 * time, and these only stop it dropping absurdly low in a flat scene. */
#define FG_FLOOR   12
#define MOVE_FLOOR 10

/* How many times the measured noise level a change must exceed. */
#define NOISE_MULTIPLE 4

/* How long a cell stays protected after it last moved.
 *
 * In MICROSECONDS, not frames. Counted in frames this silently depends on
 * how fast the loop happens to run, so tripling the frame rate would have
 * cut how long someone can stand still before the room absorbs them -
 * a coupling between two things that have no business being related. */
#define MOVE_HOLD_US 30000000

/* Smallest blob that counts as a person, in cells of the 40x30 grid.
   Scaled from the 20x15 measurement where an empty room never exceeded 5
   connected cells and a person across the room ran 8-12; four times the
   cells means four times both. Verified against the device's own
   empty-room reporting after the change. */
#define MIN_CELLS 28

/* How fast the background learns. Cells that look like background follow
   the room quickly; cells held by recent motion barely move, so a person
   standing still is not dissolved. */
#define LEARN_FAST 0.03f
#define LEARN_SLOW 0.001f

/* Frames spent learning the room before any detection is reported, and how
   fast it learns during them.
 *
 * This runs after EVERY head move, so it is a direct cost in
 * responsiveness - at ~4 fps, 8 frames is about two seconds before the
 * robot can see again. Learning fast while warming up is what keeps it
 * short: at the normal rate the model would still be two-thirds of the
 * single frame it started from, and the leftover would be reported as a
 * person standing in the corner. That is exactly what the log showed - a
 * detection immediately after each move, then nothing. */
#define WARMUP 8
#define LEARN_WARMUP 0.3f

static float   s_bg[GN];
static int64_t s_last_move[GN];
/* Set whenever the model is dropped: the next grab must discard the frames
   the driver queued while the head was moving. */
static bool    s_need_drain;
static uint8_t s_prev[GN];
static uint8_t s_snap[GN];
static bool    s_have_snap;
static int32_t s_frame;
static bool    s_learning;
static int     s_w, s_h;

/* What the last look concluded, kept only so the debug view shows what the
   detector actually saw rather than a fresh frame that may differ. */
static bool    s_last_fg[GN];
static int     s_last_cells;
static int     s_last_thr;
static float   s_last_x, s_last_y;
static bool    s_last_valid;

/* ------------------------------------------------------------------ init -- */

bool vision_begin(void)
{
    /* Straight from M5's own GC0308 driver for this board. pin_xclk is -1:
       the sensor runs from its own oscillator, and there are no power or
       reset pins to sequence. */
    camera_config_t cfg = {
        .pin_pwdn     = -1,
        .pin_reset    = -1,
        .pin_xclk     = -1,
        .pin_sccb_sda = 12,
        .pin_sccb_scl = 11,
        .pin_d7 = 47, .pin_d6 = 48, .pin_d5 = 16, .pin_d4 = 15,
        .pin_d3 = 42, .pin_d2 = 41, .pin_d1 = 40, .pin_d0 = 39,
        .pin_vsync = 46,
        .pin_href  = 38,
        .pin_pclk  = 45,

        .xclk_freq_hz = 20000000,
        .ledc_timer   = LEDC_TIMER_0,
        .ledc_channel = LEDC_CHANNEL_0,

        .pixel_format  = PIXFORMAT_RGB565,
        .frame_size    = FRAMESIZE_QVGA,
        .jpeg_quality  = 0,
        .fb_count      = 2,
        .fb_location   = CAMERA_FB_IN_PSRAM,
        /* LATEST, not WHEN_EMPTY. WHEN_EMPTY hands back the OLDEST queued
           frame, so after the head had been still for a second both buffers
           still held frames exposed while it was moving. Measured with the
           startup sweep: the montage ran two frames behind the servo, and
           the first stop showed where the head had been before the sweep
           began. That stale frame became the reference for the next
           comparison, which reported the whole room as having moved. */
        .grab_mode     = CAMERA_GRAB_LATEST,
        .sccb_i2c_port = -1,
    };

    const esp_err_t err = esp_camera_init(&cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "camera init failed: %s", esp_err_to_name(err));
        return false;
    }

    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) {
        ESP_LOGE(TAG, "camera up but no frame");
        return false;
    }
    s_w = fb->width;
    s_h = fb->height;
    ESP_LOGI(TAG, "camera %dx%d, grid %dx%d", s_w, s_h, GW, GH);
    esp_camera_fb_return(fb);

    vision_forget();
    return true;
}

void vision_frame_size(int *w, int *h) { if (w) *w = s_w; if (h) *h = s_h; }
void vision_grid_size(int *w, int *h)  { if (w) *w = GW;  if (h) *h = GH; }

void vision_forget(void)
{
    /* The snapshot deliberately survives this. It belongs to the gain
       measurement, which works by snapshotting, MOVING THE HEAD, and
       comparing - and moving the head is exactly when the room model has to
       be thrown away. Clearing both here meant vision_shift() always found
       no snapshot and reported the scene as too plain to measure, so the
       robot silently fell back to assumed constants every boot. */
    s_learning   = true;
    s_frame      = 0;
    s_need_drain = true;
    s_last_valid = false;
    s_last_cells = 0;
    memset(s_last_fg, 0, sizeof(s_last_fg));
}

static bool grab_grid(uint8_t *grid);

void vision_reframe(float dx_cells, float dy_cells)
{
    /* Nothing learned yet, or a shift so large that almost nothing overlaps
       - relearning is cheaper and safer than sliding in mostly-unknown
       cells. */
    const int dx = (int)(dx_cells + (dx_cells >= 0 ? 0.5f : -0.5f));
    const int dy = (int)(dy_cells + (dy_cells >= 0 ? 0.5f : -0.5f));
    if (s_learning || dx <= -GW || dx >= GW || dy <= -GH || dy >= GH) {
        vision_forget();
        return;
    }

    /* A fresh view to seed whatever swung in from off-frame, and to be the
       reference the next frame is differenced against. Taken first, because
       the queued frames still show where the head used to point. */
    s_need_drain = true;
    static uint8_t fresh[GN];
    if (!grab_grid(fresh)) { vision_forget(); return; }

    static float   bg2[GN];
    static int64_t mv2[GN];
    const int64_t long_ago = INT64_MIN / 2;

    for (int y = 0; y < GH; y++) {
        for (int x = 0; x < GW; x++) {
            const int i = y * GW + x;
            /* Cell (x,y) now shows what used to be at (x-dx, y-dy). */
            const int sx = x - dx, sy = y - dy;
            if (sx < 0 || sx >= GW || sy < 0 || sy >= GH) {
                bg2[i] = (float)fresh[i];   /* new ground: assume background */
                mv2[i] = long_ago;          /* and nothing has moved in it */
            } else {
                const int j = sy * GW + sx;
                bg2[i] = s_bg[j];
                /* The brightness model slides, the motion history does NOT.
                 *
                 * Carrying protection across a move compounds: each slide
                 * misaligns edges by a fraction of a cell, protected cells
                 * are never corrected, and the error grows with every move.
                 * Measured live, the blob went 29 -> 92 -> 282 -> 443 -> 592
                 * cells over consecutive moves until half the frame counted
                 * as a person and drove the head into its pitch stop.
                 *
                 * Dropping it costs nothing real. Protection exists to keep
                 * someone standing still from dissolving - but if the head
                 * just moved, it moved BECAUSE they moved, so they will
                 * register again within a frame or two and earn it back. */
                mv2[i] = long_ago;
            }
        }
    }

    memcpy(s_bg, bg2, sizeof(s_bg));
    memcpy(s_last_move, mv2, sizeof(s_last_move));
    memcpy(s_prev, fresh, sizeof(s_prev));
    s_last_valid = false;
    s_last_cells = 0;
    memset(s_last_fg, 0, sizeof(s_last_fg));
}

/* -------------------------------------------------------------- sampling -- */

/**
 * Get a frame that is actually current.
 *
 * The driver keeps fb_count buffers filled continuously, so a frame handed
 * back right after a pause can have been exposed before the pause. The
 * queued ones therefore have to go - but ONLY after the head has moved.
 *
 * Draining on every single look, which is what this used to do, cost three
 * sensor frames per look instead of one and held the whole tracking loop to
 * a third of the rate the camera could sustain. While the head is still,
 * consecutive frames are all equally current and there is nothing stale to
 * throw away.
 */
static camera_fb_t *grab_fresh(void)
{
    if (s_need_drain) {
        for (int i = 0; i < 2; i++) {
            camera_fb_t *stale = esp_camera_fb_get();
            if (!stale) return NULL;
            esp_camera_fb_return(stale);
        }
        s_need_drain = false;
    }
    return esp_camera_fb_get();
}

/** Reduce a frame to a GW x GH brightness grid. */
static void sample(const camera_fb_t *fb, uint8_t *grid)
{
    const uint16_t *px = (const uint16_t *)fb->buf;
    const int cw = fb->width / GW;
    const int ch = fb->height / GH;

    for (int gy = 0; gy < GH; gy++) {
        for (int gx = 0; gx < GW; gx++) {
            uint32_t sum = 0;
            int n = 0;
            for (int y = gy * ch; y < (gy + 1) * ch; y += 2) {
                for (int x = gx * cw; x < (gx + 1) * cw; x += 2) {
                    const uint16_t p = px[y * fb->width + x];
                    const int r = (p >> 11) & 0x1F;
                    const int g = (p >> 5) & 0x3F;
                    const int b = p & 0x1F;
                    sum += (uint32_t)((r << 1) + g + (b << 1));
                    n++;
                }
            }
            grid[gy * GW + gx] = n ? (uint8_t)(sum / n) : 0;
        }
    }
}

static bool grab_grid(uint8_t *grid)
{
    camera_fb_t *fb = grab_fresh();
    if (!fb) return false;
    sample(fb, grid);
    esp_camera_fb_return(fb);
    return true;
}

/**
 * Median of a set of differences.
 *
 * The median and not the mean, because the GC0308 runs auto-exposure
 * continuously and the whole image drifts in brightness on its own. That is
 * a global shift and has to come out, but a person can cover a third of the
 * frame - enough to drag a mean along with them and hide themselves.
 * A histogram is the cheap way to a median on 300 small integers.
 */
static int median_of(const int16_t *d, int n)
{
    static uint16_t hist[512];
    memset(hist, 0, sizeof(hist));
    for (int i = 0; i < n; i++) {
        int v = d[i] + 256;
        if (v < 0) v = 0;
        if (v > 511) v = 511;
        hist[v]++;
    }
    int seen = 0;
    for (int v = 0; v < 512; v++) {
        seen += hist[v];
        if (seen * 2 >= n) return v - 256;
    }
    return 0;
}

/**
 * Spread of a set of differences, measured robustly.
 *
 * Median absolute deviation rather than a standard deviation, for the same
 * reason the median is used to remove global drift: a person can cover a
 * third of the frame, and a measure that they can drag along with them
 * would raise the threshold until they no longer register.
 */
static int mad_of(const int16_t *d, int n, int med)
{
    static int16_t dev[GN];
    for (int i = 0; i < n; i++) {
        const int v = d[i] - med;
        dev[i] = (int16_t)(v < 0 ? -v : v);
    }
    return median_of(dev, n);
}

/* ------------------------------------------------------------------ blob -- */

/**
 * Biggest connected run of foreground cells, and where to aim at it.
 *
 * A person is one connected thing. Averaging over every lit cell mixes the
 * person with any scattered noise and lands the aim between them, on
 * nothing. Flood fill is trivial on 300 cells.
 *
 * The y returned is near the TOP of the blob rather than its centre: a
 * standing person runs head to feet, so the centroid is at the waist.
 */
static int largest_blob(const bool *fg, float *out_x, float *out_y)
{
    static int16_t stack[GN];
    static bool seen[GN];
    static int16_t rows[GN];
    memset(seen, 0, sizeof(seen));

    int best = 0;

    for (int start = 0; start < GN; start++) {
        if (!fg[start] || seen[start]) continue;

        int sp = 0, count = 0, sum_x = 0;
        stack[sp++] = (int16_t)start;
        seen[start] = true;

        while (sp > 0) {
            const int i = stack[--sp];
            const int x = i % GW, y = i / GW;
            rows[count] = (int16_t)y;
            sum_x += x;
            count++;

            const int nb[4] = {
                (x > 0)      ? i - 1  : -1,
                (x < GW - 1) ? i + 1  : -1,
                (y > 0)      ? i - GW : -1,
                (y < GH - 1) ? i + GW : -1,
            };
            for (int k = 0; k < 4; k++) {
                const int j = nb[k];
                if (j >= 0 && fg[j] && !seen[j]) {
                    seen[j] = true;
                    stack[sp++] = (int16_t)j;
                }
            }
        }

        if (count > best) {
            best = count;

            /* Row at the 20th percentile: head and shoulders, not waist.
               Counting sort, because the rows are 0..GH-1. */
            int bins[GH] = {0};
            for (int k = 0; k < count; k++) bins[rows[k]]++;
            const int want = count / 5;
            int seen_n = 0, row = 0;
            for (int r = 0; r < GH; r++) {
                seen_n += bins[r];
                if (seen_n > want) { row = r; break; }
            }

            const float cx = (float)sum_x / (float)count;
            *out_x = (cx - (GW - 1) * 0.5f) / ((GW - 1) * 0.5f);
            *out_y = ((float)row - (GH - 1) * 0.5f) / ((GH - 1) * 0.5f);
        }
    }
    return best;
}

/* ------------------------------------------------------------------ look -- */

bool vision_look(motion_t *out)
{
    if (!out) return false;
    memset(out, 0, sizeof(*out));
    s_last_valid = false;

    static uint8_t grid[GN];
    if (!grab_grid(grid)) return false;
    const int64_t now_us = esp_timer_get_time();

    /* First frame after forgetting: seed the model and the motion history. */
    if (s_frame == 0) {
        for (int i = 0; i < GN; i++) {
            s_bg[i] = (float)grid[i];
            s_last_move[i] = INT64_MIN / 2;
        }
        memcpy(s_prev, grid, sizeof(grid));
        s_frame = 1;
        return true;
    }

    /* Which cells changed since the previous frame, global drift removed. */
    static int16_t d[GN];
    for (int i = 0; i < GN; i++) d[i] = (int16_t)((int)grid[i] - (int)s_prev[i]);
    const int dmed = median_of(d, GN);
    int move_thr = NOISE_MULTIPLE * mad_of(d, GN, dmed);
    if (move_thr < MOVE_FLOOR) move_thr = MOVE_FLOOR;
    for (int i = 0; i < GN; i++) {
        int m = d[i] - dmed;
        if (m < 0) m = -m;
        if (m >= move_thr) s_last_move[i] = now_us;
    }
    memcpy(s_prev, grid, sizeof(grid));

    /* Which cells do not match the empty room. */
    static int16_t b[GN];
    for (int i = 0; i < GN; i++) b[i] = (int16_t)((float)grid[i] - s_bg[i]);
    const int bmed = median_of(b, GN);
    int fg_thr = NOISE_MULTIPLE * mad_of(b, GN, bmed);
    if (fg_thr < FG_FLOOR) fg_thr = FG_FLOOR;
    s_last_thr = fg_thr;

    static bool fg[GN];
    for (int i = 0; i < GN; i++) {
        int m = b[i] - bmed;
        if (m < 0) m = -m;
        /* Foreground only while it has moved recently. A cell that differs
           from the background but has been perfectly still for a long time
           is a modelling error, not a person, and is let go below. */
        fg[i] = (m >= fg_thr) && ((now_us - s_last_move[i]) < MOVE_HOLD_US);
    }

    for (int i = 0; i < GN; i++) {
        const float rate = s_learning ? LEARN_WARMUP
                                      : (fg[i] ? LEARN_SLOW : LEARN_FAST);
        s_bg[i] += rate * ((float)grid[i] - s_bg[i]);
    }

    memcpy(s_last_fg, fg, sizeof(fg));
    s_frame++;

    if (s_learning) {
        if (s_frame < WARMUP) return true;
        s_learning = false;
        ESP_LOGD(TAG, "room learned");
    }

    float x = 0.0f, y = 0.0f;
    const int cells = largest_blob(fg, &x, &y);
    s_last_cells = cells;
    if (cells < MIN_CELLS) return true;

    /* Nobody fills a third of the room. A blob this large means the model
       has gone wrong, and acting on it is worse than seeing nothing: its
       centroid sits near the frame centre with total confidence and walks
       the head into a stop. Throw the model away and learn the room again. */
    if (cells > (GN * 35) / 100) {
        ESP_LOGW(TAG, "blob is %d of %d cells - model is wrong, relearning",
                 cells, GN);
        vision_forget();
        s_last_cells = 0;
        return true;
    }

    out->x = x;
    out->y = y;
    out->cells = cells;
    out->strength = (float)cells / 40.0f;
    if (out->strength > 1.0f) out->strength = 1.0f;
    out->valid = true;

    s_last_x = x;
    s_last_y = y;
    s_last_valid = true;
    return true;
}

/* ----------------------------------------------------------------- shift -- */

void vision_snapshot(void)
{
    s_have_snap = grab_grid(s_snap);
}

/**
 * Cross-correlate the current frame against the snapshot.
 *
 * Brute force over a window of offsets, scoring by absolute difference over
 * the overlapping region only. Coarse - whole grid cells - but that is all
 * the control loop needs, and it is measured rather than asserted.
 */
bool vision_shift(int range_x, int range_y, float *dx, float *dy)
{
    if (!s_have_snap) return false;

    static uint8_t now[GN];
    if (!grab_grid(now)) return false;

    /* The caller bounds the search to the axis that moved; see the header.
       A 80-unit yaw turn slides the picture about 10 cells, so the window
       has to be wide enough to contain the answer - an earlier +-8 could
       not, and reported "scene too flat" when the truth was "outside the
       window I looked in". */
    if (range_x < 0) range_x = 0;
    if (range_y < 0) range_y = 0;
    if (range_x > GW - 4) range_x = GW - 4;
    if (range_y > GH - 4) range_y = GH - 4;

    int32_t best = INT32_MAX;
    int32_t total = 0;
    int tried = 0;
    int bx = 0, by = 0;

    for (int oy = -range_y; oy <= range_y; oy++) {
        for (int ox = -range_x; ox <= range_x; ox++) {
            int32_t sum = 0, n = 0;
            for (int y = 0; y < GH; y++) {
                const int sy = y + oy;
                if (sy < 0 || sy >= GH) continue;
                for (int x = 0; x < GW; x++) {
                    const int sx = x + ox;
                    if (sx < 0 || sx >= GW) continue;
                    int v = (int)now[sy * GW + sx] - (int)s_snap[y * GW + x];
                    sum += (v < 0) ? -v : v;
                    n++;
                }
            }
            if (n < GN / 4) continue;        /* too little overlap to judge */

            /* Scaled by 16 so near-ties are still distinguishable; integer
               error-per-cell was too coarse to rank offsets apart. */
            const int32_t score = sum * 16 / n;
            total += score;
            tried++;
            if (score < best) { best = score; bx = ox; by = oy; }
        }
    }

    /* A flat scene matches about equally well everywhere, and a shift read
       off that is noise wearing a number's clothes. Compare the winner with
       the AVERAGE across the search rather than with the runner-up: in a
       correlation surface the runner-up is the neighbouring offset and is
       always close, so that test rejected every real measurement.

       The margin is only 10%: a probe large enough to measure well also
       slides much of the picture out of frame, leaving little overlap to
       correlate, so a genuine match is not dramatically better than the
       average. Measured on this robot, a good yaw match scored 12% below
       average - a 12.5% requirement rejected it. */
    if (tried < 8 || best == INT32_MAX) return false;
    const int32_t avg = total / tried;
    if (best * 10 > avg * 9) {
        ESP_LOGW(TAG, "scene too flat to measure shift (best %ld vs avg %ld)",
                 (long)best, (long)avg);
        return false;
    }

    if (dx) *dx = (float)bx;
    if (dy) *dy = (float)by;
    return true;
}

/* ----------------------------------------------------------------- debug -- */

bool vision_capture(uint8_t **jpg, size_t *jpg_len, int quality, uint8_t *grid)
{
    camera_fb_t *fb = grab_fresh();
    if (!fb) return false;

    bool ok = true;
    if (grid) sample(fb, grid);
    if (jpg && jpg_len) ok = frame2jpg(fb, quality, jpg, jpg_len);

    esp_camera_fb_return(fb);
    return ok;
}

bool vision_jpeg(uint8_t **out, size_t *len, int quality)
{
    if (!out || !len) return false;
    return vision_capture(out, len, quality, NULL);
}

void vision_debug_grid(void)
{
    printf("--GRID %dx%d cells=%d", GW, GH, s_last_cells);
    if (s_last_valid) printf(" at %+.2f,%+.2f", (double)s_last_x, (double)s_last_y);
    printf("\n");

    for (int gy = 0; gy < GH; gy++) {
        printf("  |");
        for (int gx = 0; gx < GW; gx++) putchar(s_last_fg[gy * GW + gx] ? '#' : ' ');
        printf("|\n");
    }
    printf("--ENDGRID\n");
}

void vision_debug_stream(int quality, int yaw, int pit)
{
    static const char kB64[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    uint8_t *jpg = NULL;
    size_t len = 0;
    if (!vision_capture(&jpg, &len, quality, NULL)) {
        if (jpg) free(jpg);
        return;
    }

    printf("--F 0 %lld %d %d %d %d %d %d\n",
           (long long)esp_timer_get_time(), GW, GH, yaw, pit, yaw, pit);
    printf("D %d %.3f %.3f\n", s_last_cells,
           (double)s_last_x, (double)s_last_y);

    /* The mask as one character per cell: cheap to send, and readable in a
       raw log without any tooling. */
    printf("M ");
    for (int i = 0; i < GN; i++) putchar(s_last_fg[i] ? '#' : '.');
    putchar('\n');

    printf("J %u\n", (unsigned)len);
    for (size_t i = 0; i < len; i += 3) {
        const uint32_t a = jpg[i];
        const uint32_t b = (i + 1 < len) ? jpg[i + 1] : 0;
        const uint32_t c = (i + 2 < len) ? jpg[i + 2] : 0;
        const uint32_t w = (a << 16) | (b << 8) | c;
        putchar(kB64[(w >> 18) & 63]);
        putchar(kB64[(w >> 12) & 63]);
        putchar((i + 1 < len) ? kB64[(w >> 6) & 63] : '=');
        putchar((i + 2 < len) ? kB64[w & 63] : '=');
        if ((i / 3) % 19 == 18) putchar('\n');
    }
    printf("\n--E\n");
    free(jpg);
}
