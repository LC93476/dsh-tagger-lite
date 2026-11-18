"""Generate pose thumbnails for the DSh tagger picker.

Reads <node>/img/<poseId>.png and writes <dataDir>/pose-thumbs/<poseId>.jpg (width 220).
Run:  python make-pose-thumbs.py <nodeImgDir> <thumbDir>
"""
import os, sys
from PIL import Image

def main(src, dst, width=220, quality=80):
    os.makedirs(dst, exist_ok=True)
    names = sorted(n for n in os.listdir(src) if n.lower().endswith(".png"))
    made = skipped = failed = 0
    for name in names:
        stem = os.path.splitext(name)[0]
        out = os.path.join(dst, stem + ".jpg")
        if os.path.exists(out) and os.path.getmtime(out) >= os.path.getmtime(os.path.join(src, name)):
            skipped += 1
            continue
        try:
            with Image.open(os.path.join(src, name)) as im:
                im = im.convert("RGB")
                w, h = im.size
                if w > width:
                    im = im.resize((width, max(1, round(h * width / w))), Image.LANCZOS)
                im.save(out, "JPEG", quality=quality, optimize=True)
            made += 1
        except Exception as exc:
            failed += 1
            print("fail", name, exc)
    print("thumbs made=%d skipped=%d failed=%d total=%d" % (made, skipped, failed, len(names)))

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        raise SystemExit(2)
    main(sys.argv[1], sys.argv[2])