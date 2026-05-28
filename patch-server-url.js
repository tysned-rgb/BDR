/**
 * Patches Ava's tool server URLs and call status URL in Vapi
 * to point to the Railway deployment instead of ngrok.
 *
 * Run once: node patch-server-url.js
 */

require('dotenv').config();
const axios = require('axios');

const VAPI_KEY     = process.env.VAPI_API_KEY;
const ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID;
// Accept SERVER_URL from env or command line: SERVER_URL=https://... node patch-server-url.js
const SERVER_URL   = process.env.SERVER_URL;

async function patch() {
  console.log(`\nPatching Ava to use: ${SERVER_URL}\n`);

  // Fetch current assistant config
  const { data: assistant } = await axios.get(
    `https://api.vapi.ai/assistant/${ASSISTANT_ID}`,
    { headers: { Authorization: `Bearer ${VAPI_KEY}` } }
  );

  // Update each tool's server URL
  const updatedTools = (assistant.model?.tools || []).map(tool => ({
    ...tool,
    server: { url: `${SERVER_URL}/tool-call` },
  }));

  // Patch the assistant
  await axios.patch(
    `https://api.vapi.ai/assistant/${ASSISTANT_ID}`,
    {
      model:     { ...assistant.model, tools: updatedTools },
      serverUrl: `${SERVER_URL}/call-status`,
    },
    { headers: { Authorization: `Bearer ${VAPI_KEY}`, 'Content-Type': 'application/json' } }
  );

  console.log('✅ Ava updated — all tool calls now route to Railway');
  console.log(`   Tool calls:  ${SERVER_URL}/tool-call`);
  console.log(`   Call status: ${SERVER_URL}/call-status\n`);
}

patch().catch(err => {
  console.error('❌ Failed:', err.response?.data || err.message);
  process.exit(1);
});
