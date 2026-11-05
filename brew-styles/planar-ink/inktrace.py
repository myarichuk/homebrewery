"""
PLANAR INK  ·  shared potrace helpers (used by build_font.py and
extract_marginalia.py).

potracer is the pure-Python port of potrace:  pip install potracer
"""

import numpy as np
import potrace
from fontTools.pens.recordingPen import RecordingPen


def trace(mask, turdsize=8, alphamax=1.0, opttolerance=0.4):
	"""bool mask (True = ink) -> RecordingPen in pixel space (y down).

	potracer reads values below its black level as ink, so it is handed the
	inverse (False = ink), padded with paper so contours never touch the edge.
	Contours come out with alternating direction (outer / hole), which suits
	both CFF's non-zero rule and SVG's default fill rule.
	"""
	bm   = potrace.Bitmap(np.pad(~mask, 2, constant_values=True))
	path = bm.trace(turdsize=turdsize, turnpolicy=potrace.POTRACE_TURNPOLICY_MINORITY,
	                alphamax=alphamax, opticurve=True, opttolerance=opttolerance)
	pen = RecordingPen()
	for curve in path:
		pen.moveTo((curve.start_point.x - 2, curve.start_point.y - 2))
		for seg in curve.segments:
			if seg.is_corner:
				pen.lineTo((seg.c.x - 2, seg.c.y - 2))
				pen.lineTo((seg.end_point.x - 2, seg.end_point.y - 2))
			else:
				pen.curveTo((seg.c1.x - 2, seg.c1.y - 2), (seg.c2.x - 2, seg.c2.y - 2),
				            (seg.end_point.x - 2, seg.end_point.y - 2))
		pen.closePath()
	return pen


def svg_path(rec, transform, prec=1):
	"""RecordingPen -> compact SVG path data, after an affine
	(a, b, c, d, e, f) transform, with relative commands."""
	a, b, c, d, e, f = transform
	q = 10 ** prec

	def T(p):
		x, y = p
		return round((a * x + c * y + e) * q), round((b * x + d * y + f) * q)

	def num(v):
		s = f'{v / q:.{prec}f}'.rstrip('0').rstrip('.')
		s = s.replace('0.', '.', 1) if s.startswith('0.') else s.replace('-0.', '-.', 1)
		return s or '0'

	out, cur, start = [], (0, 0), (0, 0)

	def rel(pts):
		nonlocal cur
		parts = []
		for p in pts:
			parts.append((p[0] - cur[0], p[1] - cur[1]))
		return parts

	def fmt(pairs):
		s = ''
		for dx, dy in pairs:
			for v in (dx, dy):
				t = num(v)
				s += t if (t.startswith('-') or not s) else ' ' + t
		return s

	for op, args in rec.value:
		if op == 'moveTo':
			p = T(args[0])
			out.append('M' + fmt([p]) if not out else 'm' + fmt(rel([p])))
			cur = start = p
		elif op == 'lineTo':
			p = T(args[0])
			out.append('l' + fmt(rel([p])))
			cur = p
		elif op == 'curveTo':
			pts = [T(x) for x in args]
			base = cur
			pairs = [(x - base[0], y - base[1]) for x, y in pts]
			out.append('c' + fmt(pairs))
			cur = pts[-1]
		elif op == 'closePath':
			out.append('z')
			cur = start
	return ''.join(out)
