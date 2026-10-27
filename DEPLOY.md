# Deploying Campus Navigator (so any phone can scan, on any network)

**Why the Wi-Fi problem existed:** the QR codes pointed to `http://192.168.1.3:5173`, the
laptop's address on the local network, and the backend also ran on that laptop. After
deployment, the QR codes point to a public `https://…` address that works on 4G/5G and any
Wi-Fi. The site and the API are served from ONE address (the FastAPI server serves the built
React app), so there is no proxy, CORS or "same network" issue left.

---

## Step 0 — Replace the leaked Groq key (do this first)
The old key is in the git history of the repo (and in the `.rar`).
1. Go to https://console.groq.com/keys → **delete the old key**, create a new one.
2. Put the new key only in your local `.env` (ignored by git) and, later, in Render's dashboard.

## Step 1 — Check the production build on your laptop
```bash
pip install -r requirements.txt
npm install
npm run build
uvicorn server.main:app --port 8000
```
Open http://localhost:8000/?start=N114 → ask for "salle J23". If it works, the same code works online.

## Step 2 — Put the project on GitHub
```bash
git add -A
git commit -m "Live navigation + deployment config"
git push
```
(`.env`, `node_modules`, `dist` and the QR images are in `.gitignore`/`.dockerignore`.)

## Step 3 — Create the service on Render (free tier available)
1. Create an account at https://render.com and connect your GitHub account.
2. **New → Blueprint** → select the repository (Render reads `render.yaml`).
   *(Or: New → Web Service → select the repo → Runtime: **Docker**.)*
3. When asked for `GROQ_API_KEY`, paste the **new** key.
4. Click **Deploy**. The first build takes a few minutes (it builds the React app, then the Python image).
5. Render gives you an address like `https://campus-navigator-xxxx.onrender.com`.

## Step 4 — Verify it works outside your Wi-Fi
1. Open `https://<your-address>/api/health` → should show `{"ok":true,"llm":true,...}`
   (`"llm": false` means the key is missing; the app still works with its local fallback).
2. On your phone, **turn Wi-Fi OFF (use mobile data)** and open `https://<your-address>/?start=N114`.
3. Ask for a room. If the route appears, the Wi-Fi problem is solved.

## Step 5 — Regenerate and print the QR codes
```bash
pip install "qrcode[pil]" openpyxl
python scripts/generate-qr-codes.py https://<your-address>
# optional: also codes for the stairs, so people can re-sync their position on the way
python scripts/generate-qr-codes.py https://<your-address> --types entry_point,stairs
```
Images are written to `public/qr-codes/`. Put the `tv-*` codes on the matching TV screens
(the file name contains the node id, e.g. `tv-1-N3.png` = node N3). The script refuses
`localhost` / `192.168.x.x` addresses on purpose.

## Step 6 — Updating later
`git push` → Render redeploys automatically. Data changes in `data/Book_4.xlsx` are picked up on redeploy.
If you change the public address, regenerate the QR codes.

---

## Things to know
- **Free Render services sleep after ~15 min without traffic**; the first scan after a pause can
  take 30–60 s. For real use on campus, take the paid "Starter" plan (set `plan: starter` in
  `render.yaml`), or ping `/api/health` every 10 min with a free monitor such as UptimeRobot.
- **HTTPS is required** for phone motion sensors (step tracking) — Render provides it automatically.
- **Other hosts:** the `Dockerfile` runs anywhere (Fly.io, Railway, a school server with
  `docker build -t campus . && docker run -p 80:8000 -e GROQ_API_KEY=... campus`; put Caddy/Nginx
  in front for HTTPS).
- **Quick demo without deploying:** run the app locally (Step 1) and expose it with
  `ngrok http 8000` or `cloudflared tunnel --url http://localhost:8000`. You get a temporary public
  https URL — use it as the `BASE_URL` for the QR script. It changes every run, so this is for
  demos only, and your laptop must stay on.
