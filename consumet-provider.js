const { ANIME } = require('@consumet/extensions');

// Usaremos AnimeFLV como proveedor principal en español
const provider = new ANIME.AnimeFlv();

/**
 * Busca anime en AnimeFLV
 */
async function searchAnime(query) {
  try {
    const results = await provider.search(query);
    return results.results || [];
  } catch (error) {
    console.error('Error en búsqueda Consumet:', error);
    return [];
  }
}

/**
 * Obtiene info detallada y lista de episodios
 */
async function getAnimeInfo(id) {
  try {
    const info = await provider.fetchAnimeInfo(id);
    return info;
  } catch (error) {
    console.error('Error info Consumet:', error);
    return null;
  }
}

/**
 * Obtiene los enlaces de video directos de un episodio
 */
async function getEpisodeSources(episodeId) {
  try {
    // Consumet intenta resolver los enlaces a directos (.m3u8)
    const sources = await provider.fetchEpisodeSources(episodeId);
    return sources;
  } catch (error) {
    console.error('Error sources Consumet:', error);
    return null;
  }
}

module.exports = {
  searchAnime,
  getAnimeInfo,
  getEpisodeSources
};
