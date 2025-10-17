/**
 * Minimal Voice AI Relay for Twilio Programmable Voice + OpenAI Realtime + n8n
 * ------------------------------------------------------------
 * Che fa:
 * - Espone /voice (TwiML) che dice a Twilio di aprire uno Stream Media su /twilio-media (WebSocket)
 * - Bridge audio Twilio <-> OpenAI Realtime (parla/ascolta in tempo reale)
 * - Accumula transcript + campi estratti e POSTa il riepilogo a n8n
 *
 * Requisiti:
 *  - Node 18+
 *  - npm i express twilio body-parser ws node-fetch dotenv
 *
 * .env (esempio):
 *   PORT=3000
 *   OPENAI_API_KEY=sk-...
 *   N8N_SUMMARY_WEBHOOK=https://<tuo-n8n>/webhook/ai-receptionist/summary
 *   SYSTEM_PROMPT=Sei una centralinista di Revan. Rispondi in italiano...
 *
 * NOTE: esempio semplificato. Per produzione: HTTPS, auth, retry, logging, ecc.
 */
import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';
import { WebSocketServer, WebSocket } from 'ws';

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const N8N_SUMMARY_WEBHOOK = process.env.N8N_SUMMARY_WEBHOOK;
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  'Sei una centralinista cordiale. Parla italiano chiaro. Raccogli nome, azienda, motivo della chiamata, urgenza (1-5), recapito e fascia oraria per richiamare. Mantieni risposte brevi.';

/** Store in-memory per demo: callSid -> { transcript: [], fields: {}, start } */
const sessions = new Map();

/** 1) TwiML endpoint: Twilio lo chiama quando squilla il numero */
app.post('/voice', (req, res) => {
  const callSid = req.body?.CallSid || `call_${Date.now()}`;
  const wsUrl = `${req.protocol === 'https' ? 'wss' : 'ws'}://${req.get('host')}/twilio-media?callSid=${encodeURIComponent(
    callSid
  )}`;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;
  sessions.set(callSid, { transcript: [], fields: {}, start: Date.now() });
  res.set('Content-Type', 'text/xml').send(twiml);
});

/** 2) WebSocket endpoint per Twilio Media Streams */
const wss = new WebSocketServer({ noServer: true });

async function openAIRealtimeSocket(systemPrompt) {
  // Endpoint Realtime (può variare in base al provider/modello abilitato)
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
  } catch (e) {
    console.error('Failed to POST summary to n8n:', e);
  }
}

wss.on('connection', async (twilioWS, request) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const callSid = url.searchParams.get('callSid') || `call_${Date.now()}`;
  const session = sessions.get(callSid) || { transcript: [], fields: {}, start: Date.now() };
  sessions.set(callSid, session);

  // Collega OpenAI Realtime
  let aiWS;
  try {
    aiWS = await openAIRealtimeSocket(SYSTEM_PROMPT);
  } catch (e) {
    console.error('OpenAI WS error:', e);
    twilioWS.close();
    return;
  }

  // Messaggi in arrivo da OpenAI → inoltra audio a Twilio + logga testi/fields
  aiWS.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'response.audio.delta' && msg.audio) {
        // base64 u-law → verso Twilio
        twilioWS.send(
          JSON.stringify({
            event: 'media',
            media: { payload: msg.audio },
          })
        );
      }
      if (msg.type === 'transcript.delta' && msg.text) {
        session.transcript.push({ from: msg.from || 'agent', text: msg.text, t: Date.now() });
      }
      if (msg.type === 'extracted.fields' && msg.fields) {
        Object.assign(session.fields, msg.fields);
      }
    } catch (_) {}
  });

  // Dati da Twilio → inoltra audio verso OpenAI
  twilioWS.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.event === 'media' && msg.media?.payload) {
        aiWS.send(
          JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: msg.media.payload, // base64 u-law
          })
        );
      } else if (msg.event === 'start') {
        // handshake ok
      } else if (msg.event === 'stop') {
        aiWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        aiWS.send(JSON.stringify({ type: 'response.create', response: { instructions: 'fine chiamata' } }));
        try {
          aiWS.close();
        } catch (_) {}
        try {
          twilioWS.close();
        } catch (_) {}
      }
    } catch (e) {
      console.error('Parse error:', e);
    }
  });

  twilioWS.on('close', () => {
    finalizeAndNotify(callSid);
    try {
      aiWS.close();
    } catch (_) {}
  });

  aiWS.on('close', () => {
    try {
      twilioWS.close();
    } catch (_) {}
  });
});

// Upgrade HTTP→WS per /twilio-media
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

