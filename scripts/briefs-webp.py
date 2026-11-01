"""Converts the static maps from Amazon Location (PNG) to WebP, with small thumbnails for the brief list.
Run after `npm run briefs -w pipeline` and `npm run sample-maps -w pipeline`."""
import glob, os
from PIL import Image

web = os.path.join(os.path.dirname(__file__), "..", "web", "public")
for folder in ("briefs", "samples"):
    for f in glob.glob(os.path.join(web, folder, "*.png")):
        im = Image.open(f).convert("RGB")
        im.save(f[:-4] + ".webp", "WEBP", quality=82, method=6)
        if folder == "briefs":
            im.thumbnail((360, 203))
            im.save(f[:-4] + ".thumb.webp", "WEBP", quality=78, method=6)
        os.remove(f)
