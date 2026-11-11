# Render the SingersVoice 3D logo from the Blender source file.
#
# Run on your computer (Blender 3.6+ / 4.x):
#   blender -b "C:\Work\SVOld\assets\Logo\SV.blend" -P tools/brand/export_logo_blender.py -- out/
#
# Produces in out/:
#   sv-logo-1024.png        transparent still (front view, current frame)
#   sv-logo-turntable.mp4   10 s loop at 1280x720 (H.264), for the welcome hero
#
# The still is a drop-in replacement for apps/web/public/brand/sv-mark@2x.png
# (run tools/brand/make_brand.py afterwards to regenerate icons).
import sys
from pathlib import Path

import bpy

out = Path(sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "out")
out.mkdir(parents=True, exist_ok=True)

scene = bpy.context.scene
scene.render.engine = "BLENDER_EEVEE_NEXT" if hasattr(bpy.types, "SceneEEVEE") else "BLENDER_EEVEE"
scene.render.film_transparent = True

# Still
scene.render.resolution_x = 1024
scene.render.resolution_y = 1024
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
scene.render.filepath = str(out / "sv-logo-1024.png")
bpy.ops.render.render(write_still=True)

# Turntable loop (uses the file's own animation range)
scene.render.film_transparent = False
scene.render.resolution_x = 1280
scene.render.resolution_y = 720
scene.render.image_settings.file_format = "FFMPEG"
scene.render.ffmpeg.format = "MPEG4"
scene.render.ffmpeg.codec = "H264"
scene.render.ffmpeg.constant_rate_factor = "MEDIUM"
scene.render.filepath = str(out / "sv-logo-turntable.mp4")
bpy.ops.render.render(animation=True)
print("done ->", out)
