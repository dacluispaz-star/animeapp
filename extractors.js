const axios = require('axios');
const cheerio = require('cheerio');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Extractor para Fembed / Femax / Feurl
 */
async function resolveFembed(url) {
  try {
    // Convertir URL de embed a URL de API
    // Ejemplo: https://www.fembed.com/v/xxxx -> https://www.fembed.com/api/source/xxxx
    const id = url.split('/').pop();
    const domain = new URL(url).origin;
    
    const res = await axios.post(`${domain}/api/source/${id}`, {}, {
      headers: { 'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest' },
      timeout: 4000
    });
    
    if (res.data && res.data.success) {
      // Devolver la calidad más alta disponible
      const sources = res.data.data.map(s => ({
        url: s.file,
        quality: s.label,
        isM3U8: s.file.includes('.m3u8')
      }));
      return sources.sort((a, b) => parseInt(b.quality) - parseInt(a.quality))[0];
    }
  } catch (e) {
    console.error('[Extractor Fembed] Error:', e.message);
  }
  return null;
}

/**
 * Extractor para OK.ru
 */
async function resolveOkru(url) {
  try {
    const res = await axios.get(url, { headers: { 'User-Agent': UA }, timeout: 4000 });
    const $ = cheerio.load(res.data);
    const dataOptions = $('div[data-options]').attr('data-options');
    
    if (dataOptions) {
      const json = JSON.parse(dataOptions);
      const metadata = JSON.parse(json.flashvars.metadata);
      // OK.ru devuelve un array de videos con diferentes calidades
      if (metadata.videos && metadata.videos.length > 0) {
        const best = metadata.videos.sort((a, b) => {
          const qA = { 'top': 4, 'vh': 3, 'hd': 2, 'sd': 1, 'low': 0 }[a.name] || 0;
          const qB = { 'top': 4, 'vh': 3, 'hd': 2, 'sd': 1, 'low': 0 }[b.name] || 0;
          return qB - qA;
        })[0];
        
        return {
          url: best.url,
          quality: best.name,
          isM3U8: best.url.includes('.m3u8')
        };
      }
    }
  } catch (e) {
    console.error('[Extractor Okru] Error:', e.message);
  }
  return null;
}

/**
 * Extractor para Streamwish (y clones como awish, wishembed)
 */
async function resolveStreamwish(url) {
  try {
    const domain = new URL(url).origin;
    const res = await axios.get(url, { 
      headers: { 
        'User-Agent': UA,
        'Referer': 'https://www4.animeflv.net/',
        'Origin': 'https://www4.animeflv.net',
        'Sec-Fetch-Dest': 'iframe',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'cross-site'
      },
      timeout: 2000
    });
    const source = res.data;
    
    // Si todavía muestra "Loading", es que el Referer no fue suficiente o cambió el script
    if (source.includes('Page is loading')) {
       console.log('[Extractor Streamwish] Landing page detected, attempt bypass...');
       // A veces requieren una cookie que se pone en una segunda petición
       // Pero con el Referer correcto suele bastar. Intentamos regex de nuevo por si acaso.
    }

    const m3u8Match = source.match(/file:\s*"([^"]+\.m3u8[^"]*)"/) || 
                     source.match(/sources:\s*\[\s*{\s*file:\s*"([^"]+\.m3u8[^"]*)"/);
    
    if (m3u8Match) {
      return {
        url: m3u8Match[1],
        quality: '720p/1080p',
        isM3U8: true
      };
    }
  } catch (e) {
    console.error('[Extractor Streamwish] Error:', e.message);
  }
  return null;
}

/**
 * Extractor para Voe
 */
async function resolveVoe(url) {
  try {
    const res = await axios.get(url, { 
      headers: { 
        'User-Agent': UA,
        'Referer': 'https://www4.animeflv.net/',
      },
      timeout: 4000
    });
    const source = res.data;
    
    const hlsMatch = source.match(/"hls":\s*"([^"]+)"/);
    if (hlsMatch) {
      return {
        url: hlsMatch[1],
        quality: 'Original',
        isM3U8: true
      };
    }
  } catch (e) {
    console.error('[Extractor Voe] Error:', e.message);
  }
  return null;
}

/**
 * Resolver unívoco que intenta extraer el link directo si el servidor es soportado
 */
async function resolveDirectLink(serverName, url) {
  const name = serverName.toLowerCase();
  
  if (name.includes('fembed') || name.includes('femax') || name.includes('feurl')) {
    return await resolveFembed(url);
  }
  
  if (name.includes('okru')) {
    return await resolveOkru(url);
  }

  if (name.includes('streamwish') || name.includes('wish')) {
    return await resolveStreamwish(url);
  }

  if (name.includes('voe')) {
    return await resolveVoe(url);
  }

  return null;
}

module.exports = { resolveDirectLink };
