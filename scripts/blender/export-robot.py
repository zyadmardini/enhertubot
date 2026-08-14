"""Turn Robot.blend into the web GLB, headless.

  blender -b -noaudio Robot.blend --python scripts/blender/export-robot.py \
      -- <out.blend> <out.glb>

Run with the Blender version that WROTE the file (5.2 for Robot.blend), not the
newest installed. Pair with scripts/optimize-robot-glb.mjs, which handles scale,
texture compression and Draco on the glTF side.
"""

import bpy, sys, json, os, re

argv = sys.argv[sys.argv.index("--") + 1:]
OUT_BLEND, OUT_GLB = argv[0], argv[1]

# Second-pass map, for clips rescue-actions.py could only slugify. Anything the
# artist names outside the contract lands here rather than being guessed at.
RENAME = {
    "wave_one_hand": "greeting_wave",
    "talk_with_left_hand_raised": "talk_b",
    "talk_with_hands_open": "talk_a",
    "short_breathe_and_look_around": "idle_look_around",
    "idle_3": "idle",
    "walking_man": "walk",
}

REQUIRED = ["idle", "breathe", "greeting_wave", "talk_a", "talk_b", "talk_c", "thinking", "nod"]

log = {"blender": bpy.app.version_string, "deleted": [], "renamed": [], "clips": []}

# --- 1. drop the unrigged high-res sculpt -----------------------------------
# 1.9M tris, no armature, no vertex groups: it cannot animate and it is ~190MB
# of the file. Kept in the .blend as a bake source; never shipped.
for o in list(bpy.data.objects):
    if o.type == "MESH" and not o.vertex_groups and not o.find_armature():
        log["deleted"].append({"object": o.name, "tris": len(o.data.polygons)})
        bpy.data.objects.remove(o, do_unlink=True)

# --- 2. finish renaming to the clip contract --------------------------------
for a in bpy.data.actions:
    key = re.sub(r"[^a-z0-9_]", "", a.name.lower())
    new = RENAME.get(key)
    if new and new != a.name:
        log["renamed"].append({"was": a.name, "now": new})
        a.name = new
    a.use_fake_user = True

# Track names drive NLA_TRACKS export and are what the artist reads in the
# dope sheet; keep them in step with the action they hold.
for o in bpy.data.objects:
    if not o.animation_data:
        continue
    for t in o.animation_data.nla_tracks:
        for s in t.strips:
            if s.action:
                s.name = t.name = s.action.name

bpy.ops.outliner.orphans_purge(do_local_ids=True, do_linked_ids=True, do_recursive=True)
bpy.ops.wm.save_as_mainfile(filepath=OUT_BLEND)

# --- 3. export --------------------------------------------------------------
# ACTIONS mode rather than NLA_TRACKS: both were verified to emit identically
# named clips, and ACTIONS does not care whether the stack is muted.
bpy.ops.export_scene.gltf(
    filepath=OUT_GLB,
    export_format="GLB",
    export_animations=True,
    export_animation_mode="ACTIONS",
    export_bake_animation=False,
    export_force_sampling=True,
    export_optimize_animation_size=True,
    export_apply=True,
    export_yup=True,
    export_skins=True,
    export_morph=False,
    export_cameras=False,
    export_lights=False,
)

have = sorted(a.name for a in bpy.data.actions)
log["clips"] = have
log["missing_required"] = [c for c in REQUIRED if c not in have]
log["blend_bytes"] = os.path.getsize(OUT_BLEND)
log["glb_bytes"] = os.path.getsize(OUT_GLB)

print("###JSON_START###")
print(json.dumps(log, indent=2))
print("###JSON_END###")
