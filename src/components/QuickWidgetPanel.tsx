import React, { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import {
  Search,
  Mic,
  MicOff,
  LocateFixed,
  SlidersHorizontal,
  X,
  Zap,
  GripHorizontal,
  Map as MapIcon,
  Info,
  Check,
  Trash2,
  Navigation,
  Route,
  ExternalLink,
  Copy,
  Smartphone,
  RefreshCw
} from 'lucide-react';
import { Location } from '../types';
import {
  smartSearchLocations,
  parseMultiQueryLocations,
  sortLocationsNearestFirst,
  buildYandexMapsUrl,
  buildGoogleMapsUrl,
  haversineDistanceKm
} from '../utils/navigationHelpers';

interface WidgetPrefs {
  widthPercent: number;
  heightPx: number;
  position: 'top' | 'center' | 'bottom';
}

const DEFAULT_PREFS: WidgetPrefs = {
  widthPercent: 96,
  heightPx: 430,
  position: 'top'
};

interface QuickWidgetPanelProps {
  isOpen: boolean;
  onClose: () => void;
  locations: Location[];
  selectedLocations: Location[];
  userLocation: [number, number] | null;
  fallbackCenter: [number, number];
  onRequestGps: () => void;
  onToggleLocation: (loc: Location) => void;
  onSetSelectedLocations: (locs: Location[]) => void;
  onClearSelected: () => void;
  onBuildRouteFromGps: (locs: Location[], autoSort?: boolean) => void;
  onQuickNearestRoute: (pool: Location[]) => void;
  showToast: (msg: string, type?: 'success' | 'error' | 'info') => void;
}

export const QuickWidgetPanel: React.FC<QuickWidgetPanelProps> = ({
  isOpen,
  onClose,
  locations,
  selectedLocations,
  userLocation,
  fallbackCenter,
  onRequestGps,
  onToggleLocation,
  onSetSelectedLocations,
  onClearSelected,
  onBuildRouteFromGps,
  onQuickNearestRoute,
  showToast
}) => {
  const [prefs, setPrefs] = useState<WidgetPrefs>(() => {
    try {
      const saved = localStorage.getItem('mmtb_widget_prefs');
      return saved ? { ...DEFAULT_PREFS, ...JSON.parse(saved) } : DEFAULT_PREFS;
    } catch {
      return DEFAULT_PREFS;
    }
  });

  const [showControls, setShowControls] = useState(false);
  const [showAndroidNote, setShowAndroidNote] = useState(false);
  const [copiedWidgetUrl, setCopiedWidgetUrl] = useState(false);
  const [query, setQuery] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'maktab' | 'dmtt'>('all');
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<any>(null);
  const dragStartRef = useRef<{ y: number; startHeight: number } | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem('mmtb_widget_prefs', JSON.stringify(prefs));
    } catch {
      // ignore
    }
  }, [prefs]);

  useEffect(() => {
    if (isOpen && !userLocation && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        () => {
          onRequestGps();
        },
        () => {
          // silent fallback
        },
        { enableHighAccuracy: false, timeout: 6000, maximumAge: 60000 }
      );
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const refLat = userLocation ? userLocation[0] : fallbackCenter[0];
  const refLng = userLocation ? userLocation[1] : fallbackCenter[1];

  const cleanSelected = selectedLocations.filter((l) => !l.id.startsWith('gps-'));
  const selectedIdSet = new Set(cleanSelected.map((l) => l.id));

  const pool = locations.filter((l) => {
    if (filterType === 'maktab') return l.type === 'maktab';
    if (filterType === 'dmtt') return l.type === 'dmtt' || l.type === 'bogcha';
    return true;
  });

  const multiMatches = query.trim()
    ? parseMultiQueryLocations(locations, query, userLocation || fallbackCenter)
    : [];

  const displayItems = query.trim()
    ? smartSearchLocations(pool, query, userLocation || fallbackCenter, 8).map((loc) => ({
        ...loc,
        distKm: loc.distanceKm ?? haversineDistanceKm(refLat, refLng, loc.lat, loc.lng)
      }))
    : [...pool]
        .map((loc) => ({
          ...loc,
          distKm: haversineDistanceKm(refLat, refLng, loc.lat, loc.lng)
        }))
        .sort((a, b) => a.distKm - b.distKm)
        .slice(0, 8);

  const handleApplyMultiMatches = (sortNearest: boolean) => {
    if (multiMatches.length < 2) return;
    const nextStops = sortNearest
      ? sortLocationsNearestFirst(multiMatches, refLat, refLng)
      : multiMatches;
    onSetSelectedLocations(nextStops);
    if (!userLocation) onRequestGps();
    setQuery('');
    showToast(
      sortNearest
        ? `📍 Joylashuvingizdan ${nextStops.length} ta manzil eng yaqinidan tartiblandi`
        : `📍 Joylashuvingizdan ${nextStops.length} ta manzil marshrutga qo'yildi`,
      'success'
    );
  };

  const handleSortSelectedNearest = () => {
    if (cleanSelected.length < 2) return;
    const ordered = sortLocationsNearestFirst(cleanSelected, refLat, refLng);
    onSetSelectedLocations(ordered);
    if (!userLocation) onRequestGps();
    showToast("⚡ Joylashuvingizdan eng yaqin tartibga keltirildi!", 'success');
  };

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

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      showToast("Brauzeringizda ovozli qidiruv yo'q (Chrome/Android da ishlaydi)", 'info');
      return;
    }

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

  const handleResizePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragStartRef.current = { y: e.clientY, startHeight: prefs.heightPx };
  };

  const handleResizePointerMove = (e: React.PointerEvent) => {
    if (!dragStartRef.current) return;
    const delta = e.clientY - dragStartRef.current.y;
    const multiplier = prefs.position === 'bottom' ? -1 : 1;
    const nextHeight = Math.min(620, Math.max(240, Math.round(dragStartRef.current.startHeight + delta * multiplier)));
    setPrefs((prev) => ({ ...prev, heightPx: nextHeight }));
  };

  const handleResizePointerUp = () => {
    dragStartRef.current = null;
  };

  const alignClass =
    prefs.position === 'top'
      ? 'items-start pt-3'
      : prefs.position === 'bottom'
      ? 'items-end pb-3'
      : 'items-center';

  return (
    <div
      className={`print:hidden fixed inset-0 z-[980] bg-slate-950/45 backdrop-blur-[2px] flex justify-center px-2 ${alignClass}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="bg-slate-900 text-white rounded-3xl shadow-2xl border border-slate-700/80 flex flex-col overflow-hidden transition-[width] duration-150 max-w-[540px]"
        style={{
          width: `${prefs.widthPercent}%`,
          height: `${prefs.heightPx}px`
        }}
      >
        {/* Top drag handle for bottom-anchored widget */}
        {prefs.position === 'bottom' && (
          <div
            onPointerDown={handleResizePointerDown}
            onPointerMove={handleResizePointerMove}
            onPointerUp={handleResizePointerUp}
            onPointerCancel={handleResizePointerUp}
            className="h-5 bg-slate-800/80 border-b border-slate-700/70 flex items-center justify-center cursor-ns-resize touch-none shrink-0"
            title="Bo'yini o'zgartirish uchun yuqori-pastga torting"
          >
            <GripHorizontal className="w-5 h-4 text-slate-400" />
          </div>
        )}

        {/* Widget Header */}
        <div className="px-3.5 py-2.5 bg-slate-800/70 border-b border-slate-700/70 flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              onClick={onRequestGps}
              className={`min-h-[36px] px-2.5 rounded-xl text-[11px] font-extrabold flex items-center gap-1.5 cursor-pointer shrink-0 ${
                userLocation
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                  : 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
              }`}
              title="GPS joylashuvni yangilash"
            >
              <LocateFixed className="w-3.5 h-3.5 shrink-0" />
              <span>{userLocation ? 'GPS faol' : 'GPS olish'}</span>
            </button>
            <span className="font-extrabold text-xs text-slate-100 truncate">
              MMTB Tezkor Widget
            </span>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {(window as unknown as { AndroidBridge?: { checkForUpdate?: () => void } }).AndroidBridge?.checkForUpdate && (
              <button
                type="button"
                onClick={() => {
                  (window as unknown as { AndroidBridge?: { checkForUpdate?: () => void } }).AndroidBridge?.checkForUpdate?.();
                }}
                aria-label="Ilova yangilanishini tekshirish"
                className="min-h-[36px] px-2.5 rounded-xl bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-400/35 text-emerald-300 text-[11px] font-bold flex items-center gap-1 cursor-pointer transition-colors"
                title="Ilovaning yangi versiyasini tekshirish va o'rnatish"
              >
                <RefreshCw className="w-3.5 h-3.5 shrink-0" />
                <span className="hidden sm:inline">Yangilash</span>
              </button>
            )}
            <Link
              to="/widget"
              onClick={onClose}
              className="min-h-[36px] px-2.5 rounded-xl bg-sky-500/20 hover:bg-sky-500/30 border border-sky-400/35 text-sky-200 text-[11px] font-bold flex items-center gap-1 no-underline transition-colors"
              title="Alohida Meteum uslubidagi vidjet sahifasini ochish"
            >
              <ExternalLink className="w-3.5 h-3.5 shrink-0" />
              <span className="hidden sm:inline">Alohida</span>
            </Link>
            <button
              type="button"
              onClick={() => setShowAndroidNote((v) => !v)}
              className={`min-h-[36px] px-2.5 rounded-xl text-[11px] font-bold flex items-center gap-1 cursor-pointer transition-colors ${
                showAndroidNote
                  ? 'bg-emerald-500 text-slate-950'
                  : 'bg-slate-700/80 hover:bg-slate-700 text-slate-200'
              }`}
              title="Telefon bosh ekraniga Meteum kabi vidjet qo'shish"
            >
              <Smartphone className="w-3.5 h-3.5 shrink-0" />
              <span className="hidden sm:inline">Ekranga</span>
            </button>
            <button
              type="button"
              onClick={() => setShowControls((v) => !v)}
              aria-label="Widget hajmini moslash"
              className={`min-h-[36px] px-2.5 rounded-xl text-[11px] font-bold flex items-center gap-1 cursor-pointer transition-colors ${
                showControls
                  ? 'bg-sky-500 text-white'
                  : 'bg-slate-700/80 hover:bg-slate-700 text-slate-200'
              }`}
              title="Widget eni va bo'yini moslash"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Hajm</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Widgetni yopish va xaritaga qaytish"
              className="min-h-[36px] min-w-[36px] px-2 rounded-xl bg-slate-700/80 hover:bg-slate-600 text-slate-200 text-[11px] font-bold flex items-center justify-center gap-1 cursor-pointer"
              title="To'liq xaritaga qaytish"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Android Home Screen Widget Guide Drawer */}
        {showAndroidNote && (
          <div className="px-3.5 py-3 bg-[#172542] border-b border-sky-500/30 space-y-2 text-[11px] text-slate-200 shrink-0">
            <div className="flex items-start justify-between gap-2">
              <p className="font-extrabold text-sky-200">
                Samsung / Android bosh ekraniga Meteum kabi vidjet qo&apos;shish:
              </p>
              <button
                type="button"
                onClick={() => setShowAndroidNote(false)}
                aria-label="Qo'llanmani yopish"
                className="text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <p className="text-slate-300 leading-relaxed">
              Brauzer saytlari Androidning <strong>&quot;Vidjetlar&quot;</strong> ro&apos;yxatiga to&apos;g&apos;ridan-to&apos;g&apos;ri kira olmaydi (buning uchun alohida Android ilovasi kerak). Lekin maxsus <strong>/widget</strong> sahifamizni <strong>Web Widget</strong> yoki <strong>Hermit</strong> ilovasi orqali bosh ekranga xuddi Meteum vidjetidek joylashingiz mumkin:
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(`${window.location.origin}/widget`);
                    setCopiedWidgetUrl(true);
                    showToast("Vidjet havolasi (/widget) nusxalandi!", 'success');
                    setTimeout(() => setCopiedWidgetUrl(false), 2000);
                  } catch {
                    showToast("Havolani nusxalab bo'lmadi", 'error');
                  }
                }}
                className="flex-1 min-h-[34px] px-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-slate-950 font-extrabold text-[11px] flex items-center justify-center gap-1.5 cursor-pointer"
              >
                {copiedWidgetUrl ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedWidgetUrl ? 'Nusxalandi!' : '/widget havolasini nusxalash'}</span>
              </button>
              <Link
                to="/widget"
                onClick={onClose}
                className="min-h-[34px] px-3 rounded-xl bg-sky-500 hover:bg-sky-600 text-white font-extrabold text-[11px] flex items-center justify-center gap-1 no-underline shrink-0"
              >
                <span>Ochish</span>
                <ExternalLink className="w-3 h-3" />
              </Link>
            </div>
          </div>
        )}

        {/* Size & Layout Controls Drawer */}
        {showControls && (
          <div className="px-3.5 py-3 bg-slate-800/95 border-b border-slate-700 space-y-2.5 text-xs shrink-0 overflow-y-auto max-h-[230px]">
            <div className="flex items-center justify-between gap-2">
              <span className="font-bold text-slate-300">Eni: {prefs.widthPercent}%</span>
              <div className="flex gap-1">
                {[78, 90, 100].map((w) => (
                  <button
                    key={w}
                    type="button"
                    onClick={() => setPrefs((p) => ({ ...p, widthPercent: w }))}
                    className={`px-2 py-1 rounded-lg text-[10px] font-extrabold cursor-pointer ${
                      prefs.widthPercent === w ? 'bg-sky-500 text-white' : 'bg-slate-700 text-slate-300'
                    }`}
                  >
                    {w === 100 ? "To'liq" : `${w}%`}
                  </button>
                ))}
              </div>
            </div>
            <input
              type="range"
              min={65}
              max={100}
              value={prefs.widthPercent}
              onChange={(e) => setPrefs((p) => ({ ...p, widthPercent: Number(e.target.value) }))}
              className="w-full accent-sky-400 cursor-pointer"
            />

            <div className="flex items-center justify-between gap-2 pt-1">
              <span className="font-bold text-slate-300">Bo'yi: {prefs.heightPx}px</span>
              <div className="flex gap-1">
                {[
                  { label: 'Ixcham', h: 280 },
                  { label: "O'rta", h: 430 },
                  { label: 'Katta', h: 540 }
                ].map((preset) => (
                  <button
                    key={preset.h}
                    type="button"
                    onClick={() => setPrefs((p) => ({ ...p, heightPx: preset.h }))}
                    className={`px-2 py-1 rounded-lg text-[10px] font-extrabold cursor-pointer ${
                      prefs.heightPx === preset.h ? 'bg-sky-500 text-white' : 'bg-slate-700 text-slate-300'
                    }`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
            <input
              type="range"
              min={240}
              max={620}
              step={10}
              value={prefs.heightPx}
              onChange={(e) => setPrefs((p) => ({ ...p, heightPx: Number(e.target.value) }))}
              className="w-full accent-sky-400 cursor-pointer"
            />

            <div className="flex items-center justify-between gap-2 pt-1">
              <span className="font-bold text-slate-300">Ekrandagi joyi:</span>
              <div className="grid grid-cols-3 gap-1">
                {(['top', 'center', 'bottom'] as const).map((pos) => (
                  <button
                    key={pos}
                    type="button"
                    onClick={() => setPrefs((p) => ({ ...p, position: pos }))}
                    className={`px-2.5 py-1 rounded-lg text-[10px] font-extrabold cursor-pointer ${
                      prefs.position === pos ? 'bg-sky-500 text-white' : 'bg-slate-700 text-slate-300'
                    }`}
                  >
                    {pos === 'top' ? 'Yuqori' : pos === 'center' ? "O'rta" : 'Pastda'}
                  </button>
                ))}
              </div>
            </div>

            <button
              type="button"
              onClick={() => setShowAndroidNote((v) => !v)}
              className="w-full text-left text-[10px] text-sky-300 hover:text-sky-200 font-semibold flex items-center gap-1 pt-1 cursor-pointer"
            >
              <Info className="w-3.5 h-3.5 shrink-0" />
              <span>Telefon bosh ekraniga ob-havo vidjetidek qo'yish qo'llanmasi</span>
            </button>
          </div>
        )}

        {/* Search & Filters */}
        <div className="p-2.5 space-y-2 border-b border-slate-800 shrink-0">
          <div className="flex items-center gap-1.5 bg-slate-800 rounded-2xl border border-slate-700 pl-3 pr-1.5 min-h-[44px]">
            <Search className="w-4 h-4 text-slate-400 shrink-0" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Yozing: 9 bog'cha yoki 4 maktab, 9 bog'cha, 15"
              className="flex-1 min-h-[40px] bg-transparent outline-none text-sm font-semibold text-white placeholder:text-slate-400"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Qidiruvni tozalash"
                className="min-w-[36px] min-h-[36px] flex items-center justify-center text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            )}
            <button
              type="button"
              onClick={handleVoice}
              aria-label="Ovozli qidiruv"
              className={`min-w-[38px] min-h-[38px] rounded-xl flex items-center justify-center cursor-pointer ${
                isListening ? 'bg-rose-500 text-white animate-pulse' : 'text-sky-400 hover:bg-slate-700'
              }`}
              title="Ovozli qidiruv"
            >
              {isListening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            </button>
          </div>

          {/* Multi-Query Detected Banner */}
          {multiMatches.length >= 2 && (
            <div className="p-2 rounded-2xl bg-emerald-500/15 border border-emerald-500/40 space-y-2">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[10px] font-extrabold text-emerald-300 uppercase tracking-wide">
                  Topilgan manzillar ({multiMatches.length}):
                </span>
                {multiMatches.map((m, idx) => (
                  <span
                    key={m.id}
                    className="text-[11px] font-bold bg-slate-900/80 text-white px-2 py-0.5 rounded-lg border border-emerald-500/30"
                  >
                    {idx + 1}. {m.name}
                  </span>
                ))}
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => handleApplyMultiMatches(true)}
                  className="flex-1 min-h-[42px] px-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-slate-950 font-black text-xs flex items-center justify-center gap-1.5 cursor-pointer active:scale-95"
                >
                  <Navigation className="w-3.5 h-3.5 shrink-0" />
                  <span>Joylashuvimdan bularga marshrut</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleApplyMultiMatches(false)}
                  className="min-h-[42px] px-2.5 rounded-xl bg-slate-700 hover:bg-slate-600 text-white font-bold text-[11px] shrink-0 cursor-pointer active:scale-95"
                  title="Yozilgan tartibda qo'shish"
                >
                  Tartib bilan
                </button>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between gap-2">
            <div className="flex gap-1 bg-slate-800 p-1 rounded-xl flex-1">
              {[
                { id: 'all', label: 'Barchasi' },
                { id: 'maktab', label: 'Maktab' },
                { id: 'dmtt', label: "Bog'cha" }
              ].map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setFilterType(tab.id as 'all' | 'maktab' | 'dmtt')}
                  className={`flex-1 min-h-[34px] rounded-lg text-[11px] font-extrabold transition-colors cursor-pointer ${
                    filterType === tab.id ? 'bg-slate-600 text-white' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => onQuickNearestRoute(pool)}
              className="min-h-[38px] px-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-extrabold flex items-center gap-1 shrink-0 cursor-pointer"
              title="Eng yaqin 5 tasiga marshrut"
            >
              <Zap className="w-3.5 h-3.5 text-amber-300" />
              <span>Yaqin 5 ta</span>
            </button>
          </div>
        </div>

        {/* Widget Items List */}
        <div className="flex-1 min-h-0 overflow-y-auto p-2.5 space-y-2">
          {displayItems.length === 0 ? (
            <div className="h-full flex items-center justify-center text-xs text-slate-400 font-semibold py-4">
              Natija topilmadi
            </div>
          ) : (
            displayItems.map((loc) => {
              const isSelected = selectedIdSet.has(loc.id);
              return (
                <div
                  key={loc.id}
                  className={`p-2.5 rounded-2xl border flex items-center justify-between gap-2 transition-colors ${
                    isSelected
                      ? 'bg-emerald-950/40 border-emerald-500/50'
                      : 'bg-slate-800/80 border-slate-700/70'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-extrabold text-xs sm:text-sm text-white truncate">{loc.name}</span>
                      <span className="text-[10px] font-extrabold text-emerald-300 bg-emerald-500/15 border border-emerald-500/30 px-1.5 py-0.5 rounded-md">
                        {loc.distKm.toFixed(1)} km
                      </span>
                    </div>
                    {loc.mahalla && (
                      <p className="text-[10px] text-slate-400 truncate mt-0.5">{loc.mahalla}</p>
                    )}
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <a
                      href={buildYandexMapsUrl([loc], userLocation, true)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="min-h-[42px] px-2.5 rounded-xl bg-orange-500 hover:bg-orange-600 text-white font-extrabold text-[11px] flex items-center justify-center no-underline active:scale-95"
                    >
                      Yandex
                    </a>
                    <a
                      href={buildGoogleMapsUrl([loc], userLocation, true)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="min-h-[42px] px-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-extrabold text-[11px] flex items-center justify-center no-underline active:scale-95"
                    >
                      Google
                    </a>
                    <button
                      type="button"
                      onClick={() => {
                        onToggleLocation(loc);
                        showToast(
                          isSelected
                            ? `${loc.name} marshrutdan olindi`
                            : `${loc.name} marshrutga qo'shildi`,
                          isSelected ? 'info' : 'success'
                        );
                      }}
                      className={`min-w-[42px] min-h-[42px] rounded-xl font-black text-sm flex items-center justify-center cursor-pointer active:scale-95 transition-colors ${
                        isSelected
                          ? 'bg-emerald-500 hover:bg-emerald-600 text-slate-950'
                          : 'bg-slate-700 hover:bg-slate-600 text-white'
                      }`}
                      title={isSelected ? 'Marshrutdan olib tashlash' : "Marshrutga qo'shish"}
                      aria-label={isSelected ? `${loc.name} marshrutdan olib tashlash` : `${loc.name} marshrutga qo'shish`}
                    >
                      {isSelected ? <Check className="w-4 h-4 stroke-[3]" /> : '+'}
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Sticky Multi-Stop Route Bar (starts from user's GPS location) */}
        {cleanSelected.length > 0 && (
          <div className="px-3 py-2.5 bg-slate-800/95 border-t border-slate-700 space-y-2 shrink-0">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-[11px] font-extrabold text-white truncate">
                  📍 Joylashuvimdan → {cleanSelected.length} ta manzil
                </span>
                <span
                  className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md shrink-0 ${
                    userLocation
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                      : 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
                  }`}
                >
                  {userLocation ? 'GPS tayyor' : 'Avto GPS'}
                </span>
              </div>

              <button
                type="button"
                onClick={onClearSelected}
                className="min-h-[30px] px-2 rounded-lg bg-slate-700 hover:bg-rose-500/80 text-slate-200 hover:text-white text-[11px] font-bold flex items-center gap-1 cursor-pointer shrink-0"
                title="Tanlangan manzillarni tozalash"
              >
                <Trash2 className="w-3 h-3" />
                <span>Tozalash</span>
              </button>
            </div>

            {/* Selected Stops Horizontal Chips */}
            <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
              {cleanSelected.map((stop, idx) => (
                <div
                  key={stop.id}
                  className="flex items-center gap-1 bg-slate-900 border border-slate-600/80 rounded-xl pl-2 pr-1 py-1 shrink-0"
                >
                  <span className="text-[11px] font-bold text-slate-100 whitespace-nowrap">
                    {idx + 1}. {stop.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => onToggleLocation(stop)}
                    aria-label={`${stop.name} ni olib tashlash`}
                    className="w-5 h-5 rounded-lg hover:bg-rose-500/30 text-slate-400 hover:text-rose-300 flex items-center justify-center cursor-pointer"
                    title="Olib tashlash"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>

            {/* Launch Multi-Stop Route Actions */}
            <div className="flex items-center gap-1.5">
              {cleanSelected.length >= 2 && (
                <button
                  type="button"
                  onClick={handleSortSelectedNearest}
                  className="min-h-[44px] px-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-extrabold text-[11px] flex items-center justify-center gap-1 shrink-0 cursor-pointer active:scale-95"
                  title="Joylashuvingizdan eng yaqin ketma-ketlikka solish"
                >
                  <Zap className="w-3.5 h-3.5 text-amber-300 shrink-0" />
                  <span>Yaqinidan</span>
                </button>
              )}

              <a
                href={buildYandexMapsUrl(cleanSelected, userLocation, true)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 min-h-[44px] px-2.5 rounded-xl bg-orange-500 hover:bg-orange-600 text-white font-extrabold text-xs flex items-center justify-center gap-1 no-underline active:scale-95"
              >
                <span>Yandex</span>
              </a>

              <a
                href={buildGoogleMapsUrl(cleanSelected, userLocation, true)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 min-h-[44px] px-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-extrabold text-xs flex items-center justify-center gap-1 no-underline active:scale-95"
              >
                <span>Google</span>
              </a>

              <button
                type="button"
                onClick={() => onBuildRouteFromGps(cleanSelected, false)}
                className="min-h-[44px] px-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-slate-950 font-black text-[11px] flex items-center justify-center gap-1 shrink-0 cursor-pointer active:scale-95"
                title="Xaritada marshrut chizish"
              >
                <Route className="w-3.5 h-3.5 shrink-0" />
                <span>Xaritada</span>
              </button>
            </div>
          </div>
        )}

        {/* Bottom drag handle for top/center-anchored widget */}
        {prefs.position !== 'bottom' && (
          <div
            onPointerDown={handleResizePointerDown}
            onPointerMove={handleResizePointerMove}
            onPointerUp={handleResizePointerUp}
            onPointerCancel={handleResizePointerUp}
            className="h-5 bg-slate-800/80 border-t border-slate-700/70 flex items-center justify-center cursor-ns-resize touch-none shrink-0"
            title="Bo'yini o'zgartirish uchun yuqori-pastga torting"
          >
            <GripHorizontal className="w-5 h-4 text-slate-400" />
          </div>
        )}
      </div>
    </div>
  );
};
