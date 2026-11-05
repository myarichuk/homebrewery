"""
PLANAR INK  ·  pre-rendered paper, ink texture and watercolour washes

    python3 brew-styles/planar-ink/make_paper.py

Everything here used to be SVG feTurbulence evaluated by the browser. That
renders at screen resolution, prints at whatever the PDF backend picks, and
reads as digital salt-and-pepper speckle. These are rendered once, seeded,
at print resolution:

    art/paper.webp      1024 px seamless tile, shown at 512 CSS px (2x).
                        Smooth multi-scale mottling and faint fibres; no
                        per-pixel speckle, which is what made the old grain
                        look like a filter.
    art/stains.webp     page-sized (272 x 352, stretched; it is all soft): broad tide-marks,
                        darker toward the edges, plus foxing spots.
    art/inkgrain.webp   512 px seamless alpha tile. Used as mask-image on the
                        titles and ink overlays: mostly opaque, with dry-brush
                        streaks and pits where the pen skipped on the tooth of
                        the paper. This is most of the "hand inked" feel.
    art/wash-1..3.webp  watercolour blots: irregular pigment pool with
                        granulation and the darker rim that real watercolour
                        leaves where it dries (edge darkening). Margin stains
                        and the drop-cap halo.

Seamless noise: white noise shaped in the frequency domain (FFT) is periodic
by construction, so tiles wrap with no seam.
"""

import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage

HERE  = os.path.dirname(os.path.abspath(__file__))
PAPER = np.array([239, 224, 189], np.float32)     # --pi-paper  #efe0bd
DARK  = np.array([214, 190, 145], np.float32)     # where the paper browns
WASH  = (93, 84, 74)                              # grey-brown watercolour


def noise(n, seed, lo, hi=None, aniso=(1.0, 1.0)):
	"""Periodic band-limited noise, n x n, zero mean, unit std.
	lo/hi: wavelengths in px kept (hi = smallest)."""
	r  = np.random.default_rng(seed)
	w  = r.standard_normal((n, n))
	fy = np.fft.fftfreq(n)[:, None] * aniso[0]
	fx = np.fft.fftfreq(n)[None, :] * aniso[1]
	f  = np.hypot(fx, fy)
	f[0, 0] = 1
	amp = f ** -1.0                                   # pink-ish within the band
	amp[f < 1 / lo] = 0
	if hi:
		amp *= np.exp(-(f * hi) ** 2)
	out = np.real(np.fft.ifft2(np.fft.fft2(w) * amp))
	return (out - out.mean()) / (out.std() + 1e-9)


def save(img, name, **kw):
	path = os.path.join(HERE, 'art', name)
	img.save(path, 'WEBP', method=6, **kw)
	print(f'wrote {os.path.relpath(path)}  {img.size}  ({os.path.getsize(path) / 1024:.1f} KiB)')


# ---------------------------------------------------------------- paper
def paper_tile(n=1024):
	m = (0.55 * noise(n, 1, 700, 90)
	     + 0.30 * noise(n, 2, 160, 18)
	     + 0.15 * noise(n, 3, 40, 3.5))
	t = np.clip(0.5 + 0.22 * m, 0, 1)[..., None]      # 0 light .. 1 browned
	rgb = PAPER + (DARK - PAPER) * (t * 0.55)
	# fibres: short, faint, slightly curved strokes, drawn wrapped
	fib = Image.new('L', (n, n), 128)
	d = ImageDraw.Draw(fib)
	r = np.random.default_rng(4)
	for _ in range(900):
		x, y = r.uniform(0, n, 2)
		a = r.uniform(0, np.pi)
		L = r.uniform(12, 60)
		bend = r.uniform(-0.4, 0.4)
		pts = [(x + np.cos(a + bend * s) * L * s, y + np.sin(a + bend * s) * L * s) for s in np.linspace(0, 1, 6)]
		tone = int(128 + r.choice([-1, 1]) * r.uniform(14, 30))
		for ox in (-n, 0, n):
			for oy in (-n, 0, n):
				d.line([(px + ox, py + oy) for px, py in pts], fill=tone, width=1)
	fib = np.asarray(fib.filter(ImageFilter.GaussianBlur(0.7)), np.float32) - 128
	rgb = rgb + fib[..., None] * 0.4
	# the paper's tooth: soft 2-4 px grain, far below speckle contrast
	rgb = rgb + noise(n, 5, 6, 1.4)[..., None] * 2.2
	return Image.fromarray(np.clip(rgb + 0.5, 0, 255).astype(np.uint8), 'RGB')


def stains(w=272, h=352):
	yy, xx = np.mgrid[0:h, 0:w]
	# distance to the nearest edge, 0 at edge .. 1 in the middle
	edge = np.minimum.reduce([xx, w - 1 - xx, yy, h - 1 - yy]) / (min(w, h) / 2)
	big = noise(1024, 11, 900, 60)[:h, :w]
	mid = noise(1024, 12, 200, 12)[:h, :w]
	a = np.clip(0.30 * (1 - edge) ** 2.2 + 0.07 * big + 0.03 * mid - 0.02, 0, 1)
	# tide-marks: thin darker contours of the broad noise
	tide = np.exp(-(((big * 3) % 1) - 0.5) ** 2 / 0.004) * np.clip(big + 0.3, 0, 1) * 0.05
	a = a + tide * (1 - edge * 0.6)
	# foxing: a few small rust spots
	r = np.random.default_rng(13)
	fox = np.zeros((h, w), np.float32)
	for _ in range(10):
		cx, cy = r.uniform(0, w), r.uniform(0, h)
		rad = r.uniform(0.35, 0.9)
		fox += np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * rad ** 2)) * r.uniform(.08, .2)
	a = np.clip(a + fox, 0, 0.6)
	rgba = np.zeros((h, w, 4), np.uint8)
	rgba[..., :3] = (122, 84, 40)
	rgba[..., 3] = (a * 255 + 0.5).astype(np.uint8)
	return Image.fromarray(rgba, 'RGBA')


# ------------------------------------------------------------ ink texture
def ink_grain(n=512):
	# pits: where the pen skipped over the paper's tooth
	pits = noise(n, 21, 24, 1.6)
	# drag: dry-brush streaks, long in one direction
	drag = noise(n, 22, 90, 2.5, aniso=(0.18, 1.0))
	a = 1.0 - 0.6 * np.clip(pits - 1.9, 0, 1.5) - 0.5 * np.clip(drag - 1.7, 0, 1.2)
	a = np.clip(a, 0.18, 1.0)
	rgba = np.zeros((n, n, 4), np.uint8)
	rgba[..., :3] = 255
	rgba[..., 3] = (a * 255 + 0.5).astype(np.uint8)
	return Image.fromarray(rgba, 'RGBA')


# --------------------------------------------------------- watercolour
def wash_blot(seed, n=200, strength=0.34):
	yy, xx = np.mgrid[0:n, 0:n] / n - 0.5
	rr = np.hypot(xx, yy) * 2
	shape = (1 - rr) + 0.16 * noise(n, seed, 190, 32) + 0.025 * noise(n, seed + 1, 32, 5)
	inside = shape > 0.42
	inside = ndimage.binary_opening(inside, iterations=2)
	lab, k = ndimage.label(inside)
	if k > 1:      # keep the main pool and anything sizable
		sizes = ndimage.sum(inside, lab, range(1, k + 1))
		inside = np.isin(lab, 1 + np.nonzero(sizes > sizes.max() * 0.04)[0])
	dist = ndimage.distance_transform_edt(inside)
	gran = noise(n, seed + 2, 9, 1.0)                # pigment granulation
	pool = 0.55 + 0.12 * noise(n, seed + 3, 75, 6) + 0.06 * gran
	rim  = 0.75 * np.exp(-dist / 1.7)                 # edge darkening
	a = np.where(inside, pool + rim, 0) * strength
	a = ndimage.gaussian_filter(a, 0.8)
	rgba = np.zeros((n, n, 4), np.uint8)
	rgba[..., :3] = WASH
	rgba[..., 3] = (np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)
	return Image.fromarray(rgba, 'RGBA')


def main():
	os.makedirs(os.path.join(HERE, 'art'), exist_ok=True)
	save(paper_tile(), 'paper.webp', quality=78)
	save(stains(), 'stains.webp', quality=70, alpha_quality=55)
	save(ink_grain(), 'inkgrain.webp', quality=80, alpha_quality=40)
	for i, seed in enumerate((31, 47, 63), 1):
		save(wash_blot(seed), f'wash-{i}.webp', quality=70, alpha_quality=60)


if __name__ == '__main__':
	main()
