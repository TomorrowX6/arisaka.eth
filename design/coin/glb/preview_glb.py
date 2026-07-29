"""
Re-imports the exported GLB and renders both faces, so what gets checked is
the actual file rather than the scene it came from.

    "C:\\Program Files\\Blender Foundation\\Blender 5.1\\blender.exe" \
        --background --factory-startup \
        --python design/coin/glb/preview_glb.py
"""

import math
import os
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(sys.argv[sys.argv.index("--python") + 1]))

# Anything after "--" selects which platings to render; default is all three.
_args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
METALS = _args or ["gold", "silver", "bronze"]

RES = 900
SAMPLES = 64


def clear():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)


def studio():
    world = bpy.data.worlds.new("studio")
    bpy.context.scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    bg = nt.nodes["Background"]
    grad = nt.nodes.new("ShaderNodeTexGradient")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    tex = nt.nodes.new("ShaderNodeTexCoord")
    mapping = nt.nodes.new("ShaderNodeMapping")
    mapping.inputs["Rotation"].default_value = (math.radians(90), 0, 0)
    nt.links.new(tex.outputs["Generated"], mapping.inputs["Vector"])
    nt.links.new(mapping.outputs["Vector"], grad.inputs["Vector"])
    nt.links.new(grad.outputs["Color"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bg.inputs["Color"])
    # Metal has no diffuse term — it only shows what surrounds it. A dim world
    # renders gold as brown mud, so this is deliberately bright.
    ramp.color_ramp.elements[0].color = (0.05, 0.05, 0.06, 1)
    ramp.color_ramp.elements[1].color = (1.0, 0.99, 0.96, 1)
    bg.inputs["Strength"].default_value = 2.6


# The coin comes back from glTF facing Blender -Y, so -Y is "towards camera".
LIGHTS = (
    ("key", (-0.09, -0.12, 0.10), 260, 0.16),
    ("fill", (0.11, -0.10, 0.02), 90, 0.22),
    ("rim", (0.02, 0.13, 0.06), 140, 0.14),
)


def key_lights(sign):
    objs = []
    for name, (lx, ly, lz), energy, size in LIGHTS:
        light = bpy.data.lights.new(name, "AREA")
        light.energy = energy
        light.size = size
        obj = bpy.data.objects.new(name, light)
        obj.location = (lx, ly * sign, lz)
        obj.rotation_euler = _look(tuple(-c for c in obj.location))
        bpy.context.collection.objects.link(obj)
        objs.append(obj)
    return objs


def _look(d):
    x, y, z = d
    return (math.atan2(math.hypot(x, y), z), 0, math.atan2(y, x) + math.pi / 2)


def camera(distance=0.115):
    cam_data = bpy.data.cameras.new("cam")
    cam_data.lens = 85
    cam = bpy.data.objects.new("cam", cam_data)
    bpy.context.collection.objects.link(cam)
    bpy.context.scene.camera = cam
    return cam


def shoot(cam, sign, path, distance=0.115):
    """sign -1 looks at the obverse, +1 swings round to the reverse."""
    for old in [o for o in bpy.context.scene.objects if o.type == "LIGHT"]:
        bpy.data.objects.remove(old, do_unlink=True)
    key_lights(sign)

    cam.location = (0, distance * sign, 0)
    cam.rotation_euler = (math.pi / 2, 0, math.pi if sign > 0 else 0)
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def main():
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = SAMPLES
    scene.cycles.use_denoising = True
    scene.render.resolution_x = scene.render.resolution_y = RES
    scene.render.film_transparent = False
    scene.view_settings.view_transform = "Standard"   # AgX desaturates the metal

    studio()

    for metal in METALS:
        glb = os.path.join(HERE, f"arisaka-coin-{metal}.glb")
        for old in [o for o in scene.objects if o.type == "MESH"]:
            bpy.data.objects.remove(old, do_unlink=True)
        bpy.ops.import_scene.gltf(filepath=glb)

        coin = next(o for o in scene.objects if o.type == "MESH")
        dims = tuple(round(d * 1000, 3) for d in coin.dimensions)
        colour = next(n for n in coin.data.materials[0].node_tree.nodes
                      if n.type == "BSDF_PRINCIPLED").inputs["Base Color"].default_value
        print(f"\n[glb] {metal}: {len(coin.data.vertices)} verts, {dims} mm, "
              f"F0 {tuple(round(c, 3) for c in colour[:3])}, "
              f"materials {[m.name for m in coin.data.materials]}")

        cam = camera()
        shoot(cam, -1, os.path.join(HERE, f"preview-{metal}-obverse.png"))
        shoot(cam, +1, os.path.join(HERE, f"preview-{metal}-reverse.png"))
        bpy.data.objects.remove(cam, do_unlink=True)

    print("\n[glb] previews written")


main()
