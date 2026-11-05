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

Line work is then *traced* (potrace, see inktrace.py) at the sheet's full
resolution and written as SVG paths, so corners and sigils stay as sharp as
the text at any zoom and in print. A bitmap layer at page size would have
to be ~2550 px wide to hold up at 300 dpi; the vectors are smaller.

Outputs (relative to this file):
    art/frame.svg         four corner brackets + crest, 816 x 1056 viewBox
    art/m-*.svg           skulls, dagger, compass, orrery, splatters: one
                          file each, placed (and varied per page) by CSS
    art/blot.webp         grey ink wash behind drop caps (stays a bitmap:
                          it is all soft tone, nothing to trace)
"""

import os
import sys

import numpy as np
from PIL import Image, ImageFilter, ImageOps

from inktrace import trace, svg_path

HERE      = os.path.dirname(os.path.abspath(__file__))
PAGE_W    = 816
PAGE_H    = 1056
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

# Marginalia are emitted one file per drawing (art/m-<name>.svg, sized in
# CSS px at `scale`), and placed by rules.css, which varies their position
# and size from page to page. Splatters can be reused many times.
PIECES = {
	'skull'    : dict(crop=(38, 786, 148, 898),    scale=0.5),
	'skull-sm' : dict(crop=(292, 782, 372, 872),   scale=0.4),
	'dagger'   : dict(crop=(462, 1072, 548, 1292), scale=0.5),
	'compass'  : dict(crop=(290, 1358, 518, 1600), scale=0.3),
	'orrery'   : dict(crop=(922, 1062, 1065, 1292), scale=0.34),
	'splat-a'  : dict(crop=(395, 1628, 538, 1802), scale=0.32),
	'splat-b'  : dict(crop=(588, 1618, 748, 1792), scale=0.3),
	'splat-c'  : dict(crop=(205, 1808, 368, 1968), scale=0.26),
}

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


def vector(sheet, elements) -> str:
	"""Trace every element at sheet resolution and place it on the page."""
	paths = []
	for el in elements:
		x0, y0, x1, y1 = el['crop']
		alpha = np.asarray(separate(sheet.crop(el['crop'])))[..., 3]
		rec = trace(alpha >= 128, turdsize=4, alphamax=1.0, opttolerance=0.3)
		k, w, h = el['scale'], (x1 - x0) * el['scale'], (y1 - y0) * el['scale']
		x, y = el['at']
		anchor = el.get('anchor', 'tl')
		if anchor in ('tr', 'br'): x -= w
		if anchor == 'tc':         x -= w / 2
		if anchor in ('bl', 'br'): y -= h
		t = (-k, 0, 0, k, x + w, y) if el.get('mirror') else (k, 0, 0, k, x, y)
		paths.append(svg_path(rec, t, prec=1))
	return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{PAGE_W}" height="{PAGE_H}" '
	        f'viewBox="0 0 {PAGE_W} {PAGE_H}"><path fill="#{"%02x%02x%02x" % INK_RGB}" '
	        f'd="{"".join(paths)}"/></svg>\n')


def piece(sheet, el) -> str:
	"""One drawing as a standalone SVG, intrinsic size in CSS px."""
	x0, y0, x1, y1 = el['crop']
	k = el['scale']
	w, h = round((x1 - x0) * k, 1), round((y1 - y0) * k, 1)
	alpha = np.asarray(separate(sheet.crop(el['crop'])))[..., 3]
	d = svg_path(trace(alpha >= 128, turdsize=4, opttolerance=0.3), (k, 0, 0, k, 0, 0), prec=1)
	return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w:g}" height="{h:g}" viewBox="0 0 {w:g} {h:g}">'
	        f'<path fill="#{"%02x%02x%02x" % INK_RGB}" d="{d}"/></svg>\n')


def save_svg(text: str, name: str):
	path = os.path.join(HERE, 'art', name)
	with open(path, 'w') as fh:
		fh.write(text)
	print(f'wrote {os.path.relpath(path)}  ({os.path.getsize(path) / 1024:.1f} KiB)')


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
	save_svg(vector(sheet, FRAME), 'frame.svg')
	for name, el in PIECES.items():
		save_svg(piece(sheet, el), f'm-{name}.svg')
	save(separate(sheet.crop(BLOT), 'wash'), 'blot.webp')


if __name__ == '__main__':
	main()
