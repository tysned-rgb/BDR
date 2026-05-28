/**
 * Alta Voice BDR Agent — Webhook Server
 *
 * Handles all tool calls from Vapi (Ava) and routes them to HubSpot.
 *
 * Endpoints:
 *   POST /tool-call      → Handles Vapi function/tool calls
 *   POST /call-status    → Handles Vapi call lifecycle events
 *   GET  /health         → Health check
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const express = require('express');
const hs      = require('./hubspot');

const app  = express();
app.use(express.json());

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', agent: 'Ava - Alta Voice BDR' }));

// ─────────────────────────────────────────────────────────────────────────────
// VAPI TOOL CALL HANDLER
// Vapi sends POST /tool-call with: { message: { toolCalls: [...] } }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/tool-call', async (req, res) => {
  const { message } = req.body;
  if (!message || !message.toolCalls?.length) {
    return res.status(400).json({ error: 'No tool calls in request' });
  }

  const results = [];

  for (const toolCall of message.toolCalls) {
    const { id, function: fn } = toolCall;
    const args = typeof fn.arguments === 'string'
      ? JSON.parse(fn.arguments)
      : fn.arguments;

    console.log(`[Tool] ${fn.name}`, args);

    try {
      const result = await handleTool(fn.name, args, message);
      results.push({ toolCallId: id, result: JSON.stringify(result) });
    } catch (err) {
      console.error(`[Tool Error] ${fn.name}:`, err.message);
      results.push({
        toolCallId: id,
        result: JSON.stringify({ error: err.message }),
      });
    }
  }

  res.json({ results });
});

// ─────────────────────────────────────────────────────────────────────────────
// VAPI CALL STATUS HANDLER
// Fired when a call starts, ends, etc.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/call-status', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.sendStatus(200);

  const { type, call } = message;
  console.log(`[Call Status] type=${type} callId=${call?.id}`);

  // On call-end, if outcome wasn't already logged by Ava's tool, log as no_answer
  if (type === 'end-of-call-report') {
    const contactId = call?.metadata?.contactId;
    const alreadyLogged = call?.metadata?.outcomeLogged;

    if (contactId && !alreadyLogged) {
      const endedReason = call?.endedReason || 'unknown';
      const outcome = endedReason === 'customer-did-not-answer' ? 'no_answer'
                    : endedReason === 'voicemail'               ? 'voicemail'
                    : 'no_answer';

      await hs.logCall({
        contactId,
        outcome,
        notes: `Auto-logged by system. End reason: ${endedReason}`,
        durationSeconds: call?.duration || 0,
        callRecordingUrl: call?.recordingUrl || null,
      }).catch(e => console.error('Auto-log failed:', e.message));
    }
  }

  res.sendStatus(200);
});

// ─────────────────────────────────────────────────────────────────────────────
// TOOL IMPLEMENTATIONS
// ─────────────────────────────────────────────────────────────────────────────
async function handleTool(name, args, message) {
  const contactId = args.contact_id
    || message?.call?.metadata?.contactId
    || null;

  switch (name) {

    // ── GET CONTACT INFO ─────────────────────────────────────────────────────
    case 'get_contact_info': {
      if (!contactId) throw new Error('contact_id is required');
      const contact = await hs.getContact(contactId);
      const p = contact.properties;
      return {
        contact_id:   contactId,
        first_name:   p.firstname || '',
        last_name:    p.lastname  || '',
        full_name:    [p.firstname, p.lastname].filter(Boolean).join(' ') || 'there',
        company:      p.company   || 'your practice',
        job_title:    p.jobtitle  || '',
        phone:        p.phone     || p.mobilephone || '',
        email:        p.email     || '',
      };
    }

    // ── SEND BOOKING LINK ────────────────────────────────────────────────────
    // Vapi handles SMS natively — we return the message content and Vapi
    // sends it. We also create a follow-up note in HubSpot.
    case 'send_booking_link': {
      const phone    = args.phone_number;
      const bookingUrl = process.env.DEMO_BOOKING_URL || 'https://meetings.hubspot.com/altavoice/demo';
      const smsBody  = `Hi! This is Ava from Alta Voice AI. Here's the link to book your 15-min demo with our team: ${bookingUrl} — looking forward to connecting!`;

      // Log a note on the contact that we sent the link
      if (contactId) {
        await hs.logCall({
          contactId,
          outcome: 'demo_booked',
          notes: `Booking link sent via SMS to ${phone}. URL: ${bookingUrl}`,
          durationSeconds: 0,
        }).catch(() => {});
      }

      // Return content for Vapi to send as SMS
      return {
        sms: {
          to:   phone,
          body: smsBody,
        },
        confirmation: `Booking link sent to ${phone}.`,
        booking_url: bookingUrl,
      };
    }

    // ── LOG CALL OUTCOME ─────────────────────────────────────────────────────
    case 'log_call_outcome': {
      if (!contactId) throw new Error('contact_id is required');
      const { outcome, notes, duration_seconds } = args;
      const recording = message?.call?.recordingUrl || null;

      await hs.logCall({
        contactId,
        outcome:       outcome || 'no_answer',
        notes:         notes   || '',
        durationSeconds: duration_seconds || message?.call?.duration || 0,
        callRecordingUrl: recording,
      });

      return { success: true, logged_outcome: outcome };
    }

    // ── CREATE FOLLOW-UP TASK ────────────────────────────────────────────────
    case 'create_followup_task': {
      if (!contactId) throw new Error('contact_id is required');
      const { callback_date, callback_time, notes } = args;

      // Parse the requested date/time
      let dueDate;
      if (callback_date) {
        const dateStr = callback_time
          ? `${callback_date} ${callback_time}`
          : `${callback_date} 09:00`;
        dueDate = new Date(dateStr);
      } else {
        dueDate = new Date(Date.now() + 86400000 * 2); // 2 days out
      }

      await hs.createFollowupTask({
        contactId,
        subject: `Call back - Alta Voice BDR (Ava)`,
        body:    notes || 'Prospect requested callback. Continue demo conversation.',
        dueDate,
      });

      return {
        success:  true,
        task_due: dueDate.toISOString(),
        message:  `Follow-up task created for ${dueDate.toDateString()}`,
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎙️  Alta Voice BDR Server running on port ${PORT}`);
  console.log(`   Tool calls:  POST http://localhost:${PORT}/tool-call`);
  console.log(`   Call status: POST http://localhost:${PORT}/call-status`);
  console.log(`   Health:      GET  http://localhost:${PORT}/health\n`);
});

module.exports = app;
