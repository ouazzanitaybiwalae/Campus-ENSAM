import React, { useState, useRef, useEffect } from 'react';
import LiveRoute from './src/LiveNavigation.jsx';

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
    next: 'Suivant',
    prev: 'Précédent',
    step: 'Étape',
    remaining: 'restants',
    arrived: 'Vous êtes arrivé à destination 🎉',
    recenter: 'Recentrer',
    autoSteps: 'Suivi par pas (bêta)',
    demo: 'Démo',
    allSteps: 'Toutes les étapes',
    hideSteps: 'Masquer les étapes',
    stairsUp: (b, f) => `Montez l'escalier de ${b} jusqu'à : ${f}`,
    stairsDown: (b, f) => `Descendez l'escalier de ${b} jusqu'à : ${f}`,
    motionDenied: "Capteurs de mouvement refusés. Utilisez le bouton « Suivant » pour avancer.",
    motionNone: "Aucun capteur de mouvement détecté sur cet appareil. Utilisez « Suivant » pour avancer.",
    gpsDenied: "Position GPS indisponible. Autorisez la localisation ou utilisez « Suivant ».",
    gpsLocating: 'Localisation GPS en cours…',
    gpsWeak: (acc) => `Signal GPS faible (±${Math.round(acc)} m)`,
    gpsOff: 'Vous semblez hors de l’itinéraire.',
    gpsRerouting: 'Vous êtes hors itinéraire. Recalcul en cours…',
    resync: 'Je suis perdu / Je suis ici',
    resyncPlaceholder: 'ex. Je suis devant la salle B5',
    resyncSubmit: 'Recalculer',
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
    next: 'Next',
    prev: 'Back',
    step: 'Step',
    remaining: 'left',
    arrived: 'You have arrived 🎉',
    recenter: 'Re-center',
    autoSteps: 'Step tracking (beta)',
    demo: 'Demo',
    allSteps: 'All steps',
    hideSteps: 'Hide steps',
    stairsUp: (b, f) => `Take the stairs in ${b} up to: ${f}`,
    stairsDown: (b, f) => `Take the stairs in ${b} down to: ${f}`,
    motionDenied: 'Motion sensors were denied. Use the "Next" button to move forward.',
    motionNone: 'No motion sensor detected on this device. Use "Next" to move forward.',
    gpsDenied: 'GPS location is unavailable. Allow location access or use "Next".',
    gpsLocating: 'Locating you with GPS…',
    gpsWeak: (acc) => `Weak GPS signal (±${Math.round(acc)} m)`,
    gpsOff: 'You seem to be off the route.',
    gpsRerouting: 'You are off route. Recalculating…',
    resync: 'I am lost / I am here',
    resyncPlaceholder: 'e.g. I am in front of room B5',
    resyncSubmit: 'Recalculate',
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
async function resolveRoute(text, startNode, lang, routeOptions = {}) {
  if (!startNode) return { error: 'no_start' };
  try {
    const res = await fetch('/api/navigate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, startNode, lang, ...routeOptions }),
    });
    if (!res.ok) return { error: 'server' };
    const data = await res.json();
    if (data.error) return { error: data.code || 'not_found' };
    return {
      route: {
        destination: data.destinationName || 'destination',
        destinationNode: data.destinationNode,
        path: data.path,
        pathMeta: data.pathMeta,
        edgeMeters: data.edgeMeters,
        edgeTypes: data.edgeTypes || [],
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
  const lastGpsRerouteRef = useRef(null);
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

  async function sendMessage(overrideText, routeOptions = {}) {
    const text = (overrideText ?? inputValue).trim();
    if (!text && !routeOptions.destinationNode) return;

    const userMsg = { role: 'user', text, id: Date.now() };
    const pendingId = Date.now() + 1;
    const pendingMsg = { role: 'assistant', pending: true, id: pendingId };

    setMessages((m) => [...m, ...(text ? [userMsg] : []), pendingMsg]);
    if (text) setInputValue('');
    setResume(null);

    // start from where the user is NOW (not from the original QR code)
    const from = routeOptions.startNode || positionRef.current || startNode;
    const result = await resolveRoute(text, from, lang, routeOptions);

    if (result.route) {
      positionRef.current = result.route.path[0];
      if (!routeOptions.destinationNode) lastGpsRerouteRef.current = null;
      const previous = routeOptions.destinationNode ? loadLastRoute() : null;
      saveLastRoute({
        text: previous?.text || text,
        destination: result.route.destination,
        destinationNode: result.route.destinationNode,
      });
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
    return result;
  }

  function useSuggestion(s) {
    setInputValue(s);
    sendMessage(s);
  }

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100%', fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif", background: '#f4f7fb', color: 'oklch(0.24 0.03 255)', overflow: 'hidden' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, background: '#f4f7fb' }}>
        
        {/* Language Bar */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '10px 20px', background: '#fff', borderBottom: '1px solid oklch(0.9 0.01 258)', gap: 8 }}>
          <button onClick={() => setLang('fr')} style={{ background: lang === 'fr' ? 'oklch(0.5 0.15 258)' : '#e8edf5', color: lang === 'fr' ? '#fff' : '#333', border: 'none', borderRadius: 6, padding: '4px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>FR</button>
          <button onClick={() => setLang('en')} style={{ background: lang === 'en' ? 'oklch(0.5 0.15 258)' : '#e8edf5', color: lang === 'en' ? '#fff' : '#333', border: 'none', borderRadius: 6, padding: '4px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>EN</button>
        </div>

        {!hasMessages && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '0 24px', textAlign: 'center' }}>
            <div style={{ width: 64, height: 64, borderRadius: 16, background: 'linear-gradient(135deg, oklch(0.62 0.14 250), oklch(0.48 0.15 260))', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 24, color: '#fff', boxShadow: '0 8px 24px oklch(0.5 0.14 258 / 0.25)', marginBottom: 20 }}>EC</div>
            <div style={{ fontSize: 22, fontWeight: 600, color: 'oklch(0.22 0.03 258)', marginBottom: 6 }}>{t.title}</div>
            <div style={{ fontSize: 14.5, color: 'oklch(0.48 0.02 258)', maxWidth: 420, lineHeight: 1.5, marginBottom: 28 }}>{t.subtitle}</div>

            {startNode && (
              <div style={{ fontSize: 11, color: '#666', padding: '4px 8px', background: '#e8edf5', borderRadius: 6, marginBottom: 12 }}>
                {t.startPoint} <strong>{startNode}</strong>
              </div>
            )}

            {resume && startNode && (
              <div style={{ background: '#FFF8E6', border: '1px solid #F2D9A0', borderRadius: 12, padding: '12px 14px', marginBottom: 14, maxWidth: 600, fontSize: 14 }}>
                <div style={{ marginBottom: 10, fontWeight: 600 }}>{t.resumeTitle(resume.destination)}</div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                  <button
                    onClick={() =>
                      sendMessage(
                        resume.text,
                        resume.destinationNode ? { destinationNode: resume.destinationNode } : {}
                      )
                    }
                    style={{ background: 'oklch(0.5 0.15 258)', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px', fontWeight: 600, cursor: 'pointer' }}
                  >
                    {t.resumeYes}
                  </button>
                  <button onClick={() => { clearLastRoute(); setResume(null); }} style={{ background: '#fff', border: '1px solid #ddd', borderRadius: 8, padding: '8px 16px', fontWeight: 600, cursor: 'pointer' }}>{t.resumeNo}</button>
                </div>
              </div>
            )}

            <div style={{ width: '100%', maxWidth: 600, display: 'flex', alignItems: 'center', gap: 10, background: '#fff', border: '1px solid oklch(0.88 0.01 258)', borderRadius: 14, padding: '6px 6px 6px 18px', boxShadow: '0 2px 10px oklch(0.4 0.05 258 / 0.06)' }}>
              <input
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
                placeholder={t.placeholder}
                style={{ flex: 1, border: 'none', outline: 'none', fontSize: 14.5, padding: '10px 0', color: 'oklch(0.22 0.03 258)', background: 'transparent' }}
              />
              <button onClick={() => sendMessage()} style={{ background: 'oklch(0.5 0.15 258)', color: '#fff', border: 'none', borderRadius: 10, padding: '11px 18px', fontSize: 13.5, fontWeight: 600, cursor: 'pointer', flex: 'none' }}>{t.send}</button>
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap', justifyContent: 'center', maxWidth: 600 }}>
              {t.suggestions.map((s) => (
                <div key={s} onClick={() => useSuggestion(s)} style={{ fontSize: 13, color: 'oklch(0.4 0.1 258)', background: 'oklch(0.94 0.02 258)', border: '1px solid oklch(0.88 0.03 258)', borderRadius: 20, padding: '7px 14px', cursor: 'pointer' }}>{s}</div>
              ))}
            </div>
          </div>
        )}

        {hasMessages && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 28px', borderBottom: '1px solid oklch(0.9 0.01 258)', background: '#fff', flex: 'none' }}>
              <div style={{ width: 32, height: 32, borderRadius: 9, background: 'linear-gradient(135deg, oklch(0.62 0.14 250), oklch(0.48 0.15 260))', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 13, color: '#fff' }}>EC</div>
              <div style={{ fontSize: 14.5, fontWeight: 600 }}>{t.title}</div>
              <div style={{ fontSize: 12, color: 'oklch(0.55 0.1 150)', background: 'oklch(0.94 0.05 150)', padding: '3px 9px', borderRadius: 20, marginLeft: 6 }}>{t.online}</div>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: '28px 0' }}>
              <div style={{ maxWidth: 720, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 22, padding: '0 28px' }}>
                {messages.map((msg) => (
                  <div key={msg.id} style={{ display: 'flex', flexDirection: 'column', alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start', gap: 8 }}>
                    <div style={{ fontSize: 11.5, color: 'oklch(0.55 0.02 258)', padding: '0 4px' }}>{msg.role === 'user' ? t.user : t.bot}</div>

                    {msg.role === 'user' && (
                      <div style={{ background: 'oklch(0.5 0.15 258)', color: '#fff', padding: '12px 16px', borderRadius: '16px 16px 4px 16px', fontSize: 14.5, lineHeight: 1.5, maxWidth: 480 }}>{msg.text}</div>
                    )}

                    {msg.role === 'assistant' && (
                      <div style={{ background: '#fff', border: '1px solid oklch(0.9 0.01 258)', padding: '16px 18px', borderRadius: '4px 16px 16px 16px', fontSize: 14.5, lineHeight: 1.6, maxWidth: msg.mapData ? 720 : 560, width: msg.mapData ? '100%' : undefined, boxSizing: 'border-box', color: 'oklch(0.26 0.03 258)', boxShadow: '0 1px 4px oklch(0.4 0.05 258 / 0.05)' }}>
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
                            onResync={(locationText, destinationNode) =>
                              sendMessage(locationText, { startText: locationText, destinationNode })
                            }
                            onReroute={({ lat, lon, destinationNode }) => {
                              const previous = lastGpsRerouteRef.current;
                              if (previous) {
                                const distance = Math.hypot(
                                  (lat - previous.lat) * 110540,
                                  (lon - previous.lon) * 111320 * Math.cos((lat * Math.PI) / 180)
                                );
                                if (distance < 30) return;
                              }
                              lastGpsRerouteRef.current = { lat, lon };
                              return sendMessage('', {
                                startNode: positionRef.current || startNode,
                                startLat: lat,
                                startLon: lon,
                                destinationNode,
                              }).then((result) => {
                                if (!result.route) lastGpsRerouteRef.current = null;
                              });
                            }}
                          />
                        )}

                        {msg.mapData && msg.id !== activeRouteId && (
                          <>
                            <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 8 }}>{t.routeTo} {msg.mapData.destination}</div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                              {msg.mapData.steps.map((step, i) => (
                                <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                                  <div style={{ width: 20, height: 20, borderRadius: '50%', background: 'oklch(0.94 0.03 258)', color: 'oklch(0.45 0.13 258)', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', marginTop: 1 }}>{i + 1}</div>
                                  <div style={{ fontSize: 14, lineHeight: 1.5 }}>{step}</div>
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
            </div>

            <div style={{ padding: '16px 28px 22px', flex: 'none' }}>
              <div style={{ maxWidth: 900, margin: '0 auto', display: 'flex', alignItems: 'center', gap: 10, background: '#fff', border: '1px solid oklch(0.88 0.01 258)', borderRadius: 14, padding: '6px 6px 6px 18px', boxShadow: '0 2px 10px oklch(0.4 0.05 258 / 0.06)' }}>
                <input
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
                  placeholder={t.placeholder}
                  style={{ flex: 1, border: 'none', outline: 'none', fontSize: 14.5, padding: '10px 0', color: 'oklch(0.22 0.03 258)', background: 'transparent' }}
                />
                <button onClick={() => sendMessage()} style={{ background: 'oklch(0.5 0.15 258)', color: '#fff', border: 'none', borderRadius: 10, padding: '11px 18px', fontSize: 13.5, fontWeight: 600, cursor: 'pointer', flex: 'none' }}>{t.send}</button>
              </div>
            </div>
          </>
        )}
      </div>

      <style>{`
        .dot { width:7px; height:7px; border-radius:50%; background: oklch(0.6 0.1 258); animation: dotPulse 1.2s ease-in-out infinite; display:inline-block; }
        @keyframes dotPulse { 0%,80%,100% { opacity:.25; transform:translateY(0); } 40% { opacity:1; transform:translateY(-3px); } }
      `}</style>
    </div>
  );
}
