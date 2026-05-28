/**
 * Alta Voice BDR — One-Time Vapi Setup
 *
 * Run this once to create the Ava assistant in your Vapi account.
 * It will print the assistant ID and phone number ID to add to your .env
 *
 * Usage:
 *   node setup.js
 */

require('dotenv').config();
const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const VAPI_KEY = process.env.VAPI_API_KEY;

if (!VAPI_KEY) {
  console.error('❌ VAPI_API_KEY not set in .env');
  process.exit(1);
}

const VAPI = axios.create({
  baseURL: 'https://api.vapi.ai',
  headers: {
    Authorization: `Bearer ${VAPI_KEY}`,
    'Content-Type': 'application/json',
  },
});

// ─── Load system prompt ───────────────────────────────────────────────────────
const systemPrompt = fs.readFileSync(
  path.join(__dirname, 'vapi/system_prompt.txt'),
  'utf8'
);

// ─── Assistant configuration ──────────────────────────────────────────────────
// Voice is set to a placeholder — run this script first, then pick a voice
// from the Vapi dashboard and update the voiceId here before calling contacts.
const ASSISTANT_CONFIG = {
  name: 'Ava - Alta Voice BDR',

  model: {
    provider: 'openai',
    model:    'gpt-4o',
    temperature: 0.75,
    messages: [
      { role: 'system', content: systemPrompt },
    ],
    // Tool definitions — Ava can call these during conversations
    tools: [
      {
        type: 'function',
        function: {
          name:        'get_contact_info',
          description: 'Get the prospect\'s name, company, phone, and job title from HubSpot at the start of a call.',
          parameters: {
            type: 'object',
            properties: {
              contact_id: {
                type:        'string',
                description: 'The HubSpot contact ID (passed in call metadata)',
              },
            },
            required: ['contact_id'],
          },
        },
        server: { url: `${process.env.SERVER_URL}/tool-call` },
      },
      {
        type: 'function',
        function: {
          name:        'send_booking_link',
          description: 'Send the demo booking link to the prospect via SMS when they agree to a demo.',
          parameters: {
            type: 'object',
            properties: {
              contact_id: {
                type:        'string',
                description: 'The HubSpot contact ID',
              },
              phone_number: {
                type:        'string',
                description: 'The prospect\'s phone number in E.164 format',
              },
            },
            required: ['contact_id', 'phone_number'],
          },
        },
        server: { url: `${process.env.SERVER_URL}/tool-call` },
      },
      {
        type: 'function',
        function: {
          name:        'log_call_outcome',
          description: 'Log the result of the call to HubSpot. Call this at the end of every call.',
          parameters: {
            type: 'object',
            properties: {
              contact_id: {
                type:        'string',
                description: 'The HubSpot contact ID',
              },
              outcome: {
                type: 'string',
                enum: ['demo_booked', 'callback_requested', 'not_interested', 'wrong_contact', 'no_answer', 'voicemail', 'gatekeeper'],
                description: 'The outcome of the call',
              },
              notes: {
                type:        'string',
                description: 'Brief notes about what was discussed or why the prospect wasn\'t interested',
              },
              duration_seconds: {
                type:        'number',
                description: 'Call duration in seconds',
              },
            },
            required: ['contact_id', 'outcome'],
          },
        },
        server: { url: `${process.env.SERVER_URL}/tool-call` },
      },
      {
        type: 'function',
        function: {
          name:        'create_followup_task',
          description: 'Create a follow-up call task in HubSpot when a prospect requests a callback.',
          parameters: {
            type: 'object',
            properties: {
              contact_id: {
                type:        'string',
                description: 'The HubSpot contact ID',
              },
              callback_date: {
                type:        'string',
                description: 'The requested callback date (e.g. "2024-03-15")',
              },
              callback_time: {
                type:        'string',
                description: 'The requested callback time (e.g. "2:00 PM")',
              },
              notes: {
                type:        'string',
                description: 'Notes about the conversation and what to follow up on',
              },
            },
            required: ['contact_id'],
          },
        },
        server: { url: `${process.env.SERVER_URL}/tool-call` },
      },
    ],
  },

  // ── Voice ── Update voiceId after picking your preferred voice
  // Top warm female options from ElevenLabs via Vapi:
  //   Sarah:   EXAVITQu4vr4xnSDxMaL  (warm, natural — recommended)
  //   Rachel:  21m00Tcm4TlvDq8ikWAM  (clear, friendly)
  //   Aria:    9BWtsMINqrJLrRacOk9x  (expressive, conversational)
  //   Laura:   FGY2WhTYpPnrIDTdsKH5  (professional, clear)
  //   Lily:    pFZP5JQG7iQjIQuC4Bku  (soft, approachable)
  voice: {
    provider: '11labs',
    voiceId:  'EXAVITQu4vr4xnSDxMaL', // Sarah — update after voice selection
    stability:        0.5,
    similarityBoost:  0.8,
    style:            0.0,
    useSpeakerBoost:  true,
  },

  // ── Transcription ──────────────────────────────────────────────────────────
  transcriber: {
    provider: 'deepgram',
    model:    'nova-2',
    language: 'en-US',
  },

  // ── Call settings ──────────────────────────────────────────────────────────
  firstMessageMode:    'assistant-speaks-first',
  firstMessage:        "Hi there, this is Ava with Alta Voice AI. We work with dental practices to make perio charting and clinical notes completely hands-free through voice recognition. I know you weren't expecting my call — do you have a quick minute?",
  endCallMessage:      "It was really great speaking with you. Have a wonderful rest of your day!",
  endCallPhrases:      ['goodbye', 'bye', 'talk later', 'have a good one', 'take care', 'not interested', 'remove me', 'do not call'],

  maxDurationSeconds:  600,   // 10 min max per call
  recordingEnabled:    true,
  silenceTimeoutSeconds: 30,
  responseDelaySeconds:  0,
  llmRequestDelaySeconds: 0,

  // Server URL for call status events
  serverUrl: `${process.env.SERVER_URL}/call-status`,

  // ── Background noise / ambiance ───────────────────────────────────────────
  backgroundSound: 'office',
};

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🎙️  Alta Voice BDR — Vapi Setup\n');

  // 1. Create the assistant
  console.log('Creating Ava assistant in Vapi...');
  let assistant;
  try {
    const res = await VAPI.post('/assistant', ASSISTANT_CONFIG);
    assistant  = res.data;
    console.log(`✅ Assistant created: ${assistant.id}`);
  } catch (err) {
    console.error('❌ Failed to create assistant:', err.response?.data || err.message);
    process.exit(1);
  }

  // 2. List phone numbers to find the one matching our outbound number
  console.log('\nLooking up phone numbers in Vapi...');
  let phoneNumberId = null;
  try {
    const res = await VAPI.get('/phone-number');
    const numbers = res.data || [];
    const match = numbers.find(n =>
      n.number?.replace(/\D/g,'') === process.env.OUTBOUND_PHONE_NUMBER?.replace(/\D/g,'')
    );
    if (match) {
      phoneNumberId = match.id;
      console.log(`✅ Phone number found: ${match.number} → ID: ${match.id}`);
    } else {
      console.log('⚠️  Phone number not found in Vapi yet.');
      console.log('   Import it at: https://app.vapi.ai → Phone Numbers → Import from Twilio');
      console.log('   Then add the ID to VAPI_PHONE_NUMBER_ID in .env');
    }
  } catch (err) {
    console.warn('Could not list phone numbers:', err.response?.data || err.message);
  }

  // 3. Print what to add to .env
  console.log('\n──────────────────────────────────────────────────');
  console.log('Add these to your .env file:\n');
  console.log(`VAPI_ASSISTANT_ID=${assistant.id}`);
  if (phoneNumberId) {
    console.log(`VAPI_PHONE_NUMBER_ID=${phoneNumberId}`);
  }
  console.log('──────────────────────────────────────────────────\n');

  console.log('Next steps:');
  console.log('  1. Add the IDs above to your .env');
  console.log('  2. Deploy your webhook server and set SERVER_URL in .env');
  console.log('  3. Add your HUBSPOT_LIST_ID to .env');
  console.log('  4. Run: node orchestrator/caller.js --dry-run  (preview contacts)');
  console.log('  5. Run: node orchestrator/caller.js            (start calling)\n');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
