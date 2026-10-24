#include "eyes.h"

#include <stdlib.h>
#include <string.h>

#include "esp_camera.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "eyes";

/* Coarse grid over the frame. 20x15 on QVGA is 16x16 pixel blocks: fine
   enough to say "upper left" and cheap enough to be free. */
#define GW 20
#define GH 15

/* Change needed in a block to count as activity.
 *
 * Measured, not guessed: at a threshold of 9 this sensor lit up 40+ of 300
 * blocks on a still scene, pegging confidence at 1.00 constantly. Note the
 * brightness proxy below maxes at 187, not 255, so 9 was only ~5% - well
 * under the noise floor. */
#define BLOCK_THRESHOLD 22

/* Blocks that must be active before we believe anything is happening. */
#define MIN_ACTIVE_BLOCKS 4

/* ...and a ceiling. If most of the frame changed it was the light or the
   sensor's own auto-exposure, not a person. The centroid of a global change
   is the frame centre, which would otherwise read as "activity dead ahead"
   with maximum confidence. */
#define MAX_ACTIVE_FRACTION 0.40f

/* Ignore activity this close to centre. Without a deadband the head
   integrates small biased errors and slowly walks off target - observed as
   pitch drifting to -0.86 while activity read about zero. */
#define CENTRE_DEADBAND 0.10f

/* Correlation search window, in pixels.
 *
 * Has to exceed the shift a calibration nudge produces or the match falls
 * outside the search and the result collapses to 0 - which is exactly what
 * happened with a +-40 window: stddev 1259 and frame delta 267 proved the
 * scene was textured and had moved, yet the reported shift was +0.
 *
 * It also has to exceed it with room to spare: a measured shift landing
 * exactly on the limit is pinned, not measured. An +80 px result against an
 * 80 px window is a clipped answer that reads as a real one. */
#define MAX_LAG 110

/* How long after the head stops before motion data is trusted again.
 *
 * Short now that self-motion is compensated rather than waited out. It used
 * to be 350 ms, which meant the robot went blind after every tracking step -
 * and tracking is nothing but steps, so it spent most of its time unable to
 * see. That stop-start loop is what felt like lag. */
#define SETTLE_US 60000

/* Pixels per grid cell, used to convert a predicted image shift into a
   whole-cell offset of the reference grid. */
#define CELL_W (320 / GW)
#define CELL_H (240 / GH)

static uint8_t s_prev[GW * GH];
static bool s_have_prev = false;

static int s_w = 0, s_h = 0;

static bool s_head_moving = false;
static int64_t s_still_since = 0;

/* Predicted view shift since the reference grid was taken, in pixels. */
static float s_comp_x = 0.0f, s_comp_y = 0.0f;

/* Cells whose reference slid in from outside the frame. They have no history
   to difference against, so they must be SKIPPED rather than compared
   against zero - comparing against zero produced a huge false signal pinned
   to whichever edge the head was moving away from, which read as activity
   permanently off to one side. */
static bool s_cell_valid[GW * GH];

/* Smoothed output. Vision is noisy frame to frame; the head should not be. */
static float s_sx = 0.0f, s_sy = 0.0f;

/* --- template tracking ---------------------------------------------------
 *
 * Motion finds a person; a remembered patch of their appearance KEEPS them.
 * Frame differencing can only see change, so someone who holds still or
 * turns away vanishes from it entirely - which is why a motion-only tracker
 * feels like it loses interest the moment you stop waving.
 *
 * The template is held at grid resolution, so each cell is 16x16 px and a
 * 5x5 template covers roughly 80x80 px - about a person at conversational
 * distance. Matching is zero-mean sum-of-absolute-differences so a change in
 * room brightness does not break the lock. */
#define TPL 5                  /* template is TPL x TPL grid cells */
#define TPL_SEARCH 4           /* cells to search either way each frame */
#define TPL_ACQUIRE_CONF 0.30f /* motion must be this strong to grab one */
#define TPL_LOST_SCORE 46      /* mean abs error above which the lock drops */
#define TPL_BLEND 6            /* 1/N of the new patch blended in per frame */

static uint8_t s_tpl[TPL * TPL];
static bool s_has_tpl = false;
static int s_tpl_gx = 0, s_tpl_gy = 0;   /* last known centre, in cells */
static int s_tpl_miss = 0;
/* When motion last CORROBORATED the lock. A template will happily match a
   ceiling light forever, so a lock that nothing has moved near is stale and
   must die - otherwise it blocks surveying and the robot freezes on
   whatever it happened to see first. */
static int64_t s_tpl_confirmed_us = 0;

/* Kept purely so the debug dump shows what the tracker actually saw on its
   last pass, rather than a fresh frame that may look nothing like it. */
static int16_t s_last_diff[GW * GH];
static int s_last_mean = 0;
static int s_last_active = 0;
static float s_last_cx = 0.0f, s_last_cy = 0.0f;
static bool s_last_valid = false;

/* ------------------------------------------------------------------ init -- */

bool eyes_begin(void)
{
    /* Straight from M5's own GC0308 driver for this board. Note pin_xclk is
       -1: the sensor runs from its own oscillator, and there are no power or
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

        /* RGB565 rather than JPEG: the GC0308 has no hardware JPEG encoder,
           so JPEG would be a software pass we do not need for motion. */
        .pixel_format  = PIXFORMAT_RGB565,
        .frame_size    = FRAMESIZE_QVGA,
        .jpeg_quality  = 0,
        .fb_count      = 2,
        .fb_location   = CAMERA_FB_IN_PSRAM,
        .grab_mode     = CAMERA_GRAB_WHEN_EMPTY,
        .sccb_i2c_port = -1,
    };

    const esp_err_t err = esp_camera_init(&cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_camera_init failed: %s", esp_err_to_name(err));
        return false;
    }

    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) {
        ESP_LOGE(TAG, "camera initialised but produced no frame");
        return false;
    }
    s_w = fb->width;
    s_h = fb->height;
    ESP_LOGI(TAG, "camera up: %dx%d, %u bytes/frame", s_w, s_h, (unsigned)fb->len);
    esp_camera_fb_return(fb);

    s_still_since = esp_timer_get_time();
    return true;
}

void eyes_frame_size(int *w, int *h)
{
    if (w) *w = s_w;
    if (h) *h = s_h;
}

void eyes_set_head_moving(bool moving)
{
    if (s_head_moving && !moving) s_still_since = esp_timer_get_time();
    s_head_moving = moving;
}

void eyes_compensate(float dx_px, float dy_px)
{
    s_comp_x += dx_px;
    s_comp_y += dy_px;
}

/**
 * Slide the reference grid to cancel the head's own movement.
 *
 * Only whole cells are shifted; the sub-cell remainder is carried forward so
 * a run of small moves still accumulates into a correction rather than being
 * repeatedly rounded away.
 */
static void apply_compensation(void)
{
    const int cx = (int)(s_comp_x / CELL_W);
    const int cy = (int)(s_comp_y / CELL_H);
    if (cx == 0 && cy == 0) return;

    static uint8_t shifted[GW * GH];
    for (int gy = 0; gy < GH; gy++) {
        for (int gx = 0; gx < GW; gx++) {
            const int sx = gx + cx;
            const int sy = gy + cy;
            const int i = gy * GW + gx;
            const bool inside = (sx >= 0 && sx < GW && sy >= 0 && sy < GH);
            shifted[i] = inside ? s_prev[sy * GW + sx] : 0;
            s_cell_valid[i] = inside;
        }
    }
    memcpy(s_prev, shifted, sizeof(shifted));

    /* Edges that slid in from outside have no history, so nothing can be
       said about them this frame. Keeping the remainder avoids drift. */
    s_comp_x -= (float)(cx * CELL_W);
    s_comp_y -= (float)(cy * CELL_H);
}

/* -------------------------------------------------------------- sampling -- */

/**
 * Reduce a frame to a GW x GH brightness grid.
 *
 * Samples every 4th pixel per block rather than averaging all 256 - the
 * grid is a motion signal, not an image, and 16 samples per block is plenty
 * to see a person move through it.
 */
static void sample_grid(const camera_fb_t *fb, uint8_t *grid)
{
    const uint16_t *px = (const uint16_t *)fb->buf;
    const int bw = fb->width / GW;
    const int bh = fb->height / GH;

    for (int gy = 0; gy < GH; gy++) {
        for (int gx = 0; gx < GW; gx++) {
            uint32_t sum = 0;
            int n = 0;
            for (int y = gy * bh; y < (gy + 1) * bh; y += 4) {
                for (int x = gx * bw; x < (gx + 1) * bw; x += 4) {
                    const uint16_t p = px[y * fb->width + x];
                    /* RGB565 -> brightness proxy. Exact luma is unnecessary;
                       it only has to be consistent frame to frame. */
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

/* ---------------------------------------------------- template tracking -- */

/** Mean brightness of a TPL x TPL patch of the grid, centred on (gx, gy). */
static int patch_mean(const uint8_t *grid, int gx, int gy)
{
    int sum = 0, n = 0;
    for (int dy = -TPL / 2; dy <= TPL / 2; dy++) {
        for (int dx = -TPL / 2; dx <= TPL / 2; dx++) {
            const int x = gx + dx, y = gy + dy;
            if (x < 0 || x >= GW || y < 0 || y >= GH) continue;
            sum += grid[y * GW + x];
            n++;
        }
    }
    return n ? sum / n : 0;
}

/** Remember what is at (gx, gy) so it can be followed when it stops moving. */
static void capture_template(const uint8_t *grid, int gx, int gy)
{
    const int mean = patch_mean(grid, gx, gy);
    for (int dy = 0; dy < TPL; dy++) {
        for (int dx = 0; dx < TPL; dx++) {
            const int x = gx + dx - TPL / 2;
            const int y = gy + dy - TPL / 2;
            const int v = (x >= 0 && x < GW && y >= 0 && y < GH)
                              ? (int)grid[y * GW + x] - mean
                              : 0;
            /* Store zero-mean, offset to fit unsigned. */
            s_tpl[dy * TPL + dx] = (uint8_t)(v + 128 < 0 ? 0 : (v + 128 > 255 ? 255 : v + 128));
        }
    }
    s_tpl_gx = gx;
    s_tpl_gy = gy;
    s_has_tpl = true;
    s_tpl_miss = 0;
    s_tpl_confirmed_us = esp_timer_get_time();
}

/**
 * Find the template near where it was last seen.
 *
 * Zero-mean matching: the patch mean is removed from both sides, so the lock
 * survives the lights changing or the camera's auto-exposure drifting, which
 * would otherwise look like the person had been replaced.
 */
static bool find_template(const uint8_t *grid, int *best_gx, int *best_gy, int *best_err)
{
    int bx = s_tpl_gx, by = s_tpl_gy, berr = 1 << 30;

    for (int oy = -TPL_SEARCH; oy <= TPL_SEARCH; oy++) {
        for (int ox = -TPL_SEARCH; ox <= TPL_SEARCH; ox++) {
            const int cx = s_tpl_gx + ox;
            const int cy = s_tpl_gy + oy;
            if (cx < TPL / 2 || cx >= GW - TPL / 2) continue;
            if (cy < TPL / 2 || cy >= GH - TPL / 2) continue;

            const int mean = patch_mean(grid, cx, cy);
            int err = 0;
            for (int dy = 0; dy < TPL; dy++) {
                for (int dx = 0; dx < TPL; dx++) {
                    const int x = cx + dx - TPL / 2;
                    const int y = cy + dy - TPL / 2;
                    const int got = (int)grid[y * GW + x] - mean;
                    const int want = (int)s_tpl[dy * TPL + dx] - 128;
                    err += got > want ? got - want : want - got;
                }
            }
            err /= (TPL * TPL);
            if (err < berr) { berr = err; bx = cx; by = cy; }
        }
    }

    *best_gx = bx;
    *best_gy = by;
    *best_err = berr;
    return berr <= TPL_LOST_SCORE;
}

/** Blend the current view into the template so it survives slow changes. */
static void refresh_template(const uint8_t *grid, int gx, int gy)
{
    const int mean = patch_mean(grid, gx, gy);
    for (int dy = 0; dy < TPL; dy++) {
        for (int dx = 0; dx < TPL; dx++) {
            const int x = gx + dx - TPL / 2;
            const int y = gy + dy - TPL / 2;
            if (x < 0 || x >= GW || y < 0 || y >= GH) continue;
            const int now = (int)grid[y * GW + x] - mean + 128;
            const int old = s_tpl[dy * TPL + dx];
            s_tpl[dy * TPL + dx] = (uint8_t)(old + (now - old) / TPL_BLEND);
        }
    }
    s_tpl_gx = gx;
    s_tpl_gy = gy;
}

void eyes_drop_lock(void)
{
    s_has_tpl = false;
    s_tpl_miss = 0;
}

bool eyes_has_lock(void)
{
    if (!s_has_tpl) return false;

    /* A lock only counts while something has recently moved near it. A
       static scene feature matches its own template indefinitely, which
       would hold the robot's gaze on an empty wall for ever. */
    if (esp_timer_get_time() - s_tpl_confirmed_us > 20000000) {
        s_has_tpl = false;
        return false;
    }
    return true;
}

/* ------------------------------------------------------------------ read -- */

static bool follow_template(const uint8_t *grid, activity_t *out);

bool eyes_read(activity_t *out)
{
    if (!out) return false;
    out->valid = false;
    out->x = out->y = 0.0f;
    out->confidence = 0.0f;
    out->from_template = false;

    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) return false;

    static uint8_t grid[GW * GH];
    sample_grid(fb, grid);
    esp_camera_fb_return(fb);

    /* While the head is moving - or just after - every block changes because
       the camera moved, not because the world did. */
    const bool settled = !s_head_moving &&
                         (esp_timer_get_time() - s_still_since) > SETTLE_US;
    if (!settled) {
        memcpy(s_prev, grid, sizeof(grid));
        s_have_prev = true;
        return true;
    }

    if (!s_have_prev) {
        memcpy(s_prev, grid, sizeof(grid));
        s_have_prev = true;
        s_comp_x = s_comp_y = 0.0f;
        return true;
    }

    /* Cancel the head's own contribution before looking for the room's. */
    for (int i = 0; i < GW * GH; i++) s_cell_valid[i] = true;
    apply_compensation();

    /* Per-block signed change, and its mean across the frame. */
    static int16_t diff[GW * GH];
    int32_t sum = 0;
    int counted = 0;
    for (int i = 0; i < GW * GH; i++) {
        if (!s_cell_valid[i]) { diff[i] = 0; continue; }
        diff[i] = (int16_t)((int)grid[i] - (int)s_prev[i]);
        sum += diff[i];
        counted++;
    }
    const int mean = counted ? sum / counted : 0;

    memcpy(s_prev, grid, sizeof(grid));

    /* Energy-weighted centroid of change, with the global component removed.
     *
     * Subtracting the mean is what makes this usable on real hardware: the
     * GC0308 runs auto-exposure continuously, so the whole frame brightens
     * and darkens on its own. That is a global shift, and without removing
     * it every block trips the threshold at once - measured as confidence
     * pegged at 1.00 on a completely still scene. */
    uint32_t total = 0;
    uint32_t wx = 0, wy = 0;
    int active = 0;

    for (int gy = 0; gy < GH; gy++) {
        for (int gx = 0; gx < GW; gx++) {
            const int i = gy * GW + gx;
            if (!s_cell_valid[i]) continue;
            const int d = diff[i] - mean;
            const uint32_t mag = (uint32_t)(d < 0 ? -d : d);
            if (mag < BLOCK_THRESHOLD) continue;

            total += mag;
            wx += mag * (uint32_t)gx;
            wy += mag * (uint32_t)gy;
            active++;
        }
    }

    memcpy(s_last_diff, diff, sizeof(diff));
    s_last_mean   = mean;
    s_last_active = active;
    s_last_valid  = false;

    /* Nothing moved - but someone standing still is still there. */
    if (active < MIN_ACTIVE_BLOCKS || total == 0) {
        follow_template(grid, out);
        return true;
    }

    /* Too much of the frame changed to be one thing happening in it. */
    if ((float)active > MAX_ACTIVE_FRACTION * (GW * GH)) {
        follow_template(grid, out);
        return true;
    }

    const float cx = (float)wx / (float)total;  /* grid units */
    const float cy = (float)wy / (float)total;

    /* Grid coordinates to -1..1 about centre. */
    const float nx = (cx - (GW - 1) * 0.5f) / ((GW - 1) * 0.5f);
    const float ny = (cy - (GH - 1) * 0.5f) / ((GH - 1) * 0.5f);

    /* Exponential smoothing. 0.35 follows a walking person without the
       head twitching at every frame of sensor noise. */
    const float a = 0.35f;
    s_sx += a * (nx - s_sx);
    s_sy += a * (ny - s_sy);

    /* Deadband. Activity sitting near the centre is usually residual noise,
       and acting on it makes the head integrate a small bias into a slow
       walk off target. */
    const float mag = (s_sx * s_sx + s_sy * s_sy);
    if (mag < CENTRE_DEADBAND * CENTRE_DEADBAND) {
        follow_template(grid, out);
        return true;
    }

    /* Confidence from how much of the frame changed, scaled so a handful of
       blocks is tentative and a solid cluster is convincing. */
    float conf = (float)(active - MIN_ACTIVE_BLOCKS) / 25.0f;
    if (conf < 0.0f) conf = 0.0f;
    if (conf > 1.0f) conf = 1.0f;

    out->x = s_sx;
    out->y = s_sy;
    out->confidence = conf;
    out->valid = true;

    /* Strong motion is how a person gets found. Remember what is there so
       they can be followed once they stop moving. */
    if (conf >= TPL_ACQUIRE_CONF) {
        const int gx = (int)((s_sx * 0.5f + 0.5f) * (GW - 1) + 0.5f);
        const int gy = (int)((s_sy * 0.5f + 0.5f) * (GH - 1) + 0.5f);
        capture_template(grid, gx, gy);
    }

    s_last_cx    = s_sx;
    s_last_cy    = s_sy;
    s_last_valid = true;
    return true;
}

/**
 * Follow a remembered appearance when nothing is moving.
 *
 * Called when motion found nothing. This is what makes the robot stay on a
 * person who is standing still or looking away, rather than treating them as
 * gone the moment they stop waving.
 */
static bool follow_template(const uint8_t *grid, activity_t *out)
{
    if (!s_has_tpl) return false;

    /* A template matching a STATIC scene feature is not evidence that a
     * person is there - a ceiling light matches its own template perfectly
     * and indefinitely. Observed doing exactly that: the same reading
     * (-0.05, +0.00) frame after frame, which kept the head frozen looking
     * up because every frame counted as "someone is here".
     *
     * The expiry has to live here rather than in a query the caller might
     * not make. Only motion nearby renews a lock; matching yourself does
     * not. */
    if (esp_timer_get_time() - s_tpl_confirmed_us > 8000000) {
        s_has_tpl = false;
        s_tpl_miss = 0;
        return false;
    }

    int gx = 0, gy = 0, err = 0;
    const bool found = find_template(grid, &gx, &gy, &err);

    if (!found) {
        /* Tolerate a few bad frames - someone turning, or a hand passing in
           front - before concluding they have actually gone. */
        if (++s_tpl_miss > 12) {
            s_has_tpl = false;
        }
        return false;
    }
    s_tpl_miss = 0;
    refresh_template(grid, gx, gy);

    out->x = ((float)gx / (float)(GW - 1)) * 2.0f - 1.0f;
    out->y = ((float)gy / (float)(GH - 1)) * 2.0f - 1.0f;
    /* Confidence from match quality: a perfect match is 1.0, and the lost
       threshold is 0. */
    out->confidence = 1.0f - ((float)err / (float)TPL_LOST_SCORE);
    if (out->confidence < 0.0f) out->confidence = 0.0f;
    out->valid = true;
    out->from_template = true;
    return true;
}

/* ----------------------------------------------------------- debug views -- */

bool eyes_capture_jpeg(uint8_t **out, size_t *len, int quality)
{
    if (!out || !len) return false;

    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) return false;

    const bool ok = frame2jpg(fb, quality, out, len);
    esp_camera_fb_return(fb);
    return ok;
}

void eyes_debug_grid(void)
{
    /* One character per block, scaled by how much it changed. Reading this
       is how you tell a person moving (a tight cluster) from the lights
       changing (the whole grid) from noise (scattered specks). */
    static const char ramp[] = " .:-=+*#%@";

    printf("--GRID %dx%d mean=%d active=%d", GW, GH, s_last_mean, s_last_active);
    if (s_last_valid) printf(" centroid=%+.2f,%+.2f", s_last_cx, s_last_cy);
    printf("\n");

    for (int gy = 0; gy < GH; gy++) {
        printf("  |");
        for (int gx = 0; gx < GW; gx++) {
            const int d = s_last_diff[gy * GW + gx] - s_last_mean;
            int mag = d < 0 ? -d : d;
            if (mag < BLOCK_THRESHOLD) {
                putchar(ramp[0]);
            } else {
                int level = 1 + (mag - BLOCK_THRESHOLD) / 8;
                if (level > 9) level = 9;
                putchar(ramp[level]);
            }
        }
        printf("|\n");
    }
    printf("--ENDGRID\n");
}


/* ======================================================================== */
/*  Shift measurement: how far the view slides when the head moves.         */
/*                                                                          */
/*  This is what lets the controller be calibrated rather than tuned by      */
/*  guesswork. Servo feedback tells us the shaft turned; only the camera     */
/*  tells us how much the view actually changed, which is what matters for   */
/*  pointing at something.                                                   */
/* ======================================================================== */

static int32_t s_snap_col[320];
static int32_t s_snap_row[240];
static int s_snap_w = 0, s_snap_h = 0;
static bool s_have_snap = false;

/** Column and row brightness profiles of one frame. */
static bool profiles(int32_t *col, int32_t *row, int *w_out, int *h_out)
{
    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) return false;

    const int w = (int)fb->width > 320 ? 320 : (int)fb->width;
    const int h = (int)fb->height > 240 ? 240 : (int)fb->height;
    const uint16_t *px = (const uint16_t *)fb->buf;

    for (int x = 0; x < w; x++) col[x] = 0;
    for (int y = 0; y < h; y++) row[y] = 0;

    /* Every 2nd row and column: still thousands of samples per profile. */
    for (int y = 0; y < h; y += 2) {
        for (int x = 0; x < w; x += 2) {
            const uint16_t p = px[y * fb->width + x];
            const int r = (p >> 11) & 0x1F, g = (p >> 5) & 0x3F, b = p & 0x1F;
            const int32_t lum = (r << 1) + g + (b << 1);
            col[x] += lum;
            row[y] += lum;
        }
    }
    esp_camera_fb_return(fb);

    if (w_out) *w_out = w;
    if (h_out) *h_out = h;
    return true;
}


/**
 * Lag at which b best matches a, plus how distinct that match is.
 *
 * Correlates the DERIVATIVE of each profile rather than the profile itself.
 * That matters: a smooth brightness ramp - a bright ceiling over a dark
 * floor, say - has enormous variance but no distinctive features, so it
 * correlates almost equally at every lag and the search settles on 0 by
 * noise. Measured exactly that way: a pitch move of 40 servo units reported
 * a shift of 0 px while the profile's variance looked healthy at 1201.
 * Differencing removes the ramp and leaves the edges, which correlate
 * sharply.
 *
 * @param sharpness best score divided by the mean score. Near 1.0 means
 *                  every lag fits equally well, i.e. the answer is noise.
 */
static int best_lag(const int32_t *a, const int32_t *b, int n, int stride,
                    int max_lag, double *sharpness)
{
    /* Gradient profiles. One sample shorter, hence n - stride below. */
    static double da[320], db[320];
    int m = 0;
    for (int i = 0; i + stride < n && m < 320; i += stride, m++) {
        da[m] = (double)a[i + stride] - (double)a[i];
        db[m] = (double)b[i + stride] - (double)b[i];
    }
    if (m < 8) { if (sharpness) *sharpness = 0.0; return 0; }

    const int lag_steps = max_lag / stride;
    double best = -1e30, sum_abs = 0.0;
    int best_l = 0, considered = 0;

    for (int l = -lag_steps; l <= lag_steps; l++) {
        double score = 0.0;
        int k = 0;
        for (int i = 0; i < m; i++) {
            const int j = i + l;
            if (j < 0 || j >= m) continue;
            score += da[i] * db[j];
            k++;
        }
        if (k < m / 2) continue;
        score /= k;

        sum_abs += score < 0 ? -score : score;
        considered++;
        if (score > best) { best = score; best_l = l * stride; }
    }

    if (sharpness) {
        const double mean_abs = considered ? sum_abs / considered : 0.0;
        *sharpness = (mean_abs > 1e-9) ? (best / mean_abs) : 0.0;
    }
    return best_l;
}

bool eyes_snapshot(void)
{
    if (!profiles(s_snap_col, s_snap_row, &s_snap_w, &s_snap_h)) return false;
    s_have_snap = true;
    return true;
}

bool eyes_shift_since_snapshot(int *dx, int *dy, double *quality)
{
    if (!s_have_snap) return false;

    static int32_t col[320], row[240];
    int w = 0, h = 0;
    if (!profiles(col, row, &w, &h)) return false;
    if (w != s_snap_w || h != s_snap_h) return false;

    /* Rows are sampled every 2nd line, so the row profile has gaps; stride
       the correlation to match or every other lag scores against zeros. */
    double sx = 0.0, sy = 0.0;
    const int lx = best_lag(s_snap_col, col, w, 2, MAX_LAG, &sx);
    const int ly = best_lag(s_snap_row, row, h, 2, MAX_LAG, &sy);
    if (dx) *dx = lx;
    if (dy) *dy = ly;

    /* Quality is now how DISTINCT the match is, not how much the profile
       varies. Variance was the wrong measure: a smooth ramp scores high on
       it and still cannot be correlated. The caller asks about one axis at
       a time, so report each axis' own sharpness via the axis it asked for. */
    if (quality) *quality = (dy && !dx) ? sy : ((dx && !dy) ? sx : (sx < sy ? sx : sy));
    return true;
}
