/**
 * AniPlay Server v3.1 — FIXED
 *
 * Fuentes:
 *  - Anime:     AnimeFLV (Cheerio scraper)
 *  - Películas: TMDB catálogo + múltiples embed providers (vidsrc, 2embed, etc.)
 *  - Series:    TMDB catálogo + múltiples embed providers
 *
 * FIX principal: Cuevana3 bloquea scrapers con 403. Ahora usamos TMDB para
 * el catálogo y embed providers que funcionan con TMDB IDs para el reproductor.
 * Esto es más robusto, rápido y fiable que scraping de Cuevana.
 */

const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const cheerio = require('cheerio');
const { resolveDirectLink } = require('./extractors');

const app = express();
app.use(cors());
app.use(express.json());

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const ANIMEFLV = 'https://www3.animeflv.net';
const ANILIST  = 'https://graphql.anilist.co';

// ─── ANILIST (Discovery & Meta) ──────────────────────────────────────────────
async function anilistQuery(query, variables = {}) {
  try {
    const res = await axios.post(ANILIST, { query, variables }, {
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
    });
    return res.data.data.Page.media;
  } catch (e) {
    console.error('[Anilist Error]', e.message);
    return [];
  }
}

const ANIME_FIELDS = `
  id
  title { romaji english native }
  coverImage { extraLarge large }
  bannerImage
  averageScore
  seasonYear
  description
  format
`;

async function getAnilistTrending() {
  return cached('anilist:trending', 30 * 60 * 1000, () =>
    anilistQuery(`query ($sort: [MediaSort]) { 
      Page(page: 1, perPage: 10) { 
        media(sort: $sort, type: ANIME, isAdult: false) { ${ANIME_FIELDS} } 
      }
    }`, { sort: ['TRENDING_DESC', 'POPULARITY_DESC'] })
      .then(items => items.map(formatAnilist))
  );
}

async function getAnilistPopular() {
  return cached('anilist:popular', 60 * 60 * 1000, () =>
    anilistQuery(`query ($sort: [MediaSort]) { 
      Page(page: 1, perPage: 15) { 
        media(sort: $sort, type: ANIME, isAdult: false) { ${ANIME_FIELDS} } 
      }
    }`, { sort: ['POPULARITY_DESC'] })
      .then(items => items.map(formatAnilist))
  );
}

async function getAnilistMovies() {
  return cached('anilist:movies', 60 * 60 * 1000, () =>
    anilistQuery(`query ($sort: [MediaSort]) { 
      Page(page: 1, perPage: 15) { 
        media(sort: $sort, type: ANIME, format: MOVIE, isAdult: false) { ${ANIME_FIELDS} } 
      }
    }`, { sort: ['POPULARITY_DESC'] })
      .then(items => items.map(formatAnilist))
  );
}

function formatAnilist(item) {
  if (!item) return {};
  return {
    id: `anilist-${item.id}`,
    anilistId: item.id,
    title: item.title?.romaji || item.title?.english || item.title?.native || 'Sin título',
    type: 'anime',
    mediaType: 'anime',
    poster: item.coverImage?.extraLarge || item.coverImage?.large || '',
    backdrop: item.bannerImage || '',
    overview: item.description?.replace(/<[^>]*>?/gm, '') || '',
    rating: item.averageScore ? (item.averageScore / 10).toFixed(1) : '',
    year: item.seasonYear || '',
    format: item.format,
    _source: 'anilist'
  };
}

// ─── ANIMFLV ─────────────────────────────────────────────────────────────────

async function animeflvSearch(query) {
  return cached(`flv:search:${query}`, 30 * 60 * 1000, async () => {
    const html = await get(`${ANIMEFLV}/browse?q=${encodeURIComponent(query)}`);
    const $ = cheerio.load(html);
    const results = [];
    $('ul.ListAnimes li article').each((_, el) => {
      const a      = $(el).find('a').first();
      const img    = $(el).find('img');
      const title  = $(el).find('h3.Title').text().trim();
      const type   = $(el).find('span.Type').text().trim();
      const href   = a.attr('href') || '';
      const poster = img.attr('src') || img.attr('data-src') || '';
      if (title && href) {
        results.push({
          id: href.replace('/anime/', '').replace(/\/$/, ''),
          title, type,
          poster: poster.startsWith('http') ? poster : `${ANIMEFLV}${poster}`,
          url: href.startsWith('http') ? href : `${ANIMEFLV}${href}`,
          _source: 'animeflv',
          mediaType: 'anime',
        });
      }
    });
    return results;
  });
}

async function animeflvCatalog(type = 'emision') {
  return cached(`flv:catalog:${type}`, 10 * 60 * 1000, async () => {
    const url = type === 'emision'
      ? `${ANIMEFLV}/`
      : `${ANIMEFLV}/browse?type[]=${type}&order=rating`;
    const html = await get(url);
    const $ = cheerio.load(html);
    const items = [];

    const selector = type === 'emision'
      ? 'ul.ListEpisodios li, ul.ListAnimes li'
      : 'ul.ListAnimes li article';

    $(selector).each((_, el) => {
      const a      = $(el).find('a').first();
      const img    = $(el).find('img');
      const title  = $(el).find('.Title, h3').first().text().trim();
      const href   = a.attr('href') || '';
      const poster = img.attr('src') || img.attr('data-src') || '';
      if (!title || !href) return;
      const slug = href.replace(/^\/anime\//, '').replace(/^\/ver\//, '').replace(/\/$/, '');
      items.push({
        id: slug,
        title,
        type: 'anime',
        mediaType: 'anime',
        poster: poster.startsWith('http') ? poster : (poster ? `${ANIMEFLV}${poster}` : ''),
        url: href.startsWith('http') ? href : `${ANIMEFLV}${href}`,
        _source: 'animeflv',
      });
    });
    return items;
  });
}

async function animeflvEpisodes(slug) {
  return cached(`flv:episodes:${slug}`, 30 * 60 * 1000, async () => {
    const html = await get(`${ANIMEFLV}/anime/${slug}`);
    const $ = cheerio.load(html);
    let episodes = [], animeInfo = {};
    $('script').each((_, el) => {
      const text = $(el).html() || '';
      const epM = text.match(/var episodes\s*=\s*(\[.*?\]);/s);
      if (epM) { try { episodes = JSON.parse(epM[1]); } catch (_) {} }
      const inM = text.match(/var anime_info\s*=\s*(\[.*?\]);/s);
      if (inM) { try { animeInfo = JSON.parse(inM[1]); } catch (_) {} }
    });
    const title    = $('h1.Title').text().trim();
    const synopsis = $('div.Description p').text().trim();
    const poster   = $('div.AnimeCover img').attr('src') || '';
    const genres   = [];
    $('nav.Nvgnrs a').each((_, el) => genres.push($(el).text().trim()));
    return {
      slug, title, synopsis,
      poster: poster.startsWith('http') ? poster : (poster ? `${ANIMEFLV}${poster}` : ''),
      genres,
      episodes: episodes.map(([num]) => ({ number: num })),
    };
  });
}

async function animeflvServers(episodeSlug) {
  return cached(`flv:srv:${episodeSlug}`, 15 * 60 * 1000, async () => {
    const html = await get(`${ANIMEFLV}/ver/${episodeSlug}`);
    const $ = cheerio.load(html);
    let videos = [];
    $('script').each((_, el) => {
      const text = $(el).html() || '';
      const m = text.match(/var videos\s*=\s*(\{.*?\});/s);
      if (m) {
        try {
          const parsed = JSON.parse(m[1]);
          for (const [lang, srvs] of Object.entries(parsed)) {
            for (const srv of srvs) {
              const name = (srv.title || srv.server || '').toLowerCase();
              // Priorizamos Streamwish, pero dejamos los demás como fallback
              videos.push({
                lang,
                server: srv.title || srv.server || 'Server',
                url: srv.code || srv.url || '',
                type: 'iframe',
                isPriority: name.includes('streamwish') || name.includes('wish')
              });
            }
          }
        } catch (_) {}
      }
    });
    
    // Ordenar: Priority primero
    videos.sort((a, b) => b.isPriority - a.isPriority);
    
    // Intentar resolver link directo para Streamwish con un tiempo límite estricto
    const resolvedServers = await Promise.all(videos.map(async (srv) => {
      try {
        const direct = await Promise.race([
          resolveDirectLink(srv.server, srv.url),
          new Promise(r => setTimeout(() => r(null), 2000))
        ]);
        if (direct) {
          return { ...srv, directUrl: direct.url, isM3U8: direct.isM3U8, quality: direct.quality };
        }
      } catch (e) {}
      return srv;
    }));

    return { servers: resolvedServers };
  });
}

// ── Anilist Discovery (Filtered) ──

app.get('/anime/trending', async (_, res) => {
  try {
    const items = await getAnilistTrending();
    const filtered = await filterAvailable(items);
    res.json(filtered);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/anime/popular', async (_, res) => {
  try {
    const items = await getAnilistPopular();
    const filtered = await filterAvailable(items);
    res.json(filtered);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/anime/movies', async (_, res) => {
  try {
    const items = await getAnilistMovies();
    const filtered = await filterAvailable(items);
    res.json(filtered);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/anime/calendar', async (_, res) => {
  console.log('--- Solicitud de Calendario ---');
  try {
    const now = Math.floor(Date.now() / 1000);
    const endOfWeek = now + (7 * 24 * 60 * 60);
    const query = `query ($start: Int, $end: Int) {
      Page(page: 1, perPage: 50) {
        airingSchedules(airingAt_greater: $start, airingAt_less: $end, sort: TIME) {
          airingAt
          episode
          media {
            id
            title { romaji english native }
            coverImage { extraLarge large }
            bannerImage
            averageScore
            seasonYear
            description
            format
          }
        }
      }
    }`;
    
    const response = await axios.post(ANILIST, 
      { query, variables: { start: now, end: endOfWeek } },
      { headers: { 'Content-Type': 'application/json' } }
    );
    
    const schedules = response.data?.data?.Page?.airingSchedules;
    if (!schedules) {
      console.log('Anilist no devolvió programación.');
      return res.json({});
    }

    console.log(`Recibidos ${schedules.length} eventos de Anilist.`);
    
    const days = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    const calendar = {};
    schedules.forEach(s => {
      if (!s.media) return;
      const date = new Date(s.airingAt * 1000);
      const dayName = days[date.getDay()];
      if (!calendar[dayName]) calendar[dayName] = [];
      
      calendar[dayName].push({
        ...formatAnilist(s.media),
        airingAt: s.airingAt,
        episode: s.episode
      });
    });
    res.json(calendar);
  } catch (e) { 
    console.error('[Error Calendario]', e.response?.data || e.message);
    res.status(500).json({ error: 'Error al obtener calendario de Anilist' }); 
  }
});

app.get('/anime/seasonal', async (req, res) => {
  const { season, year } = req.query;
  console.log(`--- Solicitud Estacional: ${season} ${year} ---`);
  try {
    const query = `query ($season: MediaSeason, $year: Int) {
      Page(page: 1, perPage: 30) {
        media(season: $season, seasonYear: $year, type: ANIME, sort: POPULARITY_DESC, isAdult: false) { ${ANIME_FIELDS} }
      }
    }`;
    const items = await anilistQuery(query, { season, year: parseInt(year) });
    console.log(`Encontrados ${items.length} animes para la temporada.`);
    const formatted = items.map(formatAnilist);
    res.json(formatted);
  } catch (e) { 
    console.error('[Error Estacional]', e.message);
    res.status(500).json({ error: e.message }); 
  }
});

// ── Mapeo ID Anilist -> Slug AnimeFLV ──

app.get('/anime/map/:anilistId', async (req, res) => {
  const { anilistId } = req.params;
  const title = req.query.title;
  if (!title) return res.status(400).json({ error: 'title required' });
  
  const slug = await findAnimeFLVSlug(anilistId, title);
  if (!slug) return res.status(404).json({ error: 'No mapping found' });
  res.json({ slug });
});

// ── Catálogos (AnimeFLV) ──

app.get('/catalog/anime', async (req, res) => {
  try { res.json(await animeflvCatalog('emision')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Búsqueda Unificada (Anime Only) ──

app.get('/search', async (req, res) => {
  const { q, sort, status, format } = req.query;
  if (!q) return res.status(400).json({ error: 'q required' });
  try {
    // Primero buscar en Anilist para obtener metadata rica y filtros
    const query = `query ($search: String, $sort: [MediaSort], $status: MediaStatus, $format: MediaFormat) {
      Page(page: 1, perPage: 20) {
        media(search: $search, sort: $sort, status: $status, format: $format, type: ANIME, isAdult: false) { ${ANIME_FIELDS} }
      }
    }`;
    const items = await anilistQuery(query, { 
      search: q, 
      sort: sort ? [sort] : ['POPULARITY_DESC'],
      status: status || undefined,
      format: format || undefined
    });
    
    const formatted = items.map(formatAnilist);
    // Filtrar los que están disponibles en AnimeFLV (opcional, pero mejora UX)
    const available = await filterAvailable(formatted);
    
    res.json({ anime: available, movies: [], series: [] });
  } catch (e) { 
    // Fallback a búsqueda directa en AnimeFLV si Anilist falla
    try {
      const results = await animeflvSearch(q);
      res.json({ anime: results, movies: [], series: [] });
    } catch (err) {
      res.status(500).json({ error: e.message }); 
    }
  }
});

// ── Anime: episodios y servidores ──

app.get('/anime/:slug/episodes', async (req, res) => {
  try { res.json(await animeflvEpisodes(req.params.slug)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/', (req, res) => {
  res.json({ status: 'online', service: 'AniPlay-Backend', version: '4.5' });
});

app.get('/anime/servers/:episodeSlug(*)', async (req, res) => {
  try { res.json(await animeflvServers(req.params.episodeSlug)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DIRECT STREAMING (Anify/Zoro) ───────────────────────────────────────────

async function getDirectStream(anilistId, epNum) {
  try {
    const infoUrl = `https://api.anify.tv/info/${anilistId}`;
    const infoRes = await axios.get(infoUrl, { timeout: 5000 });
    const data = infoRes.data;

    const providerIds = (data.episodes || []).map(p => p.id);
    const sortedProviders = ['zoro', 'aniwatch', 'gogoanime', 'animepahe'].filter(p => providerIds.includes(p));

    // Intentar todos los proveedores en paralelo y tomar el primero que tenga subs en español
    const results = await Promise.all(sortedProviders.map(async (providerId) => {
      try {
        const watchUrl = `https://api.anify.tv/watch/${data.id}/${epNum}/${providerId}`;
        const watchRes = await axios.get(watchUrl, { timeout: 5000 });
        const sources = watchRes.data;

        if (!sources || !sources.sources || sources.sources.length === 0) return null;

        const spanishSubs = (sources.subtitles || []).find(s => {
          const l = s.lang.toLowerCase();
          return l.includes('spanish') || l.includes('latino') || l.includes('español') || l.includes('spa') || l.includes('esp');
        });

        if (spanishSubs) {
          return {
            sources: sources.sources,
            subtitles: sources.subtitles,
            preferredSub: spanishSubs.url,
            providerId
          };
        }
      } catch (e) {
        return null;
      }
      return null;
    }));

    return results.find(r => r !== null) || null;
  } catch (e) {
    console.error('[Direct Stream Error]', e.message);
    return null;
  }
}

app.get('/anime/stream-direct/:anilistId/:episode', async (req, res) => {
  let { anilistId, episode } = req.params;
  // Limpiar ID por si viene con prefijo
  const cleanId = anilistId.replace('anilist-', '');
  console.log(`[Direct] Buscando stream directo para Anilist: ${cleanId}, Ep: ${episode}`);
  
  const result = await getDirectStream(cleanId, episode);
  if (!result) {
    console.log('[Direct] No se encontró fuente directa con subtítulos en español.');
    return res.status(404).json({ error: 'No direct source with Spanish subs found' });
  }
  res.json(result);
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────

async function get(url) {
  const res = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  return res.data;
}

const cache = new Map();
function cached(key, ttl, fn) {
  const now = Date.now();
  if (cache.has(key)) {
    const entry = cache.get(key);
    if (now - entry.timestamp < ttl) return entry.data;
  }
  return fn().then(data => {
    cache.set(key, { data, timestamp: now });
    return data;
  });
}

const mappingCache = new Map();

async function findAnimeFLVSlug(anilistId, title) {
  if (mappingCache.has(anilistId)) return mappingCache.get(anilistId);
  
  try {
    const results = await animeflvSearch(title);
    if (results && results.length > 0) {
      // Intentar encontrar el mejor match (por ahora el primero ya es bueno)
      const slug = results[0].id;
      mappingCache.set(anilistId, slug);
      return slug;
    }
  } catch (e) { console.error(`[Map Error] ${title}:`, e.message); }
  return null;
}

async function filterAvailable(items) {
  const result = [];
  // Procesamos en grupos de 5 para no saturar
  for (let i = 0; i < items.length; i += 5) {
    const chunk = items.slice(i, i + 5);
    const checked = await Promise.all(chunk.map(async (item) => {
      const slug = await findAnimeFLVSlug(item.anilistId, item.title);
      return slug ? { ...item, slug } : null;
    }));
    result.push(...checked.filter(Boolean));
    if (result.length >= 12) break; // Con 12 sugerencias es suficiente y rápido
  }
  return result;
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n⛩  AniPlay ANIME-ONLY en http://localhost:${PORT}`);
  console.log(`\n  Fuentes:`);
  console.log(`  ├─ Descubrimiento: Anilist + Auto-Mapping`);
  console.log(`  └─ Streaming:      AnimeFLV + Anify Direct\n`);
});
