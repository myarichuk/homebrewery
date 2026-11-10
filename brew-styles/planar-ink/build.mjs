/* ==================================================================
   PLANAR INK  ·  asset generator

   Builds ../planar-ink.css from ./rules.css, injecting every image the
   sheet needs as CSS custom properties at the @@ASSETS@@ marker:

   · art/frame.svg, art/m-*.svg – ink line-work lifted off the
     asset sheet and traced to vectors by extract_marginalia.py.
   · art/p-*.webp, art/frame-*.svg – every other drawing (marginalia,
     glyphs, splatter, crests, corner sets), lifted off the sheets in
     source/ by extract_pieces.py; sizes and roles in art/pieces.json.
   · art/*.webp – the drop-cap wash (extract_marginalia.py); the engraved thorn ornaments
     (vine rule, kicker plaque, cartouche) keyed off the blue sheet by
     extract_ornaments.py. Embedded as base64 WebP.
   · art/planar-thorn.woff2 – the hand-inked display face, traced by
     build_font.py. Embedded as a data-URI @font-face.
   · generated SVG – torn page edge, scorched rim, the watercolour image
     masks, small rules, the text-box border, the hand-ruled table strokes
     and row washes.
   · generated CSS – the per-page marginalia scatter (see "marginalia
     scatter" below).

   The output is a single self-contained sheet you can paste into the
   Homebrewery Style tab. Nothing is fetched except Google Fonts.

       python3 brew-styles/planar-ink/extract_marginalia.py <sheet.jpg>   (only if art changes)
       python3 brew-styles/planar-ink/extract_pieces.py                   (only if art changes)
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
			<use href="#e" stroke="#c9995c" stroke-width="50" opacity=".3" filter="url(#b)"/>
			<use href="#e" stroke="#9a6c3a" stroke-width="5" opacity=".3"/>
			<use href="#e" stroke="#4a2f14" stroke-width="1.4" opacity=".4"/>
		</g>`, 'preserveAspectRatio="none"');
};

/* ---------- artwork masks ------------------------------------------------
   A torn-paper edge for pictures: the art keeps nearly its whole box and
   only the rim is ragged. Several nested polygons at falling opacity give a
   dry, slightly feathered edge without blur filters.

   viewBox 1000 x 1000 with no width/height: no intrinsic size, so the mask
   stretches to any box, and the same image drives shape-outside.          */
const TORN = [[420, 16], [130, 10], [38, 5], [11, 2.4]];      // ragged at every scale
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
	const wob = fbm(seed + 5, [[60, 1.1], [17, .5], [5, .2]]);
	const strokes = [];
	const side = (x0, y0, x1, y1, k)=>{
		const n = 2 + Math.floor(r() * 1.4);
		for (let j = 0; j < n; j++) {
			const o0 = 3 + r() * 10, o1 = 3 + r() * 10;            // overshoot
			const off = (r() - .5) * 2.4;                            // parallel offset
			const len = Math.hypot(x1 - x0, y1 - y0), ux = (x1 - x0) / len, uy = (y1 - y0) / len;
			const pts = [];
			for (let t = -o0; t <= len + o1; t += 6) {
				const w = wob(k * 1000 + j * 333 + t) - .9 + off * .6;
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

/* ---------- paint edge for framed art ----------------------------------
   On the reference panels the watercolour doesn't stop at the ruled line:
   here it runs a few pixels past, there it stops short and leaves a sliver
   of paper inside the frame. So the picture's mask edge has to wander
   around the line, in page pixels, whatever the size of the panel.

   A single stretched mask can't do that (its wobble would scale with the
   box). Instead the mask is five layers, which CSS unions: a plain
   rectangle for the middle, and one strip per side. A strip is THICK px
   deep at a fixed size and stretches only along its length, so its ragged
   outer edge stays in real pixels: the line sits LINE px in from the box
   edge, and the paint edge runs from about 9px past the line to 8px
   short of it. Mostly it hugs the line; now and then it lunges.
   Each strip returns to the line at both ends so the corners meet.       */
const SPILL_THICK = 26, SPILL_LINE = 11.7;
const buildSpillStrip = (seed, vertical)=>{
	const L = 1000, T = SPILL_THICK;
	const small = fbm(seed, [[90, 1.6], [28, .9], [9, .4]]);              // hugging the line
	const lunge = fbm(seed + 50, [[240, 1], [110, .6]]);                   // where it breaks away
	const edge = (x, extra)=>{
		const l = lunge(x) - .8;                                           // about -.8 .. .8
		const far = Math.sign(l) * Math.max(0, Math.abs(l) - .14) * 13;    // dead zone: mostly on the line
		const taper = Math.min(1, x / 30, (L - x) / 30);
		// rest position a pixel outside the line: paint laid up to a line overlaps it
		return Math.max(2.5, Math.min(T - 6, SPILL_LINE + ((small(x) - 1.45) * 1.3 - 1 + far) * taper + extra));
	};
	// two nested shapes: a thin wash that reaches a little further, then the body
	const shape = (extra, op)=>{
		const pts = [];
		for (let x = 0; x <= L; x += 4) pts.push([x, edge(x, extra)]);
		pts.push([L, T], [0, T]);
		const d = pts.map(([a, b])=>(vertical ? `${f(b)} ${f(a)}` : `${f(a)} ${f(b)}`)).join('L');
		return `<path d="M${d}Z"${op < 1 ? ` fill-opacity="${op}"` : ''}/>`;
	};
	const body = shape(-1.3, .5) + shape(0, 1);
	return vertical ? svg(T, L, body, 'preserveAspectRatio="none"', false) : svg(L, T, body, 'preserveAspectRatio="none"', false);
};
// the same strip serves the opposite side, flipped
const flipSvg = (inner, w, h, vertical)=>svg(w, h, `<g transform="${vertical ? `translate(${w} 0) scale(-1 1)` : `translate(0 ${h}) scale(1 -1)`}">${inner}</g>`, 'preserveAspectRatio="none"', false);
const spillSet = (seed)=>{
	const inner = (s_)=>s_.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
	const T = SPILL_THICK, L = 1000;
	return {
		t : svgUri(buildSpillStrip(seed, false)),
		b : svgUri(flipSvg(inner(buildSpillStrip(seed + 1, false)), L, T, false)),
		l : svgUri(buildSpillStrip(seed + 2, true)),
		r : svgUri(flipSvg(inner(buildSpillStrip(seed + 3, true)), T, L, true))
	};
};

/* ---------- table furniture ---------------------------------------------
   A ruled table is the most typeset-looking thing on a page of pen work,
   so its two parts are redrawn by hand:

   stroke   the rule above and below: two or three overlapping pen strokes
            that wobble, vary in weight and overshoot the ends, the same
            hand as the art frames. Stretches along its length only.
   row wash the zebra stripe: one pass of a loaded brush, its long edges
            uneven and its ends ragged, instead of a grey rectangle.
   Plain paths, no filters; both stretch to whatever they are given.      */
const buildStroke = (seed)=>{
	const L = 600, T = 10;
	const r = mulberry32(seed);
	const wob = fbm(seed + 3, [[70, 1.2], [19, .5], [6, .2]]);
	const strokes = [];
	const n = 2 + Math.floor(r() * 1.5);
	for (let j = 0; j < n; j++) {
		const a = j === 0 ? 2 : 4 + r() * 30, b = j === 0 ? L - 2 : L - 4 - r() * 30;
		const off = j === 0 ? 0 : (r() - .5) * 2.6;
		const pts = [];
		for (let x = a; x <= b; x += 6) pts.push([x, T / 2 + wob(j * 400 + x) - .95 + off]);
		strokes.push(`<path d="M${pts.map(([x, y])=>`${f(x)} ${f(y)}`).join('L')}" stroke-width="${f(j === 0 ? 1.9 + r() * .5 : .8 + r() * .7)}" stroke-opacity="${f(j === 0 ? .92 : .5 + r() * .3)}"/>`);
	}
	return svg(L, T, `<g fill="none" stroke="${INK}" stroke-linecap="round" stroke-linejoin="round">${strokes.join('')}</g>`, 'preserveAspectRatio="none"', false);
};

const buildRowWash = (seed)=>{
	const L = 600, T = 40;
	const edge = fbm(seed, [[130, 4.5], [40, 2.2], [12, 1]]);
	const end  = fbm(seed + 9, [[16, 9], [6, 4]]);
	const shape = (inset, op)=>{
		const top = [], bottom = [], left = [], right = [];
		for (let x = 8; x <= L - 8; x += 6) { top.push([x, inset + edge(x)]); bottom.push([x, T - inset - edge(x + 900)]); }
		for (let y = 6; y <= T - 6; y += 3) { right.push([L - 3 - inset - end(y), y]); left.push([3 + inset + end(y + 300), y]); }
		const pts = [...top, ...right, ...bottom.reverse(), ...left.reverse()];
		return `<path d="M${pts.map(([x, y])=>`${f(x)} ${f(y)}`).join('L')}Z" fill-opacity="${op}"/>`;
	};
	// a thin first pass that reaches the edges, a heavier one inside it
	return svg(L, T, `<g fill="#5b5348">${shape(0, .07)}${shape(2.5, .08)}</g>`, 'preserveAspectRatio="none"', false);
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
   output is stable) and dealt out per page with :nth-child cycles.

   A page's scatter is four independent layers, each on its own cycle:

       left margin     11 layouts
       right margin    13 layouts
       bottom margin    7 layouts
       ink splatter     9 sets

   The cycle lengths are pairwise co-prime, so a page's combination comes
   round again only after 11 x 13 x 7 x 9 = 9009 pages, and two pages that
   share a left margin differ on the right and at the foot. Each drawing is
   embedded once; a layout is only a list of image references, positions and
   sizes, so the extra layouts cost about a kilobyte apiece.

   Pieces come from three sheets: the original asset sheet (vector line art
   + a watercolour tone layer, extract_marginalia.py), and the second sheet
   and the labelled pack (bitmaps, extract_pieces.py, sizes in
   art/pieces.json).                                                      */
const manifest = JSON.parse(fs.readFileSync(path.join(here, 'art/pieces.json'), 'utf8'));
const CLASSIC = {
	'skull'   : [55, 56], 'skull-sm' : [32, 36], 'dagger' : [43, 110],
	'compass' : [68, 73], 'orrery'   : [49, 78],
	'splat-a' : [46, 56], 'splat-b'  : [48, 52], 'splat-c' : [42, 42]
};
const CLASSIC_MARG  = ['skull', 'skull-sm', 'dagger', 'compass', 'orrery'];
const CLASSIC_SPLAT = ['splat-a', 'splat-b', 'splat-c'];
// drawn size of the classic pieces in a margin (the sheet sizes above are
// their natural, hand-placed size)
const CLASSIC_W = { 'skull': 58, 'skull-sm': 35, 'dagger': 40, 'compass': 62, 'orrery': 50 };

const classicPiece = (n)=>({
	name   : n,
	w      : CLASSIC[n][0], h : CLASSIC[n][1],
	layers : CLASSIC_MARG.includes(n) ? [`var(--pi-m-${n})`, `var(--pi-m-${n}-tone)`] : [`var(--pi-m-${n})`]
});
const sheetPiece = (n)=>({ name: n, w: manifest.pieces[n].w, h: manifest.pieces[n].h, layers: [`var(--pi-p-${n})`] });

// What a drawing is of. The margins draw a family first, then a piece from
// it, so a family with many drawings (there are a dozen skulls) doesn't
// crowd out the rest: bones turn up on roughly one margin in six.
const FAMILY = {
	bone   : ['skull', 'skull-a', 'skull-b', 'skull-c', 'skull-d', 'skull-horn', 'ram', 'bull', 'bird-a', 'bird-b', 'bone'],
	occult : ['compass', 'compass2', 'orrery', 'circle-a', 'circle-b', 'circle-c', 'rose-a', 'rose-b', 'star-ring', 'sun', 'sigil-a', 'burst-a', 'burst-b', 'stars-c'],
	relic  : ['dagger', 'sword', 'crown-a', 'crown-b', 'shield-a', 'shield-b', 'book-a', 'book-b', 'book-c', 'vial', 'staff', 'banner-a', 'banner-b', 'hand-a', 'hand-b', 'eye-wing', 'beetle', 'fairy', 'mimic'],
	planar : ['portal-a', 'portal-b', 'portal-c', 'moons', 'arrow-a', 'arrow-b', 'arrow-c', 'script']
};
const FAMILY_WEIGHT = { bone: .16, occult: .3, relic: .32, planar: .22 };
// flat drawings that also fit the strip under the text
const CLASSIC_FOOT = ['mimic', 'bird-a', 'bird-b'];

// The pools for one sheet. The lite sheet leaves out the pack drawings
// (pieces.json: lite false), so its layouts are dealt from a smaller deck.
const pools = (lite)=>{
	const have = (n)=>n in CLASSIC || (manifest.pieces[n] && !(lite && manifest.pieces[n].lite === false));
	const piece = (n)=>(n in CLASSIC ? classicPiece(n) : sheetPiece(n));
	const byRole = (role)=>Object.keys(manifest.pieces).filter((n)=>manifest.pieces[n].role === role && have(n)).map(sheetPiece);
	return {
		family : Object.fromEntries(Object.entries(FAMILY).map(([k, names])=>[k, names.filter(have).map(piece)])),
		marg   : [...CLASSIC_MARG.map(classicPiece), ...byRole('marg')],
		glyph  : byRole('glyph'),
		hang   : byRole('hang'),
		foot   : Object.keys(manifest.pieces).filter((n)=>have(n) && (manifest.pieces[n].foot || CLASSIC_FOOT.includes(n))).map(sheetPiece),
		splat  : [...CLASSIC_SPLAT.map(classicPiece), ...byRole('splat')],
		wash   : [...byRole('pool'), ...[1, 2, 3].map((i)=>({ name: `pool-${i}`, w: 70, h: 70, layers: [`var(--pi-pool-${i})`] }))]
	};
};

const CYCLE = { l: 11, r: 13, b: 7, splat: 9 };
const SPLATS_PER_PAGE = 12;
const WASHES_PER_PAGE = 2;

// Where the margins are (page px). The text block is 140px in from each
// side and ends 91px above the foot.
//   band    the strip a margin drawing may sit in; generous on purpose, so
//           pieces land near the torn edge or tuck toward the text instead
//           of lining up in a ruled column
//   pocket  the hollow of the top corner bracket: narrower, clear of the
//           bracket's long arm
const MARGIN_TOP = 244, MARGIN_BOTTOM = 826;     // between the corner brackets
const POCKET_TOP = 118, POCKET_IN = 62;
const BAND = [14, 122];
const FOOT = { y0: 980, y1: 1038, left: [244, 374], right: [442, 572] };     // between the corners, clear of the page number

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
const weighted = (r, weights)=>{
	const entries = Object.entries(weights);
	let t = r() * entries.reduce((acc, [, w])=>acc + w, 0);
	for (const [k, w] of entries) { t -= w; if (t <= 0) return k; }
	return entries[entries.length - 1][0];
};

// flatten placed pieces into the three comma lists CSS wants; an empty
// layer still has to be a valid one
const lists = (placed)=>{
	const img = [], pos = [], size = [];
	for (const { p, x, y, w, h } of placed) {
		for (const layer of p.layers) {
			img.push(layer);
			pos.push(`${f(x)}px ${f(y)}px`);
			size.push(`${f(w)}px ${f(h)}px`);
		}
	}
	if (!img.length) return { img: 'none', pos: '0 0', size: '0 0' };
	return { img: img.join(', '), pos: pos.join(', '), size: size.join(', ') };
};

// A deck that deals every card before it repeats one: over the layouts of
// one margin each drawing turns up once before any turns up twice.
const deck = (r, cards)=>{
	let pile = [];
	return ()=>{
		if (!pile.length) pile = shuffle(r, cards);
		return pile.pop();
	};
};

/* One margin. The reference pages all carried the same furniture in the
   same places (two skulls top left, the dagger sigil low on the left, a
   compass top right): fine for three mockups, a rubber stamp over a book.
   So a margin is now composed afresh each time, from four kinds of thing:

     drawing   one piece, from a family drawn by weight
     twin      the classic pair of skulls, one above the other
     column    2-6 planetary signs and runes, stacked, the gaps uneven
     pendant   a charm hanging from just under the top bracket

   A margin holds 0-4 of them (most often two), anywhere from the pocket of
   the top bracket down to the bottom one, never overlapping. `side` 0 is
   the left margin; the right is the same band mirrored.                  */
const marginSide = (side, count, P, seed)=>{
	const r = mulberry32(seed);
	const draw = Object.fromEntries(Object.entries(P.family).filter(([, v])=>v.length).map(([k, v])=>[k, deck(r, v)]));
	const famW = Object.fromEntries(Object.keys(draw).map((k)=>[k, FAMILY_WEIGHT[k]]));
	const glyph = deck(r, P.glyph), hang = deck(r, P.hang);
	const X = (x, w)=>(side === 0 ? x : W - x - w);          // mirror a left-margin x
	const out = [];
	let lastKinds = [];
	for (let i = 0; i < count; i++) {
		const placed = [], taken = [];
		// a box in left-margin coordinates; null if it found no room
		const fit = (w, h, top = POCKET_TOP)=>{
			for (let tries = 0; tries < 400; tries++) {
				const y = top + r() * (MARGIN_BOTTOM - h - top);
				const x0 = y < MARGIN_TOP ? POCKET_IN : BAND[0] + 4;
				const x1 = BAND[1] - w;
				if (x1 < x0) { if (y < MARGIN_TOP) continue; }
				const x = x1 <= x0 ? x0 : x0 + r() * (x1 - x0);
				const box = [x, y, w, h];
				if (!taken.some((t)=>overlaps(box, t, 22))) { taken.push(box); return box; }
			}
			return null;
		};
		const put = (p, x, y, w)=>placed.push({ p, x: X(x, w), y, w, h: w * p.h / p.w });
		const kinds = {
			drawing : ()=>{
				const p = draw[weighted(r, famW)]();
				const w = (CLASSIC_W[p.name] ?? p.w) * (.94 + r() * .2), h = w * p.h / p.w;
				const box = fit(w, h);
				if (!box) return;
				put(p, box[0], box[1], w);
				if (p.name === 'skull' && r() < .55) {             // the pair, as on the references
					const s = classicPiece('skull-sm'), sw = 35, sh = sw * s.h / s.w;
					const b2 = [box[0] + (r() - .6) * 16, box[1] + h + 6 + r() * 6, sw, sh];
					if (b2[1] + sh < MARGIN_BOTTOM && !taken.some((t)=>t !== box && overlaps(b2, t, 10))) { taken.push(b2); put(s, b2[0], b2[1], sw); }
				}
			},
			column : ()=>{
				const n = 2 + Math.floor(r() * r() * 5);              // mostly short
				const gs = Array.from({ length: n }, ()=>{ const g = glyph(); const w = g.w * (.74 + r() * .18); return { g, w, h: w * g.h / g.w, gap: 5 + r() * 7 }; });
				const cw = Math.max(...gs.map((g)=>g.w)) + 6, ch = gs.reduce((acc, g)=>acc + g.h + g.gap, 0);
				const box = fit(cw, ch);
				if (!box) return;
				let y = box[1];
				for (const { g, w, h, gap } of gs) { put(g, box[0] + (cw - w) / 2 + (r() - .5) * 6, y, w); y += h + gap; }
			},
			lone : ()=>{                                             // one sign, large, set apart
				const g = glyph(), w = g.w * (1.25 + r() * .3), h = w * g.h / g.w;
				const box = fit(w, h, MARGIN_TOP);
				if (box) put(g, box[0], box[1], w);
			},
			pendant : ()=>{
				if (!P.hang.length) return kinds.drawing();
				const p = hang(), w = p.w * (.9 + r() * .12), h = w * p.h / p.w;
				const box = [BAND[0] + 16 + r() * (BAND[1] - w - BAND[0] - 22), MARGIN_TOP - 4 + r() * 10, w, h];
				if (taken.some((t)=>overlaps(box, t, 16))) return;
				taken.push(box); put(p, box[0], box[1], w);
			}
		};
		// how many things, then which; two layouts in a row never open alike
		const n = [0, 1, 1, 2, 2, 2, 2, 3, 3, 3, 4][Math.floor(r() * 11)];
		let seq;
		do { seq = Array.from({ length: n }, ()=>weighted(r, { drawing: .42, column: .36, lone: .12, pendant: .1 })); }
		while (n && seq.join() === lastKinds.join());
		lastKinds = seq;
		// pendants first: they have one place to hang; then big before small
		seq.sort((a, b)=>(a === 'pendant' ? -1 : b === 'pendant' ? 1 : 0));
		for (const k of seq) kinds[k]();
		out.push(lists(placed));
	}
	return out;
};

/* The foot of the page: the strip between the bottom brackets, either side
   of the page number. Two in seven pages leave it empty; the rest get a
   flat drawing (a row of ribs, a crown, an arrow sigil, a line of runes),
   a short row of signs, or one of each.                                  */
const footLayouts = (count, P, seed)=>{
	const r = mulberry32(seed);
	const flat = deck(r, P.foot), glyph = deck(r, P.glyph);
	const out = [];
	const kindsDeck = deck(r, ['none', 'piece', 'row', 'both', 'piece', 'row', 'none'].slice(0, count));
	for (let i = 0; i < count; i++) {
		const placed = [];
		const kind = kindsDeck();
		const sides = shuffle(r, [FOOT.left, FOOT.right]);
		const mid = (FOOT.y0 + FOOT.y1) / 2;
		const piece = ([x0, x1])=>{
			const p = flat();
			let w = Math.min(p.w, x1 - x0 - 6) * (.86 + r() * .14);
			let h = w * p.h / p.w;
			if (h > FOOT.y1 - FOOT.y0 - 8) { const k = (FOOT.y1 - FOOT.y0 - 8) / h; w *= k; h *= k; }
			placed.push({ p, x: x0 + r() * (x1 - x0 - w), y: mid - h / 2 + (r() - .5) * 6, w, h });
		};
		const row = ([x0, x1])=>{
			const n = 2 + Math.floor(r() * 3);
			const gs = Array.from({ length: n }, ()=>{ const g = glyph(); const h = 19 + r() * 5; return { g, h, w: h * g.w / g.h }; });
			const total = gs.reduce((acc, g)=>acc + g.w + 9, -9);
			let x = x0 + r() * Math.max(0, x1 - x0 - total);
			for (const { g, w, h } of gs) {
				if (x + w > x1) break;
				placed.push({ p: g, x, y: mid - h / 2 + (r() - .5) * 5, w, h });
				x += w + 7 + r() * 5;
			}
		};
		if (kind === 'piece' || kind === 'both') piece(sides[0]);
		if (kind === 'row') row(sides[0]);
		if (kind === 'both') row(sides[1]);
		out.push(lists(placed));
	}
	return out;
};

const splatterSet = (i, P)=>{
	const r = mulberry32(SEED ^ (0x5B1A + i * 211));
	const taken = [], placed = [];
	for (let k = 0; k < SPLATS_PER_PAGE; k++) {
		const p = P.splat[Math.floor(r() * P.splat.length)];
		const w = 14 + r() * r() * 48;                          // mostly small, the odd big one
		const h = w * p.h / p.w;
		const s = Math.min(w, 20), sh = s * p.h / p.w;          // only specks at the foot: drawings live there now
		const regions = [
			[...band(0, w), 200, 1010], [...band(1, w), 200, 1010],
			[150, 262 - w, 36, 100], [554, 668 - w, 36, 100]     // top margin, beside the crest, above the title
		];
		const foot = [[240, 372 - s, 990, 1036], [444, 570 - s, 990, 1036]];
		const atFoot = r() < .22;
		const box = atFoot ? place(r, taken, s, sh, foot, 10) : place(r, taken, w, h, regions, 10);
		if (box) placed.push({ p, x: box[0], y: box[1], w: box[2], h: box[3] });
	}
	// grey watercolour pools, like the references' margin stains
	for (let k = 0; k < WASHES_PER_PAGE; k++) {
		const p = P.wash[Math.floor(r() * P.wash.length)];
		const w = 40 + r() * 44, h = w * p.h / p.w;
		// just outside the text block, as the references' stains sit: close
		// enough to read as spilled on the text, not far enough in to land
		// on a picture that fills the measure
		const regions = [[84 - w * .5, 128 - w, 250, 940], [690, 724, 250, 940]];
		const box = place(r, taken, w, h, regions, -w * .3);
		if (box) placed.push({ p, x: box[0], y: box[1], w, h });
	}
	return lists(placed);
};

/* Emitted as: every layout once, as custom properties on :root; then one
   short rule per cycle step pointing a page at its layout; then the
   re-roll classes. \page {roll-N} (N = 1..13) deals that page a different
   hand: a way out when the layout a page was dealt lands on its artwork. */
const scatterCss = (lite)=>{
	const P = pools(lite);
	const layers = {
		l     : marginSide(0, CYCLE.l, P, SEED ^ 0x3A11),
		r     : marginSide(1, CYCLE.r, P, SEED ^ 0x7C35),
		b     : footLayouts(CYCLE.b, P, SEED ^ 0x0F07),
		splat : Array.from({ length: CYCLE.splat }, (_, i)=>splatterSet(i, P))
	};
	const defs = [], rules = [];
	const point = (k, i)=>['img', 'pos', 'size'].map((t)=>`--pi-${k}-${t} : var(--pi-${k}${i}-${t});`).join(' ');
	for (const [k, list] of Object.entries(layers)) {
		list.forEach((l, i)=>defs.push(`\t--pi-${k}${i}-img : ${l.img};\n\t--pi-${k}${i}-pos : ${l.pos};\n\t--pi-${k}${i}-size : ${l.size};`));
		// offset the cycles against each other so page 1 isn't layout 0 of everything
		const shift = { l: 0, r: 5, b: 3, splat: 2 }[k];
		list.forEach((_, i)=>rules.push(`.page:nth-child(${list.length}n+${i + 1}) { ${point(k, (i + shift) % list.length)} }`));
	}
	for (let n = 1; n <= 13; n++) {
		rules.push(`.page.roll-${n} { ${point('l', (n * 3 + 1) % CYCLE.l)} ${point('r', (n * 5 + 2) % CYCLE.r)} ${point('b', (n * 2 + 1) % CYCLE.b)} ${point('splat', (n * 4) % CYCLE.splat)} }`);
	}
	return `:root {\n${defs.join('\n')}\n}\n${rules.join('\n')}`;
};

// Hand-placed pieces: every drawing in the pools as a class on an empty
// block, placed like Homebrewery's stock watercolour stains:
//     {{marg,ram,top:14cm,left:.4cm}}
// Natural size by default; width (or --marg-w) scales it, height follows.
const placedCss = (lite)=>{
	const P = pools(lite);
	const seen = new Set(), out = [];
	for (const p of [...P.marg, ...P.hang, ...P.glyph, ...P.splat, ...P.wash]) {
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
                          rule only, and the marginalia of the first two
                          sheets (no pack drawings): about half the size,
                          for a lighter Style tab. Same scatter scheme,
                          dealt from the smaller deck. Classes for the
                          missing options just draw nothing.               */

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
	...Object.fromEntries(Object.keys(manifest.pieces)
		.filter((n)=>['marg', 'hang', 'glyph', 'splat', 'pool'].includes(manifest.pieces[n].role) && !(lite && manifest.pieces[n].lite === false))
		.map((n)=>[`--pi-p-${n}`, webpUri(`art/p-${n}.webp`)])),
	// torn paper, slightly feathered
	'--pi-wc-1'       : svgUri(buildArtMask({ seed: 4,  amp: 1,   layers: [[.35, 0], [1, 9]] })),
	// rougher tear, deeper bites
	'--pi-wc-2'       : svgUri(buildArtMask({ seed: 19, amp: 1.8, layers: [[.3, 0], [1, 12]], tears: 9 })),
	// bleed: wide, soft watercolour rim, for unframed art (reference 2).
	// A pre-rendered alpha bitmap (make_paper.py): soft, and it prints.
	'--pi-wc-3'       : webpUri('art/bleed.webp'),
	// subtle tear for text boxes: just enough to lose the ruler-straight edge
	'--pi-box-edge'   : svgUri(buildArtMask({ seed: 57, amp: .45, layers: [[1, 0]], tears: 3, tearDepth: [4, 9] })),
	...Object.fromEntries(Object.entries(spillSet(401)).map(([k, v])=>[`--pi-spill-${k}`, v])),
	...Object.fromEntries(Object.entries(spillSet(477)).map(([k, v])=>[`--pi-spill2-${k}`, v])),
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
	'--pi-capblot'    : webpUri('art/capblot.webp'),
	'--pi-vine'       : webpUri('art/vine.webp'),
	'--pi-plaque'     : webpUri('art/plaque.webp'),
	'--pi-cartouche'  : webpUri('art/cartouche.webp'),
	'--pi-stroke-1'   : svgUri(buildStroke(211)),
	'--pi-stroke-2'   : svgUri(buildStroke(223)),
	'--pi-row-1'      : svgUri(buildRowWash(301)),
	'--pi-row-2'      : svgUri(buildRowWash(317)),
	'--pi-row-3'      : svgUri(buildRowWash(331)),
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
	scatterCss(lite),
	placedCss(lite)
].join('\n');

const rules = fs.readFileSync(path.join(here, 'rules.css'), 'utf8');
if(!rules.includes('/* @@ASSETS@@ */')) throw new Error('rules.css is missing the /* @@ASSETS@@ */ marker');
for (const [lite, file] of [[false, 'planar-ink.css'], [true, 'planar-ink-lite.css']]) {
	const out  = rules.replace('/* @@ASSETS@@ */', block(lite));
	const dest = path.join(here, '..', file);
	fs.writeFileSync(dest, out);
	console.log(`wrote ${path.relative(process.cwd(), dest)}  (${(out.length / 1024).toFixed(1)} KiB)`);
}
