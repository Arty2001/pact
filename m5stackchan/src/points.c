#include "points.h"

#include <stdlib.h>
#include <string.h>

#include "esp_log.h"

static const char *TAG = "points";

/* Tracking budget. Each point costs a small search every frame, so this is
   chosen to stay comfortably inside one frame interval rather than to be
   as large as possible. */
#define MAX_POINTS 14

/* Patch compared when following a point. 8x8 at QVGA is a shoulder or a
   face-sized chunk at conversational distance. */
#define PATCH 8
#define HALF (PATCH / 2)

/* How far a point may move between frames, in pixels. Larger costs search
   time; 7 covers a brisk walk at this framerate. */
#define SEARCH 7

/* Mean absolute error above which a point is considered lost. */
#define LOST_ERR 34

/* A point must move at least this many pixels per second to count as alive.
 *
 * This is the whole reason for the rewrite. Scenery - a ceiling light, a
 * door frame - tracks perfectly and moves not at all, and treating it as a
 * target is what froze the head looking upward. Velocity is the test that
 * separates a person from a light fitting. */
#define MIN_SPEED_PX_S 2.5f

/* Frames a point may be slow before it is dropped, so someone pausing
   briefly is not discarded instantly. */
#define MAX_SLOW_FRAMES 25

typedef struct {
    float x, y;        /* position in pixels */
    float vx, vy;      /* pixels per second */
    uint8_t patch[PATCH * PATCH];
    int slow_frames;
    bool alive;
} point_t;

static point_t s_pts[MAX_POINTS];
static int s_alive = 0;

void points_reset(void)
{
    for (int i = 0; i < MAX_POINTS; i++) s_pts[i].alive = false;
    s_alive = 0;
}

int points_count(void) { return s_alive; }

/* ------------------------------------------------------------- sampling -- */

static void grab_patch(const uint8_t *g, int w, int h, int cx, int cy, uint8_t *dst)
{
    for (int dy = 0; dy < PATCH; dy++) {
        for (int dx = 0; dx < PATCH; dx++) {
            int x = cx + dx - HALF;
            int y = cy + dy - HALF;
            if (x < 0) x = 0;
            if (x >= w) x = w - 1;
            if (y < 0) y = 0;
            if (y >= h) y = h - 1;
            dst[dy * PATCH + dx] = g[y * w + x];
        }
    }
}

/** Mean of a patch, for zero-mean comparison. */
static int patch_mean(const uint8_t *p)
{
    int s = 0;
    for (int i = 0; i < PATCH * PATCH; i++) s += p[i];
    return s / (PATCH * PATCH);
}

/**
 * Zero-mean error between a stored patch and the frame at (cx, cy).
 *
 * Zero-mean because the GC0308 runs continuous auto-exposure: without
 * removing the mean, the whole room brightening looks like every point
 * has been replaced.
 */
static int match_err(const uint8_t *g, int w, int h, int cx, int cy,
                     const uint8_t *patch, int patch_mu)
{
    int sum = 0, n = 0, err = 0;
    uint8_t cur[PATCH * PATCH];
    grab_patch(g, w, h, cx, cy, cur);

    for (int i = 0; i < PATCH * PATCH; i++) { sum += cur[i]; n++; }
    const int mu = n ? sum / n : 0;

    for (int i = 0; i < PATCH * PATCH; i++) {
        const int a = (int)cur[i] - mu;
        const int b = (int)patch[i] - patch_mu;
        err += a > b ? a - b : b - a;
    }
    return err / (PATCH * PATCH);
}

/** Follow one point: search a small window for its best new position. */
static bool follow_point(point_t *p, const uint8_t *g, int w, int h,
                         float pred_x, float pred_y, float dt_s)
{
    const int mu = patch_mean(p->patch);
    int best = 1 << 30, bx = (int)pred_x, by = (int)pred_y;

    for (int dy = -SEARCH; dy <= SEARCH; dy++) {
        for (int dx = -SEARCH; dx <= SEARCH; dx++) {
            const int cx = (int)pred_x + dx;
            const int cy = (int)pred_y + dy;
            if (cx < HALF || cx >= w - HALF || cy < HALF || cy >= h - HALF) continue;
            const int e = match_err(g, w, h, cx, cy, p->patch, mu);
            if (e < best) { best = e; bx = cx; by = cy; }
        }
    }

    if (best > LOST_ERR) return false;

    if (dt_s > 0.0f) {
        /* Blend velocity rather than replacing it: a single frame's
           displacement is noisy, and the point of velocity here is to
           predict, which needs it smooth. */
        const float nvx = ((float)bx - p->x) / dt_s;
        const float nvy = ((float)by - p->y) / dt_s;
        p->vx += 0.4f * (nvx - p->vx);
        p->vy += 0.4f * (nvy - p->vy);
    }
    p->x = (float)bx;
    p->y = (float)by;

    /* Refresh slowly so a turning person stays matched. */
    uint8_t cur[PATCH * PATCH];
    grab_patch(g, w, h, bx, by, cur);
    for (int i = 0; i < PATCH * PATCH; i++) {
        p->patch[i] = (uint8_t)(p->patch[i] + ((int)cur[i] - (int)p->patch[i]) / 4);
    }
    return true;
}

/* --------------------------------------------------------------- seeding -- */

/**
 * Put new points on whatever is moving.
 *
 * Seeds are placed where the frame differs from the previous one, so points
 * start on a person rather than on the furniture. Scenery never gets a
 * point in the first place, which is the difference between this and the
 * template approach it replaces.
 */
static void seed(const uint8_t *g, const uint8_t *prev, int w, int h)
{
    if (!prev) return;

    const int step = PATCH;
    int best_x[MAX_POINTS], best_y[MAX_POINTS], best_d[MAX_POINTS];
    int found = 0;

    for (int y = HALF; y < h - HALF; y += step) {
        for (int x = HALF; x < w - HALF; x += step) {
            /* Difference over a sparse sample of the block. */
            int d = 0;
            for (int k = 0; k < PATCH; k += 2) {
                const int i = (y + k - HALF) * w + x;
                const int a = (int)g[i], b = (int)prev[i];
                d += a > b ? a - b : b - a;
            }
            if (d < 40) continue;

            /* Not too close to an existing point. */
            bool near = false;
            for (int i = 0; i < MAX_POINTS; i++) {
                if (!s_pts[i].alive) continue;
                const float ddx = s_pts[i].x - (float)x;
                const float ddy = s_pts[i].y - (float)y;
                if (ddx * ddx + ddy * ddy < (float)(PATCH * PATCH * 4)) { near = true; break; }
            }
            if (near) continue;

            if (found < MAX_POINTS) {
                best_x[found] = x; best_y[found] = y; best_d[found] = d; found++;
            }
        }
    }

    for (int i = 0; i < found && s_alive < MAX_POINTS; i++) {
        for (int j = 0; j < MAX_POINTS; j++) {
            if (s_pts[j].alive) continue;
            s_pts[j].x = (float)best_x[i];
            s_pts[j].y = (float)best_y[i];
            s_pts[j].vx = s_pts[j].vy = 0.0f;
            s_pts[j].slow_frames = 0;
            s_pts[j].alive = true;
            grab_patch(g, w, h, best_x[i], best_y[i], s_pts[j].patch);
            s_alive++;
            break;
        }
    }
}

/* ---------------------------------------------------------------- update -- */

bool points_update(const uint8_t *gray, int w, int h,
                   float shift_x, float shift_y, float dt_s,
                   points_target_t *out)
{
    static uint8_t *prev = NULL;
    static int prev_w = 0, prev_h = 0;

    if (!gray || !out) return false;
    memset(out, 0, sizeof(*out));

    /* Follow existing points. */
    for (int i = 0; i < MAX_POINTS; i++) {
        point_t *p = &s_pts[i];
        if (!p->alive) continue;

        /* Predict where it should be: its own motion, plus however far the
           head just swung the whole view. */
        const float px = p->x + p->vx * dt_s - shift_x;
        const float py = p->y + p->vy * dt_s - shift_y;

        if (!follow_point(p, gray, w, h, px, py, dt_s)) {
            p->alive = false;
            s_alive--;
            continue;
        }

        /* The test that scenery fails. */
        const float speed = (p->vx < 0 ? -p->vx : p->vx) + (p->vy < 0 ? -p->vy : p->vy);
        if (speed < MIN_SPEED_PX_S) {
            if (++p->slow_frames > MAX_SLOW_FRAMES) {
                p->alive = false;
                s_alive--;
                continue;
            }
        } else {
            p->slow_frames = 0;
        }
    }

    if (s_alive < MAX_POINTS) seed(gray, (prev_w == w && prev_h == h) ? prev : NULL, w, h);

    /* Remember this frame for the next seeding pass. */
    if (!prev || prev_w != w || prev_h != h) {
        free(prev);
        prev = malloc((size_t)(w * h));
        prev_w = w; prev_h = h;
    }
    if (prev) memcpy(prev, gray, (size_t)(w * h));

    /* Report the centre of the points that are actually moving. */
    float sx = 0, sy = 0, svx = 0, svy = 0;
    int n = 0;
    for (int i = 0; i < MAX_POINTS; i++) {
        point_t *p = &s_pts[i];
        if (!p->alive) continue;

        /* Test the speed directly rather than trusting slow_frames.
         *
         * A freshly seeded point has slow_frames == 0 only because it has
         * not been tested yet, so filtering on that counter let brand new
         * STATIC points through - and since points are reseeded constantly,
         * the target ended up permanently made of untested scenery. Observed
         * as v(+0.00,+0.00) with 14 points pinned at the top of the frame,
         * driving the head up at +36 units a frame.
         *
         * A point earns its place by moving. */
        const float speed = (p->vx < 0 ? -p->vx : p->vx) + (p->vy < 0 ? -p->vy : p->vy);
        if (speed < MIN_SPEED_PX_S) continue;

        sx += p->x; sy += p->y; svx += p->vx; svy += p->vy;
        n++;
    }

    out->n_points = s_alive;
    if (n < 2) return true;   /* one point is a coincidence, not a target */

    sx /= (float)n; sy /= (float)n; svx /= (float)n; svy /= (float)n;

    out->x = (sx - (float)w * 0.5f) / ((float)w * 0.5f);
    out->y = (sy - (float)h * 0.5f) / ((float)h * 0.5f);
    out->vx = svx / (float)w;
    out->vy = svy / (float)h;
    out->confidence = (float)n / 6.0f;
    if (out->confidence > 1.0f) out->confidence = 1.0f;
    out->valid = true;
    return true;
}
