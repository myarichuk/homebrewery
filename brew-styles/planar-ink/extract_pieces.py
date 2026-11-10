"""
PLANAR INK  ·  piece extractor for the second-generation sheets

    python3 brew-styles/planar-ink/extract_pieces.py

    source/marginalia-2.jpg   1493 x 2000   corners, marginalia, splatter,
                                            washes, dividers
    source/headers.jpg        2000 x 1493   page-top crests and the spiked
                                            title banner
    source/asset-sheet.jpg    1792 x 2400   the two rows of planetary signs
                                            and runes (the margin glyphs of
                                            the reference pages)

Every piece is written as one bitmap, art/p-<name>.webp, at RES x its CSS
size (2.5x = 240 dpi on a printed letter page), alpha carrying the ink tone.
These drawings are dense cross-hatching: traced to vectors they come out
at 10-30x the bytes of a 2.5x WebP that looks the same and also keeps the
grey washes. Each corner set is an SVG that embeds its drawing once and
<use>s it mirrored into the other corners, so a set costs one bitmap.

art/pieces.json records each piece's CSS size and role; build.mjs reads it
to emit the custom properties and the per-page marginalia layouts.

Ink separation
--------------
These sheets are clean white, but some ink shapes (splats, blots) are far
bigger than any local window, so the paper level is taken globally (99th
percentile of the crop) rather than with a moving max-filter:

    darkness = (paper - L) / paper
    alpha    = smoothstep(0.06, 0.8, darkness) * strength
"""

import base64
import io
import json
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

HERE    = os.path.dirname(os.path.abspath(__file__))
INK     = (29, 23, 18)
PAGE_W  = 816
PAGE_H  = 1056
RES     = 2.5          # 240 dpi on the printed page: past what ink-on-paper texture needs
SHEETS  = {
	'm' : ('source/marginalia-2.jpg', (1493, 2000)),
	'h' : ('source/headers.jpg', (2000, 1493)),
	'w' : ('source/wreath.webp', (1500, 1000)),           # transparent, magenta-keyed shading
	'o' : ('source/corners-occult.webp', (1500, 1000)),   # transparent, magenta-keyed shading
	'a' : ('source/asset-sheet.jpg', (1792, 2400)),       # the first sheet: rune rows, shields, books, bones, portals
	'k' : ('source/marginalia-pack.jpg', (1342, 2000)),   # the labelled pack, drawn on parchment (see LOCAL_PAPER)
}
# Sheets drawn on tinted, stained paper: the paper level is estimated
# locally (max-filter + blur) and the ink threshold raised, or the stains
# come along as a grey haze around every piece.
LOCAL_PAPER = {'k'}

# name: (sheet, crop, css width, role, options)
#   role  marg   marginalia drawing, placed by the per-page layouts
#         hang   marginalia that hangs from the top of a margin (pendants)
#         glyph  planetary sign or rune: the glyph columns down the margins
#         splat  ink splatter, placed (and resized) per page
#         pool   grey wash blot, tone only
#         crest  page-top ornament
#         rule   divider for {{rule}}
#         plate  title banner
# options
#   foot      flat enough for the bottom margin too (build.mjs: bottom row)
#   lite      False: left out of planar-ink-lite.css
#   strength  ink opacity (washes)
#   clear     sheet-space rectangles to blank (neighbouring drawings)
X = {'lite': False}
F = {'lite': False, 'foot': True}
PIECES = {
	# ------------------------------------------------------------ marginalia
	'compass2'   : ('m', (50, 795, 412, 1162),   74, 'marg'),
	'fairy'      : ('m', (415, 808, 655, 1092),  66, 'marg'),
	'mimic'      : ('m', (580, 1000, 772, 1132), 60, 'marg'),
	'skull-a'    : ('m', (35, 1180, 186, 1352),  52, 'marg'),
	'skull-b'    : ('m', (38, 1364, 172, 1526),  44, 'marg'),
	'ram'        : ('m', (200, 1185, 402, 1372), 62, 'marg'),
	'bull'       : ('m', (420, 1180, 612, 1386), 62, 'marg'),
	'bird-a'     : ('m', (196, 1388, 370, 1528), 54, 'marg'),
	'bird-b'     : ('m', (396, 1380, 630, 1522), 66, 'marg'),
	'banner-a'   : ('m', (644, 1188, 792, 1516), 44, 'marg'),
	'banner-b'   : ('m', (808, 1178, 972, 1528), 46, 'marg'),
	'pend-skull' : ('m', (815, 812, 1002, 1137), 54, 'hang'),
	'pend-moon'  : ('m', (1024, 812, 1206, 1178), 50, 'hang'),
	'pend-hex'   : ('m', (1192, 812, 1332, 1212), 42, 'hang'),
	'pend-star'  : ('m', (1342, 812, 1462, 1218), 36, 'hang'),
	# ---- the labelled pack: grotesque iconography, skulls and charms, occult
	'hand-a'     : ('k', (258, 1428, 377, 1597),  50, 'marg', X),
	'hand-b'     : ('k', (521, 1432, 641, 1596),  50, 'marg', X),
	'eye-wing'   : ('k', (392, 1430, 514, 1581),  52, 'marg', X),
	'eye-wings'  : ('k', (243, 1574, 492, 1700),  84, 'marg', F),
	'crown-a'    : ('k', (485, 1592, 645, 1717),  56, 'marg', F),
	'crown-b'    : ('k', (262, 1700, 453, 1830),  62, 'marg', F),
	'crown-c'    : ('k', (462, 1719, 663, 1829),  66, 'marg', F),
	'sword'      : ('k', (136, 1596, 253, 1867),  40, 'marg', X),
	'skull-horn' : ('k', (876, 1078, 1060, 1294), 62, 'marg', X),
	'skull-c'    : ('k', (726, 1151, 864, 1290),  50, 'marg', X),
	'skull-d'    : ('k', (1067, 1153, 1181, 1291), 44, 'marg', X),
	'bone'       : ('k', (985, 879, 1041, 1056),  17, 'marg', X),
	'vial'       : ('k', (1116, 1058, 1180, 1155), 24, 'marg', X),
	'moons'      : ('k', (352, 910, 446, 1256),   28, 'marg', X),
	'arrow-a'    : ('k', (467, 907, 530, 1260),   20, 'marg', X),
	'arrow-b'    : ('k', (548, 907, 602, 1075),   18, 'marg', X),
	'arrow-c'    : ('k', (552, 1129, 601, 1263),  17, 'marg', X),
	'arrow-h'    : ('k', (329, 1272, 614, 1335), 100, 'marg', F),
	'script'     : ('k', (615, 909, 664, 1344),   17, 'marg', X),
	'staff'      : ('k', (93, 446, 166, 670),     23, 'marg', X),
	'circle-a'   : ('k', (704, 172, 916, 389),    64, 'marg', X),
	'circle-b'   : ('k', (872, 266, 1126, 527),   70, 'marg', X),
	'circle-c'   : ('k', (708, 393, 886, 570),    58, 'marg', X),
	'rose-a'     : ('k', (702, 573, 894, 766),    58, 'marg', X),
	'rose-b'     : ('k', (913, 586, 1081, 756),   52, 'marg', X),
	'sigil-a'    : ('k', (868, 508, 959, 640),    32, 'marg', X),
	'pend-owl'   : ('k', (1042, 880, 1118, 1136), 30, 'hang', X),
	'pend-shield': ('k', (1098, 880, 1185, 1056), 34, 'hang', X),
	# ---- first sheet: heraldry, books, bones, portals
	'shield-a'   : ('a', (18, 1069, 215, 1319),   52, 'marg', X),
	'shield-b'   : ('a', (221, 1059, 421, 1317),  52, 'marg', X),
	'beetle'     : ('a', (725, 1068, 917, 1311),  50, 'marg', X),
	'book-a'     : ('a', (1624, 1641, 1757, 1790), 42, 'marg', X),
	'book-b'     : ('a', (1495, 1647, 1613, 1787), 38, 'marg', X),
	'book-c'     : ('a', (1484, 1785, 1636, 1927), 46, 'marg', X),
	'book-open'  : ('a', (1623, 1812, 1778, 1904), 52, 'marg', F),
	'stars-c'    : ('a', (1480, 1926, 1644, 2055), 50, 'marg', X),
	'burst-a'    : ('a', (1080, 1638, 1248, 1820), 44, 'marg', X),
	'burst-b'    : ('a', (919, 1643, 1079, 1813),  40, 'marg', X),
	'star-ring'  : ('a', (1254, 1870, 1465, 2103), 56, 'marg', X),
	'sun'        : ('a', (1273, 2125, 1463, 2363), 48, 'marg', X),
	'portal-a'   : ('a', (430, 2165, 687, 2369),  56, 'marg', X),
	'portal-b'   : ('a', (705, 2165, 976, 2372),  58, 'marg', X),
	'portal-c'   : ('a', (1005, 2165, 1268, 2369), 56, 'marg', X),
	'ribs'       : ('a', (957, 782, 1215, 882),   90, 'marg', F),
	'bones-v'    : ('a', (1027, 863, 1249, 974),  70, 'marg', F),
	'antler'     : ('a', (1264, 878, 1505, 1005), 76, 'marg', F),
	'bonecrest'  : ('a', (1253, 786, 1775, 892), 112, 'marg', F),
	'runes-a'    : ('a', (1498, 2076, 1626, 2138), 56, 'marg', F),
	'runes-b'    : ('a', (1650, 2060, 1761, 2150), 48, 'marg', F),
	'pend-disc'  : ('a', (1104, 1022, 1249, 1340), 40, 'hang', X),
	'pend-keys'  : ('a', (1269, 1042, 1405, 1340), 40, 'hang', X),
	# ---------------------------------------------------------- margin glyphs
	# sun, pluto, mars, sigil, six runes / mercury, saturn, pisces, knot, tally, four runes
	'g1' : ('a', (786, 1369, 895, 1475), 39, 'glyph'),
	'g2' : ('a', (907, 1363, 996, 1480), 32, 'glyph'),
	'g3' : ('a', (1013, 1366, 1115, 1475), 37, 'glyph'),
	'g4' : ('a', (1136, 1362, 1215, 1478), 28, 'glyph'),
	'g5' : ('a', (1240, 1367, 1312, 1476), 26, 'glyph'),
	'g6' : ('a', (1337, 1367, 1406, 1476), 25, 'glyph'),
	'g7' : ('a', (1422, 1366, 1495, 1473), 26, 'glyph'),
	'g8' : ('a', (1518, 1367, 1582, 1476), 23, 'glyph'),
	'g9' : ('a', (1601, 1367, 1675, 1475), 27, 'glyph'),
	'g10' : ('a', (1692, 1360, 1766, 1475), 27, 'glyph'),
	'g11' : ('a', (800, 1478, 881, 1603), 29, 'glyph'),
	'g12' : ('a', (913, 1484, 992, 1594), 28, 'glyph'),
	'g13' : ('a', (1015, 1489, 1113, 1589), 35, 'glyph'),
	'g14' : ('a', (1134, 1489, 1222, 1589), 32, 'glyph'),
	'g15' : ('a', (1239, 1483, 1307, 1591), 24, 'glyph'),
	'g16' : ('a', (1335, 1485, 1404, 1594), 25, 'glyph'),
	'g17' : ('a', (1417, 1484, 1486, 1592), 25, 'glyph'),
	'g18' : ('a', (1510, 1486, 1588, 1589), 28, 'glyph'),
	'g19' : ('a', (1603, 1486, 1681, 1594), 28, 'glyph'),
	# the pack's rune columns and occult sigils
	'g20' : ('k', (187, 1080, 244, 1164), 22, 'glyph', X),
	'g21' : ('k', (190, 1234, 242, 1348), 21, 'glyph', X),
	'g22' : ('k', (263, 1093, 321, 1209), 23, 'glyph', X),
	'g23' : ('k', (269, 1268, 317, 1343), 20, 'glyph', X),
	'g24' : ('k', (527, 1072, 605, 1129), 30, 'glyph', X),
	'g25' : ('k', (1196, 1160, 1264, 1330), 22, 'glyph', X),
	'g26' : ('k', (78, 673, 165, 759),    30, 'glyph', X),
	'g27' : ('k', (97, 759, 171, 814),    27, 'glyph', X),
	'g28' : ('k', (89, 810, 165, 905),    26, 'glyph', X),
	'g29' : ('k', (187, 901, 246, 1080),  21, 'glyph', X),
	'g30' : ('k', (1018, 512, 1084, 606), 25, 'glyph', X),
	'g31' : ('k', (1088, 488, 1179, 616), 31, 'glyph', X),
	'g32' : ('k', (1091, 625, 1180, 742), 31, 'glyph', X),
	# ------------------------------------------------------------- splatter
	'sp1' : ('m', (28, 1550, 172, 1668),  44, 'splat'),
	'sp2' : ('m', (184, 1545, 322, 1668), 44, 'splat'),
	'sp3' : ('m', (322, 1552, 482, 1668), 44, 'splat'),
	'sp4' : ('m', (492, 1552, 612, 1668), 40, 'splat'),
	'sp5' : ('m', (616, 1540, 772, 1668), 46, 'splat'),
	'sp6' : ('m', (28, 1672, 172, 1822),  42, 'splat'),
	'sp7' : ('m', (186, 1690, 312, 1818), 40, 'splat'),
	'sp8' : ('m', (322, 1690, 472, 1818), 44, 'splat'),
	'sp9' : ('m', (492, 1680, 612, 1822), 38, 'splat'),
	'stars'  : ('m', (792, 1572, 1062, 1772), 70, 'splat'),
	'specks' : ('m', (1292, 1556, 1488, 1764), 60, 'splat'),
	# ------------------------------------------------------------ wash blots
	'pool1' : ('m', (638, 1680, 772, 1820), 70, 'pool', {'strength': .5}),
	'pool2' : ('m', (192, 1830, 332, 1966), 72, 'pool', {'strength': .5}),
	'pool3' : ('m', (492, 1834, 628, 1960), 70, 'pool', {'strength': .5}),
	'pool4' : ('m', (642, 1836, 772, 1958), 68, 'pool', {'strength': .5}),
	# --------------------------------------------------------------- dividers
	'rule-thorn'  : ('m', (18, 642, 1478, 795),   300, 'rule'),
	'rule-knot'   : ('m', (988, 1188, 1468, 1292), 300, 'rule'),
	'rule-barbed' : ('m', (988, 1292, 1462, 1372), 300, 'rule'),
	# ---------------------------------------------------------------- crests
	'crest-beetle'  : ('m', (688, 386, 1182, 600),   260, 'crest'),
	'crest-compass' : ('h', (150, 12, 1852, 498),    400, 'crest',
	                   {'clear': [(150, 418, 842, 498), (1158, 418, 1852, 498)]}),   # banner spikes below
	'crest-skull'   : ('h', (118, 778, 1872, 1102),  420, 'crest'),
	'crest-blades'  : ('h', (160, 1098, 1848, 1472), 400, 'crest'),
	# ------------------------------------------------------- wreath frame
	'wreath'        : ('w', (125, 38, 1372, 952),    380, 'plate', {'res': 2, 'fill': [(750, 495)]}),   # dense engraving: 2x keeps it under 100 KiB
}

# Corner sets: (sheet, crop, which corner the drawing is, css width).
# The other three corners are mirrored / flipped copies.
#   tl, tr, bl, br  : where the drawing sits as drawn
FRAMES = {
	'thorn'  : dict(top=('m', (0, 0, 312, 338), 'tl', 150), bottom=('m', (24, 348, 308, 612), 'bl', 140)),
	'gothic' : dict(top=('m', (328, 22, 588, 300), 'tl', 132), bottom=None),
	# four different corners, placed as drawn (no mirroring)
	'occult' : dict(res=2, corners={'tl': ('o', (60, 45, 615, 555), 196), 'tr': ('o', (978, 50, 1432, 520), 162),
	                         'bl': ('o', (70, 575, 525, 950), 160), 'br': ('o', (868, 540, 1425, 950), 196)}),
	# the sheet draws two nested brackets here (bones outside, a plain rune
	# bracket inside, the beetle crest inside that): keep only the outer one
	'bone'   : dict(top=('m', (812, 86, 1382, 606), 'tr', 200), bottom=None,
	                clear=[(812, 236, 1256, 606)]),
}
INSET = 18      # px from the page edge


def load(sheet):
	"""Sheet as greyscale ink-on-white. Transparent sheets are flattened onto
	white. Some generated sheets fill their hatching gaps with magenta (a
	keying colour the generator half-applied): that is paper, not ink, so
	strongly magenta pixels are pushed back to white."""
	path, size = SHEETS[sheet]
	im = Image.open(os.path.join(HERE, path))
	if im.size != size:
		sys.exit(f'{path}: expected {size}, got {im.size}; the crop tables would be wrong')
	if im.mode in ('RGBA', 'LA', 'P'):
		bg = Image.new('RGBA', im.size, (255, 255, 255, 255))
		bg.alpha_composite(im.convert('RGBA'))
		im = bg
	rgb = np.asarray(im.convert('RGB'), np.float32)
	r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
	L = rgb @ np.array([.299, .587, .114], np.float32)
	t = np.clip((np.minimum(r, b) - g - 40) / 60, 0, 1)
	L = L + (255 - L) * t
	return Image.fromarray(np.clip(L + 0.5, 0, 255).astype(np.uint8), 'L')


def darkness(img, crop, clear=(), local=False):
	"""clear: sheet-space rectangles inside the crop that belong to a
	neighbouring drawing and are blanked.
	local: tinted paper; take the paper level around each pixel and cut the
	faint end off, so stains and paper grain don't count as ink."""
	if local:
		pad = 40
		box = (max(0, crop[0] - pad), max(0, crop[1] - pad), min(img.width, crop[2] + pad), min(img.height, crop[3] + pad))
		L = np.asarray(img.crop(box), np.float32)
		P = np.maximum(ndimage.gaussian_filter(ndimage.maximum_filter(L, 41), 14), 1.0)
		d = np.clip((P - L) / P, 0, 1)
		d = d[crop[1] - box[1]:crop[3] - box[1], crop[0] - box[0]:crop[2] - box[0]]
		d = np.clip((d - .1) / .9, 0, 1)
	else:
		L = np.asarray(img.crop(crop), np.float32)
		P = max(np.percentile(L, 99), 1.0)
		d = np.clip((P - L) / P, 0, 1)
	for x0, y0, x1, y1 in clear:
		d[max(0, y0 - crop[1]):max(0, y1 - crop[1]), max(0, x0 - crop[0]):max(0, x1 - crop[0])] = 0
	return drop_intruders(d)


def drop_intruders(d):
	"""Sheets pack drawings tightly, so a crop box catches corners of its
	neighbours. Anything that is cut by the crop edge and is not part of the
	drawing itself (the largest connected shape, or one at least a third of
	its size) is a neighbour: blank it. Free-standing specks inside the box
	(splatter dots, stars) don't touch the edge and stay."""
	ink = ndimage.binary_dilation(d > 0.12, iterations=3)
	lab, n = ndimage.label(ink)
	if n < 2:
		return d
	sizes = ndimage.sum(ink, lab, range(1, n + 1))
	edge = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))) - {0}
	keep = sizes >= sizes.max() / 3
	drop = [i + 1 for i in range(n) if (i + 1) in edge and not keep[i]]
	if drop:
		d = np.where(np.isin(lab, drop), 0, d)
	return d


def smooth(d, lo, hi):
	t = np.clip((d - lo) / (hi - lo), 0, 1)
	return t * t * (3 - 2 * t)


PAPER = np.array([244, 233, 216], np.float32)


def raster(d, w, h, strength=1.0, res=RES, fill=None):
	"""fill: bool mask of enclosed areas to make opaque paper (a ribbon or
	plate face that text sits on, so nothing behind shows through)."""
	a = smooth(d, 0.06, 0.8) * strength
	rgba = np.zeros((*a.shape, 4), np.uint8)
	rgba[..., :3] = INK
	rgba[..., 3] = (a * 255 + 0.5).astype(np.uint8)
	if fill is not None and fill.any():
		ink = np.array(INK, np.float32)
		col = ink * a[..., None] + PAPER * (1 - a[..., None])
		rgba[fill, :3] = (col[fill] + 0.5).astype(np.uint8)
		rgba[fill, 3] = 255
	img = Image.fromarray(rgba, 'RGBA')
	return img.resize((max(1, round(w * res)), max(1, round(h * res))), Image.LANCZOS)


def webp_bytes(img):
	buf = io.BytesIO()
	img.save(buf, 'WEBP', quality=78, alpha_quality=70, method=6)
	return buf.getvalue()


def write(name, data):
	path = os.path.join(HERE, 'art', name)
	with open(path, 'wb' if isinstance(data, bytes) else 'w') as fh:
		fh.write(data)
	return os.path.getsize(path)


def main():
	os.makedirs(os.path.join(HERE, 'art'), exist_ok=True)
	sheets = {k: load(k) for k in SHEETS}
	manifest = {'pieces': {}, 'frames': {}}
	total = 0
	for name, spec in PIECES.items():
		sheet, crop, cw, role = spec[:4]
		opt = spec[4] if len(spec) > 4 else {}
		d = darkness(sheets[sheet], crop, opt.get('clear', ()), sheet in LOCAL_PAPER)
		k = cw / (crop[2] - crop[0])
		w, h = round(cw, 1), round((crop[3] - crop[1]) * k, 1)
		fill = None
		if opt.get('fill'):
			lab, _ = ndimage.label(d < 0.35)
			seeds = [lab[y - crop[1], x - crop[0]] for x, y in opt['fill']]
			fill = ndimage.binary_dilation(np.isin(lab, [s_ for s_ in seeds if s_]), iterations=2)
		size = write(f'p-{name}.webp', webp_bytes(raster(d, w, h, opt.get('strength', 1.0), opt.get('res', RES), fill)))
		manifest['pieces'][name] = {'w': w, 'h': h, 'role': role, **{k_: opt[k_] for k_ in ('foot', 'lite') if k_ in opt}}
		total += size
		print(f'{name:14s} {w:6.1f} x {h:6.1f}  {size / 1024:6.1f} KiB')

	for fname, f in FRAMES.items():
		defs, uses = [], []
		for corner, (sheet, crop, cw) in f.get('corners', {}).items():
			d = darkness(sheets[sheet], crop)
			k = cw / (crop[2] - crop[0])
			w, h = cw, round((crop[3] - crop[1]) * k, 1)
			b64 = base64.b64encode(webp_bytes(raster(d, w, h, res=f.get('res', RES)))).decode()
			x = INSET if corner[1] == 'l' else PAGE_W - INSET - w
			y = INSET if corner[0] == 't' else PAGE_H - INSET - h
			uses.append(f'<image x="{x:g}" y="{y:g}" width="{w:g}" height="{h:g}" href="data:image/webp;base64,{b64}"/>')
		for part in (('top', 'bottom') if 'top' in f else ()):
			flip_v = f[part] is None              # reuse the top drawing, flipped
			sheet, crop, drawn, cw = f[part] or f['top']
			if not flip_v:
				d = darkness(sheets[sheet], crop, f.get('clear', ()))
				k = cw / (crop[2] - crop[0])
				w, h = cw, round((crop[3] - crop[1]) * k, 1)
				b64 = base64.b64encode(webp_bytes(raster(d, w, h))).decode()
				defs.append(f'<image id="{part}" width="{w:g}" height="{h:g}" href="data:image/webp;base64,{b64}"/>')
				src, sw, sh = part, w, h
			drawn_left = drawn in ('tl', 'bl')
			for side in ('l', 'r'):
				mirror = (side == 'l') != drawn_left
				x = INSET if side == 'l' else PAGE_W - INSET - sw
				y = INSET if part == 'top' else PAGE_H - INSET - sh
				a_, d_ = (-1 if mirror else 1), (-1 if flip_v else 1)
				e_, f_ = x + (sw if mirror else 0), y + (sh if flip_v else 0)
				uses.append(f'<use href="#{src}" transform="matrix({a_} 0 0 {d_} {e_:g} {f_:g})"/>')
		svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{PAGE_W}" height="{PAGE_H}" viewBox="0 0 {PAGE_W} {PAGE_H}">'
		       f'<defs>{"".join(defs)}</defs>{"".join(uses)}</svg>\n')
		size = write(f'frame-{fname}.svg', svg)
		manifest['frames'][fname] = True
		total += size
		print(f'frame-{fname:8s}  {size / 1024:6.1f} KiB')

	with open(os.path.join(HERE, 'art', 'pieces.json'), 'w') as fh:
		json.dump(manifest, fh, indent=1, sort_keys=True)
	print(f'total {total / 1024:.1f} KiB')


if __name__ == '__main__':
	main()
