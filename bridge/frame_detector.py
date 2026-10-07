"""Find the screen in a scene-camera frame from the bright frame markers.js draws.

EXPERIMENTAL — a candidate replacement for the AprilTags. Scored offline
against recordings (see eval_frame.py); not used by the live bridge yet.

    corners = detect_frame(bgr)   # TL, TR, BR, BL in raw scene px, or None

Corners are in the RAW (distorted) image, like corners_px in a recording, so
the two compare directly.

What the camera actually sees, measured on real recordings:
  - In a dim room the magenta line comes out washed-out light pink
    (brightness ~185 of 255) between a dark bezel (~60) and, often, dark
    content (~75). So it is FOUND by brightness: the line runs unbroken around
    the viewport, so the outer outline of the bright region containing it is
    the viewport's edge, whatever the content inside does.
  - Up close, auto-exposure darkens the scene and the same line turns a dim
    purple that a single fixed threshold misses — and then the next bright
    rectangle (a tag's white border) won instead. Hence several thresholds,
    and a COLOUR check on every candidate: the line is pink/purple (blue and
    red above green) while white tag borders and lit walls are not.
  - With the room lights ON the opposite happens: exposure is set for a
    bright room, the screen is among the darker things in view (a white wall
    is far brighter than the line), and the line comes out a dark, strongly
    SATURATED magenta-purple (saturation ~175) — found by colour instead.
    Both searches run; whichever finds a pink-edged quad wins.
  - The bright line blooms outward. Thresholding put the edge 1-3.7 camera px
    outside the truth, so edges are located instead at HALF-MAXIMUM: across
    the edge, where brightness falls halfway from the line to the bezel. That
    is exposure-independent.
  - The wide-angle lens bends the edges. Each corner is the intersection of
    lines fitted only to the short stretch of edge next to it, which is
    nearly straight where a full edge is not.
"""
import cv2
import numpy as np

# Candidate search runs at half resolution (4x fewer pixels); edges are then
# located at full resolution. Thresholds are tried brightest first.
SEARCH_SCALE = 0.5
THRESHOLDS = (125, 95, 70)
MIN_AREA_FRAC = 0.01          # smallest screen considered, of the image area
COVER_MIN = 0.7               # share of a candidate's perimeter on the mask
# Lights-on candidates: saturated magenta-purple, bright enough to exclude the
# darker purple glow on the bezel just outside the line (V ~110 vs ~175).
HUE_RANGE = (115, 170)        # OpenCV hue, 0-180; the line measures ~132
SAT_MIN = 90
VAL_MIN = 140
PINK_MIN = 8                  # median min(B,R)-G along the line (real: ~25)
CORNER_SPAN = 0.25            # fraction of each edge used to fit near a corner
EDGE_SAMPLES = 24             # half-maximum profiles per edge stretch
INNER_PX = 3.0                # how far inside the rough edge the line's peak may be


def _order_corners(pts):
    """TL, TR, BR, BL — assuming the glasses are worn roughly upright."""
    pts = np.asarray(pts, np.float64).reshape(4, 2)
    s, d = pts.sum(1), pts[:, 0] - pts[:, 1]
    return np.array([pts[np.argmin(s)], pts[np.argmax(d)],
                     pts[np.argmax(s)], pts[np.argmin(d)]])


def _bilinear(img, pts):
    """Mean brightness of a BGR image at sub-pixel points (N,2) -> (N,).

    Sampled straight from the colour image rather than from a precomputed
    grey one: converting all 1.9M pixels cost more than every profile put
    together, and edges are only ever needed at a few hundred points.
    """
    h, w = img.shape[:2]
    x = np.clip(pts[:, 0], 0, w - 1.001)
    y = np.clip(pts[:, 1], 0, h - 1.001)
    x0, y0 = np.floor(x).astype(int), np.floor(y).astype(int)
    fx, fy = (x - x0)[:, None], (y - y0)[:, None]
    v = (img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x0 + 1] * fx * (1 - fy) +
         img[y0 + 1, x0] * (1 - fx) * fy + img[y0 + 1, x0 + 1] * fx * fy)
    return v.mean(axis=1) if v.ndim == 2 else v


def _edge_points(gray, a, b, centre, t0, t1):
    """Half-maximum edge positions along the stretch a+t*(b-a), t in [t0,t1].

    For each sample, a brightness profile is taken along the outward normal:
    the line's peak lies just inside the rough edge, the bezel's level just
    outside, and the edge is where brightness crosses halfway between them.
    All profiles are sampled in one vectorised call — a Python loop over them
    cost ~20 ms a frame, most of the tracker's budget.
    """
    u = (b - a) / np.linalg.norm(b - a)
    n = np.array([-u[1], u[0]])
    if n @ (a - centre) < 0:
        n = -n                              # point outward
    # Narrow on purpose: the line is ~3 camera px thick at desk distance,
    # and anything bright further in (a tag's white border sits only ~7 px
    # inside the edge) must not be mistaken for its peak.
    offs = np.arange(-INNER_PX, 6.01, 0.25)  # negative = inside the screen
    ts = np.linspace(t0, t1, EDGE_SAMPLES)
    base = a + ts[:, None] * (b - a)                                # (S,2)
    pts = base[:, None, :] + offs[None, :, None] * n                # (S,O,2)
    prof = _bilinear(gray, pts.reshape(-1, 2)).reshape(len(ts), len(offs))
    inner = offs <= 1.5
    k_peak = np.argmax(np.where(inner, prof, -1), axis=1)            # (S,)
    peak = prof[np.arange(len(ts)), k_peak]
    floor = np.median(prof[:, offs >= 4.0], axis=1)
    half = (peak + floor) / 2
    # first fall below half-maximum, outward of the peak
    idx = np.arange(len(offs) - 1)
    crossing = ((prof[:, :-1] >= half[:, None]) & (prof[:, 1:] < half[:, None]) &
                (idx[None, :] >= k_peak[:, None]))
    has = crossing.any(axis=1) & (peak - floor >= 20)   # else: no clear line here
    k = np.argmax(crossing, axis=1)
    r = np.arange(len(ts))
    p0, p1 = prof[r, k], prof[r, k + 1]
    f = np.where(p0 != p1, (p0 - half) / np.where(p0 != p1, p0 - p1, 1), 0)
    out = base + ((offs[k] + f * 0.25)[:, None]) * n
    return out[has]


def _fit_line(points):
    if len(points) < 5:
        return None
    vx, vy, x0, y0 = cv2.fitLine(np.float32(points), cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()
    return np.array([x0, y0]), np.array([vx, vy])


def _intersect(l1, l2):
    (p, r), (q, s) = l1, l2
    den = r[0] * s[1] - r[1] * s[0]
    if abs(den) < 1e-9:
        return None
    t = ((q - p)[0] * s[1] - (q - p)[1] * s[0]) / den
    return p + t * r


def _refit_edges(gray, rough):
    """Correct the rough quad from whole edges: one bad hull vertex cannot
    survive three good edges. Lines through the middle 70% of each edge,
    intersected pairwise. (Lens bowing biases these slightly; the per-corner
    step afterwards removes that.)"""
    centre = rough.mean(0)
    lines = []
    for k in range(4):
        a, b = rough[k], rough[(k + 1) % 4]
        if np.linalg.norm(b - a) < 20:
            return None
        lines.append(_fit_line(_edge_points(gray, a, b, centre, 0.15, 0.85)))
    if any(l is None for l in lines):
        return None
    out = []
    for k in range(4):
        p = _intersect(lines[(k - 1) % 4], lines[k])
        if p is None or np.linalg.norm(p - rough[k]) > 40:
            return None
        out.append(p)
    return np.array(out)


def _refine(gray, rough):
    rough = _refit_edges(gray, rough)
    if rough is None:
        return None
    centre = rough.mean(0)
    refined = []
    for k in range(4):
        c, nxt, prv = rough[k], rough[(k + 1) % 4], rough[(k - 1) % 4]
        if min(np.linalg.norm(nxt - c), np.linalg.norm(prv - c)) < 20:
            return None
        # Start clear of the corner itself (rounded by blur, and the
        # orientation square sits in the top-left).
        lines = [_fit_line(_edge_points(gray, c, o, centre, 0.06, CORNER_SPAN))
                 for o in (nxt, prv)]
        if lines[0] is None or lines[1] is None:
            return None
        p = _intersect(*lines)
        if p is None or np.linalg.norm(p - c) > 12:
            return None
        refined.append(p)
    return np.array(refined)


def _pinkness_along(bgr, quad):
    """Median min(B,R)-G just inside the quad's edges, corners skipped."""
    centre = quad.mean(0)
    pts = []
    for k in range(4):
        a, b = quad[k], quad[(k + 1) % 4]
        for t in np.linspace(0.15, 0.85, 30):
            p = a + t * (b - a)
            d = centre - p
            pts.append(p + 1.5 * d / np.linalg.norm(d))
    pts = np.round(pts).astype(int)
    h, w = bgr.shape[:2]
    ok = (pts[:, 0] >= 0) & (pts[:, 0] < w) & (pts[:, 1] >= 0) & (pts[:, 1] < h)
    if ok.sum() < 40:
        return -999
    px = bgr[pts[ok, 1], pts[ok, 0]].astype(int)
    return float(np.median(np.minimum(px[:, 0], px[:, 2]) - px[:, 1]))


def _perimeter_coverage(mask, quad):
    """Fraction of the quad's perimeter that lies on the mask (1px slack)."""
    near = cv2.dilate(mask, np.ones((3, 3), np.uint8))
    h, w = mask.shape
    hits = total = 0
    for k in range(4):
        a, b = quad[k], quad[(k + 1) % 4]
        n = max(int(np.linalg.norm(b - a)), 8)
        for t in np.linspace(0.05, 0.95, n):   # corners are rounded: skip
            x, y = np.round(a + t * (b - a)).astype(int)
            if 0 <= x < w and 0 <= y < h:
                total += 1
                hits += near[y, x] > 0
    return hits / total if total else 0.0


def _quads(mask, close, test):
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((close, close), np.uint8))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    h, w = mask.shape
    out = []
    for cnt in contours:
        hull = cv2.convexHull(cnt)
        area = cv2.contourArea(hull)
        if area < MIN_AREA_FRAC * w * h:
            continue
        approx = cv2.approxPolyDP(hull, 0.02 * cv2.arcLength(hull, True), True)
        if len(approx) != 4:
            continue
        quad = approx.reshape(4, 2).astype(np.float64)
        if test(mask, cnt, area, quad):
            out.append((area, quad))
    return sorted(out, key=lambda c: -c[0])


def _candidates(mask):
    """Quadrilaterals the mask outlines, by two complementary tests.

    SOLID: the outline of a closed bright region fills its hull — robust when
    the line is unbroken (dim room), since nothing outside it can join in.
    PERIMETER: most of the quad's edge lies on the mask — needed when the line
    is ~1 px wide at search resolution and broken in places (lit room), where
    no closed outline forms at all. Each alone lost a whole recording.
    """
    yield from _quads(mask, 3, lambda m, cnt, area, q: cv2.contourArea(cnt) / max(area, 1) >= 0.9)
    yield from _quads(mask, 5, lambda m, cnt, area, q: _perimeter_coverage(m, q) >= COVER_MIN)


def _masks(bgr_small):
    """Candidate masks, most specific first."""
    bright = bgr_small.max(axis=2)          # the line is bright in R and B
    for threshold in THRESHOLDS:
        yield (bright > threshold).astype(np.uint8)
    hsv = cv2.cvtColor(bgr_small, cv2.COLOR_BGR2HSV)
    h, sat, val = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    yield ((h >= HUE_RANGE[0]) & (h <= HUE_RANGE[1]) &
           (sat >= SAT_MIN) & (val >= VAL_MIN)).astype(np.uint8)


def detect_frame(bgr):
    # Edges are located on MEAN brightness (see _bilinear): it separates line
    # from bezel in a dark room (~185 vs ~65) and a lit one (~114 vs ~57)
    # alike, where the brightest channel alone does not (blue: 175 vs 110
    # with lights on).
    gray = bgr
    small = cv2.resize(bgr, None, fx=SEARCH_SCALE, fy=SEARCH_SCALE,
                       interpolation=cv2.INTER_AREA)
    for mask in _masks(small):
        found = sorted(_candidates(mask), key=lambda c: -c[0])
        for _area, quad in found:
            rough = _order_corners(quad / SEARCH_SCALE)
            if _pinkness_along(bgr, rough) < PINK_MIN:
                continue                    # white tag border, lit wall, …
            corners = _refine(gray, rough)
            if corners is not None:
                return corners
    return None


class FrameTracker:
    """detect_frame over a video stream: cheap while it holds, safe when lost.

    While the screen was found in the previous frame, it is re-located from
    there — edges and corners only, no image-wide search — which costs a few
    ms instead of ~30. A full search runs when that fails. A full search
    that lands far from where the screen just was is held back until the
    next frame confirms it: a brief wrong rectangle (a tag's white border, a
    lit window) never reaches the gaze mapping, while a real move survives
    one frame of doubt.
    """

    # Beyond this jump (camera px) from the last good solve, a full-search
    # result needs confirming by the next frame.
    JUMP_PX = 40
    # How long a previous solve counts as "where the screen just was".
    RECENT_S = 0.5

    # Once the screen has been out of view this long, search only every
    # SEARCH_EVERY-th frame: nobody is looking at it, a full search costs
    # ~20 ms of the bridge's event loop, and a returning screen is still
    # picked up within a tenth of a second.
    LOST_SLOW_S = 1.0
    SEARCH_EVERY = 3

    def __init__(self):
        self.corners = None
        self.at = 0.0
        self._pending = None
        self._skipped = 0

    def update(self, bgr, now):
        recent = self.corners is not None and now - self.at < self.RECENT_S
        if recent:
            tracked = _refine(bgr, self.corners)
            if tracked is not None:
                return self._accept(tracked, now)
        if now - self.at > self.LOST_SLOW_S:
            self._skipped = (self._skipped + 1) % self.SEARCH_EVERY
            if self._skipped:
                return None
        found = detect_frame(bgr)
        if found is None:
            self._pending = None
            return None
        if recent and np.linalg.norm(found - self.corners, axis=1).max() > self.JUMP_PX:
            if (self._pending is not None and
                    np.linalg.norm(found - self._pending, axis=1).max() < self.JUMP_PX / 4):
                return self._accept(found, now)    # confirmed: the screen did move
            self._pending = found
            return None
        return self._accept(found, now)

    def _accept(self, corners, now):
        self.corners, self.at, self._pending = corners, now, None
        return corners
