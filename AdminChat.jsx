import React, { useState, useRef, useEffect } from 'react';
import LiveRoute, { requestMotionPermission } from './src/LiveNavigation.jsx';

// Multilingual UI Dictionary
const TRANSLATIONS = {
  fr: {
    title: 'ENSAM RABAT Campus Navigator',
    subtitle: "Demandez où vous devez aller sur le campus — je vous montre l'itinéraire sur une carte et vous guide étape par étape.",
    placeholder: 'ex. Comment aller au bureau de scolarité ?',
    send: 'Envoyer',
    online: 'En ligne',
    startPoint: 'Point de départ actif :',
    routeTo: 'Itinéraire vers',
    walkingRoute: 'Itinéraire à pied',
    notFound: "Je n'ai pas trouvé cette destination. Essayez d'exprimer votre recherche différemment.",
    noStartNode: "Aucun point de départ détecté — scannez le QR code d'un des écrans du campus.",
    loadingMap: 'Chargement du plan...',
    noMap: 'Plan non disponible pour cet étage.',
    user: 'Vous',
    bot: 'Campus Navigator',
    outdoor: 'Extérieur',
    floor: 'Étage',
    groundFloor: 'RDC',
    youAreHere: 'Vous êtes ici',
    step: 'Étape',
    remaining: 'restants',
    arrived: 'Vous êtes arrivé à destination 🎉',
    recenter: 'Recentrer',
    demo: 'Démo',
    stepsTitle: 'Instructions',
    gpsOk: (m) => `GPS actif (précision ±${m} m)`,
    gpsWait: 'Recherche du signal GPS… (le podomètre prend le relais en attendant)',
    gpsWeak: (m) => `GPS imprécis (±${m} m) : suivi par le podomètre`,
    gpsOffRoute: "Vous vous éloignez de l'itinéraire",
    gpsDenied: 'Localisation refusée : autorisez-la pour ce site dans les réglages du navigateur, puis rechargez la page.',
    stairsUp: (b, f) => `Montez l'escalier de ${b} jusqu'à : ${f}`,
    stairsDown: (b, f) => `Descendez l'escalier de ${b} jusqu'à : ${f}`,
    motionDenied: "L'accès aux capteurs de mouvement a été refusé : le point ne peut pas suivre vos pas. Autorisez-le dans les réglages du navigateur, puis relancez l'itinéraire.",
    motionNone: "Aucun capteur de mouvement détecté sur cet appareil (ou la page n'est pas servie en HTTPS) : le point ne peut pas suivre vos pas.",
    resumeTitle: (d) => `Reprendre l'itinéraire vers « ${d} » depuis ce point ?`,
    resumeYes: 'Reprendre',
    resumeNo: 'Ignorer',
    errors: {
      not_found: "Je n'ai pas trouvé cette destination. Essayez d'exprimer votre recherche différemment.",
      bad_start: "Ce point de départ est inconnu. Scannez à nouveau le QR code d'un écran du campus.",
      no_path: "Aucun chemin n'a été trouvé vers cette destination.",
      already_there: 'Vous êtes déjà à cet endroit !',
      server: 'Le service est momentanément indisponible. Réessayez dans un instant.',
    },
    suggestions: [
      'Où se trouve la salle B7 ?',
      'Comment aller à la salle d\'étude?',
      'Itinéraire vers le bureau de scolarité',
    ],
  },
  en: {
    title: 'ENSAM RABAT campus Navigator',
    subtitle: 'Ask where you need to go on campus — I will show you the route on a map and guide you step by step.',
    placeholder: 'e.g. How do I get to the registrar office?',
    send: 'Send',
    online: 'Online',
    startPoint: 'Active starting point:',
    routeTo: 'Route to',
    walkingRoute: 'Walking directions',
    notFound: "I couldn't find that destination. Please try rephrasing your search.",
    noStartNode: 'No starting point detected — please scan a QR code from a campus screen.',
    loadingMap: 'Loading map...',
    noMap: 'Map not available for this floor.',
    user: 'You',
    bot: 'Campus Navigator',
    outdoor: 'Outdoor',
    floor: 'Floor',
    groundFloor: 'Ground Floor',
    youAreHere: 'You are here',
    step: 'Step',
    remaining: 'left',
    arrived: 'You have arrived 🎉',
    recenter: 'Re-center',
    demo: 'Demo',
    stepsTitle: 'Directions',
    gpsOk: (m) => `GPS on (accuracy ±${m} m)`,
    gpsWait: 'Looking for GPS signal… (step counting in the meantime)',
    gpsWeak: (m) => `GPS imprecise (±${m} m): using step counting`,
    gpsOffRoute: 'You are moving away from the route',
    gpsDenied: 'Location access denied: allow it for this site in your browser settings, then reload the page.',
    stairsUp: (b, f) => `Take the stairs in ${b} up to: ${f}`,
    stairsDown: (b, f) => `Take the stairs in ${b} down to: ${f}`,
    motionDenied: 'Motion sensor access was denied, so the dot cannot follow your steps. Allow it in your browser settings, then request the route again.',
    motionNone: 'No motion sensor detected on this device (or the page is not served over HTTPS), so the dot cannot follow your steps.',
    resumeTitle: (d) => `Continue the route to "${d}" from this point?`,
    resumeYes: 'Continue',
    resumeNo: 'Dismiss',
    errors: {
      not_found: "I couldn't find that destination. Please try rephrasing your search.",
      bad_start: 'Unknown starting point. Please scan a QR code from a campus screen again.',
      no_path: 'No path was found to that destination.',
      already_there: 'You are already there!',
      server: 'The service is temporarily unavailable. Please try again in a moment.',
    },
    suggestions: [
      'Where is classroom B7?',
      'How do I get to the library?',
      'Directions to the registrar office',
    ],
  },
};

const LAST_ROUTE_KEY = 'cn_last_route';
const LAST_ROUTE_TTL_MS = 30 * 60 * 1000;

function saveLastRoute(data) {
  try {
    localStorage.setItem(LAST_ROUTE_KEY, JSON.stringify({ ...data, ts: Date.now() }));
  } catch {}
}
function loadLastRoute() {
  try {
    const d = JSON.parse(localStorage.getItem(LAST_ROUTE_KEY));
    return d && Date.now() - d.ts < LAST_ROUTE_TTL_MS ? d : null;
  } catch {
    return null;
  }
}
function clearLastRoute() {
  try {
    localStorage.removeItem(LAST_ROUTE_KEY);
  } catch {}
}

// Returns { route } on success or { error: <code> } on failure.
async function resolveRoute(text, startNode, lang) {
  if (!startNode) return { error: 'no_start' };
  try {
    const res = await fetch('/api/navigate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, startNode, lang }),
    });
    if (!res.ok) return { error: 'server' };
    const data = await res.json();
    if (data.error) return { error: data.code || 'not_found' };
    return {
      route: {
        destination: data.destinationName || 'destination',
        path: data.path,
        pathMeta: data.pathMeta,
        edgeMeters: data.edgeMeters,
        steps: data.steps,
      },
    };
  } catch (err) {
    console.error('Error calling /api/navigate:', err);
    return { error: 'server' };
  }
}

export default function AdminChat() {
  const [lang, setLang] = useState('fr');
  const t = TRANSLATIONS[lang];

  const [inputValue, setInputValue] = useState('');
  const [messages, setMessages] = useState([]);
  const [startNode, setStartNode] = useState(null);
  const positionRef = useRef(null); // where the user currently is (updates while they walk)
  const [resume, setResume] = useState(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const node = params.get('start');
    setStartNode(node);
    positionRef.current = node;
    // Re-scanned a QR code in the middle of a trip? Offer to continue the previous destination.
    const saved = loadLastRoute();
    if (node && saved) setResume(saved);
  }, []);

  const scrollAnchorRef = useRef(null);
  const hasMessages = messages.length > 0;
  const activeRouteId = [...messages].reverse().find((m) => m.mapData)?.id;

  useEffect(() => {
    if (scrollAnchorRef.current) scrollAnchorRef.current.scrollIntoView({ block: 'nearest' });
  }, [messages]);

  async function sendMessage(overrideText) {
    const text = (overrideText ?? inputValue).trim();
    if (!text) return;
    requestMotionPermission(); // must run inside the tap, before any await (iOS)

    const userMsg = { role: 'user', text, id: Date.now() };
    const pendingId = Date.now() + 1;
    const pendingMsg = { role: 'assistant', pending: true, id: pendingId };

    setMessages((m) => [...m, userMsg, pendingMsg]);
    setInputValue('');
    setResume(null);

    // start from where the user is NOW (not from the original QR code)
    const from = positionRef.current || startNode;
    const result = await resolveRoute(text, from, lang);

    if (result.route) {
      positionRef.current = result.route.path[0];
      saveLastRoute({ text, destination: result.route.destination });
    }

    setMessages((m) =>
      m.map((msg) =>
        msg.id === pendingId
          ? result.route
            ? { role: 'assistant', id: msg.id, mapData: result.route }
            : {
                role: 'assistant',
                id: msg.id,
                text: !from ? t.noStartNode : t.errors[result.error] || t.notFound,
              }
          : msg
      )
    );
  }

  function useSuggestion(s) {
    setInputValue(s);
    sendMessage(s);
  }

  const inputBar = (
    <form
      className="cn-input"
      onSubmit={(e) => {
        e.preventDefault();
        sendMessage();
      }}
    >
      <input
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        placeholder={t.placeholder}
        enterKeyHint="send"
        autoComplete="off"
      />
      <button type="submit" disabled={!inputValue.trim()}>{t.send}</button>
    </form>
  );

  return (
    <div className="cn-app">
      <header className="cn-header">
        <img src="/logo-ensam.jpg" alt="ENSAM Rabat — École Nationale Supérieure d'Arts et Métiers" className="cn-logo" />
        <div className="cn-lang">
          <button className={lang === 'fr' ? 'on' : ''} onClick={() => setLang('fr')}>FR</button>
          <button className={lang === 'en' ? 'on' : ''} onClick={() => setLang('en')}>EN</button>
        </div>
      </header>

      {!hasMessages && (
        <main className="cn-welcome">
          <h1>{t.title}</h1>
          <p>{t.subtitle}</p>

          {startNode && (
            <div className="cn-start">
              {t.startPoint} <strong>{startNode}</strong>
            </div>
          )}

          {resume && startNode && (
            <div className="cn-resume">
              <div style={{ marginBottom: 10, fontWeight: 600 }}>{t.resumeTitle(resume.destination)}</div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                <button className="cn-btn" onClick={() => sendMessage(resume.text)}>{t.resumeYes}</button>
                <button className="cn-btn ghost" onClick={() => { clearLastRoute(); setResume(null); }}>{t.resumeNo}</button>
              </div>
            </div>
          )}

          {inputBar}

          <div className="cn-suggestions">
            {t.suggestions.map((s) => (
              <button key={s} onClick={() => useSuggestion(s)}>{s}</button>
            ))}
          </div>
        </main>
      )}

      {hasMessages && (
        <>
          <main className="cn-thread">
            <div className="cn-thread-inner">
              {messages.map((msg) => (
                <div key={msg.id} className={`cn-msg ${msg.role}`}>
                  <div className="cn-who">{msg.role === 'user' ? t.user : t.bot}</div>

                  {msg.role === 'user' && <div className="cn-bubble user">{msg.text}</div>}

                  {msg.role === 'assistant' && (
                    <div className={`cn-bubble bot${msg.mapData ? ' route' : ''}`}>
                      {msg.pending && (
                        <div style={{ display: 'flex', gap: 5, padding: '4px 0' }}>
                          <span className="dot" style={{ animationDelay: '0s' }} />
                          <span className="dot" style={{ animationDelay: '0.2s' }} />
                          <span className="dot" style={{ animationDelay: '0.4s' }} />
                        </div>
                      )}

                      {msg.mapData && msg.id === activeRouteId && (
                        <LiveRoute
                          key={msg.id}
                          route={msg.mapData}
                          t={t}
                          onPositionChange={(node) => { positionRef.current = node; }}
                          onArrived={clearLastRoute}
                        />
                      )}

                      {msg.mapData && msg.id !== activeRouteId && (
                        <>
                          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>{t.routeTo} {msg.mapData.destination}</div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            {msg.mapData.steps.map((step, i) => (
                              <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                                <div style={{ width: 22, height: 22, borderRadius: '50%', background: 'oklch(0.94 0.03 258)', color: 'oklch(0.45 0.13 258)', fontSize: 11.5, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', marginTop: 1 }}>{i + 1}</div>
                                <div style={{ fontSize: 14.5, lineHeight: 1.5 }}>{step}</div>
                              </div>
                            ))}
                          </div>
                        </>
                      )}

                      {msg.text && <div>{msg.text}</div>}
                    </div>
                  )}
                </div>
              ))}
              <div ref={scrollAnchorRef} />
            </div>
          </main>

          <footer className="cn-footer">{inputBar}</footer>
        </>
      )}

      <style>{`
        html, body, #root { margin: 0; height: 100%; }
        body { background: #f4f7fb; -webkit-text-size-adjust: 100%; }
        * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
        button { font-family: inherit; }

        .cn-app { display: flex; flex-direction: column; height: 100vh; height: 100dvh; width: 100%; overflow: hidden;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
          background: #f4f7fb; color: oklch(0.24 0.03 255); }

        .cn-header { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px;
          padding: calc(8px + env(safe-area-inset-top)) 16px 8px; background: #f7f7f7; /* same as the logo's background */
          border-bottom: 1px solid oklch(0.9 0.01 258); }
        .cn-logo { height: 52px; width: auto; max-width: 62vw; object-fit: contain; display: block; }
        .cn-lang { display: flex; background: #e6e9ef; border-radius: 9px; padding: 3px; flex: none; }
        .cn-lang button { border: none; background: transparent; color: #333; border-radius: 7px; padding: 7px 11px;
          font-size: 13px; font-weight: 600; cursor: pointer; min-width: 40px; }
        .cn-lang button.on { background: oklch(0.5 0.15 258); color: #fff; }

        .cn-welcome { flex: 1; overflow-y: auto; display: flex; flex-direction: column; align-items: center;
          justify-content: center; padding: 24px 16px; text-align: center; }
        .cn-welcome h1 { font-size: 21px; font-weight: 700; color: oklch(0.22 0.03 258); margin: 0 0 8px; }
        .cn-welcome p { font-size: 15px; color: oklch(0.48 0.02 258); max-width: 440px; line-height: 1.5; margin: 0 0 22px; }
        .cn-start { font-size: 12px; color: #555; padding: 5px 10px; background: #e8edf5; border-radius: 7px; margin-bottom: 14px; }
        .cn-resume { width: 100%; max-width: 600px; background: #FFF8E6; border: 1px solid #F2D9A0; border-radius: 14px;
          padding: 14px; margin-bottom: 14px; font-size: 14.5px; }

        .cn-input { width: 100%; max-width: 600px; margin: 0 auto; display: flex; align-items: center; gap: 8px;
          background: #fff; border: 1px solid oklch(0.88 0.01 258); border-radius: 14px; padding: 5px 5px 5px 14px;
          box-shadow: 0 2px 10px oklch(0.4 0.05 258 / 0.06); }
        .cn-input input { flex: 1; min-width: 0; border: none; outline: none; font-size: 16px; padding: 10px 0;
          color: oklch(0.22 0.03 258); background: transparent; }
        .cn-input button, .cn-btn { background: oklch(0.5 0.15 258); color: #fff; border: none; border-radius: 10px;
          padding: 12px 16px; font-size: 15px; font-weight: 600; cursor: pointer; flex: none; }
        .cn-input button:disabled { opacity: 0.45; }
        .cn-btn.ghost { background: #fff; color: #333; border: 1px solid #ddd; }

        .cn-suggestions { display: flex; flex-direction: column; gap: 8px; margin-top: 16px; width: 100%; max-width: 600px; }
        .cn-suggestions button { font-size: 14.5px; color: oklch(0.4 0.1 258); background: oklch(0.96 0.015 258);
          border: 1px solid oklch(0.88 0.03 258); border-radius: 12px; padding: 12px 14px; cursor: pointer; text-align: left; }

        .cn-thread { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 16px 0; }
        .cn-thread-inner { max-width: 720px; margin: 0 auto; display: flex; flex-direction: column; gap: 18px; padding: 0 12px; }
        .cn-msg { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
        .cn-msg.user { align-items: flex-end; }
        .cn-who { font-size: 11.5px; color: oklch(0.55 0.02 258); padding: 0 4px; }
        .cn-bubble { font-size: 15px; line-height: 1.55; max-width: 88%; }
        .cn-bubble.user { background: oklch(0.5 0.15 258); color: #fff; padding: 11px 15px; border-radius: 16px 16px 4px 16px; }
        .cn-bubble.bot { background: #fff; border: 1px solid oklch(0.9 0.01 258); padding: 14px 16px; border-radius: 4px 16px 16px 16px;
          color: oklch(0.26 0.03 258); box-shadow: 0 1px 4px oklch(0.4 0.05 258 / 0.05); }
        .cn-bubble.bot.route { width: 100%; max-width: 100%; padding: 14px 12px; }

        .cn-footer { flex: none; padding: 10px 12px calc(10px + env(safe-area-inset-bottom)); background: #fff;
          border-top: 1px solid oklch(0.9 0.01 258); }

        @media (min-width: 720px) {
          .cn-header { padding-left: 28px; padding-right: 28px; }
          .cn-logo { height: 60px; }
          .cn-welcome h1 { font-size: 24px; }
          .cn-suggestions { flex-direction: row; flex-wrap: wrap; justify-content: center; }
          .cn-suggestions button { border-radius: 20px; padding: 8px 14px; font-size: 13.5px; }
          .cn-thread { padding: 24px 0; }
          .cn-thread-inner { padding: 0 24px; gap: 22px; }
          .cn-bubble.bot.route { padding: 16px 18px; }
          .cn-footer { padding-left: 24px; padding-right: 24px; }
        }

        .dot { width:7px; height:7px; border-radius:50%; background: oklch(0.6 0.1 258); animation: dotPulse 1.2s ease-in-out infinite; display:inline-block; }
        @keyframes dotPulse { 0%,80%,100% { opacity:.25; transform:translateY(0); } 40% { opacity:1; transform:translateY(-3px); } }
      `}</style>
    </div>
  );
}
