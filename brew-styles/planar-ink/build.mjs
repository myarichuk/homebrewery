/* ==================================================================
   PLANAR INK  ·  asset generator

   Builds ../planar-ink.css from ./rules.css, injecting every image the
   sheet needs as CSS custom properties at the @@ASSETS@@ marker:

   · art/frame.svg, art/m-*.svg – ink line-work lifted off the
     asset sheet and traced to vectors by extract_marginalia.py.
   · art/*.webp – the drop-cap wash (extract_marginalia.py); the engraved thorn ornaments
     (vine rule, kicker plaque, cartouche) keyed off the blue sheet by
     extract_ornaments.py. Embedded as base64 WebP.
   · art/planar-thorn.woff2 – the hand-inked display face, traced by
     build_font.py. Embedded as a data-URI @font-face.
   · generated SVG – torn page edge, scorched rim, paper textures, the
     watercolour image masks, small rules and the text-box border.

   The output is a single self-contained sheet you can paste into the
   Homebrewery Style tab. Nothing is fetched except Google Fonts.

       python3 brew-styles/planar-ink/extract_marginalia.py <sheet.jpg>   (only if art changes)
       python3 brew-styles/planar-ink/extract_ornaments.py                (only if art changes)
       python3 brew-styles/planar-ink/build_font.py                       (only if glyphs change)
       node    brew-styles/planar-ink/build.mjs

   Page geometry is fixed: a V3 page is 215.9 x 279.4 mm = 816 x 1056 CSS px.
   All randomness is seeded: rebuilding yields byte-identical output.
   ================================================================== */

import fs   from 'node:fs';
import path from 'node:path';
import url  from 'node:url';

const here  = path.dirname(url.fileURLToPath(import.meta.url));
const W     = 816;
const H     = 1056;
const SEED  = 0x5161;
const INK   = '#1d1712';

/* ---------- utilities ---------------------------------------------------- */

const mulberry32 = (a)=>()=>{
	a |= 0; a = a + 0x6D2B79F5 | 0;
	let t = Math.imul(a ^ a >>> 15, 1 | a);
	t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
	return ((t ^ t >>> 14) >>> 0) / 4294967296;
};
const f = (n)=>(Math.round(n * 10) / 10).toString();

// Minimal, safe data-URI encoding for SVG: short and still diffable.
const svgUri = (svg)=>{
	const min = svg.replace(/\s+/g, ' ').replace(/> </g, '><').replace(/"/g, '\'').trim();
	const enc = min
		.replace(/%/g, '%25')
		.replace(/#/g, '%23')
		.replace(/</g, '%3C')
		.replace(/>/g, '%3E')
		.replace(/\{/g, '%7B')
		.replace(/\}/g, '%7D');
	return `url("data:image/svg+xml,${enc}")`;
};
const fontUri = (file)=>`url("data:font/woff2;base64,${fs.readFileSync(path.join(here, file)).toString('base64')}") format('woff2')`;
const webpUri = (file)=>`url("data:image/webp;base64,${fs.readFileSync(path.join(here, file)).toString('base64')}")`;

// `extra` lets callers drop width/height (=> no intrinsic size, stretches to box)
const svg = (w, h, body, extra = '', sized = true)=>`<svg xmlns="http://www.w3.org/2000/svg" ${sized ? `width="${w}" height="${h}"` : ''} viewBox="0 0 ${w} ${h}" ${extra}>${body}</svg>`;

/* ---------- torn edges (page and artwork) ------------------------------ */
// Both are plain vector polygons: no SVG filters. Filters are rasterised at
// whatever resolution the renderer picks, which in PDF export is low and in
// some engines (WebKit/Quartz) fails outright, leaving art unmasked. A dense
// polygon prints as sharp as the text.
//
// The tear is a 1-D fractal (value noise, four octaves) displacing the
// rectangle's perimeter inward, plus a few deeper bites. Points every few
// units, written as short relative moves.

// smooth 1-D value noise, period-free, seeded
const noise1 = (seed)=>{
	const r = mulberry32(seed);
	const lattice = Array.from({ length: 4096 }, r);
	return (x)=>{
		const i = Math.floor(x), t = x - i;
		const u = t * t * (3 - 2 * t);
		const a = lattice[((i % 4096) + 4096) % 4096], b = lattice[(((i + 1) % 4096) + 4096) % 4096];
		return a + (b - a) * u;                      // 0..1
	};
};

// fractal displacement along the perimeter: [[wavelength, amplitude], ...]
const fbm = (seed, octaves)=>{
	const ns = octaves.map((_, i)=>noise1(seed + i * 977));
	return (s)=>octaves.reduce((acc, [wl, amp], i)=>acc + ns[i](s / wl) * amp, 0);
};

// occasional bites: smooth notches of random depth and width
const bites = (seed, perimeter, count, depth, width)=>{
	const r = mulberry32(seed);
	const list = Array.from({ length: count }, ()=>[r() * perimeter, depth[0] + r() * (depth[1] - depth[0]), width[0] + r() * (width[1] - width[0])]);
	return (s)=>list.reduce((acc, [c, d, w])=>{
		const t = Math.abs(s - c) / w;
		return t < 1 ? acc + d * (1 - t * t) * (1 - t * t) : acc;
	}, 0);
};

// Perimeter walk of a w x h rectangle, displaced inward by disp(s).
// Within `round` of a corner the push direction swings smoothly toward the
// diagonal, so large displacements turn the corner instead of folding into
// a wedge.
const tornPolygon = (w, h, step, disp, round = 30)=>{
	const pts = [];
	let s = 0;
	const near = (t)=>Math.max(0, 1 - t / round);
	const push = (x, y, nx, ny)=>{
		const l = Math.hypot(nx, ny), d = disp(s);
		pts.push([x + nx / l * d, y + ny / l * d]);
		s += step;
	};
	for (let x = 0; x < w; x += step) push(x, 0, near(x) - near(w - x), 1);
	for (let y = 0; y < h; y += step) push(w, y, -1, near(y) - near(h - y));
	for (let x = w; x > 0; x -= step) push(x, h, near(x) - near(w - x), -1);
	for (let y = h; y > 0; y -= step) push(0, y, 1, near(y) - near(h - y));
	let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
	for (let i = 1; i < pts.length; i++) {
		const dx = f(pts[i][0] - pts[i - 1][0]), dy = f(pts[i][1] - pts[i - 1][1]);
		d += `l${dx}${dy.startsWith('-') ? '' : ' '}${dy}`;
	}
	return `${d.replace(/(^|[^0-9])0\./g, '$1.')}Z`;
};

// One polygon, reused for the page's alpha mask and its browned rim, so the
// scorch always follows the tear exactly.
const edgeShape = ()=>{
	const per  = 2 * (W + H);
	const rough = fbm(SEED ^ 0xED6E, [[260, 3.2], [80, 2.4], [26, 1.4], [7, .7]]);
	const bite  = bites(SEED ^ 0xB17E, per, 16, [4, 11], [8, 26]);
	return tornPolygon(W, H, 2.5, (s)=>1 + rough(s) + bite(s));
};

const buildEdgeMask = ()=>svg(W, H, `<path d="${edgeShape()}"/>`, 'preserveAspectRatio="none"');

const buildEdgeBurn = ()=>{
	const d = edgeShape();
	return svg(W, H, `
		<filter id="b" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="16"/></filter>
		<defs><path id="e" d="${d}"/><clipPath id="c"><use href="#e"/></clipPath></defs>
		<g clip-path="url(#c)" fill="none">
			<use href="#e" stroke="#8a5e2c" stroke-width="56" opacity=".42" filter="url(#b)"/>
			<use href="#e" stroke="#5a3a1a" stroke-width="5" opacity=".5"/>
			<use href="#e" stroke="#3a2410" stroke-width="1.6" opacity=".45"/>
		</g>`, 'preserveAspectRatio="none"');
};

/* ---------- artwork masks ------------------------------------------------
   A torn-paper edge for pictures: the art keeps nearly its whole box and
   only the rim is ragged. Several nested polygons at falling opacity give a
   dry, slightly feathered edge without blur filters.

   viewBox 1000 x 1000 with no width/height: no intrinsic size, so the mask
   stretches to any box, and the same image drives shape-outside.          */
const TORN = [[420, 16], [130, 10], [38, 5], [11, 2.4]];      // ragged at every scale
const BLEED = [[460, 70], [150, 30], [44, 7], [13, 1.6]];     // big slow wander, soft detail
const buildArtMask = ({ seed, amp = 1, octaves = TORN, layers = [[1, 0]], tears = 6, tearDepth = [8, 22], round = 40, step = 5 })=>{
	const S = 1000, per = 4 * S;
	const body = layers.map(([opacity, extra], i)=>{
		const rough = fbm(seed + i * 31, octaves.map(([wl, a])=>[wl, a * amp]));
		const bite  = bites(seed + 7, per, tears, tearDepth.map((v)=>v * amp), [12, 46]);
		const d = tornPolygon(S, S, step, (s)=>6 + extra + rough(s) + bite(s), round);
		return `<path d="${d}"${opacity < 1 ? ` fill-opacity="${opacity}"` : ''}/>`;
	}).join('');
	return svg(S, S, body, 'preserveAspectRatio="none"', false);
};

/* ---------- hand-inked panel frame -------------------------------------
   The ink border around framed art (references 1 and 3): each side is two
   or three overlapping wobbly strokes of varying weight that overshoot the
   corners, as a quick pen frame does. Used as a border-image, so the
   corners keep their drawn size and the sides stretch to any panel.
   Plain strokes, no filters.                                              */
const buildInkFrame = (seed)=>{
	const S = 240, P = 14;                    // canvas, line inset
	const r = mulberry32(seed);
	const wob = fbm(seed + 5, [[60, 2.2], [17, 1.1], [5, .4]]);
	const strokes = [];
	const side = (x0, y0, x1, y1, k)=>{
		const n = 3 + Math.floor(r() * 1.5);
		for (let j = 0; j < n; j++) {
			const o0 = 3 + r() * 10, o1 = 3 + r() * 10;            // overshoot
			const off = (r() - .5) * 2.4;                            // parallel offset
			const len = Math.hypot(x1 - x0, y1 - y0), ux = (x1 - x0) / len, uy = (y1 - y0) / len;
			const pts = [];
			for (let t = -o0; t <= len + o1; t += 6) {
				const w = wob(k * 1000 + j * 333 + t) - 1.85 + off;
				pts.push([x0 + ux * t - uy * w, y0 + uy * t + ux * w]);
			}
			const width = j === 0 ? 2.2 + r() * .8 : .9 + r() * .9;
			const op    = j === 0 ? .92 : .55 + r() * .3;
			strokes.push(`<path d="M${pts.map(([x, y])=>`${f(x)} ${f(y)}`).join('L')}" stroke-width="${f(width)}" stroke-opacity="${f(op)}"/>`);
		}
	};
	side(P, P, S - P, P, 1);
	side(S - P, P, S - P, S - P, 2);
	side(S - P, S - P, P, S - P, 3);
	side(P, S - P, P, P, 4);
	return svg(S, S, `<g fill="none" stroke="${INK}" stroke-linecap="round" stroke-linejoin="round">${strokes.join('')}</g>`);
};

/* ---------- small pieces ------------------------------------------------- */

const buildRule = ()=>svg(600, 18, `
	<g fill="${INK}">
		<path d="M290,9 C200,7 90,6 4,9 C90,11 200,11 290,9 Z"/>
		<path d="M310,9 C400,7 510,6 596,9 C510,11 400,11 310,9 Z"/>
		<path d="M300,2 l7,7 l-7,7 l-7,-7 Z" fill="none" stroke="${INK}" stroke-width="1.6"/>
		<circle cx="300" cy="9" r="1.8"/>
	</g>`, 'preserveAspectRatio="none"');

const buildArrow = ()=>svg(60, 22, `
	<g fill="${INK}">
		<path d="M2,5 C14,4 22,3 30,6 C38,3 46,4 58,5 C46,6 38,6 30,9 C22,6 14,6 2,5 Z"/>
		<path d="M25,9 L30,20 L35,9 L30,12 Z"/>
	</g>`);

/* ---------- marginalia scatter ------------------------------------------
   CSS has no random(), so the variation is precomputed here (seeded, so the
   output is stable) and selected per page with :nth-child cycles of
   co-prime length: 7 marginalia layouts x 5 splatter sets x 4 small offsets
   repeat only every 140 pages. Each drawing is embedded once; a layout is
   just a list of background images, positions and sizes for .page::after.

   Pieces come from two sheets: the original asset sheet (vector line art +
   a watercolour tone layer, extract_marginalia.py) and the second sheet
   (3x bitmaps, extract_pieces.py, sizes in art/pieces.json).              */
const manifest = JSON.parse(fs.readFileSync(path.join(here, 'art/pieces.json'), 'utf8'));
const CLASSIC = {
	'skull'   : [55, 56], 'skull-sm' : [32, 36], 'dagger' : [43, 110],
	'compass' : [68, 73], 'orrery'   : [49, 78],
	'splat-a' : [46, 56], 'splat-b'  : [48, 52], 'splat-c' : [42, 42]
};
const CLASSIC_MARG  = ['skull', 'skull-sm', 'dagger', 'compass', 'orrery'];
const CLASSIC_SPLAT = ['splat-a', 'splat-b', 'splat-c'];

const classicPiece = (n)=>({
	name   : n,
	w      : CLASSIC[n][0], h : CLASSIC[n][1],
	layers : CLASSIC_MARG.includes(n) ? [`var(--pi-m-${n})`, `var(--pi-m-${n}-tone)`] : [`var(--pi-m-${n})`]
});
const sheetPiece = (n)=>({ name: n, w: manifest.pieces[n].w, h: manifest.pieces[n].h, layers: [`var(--pi-p-${n})`] });
const byRole = (role)=>Object.keys(manifest.pieces).filter((n)=>manifest.pieces[n].role === role).map(sheetPiece);

const MARG_POOL  = [...CLASSIC_MARG.map(classicPiece), ...byRole('marg')];
const HANG_POOL  = byRole('hang');
const SPLAT_POOL = [...CLASSIC_SPLAT.map(classicPiece), ...byRole('splat')];
const WASH_POOL  = [...byRole('pool'), ...[1, 2, 3].map((i)=>({ name: `pool-${i}`, w: 70, h: 70, layers: [`var(--pi-pool-${i})`] }))];

const LAYOUTS = 7, SETS = 5;
const SPLATS_PER_PAGE = 7;
const WASHES_PER_PAGE = 2;
const MARGIN_TOP = 244, MARGIN_BOTTOM = 828;     // between the corner brackets

// left / right margin bands (page px). Generous on purpose: a drawing may
// sit near the torn edge or tuck a little toward the text, so the pieces
// don't line up in a ruled column down each margin.
const band = (side, w)=>(side === 0 ? [14, Math.max(14, 122 - w)] : [Math.min(802 - w, 694), 802 - w]);

const overlaps = (a, b, gap)=>a[0] < b[0] + b[2] + gap && b[0] < a[0] + a[2] + gap && a[1] < b[1] + b[3] + gap && b[1] < a[1] + a[3] + gap;

const place = (r, taken, w, h, regions, gap)=>{
	for (let tries = 0; tries < 600; tries++) {
		const [x0, x1, y0, y1] = regions[Math.floor(r() * regions.length)];
		const box = [x0 + r() * Math.max(0, x1 - x0), y0 + r() * Math.max(0, y1 - y0 - h), w, h];
		if (!taken.some((t)=>overlaps(box, t, gap))) { taken.push(box); return box; }
	}
	return null;
};

const shuffle = (r, list)=>{
	const a = [...list];
	for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
	return a;
};

// flatten placed pieces into the three comma lists CSS wants
const lists = (placed)=>{
	const img = [], pos = [], size = [];
	for (const { p, x, y, w, h } of placed) {
		for (const layer of p.layers) {
			img.push(layer);
			pos.push(`${f(x)}px ${f(y)}px`);
			size.push(`${f(w)}px ${f(h)}px`);
		}
	}
	return { img: img.join(', '), pos: pos.join(', '), size: size.join(', ') };
};

// Uniform random placement still reads as ruled: three or four pieces of
// similar size, one per stretch of margin, look evenly spaced however the
// dice fall. Scribes didn't fill margins that way. They loaded one margin
// and left the other nearly bare, and drew things in little groups (a skull
// with the dagger beside it). So: a heavy and a light side, a pair on the
// heavy side most of the time, and a wider spread of sizes.
const marginaliaLayout = (i)=>{
	const r = mulberry32(SEED ^ (0x3A11 + i * 101));
	const taken = [], placed = [];
	const put = (p, regions, gap)=>{
		const k = .72 + r() * .56;                              // drawn a little larger or smaller each time
		const box = place(r, taken, p.w * k, p.h * k, regions(p.w * k, p.h * k), gap);
		if (box) placed.push({ p, x: box[0], y: box[1], w: p.w * k, h: p.h * k });
		return box;
	};
	const heavy = r() < .5 ? 0 : 1, light = 1 - heavy;
	const pool = shuffle(r, MARG_POOL);
	// a pendant hangs from the top of one margin on most pages
	let lightCount = r() < .3 ? 0 : 1;
	if (r() < .65) {
		const p = HANG_POOL[Math.floor(r() * HANG_POOL.length)];
		const side = r() < .6 ? light : heavy;
		if (side === light) lightCount = 0;
		put(p, (w)=>[[...band(side, w), MARGIN_TOP, MARGIN_TOP + p.h * 1.2 + 14]], 20);
	}
	// the heavy side: one or two singles plus, usually, a pair drawn close
	const singles = 1 + (r() < .45 ? 1 : 0);
	for (let k = 0; k < singles; k++)
		put(pool.pop(), (w)=>[[...band(heavy, w), MARGIN_TOP, MARGIN_BOTTOM]], 30 + r() * 90);
	if (r() < .7) {
		const a = put(pool.pop(), (w)=>[[...band(heavy, w), MARGIN_TOP, MARGIN_BOTTOM - 60]], 30);
		if (a) {
			const below = r() < .65, y = below ? a[1] + a[3] + 2 : a[1] - 2;
			put(pool.pop(), (w, h)=>[[...band(heavy, w), below ? y : y - h - 14, below ? y + h + 14 : y]], 1);
		}
	}
	for (let k = 0; k < lightCount; k++)
		put(pool.pop(), (w)=>[[...band(light, w), MARGIN_TOP, MARGIN_BOTTOM]], 40);
	return lists(placed);
};

const splatterSet = (i)=>{
	const r = mulberry32(SEED ^ (0x5B1A + i * 211));
	const taken = [], placed = [];
	for (let k = 0; k < SPLATS_PER_PAGE; k++) {
		const p = SPLAT_POOL[Math.floor(r() * SPLAT_POOL.length)];
		const w = 14 + r() * r() * 48;                          // mostly small, the odd big one
		const h = w * p.h / p.w;
		const regions = [
			[...band(0, w), 200, 1010], [...band(1, w), 200, 1010],
			[240, 560 - w, 990, 1036],                           // bottom margin, between corners
			[150, 250 - w, 118, 190], [566, 668 - w, 118, 190]   // top margin, beside the crest
		];
		const box = place(r, taken, w, h, regions, 10);
		if (box) placed.push({ p, x: box[0], y: box[1], w, h });
	}
	// grey watercolour pools, like the references' margin stains
	for (let k = 0; k < WASHES_PER_PAGE; k++) {
		const p = WASH_POOL[Math.floor(r() * WASH_POOL.length)];
		const w = 46 + r() * 70, h = w * p.h / p.w;
		const regions = [[...band(0, w * .7), 230, 960], [...band(1, w * .7), 230, 960]];
		const box = place(r, taken, w, h, regions, -w * .3);
		if (box) placed.push({ p, x: box[0], y: box[1], w, h });
	}
	return lists(placed);
};

const scatterCss = ()=>{
	const out = [];
	for (let i = 0; i < LAYOUTS; i++) {
		const l = marginaliaLayout(i);
		out.push(`.page:nth-child(${LAYOUTS}n+${i + 1}) {\n\t--pi-marg-img  : ${l.img};\n\t--pi-marg-pos  : ${l.pos};\n\t--pi-marg-size : ${l.size};\n}`);
	}
	for (let i = 0; i < SETS; i++) {
		const s = splatterSet(i);
		out.push(`.page:nth-child(${SETS}n+${i + 1}) {\n\t--pi-splat-img  : ${s.img};\n\t--pi-splat-pos  : ${s.pos};\n\t--pi-splat-size : ${s.size};\n}`);
	}
	[[0, 0], [5, -7], [-4, 6], [6, 4]].forEach(([x, y], i)=>out.push(`.page:nth-child(4n+${i + 1})::after { translate : ${x}px ${y}px; }`));
	return out.join('\n');
};

// Hand-placed pieces: every drawing in the pools as a class on an empty
// block, placed like Homebrewery's stock watercolour stains:
//     {{marg,ram,top:14cm,left:.4cm}}
// Natural size by default; width (or --marg-w) scales it, height follows.
const placedCss = ()=>{
	const seen = new Set(), out = [];
	for (const p of [...MARG_POOL, ...HANG_POOL, ...SPLAT_POOL, ...WASH_POOL]) {
		if (seen.has(p.name)) continue;
		seen.add(p.name);
		out.push(`.page .marg.${p.name} { --marg-img : ${p.layers.join(', ')}; --marg-nat : ${f(p.w)}px; aspect-ratio : ${f(p.w)} / ${f(p.h)}; }`);
	}
	return out.join('\n');
};

/* ---------- emit ---------------------------------------------------------
   Two sheets are written:
     planar-ink.css       everything: 5 corner sets, 5 crests, 4 rules,
                          the thorn wreath
     planar-ink-lite.css  classic corners, classic + compass crests, thorn
                          rule only: about half the size, for a lighter
                          Style tab. Classes for the missing options just
                          draw nothing.                                    */

const readSvg = (file)=>svgUri(fs.readFileSync(path.join(here, file), 'utf8'));
const EXTRA_FRAMES = Object.keys(manifest.frames);
const CRESTS = Object.keys(manifest.pieces).filter((n)=>manifest.pieces[n].role === 'crest');
const RULES  = Object.keys(manifest.pieces).filter((n)=>manifest.pieces[n].role === 'rule');
const PLATES = Object.keys(manifest.pieces).filter((n)=>manifest.pieces[n].role === 'plate');
const LITE_KEEP = new Set(['crest-compass', 'rule-thorn']);

const buildAssets = (lite)=>({
	'--pi-frame-classic' : readSvg('art/frame.svg'),
	...Object.fromEntries((lite ? [] : EXTRA_FRAMES).map((n)=>[`--pi-frame-${n}`, readSvg(`art/frame-${n}.svg`)])),
	'--pi-crest-classic' : readSvg('art/m-crest.svg'),
	...Object.fromEntries([...CRESTS, ...RULES, ...PLATES].filter((n)=>!lite || LITE_KEEP.has(n)).map((n)=>[`--pi-p-${n}`, webpUri(`art/p-${n}.webp`)])),
	...Object.fromEntries(Object.keys(CLASSIC).map((n)=>[`--pi-m-${n}`, readSvg(`art/m-${n}.svg`)])),
	...Object.fromEntries(CLASSIC_MARG.map((n)=>[`--pi-m-${n}-tone`, webpUri(`art/m-${n}-tone.webp`)])),
	...Object.fromEntries([...byRole('marg'), ...byRole('hang'), ...byRole('splat'), ...byRole('pool')]
		.map((p)=>[`--pi-p-${p.name}`, webpUri(`art/p-${p.name}.webp`)])),
	// torn paper, slightly feathered
	'--pi-wc-1'       : svgUri(buildArtMask({ seed: 4,  amp: 1,   layers: [[.35, 0], [1, 9]] })),
	// rougher tear, deeper bites
	'--pi-wc-2'       : svgUri(buildArtMask({ seed: 19, amp: 1.8, layers: [[.3, 0], [1, 12]], tears: 9 })),
	// bleed: wide, soft watercolour rim, for unframed art (reference 2)
	'--pi-wc-3'       : svgUri(buildArtMask({ seed: 33, octaves: BLEED, round: 260, tears: 0, step: 10,
		layers: [[.07, 0], [.14, 12], [.22, 24], [.31, 36], [.41, 48], [.52, 60], [.64, 72], [.77, 84], [.9, 96], [1, 108]] })),
	// subtle tear for text boxes: just enough to lose the ruler-straight edge
	'--pi-box-edge'   : svgUri(buildArtMask({ seed: 57, amp: .45, layers: [[1, 0]], tears: 3, tearDepth: [4, 9] })),
	'--pi-ink-frame'  : svgUri(buildInkFrame(71)),
	'--pi-box-frame'  : svgUri(buildInkFrame(83)),
	'--pi-edge'       : svgUri(buildEdgeMask()),
	'--pi-burn'       : svgUri(buildEdgeBurn()),
	'--pi-paper-tile' : webpUri('art/paper.webp'),
	'--pi-stains'     : webpUri('art/stains.webp'),
	'--pi-inkgrain'   : webpUri('art/inkgrain.webp'),
	'--pi-pool-1'     : webpUri('art/wash-1.webp'),
	'--pi-pool-2'     : webpUri('art/wash-2.webp'),
	'--pi-pool-3'     : webpUri('art/wash-3.webp'),
	'--pi-vine'       : webpUri('art/vine.webp'),
	'--pi-plaque'     : webpUri('art/plaque.webp'),
	'--pi-cartouche'  : webpUri('art/cartouche.webp'),
	'--pi-rule'       : svgUri(buildRule()),
	'--pi-arrow'      : svgUri(buildArrow())
});

const block = (lite)=>[
	'/* GENERATED ART  ·  do not hand-edit; see planar-ink/build.mjs ______ */',
	'@font-face {',
	"\tfont-family  : 'Planar Thorn';",
	`\tsrc          : ${fontUri('art/planar-thorn.woff2')};`,
	'\tfont-display : block;',
	'}',
	':root {',
	...Object.entries(buildAssets(lite)).map(([k, v])=>`\t${k.padEnd(18)} : ${v};`),
	'}',
	'/* per-page marginalia & splatter variation (generated) */',
	scatterCss(),
	placedCss()
].join('\n');

const rules = fs.readFileSync(path.join(here, 'rules.css'), 'utf8');
if(!rules.includes('/* @@ASSETS@@ */')) throw new Error('rules.css is missing the /* @@ASSETS@@ */ marker');
for (const [lite, file] of [[false, 'planar-ink.css'], [true, 'planar-ink-lite.css']]) {
	const out  = rules.replace('/* @@ASSETS@@ */', block(lite));
	const dest = path.join(here, '..', file);
	fs.writeFileSync(dest, out);
	console.log(`wrote ${path.relative(process.cwd(), dest)}  (${(out.length / 1024).toFixed(1)} KiB)`);
}
