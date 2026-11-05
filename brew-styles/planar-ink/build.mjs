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

const wobble = (id, scale = 2.2, freq = 0.035, seed = 3)=>`
	<filter id="${id}" x="-5%" y="-5%" width="110%" height="110%">
		<feTurbulence type="fractalNoise" baseFrequency="${freq}" numOctaves="2" seed="${seed}" result="n"/>
		<feDisplacementMap in="SourceGraphic" in2="n" scale="${scale}" xChannelSelector="R" yChannelSelector="G"/>
	</filter>`;

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

// unsteady ink rectangle – border-image for text boxes (notes, stat blocks)
const buildInkBox = ()=>svg(120, 120, `
	${wobble('w', 3, 0.06, 6)}
	<g fill="none" stroke="${INK}" filter="url(#w)" stroke-linecap="round">
		<rect x="10" y="10" width="100" height="100" stroke-width="2.2"/>
		<path d="M4,10.5 L14,10.5 M106,9.5 L116,9.5 M9.5,104 L10.5,116 M110,4 L110.5,16" stroke-width="1.2"/>
	</g>`);

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
   co-prime length: 3 marginalia layouts x 5 splatter sets x 4 small offsets
   repeat only every 60 pages. Each drawing is embedded once; a layout is
   just a list of background positions and sizes for the ::after overlay.

   Sizes are the pieces' CSS px sizes (see extract_marginalia.py PIECES).   */
const PIECE = {
	'skull'   : [55, 56], 'skull-sm' : [32, 36], 'dagger' : [43, 110],
	'compass' : [68, 73], 'orrery'   : [49, 78],
	'splat-a' : [46, 56], 'splat-b'  : [48, 52], 'splat-c' : [42, 42]
};
const MARG  = ['skull', 'skull-sm', 'dagger', 'compass', 'orrery'];
const SPLAT = ['splat-a', 'splat-b', 'splat-c'];
const SPLATS_PER_PAGE = 7;
const WASHES_PER_PAGE = 2;

// left / right margin bands between the corner brackets (page px)
const band = (side, w)=>(side === 0 ? [26, 104 - w] : [714, 792 - w]);

const overlaps = (a, b, gap)=>a[0] < b[0] + b[2] + gap && b[0] < a[0] + a[2] + gap && a[1] < b[1] + b[3] + gap && b[1] < a[1] + a[3] + gap;

const place = (r, taken, w, h, regions, gap)=>{
	for (let tries = 0; tries < 400; tries++) {
		const [x0, x1, y0, y1] = regions[Math.floor(r() * regions.length)];
		const box = [x0 + r() * Math.max(0, x1 - x0), y0 + r() * Math.max(0, y1 - y0 - h), w, h];
		if (!taken.some((t)=>overlaps(box, t, gap))) { taken.push(box); return box; }
	}
	throw new Error('marginalia: no room left');
};

const marginaliaLayouts = (count)=>Array.from({ length: count }, (_, i)=>{
	const r = mulberry32(SEED ^ (0x3A11 + i * 101));
	const taken = [];
	// the skulls travel together; everything else picks a side at random
	const skullSide = i % 2;
	return MARG.map((name)=>{
		const [w, h] = PIECE[name];
		const side = name.startsWith('skull') ? skullSide : (r() < .5 ? 0 : 1);
		const [x0, x1] = band(side, w);
		const near = name === 'skull-sm' ? taken[0] : null;     // small skull tucks under the big one
		const regions = near ? [[near[0] + 4, near[0] + 22, near[1] + near[3] + 4, near[1] + near[3] + h + 30]] : [[x0, x1, 240, 900]];
		const [x, y] = place(r, taken, w, h, regions, near ? 2 : 26);
		return `${f(x)}px ${f(y)}px, ${f(x)}px ${f(y)}px`;        // line, then its wash
	}).join(', ');
});

const splatterSets = (count)=>Array.from({ length: count }, (_, i)=>{
	const r = mulberry32(SEED ^ (0x5B1A + i * 211));
	const taken = [];
	const layers = Array.from({ length: SPLATS_PER_PAGE }, ()=>{
		const name = SPLAT[Math.floor(r() * SPLAT.length)];
		const [pw, ph] = PIECE[name];
		const w = 14 + r() * r() * 50;                         // mostly small, the odd big one
		const h = w * ph / pw;
		const regions = [
			[...band(0, w), 200, 1010], [...band(1, w), 200, 1010],
			[240, 560 - w, 990, 1036],                          // bottom margin, between corners
			[150, 270 - w, 118, 196], [548, 668 - w, 118, 196]  // top margin, beside the crest
		];
		const [x, y] = place(r, taken, w, h, regions, 10);
		return { img: `var(--pi-m-${name})`, pos: `${f(x)}px ${f(y)}px`, size: `${f(w)}px ${f(h)}px` };
	});
	// soft grey watercolour pools, like the references' margin stains
	for (let k = 0; k < WASHES_PER_PAGE; k++) {
		const w = 46 + r() * 74, h = w;
		const regions = [[...band(0, w * .7), 230, 960], [...band(1, w * .7), 230, 960]];
		const [x, y] = place(r, taken, w, h, regions, -w * .3);
		layers.push({ img: `var(--pi-pool-${1 + Math.floor(r() * 3)})`, pos: `${f(x)}px ${f(y)}px`, size: `${f(w)}px ${f(h)}px` });
	}
	return {
		img  : layers.map((l)=>l.img).join(', '),
		pos  : layers.map((l)=>l.pos).join(', '),
		size : layers.map((l)=>l.size).join(', ')
	};
});

const scatterCss = ()=>{
	const out = [];
	marginaliaLayouts(3).forEach((pos, i)=>out.push(`.page:nth-child(3n+${i + 1}) { --pi-marg-pos : ${pos}; }`));
	splatterSets(5).forEach((s, i)=>out.push(`.page:nth-child(5n+${i + 1}) {\n\t--pi-splat-img  : ${s.img};\n\t--pi-splat-pos  : ${s.pos};\n\t--pi-splat-size : ${s.size};\n}`));
	[[0, 0], [5, -7], [-4, 6], [6, 4]].forEach(([x, y], i)=>out.push(`.page:nth-child(4n+${i + 1})::after { translate : ${x}px ${y}px; }`));
	return out.join('\n');
};

/* ---------- emit --------------------------------------------------------- */

const assets = {
	'--pi-frame'      : svgUri(fs.readFileSync(path.join(here, 'art/frame.svg'), 'utf8')),
	...Object.fromEntries(['skull', 'skull-sm', 'dagger', 'compass', 'orrery', 'splat-a', 'splat-b', 'splat-c']
		.map((n)=>[`--pi-m-${n}`, svgUri(fs.readFileSync(path.join(here, `art/m-${n}.svg`), 'utf8'))])),
	...Object.fromEntries(MARG.map((n)=>[`--pi-m-${n}-tone`, webpUri(`art/m-${n}-tone.webp`)])),
	// torn paper, slightly feathered
	'--pi-wc-1'       : svgUri(buildArtMask({ seed: 4,  amp: 1,   layers: [[.35, 0], [1, 9]] })),
	// rougher tear, deeper bites
	'--pi-wc-2'       : svgUri(buildArtMask({ seed: 19, amp: 1.8, layers: [[.3, 0], [1, 12]], tears: 9 })),
	// bleed: wide, soft watercolour rim, for unframed art (reference 2)
	'--pi-wc-3'       : svgUri(buildArtMask({ seed: 33, octaves: BLEED, round: 260, tears: 0, step: 10,
		layers: [[.07, 0], [.14, 12], [.22, 24], [.31, 36], [.41, 48], [.52, 60], [.64, 72], [.77, 84], [.9, 96], [1, 108]] })),
	'--pi-ink-frame'  : svgUri(buildInkFrame(71)),
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
	'--pi-inkbox'     : svgUri(buildInkBox()),
	'--pi-rule'       : svgUri(buildRule()),
	'--pi-arrow'      : svgUri(buildArrow())
};

const block = [
	'/* GENERATED ART  ·  do not hand-edit; see planar-ink/build.mjs ______ */',
	'@font-face {',
	"\tfont-family  : 'Planar Thorn';",
	`\tsrc          : ${fontUri('art/planar-thorn.woff2')};`,
	'\tfont-display : block;',
	'}',
	':root {',
	...Object.entries(assets).map(([k, v])=>`\t${k.padEnd(16)} : ${v};`),
	'}',
	'/* per-page marginalia & splatter variation (generated) */',
	scatterCss()
].join('\n');

const rules = fs.readFileSync(path.join(here, 'rules.css'), 'utf8');
if(!rules.includes('/* @@ASSETS@@ */')) throw new Error('rules.css is missing the /* @@ASSETS@@ */ marker');
const out  = rules.replace('/* @@ASSETS@@ */', block);
const dest = path.join(here, '..', 'planar-ink.css');
fs.writeFileSync(dest, out);
console.log(`wrote ${path.relative(process.cwd(), dest)}  (${(out.length / 1024).toFixed(1)} KiB)`);
