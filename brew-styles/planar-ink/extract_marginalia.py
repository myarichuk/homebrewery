"""
PLANAR INK  ·  marginalia extractor

Lifts ink line-work off an asset sheet (black ink on white: corners, crest,
skulls, sigils, splatter, washes) and composites it onto transparent layers
that build.mjs inlines into planar-ink.css.

    python3 brew-styles/planar-ink/extract_marginalia.py <asset-sheet.jpg>

The crop table below is written against the 1792 x 2400 asset sheet.

How the ink is separated from the paper
---------------------------------------
Estimate the *local* paper brightness with a max-filter (ink is dark and thin,
so a max over a 21px window sees only paper) followed by a blur, then measure
how much darker each pixel is than the paper around it:

    darkness = (paper - L) / paper            0 = paper, 1 = black

'ink' mode : alpha = smoothstep(LO, HI, darkness). Drops JPEG noise and the
             faintest grey, keeps hatching and anti-aliasing.
'wash' mode: alpha = darkness (linear). Keeps watercolour greys, for the
             drop-cap blot.

Colour is discarded: every pixel becomes the same iron-gall ink (#1d1712)
and alpha carries the tone, so the art multiplies naturally into the paper.

Outputs (relative to this file):
    art/frame.webp        four corner brackets + crest, page-sized
    art/marginalia.webp   skulls, sigils, compass, orrery, splatter, page-sized
    art/blot.webp         grey ink wash behind drop caps
Page-sized layers are drawn at OUT_SCALE x 816 x 1056 CSS px.
"""

import os
import sys

import numpy as np
from PIL import Image, ImageFilter, ImageOps

HERE      = os.path.dirname(os.path.abspath(__file__))
PAGE_W    = 816
PAGE_H    = 1056
OUT_SCALE = 1.5
INK_RGB   = (29, 23, 18)               # #1d1712, same as --pi-ink
LO, HI    = 0.10, 0.55
SHEET     = (1792, 2400)

# ----------------------------------------------------------------------------
# element table
#   crop    : (x0, y0, x1, y1) on the asset sheet
#   at      : placement on the page, CSS px, interpreted per `anchor`
#             tl (default) | tr | bl | br | tc
#   scale   : sheet px -> CSS px
#   mirror  : flip horizontally (right-hand corners reuse the left-hand art)
# ----------------------------------------------------------------------------
CORNER_TOP    = (30, 38, 358, 396)
CORNER_BOTTOM = (30, 398, 368, 728)
CS            = 0.62

FRAME = [
	dict(crop=CORNER_TOP,    at=(20, 18),    scale=CS),
	dict(crop=CORNER_TOP,    at=(796, 18),   scale=CS, anchor='tr', mirror=True),
	dict(crop=CORNER_BOTTOM, at=(20, 1038),  scale=CS, anchor='bl'),
	dict(crop=CORNER_BOTTOM, at=(796, 1038), scale=CS, anchor='br', mirror=True),
	dict(crop=(760, 352, 1282, 462), at=(408, 14), scale=0.6, anchor='tc'),      # crest
]

# Kept deliberately sparse: the margins frame the text, they don't compete with it.
MARGINALIA = [
	dict(crop=(38, 786, 148, 898),    at=(44, 250),  scale=0.5),                   # skull
	dict(crop=(292, 782, 372, 872),   at=(60, 312),  scale=0.4),                   # small skull
	dict(crop=(462, 1072, 548, 1292), at=(50, 600),  scale=0.5),                   # horned dagger
	dict(crop=(290, 1358, 518, 1600), at=(790, 250), scale=0.3,  anchor='tr'),     # compass rose
	dict(crop=(922, 1062, 1065, 1292), at=(786, 334), scale=0.34, anchor='tr'),    # orrery
	dict(crop=(395, 1628, 538, 1802), at=(28, 470),  scale=0.32),                  # splatter
	dict(crop=(588, 1618, 748, 1792), at=(800, 690), scale=0.3,  anchor='tr'),     # splatter
	dict(crop=(205, 1808, 368, 1968), at=(250, 992), scale=0.26),                  # splatter
]

BLOT = (772, 1812, 902, 1952)
BLOT_STRENGTH = 0.38                   # the sheet's wash is near-solid; a drop cap needs a light one


def separate(rgb: Image.Image, mode: str = 'ink') -> Image.Image:
	"""RGB crop -> RGBA in ink colour with darkness-derived alpha."""
	lum   = rgb.convert('L')
	paper = lum.filter(ImageFilter.MaxFilter(21)).filter(ImageFilter.GaussianBlur(18))
	L = np.asarray(lum, dtype=np.float32)
	P = np.maximum(np.asarray(paper, dtype=np.float32), 1.0)
	d = np.clip((P - L) / P, 0.0, 1.0)
	if mode == 'ink':
		t = np.clip((d - LO) / (HI - LO), 0.0, 1.0)
		a = t * t * (3 - 2 * t)
	else:
		a = np.clip((d - 0.03) / 0.97, 0.0, 1.0) * BLOT_STRENGTH
	out = np.zeros((*a.shape, 4), dtype=np.uint8)
	out[..., 0:3] = INK_RGB
	out[..., 3]   = (a * 255 + 0.5).astype(np.uint8)
	return Image.fromarray(out, 'RGBA')


def render(sheet, el) -> Image.Image:
	layer = separate(sheet.crop(el['crop']))
	if el.get('mirror'):
		layer = ImageOps.mirror(layer)
	k = el['scale'] * OUT_SCALE
	return layer.resize((max(1, round(layer.width * k)), max(1, round(layer.height * k))), Image.LANCZOS)


def compose(sheet, elements) -> Image.Image:
	canvas = Image.new('RGBA', (round(PAGE_W * OUT_SCALE), round(PAGE_H * OUT_SCALE)), (0, 0, 0, 0))
	for el in elements:
		img = render(sheet, el)
		x, y = el['at'][0] * OUT_SCALE, el['at'][1] * OUT_SCALE
		anchor = el.get('anchor', 'tl')
		if anchor in ('tr', 'br'): x -= img.width
		if anchor == 'tc':         x -= img.width / 2
		if anchor in ('bl', 'br'): y -= img.height
		canvas.alpha_composite(img, (round(x), round(y)))
	return canvas


def save(img: Image.Image, name: str):
	path = os.path.join(HERE, 'art', name)
	img.save(path, 'WEBP', lossless=True, quality=100, method=6)
	print(f'wrote {os.path.relpath(path)}  ({os.path.getsize(path) / 1024:.1f} KiB)')


def main():
	if len(sys.argv) != 2:
		sys.exit(__doc__)
	sheet = Image.open(sys.argv[1]).convert('RGB')
	if sheet.size != SHEET:
		sys.exit(f'expected a {SHEET[0]}x{SHEET[1]} asset sheet, got {sheet.size}: the crop table would be wrong')
	os.makedirs(os.path.join(HERE, 'art'), exist_ok=True)
	save(compose(sheet, FRAME), 'frame.webp')
	save(compose(sheet, MARGINALIA), 'marginalia.webp')
	save(separate(sheet.crop(BLOT), 'wash'), 'blot.webp')


if __name__ == '__main__':
	main()
