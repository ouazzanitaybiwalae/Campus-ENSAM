"""
Campus Navigator backend (FastAPI).

- POST /api/navigate     : destination (free text) + start node -> route, per-node metadata, aligned steps
- GET  /api/floorplan/x  : SVG file + viewBox for a map level (F0..F3)
- GET  /api/health       : health check for the hosting platform
- Serves the built React app (./dist) when it exists, so ONE public URL serves both
  the website and the API (no CORS / proxy / same-Wi-Fi problems).
"""
import os
import re
import json
import difflib
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
GEO_PATH = Path(os.getenv("GEO_PATH", BASE_DIR / "data" / "geo.json"))
DIST_DIR = BASE_DIR / "dist"
GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")

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

# GPS coordinates [lat, lon] of the outdoor nodes (optional): the phone uses GPS on these stretches
GEO = json.loads(GEO_PATH.read_text(encoding="utf-8")) if GEO_PATH.exists() else {}

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
        "geo": GEO.get(node_id),
    }


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

# Building names as written in French directions (the Excel sheet mixes English and French)
BUILDING_FR = {
    "Admin building": "bâtiment administratif",
    "Dept Electrique": "département électrique",
    "Atelier": "atelier",
    "Amphithéâtre": "bâtiment de l'amphithéâtre",
    "Toillette 1": "toilettes",
    "Campus Grounds": "extérieur",
}


def building_name(meta: dict, lang: str) -> str:
    b = meta["building"] or ""
    return BUILDING_FR.get(b, b) if lang == "fr" else b


def floor_name(n, lang: str) -> str:
    n = n or 0
    if lang == "en":
        return "the ground floor" if n == 0 else f"floor {n}"
    return "rez-de-chaussée" if n == 0 else ("1er étage" if n == 1 else f"{n}e étage")


def place_label(meta: dict, lang: str = "fr") -> str:
    if meta["outdoor"]:
        return "outside" if lang == "en" else "à l'extérieur"
    b = building_name(meta, lang)
    if meta["numFloors"] > 1:
        return f'{b}, {floor_name(meta["floorNumber"], lang)}'
    return b


def transition(a: dict, b: dict, lang: str):
    """What changes between two consecutive checkpoints (exit, enter, stairs), or None."""
    en = lang == "en"
    if not a["outdoor"] and b["outdoor"]:
        return "Go outside" if en else "Sortez du bâtiment"
    if a["outdoor"] and not b["outdoor"]:
        return f"Enter the {building_name(b, lang)}" if en else f"Entrez dans : {building_name(b, lang)}"
    if a["building"] != b["building"]:
        return f"Go into the {building_name(b, lang)}" if en else f"Passez dans : {building_name(b, lang)}"
    if a["floorNumber"] != b["floorNumber"]:
        up = (b["floorNumber"] or 0) > (a["floorNumber"] or 0)
        f = floor_name(b["floorNumber"], lang)
        if en:
            return f'Take the stairs {"up" if up else "down"} to {f}'
        return f'{"Montez" if up else "Descendez"} l\'escalier jusqu\'au {f}'
    return None


def fallback_steps(path, metas, lang, dest_name):
    en = lang == "en"
    steps = []
    for i, nid in enumerate(path):
        desc = NODE[nid]["description"]
        if i == 0:
            steps.append(f"You are {place_label(metas[0], lang)} ({desc})." if en else f"Vous êtes {place_label(metas[0], lang)} ({desc}).")
        elif i == len(path) - 1:
            steps.append(f"You have arrived: {dest_name}." if en else f"Vous êtes arrivé : {dest_name}.")
        else:
            move = transition(metas[i - 1], metas[i], lang) or ("Continue" if en else "Continuez")
            steps.append(f"{move} ({desc})." if en else f"{move} (repère : {desc}).")
    return steps


def clean_step(s: str, lang: str) -> str:
    s = re.sub(r"\bN\d+\b", "a nearby building" if lang == "en" else "un bâtiment voisin", str(s)).strip()
    if lang == "fr":
        s = re.sub(r"\bl'étage 0\b|\bétage 0\b", "rez-de-chaussée", s)
    return s


STYLE_FR = """Tu rédiges des instructions de guidage à pied, en français, pour des étudiants et visiteurs d'un campus.
Règles :
- Français correct et naturel, avec les accents, en vouvoyant. Une seule phrase courte par étape (15 mots maximum).
- Étape 1 : où se trouve la personne maintenant (« Vous êtes devant… »).
- Étapes intermédiaires : TOUJOURS une action à l'impératif (Avancez, Continuez, Entrez, Sortez, Traversez, Tournez, Montez, Descendez, Passez devant…) suivie d'un repère visible.
- Dernière étape : « Vous êtes arrivé : <destination>. » éventuellement avec un repère.
- Si un changement est indiqué (entrée, sortie, escalier), l'étape DOIT le dire clairement.
- Ne dis de monter ou descendre un escalier QUE si la ligne contient « changement : Montez/Descendez ». Un escalier cité dans un repère est seulement un repère (« Passez devant l'escalier »).
- Les notes de repère sont en anglais ou approximatives : traduis-les et reformule-les, ne les recopie pas.
- N'invente pas « gauche » ou « droite » si la note ne le dit pas clairement.
- Dis « rez-de-chaussée », jamais « étage 0 ». N'écris jamais « nœud », « node », « jonction », « intersection », « checkpoint » ni de code comme « N109 ».
Exemple de bon style :
["Vous êtes devant le bâtiment administratif, près de l'écran.", "Entrez dans le bâtiment administratif et avancez jusqu'à l'écran de télévision.", "Montez l'escalier jusqu'au 1er étage.", "Passez devant la salle B5 et continuez tout droit.", "Vous êtes arrivé : Salle B7."]"""

STYLE_EN = """You write walking directions in English for students and visitors on a campus.
Rules:
- One short, clear sentence per step (15 words max).
- Step 1: where the person is now ("You are in front of…").
- Middle steps: ALWAYS an imperative action (Walk, Continue, Enter, Go outside, Turn, Take the stairs, Pass…) plus a visible landmark.
- Last step: "You have arrived: <destination>." optionally with a landmark.
- If a change is given (enter, exit, stairs), the step MUST say it clearly.
- Only tell the person to go up or down stairs when the line has "changement: Take the stairs". Stairs mentioned in a note are just a landmark ("Pass the stairs").
- Rephrase the landmark notes; don't copy them verbatim. Don't invent left/right unless the note clearly says so.
- Never write "node", "junction", "intersection", "checkpoint" or codes like "N109"."""


def build_steps(path, metas, lang, dest_name):
    fb = fallback_steps(path, metas, lang, dest_name)
    if not groq_client:
        return fb
    raw = []
    for i, nid in enumerate(path):
        # notes sometimes cite other nodes ("after N96"): name them by role instead of by code
        note = re.sub(
            r'"?\b(N\d+)\b"?',
            lambda m: "the previous checkpoint" if i > 0 and m.group(1) == path[i - 1] else "a nearby spot",
            NODE[nid]["description"],
        )
        line = f"{i + 1}. lieu : {place_label(metas[i], lang)} | repère : {note}"
        change = transition(metas[i - 1], metas[i], lang) if i > 0 else None
        if change:
            line += f" | changement : {change}"
        raw.append(line)
    try:
        res = groq_client.chat.completions.create(
            model=GROQ_MODEL,
            temperature=0.2,
            messages=[
                {
                    "role": "system",
                    "content": (STYLE_EN if lang == "en" else STYLE_FR)
                    + f"\n\nThere are {len(path)} checkpoints: return EXACTLY {len(path)} steps, in order "
                    "(step k = how to get from checkpoint k-1 to checkpoint k). "
                    'Return ONLY valid JSON: {"steps": ["...", "..."]}',
                },
                {
                    "role": "user",
                    "content": f"Destination : {dest_name}\nCheckpoints :\n" + "\n".join(raw),
                },
            ],
            response_format={"type": "json_object"},
        )
        steps = json.loads(res.choices[0].message.content).get("steps")
        if isinstance(steps, list) and len(steps) == len(path) and all(isinstance(s, str) and s.strip() for s in steps):
            steps = [clean_step(s, lang) for s in steps]
            arrived = "You have arrived" if lang == "en" else "Vous êtes arrivé"
            if not steps[-1].startswith(arrived):
                steps[-1] = fb[-1]
            return steps
        print("Groq steps length mismatch, using fallback")
    except Exception as e:
        print("Groq directions error:", e)
    return fb


# API
class NavigationRequest(BaseModel):
    text: str
    startNode: str
    lang: str = "fr"
    destNode: str | None = None  # set when recalculating a route: skips destination matching


@app.post("/api/navigate")
def navigate(req: NavigationRequest):  # sync def -> runs in a worker thread (LLM calls block)
    if req.startNode not in G or req.startNode not in NODE:
        return {"error": "Point de départ invalide", "code": "bad_start"}

    dest_node = req.destNode if req.destNode in G else None
    if not dest_node:
        dest_node = llm_match(req.text)
    if not dest_node or dest_node not in G:
        dest_node = local_match(req.text)
    if not dest_node or dest_node not in G:
        return {"error": "Lieu non trouvé", "code": "not_found"}

    if dest_node == req.startNode:
        return {"error": "Vous y êtes déjà", "code": "already_there"}

    try:
        path = nx.dijkstra_path(G, source=req.startNode, target=dest_node, weight="weight")
    except nx.NetworkXNoPath:
        return {"error": "Aucun chemin trouvé", "code": "no_path"}

    row = locations_df[locations_df["Node_Id"] == dest_node]
    dest_name = str(row["Name"].values[0]) if not row.empty else dest_node

    metas = [node_meta(n) for n in path]
    edge_meters = [G[a][b]["weight"] for a, b in zip(path, path[1:])]
    steps = build_steps(path, metas, req.lang, dest_name)
    for m in metas:  # building names shown in the app ("Vous êtes ici : …")
        m["building"] = building_name(m, req.lang)

    return {
        "destinationName": dest_name,
        "destinationNode": dest_node,
        "path": path,
        "pathMeta": metas,
        "edgeMeters": edge_meters,  # Excel 'Weight', assumed to be metres
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


@app.get("/api/geo")
def get_geo():
    """Outdoor nodes with GPS coordinates and the paths between them, to place a GPS fix on the map."""
    nodes = {}
    for nid, latlon in GEO.items():
        if nid in NODE:
            m = node_meta(nid)
            nodes[nid] = {"geo": latlon, "x": m["x"], "y": m["y"], "mapLevel": m["mapLevel"]}
    edges = sorted({tuple(sorted((a, b))) for a, b in G.edges() if a in nodes and b in nodes})
    return {"nodes": nodes, "edges": edges}


@app.get("/api/health")
def health():
    return {"ok": True, "llm": groq_client is not None, "nodes": G.number_of_nodes()}


# Serve the built frontend
if DIST_DIR.exists():
    app.mount("/", StaticFiles(directory=DIST_DIR, html=True), name="frontend")
