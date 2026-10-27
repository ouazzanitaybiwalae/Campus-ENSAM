   ---
   title: Campus Navigator
   sdk: docker
   app_port: 8000
   ---
# ENSAM Rabat — Campus Navigator

Scan a QR code on a campus screen → say where you want to go → follow a **live blue route**
that shrinks and follows you, switching building floors automatically.

## How it works
- `data/Book_4.xlsx` – campus graph (Floors, Nodes, Edges, Locations, Node_Types).
- `server/main.py` – FastAPI: finds the destination (Groq LLM, with a local fuzzy fallback),
  computes the shortest path (networkx), returns per-node metadata (building, floor, map
  coordinates) and **one instruction per node**. In production it also serves the built website.
- `src/LiveNavigation.jsx` – live route card: current position, moving marker, remaining line,
  automatic floor/map switching, stairs hints, follow-camera.
- `src/navMath.js` – position-along-route maths + step detector (unit-tested).
- `scripts/generate-qr-codes.py` – QR codes (`<public-url>/?start=<Node_Id>`).

## Live position modes
1. **Next / Back buttons** (reliable everywhere).
2. **Step tracking (beta)** – phone accelerometer counts steps (needs HTTPS; iOS asks permission).
3. **Demo** – simulated walk, for presentations.
4. **Re-scan any QR** on the way → the app offers to continue the previous destination from there.

## Run locally (development)
```bash
cp .env.example .env            # put your NEW Groq key inside
pip install -r requirements.txt
uvicorn server.main:app --port 3001 --reload     # terminal 1
npm install && npm run dev                       # terminal 2  -> http://localhost:5173/?start=N114
```

## Production build, locally
```bash
npm run build
uvicorn server.main:app --port 8000              # -> http://localhost:8000/?start=N114
```

## Deploy
See **DEPLOY.md**.

## Data notes
- `Edges.Weight` is treated as **metres** (used for the remaining distance and for step tracking).
- Node coordinates are converted with the Inkscape calibration in `server/main.py`.
- Outdoor nodes and ground floors share the same map (`F0`).
