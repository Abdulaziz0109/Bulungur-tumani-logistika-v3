import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, onSnapshot } from 'firebase/firestore';
import {
  Check,
  Copy,
  ExternalLink,
  LocateFixed,
  Map as MapIcon,
  Mic,
  MicOff,
  Navigation,
  Search,
  Smartphone,
  X,
  Zap,
} from 'lucide-react';
import { db } from '../lib/firebase';
import { Location } from '../types';
import {
  buildGoogleMapsUrl,
  buildYandexMapsUrl,
  haversineDistanceKm,
  parseMultiQueryLocations,
  smartSearchLocations,
  sortLocationsNearestFirst,
} from '../utils/navigationHelpers';
import { usePWAInstall } from '../hooks/usePWAInstall';

const BULUNGUR_CENTER: [number, number] = [39.7647, 67.2714];

function buildMiniMapTileUrl(lat: number, lng: number, zoom = 14): string {
  const latRad = (lat * Math.PI) / 180;
  const n = Math.pow(2, zoom);
  const x = Math.floor(((lng + 180) / 360) * n);
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );
  return `https://mt1.google.com/vt/lyrs=m&x=${x}&y=${y}&z=${zoom}&hl=uz`;
}

export default function WidgetPage() {
  const navigate = useNavigate();
  const { isInstallable, isInstalled, install } = usePWAInstall();

  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [userLocation, setUserLocation] = useState<[number, number] | null>(null);
  const [gpsStatus, setGpsStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [query, setQuery] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'maktab' | 'dmtt'>('all');
  const [isListening, setIsListening] = useState(false);
  const [showPinGuide, setShowPinGuide] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [tileError, setTileError] = useState(false);
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, 'locations'),
      (snap) => {
        const list: Location[] = [];
        snap.forEach((docSnap) => {
          const data = docSnap.data();
          if (typeof data.lat === 'number' && typeof data.lng === 'number') {
            list.push({ id: docSnap.id, ...(data as Omit<Location, 'id'>) });
          }
        });
        setLocations(list);
        setLoading(false);
      },
      () => {
        setLoading(false);
      }
    );
    return () => unsub();
  }, []);

  const requestGps = () => {
    if (!navigator.geolocation) {
      setGpsStatus('error');
      return;
    }
    setGpsStatus('loading');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setUserLocation([pos.coords.latitude, pos.coords.longitude]);
        setGpsStatus('ready');
      },
      () => {
        setGpsStatus('error');
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
    );
  };

  useEffect(() => {
    requestGps();
  }, []);

  const refLat = userLocation ? userLocation[0] : BULUNGUR_CENTER[0];
  const refLng = userLocation ? userLocation[1] : BULUNGUR_CENTER[1];

  const pool = useMemo(() => {
    return locations.filter((l) => {
      if (filterType === 'maktab') return l.type === 'maktab';
      if (filterType === 'dmtt') return l.type === 'dmtt' || l.type === 'bogcha';
      return true;
    });
  }, [locations, filterType]);

  const multiMatches = useMemo(() => {
    if (!query.trim()) return [];
    return parseMultiQueryLocations(locations, query, userLocation || BULUNGUR_CENTER);
  }, [locations, query, userLocation]);

  const displayItems = useMemo(() => {
    if (query.trim()) {
      return smartSearchLocations(pool, query, userLocation || BULUNGUR_CENTER, 6).map((loc) => ({
        ...loc,
        distKm: loc.distanceKm ?? haversineDistanceKm(refLat, refLng, loc.lat, loc.lng),
      }));
    }
    return [...pool]
      .map((loc) => ({
        ...loc,
        distKm: haversineDistanceKm(refLat, refLng, loc.lat, loc.lng),
      }))
      .sort((a, b) => a.distKm - b.distKm)
      .slice(0, 5);
  }, [pool, query, userLocation, refLat, refLng]);

  const nearestItem = displayItems[0] || null;
  const miniMapTarget: [number, number] = nearestItem
    ? [nearestItem.lat, nearestItem.lng]
    : [refLat, refLng];
  const miniMapTileUrl = buildMiniMapTileUrl(miniMapTarget[0], miniMapTarget[1], 14);

  const counts = useMemo(() => {
    let maktab = 0;
    let dmtt = 0;
    for (const l of locations) {
      if (l.type === 'maktab') maktab++;
      else if (l.type === 'dmtt' || l.type === 'bogcha') dmtt++;
    }
    return { total: locations.length, maktab, dmtt };
  }, [locations]);

  const handleVoice = () => {
    if (isListening && recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // ignore
      }
      setIsListening(false);
      return;
    }
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) return;
    try {
      const rec = new SpeechRecognition();
      rec.lang = 'uz-UZ';
      rec.interimResults = false;
      rec.onstart = () => setIsListening(true);
      rec.onresult = (ev: any) => {
        const txt = ev?.results?.[0]?.[0]?.transcript || '';
        if (txt) setQuery(txt);
      };
      rec.onerror = () => setIsListening(false);
      rec.onend = () => setIsListening(false);
      recognitionRef.current = rec;
      rec.start();
    } catch {
      setIsListening(false);
    }
  };

  const widgetUrl =
    typeof window !== 'undefined' ? `${window.location.origin}/widget` : '/widget';

  const handleCopyWidgetUrl = async () => {
    try {
      await navigator.clipboard.writeText(widgetUrl);
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 2200);
    } catch {
      setCopiedUrl(false);
    }
  };

  const orderedMulti = useMemo(() => {
    if (multiMatches.length < 2) return [];
    return sortLocationsNearestFirst(multiMatches, refLat, refLng);
  }, [multiMatches, refLat, refLng]);

  const top5PoolRoute = useMemo(() => {
    if (pool.length === 0) return [];
    return sortLocationsNearestFirst(pool, refLat, refLng).slice(0, 5);
  }, [pool, refLat, refLng]);

  return (
    <div className="min-h-screen w-full bg-gradient-to-br from-[#0f172a] via-[#172554] to-[#0b132b] text-white flex flex-col items-center justify-center p-3 sm:p-5">
      {/* Meteum-inspired Glass Widget Card */}
      <div className="w-full max-w-[430px] rounded-[28px] bg-gradient-to-b from-[#233966]/95 via-[#1c2e54]/95 to-[#162442]/98 border border-white/15 shadow-[0_24px_60px_rgba(0,0,0,0.55)] overflow-hidden backdrop-blur-xl">
        {/* Top Meteum-style Split Header: Left Location/Hero Stat + Right Mini-Map */}
        <div className="p-4 pb-3 flex items-stretch justify-between gap-3">
          <div className="flex-1 min-w-0 flex flex-col justify-between">
            <div>
              <div className="flex items-center gap-1.5">
                <span className="text-[13px] font-bold text-white/95 truncate">
                  Bulung&apos;ur MMTB
                </span>
                <button
                  type="button"
                  onClick={requestGps}
                  aria-label="GPS joylashuvni yangilash"
                  title={userLocation ? 'GPS faol — yangilash' : 'GPS joylashuvni aniqlash'}
                  className={`w-6 h-6 rounded-full flex items-center justify-center transition-colors cursor-pointer shrink-0 ${
                    userLocation
                      ? 'bg-emerald-400/20 text-emerald-300'
                      : gpsStatus === 'loading'
                      ? 'bg-sky-400/25 text-sky-300 animate-pulse'
                      : 'bg-white/10 text-white/75 hover:bg-white/20'
                  }`}
                >
                  <LocateFixed className="w-3.5 h-3.5" />
                </button>
              </div>
              <p className="text-[11px] text-sky-200/80 font-medium mt-0.5 truncate">
                {userLocation
                  ? "Joylashuvingiz bo'yicha yaqinlar"
                  : "Tuman markazi bo'yicha (GPS kutilmoqda)"}
              </p>
            </div>

            {/* Big Hero Metric (echoing Meteum's 8° focal point) */}
            <div className="mt-2.5 flex items-baseline gap-2.5">
              <div className="text-[34px] leading-none font-extrabold tracking-tight text-white">
                {nearestItem ? `${nearestItem.distKm.toFixed(1)}` : counts.total}
                <span className="text-base font-bold text-sky-300 ml-1">
                  {nearestItem ? 'km' : 'ta'}
                </span>
              </div>
              <div className="min-w-0">
                <p className="text-xs font-bold text-white leading-tight truncate">
                  {nearestItem ? nearestItem.name : "Yuklanmoqda..."}
                </p>
                <p className="text-[10px] text-slate-300/85 font-semibold mt-0.5">
                  {counts.maktab} maktab · {counts.dmtt} bog&apos;cha
                </p>
              </div>
            </div>
          </div>

          {/* Right Mini-Map Tile (Meteum Weather top-right map card style) */}
          <button
            type="button"
            onClick={() => navigate('/')}
            aria-label="To'liq xaritani ochish"
            title="To'liq xaritani ochish"
            className="relative w-[108px] h-[112px] rounded-2xl overflow-hidden border border-white/20 bg-slate-800 shrink-0 group cursor-pointer shadow-lg"
          >
            {!tileError ? (
              <img
                src={miniMapTileUrl}
                alt="Bulung'ur xarita ko'rinishi"
                className="w-full h-full object-cover opacity-90 group-hover:scale-105 transition-transform duration-300"
                onError={() => setTileError(true)}
              />
            ) : (
              <div className="w-full h-full bg-gradient-to-br from-sky-900 to-indigo-950 flex items-center justify-center">
                <MapIcon className="w-7 h-7 text-sky-300/70" />
              </div>
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-slate-950/75 via-transparent to-transparent" />
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <span className="w-4 h-4 rounded-full bg-sky-400/35 flex items-center justify-center">
                <span className="w-2.5 h-2.5 rounded-full bg-sky-400 border-2 border-white shadow" />
              </span>
            </div>
            <span className="absolute bottom-1.5 left-1.5 right-1.5 text-[10px] font-extrabold text-white flex items-center justify-center gap-1 bg-slate-950/60 backdrop-blur-sm rounded-lg py-0.5">
              <MapIcon className="w-3 h-3 text-sky-300" />
              <span>Xarita</span>
            </span>
          </button>
        </div>

        {/* Compact Search Bar + Type Filter Strip */}
        <div className="px-4 pb-3 space-y-2">
          <div className="flex items-center gap-1.5 bg-white/10 border border-white/15 rounded-2xl pl-3 pr-1.5 min-h-[42px] focus-within:border-sky-400/70 focus-within:bg-white/15 transition-colors">
            <Search className="w-4 h-4 text-sky-200/80 shrink-0" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Qidiruv: 9 bog'cha, 4 maktab..."
              aria-label="Maktab yoki bog'cha qidirish"
              className="flex-1 bg-transparent outline-none text-sm font-semibold text-white placeholder:text-slate-300/70 min-h-[38px]"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Qidiruvni tozalash"
                className="w-8 h-8 rounded-xl flex items-center justify-center text-slate-300 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            )}
            <button
              type="button"
              onClick={handleVoice}
              aria-label="Ovozli qidiruv"
              className={`w-8 h-8 rounded-xl flex items-center justify-center cursor-pointer transition-colors ${
                isListening
                  ? 'bg-rose-500 text-white animate-pulse'
                  : 'text-sky-300 hover:bg-white/10'
              }`}
            >
              {isListening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            </button>
          </div>

          {/* Multi-stop instant bar */}
          {orderedMulti.length >= 2 && (
            <div className="p-2.5 rounded-2xl bg-emerald-400/15 border border-emerald-400/35 space-y-2">
              <div className="flex items-center gap-1 flex-wrap">
                <span className="text-[10px] font-extrabold text-emerald-300 uppercase">
                  {orderedMulti.length} ta manzil:
                </span>
                {orderedMulti.map((m, idx) => (
                  <span
                    key={m.id}
                    className="text-[11px] font-bold bg-slate-950/50 text-white px-2 py-0.5 rounded-lg"
                  >
                    {idx + 1}. {m.name}
                  </span>
                ))}
              </div>
              <div className="flex items-center gap-1.5">
                <a
                  href={buildYandexMapsUrl(orderedMulti, userLocation, true)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 min-h-[36px] rounded-xl bg-orange-500 hover:bg-orange-600 text-white font-extrabold text-xs flex items-center justify-center gap-1 no-underline"
                >
                  <Navigation className="w-3.5 h-3.5" />
                  <span>Yandex marshrut</span>
                </a>
                <a
                  href={buildGoogleMapsUrl(orderedMulti, userLocation, true)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 min-h-[36px] rounded-xl bg-sky-500 hover:bg-sky-600 text-white font-extrabold text-xs flex items-center justify-center gap-1 no-underline"
                >
                  <span>Google</span>
                </a>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between gap-2">
            <div className="flex gap-1 bg-slate-950/35 p-1 rounded-xl flex-1 border border-white/10">
              {(
                [
                  { id: 'all', label: 'Barchasi' },
                  { id: 'maktab', label: 'Maktab' },
                  { id: 'dmtt', label: "Bog'cha" },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setFilterType(tab.id)}
                  className={`flex-1 min-h-[32px] rounded-lg text-[11px] font-extrabold transition-colors cursor-pointer ${
                    filterType === tab.id
                      ? 'bg-sky-500 text-white shadow'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {top5PoolRoute.length >= 2 && (
              <a
                href={buildYandexMapsUrl(top5PoolRoute, userLocation, true)}
                target="_blank"
                rel="noopener noreferrer"
                className="min-h-[36px] px-2.5 rounded-xl bg-amber-400/20 hover:bg-amber-400/30 border border-amber-300/35 text-amber-200 text-[11px] font-extrabold flex items-center gap-1 shrink-0 no-underline"
                title="Eng yaqin 5 ta muassasaga Yandex marshrut"
              >
                <Zap className="w-3.5 h-3.5 text-amber-300" />
                <span>Yaqin 5</span>
              </a>
            )}
          </div>
        </div>

        {/* Meteum-style Divider Forecast-Like Rows */}
        <div className="border-t border-white/12 divide-y divide-white/10">
          {loading ? (
            <div className="px-4 py-6 text-center text-xs text-slate-300 font-semibold">
              Manzillar yuklanmoqda...
            </div>
          ) : displayItems.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-slate-300 font-semibold">
              Mos muassasa topilmadi
            </div>
          ) : (
            displayItems.map((loc) => (
              <div
                key={loc.id}
                className="px-4 py-2.5 flex items-center justify-between gap-2 hover:bg-white/5 transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${
                        loc.type === 'maktab'
                          ? 'bg-sky-400'
                          : loc.type === 'dmtt' || loc.type === 'bogcha'
                          ? 'bg-rose-400'
                          : 'bg-emerald-400'
                      }`}
                    />
                    <span className="text-[13px] font-bold text-white truncate">
                      {loc.name}
                    </span>
                  </div>
                  {loc.mahalla && (
                    <p className="text-[10px] text-slate-300/80 truncate pl-3.5 mt-0.5">
                      {loc.mahalla}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <span className="text-xs font-extrabold text-sky-200 tabular-nums mr-1">
                    {loc.distKm.toFixed(1)} km
                  </span>
                  <a
                    href={buildYandexMapsUrl([loc], userLocation, true)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-h-[34px] px-2.5 rounded-xl bg-orange-500 hover:bg-orange-600 text-white font-extrabold text-[11px] flex items-center justify-center no-underline active:scale-95"
                  >
                    Yandex
                  </a>
                  <a
                    href={buildGoogleMapsUrl([loc], userLocation, true)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-h-[34px] px-2.5 rounded-xl bg-sky-500 hover:bg-sky-600 text-white font-extrabold text-[11px] flex items-center justify-center no-underline active:scale-95"
                  >
                    Google
                  </a>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer Actions: Pin to Android Home Screen + Open Full Map */}
        <div className="px-4 py-3 bg-slate-950/35 border-t border-white/10 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setShowPinGuide((v) => !v)}
            className="min-h-[36px] px-3 rounded-xl bg-white/10 hover:bg-white/15 border border-white/15 text-sky-200 text-[11px] font-bold flex items-center gap-1.5 cursor-pointer"
          >
            <Smartphone className="w-3.5 h-3.5 shrink-0" />
            <span>Bosh ekranga vidjet qilib qo&apos;yish</span>
          </button>

          <button
            type="button"
            onClick={() => navigate('/')}
            className="min-h-[36px] px-3 rounded-xl bg-sky-500 hover:bg-sky-600 text-white text-[11px] font-extrabold flex items-center gap-1 shrink-0 cursor-pointer"
          >
            <span>To&apos;liq xarita</span>
            <ExternalLink className="w-3 h-3" />
          </button>
        </div>

        {/* Android Home Screen Setup Guide Drawer */}
        {showPinGuide && (
          <div className="px-4 pb-4 pt-2 bg-slate-950/60 border-t border-white/10 space-y-2.5 text-xs text-slate-200 leading-relaxed">
            <p className="font-extrabold text-white text-[12px]">
              Samsung / Android bosh ekraniga Meteum kabi vidjet chiqarish:
            </p>
            <p className="text-[11px] text-slate-300">
              Veb-saytlar Android tizimining <strong>&quot;Vidjetlar&quot;</strong> ro&apos;yxatiga avtomatik qo&apos;shila olmaydi (tizim faqat o&apos;rnatilgan ilovalarga ruxsat beradi). Lekin ushbu maxsus <code>/widget</code> sahifasini 2 usulda darhol bosh ekranga chiqarishingiz mumkin:
            </p>
            <div className="space-y-1.5 text-[11px] bg-white/5 rounded-2xl p-3 border border-white/10">
              <p>
                <strong>1-usul (Xuddi Meteum kabi jonli vidjet):</strong> Play Marketdan bepul <strong>Web Widget</strong> yoki <strong>Hermit</strong> ilovasini o&apos;rnating → Samsung ekranidan <em>Vidjetlar</em> orqali qo&apos;shing → manzil qismiga pastdagi <strong>Vidjet havolasini</strong> joylang.
              </p>
              <p>
                <strong>2-usul (Ilova yorlig&apos;i):</strong> Chrome menyusidan <em>&quot;Bosh ekranga qo&apos;shish&quot;</em> ni bosing — ikonkani bosib turganda <strong>Tezkor Widget</strong> darhol ochiladi.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleCopyWidgetUrl}
                className="flex-1 min-h-[38px] px-3 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-slate-950 font-extrabold text-xs flex items-center justify-center gap-1.5 cursor-pointer"
              >
                {copiedUrl ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                <span>{copiedUrl ? 'Havola nusxalandi!' : 'Vidjet havolasini nusxalash'}</span>
              </button>
              {isInstallable && !isInstalled && (
                <button
                  type="button"
                  onClick={install}
                  className="min-h-[38px] px-3 rounded-xl bg-sky-500 hover:bg-sky-600 text-white font-extrabold text-xs shrink-0 cursor-pointer"
                >
                  O&apos;rnatish
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
