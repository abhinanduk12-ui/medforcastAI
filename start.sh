#!/bin/bash
# Starts the MedForecast API (port 8000) and web app (port 3000)
#   ./start.sh            normal start (sign-in required)
#   ./start.sh --no-auth    sign-in disabled

NO_AUTH=0
if [ "$1" = "--no-auth" ]; then
    NO_AUTH=1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -f "$ROOT_DIR/ml/artifacts/forecast.csv" ]; then
    echo "No trained artifacts found - training models first..."
    cd "$ROOT_DIR" && python -m ml.train
fi

if [ "$NO_AUTH" -eq 1 ]; then
    export MEDFORECAST_AUTH='0'
fi

# Start API in background
echo "Starting API..."
cd "$ROOT_DIR" && python3 -m uvicorn backend.app:app --port 8000 &
API_PID=$!

if [ ! -f "$ROOT_DIR/frontend/.next/BUILD_ID" ]; then
    echo "Building frontend..."
    cd "$ROOT_DIR/frontend" && npm run build
fi

# Start Web in background
echo "Starting Website..."
cd "$ROOT_DIR/frontend" && npm run start &
WEB_PID=$!

# Trap to kill background processes on script exit
trap "kill $API_PID $WEB_PID 2>/dev/null" EXIT INT TERM

echo "Waiting for the API and website to start..."
DEADLINE=$(( $(date +%s) + 120 ))
READY=0

while [ $(date +%s) -lt $DEADLINE ]; do
    API_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/api/health)
    WEB_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/login)
    
    # Check if seasonal_ready is true in health JSON
    WARM=$(curl -s http://localhost:8000/api/health | grep -o '"seasonal_ready": *true')
    
    if [ "$API_STATUS" = "200" ] && [ "$WEB_STATUS" = "200" ] && [ -n "$WARM" ]; then
        READY=1
        break
    fi
    sleep 1
done

if [ "$READY" -eq 1 ]; then
    echo "Ready: http://localhost:3000"
    open "http://localhost:3000"
else
    echo "Still starting after 2 minutes - check the console for errors."
fi

# Keep the script running to keep background processes alive
wait
