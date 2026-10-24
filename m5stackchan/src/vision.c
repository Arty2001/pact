#include "vision.h"

#include <stdio.h>
#include <string.h>

#include "esp_camera.h"
#include "esp_log.h"

static const char *TAG = "vision";

/* Coarse grid. 20x15 on QVGA is 16x16 px cells: enough to say where
   something is, cheap enough to be free. */
#define GW 20
#define GH 15

/* A cell must change by this much to count.
 *
 * Measured rather than guessed: at a threshold of 9 this sensor lit up 40+
 * of 300 cells on a completely still scene. The brightness proxy below maxes
 * at 187, not 255, so 9 was about 5% - under the noise floor. */
#define CELL_THRESHOLD 22

/* Fewest cells that count as something happening. One cell is noise. */
#define MIN_CELLS 4

/* Most cells that can change before it is the lights rather than a person.
   A global change has its centroid at the frame centre, which would read as
   "something dead ahead" with total confidence. */
#define MAX_CELL_FRACTION 0.40f

static uint8_t s_prev[GW * GH];
static bool s_have_prev = false;
static int s_w = 0, s_h = 0;

/* Last difference map, kept only so the debug view shows what the detector
   actually saw rather than a fresh frame that may look nothing like it. */
static int16_t s_last[GW * GH];
static int s_last_cells = 0;
static float s_last_x = 0.0f, s_last_y = 0.0f;
static bool s_last_valid = false;

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
           frame, so after the head has been still for a second both buffers
           still held frames captured while it was moving. Measured with the
           sweep: the montage was two frames behind the servo throughout, and
           the first stop showed where the head had been before the sweep
           began. That stale frame became the reference for the next
           comparison, which made the whole room look like it had moved. */
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
    ESP_LOGI(TAG, "camera %dx%d", s_w, s_h);
    esp_camera_fb_return(fb);
    return true;
}

void vision_frame_size(int *w, int *h)
{
    if (w) *w = s_w;
    if (h) *h = s_h;
}

void vision_forget(void) { s_have_prev = false; }

/* -------------------------------------------------------------- sampling -- */

/**
 * Get a frame that is actually current.
 *
 * The driver keeps fb_count buffers filled continuously, so a frame handed
 * back right after a pause can have been exposed before it. GRAB_LATEST
 * picks the newest of the queue, and discarding the queued ones first makes
 * sure the newest is one exposed after this call rather than during the
 * move that preceded it.
 *
 * This matters more than it sounds: a stale frame taken while the head was
 * turning became the reference the next frame was compared against, which
 * reported the entire room as moving and sent the head chasing it.
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

/* ------------------------------------------------------------------ look -- */

bool vision_look(motion_t *out)
{
    if (!out) return false;
    memset(out, 0, sizeof(*out));
    s_last_valid = false;

    camera_fb_t *fb = grab_fresh();
    if (!fb) return false;

    static uint8_t grid[GW * GH];
    sample(fb, grid);
    esp_camera_fb_return(fb);

    if (!s_have_prev) {
        memcpy(s_prev, grid, sizeof(grid));
        s_have_prev = true;
        return true;   /* first frame after a move: reference only */
    }

    /* Per-cell change, and the frame-wide mean of it.
     *
     * Subtracting the mean is what makes this work on real hardware: the
     * GC0308 runs auto-exposure continuously, so the whole image brightens
     * and darkens on its own. That is a global shift, and without removing
     * it every cell trips the threshold at once. */
    int32_t sum = 0;
    for (int i = 0; i < GW * GH; i++) {
        s_last[i] = (int16_t)((int)grid[i] - (int)s_prev[i]);
        sum += s_last[i];
    }
    const int mean = sum / (GW * GH);
    memcpy(s_prev, grid, sizeof(grid));

    uint32_t total = 0, wx = 0, wy = 0;
    int cells = 0;
    for (int gy = 0; gy < GH; gy++) {
        for (int gx = 0; gx < GW; gx++) {
            const int d = s_last[gy * GW + gx] - mean;
            const uint32_t mag = (uint32_t)(d < 0 ? -d : d);
            if (mag < CELL_THRESHOLD) continue;
            total += mag;
            wx += mag * (uint32_t)gx;
            wy += mag * (uint32_t)gy;
            cells++;
        }
    }
    s_last_cells = cells;

    if (cells < MIN_CELLS || total == 0) return true;
    if ((float)cells > MAX_CELL_FRACTION * (GW * GH)) return true;

    const float cx = (float)wx / (float)total;
    const float cy = (float)wy / (float)total;

    out->x = (cx - (GW - 1) * 0.5f) / ((GW - 1) * 0.5f);
    out->y = (cy - (GH - 1) * 0.5f) / ((GH - 1) * 0.5f);
    out->strength = (float)cells / 30.0f;
    if (out->strength > 1.0f) out->strength = 1.0f;
    out->valid = true;

    s_last_x = out->x;
    s_last_y = out->y;
    s_last_valid = true;
    return true;
}

/* ----------------------------------------------------------------- debug -- */

void vision_grid_size(int *w, int *h)
{
    if (w) *w = GW;
    if (h) *h = GH;
}

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
    static const char ramp[] = " .:-=+*#%@";

    printf("--GRID %dx%d cells=%d", GW, GH, s_last_cells);
    if (s_last_valid) printf(" at %+.2f,%+.2f", (double)s_last_x, (double)s_last_y);
    printf("\n");

    for (int gy = 0; gy < GH; gy++) {
        printf("  |");
        for (int gx = 0; gx < GW; gx++) {
            const int d = s_last[gy * GW + gx];
            int mag = d < 0 ? -d : d;
            if (mag < CELL_THRESHOLD) {
                putchar(ramp[0]);
            } else {
                int lvl = 1 + (mag - CELL_THRESHOLD) / 8;
                if (lvl > 9) lvl = 9;
                putchar(ramp[lvl]);
            }
        }
        printf("|\n");
    }
    printf("--ENDGRID\n");
}
