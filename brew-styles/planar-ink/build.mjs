/* ==================================================================
   PLANAR INK  ·  asset generator

   Builds ../planar-ink.css from ./rules.css by generating every piece of
   line art (frame, corner thorns, crown ornament, margin sigils, skulls,
   ink splatter, torn page edge) as inline SVG and injecting it as CSS
   custom properties at the @@ASSETS@@ marker.

   The output is a single self-contained sheet you can paste into the
   Homebrewery Style tab. Nothing is fetched except Google Fonts.

       node brew-styles/planar-ink/build.mjs

   Page geometry is fixed: a V3 page is 215.9 x 279.4 mm = 816 x 1056 CSS px,
   so the overlays are drawn 1:1 in page pixels and never scaled.

   Splatter / edge randomness is seeded: rebuilding yields byte-identical
   output. Change SEED to re-roll the whole look.
   ================================================================== */

import fs   from 'node:fs';
import path from 'node:path';
import url  from 'node:url';

const here  = path.dirname(url.fileURLToPath(import.meta.url));
const W     = 816;
const H     = 1056;
const SEED  = 0x5161;   // "Sigil", more or less
const INK   = '#1d1712';
const WASH  = '#5b5348';

/* ---------- utilities ---------------------------------------------------- */

const mulberry32 = (a)=>()=>{
	a |= 0; a = a + 0x6D2B79F5 | 0;
	let t = Math.imul(a ^ a >>> 15, 1 | a);
	t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
	return ((t ^ t >>> 14) >>> 0) / 4294967296;
};
const rnd   = mulberry32(SEED);
const range = (lo, hi)=>lo + (hi - lo) * rnd();
const f     = (n)=>(Math.round(n * 10) / 10).toString();

// Minimal, safe data-URI encoding: keep it readable-ish and short.
const dataUri = (svg)=>{
	const min = svg.replace(/\s+/g, ' ').replace(/> </g, '><').replace(/"/g, '\'').trim();
	const enc = min
		.replace(/%/g, '%25')
		.replace(/#/g, '%23')
		.replace(/</g, '%3C')
		.replace(/>/g, '%3E')
		.replace(/\{/g, '%7B')
		.replace(/\}/g, '%7D')
		.replace(/"/g, '%22');
	return `url("data:image/svg+xml,${enc}")`;
};

const svg = (w, h, body, extra = '')=>`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" ${extra}>${body}</svg>`;

// A hand-inked wobble: line art never sits perfectly straight.
const wobble = (id, scale = 2.2, freq = 0.035, seed = 3)=>`
	<filter id="${id}" x="-5%" y="-5%" width="110%" height="110%">
		<feTurbulence type="fractalNoise" baseFrequency="${freq}" numOctaves="2" seed="${seed}" result="n"/>
		<feDisplacementMap in="SourceGraphic" in2="n" scale="${scale}" xChannelSelector="R" yChannelSelector="G"/>
	</filter>`;

/* ---------- torn page edge ---------------------------------------------- */
// One polygon, reused for the alpha mask and for the browned rim, so the
// scorch always follows the tear exactly.

const tornPolygon = ()=>{
	const r   = mulberry32(SEED ^ 0xED6E);
	const pts = [];
	const nick = ()=>(r() < 0.06 ? 5 + r() * 9 : 0);           // occasional bite
	const jit  = ()=>1.5 + r() * 4.5 + nick();
	const step = 9;
	for (let x = 0; x <= W; x += step) pts.push([x, jit()]);
	for (let y = step; y <= H; y += step) pts.push([W - jit(), y]);
	for (let x = W - step; x >= 0; x -= step) pts.push([x, H - jit()]);
	for (let y = H - step; y > 0; y -= step) pts.push([jit(), y]);
	// chip the corners – real paper loses its corners first
	const chip = [[0, 0, 1, 1], [W, 0, -1, 1], [W, H, -1, -1], [0, H, 1, -1]];
	return { pts, chip };
};

const edgeShape = ()=>{
	const { pts, chip } = tornPolygon();
	const d = `M${pts.map(([x, y])=>`${f(x)},${f(y)}`).join('L')}Z`;
	const corners = chip.map(([cx, cy, sx, sy], i)=>{
		const a = 10 + i * 3;
		return `M${cx},${cy}L${cx + sx * (a + 6)},${cy}L${cx},${cy + sy * (a + 2)}Z`;
	}).join('');
	return { d, corners };
};

const buildEdgeMask = ()=>{
	const { d, corners } = edgeShape();
	return svg(W, H, `
		<filter id="t" x="0" y="0" width="100%" height="100%">
			<feTurbulence type="fractalNoise" baseFrequency=".09" numOctaves="3" seed="7" result="n"/>
			<feDisplacementMap in="SourceGraphic" in2="n" scale="5"/>
		</filter>
		<mask id="m"><rect width="${W}" height="${H}" fill="#fff"/><path d="${corners}" fill="#000"/></mask>
		<path d="${d}" fill="#000" filter="url(#t)" mask="url(#m)"/>`, 'preserveAspectRatio="none"');
};

const buildEdgeBurn = ()=>{
	const { d } = edgeShape();
	return svg(W, H, `
		<filter id="b" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="16"/></filter>
		<filter id="s" x="-5%" y="-5%" width="110%" height="110%">
			<feTurbulence type="fractalNoise" baseFrequency=".09" numOctaves="3" seed="7" result="n"/>
			<feDisplacementMap in="SourceGraphic" in2="n" scale="5" result="d"/>
			<feGaussianBlur in="d" stdDeviation="1.4"/>
		</filter>
		<clipPath id="c"><path d="${d}"/></clipPath>
		<g clip-path="url(#c)" fill="none">
			<path d="${d}" stroke="#8a5e2c" stroke-width="56" opacity=".42" filter="url(#b)"/>
			<path d="${d}" stroke="#5a3a1a" stroke-width="6" opacity=".45" filter="url(#s)"/>
		</g>`, 'preserveAspectRatio="none"');
};

/* ---------- the frame: border, corner thorns, crown ---------------------- */

const IN  = 34;          // outer rule inset from page edge
const IN2 = IN + 7;      // inner hairline

// Half a corner flourish, drawn for the top-left corner along the top edge.
// The other half is the same thing reflected across the diagonal.
const cornerHalf = `
	<path d="M10,10 C42,8 70,14 96,4 C110,-1 122,8 116,18 C111,26 100,22 103,15" fill="none" stroke-width="1.7"/>
	<path d="M18,12 C36,16 52,28 60,46" fill="none" stroke-width="1.1"/>
	<path d="M44,10 L49,1 L52,10 Z M70,11 L76,0 L79,10 Z"/>
	<path d="M124,6 C134,3 142,6 150,4" fill="none" stroke-width="1"/>
	<circle cx="156" cy="4" r="1.6"/>`;

const corner = `
	<g>
		${cornerHalf}
		<g transform="matrix(0 1 1 0 0 0)">${cornerHalf}</g>
		<path d="M0,0 L26,26" stroke-width="2.2"/>
		<path d="M26,26 m-7,0 l7,-7 l7,7 l-7,7 Z" fill="none" stroke-width="1.4"/>
		<circle cx="26" cy="26" r="2.2"/>
		<path d="M30,18 C46,22 52,40 40,44" fill="none" stroke-width="1"/>
		<path d="M18,30 C22,46 40,52 44,40" fill="none" stroke-width="1"/>
	</g>`;

const crownHalf = `
	<path d="M408,${IN - 2} C372,${IN - 3} 330,${IN - 9} 262,${IN + 1} C330,${IN - 1} 372,${IN + 5} 408,${IN + 5} Z"/>
	<path d="M400,${IN + 4} C384,${IN + 14} 366,${IN + 6} 370,${IN - 6} C373,${IN - 14} 386,${IN - 12} 386,${IN - 5} C386,${IN} 380,${IN} 379,${IN - 4}" fill="none" stroke-width="1.6"/>
	<path d="M403,${IN - 6} C390,${IN - 16} 378,${IN - 30} 360,${IN - 24} C374,${IN - 22} 386,${IN - 10} 398,${IN + 2} Z"/>
	<path d="M396,${IN + 8} C386,${IN + 18} 380,${IN + 30} 384,${IN + 40}" fill="none" stroke-width="1.1"/>
	<circle cx="350" cy="${IN}" r="2"/><circle cx="338" cy="${IN + 1}" r="1.3"/><circle cx="252" cy="${IN + 1}" r="1.4"/>`;

const crown = `
	${crownHalf}
	<g transform="translate(816 0) scale(-1 1)">${crownHalf}</g>
	<path d="M408,${IN - 18} C399,${IN - 6} 398,${IN + 16} 408,${IN + 38} C418,${IN + 16} 417,${IN - 6} 408,${IN - 18} Z"/>
	<path d="M408,${IN - 18} L403,${IN - 30} L408,${IN - 25} L413,${IN - 30} Z"/>
	<path d="M408,${IN - 4} L404,${IN + 6} L408,${IN + 14} L412,${IN + 6} Z" fill="#e9dcbd"/>
	<circle cx="408" cy="${IN + 44}" r="1.8"/>`;

// small foot ornament the page number sits in
const foot = `
	<path d="M408,${H - IN - 9} l7,9 l-7,9 l-7,-9 Z" fill="none" stroke-width="1.2"/>
	<path d="M392,${H - IN} C370,${H - IN - 2} 344,${H - IN - 6} 316,${H - IN} C344,${H - IN + 4} 370,${H - IN + 2} 392,${H - IN + 2} Z"/>
	<path d="M424,${H - IN} C446,${H - IN - 2} 472,${H - IN - 6} 500,${H - IN} C472,${H - IN + 4} 446,${H - IN + 2} 424,${H - IN + 2} Z"/>`;

const buildFrame = ()=>svg(W, H, `
	${wobble('w', 2.4, 0.03, 4)}
	<g fill="${INK}" stroke="${INK}" stroke-linecap="round" stroke-linejoin="round" filter="url(#w)" opacity=".92">
		<rect x="${IN}" y="${IN}" width="${W - 2 * IN}" height="${H - 2 * IN}" fill="none" stroke-width="1.8"/>
		<rect x="${IN2}" y="${IN2}" width="${W - 2 * IN2}" height="${H - 2 * IN2}" fill="none" stroke-width=".7" opacity=".7"/>
		<g transform="translate(${IN - 4} ${IN - 4})">${corner}</g>
		<g transform="translate(${W - IN + 4} ${IN - 4}) scale(-1 1)">${corner}</g>
		<g transform="translate(${IN - 4} ${H - IN + 4}) scale(1 -1)">${corner}</g>
		<g transform="translate(${W - IN + 4} ${H - IN + 4}) scale(-1 -1)">${corner}</g>
		${crown}
		${foot}
	</g>`);

/* ---------- margin sigils & skulls -------------------------------------- */
// Invented glyphs in the spirit of alchemical / planar notation. Each is drawn
// in a ~40px box centred on (0,0) and placed with a transform.

const G = {
	skull : `
		<path d="M0,-40 C-23,-40 -36,-23 -35,-3 C-34,9 -28,15 -24,19 L-22,30 L-12,32 L-10,40 L10,40 L12,32 L22,30 L24,19 C28,15 34,9 35,-3 C36,-23 23,-40 0,-40 Z" fill="#e7d8b6" stroke-width="1.8"/>
		<path d="M-20,-30 C-28,-20 -30,-8 -28,4 M-24,-26 l-2,8 M-19,-34 l-3,7" fill="none" stroke-width=".8"/>
		<path d="M-6,-39 L-9,-28 L-4,-22 L-8,-14" fill="none" stroke-width=".9"/>
		<path d="M-23,-2 C-23,-12 -7,-13 -6,-3 C-5,7 -11,11 -16,10 C-21,9 -23,4 -23,-2 Z"/>
		<path d="M23,-2 C23,-12 7,-13 6,-3 C5,7 11,11 16,10 C21,9 23,4 23,-2 Z"/>
		<path d="M0,10 L-5,20 L0,18 L5,20 Z"/>
		<path d="M-10,32 L-10,40 M-4,31 L-4,40 M2,31 L2,40 M8,32 L8,40 M-14,30 C-5,33 5,33 14,30" fill="none" stroke-width="1"/>`,
	crescentStaff : `
		<path d="M-2,-46 A15,15 0 1,0 14,-24 A11,11 0 1,1 -2,-46 Z"/>
		<path d="M2,-22 C-6,-8 8,2 0,16 C-6,28 6,36 -1,50 C-4,56 -2,62 2,64" fill="none" stroke-width="2.2"/>
		<path d="M0,16 C8,12 14,16 12,22 M-1,34 C-9,30 -14,34 -11,40" fill="none" stroke-width="1.2"/>`,
	hookX : `
		<path d="M-14,-14 L14,14 M14,-14 L-14,14 M-18,0 L-10,0 M10,0 L18,0 M0,-20 C6,-16 6,-10 0,-6" fill="none" stroke-width="1.8"/>`,
	pct : `
		<path d="M-12,14 L12,-14" fill="none" stroke-width="1.8"/>
		<circle cx="-9" cy="-9" r="4" fill="none" stroke-width="1.6"/><circle cx="9" cy="9" r="4" fill="none" stroke-width="1.6"/>`,
	knotHook : `
		<circle cx="-2" cy="-10" r="7" fill="none" stroke-width="1.8"/>
		<path d="M-2,-3 L-2,12 M-9,4 L5,4 M-2,12 C-2,20 8,20 10,14" fill="none" stroke-width="1.8"/>
		<circle cx="-2" cy="20" r="2.4"/>`,
	dagger : `
		<path d="M-18,-66 C-12,-48 12,-48 18,-66" fill="none" stroke-width="2.4"/>
		<circle cx="0" cy="-46" r="9" fill="none" stroke-width="2.4"/>
		<path d="M0,-37 L0,-26" fill="none" stroke-width="2.4"/>
		<path d="M-16,-24 L16,-24 L13,-19 L-13,-19 Z"/>
		<path d="M-5,-18 L0,66 L5,-18 Z"/>
		<path d="M-16,-24 C-22,-22 -24,-16 -20,-12 M16,-24 C22,-22 24,-16 20,-12" fill="none" stroke-width="1.4"/>
		<path d="M-6,4 L-12,10 M6,4 L12,10" fill="none" stroke-width="1.2"/>`,
	compass : `
		<circle r="12" fill="none" stroke-width="1.3"/><circle r="3"/>
		<path d="M0,-40 L3,-12 L0,-8 L-3,-12 Z M0,40 L3,12 L0,8 L-3,12 Z M-40,0 L-12,3 L-8,0 L-12,-3 Z M40,0 L12,3 L8,0 L12,-3 Z"/>
		<path d="M-24,-24 L-9,-9 M24,-24 L9,-9 M-24,24 L-9,9 M24,24 L9,9" fill="none" stroke-width="1.2"/>
		<circle cx="-26" cy="-26" r="2.4" fill="none" stroke-width="1"/><circle cx="26" cy="-26" r="2.4" fill="none" stroke-width="1"/>
		<circle cx="-26" cy="26" r="2.4" fill="none" stroke-width="1"/><circle cx="26" cy="26" r="2.4" fill="none" stroke-width="1"/>
		<path d="M-6,-46 L0,-52 L6,-46" fill="none" stroke-width="1.2"/>`,
	pentacle : `
		<circle r="30" fill="none" stroke-width="1.4"/><circle r="25" fill="none" stroke-width=".7"/>
		<path d="M0,-25 L14.7,20.2 L-23.8,-7.7 L23.8,-7.7 L-14.7,20.2 Z" fill="none" stroke-width="1.1"/>
		<path d="M0,-30 L0,-40 M30,0 L40,0 M-30,0 L-40,0 M0,30 L0,40 M21,-21 L28,-28 M-21,21 L-28,28 M21,21 L28,28 M-21,-21 L-28,-28" fill="none" stroke-width="1"/>
		<path d="M28,-28 l7,-1 l-1,7 M-28,28 l-7,1 l1,-7" fill="none" stroke-width="1"/>
		<circle cx="0" cy="-44" r="2"/><circle cx="44" cy="0" r="1.6"/>`,
	mars : `
		<circle cx="-4" cy="4" r="9" fill="none" stroke-width="2.2"/>
		<path d="M3,-3 L14,-14 M6,-14 L14,-14 L14,-6" fill="none" stroke-width="2.2"/>`,
	triBar : `
		<path d="M-12,-14 L12,-14 M-14,-6 L14,-6 L0,16 Z" fill="none" stroke-width="2"/>`,
	cup : `
		<path d="M-12,-16 L12,-16 L8,6 L-8,6 Z M0,6 L0,16 M-9,16 L9,16 M-4,-24 L4,-24" fill="none" stroke-width="2"/>`,
	coil : `
		<circle cx="0" cy="-10" r="7" fill="none" stroke-width="2"/>
		<path d="M0,-3 C-10,2 10,8 0,14 C-6,18 -2,24 4,24" fill="none" stroke-width="2"/>`,
	fork : `
		<path d="M-8,-16 L-8,6 M8,-16 L8,6 M-12,6 L12,6 M0,6 L0,18 M-6,18 L6,18" fill="none" stroke-width="2"/>`,
	three : `
		<path d="M-10,-16 L10,-16 L-2,-2 C14,-2 14,18 -8,18" fill="none" stroke-width="2.2"/>`,
	twoHook : `
		<path d="M-12,-30 C0,-44 22,-34 10,-18 C2,-8 -8,-6 -6,2 M-8,-14 C-14,-12 -14,-4 -8,-4" fill="none" stroke-width="2.4"/>
		<path d="M-12,10 C0,-2 20,6 10,18 C2,26 -14,30 -10,40 L14,40" fill="none" stroke-width="2.4"/>`,
	triCorner : `
		<path d="M-14,-12 L14,-12 L0,14 Z" fill="none" stroke-width="1.6"/>
		<path d="M-6,-4 L6,-4 M0,-12 L0,4" fill="none" stroke-width="1.1"/>`,
	eye : `
		<circle r="14" fill="none" stroke-width="1.5"/>
		<path d="M-10,0 C-4,-7 4,-7 10,0 C4,7 -4,7 -10,0 Z" fill="none" stroke-width="1.3"/>
		<circle r="2.6"/>
		<path d="M0,-14 L0,-20 M-10,-10 L-14,-14 M10,-10 L14,-14" fill="none" stroke-width="1"/>`
};

const put = (glyph, x, y, s = 1, rot = 0)=>`<g transform="translate(${x} ${y}) rotate(${rot}) scale(${s})">${G[glyph]}</g>`;

const buildSigils = ()=>svg(W, H, `
	${wobble('w', 1.6, 0.05, 9)}
	<filter id="wash" x="-50%" y="-50%" width="200%" height="200%">
		<feTurbulence type="fractalNoise" baseFrequency=".06" numOctaves="3" seed="2" result="n"/>
		<feDisplacementMap in="SourceGraphic" in2="n" scale="18"/>
		<feGaussianBlur stdDeviation="3"/>
	</filter>
	<g fill="${WASH}" filter="url(#wash)" opacity=".22">
		<ellipse cx="112" cy="282" rx="16" ry="20"/>
		<ellipse cx="70" cy="905" rx="14" ry="22"/>
		<ellipse cx="742" cy="690" rx="10" ry="14"/>
	</g>
	<g fill="${INK}" stroke="${INK}" stroke-linecap="round" stroke-linejoin="round" filter="url(#w)" opacity=".86">
		${put('skull', 78, 172, 0.62, -6)}
		${put('skull', 66, 224, 0.46, 4)}
		${put('crescentStaff', 70, 326, 0.78)}
		${put('hookX', 70, 418, 0.8)}
		${put('pct', 66, 456, 0.8, -8)}
		${put('knotHook', 70, 496, 0.9)}
		${put('dagger', 66, 786, 0.95)}
		${put('triCorner', 70, 948, 0.8)}

		${put('compass', 748, 138, 0.82)}
		${put('pentacle', 748, 222, 0.85)}
		${put('mars', 748, 332, 0.9)}
		${put('triBar', 748, 376, 0.8)}
		${put('cup', 748, 424, 0.85)}
		${put('coil', 748, 474, 0.85)}
		${put('fork', 748, 524, 0.8)}
		${put('three', 750, 574, 0.95)}
		${put('twoHook', 750, 748, 0.9)}
		${put('eye', 748, 948, 0.8)}
	</g>`);

/* ---------- ink splatter ------------------------------------------------- */

const cluster = (cx, cy, size, angle = rnd() * 360, spread = 70)=>{
	let out = '';
	const main = size * range(0.7, 1.1);
	out += `<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(main)}" ry="${f(main * range(0.75, 1))}"/>`;
	const n = Math.round(range(6, 16) * Math.min(1.4, size / 5));
	for (let i = 0; i < n; i++) {
		const a  = (angle + range(-spread, spread)) * Math.PI / 180;
		const d  = main * range(1.4, 6.5);
		const r  = Math.max(0.5, main * range(0.08, 0.45) * (1 - d / (main * 8)));
		out += `<circle cx="${f(cx + Math.cos(a) * d)}" cy="${f(cy + Math.sin(a) * d)}" r="${f(r)}"/>`;
	}
	if (rnd() < 0.55) { // a flick / streak away from the blot
		const a  = angle + range(-20, 20);
		const len = main * range(2, 4);
		const ar = a * Math.PI / 180;
		out += `<ellipse cx="${f(cx + Math.cos(ar) * len / 2)}" cy="${f(cy + Math.sin(ar) * len / 2)}" rx="${f(len / 2)}" ry="${f(main * 0.18 + 0.4)}" transform="rotate(${f(a)} ${f(cx + Math.cos(ar) * len / 2)} ${f(cy + Math.sin(ar) * len / 2)})"/>`;
	}
	return out;
};

const dust = (x0, y0, x1, y1, n, rmax = 1.6)=>{
	let out = '';
	for (let i = 0; i < n; i++) out += `<circle cx="${f(range(x0, x1))}" cy="${f(range(y0, y1))}" r="${f(range(0.4, rmax))}"/>`;
	return out;
};

const buildSplatter = (mirror = false)=>{
	const body = [
		cluster(46, 560, 8, 30), cluster(58, 610, 5, 200), cluster(30, 640, 4), cluster(84, 590, 3),
		cluster(96, 700, 2.4), cluster(40, 1000, 3.5, -40),
		cluster(150, 1012, 7, -20), cluster(220, 1030, 2),
		cluster(780, 300, 5, 160), cluster(720, 640, 3, 120), cluster(790, 862, 7, 200), cluster(760, 1008, 4, 250),
		cluster(690, 64, 3.2, 90), cluster(720, 52, 2),
		cluster(120, 92, 2.6, 60), cluster(180, 22, 2.2),
		cluster(612, 1030, 2.6),
		dust(20, 520, 110, 680, 26), dust(700, 820, 800, 940, 18), dust(100, 990, 260, 1040, 14),
		dust(660, 40, 780, 90, 10, 1.2)
	].join('');
	return svg(W, H, `
		<filter id="s" x="-10%" y="-10%" width="120%" height="120%">
			<feTurbulence type="fractalNoise" baseFrequency=".35" numOctaves="2" seed="5" result="n"/>
			<feDisplacementMap in="SourceGraphic" in2="n" scale="2.6"/>
		</filter>
		<g fill="${INK}" filter="url(#s)" opacity=".88" ${mirror ? `transform="translate(${W} 0) scale(-1 1)"` : ''}>${body}</g>`);
};

/* ---------- textures ----------------------------------------------------- */

const buildStains = ()=>svg(W, H, `
	<filter id="s" x="0" y="0" width="100%" height="100%">
		<feTurbulence type="fractalNoise" baseFrequency=".0042 .006" numOctaves="5" seed="31"/>
		<feColorMatrix values="0 0 0 0 .48  0 0 0 0 .33  0 0 0 0 .16  1.5 0 0 0 -.66"/>
	</filter>
	<rect width="${W}" height="${H}" filter="url(#s)"/>`, 'preserveAspectRatio="none"');

const buildGrain = ()=>svg(400, 400, `
	<filter id="g" x="0" y="0" width="100%" height="100%">
		<feTurbulence type="fractalNoise" baseFrequency=".8" numOctaves="3" seed="13" stitchTiles="stitch"/>
		<feColorMatrix values="0 0 0 0 .32  0 0 0 0 .24  0 0 0 0 .14  1 0 0 0 -.44"/>
	</filter>
	<rect width="400" height="400" filter="url(#g)"/>`);

const buildFoxing = ()=>svg(360, 360, `
	<filter id="f" x="0" y="0" width="100%" height="100%">
		<feTurbulence type="fractalNoise" baseFrequency=".25" numOctaves="2" seed="17" stitchTiles="stitch"/>
		<feColorMatrix values="0 0 0 0 .40  0 0 0 0 .27  0 0 0 0 .12  0 11 0 0 -8.3"/>
	</filter>
	<rect width="360" height="360" filter="url(#f)"/>`);

// grey ink-wash blot that sits behind drop caps
const buildBlot = ()=>svg(160, 160, `
	<filter id="b" x="-30%" y="-30%" width="160%" height="160%">
		<feTurbulence type="fractalNoise" baseFrequency=".045" numOctaves="3" seed="21" result="n"/>
		<feDisplacementMap in="SourceGraphic" in2="n" scale="34"/>
		<feGaussianBlur stdDeviation="2.4"/>
	</filter>
	<g filter="url(#b)">
		<ellipse cx="78" cy="82" rx="50" ry="54" fill="${WASH}" opacity=".42"/>
		<ellipse cx="70" cy="74" rx="30" ry="34" fill="${WASH}" opacity=".3"/>
		<circle cx="128" cy="40" r="5" fill="${WASH}" opacity=".5"/>
		<circle cx="26" cy="134" r="3" fill="${WASH}" opacity=".5"/>
	</g>`);

// an ink rectangle drawn by a slightly unsteady hand – used as a border-image
const buildInkBox = (stroke = INK)=>svg(120, 120, `
	${wobble('w', 3, 0.06, 6)}
	<g fill="none" stroke="${stroke}" filter="url(#w)" stroke-linecap="round">
		<rect x="10" y="10" width="100" height="100" stroke-width="2.6"/>
		<path d="M4,10.5 L14,10.5 M106,9.5 L116,9.5 M9.5,104 L10.5,116 M110,4 L110.5,16" stroke-width="1.4"/>
	</g>`);

// small hand-drawn rule with a lozenge, for hr and headings
const buildRule = ()=>svg(600, 18, `
	<g fill="${INK}">
		<path d="M290,9 C200,7 90,6 4,9 C90,11 200,11 290,9 Z"/>
		<path d="M310,9 C400,7 510,6 596,9 C510,11 400,11 310,9 Z"/>
		<path d="M300,2 l7,7 l-7,7 l-7,-7 Z" fill="none" stroke="${INK}" stroke-width="1.6"/>
		<circle cx="300" cy="9" r="1.8"/>
	</g>`, 'preserveAspectRatio="none"');

// "kicker" arrow under a series name, as on the cover reference
const buildArrow = ()=>svg(60, 22, `
	<g fill="${INK}">
		<path d="M2,5 C14,4 22,3 30,6 C38,3 46,4 58,5 C46,6 38,6 30,9 C22,6 14,6 2,5 Z"/>
		<path d="M25,9 L30,20 L35,9 L30,12 Z"/>
	</g>`);

/* ---------- emit --------------------------------------------------------- */

const assets = {
	'--pi-edge'      : buildEdgeMask(),
	'--pi-burn'      : buildEdgeBurn(),
	'--pi-frame'     : buildFrame(),
	'--pi-sigils'    : buildSigils(),
	'--pi-splatter'  : buildSplatter(false),
	'--pi-splatter-r': buildSplatter(true),
	'--pi-stains'    : buildStains(),
	'--pi-grain'     : buildGrain(),
	'--pi-foxing'    : buildFoxing(),
	'--pi-blot'      : buildBlot(),
	'--pi-inkbox'    : buildInkBox(),
	'--pi-rule'      : buildRule(),
	'--pi-arrow'     : buildArrow()
};

const block = [
	'/* GENERATED ART  ·  do not hand-edit; see planar-ink/build.mjs ______ */',
	':root {',
	...Object.entries(assets).map(([k, v])=>`\t${k.padEnd(15)} : ${dataUri(v)};`),
	'}'
].join('\n');

const rules = fs.readFileSync(path.join(here, 'rules.css'), 'utf8');
if (!rules.includes('/* @@ASSETS@@ */')) throw new Error('rules.css is missing the /* @@ASSETS@@ */ marker');
const out = rules.replace('/* @@ASSETS@@ */', block);
const dest = path.join(here, '..', 'planar-ink.css');
fs.writeFileSync(dest, out);
console.log(`wrote ${path.relative(process.cwd(), dest)}  (${(out.length / 1024).toFixed(1)} KiB)`);
