const axios = require('axios');

// Tu URL de Render
const URL = 'https://animeapp-z49m.onrender.com/ping';

console.log('🚀 Monitor Keep-Alive iniciado...');
console.log(`📡 Enviando ping a: ${URL} cada 14 minutos.`);

function ping() {
  const timestamp = new Date().toLocaleTimeString();
  axios.get(URL)
    .then(() => {
      console.log(`[${timestamp}] ✅ Ping exitoso: Servidor despierto.`);
    })
    .catch((err) => {
      console.log(`[${timestamp}] ❌ Error en ping:`, err.message);
    });
}

// Enviar el primer ping de inmediato
ping();

// Repetir cada 14 minutos (en milisegundos)
setInterval(ping, 14 * 60 * 1000);
