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
  return {
    id: `anilist-${item.id}`,
    anilistId: item.id,
    title: item.title.romaji || item.title.english || item.title.native,
    type: 'anime',
    mediaType: 'anime',
    poster: item.coverImage.extraLarge || item.coverImage.large,
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
        return { ...srv, directUrl: direct.url, isM3U8: direct.isM3U8, quality: direct.quality };
      }
      return srv;
    }));
    return { servers: resolvedServers };
  });
}

// ── Anilist Discovery ──

app.get('/anime/trending', async (_, res) => {
  try { res.json(await getAnilistTrending()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/anime/popular', async (_, res) => {
  try { res.json(await getAnilistPopular()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/anime/movies', async (_, res) => {
  try { res.json(await getAnilistMovies()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Catálogos (AnimeFLV) ──

app.get('/catalog/anime', async (req, res) => {
  try { res.json(await animeflvCatalog('emision')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Búsqueda Unificada (Anime Only) ──

app.get('/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'q required' });
  try {
    const results = await animeflvSearch(q);
    res.json({ anime: results, movies: [], series: [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    const infoRes = await axios.get(infoUrl);
    const data = infoRes.data;

    const episodes = data.episodes || [];
    const zoro = episodes.find(p => p.id === 'zoro' || p.id === 'aniwatch');
    
    if (!zoro) return null;

    const watchUrl = `https://api.anify.tv/watch/${data.id}/${epNum}/zoro`;
    const watchRes = await axios.get(watchUrl);
    const sources = watchRes.data;

    if (!sources || !sources.sources) return null;

    const spanishSubs = (sources.subtitles || []).find(s => 
      s.lang.toLowerCase().includes('spanish') || 
      s.lang.toLowerCase().includes('latino')
    );

    if (!spanishSubs) return null;

    return {
      sources: sources.sources,
      subtitles: sources.subtitles,
      preferredSub: spanishSubs.url
    };
  } catch (e) {
    console.error('[Direct Stream Error]', e.message);
    return null;
  }
}

app.get('/anime/stream-direct/:anilistId/:episode', async (req, res) => {
  const { anilistId, episode } = req.params;
  const result = await getDirectStream(anilistId, episode);
  if (!result) return res.status(404).json({ error: 'No direct source with Spanish subs found' });
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n⛩  AniPlay ANIME-ONLY en http://localhost:${PORT}`);
  console.log(`\n  Fuentes:`);
  console.log(`  ├─ Descubrimiento: Anilist (GraphQL)`);
  console.log(`  └─ Streaming:      AnimeFLV + Anify Direct\n`);
});
