#include "vision.h"

#include <stdio.h>
#include <string.h>

#include "esp_camera.h"
#include "esp_log.h"

static const char *TAG = "vision";

/* Coarse grid. 20x15 on QVGA is 16x16 px cells: enough to say where a
   person is, cheap enough to be free. */
#define GW 20
#define GH 15
#define GN (GW * GH)

/* How far a cell must sit from the background model to count as part of a
   person. Chosen by scoring against recorded footage, not by feel: at 12,
   719 frames of empty room produced zero detections while a person was
   found in about 80% of frames. */
#define FG_THRESHOLD 12

/* How much a cell must change frame-to-frame to count as having moved. */
#define MOVE_THRESHOLD 10

/* How long a cell stays protected after it last moved, in frames. At the
   ~4 fps this loop runs, 150 frames is a little over half a minute - long
   enough for someone to stand still, short enough that a misread corrects
   itself rather than becoming permanent. */
#define MOVE_HOLD 150

/* Smallest blob that counts as a person. Below this it is sensor noise:
   measured, an empty room never exceeded 5 connected cells. */
#define MIN_CELLS 8

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
static int32_t s_last_move[GN];
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
    s_last_valid = false;
    s_last_cells = 0;
    memset(s_last_fg, 0, sizeof(s_last_fg));
}

/* -------------------------------------------------------------- sampling -- */

/**
 * Get a frame that is actually current.
 *
 * The driver keeps fb_count buffers filled continuously, so a frame handed
 * back right after a pause can have been exposed before it. Discarding the
 * queued ones first makes sure what comes back was exposed after this call
 * rather than during the move that preceded it.
 */
static camera_fb_t *grab_fresh(void)
{
    for (int i = 0; i < 2; i++) {
        camera_fb_t *stale = esp_camera_fb_get();
        if (!stale) return NULL;
        esp_camera_fb_return(stale);
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
            for (int y = gy * ch; y < (gy + 1) * ch; y += 4) {
                for (int x = gx * cw; x < (gx + 1) * cw; x += 4) {
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

    /* First frame after forgetting: seed the model and the motion history. */
    if (s_frame == 0) {
        for (int i = 0; i < GN; i++) {
            s_bg[i] = (float)grid[i];
            s_last_move[i] = -MOVE_HOLD * 4;
        }
        memcpy(s_prev, grid, sizeof(grid));
        s_frame = 1;
        return true;
    }

    /* Which cells changed since the previous frame, global drift removed. */
    static int16_t d[GN];
    for (int i = 0; i < GN; i++) d[i] = (int16_t)((int)grid[i] - (int)s_prev[i]);
    const int dmed = median_of(d, GN);
    for (int i = 0; i < GN; i++) {
        int m = d[i] - dmed;
        if (m < 0) m = -m;
        if (m >= MOVE_THRESHOLD) s_last_move[i] = s_frame;
    }
    memcpy(s_prev, grid, sizeof(grid));

    /* Which cells do not match the empty room. */
    static int16_t b[GN];
    for (int i = 0; i < GN; i++) b[i] = (int16_t)((float)grid[i] - s_bg[i]);
    const int bmed = median_of(b, GN);

    static bool fg[GN];
    for (int i = 0; i < GN; i++) {
        int m = b[i] - bmed;
        if (m < 0) m = -m;
        /* Foreground only while it has moved recently. A cell that differs
           from the background but has been perfectly still for a long time
           is a modelling error, not a person, and is let go below. */
        fg[i] = (m >= FG_THRESHOLD) && ((s_frame - s_last_move[i]) < MOVE_HOLD);
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
