"""
PLANAR INK  ·  "Planar Thorn" display font builder

Traces the hand-inked thorny capitals and the matching digits/symbols sheet
into an OpenType (CFF) font, saved as art/planar-thorn.woff2. build.mjs
embeds it in planar-ink.css as a data-URI @font-face.

    pip install potracer fonttools brotli numpy pillow scipy
    python3 brew-styles/planar-ink/build_font.py

Sources (relative to this file, crop tables are written against them):
    source/thorny-caps.jpg      1792 x 2400   A-Z  ? ! & - . , ' "
    source/thorny-symbols.jpg   1792 x 2400   0-9, operators, brackets,
                                              ornaments (skulls, swords, sigils)

Pipeline
--------
1. Ink mask: luminance < INK_T. The sheets are black ink on white, so a
   global threshold is enough; JPEG ringing sits well above it.
2. Glyph assembly: each glyph is a box on the sheet. Connected components
   of the mask are assigned to the box that contains their centroid
   (nearest box centre wins where boxes overlap), so swashes that reach
   into a neighbour's box stay with their own letter, and detached bits
   (the dot of '?', thorn flicks, splatter) join theirs. Specks smaller than
   MIN_SPECK px are dropped: they cost a contour each and vanish at text size.
3. Metrics: per row, the baseline and cap line are where the glyphs' ink is
   widest near the bottom / top (serif feet, head strokes), not the flick
   tips. Each row is scaled so its cap height maps to CAP units.
4. Tracing: potrace (pure-Python port), output cubic Béziers, written as
   CFF charstrings. Contour direction alternates outer/hole, which is what
   CFF's non-zero fill needs.
5. Spacing: swashes overhang by design. The spacing box sits halfway
   between the full ink box and the span of the middle 90% of the ink;
   advance = box x TRACK + GAP, box centred, so tails tuck under neighbours.

Letters only exist in capitals. Lowercase codepoints map to the capitals
drawn at SMALLCAP size, so mixed-case text still renders in the face.

The N on the sheet is smeared beyond use. Until a clean one is drawn it is
assembled from M: M's left stem + first diagonal, and M's right stem moved
to where the diagonal lands.
"""

import io
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

from inktrace import trace
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.boundsPen import BoundsPen

HERE      = os.path.dirname(os.path.abspath(__file__))
INK_T     = 150          # luminance threshold for ink
MIN_SPECK = 60           # px^2; smaller components are dropped
PAD       = 36           # px; glyph boxes grow by this to catch flicks
UPM       = 1000
CAP       = 700          # cap height in font units
TRACK     = 0.92         # fraction of the spacing box that counts toward the advance
GAP       = 46           # units added to every advance
SMALLCAP  = 0.80
FAMILY    = 'Planar Thorn'

# ----------------------------------------------------------------------------
# glyph tables:  char(s) -> (x0, y0, x1, y1) union box on the sheet.
# A tuple of chars maps several codepoints to one drawing.
# ----------------------------------------------------------------------------
CAPS_ROWS = [
	# row y-band, glyphs
	((40, 545), {
		'A': (68, 48, 342, 532),   'B': (312, 124, 569, 477), 'C': (591, 91, 825, 473),
		'D': (815, 107, 1062, 491), 'E': (1073, 140, 1307, 460), 'F': (1303, 97, 1487, 525),
		'G': (1478, 138, 1717, 466),
	}),
	((540, 1040), {
		'H': (60, 572, 340, 1032),  'I': (369, 601, 444, 1011), 'J': (476, 595, 726, 987),
		'K': (743, 557, 991, 1027), 'L': (989, 591, 1175, 966), 'M': (1199, 587, 1484, 1008),
	}),
	((1070, 1560), {
		'O': (74, 1138, 311, 1463),  'P': (297, 1096, 538, 1550), 'Q': (553, 1136, 795, 1479),
		'R': (788, 1115, 1062, 1492), 'S': (1036, 1106, 1246, 1483), 'T': (1237, 1109, 1547, 1552),
		'U': (1485, 1074, 1718, 1459),
	}),
	((1535, 2060), {
		'V': (169, 1540, 481, 1994),  'W': (470, 1578, 828, 1982), 'X': (816, 1561, 1153, 1991),
		'Y': (1116, 1594, 1421, 2057), 'Z': (1368, 1635, 1615, 1971),
	}),
]
# punctuation on the caps sheet: shares row 4's scale, own baseline
CAPS_PUNCT_BASELINE = 2334
CAPS_PUNCT = {
	'?': (305, 2061, 457, 2336), '!': (510, 2055, 575, 2336), '&': (630, 2092, 850, 2341),
	('-', '‐', '‑'): (896, 2199, 1029, 2234),
	'.': (1071, 2283, 1118, 2332), ',': (1179, 2283, 1229, 2376),
	("'", '’'): (1286, 2080, 1329, 2164), ('"', '”'): (1392, 2083, 1484, 2172),
}

DIGIT_ROW = {
	'0': (51, 135, 232, 430),  '1': (250, 107, 359, 431), '2': (379, 124, 538, 437),
	'3': (518, 122, 708, 478), '4': (718, 81, 901, 488),  '5': (892, 117, 1073, 475),
	'6': (1069, 92, 1237, 432), '7': (1241, 122, 1405, 491), '8': (1404, 123, 1564, 436),
	'9': (1568, 126, 1728, 477),
}
# symbols sheet, (baseline_y, glyphs). Scale = digit row's.
SYMBOL_ROWS = [
	(915, {
		'+': (65, 668, 241, 881), '−': (284, 754, 448, 795), '=': (495, 724, 663, 822),
		'/': (687, 574, 841, 969), '*': (862, 600, 1004, 750), '%': (1036, 606, 1235, 943),
		'#': (1267, 629, 1468, 911), '@': (1485, 634, 1738, 925),
	}),
	(1450, {
		'$': (75, 1081, 261, 1488), '¢': (298, 1121, 473, 1462),
		'⚔': (503, 1127, 783, 1450),                     # crossed swords
		'†': (813, 1134, 1009, 1446),                    # cross-dagger
		'☠': (1042, 1123, 1262, 1457),                   # skull and crossbones
		('\U0001F480', ''): (1294, 1134, 1499, 1446),   # skull
		('❖', ''): (1531, 1112, 1727, 1466),       # four-diamond cluster
	}),
	(1905, {
		'(': (193, 1598, 298, 1973), ')': (345, 1607, 450, 1982), '[': (529, 1624, 638, 1958),
		']': (689, 1625, 798, 1953), '{': (855, 1610, 956, 1964), '}': (993, 1615, 1092, 1968),
		'<': (1145, 1689, 1274, 1891), '>': (1313, 1682, 1454, 1893),
		'~': (1480, 1667, 1594, 1710), '_': (1464, 1872, 1631, 1899),
	}),
	(2306, {
		'^': (306, 2072, 443, 2187), '|': (509, 2046, 542, 2353), '\\': (611, 2067, 751, 2345),
		';': (801, 2149, 850, 2347), ':': (920, 2150, 961, 2306),
		('☨', ''): (1028, 2067, 1162, 2339),       # barred cross sigil
		('⁘', ''): (1196, 2073, 1414, 2235),       # diamond rosette
		'': (1438, 2070, 1560, 2335),                   # arrow sigil
	}),
]


# ----------------------------------------------------------------------------
def ink_mask(path, size):
	im = Image.open(os.path.join(HERE, path)).convert('L')
	if im.size != size:
		sys.exit(f'{path}: expected {size}, got {im.size}; the crop tables would be wrong')
	return np.asarray(im) < INK_T


class Sheet:
	"""Connected components of a sheet, assigned to glyph boxes."""

	def __init__(self, mask):
		self.mask = mask
		self.lab, n = ndimage.label(mask, structure=np.ones((3, 3)))
		idx = np.arange(1, n + 1)
		self.area = ndimage.sum(mask, self.lab, idx)
		self.cent = np.array(ndimage.center_of_mass(mask, self.lab, idx))   # (y, x)

	def assemble(self, boxes):
		"""boxes: {key: (x0,y0,x1,y1)} -> {key: (bool crop, (x0, y0))}"""
		keys   = list(boxes)
		owners = {k: [] for k in keys}
		centres = {k: ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2) for k, b in boxes.items()}
		for i, (cy, cx) in enumerate(self.cent):
			if self.area[i] < MIN_SPECK:
				continue
			best, bd = None, 1e18
			for k in keys:
				x0, y0, x1, y1 = boxes[k]
				if x0 - PAD <= cx <= x1 + PAD and y0 - PAD <= cy <= y1 + PAD:
					d = (cx - centres[k][0]) ** 2 + (cy - centres[k][1]) ** 2
					if d < bd:
						best, bd = k, d
			if best is not None:
				owners[best].append(i + 1)
		out = {}
		for k in keys:
			sel = np.isin(self.lab, owners[k])
			ys, xs = np.nonzero(sel)
			y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
			out[k] = (sel[y0:y1, x0:x1], (x0, y0))
		return out


def row_lines(glyphs):
	"""Baseline / cap line of a row: median over glyphs of the lowest / highest
	scanline whose ink width is >= 35% of that glyph's widest scanline."""
	bases, tops = [], []
	for m, (x0, y0) in glyphs.values():
		w = m.sum(1)
		rows = np.nonzero(w >= 0.35 * w.max())[0]
		bases.append(y0 + rows.max())
		tops.append(y0 + rows.min())
	return float(np.median(bases)), float(np.median(tops))


def build_n(caps):
	"""N = M's left stem and first diagonal + M's right stem moved left."""
	m, (mx, my) = caps['M']
	vertex = 1345 - mx            # where M's diagonals meet (sheet x 1345)
	stem   = 1416 - mx            # M's right stem starts here (sheet x 1416)
	left   = m[:, :vertex]
	right  = m[:, stem:]
	dx     = vertex - 14          # overlap the diagonal's foot a little
	w      = dx + right.shape[1]
	n = np.zeros((m.shape[0], w), bool)
	n[:, :left.shape[1]] |= left
	n[:, dx:dx + right.shape[1]] |= right
	return n, (mx, my)


# ----------------------------------------------------------------------------
class Glyph:
	def __init__(self, mask, origin, baseline, scale, *, track=TRACK, gap=GAP, raise_=0):
		self.rec  = trace(mask)
		self.ox, self.oy = origin
		self.w    = mask.shape[1]
		self.base = baseline
		self.k    = scale
		# Spacing box: halfway between the full ink box (flick tip to flick tip)
		# and the span holding the middle 90% of the ink. Long hairline tails
		# then overhang the neighbours instead of opening gaps.
		cum = np.cumsum(mask.sum(0)) / mask.sum()
		m0, m1 = np.searchsorted(cum, 0.05), np.searchsorted(cum, 0.95) + 1
		self.x0 = 0.5 * (0 + m0)
		self.x1 = 0.5 * (self.w + m1)
		self.adv = round((self.x1 - self.x0) * scale * track + gap)
		self.raise_ = raise_

	def outline(self, size=1.0):
		"""-> (RecordingPen in font units, advance)"""
		k   = self.k * size
		adv = round(self.adv * size)
		dx  = adv / 2 - (self.x0 + self.x1) / 2 * k      # centre the spacing box
		rec = RecordingPen()
		# pixel (x, y-down, relative to crop) -> font units (y-up, baseline 0)
		t = (k, 0, 0, -k, dx, (self.base - self.oy) * k + self.raise_ * size)
		self.rec.replay(TransformPen(rec, t))
		return rec, adv


# ----------------------------------------------------------------------------
def main():
	caps_sheet = Sheet(ink_mask('source/thorny-caps.jpg', (1792, 2400)))
	sym_sheet  = Sheet(ink_mask('source/thorny-symbols.jpg', (1792, 2400)))

	glyphs = {}     # glyph name -> (Glyph, [codepoints], size)

	def add(name, g, chars, size=1.0):
		cps = [ord(c) for c in chars]
		glyphs[name] = (g, cps, size)

	# capitals, row by row
	row_scale = None
	for band, boxes in CAPS_ROWS:
		parts = caps_sheet.assemble(boxes)
		if 'M' in parts:
			parts['N'] = build_n(parts)
		base, top = row_lines(parts)
		row_scale = CAP / (base - top)
		print(f'caps row {band}: baseline {base:.0f}, cap line {top:.0f}, scale {row_scale:.3f}')
		for ch, (m, org) in parts.items():
			g = Glyph(m, org, base, row_scale)
			add(ch, g, [ch])
			add(ch.lower(), g, [ch.lower()], SMALLCAP)

	# caps-sheet punctuation, last caps row's scale
	for key, (m, org) in caps_sheet.assemble(CAPS_PUNCT).items():
		chars = key if isinstance(key, tuple) else (key,)
		add(f'uni{ord(chars[0]):04X}', Glyph(m, org, CAPS_PUNCT_BASELINE, row_scale, track=1.0, gap=90), chars)

	# digits
	parts = sym_sheet.assemble(DIGIT_ROW)
	base, top = row_lines(parts)
	dscale = CAP / (base - top)
	print(f'digit row: baseline {base:.0f}, top {top:.0f}, scale {dscale:.3f}')
	for ch, (m, org) in parts.items():
		add(f'uni{ord(ch):04X}', Glyph(m, org, base, dscale, track=1.0, gap=110), [ch])

	# symbols & ornaments
	for base, boxes in SYMBOL_ROWS:
		for key, (m, org) in sym_sheet.assemble(boxes).items():
			chars = key if isinstance(key, tuple) else (key,)
			add(f'uni{ord(chars[0]):04X}', Glyph(m, org, base, dscale, track=1.0, gap=100), chars)

	# dashes: the hyphen, stretched
	hy = glyphs['uni002D'][0]
	for cp, sx in ((0x2013, 1.6), (0x2014, 2.6)):
		glyphs[f'uni{cp:04X}'] = (('stretch', hy, sx), [cp], 1.0)
	# opening quotes: closing quotes turned 180 degrees
	for src, cp in (('uni0027', 0x2018), ('uni0022', 0x201C)):
		glyphs[f'uni{cp:04X}'] = (('turn', glyphs[src][0]), [cp], 1.0)

	# ---- assemble the font ------------------------------------------------
	order = ['.notdef', 'space', 'nbspace'] + list(glyphs)
	charstrings, widths, cmap = {}, {}, {0x20: 'space', 0xA0: 'nbspace'}
	empty = T2CharStringPen(260, None)
	charstrings['.notdef'], widths['.notdef'] = empty.getCharString(), 260
	for nm in ('space', 'nbspace'):
		charstrings[nm], widths[nm] = T2CharStringPen(250, None).getCharString(), 250

	bounds = {}
	for name, (g, cps, size) in glyphs.items():
		if isinstance(g, tuple):
			kind, src = g[0], g[1]
			rec, adv = src.outline()
			if kind == 'stretch':
				adv = round(adv * g[2])
				t = (g[2], 0, 0, 1, 0, 0)
			else:   # turn: rotate 180 degrees about the ink's centre
				bp = BoundsPen(None)
				rec.replay(bp)
				x0, y0, x1, y1 = bp.bounds
				t = (-1, 0, 0, -1, x0 + x1, y0 + y1)
			out = RecordingPen()
			rec.replay(TransformPen(out, t))
			rec = out
		else:
			rec, adv = g.outline(size)
		pen, bp = T2CharStringPen(adv, None), BoundsPen(None)
		rec.replay(pen)
		rec.replay(bp)
		charstrings[name], widths[name] = pen.getCharString(), adv
		bounds[name] = bp.bounds
		for cp in cps:
			cmap[cp] = name

	fb = FontBuilder(UPM, isTTF=False)
	fb.setupGlyphOrder(order)
	fb.setupCharacterMap(cmap)
	fb.setupCFF(FAMILY.replace(' ', ''), {'FullName': FAMILY}, charstrings, {})
	lsb = {nm: round(bounds[nm][0]) if bounds.get(nm) else 0 for nm in order}
	fb.setupHorizontalMetrics({nm: (widths[nm], lsb[nm]) for nm in order})
	fb.setupHorizontalHeader(ascent=1000, descent=-320)
	fb.setupNameTable({'familyName': FAMILY, 'styleName': 'Regular',
	                   'copyright': 'Hand-inked for the Planar Ink brew style',
	                   'version': 'Version 1.000'})
	fb.setupOS2(sTypoAscender=1000, sTypoDescender=-320, sTypoLineGap=0,
	            usWinAscent=1100, usWinDescent=420, sCapHeight=CAP, sxHeight=round(CAP * SMALLCAP),
	            achVendID='PLNK', fsType=0)
	fb.setupPost()
	# fixed timestamps (seconds since 1904) so rebuilds are byte-identical
	fb.font['head'].created = fb.font['head'].modified = 3_900_000_000
	fb.font.flavor = 'woff2'
	dest = os.path.join(HERE, 'art', 'planar-thorn.woff2')
	fb.save(dest)
	print(f'wrote {os.path.relpath(dest)}  ({os.path.getsize(dest) / 1024:.1f} KiB, {len(order)} glyphs)')


if __name__ == '__main__':
	main()
