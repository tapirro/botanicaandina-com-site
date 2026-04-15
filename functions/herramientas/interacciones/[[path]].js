/**
 * Interacciones SSR Worker
 *
 * Renders herb×drug interaction pages on the fly from KV data.
 * Scales to 5K×5K (25M combos) with zero static files.
 *
 * KV schema:
 *   meta:herbs  → [{id, name, scientific}...] (compact list for sidebar/search)
 *   meta:drugs  → [{id, name, drugs}...] (compact list)
 *   herb:{id}   → {name, scientific, aliases, interactions: [{drugClass, severity, effect, mechanism, evidence, evidenceLevel, source, doi}...]}
 *   drug:{id}   → {name, drugs, aliases, interactions: [{herb, severity, effect}...]}
 *   popular     → [{herb, drug, severity}...] (top 200 for cross-links)
 *   sitemap:idx → sitemap index XML
 *   sitemap:{n} → sitemap chunk N
 */

// ── In-memory cache (survives across requests in same Worker instance) ──

let herbsCache = null;
let drugsCache = null;
let popularCache = null;
let plantMapCache = null;
let herbsCacheTime = 0;
let drugsCacheTime = 0;
const MEMORY_TTL = 300_000; // 5 min

async function getHerbs(kv) {
  if (herbsCache && Date.now() - herbsCacheTime < MEMORY_TTL) return herbsCache;
  const data = await kv.get('meta:herbs', 'json');
  if (data) { herbsCache = data; herbsCacheTime = Date.now(); }
  return data || [];
}

async function getDrugs(kv) {
  if (drugsCache && Date.now() - drugsCacheTime < MEMORY_TTL) return drugsCache;
  const data = await kv.get('meta:drugs', 'json');
  if (data) { drugsCache = data; drugsCacheTime = Date.now(); }
  return data || [];
}

async function getPopular(kv) {
  if (popularCache) return popularCache;
  const data = await kv.get('popular', 'json');
  if (data) popularCache = data;
  return data || [];
}

async function getPlantMap(kv) {
  if (plantMapCache) return plantMapCache;
  const data = await kv.get('meta:plant_map', 'json');
  if (data) plantMapCache = data;
  return data || {};
}

async function getHerbData(kv, herbId) {
  return kv.get(`herb:${herbId}`, 'json');
}

async function getDrugData(kv, drugId) {
  return kv.get(`drug:${drugId}`, 'json');
}

// ── URL parsing ──

function parseRoute(url) {
  const path = new URL(url).pathname;
  // /herramientas/interacciones/{herb}/{drug}/
  const m = path.match(/^\/herramientas\/interacciones\/(?:medicamento\/([^/]+)\/?|([^/]+)\/([^/]+)\/?|([^/]+)\/?)?$/);
  if (!m) return null;

  if (m[1]) return { type: 'drug', drugId: m[1] };
  if (m[2] && m[3]) return { type: 'combo', herbId: m[2], drugId: m[3] };
  if (m[4]) {
    // Could be herb overview or special page
    if (m[4] === 'todas') return { type: 'all-herbs' };
    if (m[4] === 'medicamentos') return { type: 'all-drugs' };
    if (m[4] === 'sitemap.xml') return { type: 'sitemap-index' };
    const smMatch = m[4].match(/^sitemap-(\d+)\.xml$/);
    if (smMatch) return { type: 'sitemap-chunk', chunk: parseInt(smMatch[1]) };
    return { type: 'herb', herbId: m[4] };
  }
  return null; // Main index — let Pages handle it
}

// ── Deterministic cross-links ──

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function pickCrossLinks(herbId, drugId, herbInteractions, drugInteractions, popular) {
  const seed = hashCode(`${herbId}:${drugId}`);
  const links = [];
  const seen = new Set();
  seen.add(`${herbId}:${drugId}`);

  // 4 from same herb (different drugs)
  const sameHerb = (herbInteractions || []).filter(i => i.drugClass !== drugId);
  for (let i = 0; i < 4 && i < sameHerb.length; i++) {
    const idx = (seed + i * 7919) % sameHerb.length;
    const ix = sameHerb[idx];
    const key = `${herbId}:${ix.drugClass}`;
    if (!seen.has(key)) { seen.add(key); links.push({ herb: herbId, drug: ix.drugClass, severity: ix.severity }); }
  }

  // 4 from same drug (different herbs)
  const sameDrug = (drugInteractions || []).filter(i => i.herb !== herbId);
  for (let i = 0; i < 4 && i < sameDrug.length; i++) {
    const idx = (seed + i * 6271) % sameDrug.length;
    const ix = sameDrug[idx];
    const key = `${ix.herb}:${drugId}`;
    if (!seen.has(key)) { seen.add(key); links.push({ herb: ix.herb, drug: drugId, severity: ix.severity }); }
  }

  // 4 from popular (different combos)
  const pop = (popular || []).filter(p => p.herb !== herbId && p.drug !== drugId);
  for (let i = 0; i < 4 && i < pop.length; i++) {
    const idx = (seed + i * 3571) % pop.length;
    const p = pop[idx];
    const key = `${p.herb}:${p.drug}`;
    if (!seen.has(key)) { seen.add(key); links.push(p); }
  }

  return links.slice(0, 12);
}

// ── HTML rendering ──

const SEV = {
  alta:     { label: 'Alta',     color: '#c62828', bg: '#ffebee' },
  moderada: { label: 'Moderada', color: '#e65100', bg: '#fff3e0' },
  baja:     { label: 'Baja',     color: '#1565c0', bg: '#e3f2fd' },
  teorica:  { label: 'Teórica',  color: '#757575', bg: '#f5f5f5' },
};

function esc(s) { return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function sevBadge(sev) { const s = SEV[sev] || SEV.teorica; return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-family:Arial,sans-serif;font-size:.7rem;text-transform:uppercase;letter-spacing:.5px;color:#fff;background:${s.color}">${s.label}</span>`; }

function comboUrl(h, d) { return `/herramientas/interacciones/${h}/${d}/`; }
function herbUrl(h) { return `/herramientas/interacciones/${h}/`; }
function drugUrl(d) { return `/herramientas/interacciones/medicamento/${d}/`; }
function plantUrl(slug) { return `https://yerbateca.org/plantas/${slug}/`; }

function encyclopediaLink(herbId, herbName, plantMap) {
  const slug = plantMap?.[herbId];
  if (!slug) return '';
  return `<a href="${plantUrl(slug)}" style="display:inline-block;margin-top:.6rem;padding:.4rem .8rem;background:#e8f5e9;border:1px solid #c8e6c9;border-radius:6px;font-family:Arial,sans-serif;font-size:.8rem;color:#1a5632;text-decoration:none">📖 Ver ficha completa de ${esc(herbName)} en la enciclopedia</a>`;
}

function shell(title, desc, canonical, content, breadcrumbs, jsonLd) {
  const bc = breadcrumbs || [];
  const bcHtml = bc.length ? `<nav style="font-family:Arial,sans-serif;font-size:.78rem;color:#888;margin-bottom:1rem">${bc.map((b,i) => i < bc.length-1 ? `<a href="${b.url}" style="color:#1a5632">${esc(b.name)}</a> ›` : `<span>${esc(b.name)}</span>`).join(' ')}</nav>` : '';
  const jsonLdHtml = jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` : '';

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc((desc||'').slice(0,160))}">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc((desc||'').slice(0,160))}">
<meta property="og:url" content="${canonical}">
<meta property="og:locale" content="es_LA">
${jsonLdHtml}
<style>
:root{--g:#1a5632;--gl:#e8f5e9;--bg:#fafaf7;--t:#1a1a1a;--m:#666;--bd:#e0e0e0}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:Georgia,'Times New Roman',serif;line-height:1.6;color:var(--t);background:var(--bg)}
a{color:var(--g);text-decoration:none}a:hover{text-decoration:underline}
.n{background:var(--g);position:sticky;top:0;z-index:100}
.ni{max-width:1100px;margin:0 auto;padding:0 1.5rem;display:flex;justify-content:space-between;align-items:center;min-height:48px;flex-wrap:wrap}
.nb{color:#fff;font-family:Georgia,serif;font-size:1.05rem;font-weight:bold;text-decoration:none}
.nl{display:flex;gap:1.2rem;flex-wrap:wrap}.nl a{color:rgba(255,255,255,.85);font-family:Arial,sans-serif;font-size:.8rem;text-decoration:none;white-space:nowrap}.nl a:hover{color:#fff}
.w{max-width:900px;margin:0 auto;padding:1.5rem}
.sc{border-radius:10px;padding:1.2rem 1.5rem;border-left:4px solid;margin-bottom:1rem}
.sc.alta{border-left-color:#c62828;background:#ffebee}
.sc.moderada{border-left-color:#e65100;background:#fff3e0}
.sc.baja{border-left-color:#1565c0;background:#e3f2fd}
.sc.teorica{border-left-color:#888;background:#f5f5f5}
.sc.none{border-left-color:#2e7d32;background:#e8f5e9}
.dg{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin:.8rem 0}
@media(max-width:640px){.dg{grid-template-columns:1fr}}
.db{background:#fff;border:1px solid var(--bd);border-radius:8px;padding:.8rem}
.db h4{font-size:.75rem;text-transform:uppercase;letter-spacing:.5px;color:var(--m);font-family:Arial,sans-serif;margin-bottom:.4rem}
.db p{font-family:Arial,sans-serif;font-size:.85rem;line-height:1.5}
.ev{font-family:Arial,sans-serif;font-size:.75rem;color:var(--m);margin-top:.4rem}
.ev a{color:var(--g)}
.cl{margin-top:2rem;padding-top:1.2rem;border-top:1px solid var(--bd)}
.cl h3{font-size:.85rem;margin-bottom:.6rem}
.lg{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:.4rem}
.lc{display:block;padding:.5rem .7rem;background:#fff;border:1px solid var(--bd);border-radius:6px;font-family:Arial,sans-serif;font-size:.8rem;transition:border-color .15s}
.lc:hover{border-color:var(--g);text-decoration:none}
.lc span{float:right}
.dis{background:#fff8e1;border:1px solid #ffe082;border-radius:8px;padding:.8rem 1rem;margin-top:1.2rem;font-size:.8rem;font-family:Arial,sans-serif;color:#795548}
.og{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:.8rem;margin:1rem 0}
.oc{background:#fff;border:1px solid var(--bd);border-radius:8px;padding:.8rem;transition:border-color .15s}
.oc:hover{border-color:var(--g)}
.oc h3{font-size:.9rem;margin-bottom:.2rem}.oc h3 a{color:var(--t)}
.oc .om{font-family:Arial,sans-serif;font-size:.78rem;color:var(--m)}
.st{display:flex;gap:1.5rem;margin:.8rem 0;flex-wrap:wrap}
.si{text-align:center}.sn{font-size:1.6rem;font-weight:bold;color:var(--g);display:block}
.sl{font-family:Arial,sans-serif;font-size:.7rem;color:var(--m);text-transform:uppercase;letter-spacing:1px}
.sb-s{width:100%;padding:.6rem .8rem;border:1px solid var(--bd);border-radius:6px;font-size:.9rem;font-family:Arial,sans-serif;margin-bottom:.8rem}
.sb-s:focus{outline:none;border-color:var(--g)}
footer{background:var(--g);color:rgba(255,255,255,.7);padding:1.2rem;text-align:center;font-family:Arial,sans-serif;font-size:.75rem;margin-top:2rem}
footer a{color:rgba(255,255,255,.9)}
</style>
</head>
<body>
<nav class="n"><div class="ni">
<a href="/" class="nb">Botánica Andina</a>
<div class="nl">
<a href="/noticias/">Noticias</a>
<a href="/herramientas/buscador/">Buscador</a>
<a href="/herramientas/interacciones/">Interacciones</a>
<a href="/sobre-nosotros/">Sobre Nosotros</a>
</div>
</div></nav>
<div class="w">
${bcHtml}
${content}
<div class="dis"><strong>⚕️ Aviso:</strong> Información educativa. No reemplaza el consejo médico. Consulte siempre a su profesional de salud.</div>
</div>
<footer>
<p>© ${new Date().getFullYear()} Botánica Andina · <a href="/herramientas/interacciones/">Verificador</a> · <a href="/">Inicio</a></p>
</footer>
</body>
</html>`;
}

// ── Page renderers ──

function renderComboPage(herbData, drugData, herbId, drugId, drugInteractions, popular, herbs, drugs, plantMap) {
  const hName = herbData?.name || herbId;
  const hSci = herbData?.scientific || '';
  const dName = drugData?.name || drugId;
  const dDrugs = (drugData?.drugs || []).slice(0, 4).join(', ');

  const interactions = (herbData?.interactions || []).filter(i => i.drugClass === drugId);
  const title = `${hName} y ${dName} — Interacciones`;
  const canon = `https://botanicaandina.com${comboUrl(herbId, drugId)}`;

  let desc, content;

  if (interactions.length > 0) {
    const worst = interactions.reduce((a, b) =>
      ['alta','moderada','baja','teorica'].indexOf(a.severity) <= ['alta','moderada','baja','teorica'].indexOf(b.severity) ? a : b
    );
    desc = `Interacción ${SEV[worst.severity]?.label?.toLowerCase() || ''} entre ${hName} (${hSci}) y ${dName}. ${(worst.effect || '').slice(0, 120)}`;

    const cards = interactions.map(ix => {
      const evHtml = ix.source ? `<p class="ev">📚 ${esc(ix.source)}${ix.doi ? ` · <a href="https://doi.org/${esc(ix.doi)}" target="_blank">DOI</a>` : ''}</p>` : '';
      const evLevel = ix.evidenceLevel ? ` · Evidencia nivel ${ix.evidenceLevel}` : '';
      return `<div class="sc ${ix.severity}">
<h3>${sevBadge(ix.severity)} ${esc(hName)} + ${esc(dName)}${evLevel}</h3>
<div class="dg">
<div class="db"><h4>Efecto</h4><p>${esc(ix.effect)}</p></div>
<div class="db"><h4>Mecanismo</h4><p>${esc(ix.mechanism)}</p></div>
</div>
${evHtml}
</div>`;
    }).join('\n');
    content = cards;
  } else {
    desc = `No se han documentado interacciones entre ${hName} (${hSci}) y ${dName}. Consulte a su profesional de salud.`;
    content = `<div class="sc none" style="text-align:center;padding:2rem">
<h2 style="color:#2e7d32;font-size:1.1rem;margin-bottom:.4rem">✅ Sin interacciones documentadas</h2>
<p style="font-family:Arial,sans-serif;font-size:.88rem;color:#555">No se han encontrado interacciones documentadas entre <strong>${esc(hName)}</strong> y <strong>${esc(dName)}</strong> en EMA, ESCOP o PubMed.</p>
<p style="margin-top:.4rem;font-size:.8rem;color:#888;font-family:Arial,sans-serif">Esto no garantiza que la combinación sea segura.</p>
</div>`;
  }

  // Cross-links
  const herbName = (id) => { const h = herbs.find(x => x.id === id); return h?.name || id; };
  const drugName = (id) => { const d = drugs.find(x => x.id === id); return d?.name || id; };
  const crossLinks = pickCrossLinks(herbId, drugId, herbData?.interactions, drugInteractions, popular);
  if (crossLinks.length > 0) {
    const linkCards = crossLinks.map(l =>
      `<a href="${comboUrl(l.herb, l.drug)}" class="lc">${esc(herbName(l.herb))} + ${esc(drugName(l.drug))} <span>${l.severity ? sevBadge(l.severity) : '✓'}</span></a>`
    ).join('');
    content += `<div class="cl"><h3>Otras combinaciones</h3><div class="lg">${linkCards}</div></div>`;
  }

  // Herb/drug quick nav
  const encLink = encyclopediaLink(herbId, hName, plantMap);
  content = `<h1 style="font-size:1.35rem;margin-bottom:.3rem">${esc(hName)} y ${esc(dName)}</h1>
<p style="font-family:Arial,sans-serif;font-size:.85rem;color:#666;margin-bottom:.6rem"><em>${esc(hSci)}</em> · ${esc(dName)} (${esc(dDrugs)})</p>
<p style="font-family:Arial,sans-serif;font-size:.82rem;margin-bottom:.4rem">
<a href="${herbUrl(herbId)}">Ver todas las interacciones de ${esc(hName)}</a> ·
<a href="${drugUrl(drugId)}">Ver todas las plantas con ${esc(dName)}</a> ·
<a href="/herramientas/interacciones/">🔍 Herramienta interactiva</a>
</p>
${encLink ? `<p>${encLink}</p>` : ''}
${content}`;

  const bc = [
    { name: 'Inicio', url: '/' },
    { name: 'Interacciones', url: '/herramientas/interacciones/' },
    { name: hName, url: herbUrl(herbId) },
    { name: dName },
  ];

  // FAQ + BreadcrumbList JSON-LD for documented interactions
  let jsonLd = null;
  if (interactions.length > 0) {
    const faqItems = interactions.map(ix => ({
      "@type": "Question",
      "name": `¿${hName} interactúa con ${dName}?`,
      "acceptedAnswer": {
        "@type": "Answer",
        "text": `${ix.effect || 'Interacción documentada'}. Mecanismo: ${ix.mechanism || 'No especificado'}. Severidad: ${SEV[ix.severity]?.label || ix.severity}.`
      }
    }));
    // Deduplicate if multiple interactions have same question
    const seen = new Set();
    const uniqueFaq = faqItems.filter(q => { if (seen.has(q.name)) return false; seen.add(q.name); return true; });
    // Add a general safety question
    uniqueFaq.push({
      "@type": "Question",
      "name": `¿Es seguro tomar ${hName} con ${dName}?`,
      "acceptedAnswer": {
        "@type": "Answer",
        "text": `Se han documentado interacciones de severidad ${SEV[interactions[0].severity]?.label?.toLowerCase() || 'variable'} entre ${hName} y ${dName}. Consulte a su profesional de salud antes de combinar estos productos.`
      }
    });
    jsonLd = [
      {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": uniqueFaq
      },
      {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": bc.filter(b => b.url).map((b, i) => ({
          "@type": "ListItem",
          "position": i + 1,
          "name": b.name,
          "item": `https://botanicaandina.com${b.url}`
        }))
      }
    ];
  }

  return shell(title, desc, canon, content, bc, jsonLd);
}


function renderHerbPage(herbData, herbId, herbs, drugs, plantMap) {
  const hName = herbData?.name || herbId;
  const hSci = herbData?.scientific || '';
  const inters = herbData?.interactions || [];
  const title = `${hName} (${hSci}) — Interacciones con medicamentos`;
  const canon = `https://botanicaandina.com${herbUrl(herbId)}`;
  const desc = `${inters.length} interacciones documentadas de ${hName} (${hSci}) con medicamentos. Evidencia EMA/ESCOP/PubMed.`;

  const sevCounts = { alta: 0, moderada: 0, baja: 0 };
  inters.forEach(i => { if (sevCounts[i.severity] !== undefined) sevCounts[i.severity]++; });

  const drugName = (id) => { const d = drugs.find(x => x.id === id); return d?.name || id; };

  // Group by drug
  const byDrug = {};
  inters.forEach(i => { (byDrug[i.drugClass] = byDrug[i.drugClass] || []).push(i); });

  const cards = Object.entries(byDrug).sort((a,b) => drugName(a[0]).localeCompare(drugName(b[0]))).map(([dId, dInters]) => {
    const worst = dInters.reduce((a, b) =>
      ['alta','moderada','baja','teorica'].indexOf(a.severity) <= ['alta','moderada','baja','teorica'].indexOf(b.severity) ? a : b
    );
    return `<div class="oc"><h3><a href="${comboUrl(herbId, dId)}">${esc(drugName(dId))}</a> ${sevBadge(worst.severity)}</h3><p class="om">${esc((worst.effect||'').slice(0,100))}…</p></div>`;
  }).join('');

  const encLink = encyclopediaLink(herbId, hName, plantMap);
  const content = `<h1 style="font-size:1.35rem;margin-bottom:.3rem">🌿 ${esc(hName)}</h1>
<p style="font-family:Arial,sans-serif;font-size:.85rem;color:#666;margin-bottom:.8rem"><em>${esc(hSci)}</em> · ${inters.length} interacciones · <a href="/herramientas/interacciones/">🔍 Herramienta interactiva</a></p>
${encLink ? `<p>${encLink}</p>` : ''}
<div class="st">
<div class="si"><span class="sn">${sevCounts.alta}</span><span class="sl">Alta</span></div>
<div class="si"><span class="sn">${sevCounts.moderada}</span><span class="sl">Moderada</span></div>
<div class="si"><span class="sn">${sevCounts.baja}</span><span class="sl">Baja</span></div>
</div>
<div class="og">${cards}</div>`;

  const bc = [
    { name: 'Inicio', url: '/' },
    { name: 'Interacciones', url: '/herramientas/interacciones/' },
    { name: hName },
  ];

  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      "itemListElement": bc.filter(b => b.url).map((b, i) => ({
        "@type": "ListItem",
        "position": i + 1,
        "name": b.name,
        "item": `https://botanicaandina.com${b.url}`
      }))
    },
    {
      "@context": "https://schema.org",
      "@type": "MedicalWebPage",
      "name": title,
      "description": desc,
      "url": canon,
      "about": {
        "@type": "Drug",
        "name": hName,
        "alternateName": hSci
      },
      "lastReviewed": new Date().toISOString().slice(0, 10)
    }
  ];

  return shell(title, desc, canon, content, bc, jsonLd);
}


function renderDrugPage(drugData, drugId, herbs, drugs) {
  const dName = drugData?.name || drugId;
  const dDrugs = (drugData?.drugs || []).slice(0, 6).join(', ');
  const inters = drugData?.interactions || [];
  const title = `${dName} — Interacciones con plantas medicinales`;
  const canon = `https://botanicaandina.com${drugUrl(drugId)}`;
  const desc = `Plantas medicinales que interactúan con ${dName}. ${inters.length} interacciones documentadas.`;

  const herbName = (id) => { const h = herbs.find(x => x.id === id); return h?.name || id; };
  const herbSci = (id) => { const h = herbs.find(x => x.id === id); return h?.scientific || ''; };

  const cards = inters.sort((a,b) => herbName(a.herb).localeCompare(herbName(b.herb))).map(ix =>
    `<div class="oc"><h3><a href="${comboUrl(ix.herb, drugId)}">${esc(herbName(ix.herb))}</a> ${sevBadge(ix.severity)}</h3><p class="om"><em>${esc(herbSci(ix.herb))}</em> · ${esc((ix.effect||'').slice(0,100))}…</p></div>`
  ).join('');

  const content = `<h1 style="font-size:1.35rem;margin-bottom:.3rem">${esc(dName)}</h1>
<p style="font-family:Arial,sans-serif;font-size:.85rem;color:#666;margin-bottom:1rem">${esc(dDrugs)} · ${inters.length} interacciones · <a href="/herramientas/interacciones/">🔍 Herramienta interactiva</a></p>
<div class="og">${cards}</div>`;

  const bc = [
    { name: 'Inicio', url: '/' },
    { name: 'Interacciones', url: '/herramientas/interacciones/' },
    { name: dName },
  ];

  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      "itemListElement": bc.filter(b => b.url).map((b, i) => ({
        "@type": "ListItem",
        "position": i + 1,
        "name": b.name,
        "item": `https://botanicaandina.com${b.url}`
      }))
    },
    {
      "@context": "https://schema.org",
      "@type": "MedicalWebPage",
      "name": title,
      "description": desc,
      "url": canon,
      "about": {
        "@type": "Drug",
        "name": dName,
        "alternateName": dDrugs
      },
      "lastReviewed": new Date().toISOString().slice(0, 10)
    }
  ];

  return shell(title, desc, canon, content, bc, jsonLd);
}


function renderAllHerbs(herbs) {
  const sorted = [...herbs].sort((a,b) => a.name.localeCompare(b.name));
  const items = sorted.map(h =>
    `<div class="oc"><h3><a href="${herbUrl(h.id)}">${esc(h.name)}</a></h3><p class="om"><em>${esc(h.scientific || '')}</em></p></div>`
  ).join('');

  const content = `<h1 style="font-size:1.35rem;margin-bottom:.3rem">Todas las plantas medicinales</h1>
<p style="font-family:Arial,sans-serif;font-size:.85rem;color:#666;margin-bottom:1rem">${herbs.length} plantas · <a href="/herramientas/interacciones/">🔍 Herramienta interactiva</a></p>
<input type="text" class="sb-s" placeholder="Buscar planta..." oninput="let q=this.value.toLowerCase();document.querySelectorAll('.oc').forEach(c=>c.style.display=c.textContent.toLowerCase().includes(q)?'':'none')">
<div class="og">${items}</div>`;

  const bc = [
    { name: 'Inicio', url: '/' },
    { name: 'Interacciones', url: '/herramientas/interacciones/' },
    { name: 'Todas las plantas' },
  ];

  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      "itemListElement": bc.filter(b => b.url).map((b, i) => ({
        "@type": "ListItem",
        "position": i + 1,
        "name": b.name,
        "item": `https://botanicaandina.com${b.url}`
      }))
    },
    {
      "@context": "https://schema.org",
      "@type": "ItemList",
      "name": "Plantas medicinales con interacciones documentadas",
      "numberOfItems": herbs.length,
      "itemListElement": sorted.slice(0, 50).map((h, i) => ({
        "@type": "ListItem",
        "position": i + 1,
        "name": h.name,
        "url": `https://botanicaandina.com${herbUrl(h.id)}`
      }))
    }
  ];

  return shell('Todas las plantas medicinales — Interacciones', `Lista completa de ${herbs.length} plantas medicinales con interacciones documentadas.`, 'https://botanicaandina.com/herramientas/interacciones/todas/', content, bc, jsonLd);
}


function renderAllDrugs(drugs) {
  const sorted = [...drugs].sort((a,b) => a.name.localeCompare(b.name));
  const items = sorted.map(d =>
    `<div class="oc"><h3><a href="${drugUrl(d.id)}">${esc(d.name)}</a></h3><p class="om">${esc((d.drugs||[]).slice(0,4).join(', '))}</p></div>`
  ).join('');

  const content = `<h1 style="font-size:1.35rem;margin-bottom:.3rem">Todas las clases de medicamentos</h1>
<p style="font-family:Arial,sans-serif;font-size:.85rem;color:#666;margin-bottom:1rem">${drugs.length} clases · <a href="/herramientas/interacciones/">🔍 Herramienta interactiva</a></p>
<input type="text" class="sb-s" placeholder="Buscar medicamento..." oninput="let q=this.value.toLowerCase();document.querySelectorAll('.oc').forEach(c=>c.style.display=c.textContent.toLowerCase().includes(q)?'':'none')">
<div class="og">${items}</div>`;

  const bc = [
    { name: 'Inicio', url: '/' },
    { name: 'Interacciones', url: '/herramientas/interacciones/' },
    { name: 'Medicamentos' },
  ];

  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      "itemListElement": bc.filter(b => b.url).map((b, i) => ({
        "@type": "ListItem",
        "position": i + 1,
        "name": b.name,
        "item": `https://botanicaandina.com${b.url}`
      }))
    },
    {
      "@context": "https://schema.org",
      "@type": "ItemList",
      "name": "Clases de medicamentos con interacciones con plantas",
      "numberOfItems": drugs.length,
      "itemListElement": sorted.slice(0, 50).map((d, i) => ({
        "@type": "ListItem",
        "position": i + 1,
        "name": d.name,
        "url": `https://botanicaandina.com${drugUrl(d.id)}`
      }))
    }
  ];

  return shell('Clases de medicamentos — Interacciones', `Lista de ${drugs.length} clases de medicamentos con interacciones con plantas medicinales.`, 'https://botanicaandina.com/herramientas/interacciones/medicamentos/', content, bc, jsonLd);
}


// ── Main handler ──

const handler = {
  async fetch(request, env) {
    const route = parseRoute(request.url);
    if (!route) {
      return new Response('Not found', { status: 404 });
    }

    // Check edge cache first
    const cache = caches.default;
    const cacheKey = new Request(request.url, request);
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const kv = env.DATA;
    let html;

    // Load shared meta (cached in-memory across requests)
    const [herbs, drugs] = await Promise.all([getHerbs(kv), getDrugs(kv)]);

    if (route.type === 'combo') {
      const [herbData, drugData, popular, plantMap] = await Promise.all([
        getHerbData(kv, route.herbId),
        getDrugData(kv, route.drugId),
        getPopular(kv),
        getPlantMap(kv),
      ]);
      if (!herbData && !herbs.find(h => h.id === route.herbId)) {
        return new Response('Planta no encontrada', { status: 404 });
      }
      const drugInters = drugData?.interactions || [];
      html = renderComboPage(herbData || { name: route.herbId, interactions: [] }, drugData || { name: route.drugId }, route.herbId, route.drugId, drugInters, popular, herbs, drugs, plantMap);

    } else if (route.type === 'herb') {
      const [herbData, plantMap] = await Promise.all([
        getHerbData(kv, route.herbId),
        getPlantMap(kv),
      ]);
      if (!herbData && !herbs.find(h => h.id === route.herbId)) {
        return new Response('Planta no encontrada', { status: 404 });
      }
      html = renderHerbPage(herbData || { name: route.herbId, interactions: [] }, route.herbId, herbs, drugs, plantMap);

    } else if (route.type === 'drug') {
      const drugData = await getDrugData(kv, route.drugId);
      if (!drugData) {
        return new Response('Medicamento no encontrado', { status: 404 });
      }
      html = renderDrugPage(drugData, route.drugId, herbs, drugs);

    } else if (route.type === 'all-herbs') {
      html = renderAllHerbs(herbs);

    } else if (route.type === 'all-drugs') {
      html = renderAllDrugs(drugs);

    } else if (route.type === 'sitemap-index') {
      const xml = await kv.get('sitemap:idx', 'text');
      if (!xml) return new Response('Sitemap not found', { status: 404 });
      const resp = new Response(xml, { headers: { 'Content-Type': 'application/xml;charset=UTF-8', 'Cache-Control': 'public, max-age=86400' } });
      request.method === 'GET' && cache.put(cacheKey, resp.clone());
      return resp;

    } else if (route.type === 'sitemap-chunk') {
      const xml = await kv.get(`sitemap:${route.chunk}`, 'text');
      if (!xml) return new Response('Sitemap chunk not found', { status: 404 });
      const resp = new Response(xml, { headers: { 'Content-Type': 'application/xml;charset=UTF-8', 'Cache-Control': 'public, max-age=86400' } });
      request.method === 'GET' && cache.put(cacheKey, resp.clone());
      return resp;

    } else {
      return new Response('Not found', { status: 404 });
    }

    const response = new Response(html, {
      headers: {
        'Content-Type': 'text/html;charset=UTF-8',
        'Cache-Control': `public, max-age=${env.CACHE_TTL || 3600}`,
      },
    });

    // Store in edge cache
    request.method === 'GET' && cache.put(cacheKey, response.clone());

    return response;
  },
};

// Workers standalone
export default handler;

// Pages Functions adapter
export async function onRequest(context) {
  return handler.fetch(context.request, context.env);
}
