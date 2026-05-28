/**
 * Alta Voice BDR — Local Dashboard App
 * Serves the Ava control dashboard at http://localhost:3001
 * Run via: node app.js  (or double-click "Launch Ava.command")
 */

require('dotenv').config();
const express  = require('express');
const axios    = require('axios');
const path     = require('path');
const fs       = require('fs');

const app  = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const VAPI_KEY        = process.env.VAPI_API_KEY;
const ASSISTANT_ID    = process.env.VAPI_ASSISTANT_ID;
const PHONE_NUMBER_ID = process.env.VAPI_PHONE_NUMBER_ID;
const HS_KEY          = process.env.HUBSPOT_API_KEY;
const LIST_ID         = process.env.HUBSPOT_LIST_ID;
const OUTBOUND_NUMBER = process.env.OUTBOUND_PHONE_NUMBER || '+13852357065';
const PORT            = 3001;

// ── SSE clients ────────────────────────────────────────────────────────────────
let sseClients = [];
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => res.write(msg));
}

// ── Calling state ──────────────────────────────────────────────────────────────
let calling    = false;
let stopFlag   = false;
let session    = { total: 0, called: 0, demos: 0, callbacks: 0, notInterested: 0, noAnswer: 0, voicemail: 0 };
let activityLog = [];

function logActivity(contact, outcome, note) {
  const icons = {
    demo_booked:        '✅',
    callback_requested: '📅',
    not_interested:     '❌',
    no_answer:          '📵',
    voicemail:          '📬',
    gatekeeper:         '🚪',
    wrong_contact:      '👤',
    calling:            '📞',
  };
  const entry = {
    time:    new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    icon:    icons[outcome] || '•',
    name:    contact ? `${contact.firstName} ${contact.lastName}`.trim() || 'Unknown' : '',
    company: contact?.company || '',
    outcome,
    note:    note || '',
  };
  activityLog.unshift(entry);
  if (activityLog.length > 50) activityLog.pop();
  broadcast('activity', entry);
}

// ── HubSpot: fetch contacts ────────────────────────────────────────────────────
async function fetchContacts(limit = Infinity) {
  const props   = ['firstname','lastname','phone','mobilephone','company','jobtitle'];
  let recordIds = [];
  let after     = undefined;

  do {
    const url = `https://api.hubapi.com/crm/v3/lists/${LIST_ID}/memberships/join-order`
      + (after ? `?after=${after}&limit=250` : '?limit=250');
    const res = await axios.get(url, { headers: { Authorization: `Bearer ${HS_KEY}` } });
    recordIds.push(...(res.data.results || []).map(r => String(r.recordId)));
    after = res.data.paging?.next?.after || null;
  } while (after);

  const contacts = [];
  for (let i = 0; i < recordIds.length; i += 100) {
    const chunk = recordIds.slice(i, i + 100);
    const res   = await axios.post(
      'https://api.hubapi.com/crm/v3/objects/contacts/batch/read',
      { inputs: chunk.map(id => ({ id })), properties: props },
      { headers: { Authorization: `Bearer ${HS_KEY}`, 'Content-Type': 'application/json' } }
    );
    for (const c of (res.data.results || [])) {
      contacts.push({
        id:        String(c.id),
        firstName: c.properties?.firstname || '',
        lastName:  c.properties?.lastname  || '',
        phone:     c.properties?.phone     || c.properties?.mobilephone || '',
        company:   c.properties?.company   || '',
        jobTitle:  c.properties?.jobtitle  || '',
      });
    }
  }
  return contacts.filter(c => c.phone).slice(0, limit);
}

// ── Vapi: fire outbound call ────────────────────────────────────────────────────
async function fireCall(contact) {
  const fullName = [contact.firstName, contact.lastName].filter(Boolean).join(' ') || 'there';
  const res = await axios.post('https://api.vapi.ai/call', {
    assistantId:   ASSISTANT_ID,
    phoneNumberId: PHONE_NUMBER_ID,
    customer: { number: normalizePhone(contact.phone), name: fullName },
    assistantOverrides: {
      metadata: { contactId: contact.id, contactName: fullName, companyName: contact.company, outcomeLogged: false },
      firstMessage: `Hi ${contact.firstName || 'there'}, this is Ava with Alta Voice AI. We work with dental practices to make perio charting and clinical notes completely hands-free through voice recognition. I know you weren't expecting my call — do you have a quick minute?`,
    },
  }, { headers: { Authorization: `Bearer ${VAPI_KEY}`, 'Content-Type': 'application/json' } });
  return res.data;
}

function normalizePhone(phone) {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Calling loop ───────────────────────────────────────────────────────────────
async function runCallingSession(limit) {
  calling  = true;
  stopFlag = false;
  session  = { total: 0, called: 0, demos: 0, callbacks: 0, notInterested: 0, noAnswer: 0, voicemail: 0 };
  activityLog = [];

  try {
    broadcast('status', { calling: true, message: 'Fetching contacts...' });
    const contacts = await fetchContacts(limit);
    session.total  = contacts.length;
    broadcast('session', session);

    if (contacts.length === 0) {
      broadcast('status', { calling: false, message: 'No callable contacts found.' });
      return;
    }

    broadcast('status', { calling: true, message: `Starting ${contacts.length} calls...` });

    for (let i = 0; i < contacts.length; i++) {
      if (stopFlag) {
        broadcast('status', { calling: false, message: `Stopped after ${session.called} calls.` });
        break;
      }

      const contact = contacts[i];
      broadcast('status', { calling: true, message: `Calling ${contact.firstName} ${contact.lastName} (${i+1}/${contacts.length})` });
      logActivity(contact, 'calling');

      try {
        await fireCall(contact);
        session.called++;
        broadcast('session', session);
      } catch (err) {
        logActivity(contact, 'no_answer', err.response?.data?.message || err.message);
      }

      if (i < contacts.length - 1 && !stopFlag) await sleep(5000);
    }

    if (!stopFlag) {
      broadcast('status', { calling: false, message: `Session complete — ${session.called} calls made.` });
    }
  } catch (err) {
    broadcast('status', { calling: false, message: `Error: ${err.message}` });
  } finally {
    calling = false;
    broadcast('calling_state', { calling: false });
  }
}

// ── Routes ─────────────────────────────────────────────────────────────────────

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.push(res);
  res.write(`event: init\ndata: ${JSON.stringify({ calling, session, activityLog })}\n\n`);
  req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
});

app.get('/api/stats', async (req, res) => {
  try {
    let recordIds = [];
    let after = undefined;
    do {
      const url = `https://api.hubapi.com/crm/v3/lists/${LIST_ID}/memberships/join-order`
        + (after ? `?after=${after}&limit=250` : '?limit=250');
      const r = await axios.get(url, { headers: { Authorization: `Bearer ${HS_KEY}` } });
      recordIds.push(...(r.data.results || []).map(x => x.recordId));
      after = r.data.paging?.next?.after || null;
    } while (after);
    res.json({ queueCount: recordIds.length, calling, session });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/start', async (req, res) => {
  if (calling) return res.status(400).json({ error: 'Already running' });
  const limit = req.body.limit || Infinity;
  res.json({ started: true });
  runCallingSession(limit);
});

app.post('/api/stop', (req, res) => {
  stopFlag = true;
  res.json({ stopping: true });
});

app.get('/api/activity', (req, res) => res.json(activityLog));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n🎙️  Ava Dashboard running at http://localhost:${PORT}`);
  console.log(`   Opening in browser...\n`);
  const { exec } = require('child_process');
  exec(`open http://localhost:${PORT}`);
});
