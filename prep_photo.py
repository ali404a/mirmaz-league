#!/usr/bin/env python3
"""
Teacher photo pipeline: raw JPEG -> transparent, face-framed card PNG.

    python3 tools/prep_photo.py in.jpg "عمار فاضل" [outdir]
    python3 tools/prep_photo.py --batch raw/ out/     # whole folder

Why each step exists:

1. Downscale to 1600px before segmentation. u2net is O(pixels) and a
   4500x4500 source takes ~90s vs ~20s, for output we then shrink anyway.

2. u2net_human_seg, not plain u2net. The generic model treats a hoodie as
   background clutter and eats shoulders; the human model keeps them.

3. Haar face detection, not "assume the head is at the top". Teachers
   submit photos framed differently — one at chest height, one full body.
   Aligning on the detected face is what makes 57 cards look like a set
   instead of 57 unrelated snapshots.

4. Face is placed at FACE_Y (38% down) and sized to FACE_RATIO of the card
   height. Every card then has eyes on the same line — the thing that makes
   FIFA/FC packs read as a product rather than a scrapbook.

Output: OUT_W x OUT_H RGBA PNG, subject bottom-cropped so it bleeds off the
card edge like the reference art.
"""

import sys, os, re, unicodedata
from pathlib import Path

import numpy as np
import cv2
from PIL import Image
from rembg import remove, new_session

# ── card geometry ──────────────────────────────────────
OUT_W, OUT_H = 900, 1200      # 3:4, matches the card art box
FACE_Y       = 0.38           # where the face centre lands, top->bottom
FACE_RATIO   = 0.30           # face height as a fraction of card height
SEG_MAX      = 1600           # segmentation working size
WEB_W, WEB_H = 300, 400       # web copy — the card never renders larger

_session = None
def session():
    global _session
    if _session is None:
        _session = new_session('u2net_human_seg')
    return _session


def already_cut(im: Image.Image) -> bool:
    """True if the image ships its own usable alpha channel.

    Re-segmenting an already-cut PNG is ~20s of GPU time for a worse result:
    u2net re-guesses edges the designer already resolved by hand. We only
    accept the existing alpha if a real chunk of it is transparent — a fully
    opaque RGBA is just an RGB wearing a costume.
    """
    if im.mode not in ('RGBA', 'LA'):
        return False
    a = np.array(im.convert('RGBA'))[:, :, 3]
    return (a < 16).mean() > 0.08


def cutout(path: Path) -> Image.Image:
    """Return an RGBA cut-out, segmenting only if the file lacks alpha."""
    src = Image.open(path)
    if already_cut(src):
        im = src.convert('RGBA')
        if max(im.size) > SEG_MAX:
            im.thumbnail((SEG_MAX, SEG_MAX), Image.LANCZOS)
        print('    (already transparent — skipping segmentation)')
        return im

    im = src.convert('RGB')
    if max(im.size) > SEG_MAX:
        im.thumbnail((SEG_MAX, SEG_MAX), Image.LANCZOS)
    return remove(
        im, session=session(), alpha_matting=True,
        alpha_matting_foreground_threshold=250,
        alpha_matting_background_threshold=15,
        alpha_matting_erode_size=8,
    )


def find_face(im: Image.Image):
    """(x, y, w, h) of the largest face, or None."""
    gray = cv2.cvtColor(np.array(im.convert('RGB')), cv2.COLOR_RGB2GRAY)
    haar = cv2.data.haarcascades
    for xml, scale, neigh in [
        ('haarcascade_frontalface_default.xml', 1.1, 5),
        ('haarcascade_frontalface_alt2.xml',    1.05, 4),
        ('haarcascade_profileface.xml',         1.1, 4),
    ]:
        faces = cv2.CascadeClassifier(haar + xml).detectMultiScale(
            gray, scale, neigh, minSize=(60, 60))
        if len(faces):
            return max(faces, key=lambda f: f[2] * f[3])
    return None


def subject_bbox(im: Image.Image):
    a = np.array(im)[:, :, 3]
    ys, xs = np.where(a > 25)
    if not len(xs):
        raise ValueError('cutout is empty — segmentation failed')
    return xs.min(), ys.min(), xs.max(), ys.max()


def frame(im: Image.Image) -> Image.Image:
    """Scale + position so the face lands on the card's alignment line."""
    face = find_face(im)

    if face is not None:
        fx, fy, fw, fh = face
        face_cx, face_cy = fx + fw / 2, fy + fh / 2
        scale = (OUT_H * FACE_RATIO) / fh
    else:
        # No face — fall back to fitting the whole subject. Warn loudly:
        # this card will not align with the rest and needs a human look.
        print('    ! no face detected — falling back to subject bbox')
        x0, y0, x1, y1 = subject_bbox(im)
        face_cx, face_cy = (x0 + x1) / 2, y0 + (y1 - y0) * 0.18
        scale = (OUT_H * 0.75) / (y1 - y0)

    new_size = (max(1, int(im.width * scale)), max(1, int(im.height * scale)))
    scaled = im.resize(new_size, Image.LANCZOS)

    canvas = Image.new('RGBA', (OUT_W, OUT_H), (0, 0, 0, 0))
    canvas.paste(
        scaled,
        (int(OUT_W / 2 - face_cx * scale), int(OUT_H * FACE_Y - face_cy * scale)),
        scaled,
    )
    return canvas


def fold_arabic(s: str) -> str:
    """Fold Arabic orthographic variants so names match across sources.

    Photographers type 'احمد' where the roster says 'أحمد', and 'ال منصور'
    where the roster says 'آل منصور'. Both are correct Arabic; only the
    hamza carrier differs. Without folding, 19 of 20 photos silently fail
    to bind to their teacher.
    """
    s = unicodedata.normalize('NFC', s).strip()
    for a, b in [('أ','ا'), ('إ','ا'), ('آ','ا'), ('ى','ي'),
                 ('ة','ه'), ('ؤ','و'), ('ئ','ي')]:
        s = s.replace(a, b)
    return re.sub(r'\s+', ' ', s)


def slug(name: str) -> str:
    """Filename-safe, Arabic preserved. NFC so macOS/Linux agree."""
    s = unicodedata.normalize('NFC', name).strip()
    for ch in '/\\:*?"<>| ':
        s = s.replace(ch, '_')
    return s


def process(src: Path, name: str, outdir: Path) -> Path:
    print(f'  {name}')
    cut = cutout(src)
    card = frame(cut)
    outdir.mkdir(parents=True, exist_ok=True)

    # Master PNG at full size — the archival copy, re-encode from this.
    dst = outdir / f'{slug(name)}.png'
    card.save(dst, optimize=True)

    # Web copy: WebP at card resolution. These are photographs sitting behind
    # a 260px card, so lossless colour buys nothing visible at ~10x the bytes.
    # alpha_quality stays high or the cut edge around hair crumbles.
    web = card.copy()
    web.thumbnail((WEB_W, WEB_H), Image.LANCZOS)
    web.save(outdir / f'{slug(name)}.webp', 'WEBP',
             quality=72, method=6, alpha_quality=90)

    a = np.array(card)[:, :, 3]
    wsz = (outdir / f'{slug(name)}.webp').stat().st_size
    print(f'    -> {dst.name}  {card.size[0]}x{card.size[1]}  '
          f'{100 * (a > 0).mean():.0f}% covered  '
          f'png {dst.stat().st_size // 1024}KB / webp {wsz // 1024}KB')
    return dst


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(1)

    if args[0] == '--batch':
        raw, out = Path(args[1]), Path(args[2] if len(args) > 2 else 'out')
        files = sorted(p for p in raw.iterdir()
                       if p.suffix.lower() in {'.jpg', '.jpeg', '.png', '.webp'})
        print(f'{len(files)} photos -> {out}')
        for p in files:
            try:
                process(p, p.stem, out)
            except Exception as e:
                print(f'    FAILED {p.name}: {e}')
        return

    src = Path(args[0])
    name = args[1] if len(args) > 1 else src.stem
    out = Path(args[2] if len(args) > 2 else 'out')
    process(src, name, out)


if __name__ == '__main__':
    main()
