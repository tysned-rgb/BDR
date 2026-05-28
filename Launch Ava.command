#!/bin/bash
cd "$(dirname "$0")"

echo "🎙️  Starting Ava — Alta Voice BDR"
echo ""

# Start the app server in background
node app.js &
APP_PID=$!
sleep 2

# Start ngrok and capture the URL
echo "Starting ngrok tunnel..."
ngrok http 3001 --log=stdout --log-format=json > /tmp/ngrok-ava.log 2>&1 &
NGROK_PID=$!
sleep 3

# Extract the ngrok URL
NGROK_URL=$(curl -s http://localhost:4040/api/tunnels 2>/dev/null | python3 -c "import sys,json; data=json.load(sys.stdin); print([t['public_url'] for t in data.get('tunnels',[]) if t['proto']=='https'][0])" 2>/dev/null)

if [ -n "$NGROK_URL" ]; then
  echo ""
  echo "✅ Ngrok tunnel: $NGROK_URL"
  echo ""
  echo "Run this to update Ava's webhook URL:"
  echo "  SERVER_URL=$NGROK_URL node patch-server-url.js"
  echo ""
else
  echo "⚠️  Could not get ngrok URL. Run 'ngrok http 3001' manually in a new terminal,"
  echo "   then run: SERVER_URL=<your-ngrok-url> node patch-server-url.js"
  echo ""
fi

# Wait for the app to exit
wait $APP_PID
