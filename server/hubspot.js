/**
 * HubSpot API helpers for Alta Voice BDR Agent
 * Handles contact lookup, call logging, task creation, and SMS via Vapi
 */

const axios = require('axios');

const HS_BASE = 'https://api.hubapi.com';
const HEADERS = () => ({
  Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
  'Content-Type': 'application/json',
});

// ─────────────────────────────────────────────
// CONTACT
// ─────────────────────────────────────────────

/**
 * Get a contact by ID with all fields Ava needs
 */
async function getContact(contactId) {
  const props = [
    'firstname', 'lastname', 'email', 'phone', 'mobilephone',
    'company', 'jobtitle', 'hs_lead_status', 'hubspot_owner_id',
  ].join(',');

  const res = await axios.get(
    `${HS_BASE}/crm/v3/objects/contacts/${contactId}?properties=${props}`,
    { headers: HEADERS() }
  );
  return res.data;
}

/**
 * Update a contact property
 */
async function updateContact(contactId, properties) {
  const res = await axios.patch(
    `${HS_BASE}/crm/v3/objects/contacts/${contactId}`,
    { properties },
    { headers: HEADERS() }
  );
  return res.data;
}

// ─────────────────────────────────────────────
// CALL LOGGING (via Engagements API)
// ─────────────────────────────────────────────

const OUTCOME_MAP = {
  demo_booked:        'CONNECTED',
  callback_requested: 'CONNECTED',
  not_interested:     'CONNECTED',
  wrong_contact:      'CONNECTED',
  no_answer:          'NO_ANSWER',
  voicemail:          'LEFT_VOICEMAIL',
  gatekeeper:         'CONNECTED',
};

const DISPOSITION_MAP = {
  demo_booked:        'f240bbac-87c9-4f6e-bf70-924b57d47db7', // Connected
  callback_requested: 'f240bbac-87c9-4f6e-bf70-924b57d47db7',
  not_interested:     'f240bbac-87c9-4f6e-bf70-924b57d47db7',
  no_answer:          '73a0d17f-1163-4015-bdd5-ec830791da20', // No Answer
  voicemail:          '17b47fee-58de-441e-a44c-463173ac8a54', // Left Voicemail
  gatekeeper:         'f240bbac-87c9-4f6e-bf70-924b57d47db7',
  wrong_contact:      'f240bbac-87c9-4f6e-bf70-924b57d47db7',
};

/**
 * Log a completed call as a HubSpot engagement
 */
async function logCall({ contactId, outcome, notes, durationSeconds = 0, callRecordingUrl = null }) {
  const body = {
    engagement: {
      active: true,
      type: 'CALL',
      timestamp: Date.now(),
    },
    associations: {
      contactIds: [parseInt(contactId)],
      companyIds: [],
      dealIds: [],
      ownerIds: [],
      ticketIds: [],
    },
    metadata: {
      toNumber: '',
      fromNumber: process.env.OUTBOUND_PHONE_NUMBER || '',
      status: OUTCOME_MAP[outcome] || 'CONNECTED',
      externalId: null,
      durationMilliseconds: durationSeconds * 1000,
      disposition: DISPOSITION_MAP[outcome] || DISPOSITION_MAP['no_answer'],
      recordingUrl: callRecordingUrl || undefined,
      body: buildCallNotes(outcome, notes),
    },
  };

  const res = await axios.post(
    `${HS_BASE}/engagements/v1/engagements`,
    body,
    { headers: HEADERS() }
  );

  // Also update the contact's lead status
  await updateContact(contactId, {
    hs_lead_status: outcomeToLeadStatus(outcome),
    notes_last_contacted: new Date().toISOString(),
  }).catch(() => {}); // non-fatal

  return res.data;
}

function buildCallNotes(outcome, notes) {
  const outcomeLabels = {
    demo_booked:        '✅ DEMO BOOKED',
    callback_requested: '📅 CALLBACK REQUESTED',
    not_interested:     '❌ NOT INTERESTED',
    wrong_contact:      '👤 WRONG CONTACT',
    no_answer:          '📵 NO ANSWER',
    voicemail:          '📬 LEFT VOICEMAIL',
    gatekeeper:         '🚪 GATEKEEPER',
  };
  const label = outcomeLabels[outcome] || outcome.toUpperCase();
  return `[Ava - Alta Voice BDR] ${label}\n\n${notes || ''}`.trim();
}

function outcomeToLeadStatus(outcome) {
  const map = {
    demo_booked:        'IN_PROGRESS',
    callback_requested: 'OPEN',
    not_interested:     'UNQUALIFIED',
    wrong_contact:      'OPEN',
    no_answer:          'OPEN',
    voicemail:          'OPEN',
    gatekeeper:         'OPEN',
  };
  return map[outcome] || 'OPEN';
}

// ─────────────────────────────────────────────
// FOLLOW-UP TASK (via Engagements API)
// ─────────────────────────────────────────────

/**
 * Create a follow-up task on a contact
 */
async function createFollowupTask({ contactId, subject, body, dueDate }) {
  // dueDate should be a JS Date or ISO string
  const dueDateMs = dueDate ? new Date(dueDate).getTime() : Date.now() + 86400000 * 2; // default 2 days

  const taskBody = {
    engagement: {
      active: true,
      type: 'TASK',
      timestamp: Date.now(),
    },
    associations: {
      contactIds: [parseInt(contactId)],
      companyIds: [],
      dealIds: [],
      ownerIds: [],
      ticketIds: [],
    },
    metadata: {
      status: 'NOT_STARTED',
      subject: subject || 'Follow up call - Alta Voice BDR',
      body: body || '',
      taskType: 'CALL',
      completionDate: null,
      dueDate: dueDateMs,
      priority: 'MEDIUM',
      reminders: [dueDateMs - 3600000], // 1hr before
    },
  };

  const res = await axios.post(
    `${HS_BASE}/engagements/v1/engagements`,
    taskBody,
    { headers: HEADERS() }
  );
  return res.data;
}

// ─────────────────────────────────────────────
// CONTACT LIST (for orchestrator)
// ─────────────────────────────────────────────

/**
 * Fetch contacts from a HubSpot CRM Object List (new-style /objectLists/)
 * Uses the v3 CRM Lists API to get member IDs, then batch-fetches contact details.
 */
async function getContactsFromList(listId) {
  const props = ['firstname', 'lastname', 'phone', 'mobilephone', 'company', 'jobtitle'];
  let allRecordIds = [];
  let after = undefined;

  // Step 1: page through list memberships to collect all contact IDs
  do {
    const url = `${HS_BASE}/crm/v3/lists/${listId}/memberships/join-order`
      + (after ? `?after=${after}&limit=250` : '?limit=250');
    const res = await axios.get(url, { headers: HEADERS() });
    const results = res.data.results || [];
    allRecordIds.push(...results.map(r => String(r.recordId)));
    after = res.data.paging?.next?.after || null;
  } while (after);

  if (allRecordIds.length === 0) return { contacts: [], hasMore: false };

  // Step 2: batch-read contact details in chunks of 100
  const contacts = [];
  const chunkSize = 100;
  for (let i = 0; i < allRecordIds.length; i += chunkSize) {
    const chunk = allRecordIds.slice(i, i + chunkSize);
    const res = await axios.post(
      `${HS_BASE}/crm/v3/objects/contacts/batch/read`,
      {
        inputs:     chunk.map(id => ({ id })),
        properties: props,
      },
      { headers: HEADERS() }
    );
    for (const c of (res.data.results || [])) {
      contacts.push({
        id:        String(c.id),
        firstName: c.properties?.firstname   || '',
        lastName:  c.properties?.lastname    || '',
        phone:     c.properties?.phone       || c.properties?.mobilephone || '',
        company:   c.properties?.company     || '',
        jobTitle:  c.properties?.jobtitle    || '',
      });
    }
  }

  return { contacts, hasMore: false };
}

module.exports = {
  getContact,
  updateContact,
  logCall,
  createFollowupTask,
  getContactsFromList,
};
