"""
PLANAR INK  ·  ornament extractor (blue-screen sheet)

Lifts the two-tone engraved ornaments (brown ink line, cream fill) off the
blue type-specimen sheet and saves them with real transparency:

    python3 brew-styles/planar-ink/extract_ornaments.py

    source/ornaments-blue.webp  1920 x 1280
      -> art/vine.webp        thorn-vine divider            {{rule}}
      -> art/plaque.webp      small thorned label plaque    {{kicker}}
      -> art/cartouche.webp   large thorn-and-leaf frame    {{cartouche}}

Keying
------
The backdrop is a saturated blue; the art is brown and cream, i.e. its blue
channel is never above its red channel. So "blueness" = b - max(r, g) is
large on the backdrop and <= 0 on the art:

    alpha = 1 - smoothstep(K0, K1, b - max(r, g))

Edge pixels are part blue. Undo the mix against the measured backdrop colour
(c = (obs - (1 - a) * bg) / a), then enforce r >= g >= b, which holds for
every brown and cream, so no blue or teal fringe survives on the parchment.

Ink only
--------
The output keeps the line work and drops the cream face (see to_ink): the
plaques and the cartouche are drawn on the page, not stuck onto it.

Plaque text
-----------
The plaques carry the specimen's labels. The cream face of a plaque is one
connected region; the lettering sits in holes of that region. Filling the
holes of the cream mask finds exactly the lettering (and nothing on the
frame), which is then painted with the face's own median colour.
"""

import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

HERE   = os.path.dirname(os.path.abspath(__file__))
SRC    = 'source/ornaments-blue.webp'
SIZE   = (1920, 1280)
K0, K1 = 10.0, 70.0
MUTE   = 0.3          # pull colours this far toward grey: the sheet's cream is
                      # much yellower than the parchment it will sit on
INK    = (29, 23, 18) # same ink as every other piece (extract_pieces.py)

#                 crop on the sheet          output scale  erase lettering
ORNAMENTS = {
	'vine'      : dict(crop=(372, 530, 1012, 576),  scale=0.5,  erase=False),
	'plaque'    : dict(crop=(46, 364, 334, 488),    scale=1.0,  erase=True),
	'cartouche' : dict(crop=(424, 32, 1512, 296),   scale=0.75, erase=True),
}


def key(rgb):
	"""RGB uint8 -> RGBA float, blue backdrop removed."""
	a = rgb.astype(np.float32)
	r, g, b = a[..., 0], a[..., 1], a[..., 2]
	blue = b - np.maximum(r, g)
	t = np.clip((blue - K0) / (K1 - K0), 0, 1)
	alpha = 1 - t * t * (3 - 2 * t)
	bg = np.median(a[t >= 1], axis=0) if (t >= 1).any() else np.array([10, 60, 180], np.float32)
	safe = np.maximum(alpha, 1e-3)[..., None]
	fg = (a - (1 - alpha[..., None]) * bg) / safe
	fg = np.clip(fg, 0, 255)
	fg[..., 1] = np.minimum(fg[..., 1], fg[..., 0])           # despill: brown and cream
	fg[..., 2] = np.minimum(fg[..., 2], fg[..., 1])           # always have r >= g >= b
	fg = fg + MUTE * (fg.mean(-1, keepdims=True) - fg)
	return np.dstack([fg, alpha * 255])


def erase_lettering(rgba):
	rgb = rgba[..., :3]
	lum = rgb.mean(-1)
	cream = (lum > 165) & (rgba[..., 3] > 250)
	lab, n = ndimage.label(cream)
	if n == 0:
		return rgba
	face = lab == (np.argmax(ndimage.sum(cream, lab, range(1, n + 1))) + 1)
	holes = ndimage.binary_fill_holes(face) & ~face
	holes = ndimage.binary_dilation(holes, iterations=4) & ndimage.binary_fill_holes(face)
	tone = np.median(rgb[face], axis=0)
	out = rgba.copy()
	out[holes, :3] = tone
	return out


def to_ink(rgba):
	"""Two-tone (brown line, cream face) -> ink only. The cream face was a
	separate flat surface on the page: a yellow sticker that never matched
	the mottled paper around it. Here the face's own tone becomes fully
	transparent and everything darker becomes ink, in proportion, so the
	page's paper shows through the frame like it does through every other
	drawing, and the engraved shading survives as translucent ink."""
	lum = rgba[..., :3].mean(-1)
	solid = rgba[..., 3] > 250
	face = np.percentile(lum[solid], 90) - 18            # the cream, less a knee so faint
	                                                     # residue of the erased lettering drops out
	dark = np.percentile(lum[solid], 3)                  # the deepest line
	t = np.clip((face - lum) / (face - dark), 0, 1)
	a = (rgba[..., 3] / 255) * t ** 0.85
	out = np.empty_like(rgba)
	out[..., :3] = INK
	out[..., 3] = a * 255
	return out


def main():
	im = Image.open(os.path.join(HERE, SRC)).convert('RGB')
	if im.size != SIZE:
		sys.exit(f'{SRC}: expected {SIZE}, got {im.size}; the crop table would be wrong')
	os.makedirs(os.path.join(HERE, 'art'), exist_ok=True)
	for name, o in ORNAMENTS.items():
		rgba = key(np.asarray(im.crop(o['crop'])))
		if o['erase']:
			rgba = erase_lettering(rgba)
		rgba = to_ink(rgba)
		out = Image.fromarray((rgba + 0.5).astype(np.uint8), 'RGBA')
		if o['scale'] != 1:
			out = out.resize((round(out.width * o['scale']), round(out.height * o['scale'])), Image.LANCZOS)
		path = os.path.join(HERE, 'art', f'{name}.webp')
		out.save(path, 'WEBP', quality=90, alpha_quality=70, method=6)   # colour is flat ink: the alpha is the image
		print(f'wrote {os.path.relpath(path)}  {out.size}  ({os.path.getsize(path) / 1024:.1f} KiB)')


if __name__ == '__main__':
	main()
