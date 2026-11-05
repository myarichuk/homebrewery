"""
PLANAR INK  ·  marginalia extractor

Lifts the ink line-work (corner brackets, crest, skulls, sigil, splatter) off
the AI mockup pages and composites it onto transparent, page-sized layers that
build.mjs inlines into planar-ink.css.

    python3 brew-styles/planar-ink/extract_marginalia.py <mockup1.jpg> <mockup2.jpg>

mockup1 = "A Brief History of the Blood War"  (1342 x 2000)
mockup2 = "The Great Wheel"                   (1342 x 2000)

How the ink is separated from the paper
---------------------------------------
The parchment is not a flat colour (stains, burnt edges), so a global
threshold either eats the faint hairlines or keeps the stains. Instead we
estimate the *local* paper brightness with a max-filter (ink is dark and thin,
so a max over a 21px window sees only paper) followed by a blur, then measure
how much darker each pixel is than the paper around it:

    darkness = (paper - L) / paper            0 = paper, 1 = black
    alpha    = smoothstep(LO, HI, darkness)

LO is set above the grey watercolour washes and faded body text, HI below the
line-work, so washes vanish and ink keeps its anti-aliasing. Colour is
discarded: every pixel becomes the same iron-gall ink, alpha carries the tone.

Text, title lettering and artwork that sit inside a crop are removed with
explicit erase rectangles (source-pixel coordinates), listed per element.

Output (relative to this file):
    art/frame.webp        corner brackets + crest
    art/marginalia.webp   skulls, dagger sigil, splatter
Both are drawn at OUT_SCALE x page size (816 x 1056 CSS px) for crisp print.
"""

import os
import sys

import numpy as np
from PIL import Image, ImageFilter

HERE      = os.path.dirname(os.path.abspath(__file__))
PAGE_W    = 816
PAGE_H    = 1056
OUT_SCALE = 1.5                     # 1224 x 1584 output: ~ source resolution
INK_RGB   = (29, 23, 18)            # #1d1712, same as --pi-ink
LO, HI    = 0.30, 0.62              # darkness ramp, see module docstring

# ----------------------------------------------------------------------------
# element table
#   src     : 'A' (mockup1) or 'B' (mockup2)
#   crop    : (x0, y0, x1, y1) in source pixels
#   erase   : rectangles (source pixels) to clear inside the crop
#   at      : (x, y) top-left placement on the page, CSS px
#   scale   : source px -> CSS px
#   anchor  : 'tl' default; 'tr' / 'bl' / 'br' make `at` that corner instead
# ----------------------------------------------------------------------------
S = 0.56

FRAME = [
	# top-left bracket (skulls & crescent removed; they are placed separately)
	dict(src='B', crop=(40, 35, 345, 525), at=(22, 20), scale=S,
	     erase=[(118, 232, 248, 448), (238, 168, 345, 525), (84, 452, 192, 525), (100, 352, 132, 452)]),
	# top-right bracket with its compass rose and pentacle
	dict(src='B', crop=(895, 35, 1305, 520), at=(796, 20), anchor='tr', scale=S,
	     erase=[(895, 35, 962, 150), (895, 148, 1112, 318), (895, 318, 1132, 520), (1140, 462, 1272, 520)]),
	# crest across the top edge
	dict(src='B', crop=(395, 52, 950, 178), at=(408, 16), anchor='tc', scale=S,
	     erase=[(395, 52, 442, 92), (905, 52, 950, 92), (850, 140, 950, 178)]),
	# bottom-left bracket (mockup1 has clean bottom corners)
	dict(src='A', crop=(45, 1610, 480, 1965), at=(22, 1036), anchor='bl', scale=S,
	     erase=[(238, 1550, 480, 1818), (165, 1610, 240, 1800)]),
	# bottom-right bracket
	dict(src='A', crop=(860, 1610, 1300, 1965), at=(796, 1036), anchor='br', scale=S,
	     erase=[(860, 1610, 1186, 1864), (860, 1864, 884, 1940)]),
]

MARGINALIA = [
	dict(src='B', crop=(118, 232, 248, 448), at=(44, 132), scale=0.46,               # skulls
	     erase=[(226, 372, 248, 448)]),
	dict(src='A', crop=(72, 1262, 178, 1498), at=(46, 600), scale=0.5, erase=[]),     # horned dagger sigil
	dict(src='A', crop=(104, 1500, 244, 1640), at=(30, 486), scale=0.48, erase=[]),   # splatter (left)
	dict(src='A', crop=(1186, 1560, 1262, 1720), at=(736, 690), scale=0.5,
	     erase=[(1234, 1560, 1262, 1720)]), # splatter (right)
]


def ink_layer(rgb: Image.Image, erase=(), origin=(0, 0)) -> Image.Image:
	"""RGB crop -> RGBA with constant ink colour and darkness-derived alpha.
	`erase` rectangles are in source pixels; `origin` is the crop's top-left."""
	lum   = rgb.convert('L')
	paper = lum.filter(ImageFilter.MaxFilter(21)).filter(ImageFilter.GaussianBlur(18))
	L = np.asarray(lum, dtype=np.float32)
	P = np.maximum(np.asarray(paper, dtype=np.float32), 1.0)
	d = np.clip((P - L) / P, 0.0, 1.0)
	t = np.clip((d - LO) / (HI - LO), 0.0, 1.0)
	a = t * t * (3 - 2 * t)                              # smoothstep
	ox, oy = origin
	for ex0, ey0, ex1, ey1 in erase:
		a[max(ey0 - oy, 0):max(ey1 - oy, 0), max(ex0 - ox, 0):max(ex1 - ox, 0)] = 0
	out = np.zeros((*a.shape, 4), dtype=np.uint8)
	out[..., 0:3] = INK_RGB
	out[..., 3]   = (a * 255 + 0.5).astype(np.uint8)
	return Image.fromarray(out, 'RGBA')


def render_element(srcs, el) -> Image.Image:
	x0, y0, x1, y1 = el['crop']
	layer = ink_layer(srcs[el['src']].crop((x0, y0, x1, y1)), el['erase'], (x0, y0))
	k = el['scale'] * OUT_SCALE
	return layer.resize((max(1, round(layer.width * k)), max(1, round(layer.height * k))), Image.LANCZOS)


def compose(srcs, elements) -> Image.Image:
	canvas = Image.new('RGBA', (round(PAGE_W * OUT_SCALE), round(PAGE_H * OUT_SCALE)), (0, 0, 0, 0))
	for el in elements:
		img = render_element(srcs, el)
		x, y = el['at'][0] * OUT_SCALE, el['at'][1] * OUT_SCALE
		anchor = el.get('anchor', 'tl')
		if anchor in ('tr', 'br'): x -= img.width
		if anchor == 'tc':         x -= img.width / 2
		if anchor in ('bl', 'br'): y -= img.height
		canvas.alpha_composite(img, (round(x), round(y)))
	return canvas


def main():
	if len(sys.argv) != 3:
		sys.exit(__doc__)
	srcs = {'A': Image.open(sys.argv[1]).convert('RGB'), 'B': Image.open(sys.argv[2]).convert('RGB')}
	for img in srcs.values():
		if img.size != (1342, 2000):
			sys.exit(f'expected 1342x2000 mockups, got {img.size}: crop table would be wrong')
	os.makedirs(os.path.join(HERE, 'art'), exist_ok=True)
	for name, elements in (('frame', FRAME), ('marginalia', MARGINALIA)):
		path = os.path.join(HERE, 'art', f'{name}.webp')
		compose(srcs, elements).save(path, 'WEBP', lossless=True, quality=100, method=6)
		print(f'wrote {os.path.relpath(path)}  ({os.path.getsize(path) / 1024:.1f} KiB)')


if __name__ == '__main__':
	main()
