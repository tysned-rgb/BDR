/**
 * Alta Voice BDR — Outbound Call Orchestrator
 *
 * Pulls contacts from your HubSpot list and fires outbound calls
 * through Vapi one at a time.
 *
 * Usage:
 *   node caller.js              → Run calls for real
 *   node caller.js --dry-run    → Preview contacts without calling
 *   node caller.js --limit 10   → Only call the first 10 contacts
 *
 * Prerequisites:
 *   - .env populated (VAPI_API_KEY, VAPI_ASSISTANT_ID, VAPI_PHONE_NUMBER_ID, HUBSPOT_LIST_ID)
 *   - Your webhook server is running and SERVER_URL is set in .env
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const axios = require('axios');

// ─── Config ───────────────────────────────────────────────────────────────────
const VAPI_KEY         = process.env.VAPI_API_KEY;
const ASSISTANT_ID     = process.env.VAPI_ASSISTANT_ID;
const PHONE_NUMBER_ID  = process.env.VAPI_PHONE_NUMBER_ID;
const HS_KEY           = process.env.HUBSPOT_API_KEY;
const LIST_ID          = process.env.HUBSPOT_LIST_ID;
const OUTBOUND_NUMBER  = process.env.OUTBOUND_PHONE_NUMBER || '+13852357065';

const DRY_RUN   = process.argv.includes('--dry-run');
const LIMIT_IDX = process.argv.indexOf('--limit');
const LIMIT     = LIMIT_IDX !== -1 ? parseInt(process.argv[LIMIT_IDX + 1]) : Infinity;

// Delay between calls in milliseconds (avoid hammering, respect human pacing)
const DELAY_BETWEEN_CALLS_MS = 5000; // 5 seconds

// ─── HubSpot: Fetch contacts from CRM Object List ─────────────────────────────
async function fetchContacts() {
  const props = ['firstname', 'lastname', 'phone', 'mobilephone', 'company', 'jobtitle'];
  let allRecordIds = [];
  let after = undefined;

  // Page through list memberships
  do {
    const url = `https://api.hubapi.com/crm/v3/lists/${LIST_ID}/memberships/join-order`
      + (after ? `?after=${after}&limit=250` : '?limit=250');
    const res = await axios.get(url, { headers: { Authorization: `Bearer ${HS_KEY}` } });
    const results = res.data.results || [];
    allRecordIds.push(...results.map(r => String(r.recordId)));
    after = res.data.paging?.next?.after || null;
  } while (after);

  if (allRecordIds.length === 0) return [];

  // Batch-read contact details in chunks of 100
  const allContacts = [];
  const chunkSize = 100;
  for (let i = 0; i < allRecordIds.length && allContacts.length < LIMIT; i += chunkSize) {
    const chunk = allRecordIds.slice(i, i + chunkSize);
    const res = await axios.post(
      'https://api.hubapi.com/crm/v3/objects/contacts/batch/read',
      { inputs: chunk.map(id => ({ id })), properties: props },
      { headers: { Authorization: `Bearer ${HS_KEY}`, 'Content-Type': 'application/json' } }
    );
    for (const c of (res.data.results || [])) {
      allContacts.push({
        id:        String(c.id),
        firstName: c.properties?.firstname   || '',
        lastName:  c.properties?.lastname    || '',
        phone:     c.properties?.phone       || c.properties?.mobilephone || '',
        company:   c.properties?.company     || '',
        jobTitle:  c.properties?.jobtitle    || '',
      });
    }
  }

  return allContacts.slice(0, LIMIT);
}

// ─── Vapi: Fire an outbound call ──────────────────────────────────────────────
async function fireCall(contact) {
  const fullName = [contact.firstName, contact.lastName].filter(Boolean).join(' ') || 'there';

  const payload = {
    assistantId:   ASSISTANT_ID,
    phoneNumberId: PHONE_NUMBER_ID,
    customer: {
      number: normalizePhone(contact.phone),
      name:   fullName,
    },
    // Pass contact info as metadata so Ava can retrieve it via get_contact_info
    assistantOverrides: {
      metadata: {
        contactId:     contact.id,
        contactName:   fullName,
        companyName:   contact.company,
        jobTitle:      contact.jobTitle,
        outcomeLogged: false,
      },
      // Personalize the first message with the contact's name
      firstMessage: buildFirstMessage(contact),
    },
  };

  const res = await axios.post('https://api.vapi.ai/call', payload, {
    headers: {
      Authorization: `Bearer ${VAPI_KEY}`,
      'Content-Type': 'application/json',
    },
  });

  return res.data;
}

// ─── Build personalized first message ─────────────────────────────────────────
function buildFirstMessage(contact) {
  const name = contact.firstName || 'there';
  return `Hi ${name}, this is Ava with Alta Voice AI. We work with dental practices to make perio charting and clinical notes completely hands-free through voice recognition. I know you weren't expecting my call — do you have a quick minute?`;
}

// ─── Normalize phone to E.164 ──────────────────────────────────────────────────
function normalizePhone(phone) {
  if (!phone) throw new Error('No phone number for contact');
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

// ─── Sleep helper ──────────────────────────────────────────────────────────────
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🎙️  Alta Voice BDR — Outbound Call Orchestrator');
  console.log(`   Mode:      ${DRY_RUN ? 'DRY RUN (no calls will be made)' : '🔴 LIVE'}`);
  console.log(`   List ID:   ${LIST_ID}`);
  console.log(`   Limit:     ${LIMIT === Infinity ? 'all contacts' : LIMIT}`);
  console.log('');

  if (!LIST_ID) {
    console.error('❌ HUBSPOT_LIST_ID is not set in .env');
    process.exit(1);
  }
  if (!DRY_RUN && !ASSISTANT_ID) {
    console.error('❌ VAPI_ASSISTANT_ID is not set in .env — run setup.js first');
    process.exit(1);
  }
  if (!DRY_RUN && !PHONE_NUMBER_ID) {
    console.error('❌ VAPI_PHONE_NUMBER_ID is not set in .env');
    process.exit(1);
  }

  console.log('📋 Fetching contacts from HubSpot list...');
  const contacts = await fetchContacts();

  // Filter out contacts with no phone number
  const callable = contacts.filter(c => c.phone);
  const skipped  = contacts.length - callable.length;

  console.log(`   Found ${contacts.length} contacts (${callable.length} with phone numbers, ${skipped} skipped)`);
  console.log('');

  if (callable.length === 0) {
    console.log('No callable contacts found. Exiting.');
    return;
  }

  if (DRY_RUN) {
    console.log('DRY RUN — contacts that would be called:');
    callable.forEach((c, i) => {
      console.log(`  ${i + 1}. ${c.firstName} ${c.lastName} | ${c.company} | ${c.phone} | ${c.jobTitle}`);
    });
    return;
  }

  // ── LIVE CALLING LOOP ──────────────────────────────────────────────────────
  let succeeded = 0;
  let failed    = 0;

  for (let i = 0; i < callable.length; i++) {
    const contact = callable[i];
    const label   = `${contact.firstName} ${contact.lastName} (${contact.company})`;

    process.stdout.write(`📞 [${i + 1}/${callable.length}] Calling ${label}... `);

    try {
      const call = await fireCall(contact);
      console.log(`✅ Call initiated — ID: ${call.id}`);
      succeeded++;
    } catch (err) {
      console.log(`❌ Failed — ${err.response?.data?.message || err.message}`);
      failed++;
    }

    // Don't hammer the API — wait between calls
    if (i < callable.length - 1) {
      await sleep(DELAY_BETWEEN_CALLS_MS);
    }
  }

  console.log(`\n✅ Done — ${succeeded} calls initiated, ${failed} failed\n`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
