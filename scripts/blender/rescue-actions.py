"""Make every action in the open Blender session survive a save, then name it
to the clip contract and stack it in the NLA.

RUN THIS IN THE RUNNING BLENDER, not headless: Scripting tab -> Open -> Run.
The actions this rescues exist only in that session's memory.

Why it is needed
----------------
An action with no user and no fake user is dropped when the file is written.
Assigning a clip in the Action Editor gives that one clip a user and takes the
user off the last one, so every save keeps exactly the clip you happen to have
loaded and silently discards the rest. Robot.blend has been through this twice:
saved 15:04 it held Short_Breathe_and_Look_Around, saved 15:20 it held Idle_3,
and never more than one at a time. Nothing is corrupt and nothing was deleted by
hand — the clips are still in RAM, which is why the Action Editor still lists
them.

What it does
------------
1. Sets a fake user on every action, so none can be purged again.
2. Renames to the ClipName contract in apps/kiosk/src/core/types.ts. Names that
   are not in the map are slugified and reported, not guessed at.
3. Pushes each action onto its own muted NLA track named for the clip. Not
   strictly required for glTF export, which can read the actions directly, but
   it makes the set visible in one place and gives every clip a real user rather
   than relying on the fake-user flag alone.
4. Saves over the open file.
"""

import bpy
import re

# Meshy exports actions as "Armature|<Name>|baselayer". Key on the middle
# segment, lowercased. Anything unmapped is reported so the map can grow.
RENAME = {
    "idle": "idle",
    "idle_3": "idle",
    "breathe": "breathe",
    "breathing": "breathe",
    "short_breathe_and_look_around": "idle_look_around",
    "look_around": "idle_look_around",
    "waving": "greeting_wave",
    "wave": "greeting_wave",
    "hello": "greeting_wave",
    "goodbye": "goodbye_wave",
    "talk_with_hands_open": "talk_a",
    "talking": "talk_b",
    "talk_with_hands": "talk_c",
    "thinking": "thinking",
    "think": "thinking",
    "nod": "nod",
    "nodding": "nod",
    "shake": "shake",
    "shrug": "shrug",
    "point": "point_front",
    "pointing": "point_front",
    "present": "present",
    "celebrate": "celebrate",
    "walking_man": "walk",
    "walking": "walk",
}

REQUIRED = ["idle", "breathe", "greeting_wave", "talk_a", "talk_b", "talk_c", "thinking", "nod"]


def clip_name(raw):
    """'Armature|Short_Breathe_and_Look_Around|baselayer' -> 'idle_look_around'."""
    parts = [p for p in raw.split("|") if p]
    mid = parts[1] if len(parts) >= 2 else parts[0]
    mid = re.sub(r"(?i)^(armature|mixamo(rig)?[:.]?)", "", mid).strip("_ ")
    key = re.sub(r"[^a-z0-9_]", "", mid.lower().replace(" ", "_").replace("-", "_"))
    return RENAME.get(key, key), key in RENAME


arm = next((o for o in bpy.data.objects if o.type == "ARMATURE"), None)
if arm is None:
    raise SystemExit("No armature in the scene.")

ad = arm.animation_data or arm.animation_data_create()
was_active = ad.action.name if ad.action else None

# A strip cannot be created for an action while it is actively assigned.
ad.action = None

# Clear tracks first so re-running is idempotent rather than additive, and so
# strips orphaned by an earlier purge go away.
for track in list(ad.nla_tracks):
    ad.nla_tracks.remove(track)

renamed, unmapped = [], []
for action in sorted(bpy.data.actions, key=lambda a: a.name):
    new, known = clip_name(action.name)
    if not known:
        unmapped.append(f"{action.name}  ->  {new}")
    renamed.append((action.name, new))

    action.use_fake_user = True
    action.name = new

    track = ad.nla_tracks.new()
    track.name = new
    strip = track.strips.new(new, int(action.frame_range[0]), action)
    strip.name = new
    # Blender 4.4+ slotted actions: bind the object slot or the strip plays nothing.
    if hasattr(strip, "action_slot"):
        for slot in action.slots:
            if slot.target_id_type == "OBJECT":
                strip.action_slot = slot
                break
    track.mute = True  # keep the viewport showing the active action, not the stack

# Put the artist back where they were.
if was_active:
    restored = dict(renamed).get(was_active, was_active)
    if restored in bpy.data.actions:
        ad.action = bpy.data.actions[restored]

if bpy.data.filepath:
    bpy.ops.wm.save_mainfile()

have = {a.name for a in bpy.data.actions}
print("\n" + "=" * 60)
print(f"Rescued {len(renamed)} action(s):")
for old, new in renamed:
    print(f"  {old}\n    -> {new}")
if unmapped:
    print("\nNot in the rename map — slugified, tell Claude to map these:")
    for u in unmapped:
        print(f"  {u}")
missing = [c for c in REQUIRED if c not in have]
print(f"\nRequired clips: {len(REQUIRED) - len(missing)}/{len(REQUIRED)}")
if missing:
    print("  missing: " + ", ".join(missing))
print("Saved." if bpy.data.filepath else "NOT saved — file has never been saved.")
print("=" * 60)
