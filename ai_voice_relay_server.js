/**
 * Voice AI Relay for Twilio Programmable Voice + OpenAI Realtime + n8n
 * ------------------------------------------------------------
 * - Espone /voice (TwiML) che ordina a Twilio di aprire uno Stream su /twilio-media (WebSocket)
 * - Bridgia audio Twilio <-> OpenAI Realtime (parla/ascolta in tempo reale)
 * - Accumula transcript + campi e POSTa un riepilogo a n8n a fine chiamata
 *
 * Requisiti:
 *  - Node 18+
 *  - npm i express twilio body-parser ws node-fetch dotenv
 *
 * .env (esempio):
 *   PORT=3000
 *   OPENAI_API_KEY=sk-...
 *   N8N_SUMMARY_WEBHOOK=https://<tuo-n8n>/webhook/ai-receptionist/summary
 *   SYSTEM_PROMPT=... (vedi sotto)
 *
 * NOTE: esempio semplificato. In produzione: HTTPS, auth, retry, logging, ecc.
 */
import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';
import { WebSocketServer, WebSocket } from 'ws';

const app = express();
app.set('trust proxy', 1); // Siamo dietro proxy (Render/Heroku/etc.)
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const N8N_SUMMARY_WEBHOOK = process.env.N8N_SUMMARY_WEBHOOK;
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  `Sei una centralinista virtuale di Revan SAS, azienda di consulenza IT e digitale.
Parli in modo cordiale, professionale e chiaro, con tono umano e naturale.
OBIETTIVO: accogliere l’interlocutore, capire il motivo della chiamata e raccogliere dati essenziali.
ISTRUZIONI:
1) Rispondi sempre in italiano.
2) Saluta e identifica l’azienda (“Buongiorno, Revan, come posso aiutarla?”).
3) Raccogli: Nome, Azienda, Motivo della chiamata, Urgenza (1–5), Recapito (tel/email), Fascia oraria per richiamo.
4) Se chiedono un referente: spiega che al momento non è disponibile e che inoltrerai il messaggio.
5) Mantieni risposte brevi (max 2 frasi).
6) Chiudi: “Grazie, la faremo richiamare al più presto. Buona giornata!”.
`;

/** Store in-memory per demo: callSid -> { transcript: [], fields: {}, start } */
const sessions = new Map();

/**
 * 1) TwiML endpoint – Twilio lo chiama quando arriva una telefonata.
 *    Forziamo SEMPRE wss:// (niente ws://) per evitare errori 11100/handshake.
 */
app.post('/voice', (req, res) => {
  const callSid = req.body?.CallSid || `call_${Date.now()}`;
  const host = req.get('host');
  const wsUrl = `wss://${host}/twilio-media?callSid=${encodeURIComponent(callSid)}`;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;
  sessions.set(callSid, { transcript: [], fields: {}, start: Date.now() });
  console.log('[TwiML] callSid', callSid, 'wsUrl', wsUrl);
  res.set('Content-Type', 'text/xml').send(twiml);
});

/**
 * 2) WebSocket server per lo stream Twilio
 *    - Riceve audio base64 G.711 u-law da Twilio
 *    - Lo inoltra al WS Realtime di OpenAI
 *    - Rimanda l’audio sintetizzato all’utente
 */
const wss = new WebSocketServer({ noServer: true });

async function openAIRealtimeSocket(systemPrompt) {
  // Endpoint Realtime (beta); verifica il modello abilitato nel tuo account
  const url = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview';
  const headers = {
    Authorization: `Bearer ${OPENAI_API_KEY}`,
    'OpenAI-Beta': 'realtime=v1',
  };
  const socket = new WebSocket(url, { headers });
  await new Promise((resolve, reject) => {
    socket.on('open', resolve);
    socket.on('error', reject);
  });
  // Config iniziale sessione
  const init = {
    type: 'session.update',
    session: {
      instructions: systemPrompt,
      modalities: ['audio', 'text'],
      input_audio_format: { type: 'g711_ulaw', sample_rate_hz: 8000 },
      output_audio_format: { type: 'g711_ulaw', sample_rate_hz: 8000 },
    },
  };
  socket.send(JSON.stringify(init));
  return socket;
}

async function finalizeAndNotify(callSid) {
  const s = sessions.get(callSid);
  if (!s || !N8N_SUMMARY_WEBHOOK) return;
  const payload = {
    callSid,
    startedAt: s.start,
    endedAt: Date.now(),
    transcript: s.transcript,
    fields: s.fields,
  };
  try {
    await fetch(N8N_SUMMARY_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    console.log('[n8n] summary POSTed for', callSid);
  } catch (e) {
    console.error('[n8n] POST failed:', e);
  }
}

wss.on('connection', async (twilioWS, request) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const callSid = url.searchParams.get('callSid') || `call_${Date.now()}`;
  const session = sessions.get(callSid) || { transcript: [], fields: {}, start: Date.now() };
  sessions.set(callSid, session);

  // 2a) Connessione al WS Realtime OpenAI
  let aiWS;
  try {
    aiWS = await openAIRealtimeSocket(SYSTEM_PROMPT);
  } catch (e) {
    console.error('OpenAI WS error:', e);
    try { twilioWS.close(); } catch {}
    return;
  }

  // 2b) Messaggi da OpenAI → audio verso Twilio + log transcript/fields
  aiWS.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'response.audio.delta' && msg.audio) {
        twilioWS.send(JSON.stringify({ event: 'media', media: { payload: msg.audio } }));
      }
      if (msg.type === 'transcript.delta' && msg.text) {
        session.transcript.push({ from: msg.from || 'agent', text: msg.text, t: Date.now() });
      }
      if (msg.type === 'extracted.fields' && msg.fields) {
        Object.assign(session.fields, msg.fields);
      }
    } catch (_e) {
      // Ignora pacchetti non JSON (se presenti)
    }
  });

  // 2c) Audio da Twilio → verso OpenAI
  twilioWS.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.event === 'media' && msg.media?.payload) {
        aiWS.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: msg.media.payload }));
      } else if (msg.event === 'start') {
        console.log('[Twilio] media stream start', callSid);
      } else if (msg.event === 'stop') {
        console.log('[Twilio] media stream stop', callSid);
        aiWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        aiWS.send(JSON.stringify({ type: 'response.create', response: { instructions: 'fine chiamata' } }));
        try { aiWS.close(); } catch {}
        try { twilioWS.close(); } catch {}
      }
    } catch (e) {
      console.error('WS parse error:', e);
    }
  });

  twilioWS.on('close', () => {
    finalizeAndNotify(callSid);
    try { aiWS.close(); } catch {}
  });
  aiWS.on('close', () => {
    try { twilioWS.close(); } catch {}
  });
});

// Upgrade HTTP → WS per /twilio-media
const server = app.listen(PORT, () => {
  console.log(`Voice relay listening on :${PORT}`);
});
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  if (pathname === '/twilio-media') {
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  } else {
    socket.destroy();
  }
});

// Healthcheck
app.get('/', (_req, res) => res.send('OK'));
