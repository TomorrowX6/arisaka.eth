"""
Flattens the coin artwork into plain filled polygon loops.

Blender's SVG importer handles neither <text> nor stroked geometry, and the
coin is built almost entirely out of both. So every glyph is resolved to
outlines here with fontTools, every stroke is converted to the equivalent
filled shape, and the result is written as JSON for build_coin.py to extrude.

Coordinates stay in the SVG's own space: 480 x 480 viewBox, centre (240,240),
y pointing down. The Blender side does the flip.

    python design/coin/glb/outlines.py
"""

import json
import math
import os
import sys

from fontTools.pens.basePen import BasePen
from fontTools.ttLib import TTFont

HERE = os.path.dirname(os.path.abspath(__file__))
FONTS = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")

# Matches the font stacks in the SVGs: Georgia for the struck legends,
# Cascadia Mono for anything that speaks in code.
FONT_FILES = {
    "serif": "georgia.ttf",
    "serif-bold": "georgiab.ttf",
    "mono": "CascadiaMono.ttf",
    "mono-bold": "CascadiaMono.ttf",
}
BOLD_WEIGHT = {"mono-bold": 700}

FLATNESS = 0.08          # bezier flattening tolerance, in SVG units
CIRCLE_SEGMENTS = 256    # for the full-coin rings
BEAD_SEGMENTS = 20

CX = CY = 240.0


# ── Font handling ────────────────────────────────────────────────────────────

class _Flattener(BasePen):
    """Collects contours as flat point lists, subdividing beziers adaptively."""

    def __init__(self, glyphSet, scale):
        super().__init__(glyphSet)
        self.scale = scale
        self.contours = []
        self._cur = []

    def _pt(self, p):
        return (p[0] * self.scale, -p[1] * self.scale)  # font y-up -> svg y-down

    def _moveTo(self, p):
        self._flush()
        self._cur = [self._pt(p)]

    def _lineTo(self, p):
        self._cur.append(self._pt(p))

    def _curveToOne(self, p1, p2, p3):
        self._cubic(self._cur[-1], self._pt(p1), self._pt(p2), self._pt(p3))

    def _qCurveToOne(self, p1, p2):
        a, b, c = self._cur[-1], self._pt(p1), self._pt(p2)
        # quadratic -> cubic
        self._cubic(a,
                    (a[0] + 2 / 3 * (b[0] - a[0]), a[1] + 2 / 3 * (b[1] - a[1])),
                    (c[0] + 2 / 3 * (b[0] - c[0]), c[1] + 2 / 3 * (b[1] - c[1])),
                    c)

    def _cubic(self, a, b, c, d, depth=0):
        # Flat enough when the control points sit close to the chord.
        if depth > 12 or (_dist_to_line(b, a, d) < FLATNESS and
                          _dist_to_line(c, a, d) < FLATNESS):
            self._cur.append(d)
            return
        ab, bc, cd = _mid(a, b), _mid(b, c), _mid(c, d)
        abc, bcd = _mid(ab, bc), _mid(bc, cd)
        m = _mid(abc, bcd)
        self._cubic(a, ab, abc, m, depth + 1)
        self._cubic(m, bcd, cd, d, depth + 1)

    def _closePath(self):
        self._flush()

    def _endPath(self):
        self._flush()

    def _flush(self):
        if len(self._cur) >= 3:
            if self._cur[0] == self._cur[-1]:
                self._cur.pop()
            self.contours.append(self._cur)
        self._cur = []


def _mid(p, q):
    return ((p[0] + q[0]) / 2, (p[1] + q[1]) / 2)


def _dist_to_line(p, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    n = math.hypot(dx, dy)
    if n < 1e-9:
        return math.hypot(p[0] - a[0], p[1] - a[1])
    return abs(dy * (p[0] - a[0]) - dx * (p[1] - a[1])) / n


class Face:
    def __init__(self, key):
        path = os.path.join(FONTS, FONT_FILES[key])
        font = TTFont(path, fontNumber=0)
        if key in BOLD_WEIGHT and "fvar" in font:
            from fontTools.varLib import instancer
            font = instancer.instantiateVariableFont(
                font, {"wght": BOLD_WEIGHT[key]}, inplace=False)
        self.font = font
        self.upm = font["head"].unitsPerEm
        self.cmap = font.getBestCmap()
        self.glyphSet = font.getGlyphSet()
        self.hmtx = font["hmtx"]
        self._cache = {}

    def _name(self, ch):
        return self.cmap.get(ord(ch)) or ".notdef"

    def advance(self, ch, size):
        return self.hmtx[self._name(ch)][0] / self.upm * size

    def outlines(self, ch, size):
        """Contours for one glyph, origin at the baseline start, y down."""
        key = (ch, size)
        if key not in self._cache:
            pen = _Flattener(self.glyphSet, size / self.upm)
            self.glyphSet[self._name(ch)].draw(pen)
            self._cache[key] = pen.contours
        return [list(c) for c in self._cache[key]]


_faces = {}


def face(key):
    if key not in _faces:
        _faces[key] = Face(key)
    return _faces[key]


# ── Text layout ──────────────────────────────────────────────────────────────

def _runs_width(runs, spacing):
    """runs: [(text, font_key, size)]. Spacing sits between glyphs only."""
    total, n = 0.0, 0
    for text, key, size in runs:
        f = face(key)
        for ch in text:
            total += f.advance(ch, size)
            n += 1
    return total + spacing * max(0, n - 1)


def text_straight(runs, cx, baseline, spacing=0.0, target_width=None):
    """Centred text. target_width mirrors SVG textLength/spacingAndGlyphs."""
    width = _runs_width(runs, spacing)
    k = (target_width / width) if target_width else 1.0
    x = cx - width * k / 2
    out = []
    for text, key, size in runs:
        f = face(key)
        for ch in text:
            for c in f.outlines(ch, size):
                out.append([(x + px * k, baseline + py) for px, py in c])
            x += (f.advance(ch, size) + spacing) * k
    return out


def text_arc(text, key, size, radius, spacing=0.0, side="top"):
    """
    Struck along a circle, numismatic convention: the top legend reads with
    letter tops facing out, the bottom legend with tops facing in. Each glyph
    is placed rigidly and rotated to the tangent at its own midpoint, which is
    what SVG textPath does.
    """
    f = face(key)
    advances = [f.advance(ch, size) for ch in text]
    width = sum(advances) + spacing * max(0, len(text) - 1)

    out = []
    cursor = -width / 2                      # arc length, signed from midpoint
    for ch, adv in zip(text, advances):
        mid = cursor + adv / 2
        sweep = mid / radius                 # radians along the arc

        if side == "top":
            phi = -math.pi / 2 + sweep       # y-down: -90 deg is 12 o'clock
            alpha = phi + math.pi / 2
        else:
            phi = math.pi / 2 - sweep        # 6 o'clock, running the other way
            alpha = phi - math.pi / 2

        ox = CX + radius * math.cos(phi)
        oy = CY + radius * math.sin(phi)
        ca, sa = math.cos(alpha), math.sin(alpha)

        for c in f.outlines(ch, size):
            loop = []
            for px, py in c:
                gx = px - adv / 2            # rotate about the glyph midpoint
                loop.append((ox + gx * ca - py * sa, oy + gx * sa + py * ca))
            out.append(loop)
        cursor += adv + spacing
    return out


# ── Analytic shapes ──────────────────────────────────────────────────────────

def circle(cx, cy, r, segments=CIRCLE_SEGMENTS, reverse=False):
    step = 2 * math.pi / segments
    pts = [(cx + r * math.cos(i * step), cy + r * math.sin(i * step))
           for i in range(segments)]
    return list(reversed(pts)) if reverse else pts


def ring(r, width, segments=CIRCLE_SEGMENTS):
    """Stroked circle -> annulus. Inner loop reversed so it reads as a hole."""
    return [circle(CX, CY, r + width / 2, segments),
            circle(CX, CY, r - width / 2, segments, reverse=True)]


def beads(r, count, bead_r):
    step = 2 * math.pi / count
    return [circle(CX + r * math.cos(i * step), CY + r * math.sin(i * step),
                   bead_r, BEAD_SEGMENTS)
            for i in range(count)]


def bar(x0, x1, y, width):
    h = width / 2
    return [[(x0, y - h), (x1, y - h), (x1, y + h), (x0, y + h)]]


def poly(points):
    return [list(points)]


def rosette(x, y, w=7.0, h=8.0):
    return [[(x - w, y), (x, y - h), (x + w, y), (x, y + h)]]


def device(paths, tx=240.0, ty=196.0, s=0.82, ox=-12.0, oy=60.0):
    """Applies the obverse device transform: translate, scale, translate."""
    return [[(tx + s * (px + ox), ty + s * (py + oy)) for px, py in p]
            for p in paths]


# ── The two faces ────────────────────────────────────────────────────────────

# Relief heights in SVG units. 1 unit = 40mm / 476 = 0.084mm, so the tallest
# devices stand ~0.39mm off the field, in the normal range for a struck coin.
H_RULE = 2.2
H_BEAD = 2.6
H_LEGEND = 3.6
H_DEVICE = 4.6


def shared_rings():
    return [
        ("ring-outer", H_RULE, ring(211, 1.6)),
        ("ring-inner", H_RULE, ring(205, 0.9)),
        ("beads", H_BEAD, beads(170, 96, 1.7)),
        ("rosette-w", H_LEGEND, rosette(47, 240)),
        ("rosette-e", H_LEGEND, rosette(433, 240)),
    ]


def obverse():
    groups = shared_rings()

    groups.append(("legend-top", H_LEGEND,
                   text_arc("CAPTURE THE FLAG", "serif", 19, 193, 4.5, "top")))
    groups.append(("legend-bottom", H_LEGEND,
                   text_arc("PROOF OF SOLVE", "serif", 19, 193, 4.5, "bottom")))

    groups.append(("device", H_DEVICE, device([
        [(-52, -152), (-31, -114), (-52, -102), (-73, -114)],   # finial, upper
        [(-73, -110), (-52, -98), (-31, -110), (-52, -84)],     # finial, lower
        [(-58, -92), (-46, -92), (-46, 14), (-58, 14)],         # mast
        [(-76, 14), (-28, 14), (-32, 26), (-72, 26)],           # plinth
        [(-46, -78), (100, -46), (-46, -50)],                   # pennant, upper
        [(-46, -43), (100, -45), (-46, -14)],                   # pennant, lower
    ])))

    groups.append(("wordmark", H_DEVICE, text_straight(
        [("ARISAKA", "serif-bold", 34), (".ETH", "serif", 28)],
        CX, 318, spacing=1.5, target_width=252)))
    groups.append(("wordmark-rule", H_RULE, bar(168, 312, 336, 1.2)))
    groups.append(("year", H_LEGEND, text_straight(
        [("MMXXVI", "mono", 13)], CX, 360, spacing=6)))

    return groups


def reverse():
    groups = shared_rings()

    groups.append(("legend-top", H_LEGEND,
                   text_arc("AWARDED FOR THE SOLVE", "serif", 19, 193, 4.5, "top")))
    groups.append(("legend-bottom", H_LEGEND,
                   text_arc("ARISAKA.ETH", "serif", 19, 193, 4.5, "bottom")))

    groups.append(("prompt", H_LEGEND, text_straight(
        [("> cat flag.txt", "mono", 15)], CX, 152, spacing=1.4)))
    groups.append(("brace-open", H_LEGEND, text_straight(
        [("flag{", "mono", 25)], CX, 200, spacing=2)))
    groups.append(("flag", H_DEVICE, text_straight(
        [("arisaka_eth", "mono-bold", 40)], CX, 256, target_width=248)))
    groups.append(("brace-close", H_LEGEND, text_straight(
        [("}", "mono", 25)], CX, 292, spacing=2)))

    groups.append(("rule", H_RULE, bar(172, 308, 322, 1.2)))
    groups.append(("rule-cap-w", H_LEGEND, rosette(162, 322, 6, 6)))
    groups.append(("rule-cap-e", H_LEGEND, rosette(318, 322, 6, 6)))
    groups.append(("serial", H_LEGEND, text_straight(
        [("NO. 001 / 100", "mono", 14)], CX, 352, spacing=4)))

    return groups


# ── Winding ──────────────────────────────────────────────────────────────────
#
# Font outlines are drawn for the nonzero rule: a glyph like "I" is a stem and
# two serifs as three *overlapping* outer contours, and Blender's even-odd curve
# fill would punch the overlaps out as holes. Splitting on winding direction
# fixes it — each outer contour becomes its own extruded body, so overlaps just
# merge in 3D, while counters stay attached to the contour that encloses them.
#
# TrueType outers run clockwise in the font's y-up space; the y flip in
# _Flattener inverts that, so here an outer has positive shoelace area.

def signed_area(loop):
    a = 0.0
    for i in range(len(loop)):
        x0, y0 = loop[i]
        x1, y1 = loop[(i + 1) % len(loop)]
        a += x0 * y1 - x1 * y0
    return a / 2


def contains(loop, pt):
    x, y = pt
    inside = False
    for i in range(len(loop)):
        x0, y0 = loop[i]
        x1, y1 = loop[(i + 1) % len(loop)]
        if (y0 > y) != (y1 > y):
            if x < x0 + (y - y0) / (y1 - y0) * (x1 - x0):
                inside = not inside
    return inside


def to_bodies(loops):
    """[loop] -> [[outer, hole, hole, ...], ...]"""
    outers, holes = [], []
    for loop in loops:
        (outers if signed_area(loop) > 0 else holes).append(loop)

    bodies = [[o] for o in outers]
    areas = [abs(signed_area(o)) for o in outers]
    for hole in holes:
        best, best_area = None, None
        for i, outer in enumerate(outers):
            if contains(outer, hole[0]) and (best_area is None or areas[i] < best_area):
                best, best_area = i, areas[i]
        if best is not None:
            bodies[best].append(hole)
    return bodies


def write_preview(data, path):
    """Renders the extracted loops straight back to SVG, so a layout mistake
    shows up here rather than three steps later in Blender."""
    parts = []
    for i, (name, groups) in enumerate(data["faces"].items()):
        ox = i * 500
        parts.append(f'<g transform="translate({ox},0)">')
        parts.append(f'<circle cx="240" cy="240" r="238" fill="#1b1b1b"/>')
        parts.append(f'<circle cx="240" cy="240" r="217" fill="#2e2e2e"/>')
        for g in groups:
            # One path per body, matching exactly what Blender will extrude.
            for body in g["bodies"]:
                d = " ".join(
                    "M " + " L ".join(f"{x},{y}" for x, y in loop) + " Z"
                    for loop in body)
                parts.append(f'<path d="{d}" fill="#f2e6c0" fill-rule="evenodd"/>')
        parts.append(f'<text x="240" y="474" fill="#888" font-size="16"'
                     f' text-anchor="middle" font-family="monospace">{name}</text>')
        parts.append("</g>")
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 980 480" '
           f'width="980" height="480"><rect width="980" height="480" fill="#111"/>'
           + "".join(parts) + "</svg>")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(svg)


def main():
    data = {
        "note": "SVG user units, 480 viewBox, centre (240,240), y down",
        "faces": {},
    }
    for name, fn in (("obverse", obverse), ("reverse", reverse)):
        data["faces"][name] = [
            {"name": g, "height": h,
             "bodies": [[[[round(x, 4), round(y, 4)] for x, y in loop]
                         for loop in body]
                        for body in to_bodies(loops)]}
            for g, h, loops in fn()
        ]

    out = os.path.join(HERE, "coin-outlines.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(data, fh)

    groups = [g for f in data["faces"].values() for g in f]
    bodies = sum(len(g["bodies"]) for g in groups)
    pts = sum(len(l) for g in groups for b in g["bodies"] for l in b)
    print(f"coin-outlines.json - {bodies} bodies, {pts} points, "
          f"{os.path.getsize(out) / 1024:.0f} kB")

    if "--preview" in sys.argv:
        p = os.path.join(HERE, "coin-outlines-preview.svg")
        write_preview(data, p)
        print(f"coin-outlines-preview.svg - layout check")


if __name__ == "__main__":
    main()
