# Alta Voice BDR Agent — Ava

Ava is an outbound AI sales rep built on Vapi. She calls dental practices from your HubSpot list, runs through the Alta Voice talk track, handles objections, and books demos directly into your HubSpot calendar. Every call is logged back to HubSpot automatically.

---

## Architecture

```
HubSpot List
     │
     ▼
orchestrator/caller.js  ──→  Vapi API (fires outbound calls)
                                   │
                              Ava speaks
                                   │
                         Ava calls tools (get_contact_info,
                         log_call_outcome, send_booking_link,
                         create_followup_task)
                                   │
                                   ▼
                         server/server.js (webhook)
                                   │
                                   ▼
                              HubSpot API
                       (logs calls, creates tasks,
                        updates contact properties)
```

---

## Prerequisites

- Node.js 18+
- A Vapi account → https://app.vapi.ai
- Your HubSpot Private App token (already set up)
- Your phone number imported into Vapi (see Step 2 below)

---

## Setup

### Step 1 — Install dependencies

```bash
npm install
```

### Step 2 — Import your phone number into Vapi

1. Go to https://app.vapi.ai → **Phone Numbers** → **Import**
2. Your number is **(385) 235-7065**
3. If it's a Twilio number, click **Import from Twilio** and enter your Twilio Account SID and Auth Token
4. Copy the **Phone Number ID** that Vapi assigns — you'll need it shortly

### Step 3 — Get your HubSpot List ID

1. In HubSpot, go to **Contacts → Lists**
2. Open the list: **"eBook Downloads with no scheduled meetings or Open/Won Deals"**
3. Look at the URL: `https://app.hubspot.com/contacts/XXXXXXXX/lists/12345`
4. The number after `/lists/` is your List ID (e.g., `12345`)

### Step 4 — Configure .env

```bash
cp .env.example .env
```

Open `.env` and fill in:
- `HUBSPOT_LIST_ID` — from Step 3
- `VAPI_PHONE_NUMBER_ID` — from Step 2
- `SERVER_URL` — your deployed webhook URL (see Step 5)

The API keys are already pre-filled.

### Step 5 — Deploy the webhook server

Ava needs a publicly accessible URL for her tool calls. Easiest options:

**Option A — Railway (recommended, free tier available)**
```bash
# Install Railway CLI
npm install -g @railway/cli

# Deploy
railway login
railway init
railway up
# Railway gives you a URL like https://alta-voice-bdr-production.up.railway.app
```

**Option B — Render**
- Push this folder to GitHub
- Create a new Web Service on render.com, point it at your repo
- Set environment variables in the Render dashboard

**Option C — Local dev with ngrok (for testing)**
```bash
npm install -g ngrok
npm run server         # In one terminal
ngrok http 3000        # In another — copy the https URL
```

Once deployed, set `SERVER_URL` in your `.env` to the public URL (no trailing slash).
Example: `SERVER_URL=https://alta-voice-bdr-production.up.railway.app`

### Step 6 — Create Ava in Vapi

```bash
node setup.js
```

This will:
- Create the Ava assistant with the full talk track and tool definitions
- Find your phone number in Vapi
- Print the `VAPI_ASSISTANT_ID` to add to your `.env`

Add the printed IDs to `.env` before continuing.

### Step 7 — Pick Ava's voice

Before going live, pick a voice:

1. Go to https://app.vapi.ai → **Assistants** → click **Ava - Alta Voice BDR**
2. Under **Voice**, click to preview these warm female options:
   - **Sarah** (EXAVITQu4vr4xnSDxMaL) — warm, natural — recommended
   - **Rachel** (21m00Tcm4TlvDq8ikWAM) — clear, friendly
   - **Aria** (9BWtsMINqrJLrRacOk9x) — expressive, conversational
   - **Laura** (FGY2WhTYpPnrIDTdsKH5) — professional, clear
   - **Lily** (pFZP5JQG7iQjIQuC4Bku) — soft, approachable
3. Select the voice you want — Vapi saves it automatically

### Step 8 — Test with a dry run

```bash
npm run call:dry-run
```

This shows you all the contacts Ava would call without actually dialing.

### Step 9 — Go live

```bash
npm run call
```

Ava will call through your list 5 seconds apart. Every call outcome is logged to HubSpot automatically.

---

## HubSpot — What Gets Logged

After every call, Ava logs to the contact record:
- A **Call engagement** with the outcome label and notes
- An updated **Lead Status** property
- A **follow-up Task** (if a callback was requested)

Outcome labels used:
- `✅ DEMO BOOKED` — prospect agreed to a demo, booking link sent
- `📅 CALLBACK REQUESTED` — follow-up task created
- `❌ NOT INTERESTED` — lead status set to Unqualified
- `📬 LEFT VOICEMAIL` — voicemail left, booking link sent via SMS
- `📵 NO ANSWER` — no one picked up
- `🚪 GATEKEEPER` — couldn't get through to the right person

---

## Customization

### Change the call delay
In `orchestrator/caller.js`, find `DELAY_BETWEEN_CALLS_MS` and adjust.

### Limit calls to a subset
```bash
node orchestrator/caller.js --limit 20
```

### Update the system prompt
Edit `vapi/system_prompt.txt` and re-run `setup.js` (it will create a new assistant version).

### Add more AE booking links
In `server/server.js` inside the `send_booking_link` case, you can map contacts to specific AE calendars based on owner ID.

---

## Files

```
alta-voice-bdr/
├── .env.example              ← Copy to .env and fill in
├── setup.js                  ← Run once to create Ava in Vapi
├── package.json
├── vapi/
│   └── system_prompt.txt     ← Ava's brain — talk track, persona, objections
├── server/
│   ├── server.js             ← Webhook server (tool calls + call status)
│   ├── hubspot.js            ← HubSpot API helpers
│   └── package.json
└── orchestrator/
    ├── caller.js             ← Pulls contacts + fires calls
    └── package.json
```
