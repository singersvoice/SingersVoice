#!/usr/bin/env bash
# Convert the streaming/publishing backgrounds (SVOld assets/Backgrounds) into
# web-sized WebP + thumbnails and write apps/web/public/backgrounds/index.json.
#
#   tools/backgrounds/convert.sh <source dir> <apps/web/public/backgrounds>
#
# Needs ImageMagick (convert/identify) and ffmpeg. Video backgrounds are
# re-encoded to 720p H.264 (mp4) with a JPEG poster.
set -euo pipefail
src="${1:?source dir}"
out="${2:?output dir}"
mkdir -p "$out/thumbs"
entries=()
shopt -s nullglob
for f in "$src"/*.jpg "$src"/*.jpeg "$src"/*.png "$src"/*.webp; do
  name="$(basename "${f%.*}")"
  id="$(echo "$name" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g')"
  convert "$f" -auto-orient -resize '1920x1080>' -strip -quality 80 "$out/$id.webp"
  convert "$f" -auto-orient -resize '320x180^' -gravity center -extent 320x180 -strip -quality 70 "$out/thumbs/$id.webp"
  dims="$(identify -format '%w %h' "$out/$id.webp")"
  w="${dims% *}"; h="${dims#* }"
  entries+=("{\"id\":\"$id\",\"kind\":\"image\",\"src\":\"$id.webp\",\"thumb\":\"thumbs/$id.webp\",\"width\":$w,\"height\":$h,\"label\":\"$name\"}")
done
for f in "$src"/*.mp4 "$src"/*.webm "$src"/*.mov; do
  name="$(basename "${f%.*}")"
  id="$(echo "$name" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g')"
  ffmpeg -y -v error -i "$f" -an -vf "scale='min(1280,iw)':-2" -c:v libx264 -preset slow -crf 26 -pix_fmt yuv420p -movflags +faststart "$out/$id.mp4"
  ffmpeg -y -v error -i "$f" -frames:v 1 -vf "scale=320:180:force_original_aspect_ratio=increase,crop=320:180" "$out/thumbs/$id.jpg"
  ffmpeg -y -v error -i "$f" -frames:v 1 -vf "scale='min(1280,iw)':-2" "$out/$id.poster.jpg"
  entries+=("{\"id\":\"$id\",\"kind\":\"video\",\"src\":\"$id.mp4\",\"poster\":\"$id.poster.jpg\",\"thumb\":\"thumbs/$id.jpg\",\"label\":\"$name\"}")
done
{
  echo '{"schema":"singersvoice.backgrounds.v1","items":['
  (IFS=,; echo "${entries[*]}")
  echo ']}'
} | python3 -c 'import json,sys; d=json.load(sys.stdin); d["items"].sort(key=lambda i:(len(i["id"]),i["id"])); print(json.dumps(d,indent=1))' > "$out/index.json"
echo "wrote $(( ${#entries[@]} )) backgrounds to $out"
