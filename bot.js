const { Game } = require('@gathertown/gather-game-client');
const http = require('http');
const url = require('url');

// ===================== CONFIGURAÇÕES =====================
const GATHER_API_KEY = process.env.GATHER_API_KEY || '5y3xKlHUiEBYeTMq';
const GATHER_SPACE_ID = process.env.GATHER_SPACE_ID || '4601933d-6215-4853-9f04-aa1d7d5fba92';
const PORT = process.env.PORT || 3000;

// ===================== ESTADO =====================
let game = null;
let connected = false;
let reconnectAttempts = 0;
let lastError = null;
let messageQueue = [];
let reconnectTimer = null;

// ===================== CONEXÃO GATHER (BIBLIOTECA OFICIAL) =====================
function connectToGather() {
  if (connected || reconnectAttempts > 20) return;

  reconnectAttempts++;
  console.log(`🔄 Tentativa de conexão #${reconnectAttempts}...`);

  try {
    game = new Game(GATHER_SPACE_ID, () => GATHER_API_KEY);

    // Evento de conexão
    game.subscribeToConnection((connected_) => {
      connected = connected_;
      if (connected_) {
        console.log('✅ Conectado ao Gather via biblioteca oficial!');
        reconnectAttempts = 0;
        lastError = null;

        // Enviar mensagens pendentes
        while (messageQueue.length > 0) {
          const msg = messageQueue.shift();
          sendChatMessage(msg.text, msg.mapId);
        }
      } else {
        console.log('🔌 Desconectado do Gather. Reconectando em 5s...');
        lastError = 'Desconectado';

        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => connectToGather(), 5000);
      }
    });

    // Evento de erro
    game.subscribeToEvent('error', (data) => {
      console.error('❌ Erro do Gather:', data);
      lastError = JSON.stringify(data);
    });

    // Conectar
    game.connect();
    console.log('🔗 Iniciando conexão com Gather...');

  } catch (err) {
    console.error('❌ Falha ao criar conexão:', err.message);
    lastError = err.message;
    connected = false;

    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => connectToGather(), 10000);
  }
}

// ===================== ENVIAR MENSAGEM =====================
function sendChatMessage(text, mapId = 'office') {
  if (!connected || !game) {
    console.log('📥 Mensagem enfileirada:', text);
    messageQueue.push({ text, mapId });
    return false;
  }

  try {
    // Enviar mensagem no chat global usando a biblioteca oficial
    // O evento correto para chat no Gather é 'playerChats'
    game.sendAction('playerChats', {
      contents: text,
      mapId: mapId,
      recipient: 'global'
    });

    console.log('💬 Mensagem enviada via biblioteca oficial:', text);
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
  if (game) game.disconnect();
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT recebido. Desligando...');
  if (game) game.disconnect();
  server.close(() => process.exit(0));
});
