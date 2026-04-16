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

// TMDB — obtén tu key gratis en https://www.themoviedb.org/settings/api
const TMDB_KEY = process.env.TMDB_KEY || '';
const TMDB     = 'https://api.themoviedb.org/3';
const TMDB_IMG = 'https://image.tmdb.org/t/p/w500';
const TMDB_BG  = 'https://image.tmdb.org/t/p/w1280';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Embed providers que usan TMDB ID (sin necesidad de scraping)
// Se intentan en orden hasta encontrar uno que funcione
const EMBED_PROVIDERS = {
  movie: [
    (id) => `https://vidsrc.to/embed/movie/${id}`,
    (id) => `https://vidsrc.me/embed/movie?tmdb=${id}`,
    (id) => `https://www.2embed.cc/embed/${id}`,
    (id) => `https://player.videasy.net/movie/${id}`,
    (id) => `https://embed.su/embed/movie/${id}`,
    (id) => `https://multiembed.mov/?video_id=${id}&tmdb=1`,
    (id) => `https://autoembed.co/movie/tmdb/${id}`,
  ],
  tv: [
    (id, s, e) => `https://vidsrc.to/embed/tv/${id}/${s}/${e}`,
    (id, s, e) => `https://vidsrc.me/embed/tv?tmdb=${id}&season=${s}&episode=${e}`,
    (id, s, e) => `https://www.2embed.cc/embedtv/${id}&s=${s}&e=${e}`,
    (id, s, e) => `https://player.videasy.net/tv/${id}/${s}/${e}`,
    (id, s, e) => `https://embed.su/embed/tv/${id}/${s}/${e}`,
    (id, s, e) => `https://autoembed.co/tv/tmdb/${id}-${s}-${e}`,
  ],
};

// ─── CACHE ───────────────────────────────────────────────────────────────────

const _cache = new Map();
function cached(key, ttlMs, fn) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.ts < ttlMs) return Promise.resolve(hit.data);
  return fn().then(data => { _cache.set(key, { data, ts: Date.now() }); return data; });
}

async function get(url, params = {}, extraHeaders = {}) {
  const res = await axios.get(url, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'es-ES,es;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      ...extraHeaders,
    },
    timeout: 14000,
    params,
  });
  return res.data;
}

// ─── TMDB ─────────────────────────────────────────────────────────────────────

function tmdbGet(path, params = {}) {
  if (!TMDB_KEY) throw new Error('TMDB_KEY no configurada en .env');
  return get(`${TMDB}${path}`, { api_key: TMDB_KEY, language: 'es-ES', ...params });
}

async function tmdbTrending(type = 'movie') {
  return cached(`tmdb:trending:${type}`, 10 * 60 * 1000, async () => {
    const data = await tmdbGet(`/trending/${type}/week`);
    return (data.results || []).map(item => formatTMDB(item, type === 'tv' ? 'series' : 'movie'));
  });
}

async function tmdbPopular(type = 'movie', page = 1) {
  return cached(`tmdb:popular:${type}:${page}`, 15 * 60 * 1000, async () => {
    const endpoint = type === 'tv' ? '/tv/popular' : '/movie/popular';
    const data = await tmdbGet(endpoint, { page, region: 'MX' });
    return (data.results || []).map(item => formatTMDB(item, type === 'tv' ? 'series' : 'movie'));
  });
}

async function tmdbTopRated(type = 'movie', page = 1) {
  return cached(`tmdb:toprated:${type}:${page}`, 30 * 60 * 1000, async () => {
    const endpoint = type === 'tv' ? '/tv/top_rated' : '/movie/top_rated';
    const data = await tmdbGet(endpoint, { page });
    return (data.results || []).map(item => formatTMDB(item, type === 'tv' ? 'series' : 'movie'));
  });
}

async function tmdbSearch(query, type = 'multi') {
  return cached(`tmdb:search:${type}:${query}`, 5 * 60 * 1000, () =>
    tmdbGet(`/search/${type}`, { query, region: 'MX' })
      .then(d => (d.results || []).map(r => formatTMDB(r)))
  );
}

async function tmdbMovieDetail(id) {
  return cached(`tmdb:movie:detail:${id}`, 60 * 60 * 1000, () =>
    tmdbGet(`/movie/${id}`, { append_to_response: 'credits,videos' })
  );
}

async function tmdbTVDetail(id) {
  return cached(`tmdb:tv:detail:${id}`, 60 * 60 * 1000, () =>
    tmdbGet(`/tv/${id}`, { append_to_response: 'credits,videos' })
  );
}

async function tmdbTVSeason(id, season) {
  return cached(`tmdb:tv:season:${id}:${season}`, 60 * 60 * 1000, () =>
    tmdbGet(`/tv/${id}/season/${season}`)
  );
}

function formatTMDB(item, forcedType = null) {
  const isTV = forcedType === 'series' || item.media_type === 'tv' || !!item.first_air_date;
  const type = forcedType || (isTV ? 'series' : 'movie');
  return {
    id: String(item.id),
    tmdbId: item.id,
    title: item.title || item.name || '',
    type,
    poster: item.poster_path  ? `${TMDB_IMG}${item.poster_path}`  : '',
    backdrop: item.backdrop_path ? `${TMDB_BG}${item.backdrop_path}` : '',
    overview: item.overview || '',
    rating: item.vote_average ? item.vote_average.toFixed(1) : '',
    year: (item.release_date || item.first_air_date || '').slice(0, 4),
    _source: 'tmdb',
  };
}

// ─── EMBED SERVERS para Películas/Series (usando TMDB ID) ────────────────────

function getMovieServers(tmdbId) {
  return EMBED_PROVIDERS.movie.map((fn, i) => ({
    server: getProviderName(fn(tmdbId)),
    url: fn(tmdbId),
    lang: 'LAT/SUB',
    type: 'iframe',
    priority: i,
  }));
}

function getTVServers(tmdbId, season = 1, episode = 1) {
  return EMBED_PROVIDERS.tv.map((fn, i) => ({
    server: getProviderName(fn(tmdbId, season, episode)),
    url: fn(tmdbId, season, episode),
    lang: 'LAT/SUB',
    type: 'iframe',
    priority: i,
  }));
}

function getProviderName(url) {
  try {
    const host = new URL(url).hostname.replace('www.', '').replace('.cc', '').replace('.to', '').replace('.me', '');
    const names = {
      'vidsrc': 'VidSrc',
      '2embed': '2Embed',
      'player.videasy': 'Videasy',
      'embed.su': 'EmbedSU',
      'multiembed.mov': 'MultiEmbed',
      'autoembed.co': 'AutoEmbed',
    };
    for (const [key, name] of Object.entries(names)) {
      if (host.includes(key)) return name;
    }
    return host.split('.')[0].charAt(0).toUpperCase() + host.split('.')[0].slice(1);
  } catch { return 'Servidor'; }
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
              videos.push({
                lang,
                server: srv.title || srv.server || 'Unknown',
                url: srv.code || srv.url || '',
                type: 'iframe',
              });
            }
          }
        } catch (_) {}
      }
    });
    
    // Intentar resolver links directos para servidores compatibles
    const resolvedServers = await Promise.all(videos.map(async (srv) => {
      const direct = await resolveDirectLink(srv.server, srv.url);
      if (direct) {
        return { ...srv, directUrl: direct.url, quality: direct.quality, isM3U8: direct.isM3U8 };
      }
      return srv;
    }));

    return { episodeSlug, servers: resolvedServers };
  });
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

app.get('/health', (_, res) => res.json({ ok: true, version: '3.1-fixed' }));

// ── Catálogos ──

app.get('/catalog/anime', async (req, res) => {
  try { res.json(await animeflvCatalog('emision')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/catalog/movies', async (req, res) => {
  if (!TMDB_KEY) return res.status(400).json({ error: 'TMDB_KEY requerida en .env' });
  try {
    const page = parseInt(req.query.page) || 1;
    const list = req.query.list || 'popular'; // popular | trending | top_rated
    let items;
    if (list === 'trending') items = await tmdbTrending('movie');
    else if (list === 'top_rated') items = await tmdbTopRated('movie', page);
    else items = await tmdbPopular('movie', page);
    res.json(items);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/catalog/series', async (req, res) => {
  if (!TMDB_KEY) return res.status(400).json({ error: 'TMDB_KEY requerida en .env' });
  try {
    const page = parseInt(req.query.page) || 1;
    const list = req.query.list || 'popular';
    let items;
    if (list === 'trending') items = await tmdbTrending('tv');
    else if (list === 'top_rated') items = await tmdbTopRated('tv', page);
    else items = await tmdbPopular('tv', page);
    res.json(items);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Búsqueda unificada ──

app.get('/search', async (req, res) => {
  const { q, type } = req.query;
  if (!q) return res.status(400).json({ error: 'q required' });
  try {
    const [flvR, tmdbR] = await Promise.allSettled([
      (type !== 'movie' && type !== 'series') ? animeflvSearch(q) : Promise.resolve([]),
      (TMDB_KEY && type !== 'anime') ? tmdbSearch(q, 'multi') : Promise.resolve([]),
    ]);
    const tmdbItems = tmdbR.status === 'fulfilled' ? tmdbR.value : [];
    res.json({
      anime:  flvR.status === 'fulfilled' ? flvR.value : [],
      movies: tmdbItems.filter(i => i.type === 'movie'),
      series: tmdbItems.filter(i => i.type === 'series'),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Anime: episodios y servidores ──

app.get('/anime/:slug/episodes', async (req, res) => {
  try { res.json(await animeflvEpisodes(req.params.slug)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/anime/servers/:episodeSlug(*)', async (req, res) => {
  try { res.json(await animeflvServers(req.params.episodeSlug)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Películas: servidores por TMDB ID ──

app.get('/movie/servers/:tmdbId', async (req, res) => {
  try {
    const servers = getMovieServers(req.params.tmdbId);
    res.json({ servers, tmdbId: req.params.tmdbId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Series: info de temporadas ──

app.get('/series/info/:tmdbId', async (req, res) => {
  if (!TMDB_KEY) return res.status(400).json({ error: 'TMDB_KEY requerida' });
  try {
    const detail = await tmdbTVDetail(req.params.tmdbId);
    res.json({
      tmdbId: detail.id,
      title: detail.name,
      overview: detail.overview,
      poster: detail.poster_path ? `${TMDB_IMG}${detail.poster_path}` : '',
      backdrop: detail.backdrop_path ? `${TMDB_BG}${detail.backdrop_path}` : '',
      seasons: (detail.seasons || [])
        .filter(s => s.season_number > 0)
        .map(s => ({
          season: s.season_number,
          name: s.name,
          episodeCount: s.episode_count,
          poster: s.poster_path ? `${TMDB_IMG}${s.poster_path}` : '',
        })),
      numberOfSeasons: detail.number_of_seasons,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/series/season/:tmdbId/:season', async (req, res) => {
  if (!TMDB_KEY) return res.status(400).json({ error: 'TMDB_KEY requerida' });
  try {
    const data = await tmdbTVSeason(req.params.tmdbId, req.params.season);
    res.json({
      season: data.season_number,
      episodes: (data.episodes || []).map(ep => ({
        number: ep.episode_number,
        name: ep.name,
        overview: ep.overview,
        still: ep.still_path ? `https://image.tmdb.org/t/p/w300${ep.still_path}` : '',
        runtime: ep.runtime,
        airDate: ep.air_date,
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/series/episode/servers/:tmdbId/:season/:episode', async (req, res) => {
  try {
    const { tmdbId, season, episode } = req.params;
    const servers = getTVServers(tmdbId, season, episode);
    res.json({ servers, tmdbId, season, episode });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── TMDB detalle directo ──

app.get('/tmdb/movie/:id', async (req, res) => {
  if (!TMDB_KEY) return res.status(400).json({ error: 'TMDB_KEY no configurada' });
  try { res.json(await tmdbMovieDetail(req.params.id)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/tmdb/tv/:id', async (req, res) => {
  if (!TMDB_KEY) return res.status(400).json({ error: 'TMDB_KEY no configurada' });
  try { res.json(await tmdbTVDetail(req.params.id)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🎬 AniPlay v3.1-FIXED en http://localhost:${PORT}`);
  console.log(`\n  Fuentes:`);
  console.log(`  ├─ Anime:      AnimeFLV   → /catalog/anime`);
  console.log(`  ├─ Películas:  TMDB       → /catalog/movies`);
  console.log(`  ├─ Series:     TMDB       → /catalog/series`);
  console.log(`  └─ Embeds:     vidsrc/2embed/videasy/embed.su\n`);
  if (!TMDB_KEY) {
    console.log(`  ⚠  TMDB_KEY no configurada.`);
    console.log(`     Películas y series NO funcionarán sin ella.`);
    console.log(`     Obtén tu key gratis en: https://www.themoviedb.org/settings/api`);
    console.log(`     Luego pon en server/.env:\n     TMDB_KEY=tu_clave\n`);
  }
});
