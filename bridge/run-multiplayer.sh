#!/bin/bash
# Launch multiple Neon bridges for multiplayer mode.
# Each player gets their own bridge instance on a unique port.
#
# Usage:
#   ./run-multiplayer.sh 2 172.20.10.11  # 2 players, one phone at 172.20.10.11
#   ./run-multiplayer.sh 2              # 2 players, auto-discover the phone(s)
#
# Ports used:
#   Bridge 0: localhost:8443
#   Bridge 1: localhost:8444
#   etc.

set -e

PLAYER_COUNT=${1:-2}
PHONE_ADDRESS=${2:-}

BASE_PORT=8443
SCREEN_WIDTH=1920
SCREEN_HEIGHT=1080

# Colors for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}PetrifEye Multiplayer Bridge Launcher${NC}"
echo "Players: $PLAYER_COUNT"
echo "Screen: ${SCREEN_WIDTH}x${SCREEN_HEIGHT}"
echo ""

# Kill any existing bridges first
pkill -f "neon_bridge.py" 2>/dev/null || true
sleep 1

# Start each bridge
for i in $(seq 0 $((PLAYER_COUNT - 1))); do
  PORT=$((BASE_PORT + i))
  CMD=".venv/bin/python bridge/neon_bridge.py --port $PORT --screen-width $SCREEN_WIDTH --screen-height $SCREEN_HEIGHT"

  if [ -n "$PHONE_ADDRESS" ]; then
    CMD="$CMD --address $PHONE_ADDRESS"
  fi

  echo -e "${YELLOW}Player $i:${NC} Starting bridge on port $PORT..."
  eval "$CMD" > "/tmp/bridge-player-$i.log" 2>&1 &
  PIDS[$i]=$!
done

echo ""
echo -e "${GREEN}All bridges launched!${NC}"
echo ""
echo "Bridge logs:"
for i in $(seq 0 $((PLAYER_COUNT - 1))); do
  echo "  Player $i: tail -f /tmp/bridge-player-$i.log"
done
echo ""
echo "To stop all bridges: pkill -f neon_bridge.py"
echo "To watch a specific player: tail -f /tmp/bridge-player-0.log"
echo ""
echo "Open: https://localhost:8443/"
