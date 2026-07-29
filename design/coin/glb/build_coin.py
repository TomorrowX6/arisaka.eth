"""
Builds the 1st-place (gold) coin as real geometry and exports GLB.

The planchet is generated parametrically — the reeded edge is a surface of
revolution with a 132-cycle radius, not 132 booleans. The relief comes from
coin-outlines.json: each group becomes a filled 2D curve, extruded to its own
height, so every letter and bead is genuine geometry rather than a normal map.

    "C:\\Program Files\\Blender Foundation\\Blender 5.1\\blender.exe" \
        --background --factory-startup \
        --python design/coin/glb/build_coin.py

Everything below is in SVG design units until the final scale: the 480 unit
viewBox maps to a 40 mm coin, so 1 unit = 0.084 mm.
"""

import json
import math
import os
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(bpy.data.filepath or __file__))
if "--python" in sys.argv:                       # resolve when run headless
    HERE = os.path.dirname(os.path.abspath(sys.argv[sys.argv.index("--python") + 1]))

OUTLINES = os.path.join(HERE, "coin-outlines.json")

# Linear F0 reflectance. For a metal, base colour *is* the specular colour —
# these are the standard reference values, not the 2D palette's shaded tones.
METALS = {
    "gold": (1.000, 0.766, 0.336),      # 1st
    "silver": (0.972, 0.960, 0.915),    # 2nd
    "bronze": (0.804, 0.498, 0.196),    # 3rd
}

# ── Planchet dimensions, design units ────────────────────────────────────────
R_OUT = 238.0        # rim crest
R_REED = 234.0       # reed valley
REEDS = 132
R_FIELD = 217.0      # where the rim's flat top ends
R_BEVEL = 213.0      # where the sunken field begins
T_HALF = 18.0        # half thickness -> 3 mm
FIELD_Z = 14.0       # field sits 4 units below the rim, so the rim protects it
EMBED = 0.4          # how far relief sinks into the field, to avoid a seam
BEVEL = 0.10         # edge break on every device, ~0.008 mm
# Overlapping bodies within a glyph (an "I" is a stem plus two serifs laid over
# it) end up with coincident top faces, which z-fight. Staggering neighbouring
# bodies by a hair separates them; 0.08 units is 0.007 mm, well under both the
# 0.39 mm relief and anything a die could hold.
Z_NUDGE = 0.08

SEGMENTS = REEDS * 8
MM_PER_UNIT = 40.0 / (R_OUT * 2)
SCALE = MM_PER_UNIT * 0.001                      # design units -> metres


# ── Scene helpers ────────────────────────────────────────────────────────────

def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for block in (bpy.data.meshes, bpy.data.curves, bpy.data.materials):
        for item in list(block):
            block.remove(item)


def metal_material(name, roughness):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Metallic"].default_value = 1.0
    bsdf.inputs["Roughness"].default_value = roughness
    return mat


def set_metal(materials, rgb):
    for mat in materials:
        bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
        bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)


# ── Planchet ─────────────────────────────────────────────────────────────────

def build_planchet(material):
    verts, faces = [], []
    n = SEGMENTS
    mid = (R_OUT + R_REED) / 2
    amp = (R_OUT - R_REED) / 2

    def ring(radius_fn, z):
        start = len(verts)
        for i in range(n):
            t = 2 * math.pi * i / n
            r = radius_fn(t)
            verts.append((r * math.cos(t), r * math.sin(t), z))
        return start

    # Reeds are milled as a rounded cycle rather than sharp teeth — that is
    # what a real reeded edge looks like, and it shades far better.
    reeded = lambda t: mid + amp * math.cos(REEDS * t)
    flat = lambda _r: (lambda t: _r)

    top_out = ring(reeded, T_HALF)
    bot_out = ring(reeded, -T_HALF)
    top_rim = ring(flat(R_FIELD), T_HALF)
    bot_rim = ring(flat(R_FIELD), -T_HALF)
    top_bev = ring(flat(R_BEVEL), FIELD_Z)
    bot_bev = ring(flat(R_BEVEL), -FIELD_Z)

    top_c = len(verts); verts.append((0, 0, FIELD_Z))
    bot_c = len(verts); verts.append((0, 0, -FIELD_Z))

    def strip(a, b, flip=False):
        for i in range(n):
            j = (i + 1) % n
            quad = [a + i, a + j, b + j, b + i]
            faces.append(quad[::-1] if flip else quad)

    strip(top_out, bot_out)                 # milled edge
    strip(top_rim, top_out)                 # rim table, obverse
    strip(top_bev, top_rim)                 # bevel down to the field
    strip(bot_out, bot_rim, flip=True)
    strip(bot_rim, bot_bev, flip=True)

    for i in range(n):
        j = (i + 1) % n
        faces.append([top_c, top_bev + i, top_bev + j])
        faces.append([bot_c, bot_bev + j, bot_bev + i])

    mesh = bpy.data.meshes.new("planchet")
    mesh.from_pydata(verts, [], faces)
    mesh.validate()
    obj = bpy.data.objects.new("planchet", mesh)
    obj.data.materials.append(material)
    bpy.context.collection.objects.link(obj)
    return obj


# ── Relief ───────────────────────────────────────────────────────────────────

def build_body(name, loops, height, face, material, nudge=0.0):
    """One set of loops -> one extruded, filled, edge-broken curve object."""
    curve = bpy.data.curves.new(name, "CURVE")
    curve.dimensions = "2D"
    curve.fill_mode = "BOTH"
    curve.extrude = height / 2
    curve.resolution_u = 1
    # A dead-vertical wall reads as a black line under any lighting. Struck
    # coins have drafted devices, so break the edge just enough to catch light
    # without closing up the counters in 19-unit type.
    curve.bevel_depth = BEVEL
    curve.bevel_resolution = 1

    for loop in loops:
        spline = curve.splines.new("POLY")
        spline.points.add(len(loop) - 1)
        for pt, (x, y) in zip(spline.points, loop):
            # SVG is y-down and centred on (240,240); Blender is y-up at origin.
            pt.co = (x - 240.0, -(y - 240.0), 0.0, 1.0)
        spline.use_cyclic_u = True

    obj = bpy.data.objects.new(name, curve)
    obj.data.materials.append(material)
    z = FIELD_Z + height / 2 - EMBED + nudge
    if face == "obverse":
        obj.location = (0, 0, z)
    else:
        # Turning the coin about its vertical axis: mirrors x and drops to -z,
        # which is what keeps the reverse readable from behind.
        obj.location = (0, 0, -z)
        obj.rotation_euler = (0, math.pi, 0)

    bpy.context.collection.objects.link(obj)
    return obj


def build_group(group, face, material):
    """Each body is one outer contour plus its counters — see outlines.py."""
    stem = f"{face}-{group['name']}"
    return [build_body(f"{stem}-{i}", body, group["height"], face, material,
                       nudge=(i % 4) * Z_NUDGE)
            for i, body in enumerate(group["bodies"])]


def to_mesh(objs):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.convert(target="MESH")


# ── Assembly ─────────────────────────────────────────────────────────────────

def main():
    clear_scene()

    # Proof-coin cameo: mirror field against heavily frosted devices. The
    # roughness gap is what separates relief from field when both are flat
    # and lit from the same side.
    polished = metal_material("coin-field", 0.06)
    frosted = metal_material("coin-relief", 0.58)

    planchet = build_planchet(polished)

    with open(OUTLINES, encoding="utf-8") as fh:
        data = json.load(fh)

    relief = []
    for face, groups in data["faces"].items():
        for group in groups:
            relief.extend(build_group(group, face, frosted))
    to_mesh(relief)

    bpy.ops.object.select_all(action="DESELECT")
    for o in relief + [planchet]:
        o.select_set(True)
    bpy.context.view_layer.objects.active = planchet
    bpy.ops.object.join()
    coin = bpy.context.view_layer.objects.active
    coin.name = "arisaka-coin"

    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")

    try:
        bpy.ops.object.shade_auto_smooth(angle=math.radians(35))
    except Exception:
        bpy.ops.object.shade_smooth()

    # Real-world scale, and stood up so the obverse faces the camera in glTF
    # (Blender -Y maps to glTF +Z).
    coin.scale = (SCALE, SCALE, SCALE)
    coin.rotation_euler = (math.radians(90), 0, 0)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)

    # One build, three platings: the geometry stays vertex-for-vertex identical
    # across the three ranks and only the F0 changes.
    tris = sum(len(p.vertices) - 2 for p in coin.data.polygons)
    print(f"\n[coin] {len(coin.data.vertices)} verts, {tris} tris")
    for metal, rgb in METALS.items():
        set_metal((polished, frosted), rgb)
        path = os.path.join(HERE, f"arisaka-coin-{metal}.glb")
        bpy.ops.export_scene.gltf(filepath=path, export_format="GLB",
                                  use_selection=True, export_apply=True)
        print(f"[coin] {metal:<7} {os.path.getsize(path) / 1024:.0f} kB -> {path}")


main()
