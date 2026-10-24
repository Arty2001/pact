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
 * scene was textured and had moved, yet the reported shift was +0. */
#define MAX_LAG 80

/* How long after the head stops before motion data is trusted again. The
   scene is still settling - and so is the servo - for a moment after. */
#define SETTLE_US 350000

static uint8_t s_prev[GW * GH];
static bool s_have_prev = false;

static int s_w = 0, s_h = 0;

static bool s_head_moving = false;
static int64_t s_still_since = 0;

/* Smoothed output. Vision is noisy frame to frame; the head should not be. */
static float s_sx = 0.0f, s_sy = 0.0f;

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
    if (moving) {
        /* Throw away the reference frame: it was taken from a different
           direction and differencing against it is meaningless. */
        s_have_prev = false;
    }
    s_head_moving = moving;
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

/* ------------------------------------------------------------------ read -- */

bool eyes_read(activity_t *out)
{
    if (!out) return false;
    out->valid = false;
    out->x = out->y = 0.0f;
    out->confidence = 0.0f;

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
        return true;
    }

    /* Per-block signed change, and its mean across the frame. */
    static int16_t diff[GW * GH];
    int32_t sum = 0;
    for (int i = 0; i < GW * GH; i++) {
        diff[i] = (int16_t)((int)grid[i] - (int)s_prev[i]);
        sum += diff[i];
    }
    const int mean = sum / (GW * GH);

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
            const int d = diff[i] - mean;
            const uint32_t mag = (uint32_t)(d < 0 ? -d : d);
            if (mag < BLOCK_THRESHOLD) continue;

            total += mag;
            wx += mag * (uint32_t)gx;
            wy += mag * (uint32_t)gy;
            active++;
        }
    }

    if (active < MIN_ACTIVE_BLOCKS || total == 0) return true;

    /* Too much of the frame changed to be one thing happening in it. */
    if ((float)active > MAX_ACTIVE_FRACTION * (GW * GH)) return true;

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
    if (mag < CENTRE_DEADBAND * CENTRE_DEADBAND) return true;

    /* Confidence from how much of the frame changed, scaled so a handful of
       blocks is tentative and a solid cluster is convincing. */
    float conf = (float)(active - MIN_ACTIVE_BLOCKS) / 25.0f;
    if (conf < 0.0f) conf = 0.0f;
    if (conf > 1.0f) conf = 1.0f;

    out->x = s_sx;
    out->y = s_sy;
    out->confidence = conf;
    out->valid = true;
    return true;
}

/* ------------------------------------------------- yaw sign measurement -- */

/** Collapse a frame to a column brightness profile. */
static bool column_profile(int32_t *prof, int width)
{
    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) return false;

    const uint16_t *px = (const uint16_t *)fb->buf;
    for (int x = 0; x < width; x++) prof[x] = 0;

    for (int y = 0; y < (int)fb->height; y += 3) {
        for (int x = 0; x < width && x < (int)fb->width; x++) {
            const uint16_t p = px[y * fb->width + x];
            const int r = (p >> 11) & 0x1F, g = (p >> 5) & 0x3F, b = p & 0x1F;
            prof[x] += (r << 1) + g + (b << 1);
        }
    }
    esp_camera_fb_return(fb);
    return true;
}

/** Lag where `b` best matches `a`. Positive means content moved right. */
static int best_shift(const int32_t *a, const int32_t *b, int w, int max_lag)
{
    int64_t ma = 0, mb = 0;
    for (int x = 0; x < w; x++) { ma += a[x]; mb += b[x]; }
    ma /= w; mb /= w;

    int64_t best = INT64_MIN;
    int best_lag = 0;
    for (int lag = -max_lag; lag <= max_lag; lag++) {
        int64_t score = 0;
        int n = 0;
        for (int x = 0; x < w; x++) {
            const int xb = x + lag;
            if (xb < 0 || xb >= w) continue;
            score += (int64_t)(a[x] - ma) * (int64_t)(b[xb] - mb);
            n++;
        }
        if (n < w / 2) continue;
        score /= n;
        if (score > best) { best = score; best_lag = lag; }
    }
    return best_lag;
}

/** Spread of a profile. Near zero means the scene has no vertical edges. */
static double profile_stddev(const int32_t *p, int w)
{
    double mean = 0.0;
    for (int x = 0; x < w; x++) mean += (double)p[x];
    mean /= w;

    double var = 0.0;
    for (int x = 0; x < w; x++) {
        const double d = (double)p[x] - mean;
        var += d * d;
    }
    return (var > 0.0) ? __builtin_sqrt(var / w) : 0.0;
}

bool eyes_measure_yaw_sign(void (*nudge)(void), int *out_sign)
{
    if (!nudge || !out_sign) return false;

    const int w = s_w < 320 ? s_w : 320;
    static int32_t before[320], after[320];

    if (!column_profile(before, w)) return false;

    /* Distinguish the two reasons this can fail. A flat scene has nothing to
       correlate; a scene with plenty of structure that still shows no shift
       means the head did not actually move. Reporting "too flat" for both
       would send you looking in the wrong place. */
    const double sd = profile_stddev(before, w);

    nudge();  /* caller commands a small POSITIVE yaw move and settles */

    if (!column_profile(after, w)) return false;

    /* How different the two frames are at all, before asking about direction. */
    int64_t absdiff = 0;
    for (int x = 0; x < w; x++) {
        const int64_t d = (int64_t)after[x] - (int64_t)before[x];
        absdiff += d < 0 ? -d : d;
    }
    absdiff /= w;

    const int shift = best_shift(before, after, w, MAX_LAG);
    ESP_LOGI(TAG, "yaw sign probe: shift %+d px, scene stddev %.0f, frame delta %lld",
             shift, sd, (long long)absdiff);

    if (sd < 200.0) {
        ESP_LOGW(TAG, "scene has almost no vertical structure (stddev %.0f)", sd);
        ESP_LOGW(TAG, "point the robot at a doorway, shelf or patterned wall");
        return false;
    }
    if (absdiff < 50) {
        ESP_LOGW(TAG, "frames are nearly identical - the head likely did not move");
        ESP_LOGW(TAG, "check the servo rail and that yaw is not at a travel limit");
        return false;
    }

    /* If the head turned right, the world slid left across the sensor. */
    if (shift < -3) {
        *out_sign = +1;
        ESP_LOGI(TAG, "positive yaw turns the head RIGHT");
        return true;
    }
    if (shift > 3) {
        *out_sign = -1;
        ESP_LOGI(TAG, "positive yaw turns the head LEFT");
        return true;
    }

    /* Structure and movement were both confirmed above, so a zero or
       pinned shift means the correlation could not find the match - almost
       always because the head moved further than the search window. With
       little overlap between the two frames there is no good lag anywhere
       and the search falls back to 0. */
    if (shift == 0) {
        ESP_LOGW(TAG, "no shift found despite a changed, textured scene");
        ESP_LOGW(TAG, "the nudge is probably too large - reduce it");
    } else if (shift >= MAX_LAG - 2 || shift <= -(MAX_LAG - 2)) {
        ESP_LOGW(TAG, "shift pinned at the search limit (%+d) - nudge too large", shift);
    } else {
        ESP_LOGW(TAG, "shift %+d too small to be sure of a direction", shift);
    }
    return false;
}
