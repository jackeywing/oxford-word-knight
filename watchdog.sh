#!/bin/bash
# Word-Knight tunnel keepalive script
LOG="/tmp/serveo.log"
SERVE_PID=""

while true; do
  # Check if serveo SSH is alive
  if ! pgrep -f "serveo.net" > /dev/null 2>&1; then
    echo "[$(date '+%H:%M:%S')] 🔄 Restarting serveo tunnel..." >> /tmp/tunnel-watch.log
    
    # Make sure server is up
    if ! lsof -ti:3000 > /dev/null 2>&1; then
      cd /Users/shuo/.openclaw/workspace/oxford-word-knight
      nohup node backend/server.js > /tmp/oxford.log 2>&1 &
      sleep 2
    fi
    
    nohup ssh -o StrictHostKeyChecking=no \
      -o ConnectTimeout=30 \
      -o TCPKeepAlive=yes \
      -o ServerAliveInterval=30 \
      -o ServerAliveCountMax=5 \
      -o ExitOnForwardFailure=yes \
      -R 80:localhost:3000 \
      serveo.net > "$LOG" 2>&1 &
    
    echo "[$(date '+%H:%M:%S')] ✅ Tunnel restarted, PID: $!" >> /tmp/tunnel-watch.log
  fi
  sleep 30
done
