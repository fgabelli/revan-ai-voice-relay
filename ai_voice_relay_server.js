/**
 * Voice AI Relay for Twilio Programmable Voice + OpenAI Realtime + n8n
 * - /voice: TwiML che apre uno Stream WS su /twilio-media (wss://)
 * - WS bridge: audio Twilio <-> OpenAI Realtime (G.711 μ-law 8kHz)
 * - A fine chiamata invia transcript + campi a n8n (N8N_SUMMARY_WEBHOOK)
 * - [FIX] Imposta voce TTS 'alloy' per far emettere audio al Realtime
 */

import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';
import { WebSocketServer, WebSocket } from 'ws';

const app = express();
app.set('trust proxy', 1);
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const N8N_SUMMARY_WEBHOOK = process.env.N8N_SUMMARY_WEBHOOK;
const ECHO_DEBUG = process.env.ECHO_DEBUG === '1';

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
6) Chiudi: “Grazie, la faremo richiamare al più presto. Buona giornata!”.`;

const sessions = new Map();

/* TwiML: forza wss:// per Media Streams */
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

// 2) Connetto OpenAI
try {
  aiWS = await connectOpenAI(SYSTEM_PROMPT);
  aiReady = true;
  console.log('[OpenAI] realtime socket connected');

  // TEST TTS: forziamo una frase esplicita da pronunciare
  aiWS.send(JSON.stringify({
    type: 'response.create',
    response: {
      modalities: ['audio'],
      instructions: 'Pronuncia esattamente: "Pronto, sono la centralinista Revan. Come posso aiutarla?"',
      audio: { voice: 'alloy' }
    }
  }));

  // 3) Dall'AI -> verso Twilio (rimando audio con streamSid) + LOG esteso
  let debugCount = 0;
  aiWS.on('message', (data) => {
    try {
      const raw = data.toString();
      let msg;
      try { msg = JSON.parse(raw); } catch {
        // non JSON: ignora
        return;
      }

      // Log leggero dei primi 20 messaggi per capire i tipi che arrivano
      if (debugCount < 20) {
        const keys = Object.keys(msg || {});
        console.log('[AI EVT]', ++debugCount, msg.type, keys);
      }

      // Cattura più varianti possibili di audio
      const isAudioDelta =
        (msg.type === 'response.audio.delta' && msg.audio) ||
        (msg.type === 'response.output_audio.delta' && msg.delta) ||
        (msg.type === 'response.audio.chunk' && msg.chunk) ||
        (msg.type === 'response.output_audio.chunk' && msg.chunk);

      // Prova a trovare bytes audio anche in strutture annidate (alcune versioni li mettono in output[0].content[0].audio.bytes)
      const nestedBytes = msg?.output?.[0]?.content?.[0]?.audio?.bytes || msg?.response?.output?.[0]?.content?.[0]?.audio?.bytes;

      const audioPayload = msg.audio || msg.delta || msg.chunk || nestedBytes;

      if (isAudioDelta || audioPayload) {
        framesFromAI++;
        const payload = audioPayload;
        if (payload && streamSid) {
          twilioWS.send(JSON.stringify({
            event: 'media',
            streamSid,
            media: { payload } // base64 μ-law
          }));
          framesToTwilio++;
        }
      }

      // Log utile se l'AI risponde solo in testo
      if ((msg.type === 'response.delta' || msg.type === 'response.text.delta') && msg.delta) {
        console.log('[AI TEXT]', msg.delta);
      }

      if (msg.type === 'transcript.delta' && msg.text) {
        session.transcript.push({ from: msg.from || 'agent', text: msg.text, t: Date.now() });
      }
      if (msg.type === 'extracted.fields' && msg.fields) {
        Object.assign(session.fields, msg.fields);
      }
    } catch (_) {}
  });

  aiWS.on('close', () => {
    try { twilioWS.close(); } catch {}
  });

} catch (e) {
  console.error('[OpenAI] WS error at connect:', e);
  try { twilioWS.close(); } catch {}
  return;
}


/* Invio riassunto a n8n */
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

/* WS server per Twilio Media Streams */
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', async (twilioWS, request) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const callSid = url.searchParams.get('callSid') || `call_${Date.now()}`;
  const session = sessions.get(callSid) || { transcript: [], fields: {}, start: Date.now() };
  sessions.set(callSid, session);

  let streamSid = null;
  let aiWS = null;
  let aiReady = false;

  // Counters debug
  let framesFromCaller = 0;
  let framesFromAI = 0;
  let framesToTwilio = 0;
  const dump = setInterval(() => {
    console.log(`[STAT] in=${framesFromCaller} ai=${framesFromAI} out=${framesToTwilio}`);
  }, 3000);

  // 1) Ricevo eventi Twilio e catturo streamSid
  twilioWS.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.event === 'start') {
        streamSid = msg.start?.streamSid || msg.streamSid || null;
        console.log('[Twilio] START', { callSid, streamSid, echo: ECHO_DEBUG });
        return;
      }

      if (msg.event === 'media' && msg.media?.payload) {
        framesFromCaller++;
        if (aiReady && aiWS) {
          aiWS.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: msg.media.payload, // base64 G.711 μ-law
          }));
        }
        // niente echo qui (ECHO_DEBUG è off)
        return;
      }

      if (msg.event === 'stop') {
        console.log('[Twilio] STOP', callSid);
        clearInterval(dump);
        if (aiWS) {
          try { aiWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' })); } catch {}
          try { aiWS.send(JSON.stringify({ type: 'response.create', response: { instructions: 'fine chiamata' } })); } catch {}
          try { aiWS.close(); } catch {}
        }
        try { twilioWS.close(); } catch {}
        return;
      }
    } catch (e) {
      console.error('WS parse error:', e);
    }
  });

  // 2) Connetto OpenAI
  try {
    aiWS = await connectOpenAI(SYSTEM_PROMPT);
    aiReady = true;
    console.log('[OpenAI] realtime socket connected');

    // Saluto iniziale con voice 'alloy' e output audio esplicito
    aiWS.send(JSON.stringify({
      type: 'response.create',
      response: {
        instructions: 'Saluta in italiano e chiedi come puoi aiutare.',
        modalities: ['audio'],
        audio: { voice: 'alloy' } // <<< importante
      },
    }));

    // 3) Dall'AI -> verso Twilio (rimando audio con streamSid)
    aiWS.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        const isAudioDelta =
          (msg.type === 'response.audio.delta' && msg.audio) ||
          (msg.type === 'response.output_audio.delta' && msg.delta);

        const audioPayload = msg.audio || msg.delta;

        if (isAudioDelta && audioPayload) {
          framesFromAI++;
          if (streamSid) {
            twilioWS.send(JSON.stringify({
              event: 'media',
              streamSid,                       // fondamentale
              media: { payload: audioPayload } // base64 μ-law
            }));
            framesToTwilio++;
          } else {
            console.warn('[Twilio] missing streamSid; audio skipped');
          }
        }

        if (msg.type === 'transcript.delta' && msg.text) {
          session.transcript.push({ from: msg.from || 'agent', text: msg.text, t: Date.now() });
        }
        if (msg.type === 'extracted.fields' && msg.fields) {
          Object.assign(session.fields, msg.fields);
        }
      } catch (_) {}
    });

    aiWS.on('close', () => {
      clearInterval(dump);
      try { twilioWS.close(); } catch {}
    });

  } catch (e) {
    console.error('[OpenAI] WS error at connect:', e);
    try { twilioWS.close(); } catch {}
    return;
  }

  // 4) Pulizia e invio riepilogo
  twilioWS.on('close', () => {
    clearInterval(dump);
    finalizeAndNotify(callSid);
    try { aiWS?.close(); } catch {}
  });
});

/* Upgrade HTTP → WS */
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

/* Healthcheck */
app.get('/', (_req, res) => res.send('OK'));
