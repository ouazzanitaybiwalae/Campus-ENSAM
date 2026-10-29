"""
Campus Navigator backend (FastAPI).

- POST /api/navigate     : destination (free text or node ID) + start location -> route, metadata and steps
- GET  /api/floorplan/x  : SVG file + viewBox for a map level (F0..F3)
- GET  /api/health       : health check for the hosting platform
- Serves the built React app (./dist) when it exists, so ONE public URL serves both
  the website and the API (no CORS / proxy / same-Wi-Fi problems).
"""
import os
import re
import json
import difflib
import math
import unicodedata
from pathlib import Path

import networkx as nx
import pandas as pd
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")

EXCEL_PATH = Path(os.getenv("EXCEL_PATH", BASE_DIR / "data" / "Book_4.xlsx"))
DIST_DIR = BASE_DIR / "dist"

GEO_PATH = Path(os.getenv("GEO_PATH", BASE_DIR / "data" / "geo.json"))
GEO = json.loads(GEO_PATH.read_text(encoding="utf-8")) if GEO_PATH.exists() else {}

GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-20b")

app = FastAPI(title="Campus Navigator")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# LLM client (optional: the app still works without it, using local fallbacks)
groq_client = None
if os.getenv("GROQ_API_KEY"):
    try:
        from groq import Groq

        groq_client = Groq(api_key=os.getenv("GROQ_API_KEY"))
    except Exception as e:  # pragma: no cover
        print("Groq init failed, running without LLM:", e)

# Data (Book_4.xlsx)
edges_df = pd.read_excel(EXCEL_PATH, sheet_name="Edges")
nodes_df = pd.read_excel(EXCEL_PATH, sheet_name="Nodes")
locations_df = pd.read_excel(EXCEL_PATH, sheet_name="Locations")
floors_df = pd.read_excel(EXCEL_PATH, sheet_name="Floors")

G = nx.Graph()
for _, row in edges_df.iterrows():
    G.add_edge(row["From_Node"], row["To_Node"], weight=float(row["Weight"]), edge_type=row["Edge_Type"])

NODE = {
    r["Node_Id"]: {
        "floor_id": r["floor_id"],
        "x": float(r["x"]),
        "y": float(r["y"]),
        "description": str(r["Description"]).strip(),
    }
    for _, r in nodes_df.iterrows()
}

FLOOR = {
    r["floor_id"]: {
        "building": str(r["Building_name"]).strip(),
        "floor_number": int(r["Floor_number"]),
        "num_floors": int(r["num_floors_in_building"]),
    }
    for _, r in floors_df.iterrows()
}


def map_level(floor_id) -> str:
    """Which map (SVG) a node is drawn on. Outdoor shares the ground-floor map."""
    if not isinstance(floor_id, str) or floor_id == "OUTDOOR":
        return "F0"
    return floor_id.split("-")[-1]


# Calibration between Excel coordinates (draw.io) and the Inkscape SVG viewBox
REAL_VIEWBOX = "-4000 -4000 39841.941 40660.051"
PT_TO_DOC_SCALE = 8.181097
PT_TO_DOC_OFFSET = -4000.0

LEVEL_FILES = {
    "F0": "/maps/First_Floor1.svg",
    "F1": "/maps/Second_Floor1.svg",
    "F2": "/maps/third_Floor1.svg",
    "F3": "/maps/Fourth_Floor1.svg",
}


def to_doc(x: float, y: float):
    return (
        x * PT_TO_DOC_SCALE + PT_TO_DOC_OFFSET,
        y * PT_TO_DOC_SCALE + PT_TO_DOC_OFFSET,
    )


def node_meta(node_id: str) -> dict:
    n = NODE[node_id]
    fid = n["floor_id"]
    fl = FLOOR.get(fid)
    x, y = to_doc(n["x"], n["y"])
    return {
        "node": node_id,
        "floorId": fid,
        "mapLevel": map_level(fid),
        "outdoor": fid == "OUTDOOR",
        "building": fl["building"] if fl else None,
        "floorNumber": fl["floor_number"] if fl else None,
        "numFloors": fl["num_floors"] if fl else 1,
        "x": x,
        "y": y,
        "lat": GEO[node_id][0] if node_id in GEO else None,
        "lon": GEO[node_id][1] if node_id in GEO else None,
    }


def nearest_outdoor_node(lat: float, lon: float):
    """Return the closest graph node outdoors that has GPS coordinates."""
    best_node = None
    best_distance = float("inf")
    meters_per_lon = 111320 * math.cos(math.radians(lat))
    for node_id, coordinates in GEO.items():
        if node_id not in G or node_id not in NODE or NODE[node_id]["floor_id"] != "OUTDOOR":
            continue
        if not isinstance(coordinates, (list, tuple)) or len(coordinates) < 2:
            continue
        node_lat, node_lon = coordinates[:2]
        if not isinstance(node_lat, (int, float)) or not isinstance(node_lon, (int, float)):
            continue
        distance = math.hypot(
            (lat - node_lat) * 110540,
            (lon - node_lon) * meters_per_lon,
        )
        if distance < best_distance:
            best_node = node_id
            best_distance = distance
    return best_node


# Destination matching: LLM first, local fuzzy matching as fallback
def normalize(s) -> str:
    s = unicodedata.normalize("NFKD", str(s).lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[^\w]+", " ", s, flags=re.UNICODE)
    return re.sub(r"\s+", " ", s).strip()


def _candidates():
    out = []
    for _, r in locations_df.iterrows():
        node_id = r["Node_Id"]
        if not isinstance(node_id, str) or node_id not in G:
            continue
        names = [r["Name"]]
        if isinstance(r["Aliases"], str):
            names += re.split(r"[;,]", r["Aliases"])
        for nm in names:
            norm = normalize(nm)
            if norm:
                out.append((norm, set(norm.split()), node_id))
    return out


CANDIDATES = _candidates()
STOPWORDS = {"de", "des", "du", "la", "le", "les", "l", "d", "a", "au", "aux", "the", "of", "to", "room", "salle"}


def _stem(tok: str) -> str:
    return tok.rstrip("sx") if len(tok) > 4 else tok


def _unique_stems():
    owners = {}
    for _norm, tokens, node_id in CANDIDATES:
        for t in tokens - STOPWORDS:
            if len(t) >= 4:
                owners.setdefault(_stem(t), set()).add(node_id)
    return {stem: next(iter(ids)) for stem, ids in owners.items() if len(ids) == 1}


_UNIQUE_STEMS = _unique_stems()


def local_match(text: str):
    """Return a Node_Id using token containment, then fuzzy ratio. None if unsure."""
    q = normalize(text)
    q_tokens = set(q.split())
    best, best_score = None, 0.0
    for norm, tokens, node_id in CANDIDATES:
        core = tokens - STOPWORDS
        if core and core <= q_tokens and tokens <= q_tokens | STOPWORDS:
            score = sum(len(t) for t in tokens) + 10
        elif core and core <= q_tokens:
            score = sum(len(t) for t in core)
        else:
            continue
        if score > best_score:
            best, best_score = node_id, score
    if best:
        return best
    q_stems = {_stem(t) for t in q_tokens if len(t) >= 4}
    hits = [nid for stem, nid in _UNIQUE_STEMS.items() if stem in q_stems]
    if len(hits) == 1:
        return hits[0]
    best_ratio = 0.0
    for norm, _tokens, node_id in CANDIDATES:
        ratio = max(
            difflib.SequenceMatcher(None, norm, q).ratio(),
            max((difflib.SequenceMatcher(None, norm, w).ratio() for w in q.split()), default=0),
        )
        if ratio > best_ratio:
            best, best_ratio = node_id, ratio
    return best if best_ratio >= 0.85 else None


def llm_match(text: str):
    if not groq_client:
        return None
    loc_list = [
        {"Name": r["Name"], "Aliases": r["Aliases"] if isinstance(r["Aliases"], str) else "", "Node_Id": r["Node_Id"]}
        for _, r in locations_df.iterrows()
    ]
    try:
        res = groq_client.chat.completions.create(
            model=GROQ_MODEL,
            temperature=0,
            messages=[
                {
                    "role": "system",
                    "content": "Trouve le Node_Id correspondant au lieu demandé. "
                    'Réponds UNIQUEMENT avec l\'ID du node (ex: N4), ou "null".',
                },
                {"role": "user", "content": f"Lieux: {loc_list}\nQuestion: '{text}'"},
            ],
        )
        answer = (res.choices[0].message.content or "").strip().strip("\"'` .")
        m = re.search(r"\bN\d+\b", answer)
        return m.group(0) if m else None
    except Exception as e:
        print("Groq extract error:", e)
        return None


# Step texts: exactly ONE step per path node (steps[i] = how to reach node i)
def place_label(meta: dict) -> str:
    if meta["outdoor"]:
        return "outdoor"
    if meta["numFloors"] > 1:
        return f'{meta["building"]}, floor {meta["floorNumber"]}'
    return meta["building"] or ""


def fallback_steps(path, metas, lang):
    steps = []
    for i, nid in enumerate(path):
        desc = NODE[nid]["description"]
        if i > 0:
            a, b = metas[i - 1], metas[i]
            if not a["outdoor"] and a["building"] == b["building"] and a["floorNumber"] != b["floorNumber"]:
                up = (b["floorNumber"] or 0) > (a["floorNumber"] or 0)
                if lang == "en":
                    desc = f'Take the stairs {"up" if up else "down"} to floor {b["floorNumber"]} — {desc}'
                else:
                    desc = f'Prenez l\'escalier pour {"monter" if up else "descendre"} à l\'étage {b["floorNumber"]} — {desc}'
        steps.append(desc)
    return steps


def clean_step(s: str, lang: str) -> str:
    return re.sub(r"\bN\d+\b", "a nearby building" if lang == "en" else "un bâtiment voisin", str(s)).strip()


def build_steps(path, metas, lang, use_llm=True):
    fb = fallback_steps(path, metas, lang)
    if not groq_client or not use_llm:
        return fb
    language = "English" if lang == "en" else "French"
    raw = [
        f"{i + 1}. [{place_label(metas[i])}] {NODE[nid]['description']}"
        for i, nid in enumerate(path)
    ]
    try:
        res = groq_client.chat.completions.create(
            model=GROQ_MODEL,
            temperature=0.2,
            messages=[
                {
                    "role": "system",
                    "content": (
                        f"You write short walking directions in {language} from numbered checkpoints. "
                        f"There are {len(path)} checkpoints. Return EXACTLY {len(path)} steps, in order: "
                        "step 1 says where the person is now; step k (k>1) says how to get from checkpoint k-1 to checkpoint k "
                        "(mention stairs when the floor changes). One short sentence each. "
                        "NEVER use the words 'node', 'junction' or 'intersection'. "
                        "Never output codes like 'N109'; say 'a nearby building' instead, without inventing names. "
                        'Return ONLY valid JSON: {"steps": ["...", "..."]}'
                    ),
                },
                {"role": "user", "content": "Checkpoints:\n" + "\n".join(raw)},
            ],
            response_format={"type": "json_object"},
        )
        steps = json.loads(res.choices[0].message.content).get("steps")
        if isinstance(steps, list) and len(steps) == len(path) and all(isinstance(s, str) and s.strip() for s in steps):
            return [clean_step(s, lang) for s in steps]
        print("Groq steps length mismatch, using fallback")
    except Exception as e:
        print("Groq directions error:", e)
    return fb


# API
class NavigationRequest(BaseModel):
    text: str = ""
    startNode: str
    lang: str = "fr"
    startText: str | None = None
    destinationNode: str | None = None
    startLat: float | None = None
    startLon: float | None = None


@app.post("/api/navigate")
def navigate(req: NavigationRequest):  # sync def -> runs in a worker thread (LLM calls block)
    if req.startLat is not None or req.startLon is not None:
        if req.startLat is None or req.startLon is None:
            return {"error": "Point de départ invalide", "code": "bad_start"}
        if (
            not math.isfinite(req.startLat)
            or not math.isfinite(req.startLon)
            or not -90 <= req.startLat <= 90
            or not -180 <= req.startLon <= 180
        ):
            return {"error": "Point de départ invalide", "code": "bad_start"}
        start_node = nearest_outdoor_node(req.startLat, req.startLon)
    elif req.startText is not None:
        start_node = llm_match(req.startText)
        if not start_node or start_node not in G or start_node not in NODE:
            start_node = local_match(req.startText)
    else:
        start_node = req.startNode

    if not start_node or start_node not in G or start_node not in NODE:
        return {"error": "Point de départ invalide", "code": "bad_start"}

    if req.destinationNode is not None:
        dest_node = req.destinationNode
    else:
        dest_node = llm_match(req.text)
        if not dest_node or dest_node not in G or dest_node not in NODE:
            dest_node = local_match(req.text)
    if not dest_node or dest_node not in G or dest_node not in NODE:
        return {"error": "Lieu non trouvé", "code": "not_found"}

    if dest_node == start_node:
        return {"error": "Vous y êtes déjà", "code": "already_there"}

    try:
        path = nx.shortest_path(G, source=start_node, target=dest_node, weight="weight")
    except nx.NetworkXNoPath:
        return {"error": "Aucun chemin trouvé", "code": "no_path"}

    metas = [node_meta(n) for n in path]
    edge_meters = [G[a][b]["weight"] for a, b in zip(path, path[1:])]
    edge_types = [G[a][b]["edge_type"] for a, b in zip(path, path[1:])]
    steps = build_steps(path, metas, req.lang, use_llm=req.destinationNode is None)

    row = locations_df[locations_df["Node_Id"] == dest_node]
    dest_name = str(row["Name"].values[0]) if not row.empty else dest_node

    return {
        "destinationName": dest_name,
        "destinationNode": dest_node,
        "path": path,
        "pathMeta": metas,
        "edgeMeters": edge_meters,  # Excel 'Weight', assumed to be metres
        "edgeTypes": edge_types,
        "steps": steps,  # len(steps) == len(path)
    }


@app.get("/api/floorplan/{level}")
def get_floorplan(level: str):
    level = "F0" if level == "OUTDOOR" else level
    file = LEVEL_FILES.get(level)
    if not file:
        return {"error": f"Pas de plan disponible pour {level}"}
    nodes_out = []
    for nid, n in NODE.items():
        if map_level(n["floor_id"]) == level:
            x, y = to_doc(n["x"], n["y"])
            nodes_out.append({"id": nid, "x": x, "y": y})
    return {"file": file, "viewBox": REAL_VIEWBOX, "nodes": nodes_out}


@app.get("/api/health")
def health():
    return {"ok": True, "llm": groq_client is not None, "nodes": G.number_of_nodes(), "geo": len(GEO)}


# Serve the built frontend
if DIST_DIR.exists():
    app.mount("/", StaticFiles(directory=DIST_DIR, html=True), name="frontend")
