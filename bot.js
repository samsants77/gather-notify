const WebSocket = require('ws');
const http = require('http');
const url = require('url');
const dns = require('dns');
const { promisify } = require('util');

const dnsLookup = promisify(dns.lookup);
const dnsResolve4 = promisify(dns.resolve4);

// ===================== CONFIGURAÇÕES =====================
const GATHER_API_KEY = process.env.GATHER_API_KEY || '5y3xKlHUiEBYeTMq';
const GATHER_SPACE_ID = process.env.GATHER_SPACE_ID || '4601933d-6215-4853-9f04-aa1d7d5fba92';
const PORT = process.env.PORT || 3000;

// ===================== ESTADO =====================
let ws = null;
let connected = false;
let reconnectAttempts = 0;
let lastError = null;
let messageQueue = [];
let reconnectTimer = null;

// ===================== FALLBACK IPs DO GATHER =====================
// IPs conhecidos do Gather (atualizados periodicamente)
const GATHER_FALLBACK_IPS = [
  '18.214.26.48',
  '3.225.6.48',
  '54.209.100.91'
];

// ===================== FUNÇÕES DNS =====================
async function resolveGatherIP() {
  const methods = [];

  // Método 1: dns.lookup
  try {
    const result = await dnsLookup('game.gather.town');
    methods.push({ method: 'dns.lookup', ip: result.address });
  } catch (e) {
    methods.push({ method: 'dns.lookup', error: e.message });
  }

  // Método 2: dns.resolve4
  try {
    const results = await dnsResolve4('game.gather.town');
    if (results && results.length > 0) {
      methods.push({ method: 'dns.resolve4', ip: results[0] });
    }
  } catch (e) {
    methods.push({ method: 'dns.resolve4', error: e.message });
  }

  // Método 3: Tentar conectar HTTPS e pegar IP
  try {
    const https = require('https');
    const ip = await new Promise((resolve, reject) => {
      const req = https.get('https://game.gather.town', { timeout: 5000 }, (res) => {
        const socket = res.socket;
        if (socket && socket.remoteAddress) {
          resolve(socket.remoteAddress);
        } else {
          reject(new Error('No remote address'));
        }
        res.destroy();
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
    methods.push({ method: 'https.get', ip: ip });
  } catch (e) {
    methods.push({ method: 'https.get', error: e.message });
  }

  console.log('🔍 DNS Resolution attempts:', JSON.stringify(methods, null, 2));

  // Retorna o primeiro IP válido encontrado
  for (const m of methods) {
    if (m.ip) return m.ip;
  }

  // Fallback para IPs conhecidos
  console.log('⚠️  Usando IP fallback:', GATHER_FALLBACK_IPS[0]);
  return GATHER_FALLBACK_IPS[0];
}

// ===================== CONEXÃO GATHER =====================
async function connectToGather() {
  if (connected || reconnectAttempts > 20) return;

  reconnectAttempts++;
  console.log(`🔄 Tentativa de conexão #${reconnectAttempts}...`);

  try {
    const ip = await resolveGatherIP();
    const wsUrl = `wss://${ip}/?spaceId=${GATHER_SPACE_ID}&apiKey=${GATHER_API_KEY}`;

    console.log(`🔗 Conectando em: wss://${ip}/...`);

    ws = new WebSocket(wsUrl, {
      headers: {
        'Host': 'game.gather.town',
        'Origin': 'https://app.gather.town',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      rejectUnauthorized: false, // Necessário quando conecta por IP direto
      handshakeTimeout: 15000,
      perMessageDeflate: false
    });

    ws.on('open', () => {
      console.log('✅ Conectado ao Gather!');
      connected = true;
      reconnectAttempts = 0;
      lastError = null;

      // Enviar mensagens pendentes
      while (messageQueue.length > 0) {
        const msg = messageQueue.shift();
        sendChatMessage(msg.text, msg.mapId);
      }
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.event === 'ready') {
          console.log('🎉 Gather está pronto!');
        }
      } catch (e) {
        // Ignora mensagens não-JSON
      }
    });

    ws.on('error', (err) => {
      console.error('❌ Erro WebSocket:', err.message);
      lastError = err.message;
      connected = false;
    });

    ws.on('close', () => {
      console.log('🔌 Conexão fechada. Reconectando em 5s...');
      connected = false;
      ws = null;

      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => connectToGather(), 5000);
    });

  } catch (err) {
    console.error('❌ Falha ao conectar:', err.message);
    lastError = err.message;
    connected = false;

    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => connectToGather(), 10000);
  }
}

// ===================== ENVIAR MENSAGEM =====================
function sendChatMessage(text, mapId = 'office') {
  if (!connected || !ws || ws.readyState !== WebSocket.OPEN) {
    console.log('📥 Mensagem enfileirada:', text);
    messageQueue.push({ text, mapId });
    return false;
  }

  try {
    ws.send(JSON.stringify({
      event: 'playerInteracts',
      payload: {
        data: {
          objectId: 'notification-bot',
          mapId: mapId,
          key: 'spaceId',
          value: GATHER_SPACE_ID
        }
      }
    }));

    // Usar o evento correto do Gather para chat
    ws.send(JSON.stringify({
      event: 'playerChats',
      payload: {
        contents: text,
        mapId: mapId,
        recipient: 'global'
      }
    }));

    console.log('💬 Mensagem enviada:', text);
    return true;
  } catch (err) {
    console.error('❌ Erro ao enviar:', err.message);
    messageQueue.push({ text, mapId });
    return false;
  }
}

// ===================== SERVIDOR HTTP =====================
const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);

  // Health check
  if (parsedUrl.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      connected: connected,
      queueSize: messageQueue.length,
      reconnectAttempts: reconnectAttempts,
      lastError: lastError,
      apiKeyConfigured: !!GATHER_API_KEY,
      spaceId: GATHER_SPACE_ID,
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // Receber notificação
  if (parsedUrl.pathname === '/notify' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const message = data.message || 'Novo download detectado!';
        const mapId = data.mapId || 'office';

        console.log('📨 Notificação recebida:', message);

        const sent = sendChatMessage(message, mapId);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          sent: sent,
          connected: connected,
          message: message,
          queueSize: messageQueue.length
        }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// ===================== INICIAR =====================
server.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`🔑 API Key configurada: ${GATHER_API_KEY ? 'Sim' : 'NÃO!'}`);
  console.log(`🌐 Space ID: ${GATHER_SPACE_ID}`);

  // Iniciar conexão com Gather
  connectToGather();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM recebido. Desligando...');
  if (ws) ws.close();
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT recebido. Desligando...');
  if (ws) ws.close();
  server.close(() => process.exit(0));
});
