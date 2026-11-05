/* ==================================================================
   PLANAR INK  ·  asset generator

   Builds ../planar-ink.css from ./rules.css, injecting every image the
   sheet needs as CSS custom properties at the @@ASSETS@@ marker:

   · art/*.webp – ink line-work and the drop-cap wash, lifted off the
     asset sheet by extract_marginalia.py. Embedded as base64 WebP.
   · generated SVG – torn page edge, scorched rim, paper textures, the
     watercolour image masks, small rules and the text-box border.

   The output is a single self-contained sheet you can paste into the
   Homebrewery Style tab. Nothing is fetched except Google Fonts.

       python3 brew-styles/planar-ink/extract_marginalia.py <sheet.jpg>   (only if art changes)
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
const webpUri = (file)=>`url("data:image/webp;base64,${fs.readFileSync(path.join(here, file)).toString('base64')}")`;

// `extra` lets callers drop width/height (=> no intrinsic size, stretches to box)
const svg = (w, h, body, extra = '', sized = true)=>`<svg xmlns="http://www.w3.org/2000/svg" ${sized ? `width="${w}" height="${h}"` : ''} viewBox="0 0 ${w} ${h}" ${extra}>${body}</svg>`;

const wobble = (id, scale = 2.2, freq = 0.035, seed = 3)=>`
	<filter id="${id}" x="-5%" y="-5%" width="110%" height="110%">
		<feTurbulence type="fractalNoise" baseFrequency="${freq}" numOctaves="2" seed="${seed}" result="n"/>
		<feDisplacementMap in="SourceGraphic" in2="n" scale="${scale}" xChannelSelector="R" yChannelSelector="G"/>
	</filter>`;

/* ---------- torn page edge ---------------------------------------------- */
// One polygon, reused for the alpha mask and for the browned rim, so the
// scorch always follows the tear exactly.

const edgeShape = ()=>{
	const r    = mulberry32(SEED ^ 0xED6E);
	const pts  = [];
	const nick = ()=>(r() < 0.06 ? 5 + r() * 9 : 0);
	const jit  = ()=>1.5 + r() * 4.5 + nick();
	const step = 9;
	for (let x = 0; x <= W; x += step) pts.push([x, jit()]);
	for (let y = step; y <= H; y += step) pts.push([W - jit(), y]);
	for (let x = W - step; x >= 0; x -= step) pts.push([x, H - jit()]);
	for (let y = H - step; y > 0; y -= step) pts.push([jit(), y]);
	const d = `M${pts.map(([x, y])=>`${f(x)},${f(y)}`).join('L')}Z`;
	const corners = [[0, 0, 1, 1], [W, 0, -1, 1], [W, H, -1, -1], [0, H, 1, -1]].map(([cx, cy, sx, sy], i)=>{
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

/* ---------- watercolour image masks ------------------------------------- */
// Alpha masks for artwork. A rectangle is domain-warped by low-frequency
// noise (uneven, wandering silhouette), blurred (soft wet edge), then its
// alpha is modulated by fine grain only where it is already partial – the
// interior stays opaque, the rim breaks up into blooms and dry-brush specks:
//
//     out = soft * (k1 * grain + 1)      (feComposite arithmetic, clamped)
//
// No width/height on the <svg>: with no intrinsic size the mask stretches to
// whatever box it is applied to, and the same image can drive shape-outside.

const buildWatercolorMask = ({ seed, warp = 74, blur = 3.2, inset = 62, grainK = 1.1, freq = 0.013 })=>svg(400, 400, `
	<filter id="m" x="-25%" y="-25%" width="150%" height="150%" color-interpolation-filters="sRGB">
		<feTurbulence type="fractalNoise" baseFrequency="${freq}" numOctaves="3" seed="${seed}" result="warp"/>
		<feDisplacementMap in="SourceGraphic" in2="warp" scale="${warp}" xChannelSelector="R" yChannelSelector="G" result="shape"/>
		<feGaussianBlur in="shape" stdDeviation="${blur}" result="soft"/>
		<feTurbulence type="fractalNoise" baseFrequency=".045" numOctaves="4" seed="${seed + 1}" result="n"/>
		<feColorMatrix in="n" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  3.2 0 0 0 -1.6" result="grain"/>
		<feComposite in="soft" in2="grain" operator="arithmetic" k1="${grainK}" k2="1" k3="0" k4="0"/>
	</filter>
	<rect x="${inset}" y="${inset}" width="${400 - 2 * inset}" height="${400 - 2 * inset}" fill="#fff" filter="url(#m)"/>`,
'preserveAspectRatio="none"', false);

/* ---------- paper textures ---------------------------------------------- */

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

/* ---------- emit --------------------------------------------------------- */

const assets = {
	'--pi-frame'      : webpUri('art/frame.webp'),
	'--pi-marginalia' : webpUri('art/marginalia.webp'),
	'--pi-wc-1'       : svgUri(buildWatercolorMask({ seed: 4 })),
	'--pi-wc-2'       : svgUri(buildWatercolorMask({ seed: 19, warp: 92, blur: 2.6, freq: 0.016 })),
	'--pi-wc-3'       : svgUri(buildWatercolorMask({ seed: 33, warp: 60, blur: 5, grainK: 1.3, freq: 0.01 })),
	'--pi-edge'       : svgUri(buildEdgeMask()),
	'--pi-burn'       : svgUri(buildEdgeBurn()),
	'--pi-stains'     : svgUri(buildStains()),
	'--pi-grain'      : svgUri(buildGrain()),
	'--pi-foxing'     : svgUri(buildFoxing()),
	'--pi-blot'       : webpUri('art/blot.webp'),
	'--pi-inkbox'     : svgUri(buildInkBox()),
	'--pi-rule'       : svgUri(buildRule()),
	'--pi-arrow'      : svgUri(buildArrow())
};

const block = [
	'/* GENERATED ART  ·  do not hand-edit; see planar-ink/build.mjs ______ */',
	':root {',
	...Object.entries(assets).map(([k, v])=>`\t${k.padEnd(16)} : ${v};`),
	'}'
].join('\n');

const rules = fs.readFileSync(path.join(here, 'rules.css'), 'utf8');
if(!rules.includes('/* @@ASSETS@@ */')) throw new Error('rules.css is missing the /* @@ASSETS@@ */ marker');
const out  = rules.replace('/* @@ASSETS@@ */', block);
const dest = path.join(here, '..', 'planar-ink.css');
fs.writeFileSync(dest, out);
console.log(`wrote ${path.relative(process.cwd(), dest)}  (${(out.length / 1024).toFixed(1)} KiB)`);
