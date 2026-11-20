import React, { useEffect, useState, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, GeoJSON, useMapEvents, Circle, Tooltip, ZoomControl } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import Papa from 'papaparse';
import { collection, getDocs, addDoc, deleteDoc, updateDoc, doc, writeBatch, query, where } from 'firebase/firestore';
import { db, auth } from '../lib/firebase';
import { Trash2, Route, Navigation, MapPin, Fuel, Clock, Map as MapIcon, Activity, Plus, X, MousePointer2, Printer, Shield, LogOut, Settings2, Layers, Search, Sparkles, UploadCloud, Target, Factory, LocateFixed, Check, Save, History, ExternalLink, CheckCircle2, ChevronRight, XCircle, Compass, ChevronLeft, QrCode, Smartphone, Globe, RefreshCw, Copy, Building2, Download, FileSpreadsheet, Send, Mic, MicOff, Zap, LayoutGrid } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import { Location } from '../types';
import { isNineKindergartenMatch, isSixteenKindergartenMatch } from '../utils/cadastreHelpers';
import { exportSchoolsAndKindergartensToExcel, getCadastreDetails } from '../utils/excelExporter';
import { TelegramRouteModal } from './TelegramRouteModal';
import { PWAInstallButton, OfflineIndicator } from './PWAInstallButton';
import { QuickWidgetPanel } from './QuickWidgetPanel';
import {
  smartSearchLocations,
  parseMultiQueryLocations,
  buildYandexMapsUrl,
  buildGoogleMapsUrl,
  sortLocationsNearestFirst,
  haversineDistanceKm
} from '../utils/navigationHelpers';

const getShortLabelString = (name: string) => {
  const safeName = name || '?';
  if (safeName.includes("Mening joylashuvim") || safeName.includes("user-gps")) return "📍";
  if (safeName.includes("Xaritadan") || safeName.includes("custom")) return "📌";
  const numMatch = safeName.match(/\d+/);
  return numMatch ? numMatch[0] : safeName.charAt(0).toUpperCase();
};

const divIconCache = new Map<string, L.DivIcon>();

const createDivIcon = (type: string, name: string) => {
  const label = getShortLabelString(name);
  const cacheKey = `${type}:${label}`;
  const cached = divIconCache.get(cacheKey);
  if (cached) return cached;

  let bgColor = '#8F7D66'; // Warm neutral slate-500 equivalent
  if (type === 'maktab') bgColor = '#0EA5E9'; // Osmon-ko'k (Pastel Sky - Brightened)
  else if (type === 'bogcha' || type === 'dmtt') bgColor = '#FF6F61'; // Shaftoli (Pastel Peach - Brightened)
  else if (type === 'boshqa' || type === 'tashkilot') bgColor = '#10B981'; // Yalpiz (Pastel Mint - Brightened)

  const icon = new L.DivIcon({
    className: 'bg-transparent border-0',
    html: `<div style="background-color: ${bgColor}; width: 26px; height: 26px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: white; font-weight: 800; border: 2.5px solid #FAF8F5; box-shadow: 0 4px 12px rgba(45,44,57,0.18); font-size: 11px; font-family: 'Quicksand', 'Inter', sans-serif; position: relative;">
            ${label}
            <div style="position: absolute; bottom: -5px; left: 50%; transform: translateX(-50%); width: 0; height: 0; border-left: 5.5px solid transparent; border-right: 5.5px solid transparent; border-top: 7px solid ${bgColor};"></div>
          </div>`,
    iconSize: [26, 32],
    iconAnchor: [13, 32],
    popupAnchor: [0, -32]
  });

  divIconCache.set(cacheKey, icon);
  return icon;
};

const getDistanceFromLatLonInKm = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  const R = 6371; // Radius of the earth in km
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

const deg2rad = (deg: number) => {
  return deg * (Math.PI / 180);
};

function Toggle({ label, checked, onChange, color = "bg-blue-600" }: { label: string, checked: boolean, onChange: (v: boolean) => void, color?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className="w-full flex items-center justify-between cursor-pointer group py-1 text-left"
      onClick={() => onChange(!checked)}
    >
      <span className="text-sm font-bold text-slate-700 group-hover:text-slate-900 transition-colors">{label}</span>
      <span className={`relative w-11 h-6 rounded-full transition-colors duration-300 shrink-0 ${checked ? color : 'bg-slate-200'}`}>
        <span className={`absolute top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-white transition-all duration-300 shadow-sm ${checked ? 'left-[calc(100%-1.25rem)]' : 'left-1'}`}></span>
      </span>
    </button>
  );
}

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export default function MapComponent() {
  const [locations, setLocations] = useState<Location[]>(() => {
    try {
      const cached = localStorage.getItem('mmtb_cached_locations');
      return cached ? JSON.parse(cached) : [];
    } catch {
      return [];
    }
  });
  const [loading, setLoading] = useState(true);
  const [selectedLocations, setSelectedLocations] = useState<Location[]>(() => {
    try {
      const cached = localStorage.getItem('mmtb_last_selected_locations');
      return cached ? JSON.parse(cached) : [];
    } catch {
      return [];
    }
  });
  const [routeGeometry, setRouteGeometry] = useState<[number, number][] | null>(() => {
    try {
      const cached = localStorage.getItem('mmtb_last_route_geometry');
      return cached ? JSON.parse(cached) : null;
    } catch {
      return null;
    }
  });
  const [multiRouteGeometries, setMultiRouteGeometries] = useState<{coords: [number, number][], color: string}[] | null>(() => {
    try {
      const cached = localStorage.getItem('mmtb_last_multi_route_geometries');
      return cached ? JSON.parse(cached) : null;
    } catch {
      return null;
    }
  });
  const [vehiclesCount, setVehiclesCount] = useState<number>(() => {
    try {
      const cached = localStorage.getItem('mmtb_vehicles_count');
      return cached ? parseInt(cached, 10) : 1;
    } catch {
      return 1;
    }
  });
  const [isRoundtrip, setIsRoundtrip] = useState<boolean>(() => {
    try {
      const cached = localStorage.getItem('mmtb_is_roundtrip');
      return cached === 'true';
    } catch {
      return false;
    }
  });
  const [sharedStartPoint, setSharedStartPoint] = useState<boolean>(() => {
    try {
      const cached = localStorage.getItem('mmtb_shared_start_point');
      return cached === 'true';
    } catch {
      return false;
    }
  });
  const [routeStats, setRouteStats] = useState<any>(() => {
    try {
      const cached = localStorage.getItem('mmtb_last_route_stats');
      return cached ? JSON.parse(cached) : null;
    } catch {
      return null;
    }
  });
  const [isCalculating, setIsCalculating] = useState(false);

  const getGoogleMapsUrl = (locationsList: any[]) => {
    return buildGoogleMapsUrl(locationsList, userLocation, startFromMyLocation, isRoundtrip);
  };

  const getYandexMapsUrl = (locationsList: any[]) => {
    return buildYandexMapsUrl(locationsList, userLocation, startFromMyLocation, isRoundtrip);
  };

  const [districtBoundary, setDistrictBoundary] = useState<any>(null);

  // Area Boundary Search States
  const [searchAreaQuery, setSearchAreaQuery] = useState('');
  const [isSearchingArea, setIsSearchingArea] = useState(false);
  const [mahallaBoundary, setMahallaBoundary] = useState<any>(null);

  // Telegram & Quick Driving States
  const [isTelegramModalOpen, setIsTelegramModalOpen] = useState(false);
  const [startFromMyLocation, setStartFromMyLocation] = useState<boolean>(() => {
    try {
      const cached = localStorage.getItem('mmtb_start_from_my_location');
      return cached !== 'false';
    } catch {
      return true;
    }
  });
  const [isNearbyOpen, setIsNearbyOpen] = useState(false);
  const [isWidgetOpen, setIsWidgetOpen] = useState(false);
  const [nearbyFilter, setNearbyFilter] = useState<'all' | 'maktab' | 'dmtt'>('all');
  const [isListeningVoice, setIsListeningVoice] = useState(false);
  const recognitionRef = useRef<any>(null);
  const mobileSearchInputRef = useRef<HTMLInputElement>(null);
  const desktopSearchInputRef = useRef<HTMLInputElement>(null);
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [confirmDeleteRouteId, setConfirmDeleteRouteId] = useState<string | null>(null);

  // States for Adding New Location
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isPickingLocation, setIsPickingLocation] = useState(false);
  const [newLocName, setNewLocName] = useState('');
  const [newLocType, setNewLocType] = useState('maktab');
  const [newLocLat, setNewLocLat] = useState<number | ''>('');
  const [newLocLng, setNewLocLng] = useState<number | ''>('');
  const [newLocCapacity, setNewLocCapacity] = useState<number | ''>('');
  const [newLocArea, setNewLocArea] = useState<number | ''>('');
  const [newLocLandmark, setNewLocLandmark] = useState<string>('');
  const [newLocMahalla, setNewLocMahalla] = useState<string>('');
  const [newLocCadastre, setNewLocCadastre] = useState<string>('');
  const [newLocTotalLandArea, setNewLocTotalLandArea] = useState<number | ''>('');
  const [newLocBuildingFootprintArea, setNewLocBuildingFootprintArea] = useState<number | ''>('');
  const [newLocCadastreAddress, setNewLocCadastreAddress] = useState<string>('');
  const [newLocCadastreType, setNewLocCadastreType] = useState<string>('');
  const [isNgisFetching, setIsNgisFetching] = useState<boolean>(false);
  const [selectedLocationForCadastreModal, setSelectedLocationForCadastreModal] = useState<Location | null>(null);
  const [isCadastreDetailModalOpen, setIsCadastreDetailModalOpen] = useState<boolean>(false);
  const [isBatchNgisSyncing, setIsBatchNgisSyncing] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [toastMessage, setToastMessage] = useState<{text: string, type: 'success' | 'error' | 'info'} | null>(null);

  // Settings & Filters
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [mapSource, setMapSource] = useState<'osm' | 'google' | 'google_sat' | 'yandex'>(() => {
    try {
      localStorage.removeItem('mmtb_is_navigation_active');
      const cached = localStorage.getItem('mmtb_map_source');
      return (cached as any) || 'google';
    } catch {
      return 'google';
    }
  });
  const [routeSteps, setRouteSteps] = useState<any[]>(() => {
    try {
      const cached = localStorage.getItem('mmtb_last_route_steps');
      return cached ? JSON.parse(cached) : [];
    } catch {
      return [];
    }
  });
  const [filters, setFilters] = useState({ schools: true, kindergartens: true, others: true });
  const [layers, setLayers] = useState({ district: true, neighborhoods: false, highways: false });
  const [highwaysData, setHighwaysData] = useState<any>(null);
  const [isLoadingHighways, setIsLoadingHighways] = useState(false);
  const [neighborhoodsData, setNeighborhoodsData] = useState<any>(null);
  const [isLoadingNeighborhoods, setIsLoadingNeighborhoods] = useState(false);

  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editingLocation, setEditingLocation] = useState<Location | null>(null);

  // Landmark in-place editing states
  const [editingLandmarkId, setEditingLandmarkId] = useState<string | null>(null);
  const [tempLandmark, setTempLandmark] = useState<string>('');
  const [isModerating, setIsModerating] = useState<boolean>(false);

  // Saved custom routes states
  const [savedRoutes, setSavedRoutes] = useState<any[]>([]);
  const [isSavedRoutesLoading, setIsSavedRoutesLoading] = useState<boolean>(false);
  const [isSavingRoute, setIsSavingRoute] = useState<boolean>(false);
  const [newRouteName, setNewRouteName] = useState<string>('');
  const [showSaveRouteForm, setShowSaveRouteForm] = useState<boolean>(false);
  const [showSavedRoutesList, setShowSavedRoutesList] = useState<boolean>(false);
  
  const [isBatchSelectModalOpen, setIsBatchSelectModalOpen] = useState(false);
  const [batchSearchQuery, setBatchSearchQuery] = useState('');
  const [batchTypeFilter, setBatchTypeFilter] = useState('all');

  const mapRef = useRef<L.Map>(null);
  const markerRefs = useRef<{[key: string]: L.Marker | null}>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploadingCSV, setIsUploadingCSV] = useState(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Array<Location & { distanceKm?: number }>>([]);
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [isMobilePanelOpen, setIsMobilePanelOpen] = useState(false);
  const [isMapLocked, setIsMapLocked] = useState(false);
  const [userLocation, setUserLocation] = useState<[number, number] | null>(null);
  const [isPickingRoutePoint, setIsPickingRoutePoint] = useState(false);
  const [clickedMarkerState, setClickedMarkerState] = useState<{ id: string; timestamp: number } | null>(null);
  const closeTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // States for Radius Analysis
  const [isRadiusMode, setIsRadiusMode] = useState(false);
  const [radiusKm, setRadiusKm] = useState<number>(5);
  const [radiusCenter, setRadiusCenter] = useState<[number, number] | null>(null);

  const [optimizedRouteDistance, setOptimizedRouteDistance] = useState<number | null>(null);
  const [hideUnselected, setHideUnselected] = useState(false);

  // Recent route searches (last 5 searches)
  const [recentRouteSearches, setRecentRouteSearches] = useState<any[]>(() => {
    try {
      const cached = localStorage.getItem('mmtb_recent_searches');
      return cached ? JSON.parse(cached) : [];
    } catch {
      return [];
    }
  });
  const [showRecentSearches, setShowRecentSearches] = useState<boolean>(false);


  // QR code states
  const [qrMapSelected, setQrMapSelected] = useState<'google' | 'yandex'>('google');
  const [selectedRouteQrIdx, setSelectedRouteQrIdx] = useState<number>(0);
  const [isQrOpen, setIsQrOpen] = useState<boolean>(true);
  const [isRouteStatsExpanded, setIsRouteStatsExpanded] = useState<boolean>(false);

  // Sync route states with localStorage for offline caching
  useEffect(() => {
    try {
      localStorage.setItem('mmtb_last_selected_locations', JSON.stringify(selectedLocations));
    } catch (e) {
      console.error("Local storage error:", e);
    }
  }, [selectedLocations]);

  useEffect(() => {
    try {
      if (routeGeometry) {
        localStorage.setItem('mmtb_last_route_geometry', JSON.stringify(routeGeometry));
      } else {
        localStorage.removeItem('mmtb_last_route_geometry');
      }
    } catch (e) {
      console.error("Local storage error:", e);
    }
  }, [routeGeometry]);

  useEffect(() => {
    try {
      if (multiRouteGeometries) {
        localStorage.setItem('mmtb_last_multi_route_geometries', JSON.stringify(multiRouteGeometries));
      } else {
        localStorage.removeItem('mmtb_last_multi_route_geometries');
      }
    } catch (e) {
      console.error("Local storage error:", e);
    }
  }, [multiRouteGeometries]);

  useEffect(() => {
    try {
      if (routeStats) {
        localStorage.setItem('mmtb_last_route_stats', JSON.stringify(routeStats));
      } else {
        localStorage.removeItem('mmtb_last_route_stats');
      }
    } catch (e) {
      console.error("Local storage error:", e);
    }
  }, [routeStats]);

  useEffect(() => {
    try {
      localStorage.setItem('mmtb_last_route_steps', JSON.stringify(routeSteps));
    } catch (e) {
      console.error("Local storage error:", e);
    }
  }, [routeSteps]);

  // Sync route settings to localStorage for reloading persistence

  useEffect(() => {
    try {
      localStorage.setItem('mmtb_map_source', mapSource);
    } catch (e) {
      console.error(e);
    }
  }, [mapSource]);

  useEffect(() => {
    try {
      localStorage.setItem('mmtb_vehicles_count', String(vehiclesCount));
    } catch (e) {
      console.error(e);
    }
  }, [vehiclesCount]);

  useEffect(() => {
    try {
      localStorage.setItem('mmtb_is_roundtrip', isRoundtrip ? 'true' : 'false');
    } catch (e) {
      console.error(e);
    }
  }, [isRoundtrip]);

  useEffect(() => {
    try {
      localStorage.setItem('mmtb_shared_start_point', sharedStartPoint ? 'true' : 'false');
    } catch (e) {
      console.error(e);
    }
  }, [sharedStartPoint]);

  useEffect(() => {
    try {
      localStorage.setItem('mmtb_start_from_my_location', startFromMyLocation ? 'true' : 'false');
    } catch (e) {
      console.error(e);
    }
  }, [startFromMyLocation]);

  const { role, currentUser } = useAuth();
  const navigate = useNavigate();


  const handleSearch = (q: string) => {
    setSearchQuery(q);
    if (q.trim().length > 0) {
      const res = smartSearchLocations(filteredLocations, q, userLocation, 8);
      setSearchResults(res);
    } else {
      setSearchResults([]);
    }
  };

  const handleSearchSelect = (loc: Location) => {
    if (mapRef.current) {
      mapRef.current.flyTo([loc.lat, loc.lng], 16, { duration: 1.2 });
    }
    setTimeout(() => {
      if (markerRefs.current[loc.id]) {
         markerRefs.current[loc.id]!.openPopup();
      }
    }, 1250);
    setSearchQuery('');
    setSearchResults([]);
    setIsSearchFocused(false);
  };

  const toggleVoiceSearch = () => {
    if (isListeningVoice && recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // ignore
      }
      setIsListeningVoice(false);
      return;
    }

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      showToast("Brauzeringizda ovozli qidiruv qo'llab-quvvatlanmaydi (Chrome/Android da ishlaydi)", "info");
      return;
    }

    try {
      const recognition = new SpeechRecognition();
      recognition.lang = 'uz-UZ';
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;

      recognition.onstart = () => {
        setIsListeningVoice(true);
        showToast("🎤 Gapiring: masalan, '9 bogcha' yoki '15 maktab'...", "info");
      };

      recognition.onresult = (event: any) => {
        const transcript = event?.results?.[0]?.[0]?.transcript || '';
        if (transcript) {
          handleSearch(transcript);
          setIsSearchFocused(true);
          mobileSearchInputRef.current?.focus();
        }
      };

      recognition.onerror = () => {
        setIsListeningVoice(false);
        showToast("Ovozni aniqlab bo'lmadi, qayta urinib ko'ring", "error");
      };

      recognition.onend = () => {
        setIsListeningVoice(false);
      };

      recognitionRef.current = recognition;
      recognition.start();
    } catch {
      setIsListeningVoice(false);
      showToast("Ovozli qidiruvni yoqib bo'lmadi", "error");
    }
  };

  const openNearbyPanel = () => {
    setIsNearbyOpen(true);
    setIsSearchFocused(false);
    if (!userLocation && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setUserLocation([pos.coords.latitude, pos.coords.longitude]);
        },
        () => {
          // User can tap GPS button inside panel or use district center fallback
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
      );
    }
  };

  const applyNearestOrderToSelected = async (originLat: number, originLng: number, locsToSort: Location[]) => {
    const ordered = sortLocationsNearestFirst(locsToSort, originLat, originLng);
    setSelectedLocations(ordered);
    setRouteGeometry(null);
    setRouteStats(null);
    showToast("⚡ Manzillar eng yaqinidan tartiblandi!", "success");

    if (ordered.length >= 2) {
      setIsCalculating(true);
      try {
        const coords = ordered.map(l => `${l.lng},${l.lat}`).join(';');
        const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=true`);
        const data = await res.json();
        if (data.code === 'Ok' && data.routes && data.routes.length > 0) {
          const route = data.routes[0];
          const routeCoords = route.geometry.coordinates.map((c: [number, number]) => [c[1], c[0]] as [number, number]);
          setRouteGeometry(routeCoords);
          setRouteStats({ distance: route.distance, duration: route.duration });
        }
      } catch (err) {
        console.error("Nearest route calc error:", err);
      } finally {
        setIsCalculating(false);
      }
    }
  };

  const handleSortNearestFirst = () => {
    if (selectedLocations.length < 2) return;
    if (userLocation) {
      applyNearestOrderToSelected(userLocation[0], userLocation[1], selectedLocations);
      return;
    }
    if (!navigator.geolocation) {
      applyNearestOrderToSelected(center[0], center[1], selectedLocations);
      return;
    }
    showToast("📍 GPS joylashuvingiz aniqlanmoqda...", "info");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        setUserLocation([lat, lng]);
        applyNearestOrderToSelected(lat, lng, selectedLocations);
      },
      () => {
        applyNearestOrderToSelected(selectedLocations[0].lat, selectedLocations[0].lng, selectedLocations);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  };

  const handleQuickNearestRoute = (targetLocs: Location[]) => {
    if (targetLocs.length === 0) return;
    const refLat = userLocation ? userLocation[0] : center[0];
    const refLng = userLocation ? userLocation[1] : center[1];
    const nearest5 = [...targetLocs]
      .filter(l => !l.id.startsWith('gps-'))
      .sort((a, b) => haversineDistanceKm(refLat, refLng, a.lat, a.lng) - haversineDistanceKm(refLat, refLng, b.lat, b.lng))
      .slice(0, 5);
    const ordered = sortLocationsNearestFirst(nearest5, refLat, refLng);
    setSelectedLocations(ordered);
    setStartFromMyLocation(true);
    setIsNearbyOpen(false);
    setIsMobilePanelOpen(true);
    applyNearestOrderToSelected(refLat, refLng, ordered);
  };

  const handleToggleWidgetLocation = (loc: Location) => {
    setSelectedLocations((prev) => {
      const exists = prev.some((l) => l.id === loc.id);
      return exists ? prev.filter((l) => l.id !== loc.id) : [...prev, loc];
    });
    setRouteGeometry(null);
    setRouteStats(null);
  };

  const handleSetWidgetLocations = (locs: Location[]) => {
    setSelectedLocations(locs.filter((l) => !l.id.startsWith('gps-')));
    setStartFromMyLocation(true);
    setRouteGeometry(null);
    setRouteStats(null);
  };

  const handleWidgetBuildRouteFromGps = async (locs: Location[], autoSort = false) => {
    const cleanLocs = locs.filter((l) => !l.id.startsWith('gps-'));
    if (cleanLocs.length === 0) return;

    const executeWithOrigin = async (originCoords: [number, number] | null) => {
      setStartFromMyLocation(true);
      const ordered =
        autoSort && originCoords
          ? sortLocationsNearestFirst(cleanLocs, originCoords[0], originCoords[1])
          : cleanLocs;

      let routeStops: Location[] = ordered;
      if (originCoords) {
        const gpsStart: Location = {
          id: `gps-widget-${Date.now()}`,
          name: '📍 Mening joylashuvim',
          type: 'boshqa',
          lat: originCoords[0],
          lng: originCoords[1]
        };
        routeStops = [gpsStart, ...ordered];
      }

      setSelectedLocations(routeStops);
      setRouteGeometry(null);
      setRouteStats(null);
      setMultiRouteGeometries(null);
      setIsWidgetOpen(false);
      setIsMobilePanelOpen(true);

      if (routeStops.length >= 2) {
        setIsCalculating(true);
        try {
          const coords = routeStops.map((l) => `${l.lng},${l.lat}`).join(';');
          const res = await fetch(
            `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=true`
          );
          const data = await res.json();
          if (data.code === 'Ok' && data.routes && data.routes.length > 0) {
            const route = data.routes[0];
            const routeCoords = route.geometry.coordinates.map(
              (c: [number, number]) => [c[1], c[0]] as [number, number]
            );
            setRouteGeometry(routeCoords);
            const allSteps: any[] = [];
            if (route.legs) {
              route.legs.forEach((leg: any, legIdx: number) => {
                if (leg.steps) {
                  leg.steps.forEach((step: any) => {
                    allSteps.push({
                      ...step,
                      legIndex: legIdx,
                      targetLabel: routeStops[legIdx + 1]?.name || ''
                    });
                  });
                }
              });
            }
            setRouteSteps(allSteps);
            setRouteStats({ distance: route.distance, duration: route.duration });
            if (mapRef.current && routeCoords.length > 0) {
              mapRef.current.fitBounds(L.latLngBounds(routeCoords), { padding: [50, 50] });
            }
            showToast(
              originCoords
                ? "📍 Joylashuvingizdan marshrut tayyor!"
                : "📍 Marshrut tayyor!",
              'success'
            );
          }
        } catch (err) {
          console.error('Widget GPS route calc error:', err);
        } finally {
          setIsCalculating(false);
        }
      } else if (mapRef.current && routeStops.length === 1) {
        mapRef.current.flyTo([routeStops[0].lat, routeStops[0].lng], 14, { duration: 1.2 });
        showToast("GPS aniqlanmadi, lekin Yandex/Google tugmasi avto-GPS bilan ishlaydi", 'info');
      }
    };

    if (userLocation) {
      await executeWithOrigin(userLocation);
      return;
    }

    if (navigator.geolocation) {
      showToast("📍 GPS joylashuv olinmoqda...", 'info');
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const coords: [number, number] = [pos.coords.latitude, pos.coords.longitude];
          setUserLocation(coords);
          executeWithOrigin(coords);
        },
        () => {
          executeWithOrigin(null);
        },
        { enableHighAccuracy: true, timeout: 6000, maximumAge: 30000 }
      );
      return;
    }

    await executeWithOrigin(null);
  };

  const searchAreaBoundary = async () => {
    if (!searchAreaQuery.trim()) return;
    setIsSearchingArea(true);
    try {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(searchAreaQuery)}&polygon_geojson=1&format=json&countrycodes=uz`);
        const data = await res.json();

        const filteredData = data.filter((item: any) => item.geojson && (item.geojson.type === 'Polygon' || item.geojson.type === 'MultiPolygon'));

        if (filteredData.length > 0) {
            const boundaryData = filteredData[0].geojson;
            setMahallaBoundary(boundaryData);
            
            if (mapRef.current) {
                const geojsonObj = L.geoJSON(boundaryData);
                const bounds = geojsonObj.getBounds();
                mapRef.current.fitBounds(bounds, { padding: [50, 50], duration: 1.5 });
            }
            setIsSettingsOpen(false); // Close settings to see the map
            showToast("Hudud chegarasi topildi", "success");
        } else {
            showToast("Bu hududning chegarasi (Polygon) OpenStreetMap bazasida kiritilmagan", "error");
        }
    } catch (err) {
        console.error("Area search error:", err);
        showToast("Xatolik yuz berdi", "error");
    } finally {
        setIsSearchingArea(false);
    }
  };

  // Boshlang'ich nuqta (Default center - masalan, MMTB hududi)
  const center: [number, number] = [39.7, 67.35];

  // Component to handle map clicks for picking coordinates
  function LocationPicker() {
    const map = useMapEvents({
      dragstart() {
        setClickedMarkerState(null);
        if (closeTimeoutRef.current) {
          clearTimeout(closeTimeoutRef.current);
          closeTimeoutRef.current = null;
        }
        map.closePopup();
      },
      movestart() {
        setClickedMarkerState(null);
        if (closeTimeoutRef.current) {
          clearTimeout(closeTimeoutRef.current);
          closeTimeoutRef.current = null;
        }
        map.closePopup();
      },
      popupclose() {
        setClickedMarkerState(null);
        if (closeTimeoutRef.current) {
          clearTimeout(closeTimeoutRef.current);
          closeTimeoutRef.current = null;
        }
      },
      click(e) {
        setClickedMarkerState(null);
        if (closeTimeoutRef.current) {
          clearTimeout(closeTimeoutRef.current);
          closeTimeoutRef.current = null;
        }
        if (isPickingRoutePoint) {
           const customLocation: Location = {
             id: `custom-${Date.now()}`,
             name: `📍 Xaritadan belgilangan nuqta`,
             type: 'boshqa',
             lat: parseFloat(e.latlng.lat.toFixed(6)),
             lng: parseFloat(e.latlng.lng.toFixed(6))
           };
           setSelectedLocations(prev => {
             return [...prev, customLocation];
           });
           showToast("Xaritadan nuqta marshrutga qo'shildi!", "success");
           setIsPickingRoutePoint(false);
           return;
        } else if (isPickingLocation && !isRadiusMode) {
          setNewLocLat(parseFloat(e.latlng.lat.toFixed(6)));
          setNewLocLng(parseFloat(e.latlng.lng.toFixed(6)));
          setIsPickingLocation(false);
          if (editingLocation) {
              setIsEditModalOpen(true);
          } else {
              setIsAddModalOpen(true); // Re-open modal after picking
          }
        } else if (isRadiusMode) {
          const lat = e.latlng.lat;
          const lng = e.latlng.lng;
          setRadiusCenter([lat, lng]);
          
          let schools = 0;
          let kindergartens = 0;
          let others = 0;
          
          locations.forEach(loc => {
            const dist = getDistanceFromLatLonInKm(lat, lng, loc.lat, loc.lng);
            if (dist <= radiusKm) {
              if (loc.type === 'maktab') schools++;
              else if (loc.type === 'dmtt' || loc.type === 'bogcha') kindergartens++;
              else others++;
            }
          });
          
          showToast(`${radiusKm} km radiusda: ${schools} ta maktab, ${kindergartens} ta bog'cha${others > 0 ? `, ${others} ta boshqa` : ''} bor`, 'success');
        }
      },
      dblclick(e) {
        const lat = parseFloat(e.latlng.lat.toFixed(6));
        const lng = parseFloat(e.latlng.lng.toFixed(6));
        const customLocation: Location = {
          id: `custom-${Date.now()}`,
          name: `📍 Xaritadan belgilangan nuqta`,
          type: 'boshqa',
          lat: lat,
          lng: lng
        };
        setSelectedLocations(prev => {
          return [...prev, customLocation];
        });
        showToast("Xaritadan nuqta marshrutga qo'shildi!", "success");
      }
    });

    // Helper marker when picking
    if (newLocLat !== '' && newLocLng !== '') {
      return (
         <Marker position={[newLocLat as number, newLocLng as number]} icon={createDivIcon('boshqa', '?')}>
           <Popup>Tanlangan manzil</Popup>
         </Marker>
      );
    }
    return null;
  }

  const showToast = (text: string, type: 'success' | 'error' | 'info' = 'success') => {
    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current);
    }
    setToastMessage({ text, type });
    toastTimeoutRef.current = setTimeout(() => {
      setToastMessage(null);
      toastTimeoutRef.current = null;
    }, 3000);
  };

  const handleGetLocation = () => {
    if (!navigator.geolocation) {
      showToast('Brauzeringizda GPS qo\'llab-quvvatlanmaydi.', 'error');
      return;
    }
    
    // Set a loading toast if needed, or simply let the browser ask for permission
    showToast("📍 Joylashuv aniqlanmoqda...", 'info');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        setUserLocation([lat, lng]);
        
        if (mapRef.current) {
          mapRef.current.flyTo([lat, lng], 14, { duration: 1.5 });
        }
        
        showToast("📍 Joylashuvingiz aniqlandi.", 'success');
      },
      (error) => {
        console.error("GPS Error:", error);
        if (error.code === error.PERMISSION_DENIED) {
           showToast("Siz joylashuv aniqlashga ruxsat bermadingiz. Ilovani yangi oynada (New Tab) ochib ko'ring.", 'error');
        } else {
           showToast("GPS xatosi yoki signal zaif. Telefondan joylashuvni yoqing.", 'error');
        }
      },
      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 0
      }
    );
  };

  const handleAddGPSPoint = () => {
    if (!navigator.geolocation) { showToast("Brauzoringizda GPS yo'q", "error"); return; }
    showToast("Joylashuv aniqlanmoqda...", "info");
    navigator.geolocation.getCurrentPosition(
      pos => {
        const customId = `gps-${Date.now()}`;
        const loc: Location = { id: customId, name: "📍 Mening joylashuvim", type: 'boshqa', lat: pos.coords.latitude, lng: pos.coords.longitude };
        setUserLocation([pos.coords.latitude, pos.coords.longitude]);
        setSelectedLocations(prev => {
          return [loc, ...prev];
        });
        showToast("Joylashuvingiz ro'yxat boshiga qo'shildi", "success");
        if (mapRef.current) {
          mapRef.current.flyTo([pos.coords.latitude, pos.coords.longitude], 15);
        }
      },
      err => {
        console.error("GPS Error:", err);
        showToast("GPS xatosi. Ilovani yangi oynada oching yoki ruxsat bering.", "error");
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  };

  const handleAddGPSToStart = () => {
    if (!navigator.geolocation) { 
      showToast("Brauzeringizda GPS ko'rsatkich qo'llab-quvvatlanmaydi", "error"); 
      return; 
    }
    showToast("📍 Joylashuvingiz aniqlanmoqda...", "info");
    navigator.geolocation.getCurrentPosition(
      pos => {
        const customId = `gps-${Date.now()}`;
        const loc: Location = { 
          id: customId, 
          name: "📍 Mening joylashuvim", 
          type: 'boshqa', 
          lat: pos.coords.latitude, 
          lng: pos.coords.longitude 
        };
        setUserLocation([pos.coords.latitude, pos.coords.longitude]);
        setSelectedLocations(prev => {
          const cleanPrev = prev.filter(item => !item.id.startsWith('gps-') && item.name !== "📍 Mening joylashuvim");
          return [loc, ...cleanPrev];
        });
        showToast("Joylashuvingiz marshrut boshiga qo'shildi", "success");
        if (mapRef.current) {
          mapRef.current.flyTo([pos.coords.latitude, pos.coords.longitude], 15);
        }
      },
      err => {
        console.error("GPS Error:", err);
        showToast("GPS aniqlashda xatolik yuz berdi. Ilovani yangi oynada oching yoki GPS ruxsatini bering.", "error");
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  };

  const handleExcelExportClick = () => {
    if (!currentUser) {
      showToast("🔒 Excel smetani yuklab olish faqat Admin va vakolatli xodimlarga ruxsat berilgan. Iltimos, tizimga kiring!", "error");
      navigate('/login');
      return;
    }
    const result = exportSchoolsAndKindergartensToExcel(locations);
    if (result.exported) {
      showToast(`Excel smeta yuklab olindi (${result.count} ta muassasa)`, "success");
    } else {
      showToast(result.message || "Maktab va bog'chalar bo'yicha ma'lumot topilmadi!", "error");
    }
  };

  const handleFetchNgisCadastre = async (latNum?: number, lngNum?: number, locName?: string, locType?: string, currentCad?: string) => {
    const latVal = latNum !== undefined ? latNum : (typeof newLocLat === 'number' ? newLocLat : parseFloat(String(newLocLat)));
    const lngVal = lngNum !== undefined ? lngNum : (typeof newLocLng === 'number' ? newLocLng : parseFloat(String(newLocLng)));
    const nameVal = locName || newLocName;
    const typeVal = locType || newLocType;
    const cadCode = currentCad || newLocCadastre;

    if ((!latVal || !lngVal) && !cadCode) {
      showToast("Xaritadan koordinatani tanlang yoki Kadastr raqamini kiriting", "error");
      return null;
    }

    setIsNgisFetching(true);
    showToast("🔍 open.ngis.uz portalidan ma'lumotlar olinmoqda...", "info");
    try {
      const res = await fetch('/api/cadastre/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lat: latVal,
          lng: lngVal,
          name: nameVal,
          type: typeVal,
          cadastreCode: cadCode
        })
      });

      const data = await res.json();
      if (data.success) {
        setNewLocCadastre(data.cadastre || '');
        setNewLocTotalLandArea(data.totalLandArea || '');
        setNewLocBuildingFootprintArea(data.buildingFootprintArea || '');
        setNewLocCadastreAddress(data.cadastreAddress || '');
        setNewLocCadastreType(data.cadastreType || "Noturar bino yoki inshoot");
        showToast(`✅ NGIS Portali: Kadastr raqami (${data.cadastre}) va maydonlar topildi!`, "success");
        return data;
      } else {
        showToast(data.error || "NGIS portalidan ma'lumot topilmadi", "error");
        return null;
      }
    } catch (err: any) {
      console.error("NGIS lookup error:", err);
      showToast("NGIS serveridan javob olishda xatolik", "error");
      return null;
    } finally {
      setIsNgisFetching(false);
    }
  };

  const handleSyncAllLocationsWithNgis = async () => {
    if (!currentUser || role !== 'admin') return;

    setIsBatchNgisSyncing(true);
    showToast("🏛️ Barcha ob'ektlar open.ngis.uz bilan sinxronlanmoqda...", "info");
    let updatedCount = 0;

    try {
      for (const loc of locations) {
        if (!loc.cadastre || !loc.totalLandArea || !loc.buildingFootprintArea) {
          try {
            const res = await fetch('/api/cadastre/lookup', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                lat: loc.lat,
                lng: loc.lng,
                name: loc.name,
                type: loc.type,
                cadastreCode: loc.cadastre
              })
            });
            const data = await res.json();
            if (data.success) {
              const locRef = doc(db, 'locations', loc.id);
              await updateDoc(locRef, {
                cadastre: data.cadastre,
                cadastreRegion: data.cadastreRegion || "Samarqand viloyati",
                cadastreDistrict: data.cadastreDistrict || "Bulung'ur tumani",
                cadastreAddress: data.cadastreAddress || `${loc.name}, Bulung'ur tumani`,
                cadastreType: data.cadastreType || "Noturar bino yoki inshoot",
                cadastreDescription: data.cadastreDescription || "Nejiloy",
                totalLandArea: data.totalLandArea,
                buildingFootprintArea: data.buildingFootprintArea,
                docLandArea: data.docLandArea || data.totalLandArea,
                objectArea: data.objectArea || data.buildingFootprintArea,
                ngisSyncedAt: new Date().toISOString()
              });
              updatedCount++;
            }
          } catch (e) {
            console.error("Single sync failed for", loc.name, e);
          }
        }
      }
      showToast(`🎉 Muvaffaqiyatli! ${updatedCount} ta ob'ektga NGIS kadastr va maydon ma'lumotlari biriktirildi!`, "success");
      fetchLocations();
    } catch (err: any) {
      console.error("Batch NGIS sync error:", err);
      showToast("Sinxronlashda xatolik yuz berdi", "error");
    } finally {
      setIsBatchNgisSyncing(false);
    }
  };

  const handleAddLocation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser) return;
    if (!newLocName.trim() || !newLocType || newLocLat === '' || newLocLng === '') {
      showToast("Barcha maydonlarni to'ldiring", "error");
      return;
    }
    
    setIsSubmitting(true);
    try {
      const locationData: any = {
        name: newLocName.trim(),
        type: newLocType,
        lat: Number(newLocLat),
        lng: Number(newLocLng),
      };
      if (newLocCapacity !== '') locationData.capacity = Number(newLocCapacity);
      if (newLocArea !== '') locationData.area = Number(newLocArea);
      if (newLocLandmark.trim() !== '') locationData.landmark = newLocLandmark.trim();
      if (newLocMahalla.trim() !== '') locationData.mahalla = newLocMahalla.trim();
      if (newLocCadastre.trim() !== '') locationData.cadastre = newLocCadastre.trim();
      if (newLocTotalLandArea !== '') locationData.totalLandArea = Number(newLocTotalLandArea);
      if (newLocBuildingFootprintArea !== '') locationData.buildingFootprintArea = Number(newLocBuildingFootprintArea);
      if (newLocCadastreAddress.trim() !== '') locationData.cadastreAddress = newLocCadastreAddress.trim();
      if (newLocCadastreType.trim() !== '') locationData.cadastreType = newLocCadastreType.trim();

      if (role === 'admin') {
        await addDoc(collection(db, 'locations'), locationData);
        showToast("Muvaffaqiyatli qo'shildi!", "success");
      } else {
        await addDoc(collection(db, 'requests'), {
          actionType: 'add',
          data: locationData,
          status: 'pending',
          createdBy: currentUser.uid,
          createdAt: new Date().toISOString()
        });
        showToast("Yangi joylashuv taklifi adminga yuborildi!", "success");
      }
      
      setNewLocName('');
      setNewLocType('maktab');
      setNewLocLat('');
      setNewLocLng('');
      setNewLocCapacity('');
      setNewLocArea('');
      setNewLocLandmark('');
      setNewLocMahalla('');
      setNewLocCadastre('');
      setNewLocTotalLandArea('');
      setNewLocBuildingFootprintArea('');
      setNewLocCadastreAddress('');
      setNewLocCadastreType('');
      setIsAddModalOpen(false);
      
      fetchLocations();
    } catch (error) {
      console.error("Xatolik:", error);
      showToast("Xatolik yuz berdi!", "error");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEditLocation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser || !editingLocation) return;
    if (!newLocName.trim() || !newLocType || newLocLat === '' || newLocLng === '') {
      showToast("Barcha maydonlarni to'ldiring", "error");
      return;
    }
    
    setIsSubmitting(true);
    try {
      const locationData: any = {
        name: newLocName.trim(),
        type: newLocType,
        lat: Number(newLocLat),
        lng: Number(newLocLng),
      };
      if (newLocCapacity !== '') locationData.capacity = Number(newLocCapacity);
      if (newLocArea !== '') locationData.area = Number(newLocArea);
      locationData.landmark = newLocLandmark.trim();
      locationData.mahalla = newLocMahalla.trim();
      locationData.cadastre = newLocCadastre.trim();
      if (newLocTotalLandArea !== '') locationData.totalLandArea = Number(newLocTotalLandArea);
      if (newLocBuildingFootprintArea !== '') locationData.buildingFootprintArea = Number(newLocBuildingFootprintArea);
      if (newLocCadastreAddress.trim() !== '') locationData.cadastreAddress = newLocCadastreAddress.trim();
      if (newLocCadastreType.trim() !== '') locationData.cadastreType = newLocCadastreType.trim();

      if (role === 'admin') {
        const docRef = doc(db, 'locations', editingLocation.id);
        await updateDoc(docRef, locationData);
        showToast("Muvaffaqiyatli tahrirlandi!", "success");
        setIsEditModalOpen(false);
        setEditingLocation(null);
        fetchLocations();
      } else {
        await addDoc(collection(db, 'requests'), {
          actionType: 'edit',
          originalId: editingLocation.id,
          data: locationData,
          status: 'pending',
          createdBy: currentUser.uid,
          createdAt: new Date().toISOString()
        });
        showToast("Tahrirlash taklifi adminga yuborildi!", "success");
        setIsEditModalOpen(false);
        setEditingLocation(null);
      }
    } catch (error: any) {
      console.error("Xatolik:", error);
      showToast(error.message || "Xatolik yuz berdi!", "error");
    } finally {
      setIsSubmitting(false);
    }
  };

  const openEditModal = (loc: Location) => {
    setEditingLocation(loc);
    setNewLocName(loc.name);
    setNewLocType(loc.type);
    setNewLocLat(loc.lat);
    setNewLocLng(loc.lng);
    setNewLocCapacity(loc.capacity ?? '');
    setNewLocArea(loc.area ?? '');
    setNewLocLandmark(loc.landmark || '');
    setNewLocMahalla(loc.mahalla || '');
    setNewLocCadastre(loc.cadastre || '');
    setNewLocTotalLandArea(loc.totalLandArea ?? '');
    setNewLocBuildingFootprintArea(loc.buildingFootprintArea ?? '');
    setNewLocCadastreAddress(loc.cadastreAddress || '');
    setNewLocCadastreType(loc.cadastreType || '');
    setIsEditModalOpen(true);
  };

  const startEditingLandmark = (loc: Location) => {
    setEditingLandmarkId(loc.id);
    setTempLandmark(loc.landmark || '');
  };

  const saveLandmark = async (loc: Location) => {
    setIsModerating(true);
    try {
      const textToCheck = tempLandmark.trim();
      const docRef = doc(db, 'locations', loc.id);
      if (!textToCheck) {
        await updateDoc(docRef, { landmark: "" });
        showToast("Mo'ljal muvaffaqiyatli o'chirildi!", "success");
        setEditingLandmarkId(null);
        fetchLocations();
        return;
      }

      // Call AI server moderation
      const response = await fetch("/api/moderate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: textToCheck })
      });

      if (!response.ok) {
        throw new Error("AI tekshiruvida xatolik");
      }

      const result = await response.json();

      if (result.isValid === false) {
        // Unacceptable! Clear/delete it to satisfy "o'chirib tashlasin"
        await updateDoc(docRef, { landmark: "" });
        showToast("⚠️ AI taqiqi: Nomaqbul yoki behayo so'zlar aniqlandi! O'chirib tashlandi.", "error");
        setEditingLandmarkId(null);
        fetchLocations();
      } else {
        // Safe landmark: save
        await updateDoc(docRef, { landmark: textToCheck });
        showToast("Mo'ljal muvaffaqiyatli o'zgartirildi!", "success");
        setEditingLandmarkId(null);
        fetchLocations();
      }
    } catch (err) {
      console.error("error:", err);
      showToast("Xatolik yuz berdi. Iltimos keyinroq urinib ko'ring.", "error");
    } finally {
      setIsModerating(false);
    }
  };

  const handleDeleteLocation = async (id: string | undefined) => {
    if (!currentUser || !id) return;
    try {
      if (role === 'admin') {
        await deleteDoc(doc(db, 'locations', id));
        fetchLocations();
        showToast("Muvaffaqiyatli o'chirildi!", "success");
        setSelectedLocations(prev => prev.filter(loc => loc.id !== id));
      } else {
        showToast("Faqat admin o'chira oladi. Tahrirlash orqali taklif bering.", "error");
      }
    } catch (error) {
      console.error("Xatolik o'chirishda:", error);
      showToast("O'chirishda xatolik yuz berdi!", "error");
    }
  };

  const fetchSavedRoutes = async () => {
    setIsSavedRoutesLoading(true);
    try {
      const currentUid = currentUser?.uid || 'guest';
      const q = query(collection(db, 'routes'), where('createdBy', '==', currentUid));
      const querySnapshot = await getDocs(q);
      const routesList = querySnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as any[];
      
      setSavedRoutes(routesList);
    } catch (error) {
      console.error('Error fetching saved routes:', error);
      try {
        handleFirestoreError(error, OperationType.LIST, 'routes');
      } catch (err) {
        // logged
      }
    } finally {
      setIsSavedRoutesLoading(false);
    }
  };

  const handleSaveRoute = async () => {
    if (selectedLocations.length < 2) {
      showToast("Marshrutni saqlash uchun kamida 2 ta manzil tanlangan bo'lishi kerak", "error");
      return;
    }
    if (!newRouteName.trim()) {
      showToast("Iltimos, marshrut nomini kiriting", "error");
      return;
    }

    setIsSavingRoute(true);
    try {
      const currentUid = currentUser?.uid || 'guest';
      const routeData = {
        name: newRouteName.trim(),
        locations: selectedLocations,
        routeStats: routeStats || null,
        isRoundtrip: isRoundtrip,
        createdBy: currentUid,
        createdAt: new Date().toISOString()
      };

      await addDoc(collection(db, 'routes'), routeData);
      
      showToast("Marshrut muvaffaqiyatli saqlandi!", "success");
      setNewRouteName("");
      setShowSaveRouteForm(false);
      fetchSavedRoutes();
    } catch (error) {
      console.error("Error saving route:", error);
      showToast("Marshrutni saqlashda xatolik yuz berdi", "error");
      try {
        handleFirestoreError(error, OperationType.CREATE, 'routes');
      } catch (err) {
        // logged
      }
    } finally {
      setIsSavingRoute(false);
    }
  };

  const handleDeleteRoute = async (routeId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirmDeleteRouteId !== routeId) {
      setConfirmDeleteRouteId(routeId);
      return;
    }

    try {
      await deleteDoc(doc(db, 'routes', routeId));
      setConfirmDeleteRouteId(null);
      showToast("Marshrut muvaffaqiyatli o'chirildi", "success");
      fetchSavedRoutes();
    } catch (error) {
      console.error("Error deleting route:", error);
      showToast("Marshrutni o'chirishda xatolik yuz berdi", "error");
      try {
        handleFirestoreError(error, OperationType.DELETE, `routes/${routeId}`);
      } catch (err) {
        // logged
      }
    }
  };

  const handleLoadRoute = async (route: any) => {
    setSelectedLocations(route.locations);
    setIsRoundtrip(route.isRoundtrip || false);
    
    if (route.locations && route.locations.length >= 2) {
      setIsCalculating(true);
      setRouteGeometry(null);
      setMultiRouteGeometries(null);
      try {
        const tripParams = `?roundtrip=${route.isRoundtrip || false}&source=first&overview=full&geometries=geojson&steps=true`;
        const coordsStr = route.locations.map((loc: any) => `${loc.lng},${loc.lat}`).join(';');
        const res = await fetch(`https://router.project-osrm.org/trip/v1/driving/${coordsStr}${tripParams}`);
        const data = await res.json();
        
        if (data.code === 'Ok' && data.trips && data.trips.length > 0) {
          const trip = data.trips[0];
          const routeCoords = trip.geometry.coordinates.map((coord: number[]) => [coord[1], coord[0]] as [number, number]);
          setRouteGeometry(routeCoords);
          
          // Extract steps
          const allSteps: any[] = [];
          if (trip.legs) {
            trip.legs.forEach((leg: any, legIdx: number) => {
              if (leg.steps) {
                leg.steps.forEach((step: any) => {
                  allSteps.push({
                    ...step,
                    legIndex: legIdx,
                    targetLabel: route.locations[legIdx + 1]?.name || ""
                  });
                });
              }
            });
          }
          setRouteSteps(allSteps);
          
          setRouteStats({
            distance: trip.distance,
            duration: trip.duration,
            routes: [{
              distance: trip.distance,
              duration: trip.duration,
              locations: route.locations,
              color: '#3b82f6'
            }]
          });
          setOptimizedRouteDistance(trip.distance);
          showToast(`"${route.name}" yuklandi va xaritaga chizildi!`, "success");
        } else {
          setRouteStats(route.routeStats || null);
          showToast(`"${route.name}" yuklandi, lekin chizib bo'lmadi`, "info");
        }
      } catch (err) {
        console.error("OSRM draw error: ", err);
        setRouteStats(route.routeStats || null);
        showToast(`"${route.name}" yuklashda muammo bo'ldi`, "error");
      } finally {
        setIsCalculating(false);
      }
    } else {
      setRouteGeometry(null);
      setRouteStats(null);
      showToast(`"${route.name}" yuklandi!`, "success");
    }
  };

  const saveRecentRouteSearch = (locations: Location[]) => {
    if (locations.length < 2) return;
    try {
      const cached = localStorage.getItem('mmtb_recent_searches');
      let recent: any[] = cached ? JSON.parse(cached) : [];
      
      const routeId = locations.map(l => l.id).join('-');
      
      // Remove standard duplicates
      recent = recent.filter(r => r.id !== routeId);
      
      const names = locations.map(l => l.name);
      let shortName = `${names[0]} ➔ ${names[names.length - 1]}`;
      if (names.length > 2) {
        shortName += ` (+${names.length - 2})`;
      }
      
      const newItem = {
        id: routeId,
        timestamp: Date.now(),
        name: shortName,
        locations: locations,
        isRoundtrip: isRoundtrip
      };
      
      recent.unshift(newItem);
      recent = recent.slice(0, 5);
      
      localStorage.setItem('mmtb_recent_searches', JSON.stringify(recent));
      setRecentRouteSearches(recent);
    } catch (e) {
      console.error("Failed to save recent route search:", e);
    }
  };

  const handleLoadRecentSearch = async (searchItem: any) => {
    setSelectedLocations(searchItem.locations);
    setIsRoundtrip(searchItem.isRoundtrip || false);
    
    if (searchItem.locations && searchItem.locations.length >= 2) {
      setIsCalculating(true);
      setRouteGeometry(null);
      setMultiRouteGeometries(null);
      try {
        const tripParams = `?roundtrip=${searchItem.isRoundtrip || false}&source=first&overview=full&geometries=geojson&steps=true`;
        const coordsStr = searchItem.locations.map((loc: any) => `${loc.lng},${loc.lat}`).join(';');
        const res = await fetch(`https://router.project-osrm.org/trip/v1/driving/${coordsStr}${tripParams}`);
        const data = await res.json();
        
        if (data.code === 'Ok' && data.trips && data.trips.length > 0) {
          const trip = data.trips[0];
          const routeCoords = trip.geometry.coordinates.map((coord: number[]) => [coord[1], coord[0]] as [number, number]);
          setRouteGeometry(routeCoords);
          
          // Extract steps
          const allSteps: any[] = [];
          if (trip.legs) {
            trip.legs.forEach((leg: any, legIdx: number) => {
              if (leg.steps) {
                leg.steps.forEach((step: any) => {
                  allSteps.push({
                    ...step,
                    legIndex: legIdx,
                    targetLabel: searchItem.locations[legIdx + 1]?.name || ""
                  });
                });
              }
            });
          }
          setRouteSteps(allSteps);
          
          setRouteStats({
            distance: trip.distance,
            duration: trip.duration,
            routes: [{
              distance: trip.distance,
              duration: trip.duration,
              locations: searchItem.locations,
              color: '#3b82f6'
            }]
          });
          setOptimizedRouteDistance(trip.distance);
          showToast(`Qidirilgan marshrut qayta yuklandi va xaritaga chizildi!`, "success");
        } else {
          showToast(`Marshrut yuklandi, lekin chizib bo'lmadi`, "info");
        }
      } catch (err) {
        console.error("OSRM draw error: ", err);
        showToast(`Marshrut yuklashda muammo bo'ldi`, "error");
      } finally {
        setIsCalculating(false);
      }
    } else {
      setRouteGeometry(null);
      setRouteStats(null);
      showToast(`Marshrut yuklandi!`, "success");
    }
  };

  const handleDeleteRecentSearch = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const cached = localStorage.getItem('mmtb_recent_searches');
      let recent: any[] = cached ? JSON.parse(cached) : [];
      recent = recent.filter(r => r.id !== id);
      localStorage.setItem('mmtb_recent_searches', JSON.stringify(recent));
      setRecentRouteSearches(recent);
      showToast("Qidiruv tarixi o'chirildi", "info");
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    fetchSavedRoutes();
  }, [currentUser]);

  const handleBulkUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!currentUser || role !== 'admin') {
      showToast("CSV yuklash faqat admin foydalanuvchilar uchun ruxsat etilgan", "error");
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    setIsUploadingCSV(true);
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (results) => {
        try {
          const rows = results.data as any[];
          let successCount = 0;
          let skippedCount = 0;

          for (let i = 0; i < rows.length; i += 500) {
            const batch = writeBatch(db);
            const chunk = rows.slice(i, i + 500);
            let chunkCount = 0;

            for (const row of chunk) {
              const nameVal = row.name ? row.name.toString().trim() : '';
              const typeVal = row.type ? row.type.toString().trim() : '';
              const latVal = parseFloat(row.lat);
              const lngVal = parseFloat(row.lng);
              const isValidCoords =
                Number.isFinite(latVal) &&
                Number.isFinite(lngVal) &&
                latVal >= -90 &&
                latVal <= 90 &&
                lngVal >= -180 &&
                lngVal <= 180;

              if (nameVal && typeVal && isValidCoords) {
                const docRef = doc(collection(db, 'locations'));
                batch.set(docRef, {
                  name: nameVal,
                  type: typeVal,
                  lat: latVal,
                  lng: lngVal
                });
                successCount++;
                chunkCount++;
              } else {
                skippedCount++;
              }
            }
            if (chunkCount > 0) {
              await batch.commit();
            }
          }

          if (successCount > 0) {
            showToast(
              skippedCount > 0
                ? `${successCount} ta ob'ekt qo'shildi (${skippedCount} ta noto'g'ri qator o'tkazib yuborildi)`
                : `${successCount} ta ob'ekt muvaffaqiyatli bazaga qo'shildi!`,
              "success"
            );
            fetchLocations();
          } else {
            showToast("CSV faylda yaroqli koordinatali qator topilmadi", "error");
          }
        } catch (error) {
          console.error("CSV import error:", error);
          showToast("Xatolik yuz berdi", "error");
        } finally {
          setIsUploadingCSV(false);
          if (fileInputRef.current) {
            fileInputRef.current.value = '';
          }
        }
      },
      error: (error) => {
        console.error("Papa Parse Error:", error);
        showToast("Faylni o'qishda xatolik", "error");
        setIsUploadingCSV(false);
      }
    });
  };

  useEffect(() => {
    fetchLocations();
    fetchBoundary();

    // Silently hydrate GPS if permission was already granted
    if (navigator.geolocation) {
      const tryPassiveGps = () => {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            setUserLocation([pos.coords.latitude, pos.coords.longitude]);
          },
          () => {
            // Silent ignore on initial load
          },
          { enableHighAccuracy: false, timeout: 6000, maximumAge: 60000 }
        );
      };
      if (navigator.permissions && typeof navigator.permissions.query === 'function') {
        navigator.permissions.query({ name: 'geolocation' as PermissionName }).then((perm) => {
          if (perm.state === 'granted') {
            tryPassiveGps();
          }
        }).catch(() => {});
      }
    }

    // Handle PWA App Shortcuts (?widget=1, ?quick=nearby, ?quick=search)
    const quickParams = new URLSearchParams(window.location.search);
    const quickAction = quickParams.get('quick');
    if (quickParams.get('widget') === '1' || quickAction === 'widget') {
      setIsWidgetOpen(true);
    } else if (quickAction === 'nearby') {
      openNearbyPanel();
    } else if (quickAction === 'search') {
      setTimeout(() => {
        setIsSearchFocused(true);
        mobileSearchInputRef.current?.focus();
        desktopSearchInputRef.current?.focus();
      }, 250);
    }

    // Parse URL for automated routing from Telegram Bot or external links
    const checkAndLoadUrlRoute = async () => {
      const urlParams = new URLSearchParams(window.location.search);
      const routeParam = urlParams.get('route');
      
      if (routeParam) {
        setIsCalculating(true);
        try {
          const pointStrings = routeParam.split(';');
          const parsedLocs: Location[] = [];
          
          pointStrings.forEach((pointStr, idx) => {
            const parts = pointStr.trim().split(',');
            if (parts.length >= 3) {
              const lng = parseFloat(parts[parts.length - 1]);
              const lat = parseFloat(parts[parts.length - 2]);
              const name = parts.slice(0, parts.length - 2).join(',').trim();
              if (!isNaN(lat) && !isNaN(lng)) {
                parsedLocs.push({
                  id: `url-loaded-${idx}-${Date.now()}`,
                  name: decodeURIComponent(name) || `Nuqta ${idx + 1}`,
                  type: 'custom',
                  lat,
                  lng
                });
              }
            } else if (parts.length === 2) {
              const lat = parseFloat(parts[0]);
              const lng = parseFloat(parts[1]);
              if (!isNaN(lat) && !isNaN(lng)) {
                parsedLocs.push({
                  id: `url-loaded-${idx}-${Date.now()}`,
                  name: `Nuqta ${idx + 1}`,
                  type: 'custom',
                  lat,
                  lng
                });
              }
            }
          });
          
          if (parsedLocs.length >= 2) {
            setSelectedLocations(parsedLocs);
            
            // Check flags
            const shouldOptimize = urlParams.get('optimize') === 'true' || urlParams.get('opt') === '1';
            const shouldAutostart = urlParams.get('nav') === '1' || urlParams.get('autostart') === 'true' || urlParams.get('start') === '1';
            const rtParam = urlParams.get('roundtrip') === 'true' || urlParams.get('rt') === 'true' || urlParams.get('rt') === '1';
            
            if (rtParam) {
              setIsRoundtrip(true);
            }
            
            showToast(`${parsedLocs.length} ta manzil botdan yuklandi. Marshrut hisoblanmoqda...`, "info");
            
            // Build geometry directly so user doesn't wait for state updates
            const isRoundtripVal = rtParam || isRoundtrip;
            const tripParams = `?roundtrip=${isRoundtripVal}&source=first&overview=full&geometries=geojson&steps=true`;
            const coordsStr = parsedLocs.map(loc => `${loc.lng},${loc.lat}`).join(';');
            
            let res, data;
            if (shouldOptimize) {
              res = await fetch(`https://router.project-osrm.org/trip/v1/driving/${coordsStr}${tripParams}`);
              data = await res.json();
            } else {
              // Direct route in specified order
              res = await fetch(`https://router.project-osrm.org/route/v1/driving/${coordsStr}?overview=full&geometries=geojson&steps=true`);
              data = await res.json();
            }
            
            const mainRouteOrTrip = shouldOptimize ? (data.trips && data.trips[0]) : (data.routes && data.routes[0]);
            
            if (data.code === 'Ok' && mainRouteOrTrip) {
              const routeCoords = mainRouteOrTrip.geometry.coordinates.map((coord: number[]) => [coord[1], coord[0]] as [number, number]);
              setRouteGeometry(routeCoords);
              
              // Extract steps
              const allSteps: any[] = [];
              if (mainRouteOrTrip.legs) {
                mainRouteOrTrip.legs.forEach((leg: any, legIdx: number) => {
                  if (leg.steps) {
                    leg.steps.forEach((step: any) => {
                      allSteps.push({
                        ...step,
                        legIndex: legIdx,
                        targetLabel: parsedLocs[legIdx + 1]?.name || ""
                      });
                    });
                  }
                });
              }
              setRouteSteps(allSteps);
              
              let orderedLocations = parsedLocs;
              if (shouldOptimize && data.waypoints) {
                const reordered = new Array(parsedLocs.length);
                data.waypoints.forEach((wp: any, i: number) => {
                  reordered[wp.waypoint_index] = parsedLocs[i];
                });
                setSelectedLocations(reordered);
                orderedLocations = reordered;
              }
              
              const stats = {
                distance: mainRouteOrTrip.distance,
                duration: mainRouteOrTrip.duration,
                routes: [{
                  distance: mainRouteOrTrip.distance,
                  duration: mainRouteOrTrip.duration,
                  locations: orderedLocations,
                  color: '#3b82f6'
                }]
              };
              
              setRouteStats(stats);
              setOptimizedRouteDistance(mainRouteOrTrip.distance);
              saveRecentRouteSearch(orderedLocations);
              
              // Auto-center map to the first point or user location
              if (mapRef.current && routeCoords.length > 0) {
                mapRef.current.setView(routeCoords[0], 13);
              }
              
              if (shouldAutostart) {
                setIsMobilePanelOpen(true);
                showToast("Marshrut yuklandi — Yandex yoki Google Navigatsiyani bosing!", "success");
              } else {
                showToast("Marshrut muvaffaqiyatli tayyorlandi!", "success");
              }
            } else {
              showToast("Marshrutni hisoblashda muammo yuz berdi", "error");
            }
          }
        } catch (e) {
          console.error("URL routing parsed load error:", e);
          showToast("Havoladagi ma'lumotlarni o'qishda xatolik", "error");
        } finally {
          setIsCalculating(false);
        }
      }
    };
    
    checkAndLoadUrlRoute();
  }, []);

  useEffect(() => {
    if (layers.highways && !highwaysData) {
      const fetchHighways = async () => {
        setIsLoadingHighways(true);
        try {
          const bbox = "39.50,67.05,39.95,67.65"; 
          const query = `[out:json][timeout:25];way[highway~"^(primary|secondary|trunk|motorway)$"](${bbox});out geom;`;
          const res = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`);
          if (!res.ok) return;
          const text = await res.text();
          if (!text.trim().startsWith('{')) return;
          const data = JSON.parse(text);
          if (!data || !data.elements) return;
          const features = data.elements.map((el: any) => ({
            type: "Feature",
            properties: { id: el.id, highway: el.tags?.highway },
            geometry: { type: "LineString", coordinates: el.geometry.map((g: any) => [g.lon, g.lat]) }
          }));
          setHighwaysData({ type: "FeatureCollection", features });
        } catch (err) {
          console.error("Highways fetch error:", err);
        } finally {
          setIsLoadingHighways(false);
        }
      };
      fetchHighways();
    }
  }, [layers.highways]);

  useEffect(() => {
    if (layers.neighborhoods && !neighborhoodsData) {
      const fetchNeighborhoods = async () => {
        setIsLoadingNeighborhoods(true);
        try {
          const bbox = "39.50,67.05,39.95,67.65"; 
          const query = `[out:json][timeout:25];(relation["admin_level"~"8|9|10|11"]["boundary"="administrative"](${bbox});way["admin_level"~"8|9|10|11"]["boundary"="administrative"](${bbox}););out geom;`;
          const res = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`);
          if (!res.ok) return;
          const text = await res.text();
          if (!text.trim().startsWith('{')) return;
          const data = JSON.parse(text);
          if (!data || !data.elements) return;
          const features: any[] = [];
          data.elements.forEach((el: any) => {
             if (el.type === 'way' && el.geometry) {
                 features.push({
                    type: "Feature",
                    properties: { id: el.id, name: el.tags?.name || '' },
                    geometry: { type: "LineString", coordinates: el.geometry.map((g: any) => [g.lon, g.lat]) }
                 });
             } else if (el.type === 'relation' && el.members) {
                 el.members.forEach((mem: any) => {
                     if (mem.geometry) {
                         features.push({
                            type: "Feature",
                            properties: { id: el.id, name: el.tags?.name || '' },
                            geometry: { type: "LineString", coordinates: mem.geometry.map((g: any) => [g.lon, g.lat]) }
                         });
                     }
                 });
             }
          });
          setNeighborhoodsData({ type: "FeatureCollection", features });
        } catch (err) {
          console.error("Neighborhoods fetch error:", err);
        } finally {
          setIsLoadingNeighborhoods(false);
        }
      };
      fetchNeighborhoods();
    }
  }, [layers.neighborhoods]);

  const fetchBoundary = async () => {
    try {
      const res = await fetch('https://nominatim.openstreetmap.org/search?q=Bulungur+district,+Samarqand+Region,+Uzbekistan&polygon_geojson=1&format=json');
      if (!res.ok) return;
      const text = await res.text();
      if (!text.trim().startsWith('[')) return;
      const data = JSON.parse(text);
      if (data && data.length > 0 && data[0].geojson) {
        setDistrictBoundary(data[0].geojson);
      }
    } catch (err) {
      console.error('Error fetching boundary:', err);
    }
  };

  const fetchLocations = async () => {
    try {
      setLoading(true);
      const querySnapshot = await getDocs(collection(db, 'locations'));
      
      let locs = querySnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as Location[];

      // Ensure official NGIS Geoportal data for 9-DMTT and 16-DMTT using exact numeric boundaries
      locs = locs.map(loc => {
        if (isNineKindergartenMatch(loc.name, loc.type, loc.cadastre)) {
          return {
            ...loc,
            cadastre: loc.cadastre && loc.cadastre.trim() !== '' && loc.cadastre !== 'Kiritilmagan' ? loc.cadastre : '14:01:41:02:01:0086',
            totalLandArea: loc.totalLandArea || 6800,
            buildingFootprintArea: loc.buildingFootprintArea || 1529.23,
            docLandArea: loc.docLandArea || 6800,
            cadastreAddress: loc.cadastreAddress || "Mehrjon MFY, Bulung'ur shoh ko'chasi, 28-uy",
            cadastreType: loc.cadastreType || "Noturar bino yoki inshoot",
            cadastreRegion: loc.cadastreRegion || "Samarqand viloyati",
            cadastreDistrict: loc.cadastreDistrict || "Bulung'ur tumani"
          };
        }

        if (isSixteenKindergartenMatch(loc.name, loc.type, loc.cadastre)) {
          return {
            ...loc,
            cadastre: loc.cadastre && loc.cadastre.trim() !== '' && loc.cadastre !== 'Kiritilmagan' ? loc.cadastre : '14:01:41:03:01:0015',
            totalLandArea: loc.totalLandArea || 2800,
            buildingFootprintArea: loc.buildingFootprintArea || 698.2,
            docLandArea: loc.docLandArea || 2800,
            cadastreAddress: loc.cadastreAddress || "Nurliyo'l MFY, Olmazor ko'chasi, 3-uy",
            cadastreType: loc.cadastreType || "Noturar bino yoki inshoot",
            cadastreRegion: loc.cadastreRegion || "Samarqand viloyati",
            cadastreDistrict: loc.cadastreDistrict || "Bulung'ur tumani"
          };
        }
        return loc;
      });

      setLocations(locs);
      try {
        localStorage.setItem('mmtb_cached_locations', JSON.stringify(locs));
      } catch {
        // Ignore quota errors
      }
      try {
        const bridge = (window as unknown as { AndroidBridge?: { syncLocations?: (json: string) => void } }).AndroidBridge;
        if (bridge?.syncLocations && locs.length > 0) {
          const compact = locs.map(l => ({
            id: l.id,
            name: l.name,
            type: l.type,
            lat: l.lat,
            lng: l.lng,
            mahalla: l.mahalla || ''
          }));
          bridge.syncLocations(JSON.stringify(compact));
        }
      } catch {
        // Ignore bridge errors outside Android APK
      }
    } catch (error) {
      console.error('Error fetching locations:', error);
    } finally {
      setLoading(false);
    }
  };

  const filteredLocations = locations.filter(loc => {
    if (hideUnselected && selectedLocations.length > 0) {
      if (!selectedLocations.find(l => l.id === loc.id)) return false;
    }
    if (loc.type === 'maktab' && !filters.schools) return false;
    if ((loc.type === 'dmtt' || loc.type === 'bogcha') && !filters.kindergartens) return false;
    if (loc.type !== 'maktab' && loc.type !== 'dmtt' && loc.type !== 'bogcha' && !filters.others) return false;
    return true;
  });

  const handleMarkerClick = (loc: Location) => {
    if (!selectedLocations.find(l => l.id === loc.id)) {
      setSelectedLocations([...selectedLocations, loc]);
      setRouteGeometry(null);
      setRouteStats(null);
    }
  };

  const handleClearRoute = () => {
    setSelectedLocations([]);
    setRouteGeometry(null);
    setRouteStats(null);
  };

  const removeLocation = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setSelectedLocations(selectedLocations.filter(l => l.id !== id));
    setRouteGeometry(null);
    setRouteStats(null);
  };

  const calculateRoute = async () => {
    if (selectedLocations.length < 2) return;
    setIsCalculating(true);
    setMultiRouteGeometries(null);
    try {
      const coords = selectedLocations.map(l => `${l.lng},${l.lat}`).join(';');
      const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=true`;
      const res = await fetch(url);
      const data = await res.json();
      
      if (data.code === 'Ok' && data.routes && data.routes.length > 0) {
        const route = data.routes[0];
        const routeCoords = route.geometry.coordinates.map((c: [number, number]) => [c[1], c[0]] as [number, number]);
        setRouteGeometry(routeCoords);
        
        // Extract steps
        const allSteps: any[] = [];
        if (route.legs) {
          route.legs.forEach((leg: any, legIdx: number) => {
            if (leg.steps) {
              leg.steps.forEach((step: any) => {
                allSteps.push({
                  ...step,
                  legIndex: legIdx,
                  targetLabel: selectedLocations[legIdx + 1]?.name || ""
                });
              });
            }
          });
        }
        setRouteSteps(allSteps);
        
        setRouteStats({
          distance: route.distance, 
          duration: route.duration  
        });

        // Background fetch for C scenario (optimized distance)
        fetch(`https://router.project-osrm.org/trip/v1/driving/${coords}?roundtrip=false&source=first&overview=false`)
          .then(r => r.json())
          .then(d => {
            if (d.code === 'Ok' && d.trips && d.trips.length > 0) {
              setOptimizedRouteDistance(d.trips[0].distance);
            }
          })
          .catch(e => console.error("Could not fetch optimized trip distance", e));
      }
    } catch (err) {
      console.error('Route calculation failed:', err);
    } finally {
      setIsCalculating(false);
    }
  };

  const kMeansClustering = (locations: Location[], k: number) => {
    if (k <= 1) return [locations];
    if (locations.length <= k) return locations.map(l => [l]);

    // Group locations by exact coordinates to keep them together
    const groupsMap = new Map<string, Location[]>();
    locations.forEach(loc => {
      const key = `${loc.lat.toFixed(5)},${loc.lng.toFixed(5)}`;
      if (!groupsMap.has(key)) groupsMap.set(key, []);
      groupsMap.get(key)!.push(loc);
    });
    
    const uniqueGroups = Array.from(groupsMap.values());
    if (uniqueGroups.length <= k) {
        return uniqueGroups.map(g => g);
    }

    let centroids = [];
    let shuffled = [...uniqueGroups].sort(() => 0.5 - Math.random());
    for (let i = 0; i < k; i++) centroids.push({ lat: shuffled[i][0].lat, lng: shuffled[i][0].lng });

    const targetSize = Math.ceil(locations.length / k);
    let clusters: Location[][] = Array.from({ length: k }, () => []);
    
    let iterations = 0;
    while (iterations < 50) {
      clusters = Array.from({ length: k }, () => []);
      const clusterSizes = new Array(k).fill(0);
      
      let distances: {groupIdx: number, clusterIdx: number, dist: number}[] = [];
      uniqueGroups.forEach((group, gIdx) => {
          for(let cIdx = 0; cIdx < k; cIdx++) {
              const dist = Math.pow(group[0].lat - centroids[cIdx].lat, 2) + Math.pow(group[0].lng - centroids[cIdx].lng, 2);
              distances.push({groupIdx: gIdx, clusterIdx: cIdx, dist});
          }
      });
      
      distances.sort((a, b) => a.dist - b.dist);
      const assignedGroups = new Set<number>();
      
      for (const d of distances) {
          if (assignedGroups.has(d.groupIdx)) continue;
          
          if (clusterSizes[d.clusterIdx] < targetSize || k === 1) {
              assignedGroups.add(d.groupIdx);
              clusters[d.clusterIdx].push(...uniqueGroups[d.groupIdx]);
              clusterSizes[d.clusterIdx] += uniqueGroups[d.groupIdx].length;
          }
      }
      
      // Fallback for remaining groups if clusters enforce strictly
      uniqueGroups.forEach((group, gIdx) => {
          if (!assignedGroups.has(gIdx)) {
              let minSize = Infinity;
              let bestCluster = 0;
              for(let c=0; c<k; c++) {
                  if (clusterSizes[c] < minSize) {
                      minSize = clusterSizes[c];
                      bestCluster = c;
                  }
              }
              clusters[bestCluster].push(...group);
              clusterSizes[bestCluster] += group.length;
          }
      });
      
      let changed = false;
      for (let i = 0; i < k; i++) {
        if (clusters[i].length === 0) continue;
        const newLat = clusters[i].reduce((sum, loc) => sum + loc.lat, 0) / clusters[i].length;
        const newLng = clusters[i].reduce((sum, loc) => sum + loc.lng, 0) / clusters[i].length;
        if (Math.abs(newLat - centroids[i].lat) > 0.00001 || Math.abs(newLng - centroids[i].lng) > 0.00001) {
          changed = true;
        }
        centroids[i] = { lat: newLat, lng: newLng };
      }
      if (!changed) break;
      iterations++;
    }
    return clusters.filter(c => c.length > 0);
  };

  const autoSaveCalculatedRoute = async (orderedLocs: Location[], stats: any) => {
    try {
      const currentUid = currentUser?.uid || 'guest';
      const startName = orderedLocs[0]?.name || "Noma'lum ob'ekt";
      const endName = orderedLocs[orderedLocs.length - 1]?.name || "Noma'lum ob'ekt";
      
      const now = new Date();
      const dateString = now.toLocaleDateString('uz-UZ', { day: '2-digit', month: '2-digit', year: 'numeric' });
      const timeString = now.toLocaleTimeString('uz-UZ', { hour: '2-digit', minute: '2-digit' });
      
      const routeName = `${startName} → ${endName} (${dateString}, ${timeString})`;
      
      const routeData = {
        name: routeName,
        locations: orderedLocs,
        routeStats: stats,
        isRoundtrip: isRoundtrip,
        createdBy: currentUid,
        createdAt: now.toISOString()
      };

      await addDoc(collection(db, 'routes'), routeData);
      showToast("Marshrut tarixingizga saqlandi!", "success");
      fetchSavedRoutes();
    } catch (error) {
      console.error("Auto save route error:", error);
    }
  };

  const calculateOptimizedRoute = async () => {
    if (selectedLocations.length < 2) return;
    setIsCalculating(true);
    setRouteGeometry(null);
    setMultiRouteGeometries(null);
    setSelectedRouteQrIdx(0);
    try {
      const tripParams = `?roundtrip=${isRoundtrip}&source=first&overview=full&geometries=geojson&steps=true`;
      const effectiveVehiclesCount =
        selectedLocations.length > 5
          ? Math.max(1, Math.min(vehiclesCount, Math.floor(selectedLocations.length / 2)))
          : 1;

      if (effectiveVehiclesCount <= 1) {
        const coordsStr = selectedLocations.map(loc => `${loc.lng},${loc.lat}`).join(';');
        const res = await fetch(`https://router.project-osrm.org/trip/v1/driving/${coordsStr}${tripParams}`);
        const data = await res.json();

        if (data.code === 'Ok' && data.trips && data.trips.length > 0) {
          const trip = data.trips[0];
          const routeCoords = trip.geometry.coordinates.map((coord: number[]) => [coord[1], coord[0]] as [number, number]);
          setRouteGeometry(routeCoords);

          let orderedLocations = selectedLocations;
          if (data.waypoints) {
            const reordered = new Array(selectedLocations.length);
            data.waypoints.forEach((wp: any, i: number) => {
              reordered[wp.waypoint_index] = selectedLocations[i];
            });
            setSelectedLocations(reordered);
            orderedLocations = reordered;
          }

          // Extract steps using the reordered stop sequence so leg target labels match
          const allSteps: any[] = [];
          if (trip.legs) {
            trip.legs.forEach((leg: any, legIdx: number) => {
              if (leg.steps) {
                leg.steps.forEach((step: any) => {
                  allSteps.push({
                    ...step,
                    legIndex: legIdx,
                    targetLabel: orderedLocations[legIdx + 1]?.name || (isRoundtrip ? orderedLocations[0]?.name || "" : "")
                  });
                });
              }
            });
          }
          setRouteSteps(allSteps);

          const stats = {
            distance: trip.distance,
            duration: trip.duration,
            routes: [{
              distance: trip.distance,
              duration: trip.duration,
              locations: orderedLocations,
              color: '#3b82f6'
            }]
          };
          setRouteStats(stats);
          setOptimizedRouteDistance(trip.distance);
          autoSaveCalculatedRoute(orderedLocations, stats);
          saveRecentRouteSearch(orderedLocations);
          setIsRouteStatsExpanded(true);
          setTimeout(() => {
            setIsRouteStatsExpanded(false);
          }, 1500);
        } else {
          showToast("Optimallashtirilgan yo'nalish topilmadi", "error");
        }
      } else {
        let clusters: Location[][] = [];
        if (sharedStartPoint) {
          const depot = selectedLocations[0];
          const toCluster = selectedLocations.slice(1);
          if (toCluster.length > 0) {
            clusters = kMeansClustering(toCluster, effectiveVehiclesCount);
            for (let i = 0; i < clusters.length; i++) {
              clusters[i] = [depot, ...clusters[i]];
            }
          } else {
            clusters = [[depot]];
          }
        } else {
          clusters = kMeansClustering(selectedLocations, effectiveVehiclesCount);
        }

        const colors = ['#ec4899', '#8b5cf6', '#10b981', '#f59e0b', '#06b6d4', '#eab308', '#f43f5e', '#6366f1', '#14b8a6', '#84cc16'];
        let totalDist = 0;
        let totalDur = 0;
        const multi = [];
        const routes = [];

        for (let i = 0; i < clusters.length; i++) {
          const cluster = clusters[i];
          if (cluster.length < 2) continue;

          const coordsStr = cluster.map(loc => `${loc.lng},${loc.lat}`).join(';');
          const res = await fetch(`https://router.project-osrm.org/trip/v1/driving/${coordsStr}${tripParams}`);
          const data = await res.json();

          if (data.code === 'Ok' && data.trips && data.trips.length > 0) {
            const trip = data.trips[0];
            const routeCoords = trip.geometry.coordinates.map((coord: number[]) => [coord[1], coord[0]] as [number, number]);
            totalDist += trip.distance;
            totalDur += trip.duration;
            const color = colors[i % colors.length];
            multi.push({ coords: routeCoords, color });

            let orderedLocations = cluster;
            if (data.waypoints) {
              orderedLocations = new Array(cluster.length);
              data.waypoints.forEach((wp: any, idx: number) => {
                orderedLocations[wp.waypoint_index] = cluster[idx];
              });
            }
            routes.push({
              distance: trip.distance,
              duration: trip.duration,
              locations: orderedLocations,
              color
            });
          }
        }

        if (routes.length === 0) {
          showToast("Ko'p moshinali yo'nalishni hisoblab bo'lmadi. Moshinalar sonini kamaytiring.", "error");
          return;
        }

        const stats = { distance: totalDist, duration: totalDur, routes };
        setMultiRouteGeometries(multi);
        setRouteStats(stats);
        setOptimizedRouteDistance(totalDist);
        autoSaveCalculatedRoute(selectedLocations, stats);
        saveRecentRouteSearch(selectedLocations);
        setIsRouteStatsExpanded(true);
        setTimeout(() => {
          setIsRouteStatsExpanded(false);
        }, 1500);
      }
    } catch (error) {
      console.error("TSP Xatolik:", error);
      showToast("Xatolik yuz berdi", "error");
    } finally {
      setIsCalculating(false);
    }
  };

  const multiSearchMatches = searchQuery.trim()
    ? parseMultiQueryLocations(locations, searchQuery, userLocation || center)
    : [];
  const multiSearchOrdered = multiSearchMatches.length >= 2
    ? sortLocationsNearestFirst(
        multiSearchMatches,
        userLocation ? userLocation[0] : center[0],
        userLocation ? userLocation[1] : center[1]
      )
    : [];

  return (
    <div className="w-full h-full relative font-sans text-slate-900 bg-[#f8fafc] overflow-hidden print:overflow-visible print:bg-white print:p-8 print:h-auto print:-m-8">
      
      {/* Print Document Header */}
      <div className="hidden print:block text-center mb-8 border-b-2 border-slate-900 pb-4 shrink-0 mt-8">
        <h1 className="text-xl font-black uppercase tracking-widest text-slate-900 mb-1">O'zbekiston Respublikasi, Maktabgacha va maktab ta'limi vazirligi</h1>
        <h2 className="text-lg font-bold text-slate-700">Bulung'ur MMTB - Logistika marshruti va Xarajatlar Smetasi</h2>
      </div>

      {/* Unified Responsive Top Bar (Desktop left-of-sidebar & Mobile stacked) */}
      <div className="print:hidden absolute top-2.5 left-2.5 right-2.5 md:top-5 md:left-5 md:right-[416px] z-[500] flex flex-col gap-2 md:gap-2.5 pointer-events-none">
        {/* Top Row: Header + (on xl+ screens) Inline Desktop Search */}
        <div className="relative z-20 flex flex-col xl:flex-row xl:items-center gap-2 md:gap-2.5 w-full">
          {/* Header Panel */}
          <div className="pointer-events-auto bg-white/95 backdrop-blur-md px-2.5 py-2 md:px-3.5 md:py-2.5 rounded-2xl shadow-xl border border-slate-100 flex items-center justify-between gap-2 w-full xl:w-auto shrink-0">
            <div className="flex items-center gap-2 shrink-0 min-w-0">
              <div className="w-8 h-8 md:w-9 md:h-9 bg-blue-600 rounded-xl flex items-center justify-center shrink-0 shadow-sm">
                <MapIcon className="w-4 h-4 md:w-5 md:h-5 text-white" />
              </div>
              <div className="min-w-0">
                <h1 className="text-[13px] md:text-base font-extrabold tracking-tight text-slate-800 leading-tight whitespace-nowrap">
                  <span className="sm:hidden">MMTB</span>
                  <span className="hidden sm:inline">MMTB Logistika</span>
                </h1>
                <div className="flex items-center text-[9px] md:text-[10px] text-slate-500 font-bold uppercase tracking-wider">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500 mr-1 shrink-0"></span>
                  <span className="truncate">{role === 'admin' ? 'Admin' : currentUser ? 'Xodim' : 'Mehmon'}</span>
                </div>
              </div>
            </div>

            <div className="hidden md:block w-px h-7 bg-slate-200 mx-0.5 shrink-0"></div>

            <div className="flex items-center gap-1 md:gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() => setIsWidgetOpen(true)}
                className="min-h-[36px] px-2 md:px-2.5 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-extrabold text-[11px] flex items-center gap-1 shrink-0 active:scale-95 transition-all cursor-pointer shadow-sm"
                title="Tezkor qidiruv va navigator vidjeti"
              >
                <LayoutGrid className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                <span>Widget</span>
              </button>

              <PWAInstallButton compact />

              <button
                type="button"
                onClick={handleExcelExportClick}
                aria-label="Excel Smetani Yuklash"
                className="min-h-[36px] px-2 md:px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold text-[11px] rounded-xl shadow-sm hover:shadow-md transition-all flex items-center gap-1 shrink-0 active:scale-95 cursor-pointer whitespace-nowrap"
                title="Maktab va bog'chalar ma'lumotlarini (Kadastr va Maydonlar) Excel (.xlsx) shaklida yuklab olish"
              >
                <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-100 shrink-0" />
                <span className="sm:hidden">XLS</span>
                <span className="hidden sm:inline 2xl:hidden">Excel</span>
                <span className="hidden 2xl:inline">Excel Smeta</span>
              </button>

              {!currentUser ? (
                <button
                  type="button"
                  onClick={() => navigate('/login')}
                  className="min-h-[36px] px-2.5 md:px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-[11px] rounded-xl shadow-sm transition-all font-sans whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Kirish
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => navigate('/admin')}
                    aria-label="Iqtisodchi Paneli"
                    className="min-h-[36px] px-2 md:px-2.5 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-bold text-[11px] rounded-xl transition-colors flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Settings2 className="w-3.5 h-3.5 shrink-0" />
                    <span className="hidden sm:inline 2xl:hidden">Panel</span>
                    <span className="hidden 2xl:inline">Iqtisodchi Paneli</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => auth.signOut()}
                    aria-label="Tizimdan chiqish"
                    className="min-h-[36px] min-w-[36px] px-2 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-600 font-bold text-[11px] rounded-xl transition-colors flex items-center justify-center shrink-0 cursor-pointer"
                    title="Tizimdan chiqish"
                  >
                    <LogOut className="w-4 h-4" />
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Mobile Search & Nearby Bar */}
          <div className="pointer-events-auto md:hidden relative w-full">
            <div className="flex items-center gap-1.5">
              <div className={`flex-1 min-w-0 min-h-[46px] bg-white/95 backdrop-blur-md rounded-2xl shadow-xl border border-slate-200/80 flex items-center pl-3 pr-1 transition-all ${isSearchFocused ? 'ring-4 ring-blue-500/20 border-blue-500' : ''}`}>
                <Search className="w-4 h-4 text-slate-400 mr-2 shrink-0" />
                <input
                  ref={mobileSearchInputRef}
                  type="text"
                  placeholder="9 bog'cha, 4 maktab..."
                  className="w-full min-w-0 min-h-[42px] bg-transparent outline-none text-sm font-semibold text-slate-900 placeholder:text-slate-400 placeholder:font-normal"
                  value={searchQuery}
                  onChange={(e) => handleSearch(e.target.value)}
                  onFocus={() => setIsSearchFocused(true)}
                  onBlur={() => setTimeout(() => setIsSearchFocused(false), 260)}
                />
                {searchQuery && (
                  <button
                    type="button"
                    onMouseDown={(e) => { e.preventDefault(); setSearchQuery(''); setSearchResults([]); }}
                    className="min-w-[36px] min-h-[36px] flex items-center justify-center text-slate-400 hover:bg-slate-100 rounded-xl shrink-0"
                    aria-label="Tozalash"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
                <button
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); toggleVoiceSearch(); }}
                  className={`min-w-[38px] min-h-[38px] flex items-center justify-center rounded-xl transition-colors shrink-0 ${
                    isListeningVoice ? 'bg-rose-500 text-white animate-pulse' : 'text-blue-600 hover:bg-blue-50'
                  }`}
                  title="Ovozli qidiruv"
                  aria-label="Ovozli qidiruv"
                >
                  {isListeningVoice ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                </button>
              </div>

              <button
                type="button"
                onClick={openNearbyPanel}
                className="min-h-[46px] px-3 rounded-2xl bg-slate-900 hover:bg-slate-800 text-white font-extrabold text-xs shadow-xl border border-slate-800 flex items-center gap-1.5 shrink-0 active:scale-95 transition-transform cursor-pointer"
                title="Eng yaqin maktab va bog'chalar"
              >
                <LocateFixed className="w-4 h-4 text-sky-400 shrink-0" />
                <span>Yaqinlar</span>
              </button>
            </div>

            {/* Mobile Search Results */}
            {isSearchFocused && (searchResults.length > 0 || multiSearchOrdered.length >= 2) && (
              <div className="mt-2 bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden max-h-[60vh] overflow-y-auto divide-y divide-slate-100">
                {multiSearchOrdered.length >= 2 && (
                  <div
                    className="p-3 bg-emerald-50 border-b border-emerald-200 space-y-2"
                    onMouseDown={(e) => e.preventDefault()}
                  >
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[10px] font-black text-emerald-800 uppercase">
                        Ko'p manzilli ({multiSearchOrdered.length}):
                      </span>
                      {multiSearchOrdered.map((m, idx) => (
                        <span key={m.id} className="text-[11px] font-bold bg-white text-slate-900 px-2 py-0.5 rounded-lg border border-emerald-200">
                          {idx + 1}. {m.name}
                        </span>
                      ))}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <a
                        href={buildYandexMapsUrl(multiSearchOrdered, userLocation, true)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="min-h-[42px] px-3 rounded-xl bg-orange-500 hover:bg-orange-600 text-white font-extrabold text-xs flex items-center justify-center no-underline"
                      >
                        Yandex
                      </a>
                      <a
                        href={buildGoogleMapsUrl(multiSearchOrdered, userLocation, true)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="min-h-[42px] px-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-extrabold text-xs flex items-center justify-center no-underline"
                      >
                        Google
                      </a>
                      <button
                        type="button"
                        onClick={() => {
                          setSearchQuery('');
                          setSearchResults([]);
                          setIsSearchFocused(false);
                          handleWidgetBuildRouteFromGps(multiSearchOrdered, false);
                        }}
                        className="flex-1 min-h-[42px] px-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-black text-xs cursor-pointer"
                      >
                        📍 Joylashuvimdan chizish
                      </button>
                    </div>
                  </div>
                )}
                {searchResults.map(res => (
                  <div
                    key={res.id}
                    onMouseDown={(e) => { e.preventDefault(); handleSearchSelect(res); }}
                    className="px-3.5 py-3 hover:bg-slate-50 transition-colors flex items-center justify-between gap-2 cursor-pointer"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-extrabold text-slate-900 text-sm leading-snug">{res.name}</span>
                        {res.distanceKm !== undefined && (
                          <span className="text-[10px] font-extrabold text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded-md">
                            {res.distanceKm.toFixed(1)} km
                          </span>
                        )}
                      </div>
                      <div className="flex items-center space-x-1.5 mt-1 flex-wrap">
                        <span className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">
                          {res.type === 'dmtt' || res.type === 'bogcha' ? "Bog'cha" : res.type === 'maktab' ? "Maktab" : "Boshqa"}
                        </span>
                        {res.mahalla && (
                          <span className="text-[10px] font-bold text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded">{res.mahalla}</span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0" onMouseDown={(e) => e.preventDefault()} onClick={(e) => e.stopPropagation()}>
                      <a
                        href={buildYandexMapsUrl([res], userLocation, true)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="min-h-[44px] px-2.5 rounded-xl bg-orange-500 hover:bg-orange-600 text-white font-extrabold text-[11px] flex items-center justify-center no-underline active:scale-95"
                        title="Yandex Navigatsiyada ochish"
                      >
                        Yandex
                      </a>
                      <a
                        href={buildGoogleMapsUrl([res], userLocation, true)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="min-h-[44px] px-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-extrabold text-[11px] flex items-center justify-center no-underline active:scale-95"
                        title="Google Maps da ochish"
                      >
                        Google
                      </a>
                      <button
                        type="button"
                        onClick={() => {
                          handleMarkerClick(res);
                          showToast(`${res.name} marshrutga qo'shildi`, 'success');
                        }}
                        className="min-w-[44px] min-h-[44px] rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 font-black text-base flex items-center justify-center active:scale-95"
                        title="Marshrutga qo'shish"
                      >
                        +
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Desktop Search Bar (flex sibling on xl+, stacked below header on md-lg, never overlaps!) */}
          <div className="pointer-events-auto hidden md:block relative flex-1 min-w-0 max-w-xl">
            <div className="flex items-center gap-2">
              <div className={`flex-1 min-w-0 relative bg-white/95 backdrop-blur-md rounded-2xl shadow-xl border border-slate-100 flex items-center pl-3.5 pr-1.5 py-1.5 transition-colors ${isSearchFocused ? 'ring-4 ring-blue-500/20 border-blue-500' : ''}`}>
                <Search className="w-4 h-4 text-slate-400 mr-2.5 shrink-0" />
                <input
                  ref={desktopSearchInputRef}
                  type="text"
                  placeholder="Qidiruv: 9 bog'cha yoki 4 maktab, 9 bog'cha..."
                  className="w-full min-w-0 bg-transparent outline-none text-sm font-semibold text-slate-900 placeholder:text-slate-400 placeholder:font-normal py-1"
                  value={searchQuery}
                  onChange={(e) => handleSearch(e.target.value)}
                  onFocus={() => setIsSearchFocused(true)}
                  onBlur={() => setTimeout(() => setIsSearchFocused(false), 260)}
                />
                {searchQuery && (
                  <button
                    type="button"
                    aria-label="Qidiruvni tozalash"
                    onMouseDown={(e) => { e.preventDefault(); setSearchQuery(''); setSearchResults([]); }}
                    className="p-1.5 text-slate-400 hover:bg-slate-100 rounded-full cursor-pointer shrink-0"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
                <button
                  type="button"
                  aria-label="Ovozli qidiruv"
                  onMouseDown={(e) => { e.preventDefault(); toggleVoiceSearch(); }}
                  className={`p-2 rounded-xl transition-colors cursor-pointer shrink-0 ${
                    isListeningVoice ? 'bg-rose-500 text-white animate-pulse' : 'text-blue-600 hover:bg-blue-50'
                  }`}
                  title="Ovozli qidiruv"
                >
                  {isListeningVoice ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                </button>
              </div>
              <button
                type="button"
                onClick={openNearbyPanel}
                className="min-h-[44px] px-3.5 rounded-2xl bg-slate-900 hover:bg-slate-800 text-white font-extrabold text-xs shadow-xl border border-slate-800 flex items-center gap-1.5 shrink-0 cursor-pointer active:scale-95 transition-all"
                title="Eng yaqin maktab va bog'chalarni topish"
              >
                <LocateFixed className="w-4 h-4 text-sky-400 shrink-0" />
                <span>Yaqinlar</span>
              </button>
            </div>
            {isSearchFocused && (searchResults.length > 0 || multiSearchOrdered.length >= 2) && (
              <div className="absolute top-full left-0 w-full mt-2 bg-white rounded-2xl shadow-2xl border border-slate-100 overflow-hidden animate-in fade-in slide-in-from-top-2 divide-y divide-slate-100 max-h-[60vh] overflow-y-auto z-50">
                {multiSearchOrdered.length >= 2 && (
                  <div
                    className="p-3 bg-emerald-50 border-b border-emerald-200 space-y-2"
                    onMouseDown={(e) => e.preventDefault()}
                  >
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[10px] font-black text-emerald-800 uppercase">
                        Ko'p manzilli ({multiSearchOrdered.length}):
                      </span>
                      {multiSearchOrdered.map((m, idx) => (
                        <span key={m.id} className="text-[11px] font-bold bg-white text-slate-900 px-2 py-0.5 rounded-lg border border-emerald-200">
                          {idx + 1}. {m.name}
                        </span>
                      ))}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <a
                        href={buildYandexMapsUrl(multiSearchOrdered, userLocation, true)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="px-3 py-2 rounded-xl bg-orange-500 hover:bg-orange-600 text-white font-extrabold text-xs no-underline"
                      >
                        Yandex
                      </a>
                      <a
                        href={buildGoogleMapsUrl(multiSearchOrdered, userLocation, true)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="px-3 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-extrabold text-xs no-underline"
                      >
                        Google
                      </a>
                      <button
                        type="button"
                        onClick={() => {
                          setSearchQuery('');
                          setSearchResults([]);
                          setIsSearchFocused(false);
                          handleWidgetBuildRouteFromGps(multiSearchOrdered, false);
                        }}
                        className="flex-1 px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-black text-xs cursor-pointer"
                      >
                        📍 Joylashuvimdan xaritada chizish
                      </button>
                    </div>
                  </div>
                )}
                {searchResults.map(res => (
                  <div
                    key={res.id}
                    onMouseDown={(e) => { e.preventDefault(); handleSearchSelect(res); }}
                    className="px-4 py-3 hover:bg-slate-50 transition-colors flex items-center justify-between gap-2 cursor-pointer"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-slate-800 text-sm leading-tight">{res.name}</span>
                        {res.distanceKm !== undefined && (
                          <span className="text-[10px] font-extrabold text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded-md">
                            {res.distanceKm.toFixed(1)} km
                          </span>
                        )}
                      </div>
                      <div className="flex items-center space-x-2 mt-1">
                        <span className="text-[9px] uppercase tracking-wider text-slate-400 font-bold">{res.type === 'dmtt' || res.type === 'bogcha' ? "Bog'cha" : res.type === 'maktab' ? "Maktab" : "Boshqa"}</span>
                        {res.mahalla && (
                          <>
                            <span className="w-1 h-1 rounded-full bg-slate-200"></span>
                            <span className="text-[9px] font-bold text-indigo-500 bg-indigo-50 px-1 rounded">{res.mahalla}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0" onMouseDown={(e) => e.preventDefault()} onClick={(e) => e.stopPropagation()}>
                      <a
                        href={buildYandexMapsUrl([res], userLocation, true)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="px-2.5 py-1.5 rounded-lg bg-orange-500 hover:bg-orange-600 text-white font-bold text-[11px] no-underline"
                      >
                        Yandex
                      </a>
                      <a
                        href={buildGoogleMapsUrl([res], userLocation, true)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="px-2.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold text-[11px] no-underline"
                      >
                        Google
                      </a>
                      <button
                        type="button"
                        onClick={() => {
                          handleMarkerClick(res);
                          showToast(`${res.name} marshrutga qo'shildi`, 'success');
                        }}
                        className="w-7 h-7 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-800 font-black text-sm flex items-center justify-center cursor-pointer"
                        title="Marshrutga qo'shish"
                      >
                        +
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Desktop Left-Aligned Quick Map Tools (stacked cleanly below top bar via flex flow, zero overlap) */}
        <div className="hidden md:flex flex-col items-start gap-2.5 pointer-events-none">
          {(!isPickingLocation && !isPickingRoutePoint && currentUser) && (
            <button
              type="button"
              onClick={() => setIsAddModalOpen(true)}
              className="pointer-events-auto bg-white/95 backdrop-blur-md hover:bg-white text-slate-800 pr-4 pl-2 py-2 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] border border-slate-100 flex items-center space-x-2.5 transition-all hover:scale-105 active:scale-95 group cursor-pointer"
            >
              <div className="w-8 h-8 rounded-full bg-blue-50 flex items-center justify-center group-hover:bg-blue-100 transition-colors">
                <Plus className="w-4 h-4 text-blue-600" />
              </div>
              <span className="font-bold text-sm tracking-tight text-slate-700 group-hover:text-slate-900">Yangi ob'ekt</span>
            </button>
          )}

          <button
            type="button"
            onClick={handleGetLocation}
            title="Mening joylashuvimni aniqlash va xaritada ko'rsatish"
            className="pointer-events-auto bg-white/95 backdrop-blur-md hover:bg-white text-slate-800 pr-4 pl-2 py-2 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] border border-slate-100 flex items-center space-x-2.5 transition-all hover:scale-105 active:scale-95 group cursor-pointer"
          >
            <div className="w-8 h-8 rounded-full bg-blue-50 flex items-center justify-center group-hover:bg-blue-100 transition-colors shrink-0">
              <LocateFixed className="w-4 h-4 text-blue-600 group-hover:text-blue-700 transition-colors" />
            </div>
            <span className="font-bold text-xs md:text-sm tracking-tight text-slate-700 group-hover:text-slate-900 text-left leading-tight font-sans">
              Joylashuvni aniqlash
              <br />
              <span className="text-[10px] font-normal text-slate-500">xaritadan topish</span>
            </span>
          </button>
        </div>
      </div>

      {/* Nearby ("Yaqin atrofdagilar") Quick Drawer */}
      {isNearbyOpen && (
        <div
          className="print:hidden fixed inset-0 z-[950] bg-slate-900/50 backdrop-blur-sm flex items-end md:items-center justify-center p-0 md:p-4 animate-in fade-in duration-150"
          onClick={(e) => {
            if (e.target === e.currentTarget) setIsNearbyOpen(false);
          }}
        >
          <div className="w-full md:max-w-lg bg-white rounded-t-3xl md:rounded-3xl shadow-2xl border border-slate-100 max-h-[85vh] flex flex-col overflow-hidden">
            <div className="p-4 sm:p-5 border-b border-slate-100 flex items-center justify-between bg-slate-50/70 shrink-0">
              <div className="flex items-center gap-2.5">
                <div className="w-10 h-10 rounded-2xl bg-slate-900 text-sky-400 flex items-center justify-center shrink-0">
                  <LocateFixed className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-extrabold text-base text-slate-900">Eng yaqin muassasalar</h3>
                  <p className="text-[11px] text-slate-500 font-medium">
                    {userLocation ? "Sizning GPS joylashuvingiz bo'yicha saralandi" : "GPS kutilmoqda (tuman markazi bo'yicha)"}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsNearbyOpen(false)}
                className="w-10 h-10 rounded-full bg-white border border-slate-200 text-slate-500 hover:text-slate-800 flex items-center justify-center cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 space-y-3 border-b border-slate-100 shrink-0">
              {!userLocation && (
                <button
                  type="button"
                  onClick={handleGetLocation}
                  className="w-full min-h-[44px] px-4 py-2 rounded-xl bg-blue-50 hover:bg-blue-100 border border-blue-200 text-blue-700 font-bold text-xs flex items-center justify-center gap-2 cursor-pointer"
                >
                  <LocateFixed className="w-4 h-4" />
                  <span>📍 Mening hozirgi GPS joylashuvimni aniqlash</span>
                </button>
              )}

              <div className="grid grid-cols-3 gap-1.5 bg-slate-100 p-1 rounded-xl">
                <button
                  type="button"
                  onClick={() => setNearbyFilter('all')}
                  className={`min-h-[40px] rounded-lg text-xs font-extrabold transition-all cursor-pointer ${nearbyFilter === 'all' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}
                >
                  Barchasi
                </button>
                <button
                  type="button"
                  onClick={() => setNearbyFilter('maktab')}
                  className={`min-h-[40px] rounded-lg text-xs font-extrabold transition-all cursor-pointer ${nearbyFilter === 'maktab' ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500'}`}
                >
                  Maktablar
                </button>
                <button
                  type="button"
                  onClick={() => setNearbyFilter('dmtt')}
                  className={`min-h-[40px] rounded-lg text-xs font-extrabold transition-all cursor-pointer ${nearbyFilter === 'dmtt' ? 'bg-white text-rose-600 shadow-sm' : 'text-slate-500'}`}
                >
                  Bog'chalar
                </button>
              </div>

              {(() => {
                const pool = locations.filter(l => {
                  if (nearbyFilter === 'maktab') return l.type === 'maktab';
                  if (nearbyFilter === 'dmtt') return l.type === 'dmtt' || l.type === 'bogcha';
                  return true;
                });
                return (
                  <button
                    type="button"
                    onClick={() => handleQuickNearestRoute(pool)}
                    disabled={pool.length === 0}
                    className="w-full min-h-[46px] px-4 py-2.5 rounded-2xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-extrabold text-xs shadow-lg shadow-indigo-600/20 flex items-center justify-center gap-2 active:scale-98 transition-all cursor-pointer"
                  >
                    <Zap className="w-4 h-4 text-amber-300 shrink-0" />
                    <span>Eng yaqin 5 tasiga navbat bilan marshrut tuzish</span>
                  </button>
                );
              })()}
            </div>

            <div className="flex-1 overflow-y-auto p-3 sm:p-4 space-y-2">
              {(() => {
                const refLat = userLocation ? userLocation[0] : center[0];
                const refLng = userLocation ? userLocation[1] : center[1];
                const nearbyItems = locations
                  .filter(l => {
                    if (nearbyFilter === 'maktab') return l.type === 'maktab';
                    if (nearbyFilter === 'dmtt') return l.type === 'dmtt' || l.type === 'bogcha';
                    return true;
                  })
                  .map(l => ({
                    ...l,
                    distKm: haversineDistanceKm(refLat, refLng, l.lat, l.lng)
                  }))
                  .sort((a, b) => a.distKm - b.distKm)
                  .slice(0, 8);

                if (nearbyItems.length === 0) {
                  return (
                    <div className="text-center py-8 text-xs text-slate-400 font-semibold">
                      Ob'ektlar topilmadi
                    </div>
                  );
                }

                return nearbyItems.map((loc, idx) => (
                  <div
                    key={loc.id}
                    className="p-3 rounded-2xl border border-slate-200 bg-white flex items-center justify-between gap-2 shadow-sm"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[11px] font-black text-slate-400">#{idx + 1}</span>
                        <span className="font-extrabold text-sm text-slate-900 truncate">{loc.name}</span>
                        <span className="text-[11px] font-extrabold text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded-md">
                          {loc.distKm.toFixed(1)} km
                        </span>
                      </div>
                      {loc.mahalla && (
                        <p className="text-[11px] text-slate-500 font-medium truncate mt-0.5">{loc.mahalla}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <a
                        href={buildYandexMapsUrl([loc], userLocation, true)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="min-h-[44px] px-3 rounded-xl bg-orange-500 hover:bg-orange-600 text-white font-extrabold text-xs flex items-center justify-center no-underline active:scale-95"
                      >
                        Yandex
                      </a>
                      <a
                        href={buildGoogleMapsUrl([loc], userLocation, true)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="min-h-[44px] px-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-extrabold text-xs flex items-center justify-center no-underline active:scale-95"
                      >
                        Google
                      </a>
                      <button
                        type="button"
                        onClick={() => {
                          handleMarkerClick(loc);
                          showToast(`${loc.name} marshrutga qo'shildi`, 'success');
                        }}
                        className="min-w-[44px] min-h-[44px] rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 font-black text-base flex items-center justify-center cursor-pointer"
                        title="Marshrutga qo'shish"
                      >
                        +
                      </button>
                    </div>
                  </div>
                ));
              })()}
            </div>
          </div>
        </div>
      )}

      {/* Offline Banner */}
      <OfflineIndicator />

      {/* Toast Notification */}
      {toastMessage && (
        <div className={`print:hidden absolute bottom-36 md:bottom-24 left-1/2 transform -translate-x-1/2 md:left-6 md:translate-x-0 z-[600] px-4 md:px-6 py-2 md:py-3 rounded-xl text-xs md:text-sm font-bold shadow-2xl transition-all animate-in fade-in slide-in-from-bottom-4 ${toastMessage.type === 'success' ? 'bg-green-500 text-white' : toastMessage.type === 'info' ? 'bg-slate-800 text-white' : 'bg-red-500 text-white'}`}>
          {toastMessage.text}
        </div>
      )}



      {/* Picking Mode Overlay */}
      {(isPickingLocation || isPickingRoutePoint) && (
        <div className="print:hidden absolute top-20 md:top-6 left-1/2 transform -translate-x-1/2 z-[400] bg-slate-900 text-white px-4 md:px-6 py-2 md:py-3 rounded-full flex items-center space-x-2 md:space-x-3 shadow-2xl hover:bg-slate-800 transition-colors w-[90%] md:w-auto justify-center">
          <MousePointer2 className="w-4 h-4 md:w-5 md:h-5 text-blue-400 animate-pulse shrink-0" />
          <span className="font-semibold text-xs md:text-sm truncate">Xaritadan joylashuvni chertib tanlang...</span>
          <div className="w-px h-3 md:h-4 bg-slate-700 mx-1 shrink-0"></div>
          <button onClick={() => { 
            if (isPickingRoutePoint) {
               setIsPickingRoutePoint(false);
            } else {
               setIsPickingLocation(false); 
               if (editingLocation) {
                   setIsEditModalOpen(true);
               } else {
                   setIsAddModalOpen(true); 
               }
            }
          }} className="text-[10px] md:text-xs text-slate-300 hover:text-white font-bold transition-colors whitespace-nowrap shrink-0">
            Bekor qilish
          </button>
        </div>
      )}

      {/* Add Location Button */}
      {/* Desktop quick tools moved into unified top stack above to prevent overlap */}

      {/* Modal - Add/Edit Location */}
      {(isAddModalOpen || isEditModalOpen) && currentUser && (
        <div 
          className="absolute inset-0 z-[500] bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200 print:hidden"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
                setIsAddModalOpen(false);
                setIsEditModalOpen(false);
            }
          }}
        >
          <div className="bg-white rounded-[2rem] shadow-2xl border border-slate-100 max-w-md w-full max-h-[90vh] flex flex-col animate-in zoom-in-95 duration-200">
            <div className="p-6 pb-4 border-b border-slate-100 flex justify-between items-center shrink-0">
              <h2 className="text-lg font-extrabold text-slate-900 tracking-tight">
                  {isEditModalOpen ? (role === 'admin' ? "Ob'ektni tahrirlash" : "Tahrirlash taklifi") : "Yangi ob'ekt qo'shish"}
              </h2>
              <button 
                onClick={() => { setIsAddModalOpen(false); setIsEditModalOpen(false); }} 
                className="w-8 h-8 flex items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
                >
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <form onSubmit={isEditModalOpen ? handleEditLocation : handleAddLocation} className="p-6 space-y-5 overflow-y-auto">
              <div>
                <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Nomi</label>
                <input 
                  type="text" 
                  value={newLocName}
                  onChange={(e) => setNewLocName(e.target.value)}
                  placeholder="Masalan: 12-maktab" 
                  className="w-full px-4 py-3.5 rounded-xl bg-slate-50 border border-slate-200 focus:bg-white focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500 outline-none transition-all text-sm font-semibold text-slate-900 placeholder:text-slate-400 placeholder:font-normal"
                />
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Yaqinidagi taniqli joy (Mo'ljal)</label>
                <input 
                  type="text" 
                  value={newLocLandmark}
                  onChange={(e) => setNewLocLandmark(e.target.value)}
                  placeholder="Masalan: Katta bozor yonida" 
                  className="w-full px-4 py-3.5 rounded-xl bg-slate-50 border border-slate-200 focus:bg-white focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500 outline-none transition-all text-sm font-semibold text-slate-900 placeholder:text-slate-400 placeholder:font-normal"
                />
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Mahalla (MFY)</label>
                <input 
                  type="text" 
                  value={newLocMahalla}
                  onChange={(e) => setNewLocMahalla(e.target.value)}
                  placeholder="Masalan: Navbahor MFY" 
                  className="w-full px-4 py-3.5 rounded-xl bg-slate-50 border border-slate-200 focus:bg-white focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500 outline-none transition-all text-sm font-semibold text-slate-900 placeholder:text-slate-400 placeholder:font-normal"
                />
              </div>

              {/* NGIS Smart Lookup Box */}
              <div className="bg-gradient-to-br from-blue-50 to-indigo-50/70 p-3.5 rounded-2xl border border-blue-200">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-extrabold text-blue-900 flex items-center gap-1">
                    <Sparkles className="w-3.5 h-3.5 text-blue-600" />
                    open.ngis.uz Geoportal
                  </span>
                  <button
                    type="button"
                    disabled={isNgisFetching}
                    onClick={() => handleFetchNgisCadastre()}
                    className="px-3 py-1 text-[10px] font-extrabold bg-blue-600 hover:bg-blue-700 text-white rounded-xl transition-all shadow-sm active:scale-95 disabled:opacity-50 flex items-center gap-1 cursor-pointer"
                  >
                    {isNgisFetching ? (
                      <span className="flex items-center gap-1">
                        <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                        Olinmoqda...
                      </span>
                    ) : (
                      "⚡ NGIS Avto-Izlash"
                    )}
                  </button>
                </div>
                <p className="text-[10px] text-blue-700 font-medium leading-normal">
                  Koordinata va ob'ekt nomi orqali NGIS Ochiq Geoportalidan Kadastr raqami, manzil hamda yer/bino maydonlarini avtomatik yuklaydi.
                </p>
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Kadastr raqami</label>
                <input 
                  type="text" 
                  value={newLocCadastre}
                  onChange={(e) => setNewLocCadastre(e.target.value)}
                  placeholder="Masalan: 14:01:41:02:01:0084" 
                  className="w-full px-4 py-3.5 rounded-xl bg-slate-50 border border-slate-200 focus:bg-white focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500 outline-none transition-all text-sm font-mono font-semibold text-slate-900 placeholder:text-slate-400 placeholder:font-normal"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Yer maydoni (kv.m)</label>
                  <input 
                    type="number" step="any"
                    value={newLocTotalLandArea}
                    onChange={(e) => setNewLocTotalLandArea(e.target.value === '' ? '' : parseFloat(e.target.value))}
                    placeholder="Masalan: 5300" 
                    className="w-full px-4 py-3 rounded-xl bg-slate-50 border border-slate-200 text-slate-800 outline-none focus:border-blue-500 focus:bg-white text-xs font-semibold transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Bino osti (kv.m)</label>
                  <input 
                    type="number" step="any"
                    value={newLocBuildingFootprintArea}
                    onChange={(e) => setNewLocBuildingFootprintArea(e.target.value === '' ? '' : parseFloat(e.target.value))}
                    placeholder="Masalan: 1640" 
                    className="w-full px-4 py-3 rounded-xl bg-slate-50 border border-slate-200 text-slate-800 outline-none focus:border-blue-500 focus:bg-white text-xs font-semibold transition-colors"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Turi</label>
                <select 
                  value={newLocType}
                  onChange={(e) => setNewLocType(e.target.value)}
                  className="w-full px-4 py-3.5 rounded-xl bg-slate-50 border border-slate-200 focus:bg-white focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500 outline-none transition-all text-sm font-semibold text-slate-900 cursor-pointer"
                >
                  <option value="maktab">Maktab (Umumiy ta'lim)</option>
                  <option value="dmtt">Bog'cha (DMTT)</option>
                  <option value="boshqa">Boshqa (Hokimiyat, va h.k.)</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Kenglik (Lat)</label>
                  <input 
                    type="number" step="any"
                    value={newLocLat}
                    onChange={(e) => setNewLocLat(e.target.value === '' ? '' : parseFloat(e.target.value))}
                    placeholder="..." 
                    className="w-full px-4 py-3.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-700 outline-none focus:border-blue-400 focus:bg-white text-xs font-mono font-bold transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Uzunlik (Lng)</label>
                  <input 
                    type="number" step="any"
                    value={newLocLng}
                    onChange={(e) => setNewLocLng(e.target.value === '' ? '' : parseFloat(e.target.value))}
                    placeholder="..." 
                    className="w-full px-4 py-3.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-700 outline-none focus:border-blue-400 focus:bg-white text-xs font-mono font-bold transition-colors"
                  />
                </div>
              </div>

              {(newLocType === 'maktab' || newLocType === 'bogcha' || newLocType === 'dmtt') && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Sig'imi (O'rin)</label>
                    <input 
                      type="number" step="any"
                      value={newLocCapacity}
                      onChange={(e) => setNewLocCapacity(e.target.value === '' ? '' : parseFloat(e.target.value))}
                      placeholder="0" 
                      className="w-full px-4 py-3.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-700 outline-none focus:border-blue-400 focus:bg-white text-sm font-semibold transition-colors"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Maydoni (Ga)</label>
                    <input 
                      type="number" step="any"
                      value={newLocArea}
                      onChange={(e) => setNewLocArea(e.target.value === '' ? '' : parseFloat(e.target.value))}
                      placeholder="0.0" 
                      className="w-full px-4 py-3.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-700 outline-none focus:border-blue-400 focus:bg-white text-sm font-semibold transition-colors"
                    />
                  </div>
                </div>
              )}

              <button 
                type="button"
                onClick={() => { setIsAddModalOpen(false); setIsEditModalOpen(false); setIsPickingLocation(true); }}
                className="w-full py-3 bg-blue-50 hover:bg-blue-100 text-blue-600 font-bold text-sm rounded-xl border border-blue-100 transition-colors flex justify-center items-center space-x-2"
              >
                <MapPin className="w-4 h-4" />
                <span>Xaritadan tanlash</span>
              </button>

              <div className="pt-4 border-t border-slate-100 mt-2">
                <button 
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full relative py-4 bg-slate-900 hover:bg-slate-800 text-white font-bold text-sm rounded-xl shadow-[0_4px_14px_0_rgb(0,0,0,0.39)] hover:shadow-[0_6px_20px_rgba(0,0,0,0.23)] hover:shadow-slate-900/40 transition-all active:scale-95 disabled:opacity-70 disabled:shadow-none flex items-center justify-center overflow-hidden mb-4"
                >
                  {isSubmitting ? (
                    <span className="flex items-center">
                       <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin mr-2"></div>
                       Saqlanmoqda
                    </span>
                  ) : (
                    isEditModalOpen && role !== 'admin' ? "Taklif yuborish" : "Saqlash"
                  )}
                </button>
                
                {/* Bulk Import */}
                <div className="pt-4 border-t border-slate-100">
                  <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3 flex items-center justify-center"><UploadCloud className="w-3 h-3 mr-1.5"/> Ommaviy yuklash (CSV)</h3>
                  <input 
                    type="file" 
                    accept=".csv" 
                    ref={fileInputRef} 
                    onChange={handleBulkUpload} 
                    className="hidden" 
                  />
                  <button 
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isUploadingCSV}
                    className="w-full py-3 bg-emerald-50 hover:bg-emerald-100 text-emerald-600 border border-emerald-200 font-bold text-sm rounded-xl transition-colors flex justify-center items-center space-x-2 mb-2"
                  >
                    {isUploadingCSV ? (
                      <>
                        <div className="w-4 h-4 border-2 border-emerald-600/30 border-t-emerald-600 rounded-full animate-spin"></div>
                        <span>Yuklanmoqda...</span>
                      </>
                    ) : (
                      <>
                        <UploadCloud className="w-4 h-4" />
                        <span>📁 Excel (CSV) orqali yuklash</span>
                      </>
                    )}
                  </button>
                  <div className="text-center">
                    <a href="data:text/csv;charset=utf-8,name,type,lat,lng%0A1-maktab,maktab,39.6543,66.9754%0A5-bog'cha,bogcha,39.6600,66.9800%0AMarkaziy shifoxona,boshqa,39.6680,66.9900" download="namuna.csv" className="text-[11px] font-bold text-indigo-500 hover:text-indigo-600 underline">
                      namuna.csv yuklab olish
                    </a>
                  </div>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Settings Modal */}
      {isSettingsOpen && (
        <div 
          className="absolute inset-0 z-[600] bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200 print:hidden"
          onClick={(e) => {
            if (e.target === e.currentTarget) setIsSettingsOpen(false);
          }}
        >
          <div className="bg-white rounded-[2rem] shadow-2xl border border-slate-100 max-w-md w-full max-h-[90vh] flex flex-col animate-in zoom-in-95 duration-200">
             <div className="p-6 pb-4 border-b border-slate-100 flex justify-between items-center shrink-0">
                <h2 className="text-lg font-extrabold text-slate-900 tracking-tight flex items-center">
                  <Settings2 className="w-5 h-5 mr-2 text-indigo-600"/> 
                  Sozlamalar
                </h2>
                <button onClick={() => setIsSettingsOpen(false)} className="w-8 h-8 flex items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors">
                  <X className="w-5 h-5" />
                </button>
             </div>
             <div className="p-6 space-y-6 overflow-y-auto">
                {/* Map Type Switcher */}
                <div>
                   <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3 flex items-center"><MapIcon className="w-3 h-3 mr-1.5"/> Xarita Ko'rinishi</h3>
                   <div className="grid grid-cols-2 gap-2">
                      <button 
                         onClick={() => setMapSource('osm')}
                         className={`px-3 py-2 rounded-xl text-xs font-bold border transition-all ${mapSource === 'osm' ? 'bg-indigo-50 border-indigo-400 text-indigo-700' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`}
                      >
                         OpenStreetMap
                      </button>
                      <button 
                         onClick={() => setMapSource('google')}
                         className={`px-3 py-2 rounded-xl text-xs font-bold border transition-all ${mapSource === 'google' ? 'bg-indigo-50 border-indigo-400 text-indigo-700' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`}
                      >
                         Google Maps
                      </button>
                      <button 
                         onClick={() => setMapSource('google_sat')}
                         className={`px-3 py-2 rounded-xl text-xs font-bold border transition-all ${mapSource === 'google_sat' ? 'bg-indigo-50 border-indigo-400 text-indigo-700' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`}
                      >
                         Google Sun'iy yo'ldosh
                      </button>
                      <button 
                         onClick={() => setMapSource('yandex')}
                         className={`px-3 py-2 rounded-xl text-xs font-bold border transition-all ${mapSource === 'yandex' ? 'bg-indigo-50 border-indigo-400 text-indigo-700' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`}
                      >
                         Yandex Maps
                      </button>
                   </div>
                </div>

                {/* Radius Analysis */}
                <div>
                   <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3 flex items-center"><Target className="w-3 h-3 mr-1.5"/> Radius Analizi (Qamrov)</h3>
                   <div className="space-y-3">
                      <div className="flex items-center space-x-2">
                          <input 
                              type="number" 
                              min="1"
                              max="100"
                              placeholder="Radius (km)" 
                              className="w-full px-4 py-2.5 rounded-xl bg-slate-50 border border-slate-200 focus:bg-white focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all text-sm font-semibold text-slate-900"
                              value={radiusKm}
                              onChange={(e) => setRadiusKm(Number(e.target.value))}
                          />
                          <span className="text-sm font-bold text-slate-500 shrink-0">km</span>
                      </div>
                      <Toggle 
                          label="Radius analizini yoqish" 
                          checked={isRadiusMode} 
                          onChange={(v) => {
                              setIsRadiusMode(v);
                              if (!v) setRadiusCenter(null);
                          }} 
                          color="bg-indigo-600" 
                      />
                      {isRadiusMode && (
                          <div className="text-xs text-slate-500 bg-indigo-50 p-3 rounded-lg border border-indigo-100 flex items-start mt-2">
                             <Target className="w-4 h-4 text-indigo-500 mr-2 shrink-0 mt-0.5" />
                             <p>Xaritadan istalgan nuqtani tanlasangiz, <b>{radiusKm} km</b> radiusdagi barcha ta'lim muassasalari soni hisoblanadi.</p>
                          </div>
                      )}
                   </div>
                </div>
                
                <div className="w-full h-px bg-slate-100"></div>

                {/* Area Search */}
                <div>
                    <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3 flex items-center"><Search className="w-3 h-3 mr-1.5"/> Maxsus hudud chegarasini izlab chizish</h3>
                    <p className="text-[10px] text-slate-500 font-medium mb-2">Biron mahalla yoki qishloq nomini kiriting. (OSM bazasida mavjud bo'lsa chiziladi)</p>
                    <div className="flex items-center space-x-2">
                        <input 
                            type="text" 
                            placeholder="Masalan: Oqtepa..." 
                            className="w-full px-4 py-2.5 rounded-xl bg-slate-50 border border-slate-200 focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-all text-sm font-semibold text-slate-900 placeholder:text-slate-400 placeholder:font-normal"
                            value={searchAreaQuery}
                            onChange={(e) => setSearchAreaQuery(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') searchAreaBoundary() }}
                        />
                        <button 
                            onClick={searchAreaBoundary}
                            disabled={isSearchingArea}
                            className="px-4 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-70 text-white font-bold text-sm rounded-xl transition-colors flex items-center shrink-0"
                        >
                            {isSearchingArea ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div> : "Chizish"}
                        </button>
                    </div>
                    {mahallaBoundary && (
                        <div className="mt-2 text-right">
                            <button 
                              onClick={() => { setMahallaBoundary(null); setSearchAreaQuery(''); }} 
                              className="text-[10px] text-red-500 hover:text-red-700 font-bold tracking-wider uppercase"
                            >
                              Chegarani tozalash
                            </button>
                        </div>
                    )}
                </div>
                
                <div className="w-full h-px bg-slate-100"></div>

                {/* Filters */}
                <div>
                   <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3 flex items-center"><Layers className="w-3 h-3 mr-1.5"/> Ob'ektlarni ko'rsatish</h3>
                   <div className="space-y-2">
                      <Toggle label="Maktablar" checked={filters.schools} onChange={(v) => setFilters({...filters, schools: v})} color="bg-blue-600" />
                      <Toggle label="Maktabgacha ta'lim (Bog'cha)" checked={filters.kindergartens} onChange={(v) => setFilters({...filters, kindergartens: v})} color="bg-rose-600" />
                      <Toggle label="Boshqa tashkilotlar" checked={filters.others} onChange={(v) => setFilters({...filters, others: v})} color="bg-emerald-600" />
                   </div>
                </div>
                
                <div className="w-full h-px bg-slate-100"></div>
     
                {/* Layers */}
                <div>
                   <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3 flex items-center"><MapIcon className="w-3 h-3 mr-1.5"/> Xarita qatlamlari</h3>
                   <div className="space-y-2">
                      <Toggle label="Tuman chegarasi (GeoJSON)" checked={layers.district} onChange={(v) => setLayers({...layers, district: v})} color="bg-indigo-600" />
                      <div className="flex items-center justify-between">
                         <Toggle label="Mahallalar chegarasi" checked={layers.neighborhoods} onChange={(v) => setLayers({...layers, neighborhoods: v})} color="bg-indigo-600" />
                         {isLoadingNeighborhoods && <span className="text-[10px] text-indigo-500 font-bold ml-2 animate-pulse">Yuklanmoqda...</span>}
                      </div>
                      <div className="flex items-center justify-between">
                         <Toggle label="Katta yo'llar (Highways)" checked={layers.highways} onChange={(v) => setLayers({...layers, highways: v})} color="bg-amber-500" />
                         {isLoadingHighways && <span className="text-[10px] text-amber-500 font-bold ml-2 animate-pulse">Yuklanmoqda...</span>}
                      </div>
                   </div>
                </div>
             </div>
          </div>
        </div>
      )}

      {/* Batch Select Modal (Full Page) */}
      {isBatchSelectModalOpen && (
        <div 
          className="fixed inset-0 z-[600] bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4 sm:p-6 md:p-12 animate-in fade-in duration-200 print:hidden"
          onClick={(e) => {
            if (e.target === e.currentTarget) setIsBatchSelectModalOpen(false);
          }}
        >
          <div className="bg-white rounded-3xl shadow-2xl w-full h-[90vh] md:h-full max-w-6xl overflow-hidden flex flex-col transform animate-in zoom-in-95 duration-200">
             <div className="p-5 flex items-center justify-between border-b border-slate-100 bg-slate-50/50">
               <div className="flex items-center space-x-2">
                 <div className="w-10 h-10 rounded-xl bg-indigo-100 text-indigo-600 flex items-center justify-center">
                    <Sparkles className="w-5 h-5" />
                 </div>
                 <div>
                   <h2 className="font-extrabold text-xl text-slate-900 tracking-tight">Kengaytirilgan tanlash paneli</h2>
                   <p className="text-xs text-slate-500 font-medium">Marshrut uchun ob'ektlarni tez va oson tanlang</p>
                 </div>
               </div>
               <button onClick={() => setIsBatchSelectModalOpen(false)} className="w-10 h-10 flex items-center justify-center rounded-full bg-white border border-slate-200 hover:bg-slate-100 text-slate-500 transition-colors shadow-sm">
                 <X className="w-5 h-5"/>
               </button>
             </div>
             
             <div className="flex-1 overflow-hidden flex flex-col md:flex-row">
                
                {/* Left Sidebar: Quick Actions */}
                <div className="w-full md:w-80 h-auto md:h-full border-b md:border-b-0 md:border-r border-slate-100 bg-slate-50/50 p-5 overflow-y-auto space-y-6 shrink-0">
                   <div>
                     <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3">Tezkor amallar</h3>
                     <div className="space-y-2">
                        <button 
                          onClick={() => {
                            const newAddition = locations.filter(loc => !selectedLocations.some(s => s.id === loc.id));
                            setSelectedLocations([...selectedLocations, ...newAddition]);
                            showToast(`${newAddition.length} ta manzil qo'shildi!`, 'success');
                          }}
                          className="w-full flex items-center justify-between p-3 rounded-xl border border-slate-200 bg-white hover:border-indigo-500 hover:bg-indigo-50 shadow-sm transition-all group"
                        >
                          <div className="flex items-center space-x-3">
                              <div className="w-8 h-8 rounded-full bg-slate-100 group-hover:bg-indigo-100 text-slate-500 group-hover:text-indigo-600 flex items-center justify-center">
                                <Layers className="w-4 h-4" />
                              </div>
                              <div className="text-left">
                                <div className="font-bold text-slate-900 text-sm">Barcha manzillar</div>
                                <div className="text-[10px] text-slate-500">Jami {locations.length} ta</div>
                              </div>
                          </div>
                          <Plus className="w-4 h-4 text-indigo-600 opacity-0 group-hover:opacity-100 transition-opacity" />
                        </button>

                        <button 
                          onClick={() => {
                            const newAddition = locations.filter(loc => loc.type === 'maktab' && !selectedLocations.some(s => s.id === loc.id));
                            setSelectedLocations([...selectedLocations, ...newAddition]);
                            showToast(`${newAddition.length} ta maktab qo'shildi!`, 'success');
                          }}
                          className="w-full flex items-center justify-between p-3 rounded-xl border border-slate-200 bg-white hover:border-blue-500 hover:bg-blue-50 shadow-sm transition-all group"
                        >
                          <div className="flex items-center space-x-3">
                              <div className="w-8 h-8 rounded-full bg-slate-100 group-hover:bg-blue-100 text-slate-500 group-hover:text-blue-600 flex items-center justify-center">
                                <div className="w-3 h-3 rounded-full bg-blue-600"></div>
                              </div>
                              <div className="text-left">
                                <div className="font-bold text-slate-900 text-sm">Faqat Maktablar</div>
                                <div className="text-[10px] text-slate-500">{locations.filter(l => l.type === 'maktab').length} ta</div>
                              </div>
                          </div>
                          <Plus className="w-4 h-4 text-blue-600 opacity-0 group-hover:opacity-100 transition-opacity" />
                        </button>

                        <button 
                          onClick={() => {
                            const newAddition = locations.filter(loc => (loc.type === 'dmtt' || loc.type === 'bogcha') && !selectedLocations.some(s => s.id === loc.id));
                            setSelectedLocations([...selectedLocations, ...newAddition]);
                            showToast(`${newAddition.length} ta bog'cha qo'shildi!`, 'success');
                          }}
                          className="w-full flex items-center justify-between p-3 rounded-xl border border-slate-200 bg-white hover:border-red-500 hover:bg-red-50 shadow-sm transition-all group"
                        >
                          <div className="flex items-center space-x-3">
                              <div className="w-8 h-8 rounded-full bg-slate-100 group-hover:bg-red-100 text-slate-500 group-hover:text-red-600 flex items-center justify-center">
                                <div className="w-3 h-3 rounded-full bg-red-500"></div>
                              </div>
                              <div className="text-left">
                                <div className="font-bold text-slate-900 text-sm">Faqat Bog'chalar</div>
                                <div className="text-[10px] text-slate-500">{locations.filter(l => l.type === 'dmtt' || l.type === 'bogcha').length} ta</div>
                              </div>
                          </div>
                          <Plus className="w-4 h-4 text-red-600 opacity-0 group-hover:opacity-100 transition-opacity" />
                        </button>

                        {isRadiusMode && radiusCenter && (
                          <button 
                            onClick={() => {
                              const inRadius = locations.filter(loc => {
                                const dist = getDistanceFromLatLonInKm(radiusCenter[0], radiusCenter[1], loc.lat, loc.lng);
                                return dist <= radiusKm;
                              });
                              const newAddition = inRadius.filter(loc => !selectedLocations.some(s => s.id === loc.id));
                              setSelectedLocations([...selectedLocations, ...newAddition]);
                              showToast(`${newAddition.length} ta manzil qo'shildi!`, 'success');
                            }}
                            className="w-full flex items-center justify-between p-3 rounded-xl border-2 border-indigo-200 bg-indigo-50 hover:bg-indigo-100 shadow-sm transition-all group"
                          >
                            <div className="flex items-center space-x-3">
                                <div className="w-8 h-8 rounded-full bg-indigo-100 text-indigo-600 flex items-center justify-center">
                                  <Target className="w-4 h-4" />
                                </div>
                                <div className="text-left">
                                  <div className="font-bold text-indigo-900 text-sm">Radiusdagi ob'ektlar</div>
                                  <div className="text-[10px] text-indigo-700">{radiusKm} km radiusda</div>
                                </div>
                            </div>
                            <Plus className="w-4 h-4 text-indigo-600 opacity-0 group-hover:opacity-100 transition-opacity" />
                          </button>
                        )}

                        <button 
                          type="button"
                          onClick={handleExcelExportClick}
                          className="w-full flex items-center justify-between p-3.5 rounded-xl border border-emerald-300 bg-gradient-to-r from-emerald-600 to-teal-700 text-white shadow-md hover:shadow-lg transition-all active:scale-95 cursor-pointer group"
                        >
                          <div className="flex items-center space-x-3">
                              <div className="w-8 h-8 rounded-full bg-white/20 text-white flex items-center justify-center">
                                <FileSpreadsheet className="w-4 h-4" />
                              </div>
                              <div className="text-left">
                                <div className="font-extrabold text-white text-xs">Excel Smetani Yuklash</div>
                                <div className="text-[9.5px] text-emerald-100 font-medium">Faqat Maktab va Bog'chalar (.xlsx)</div>
                              </div>
                          </div>
                          <Download className="w-4 h-4 text-emerald-200 group-hover:translate-y-0.5 transition-transform" />
                        </button>

                        <button 
                          onClick={() => {
                            setSelectedLocations([]);
                            showToast("Ro'yxat tozalandi", "success");
                          }}
                          className="w-full flex items-center justify-center p-3 rounded-xl border border-slate-200 bg-white hover:bg-red-50 hover:text-red-600 hover:border-red-200 text-slate-600 shadow-sm transition-all font-bold text-sm"
                        >
                          Barchasini olib tashlash
                        </button>
                     </div>
                   </div>

                   {/* Filters */}
                   <div>
                     <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3">Muassasa turi bo'yicha filtr</h3>
                     <div className="flex bg-slate-200/50 p-1 rounded-lg">
                       <button type="button" onClick={() => setBatchTypeFilter('all')} className={`flex-1 py-1.5 text-[10px] font-bold rounded-md transition-all cursor-pointer ${batchTypeFilter === 'all' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}>Barchasi</button>
                       <button type="button" onClick={() => setBatchTypeFilter('maktab')} className={`flex-1 py-1.5 text-[10px] font-bold rounded-md transition-all cursor-pointer ${batchTypeFilter === 'maktab' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}>Maktab</button>
                       <button type="button" onClick={() => setBatchTypeFilter('bogcha')} className={`flex-1 py-1.5 text-[10px] font-bold rounded-md transition-all cursor-pointer ${batchTypeFilter === 'bogcha' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}>Bog'cha</button>
                       <button type="button" onClick={() => setBatchTypeFilter('boshqa')} className={`flex-1 py-1.5 text-[10px] font-bold rounded-md transition-all cursor-pointer ${batchTypeFilter === 'boshqa' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}>Boshqa</button>
                     </div>
                   </div>

                </div>

                {/* Right Area: List of Locations */}
                <div className="flex-1 flex flex-col min-h-0 bg-white">
                   <div className="p-4 border-b border-slate-100 shadow-sm z-10 flex flex-col sm:flex-row gap-3">
                      <div className="relative flex-1">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                        <input 
                          type="text"
                          value={batchSearchQuery}
                          onChange={(e) => setBatchSearchQuery(e.target.value)}
                          placeholder="Manzil nomi, mahalla yoki mo'ljal bo'yicha qidirish..."
                          className="w-full pl-9 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:border-indigo-400 focus:bg-white focus:ring-4 focus:ring-indigo-500/10 transition-all text-sm font-medium"
                        />
                      </div>
                      <div className="flex items-center space-x-2 shrink-0">
                         <span className="text-xs font-bold text-slate-500 bg-slate-100 px-3 py-2 rounded-xl">
                           Tanlangan: <span className="text-indigo-600 font-extrabold">{selectedLocations.length}</span>
                         </span>
                      </div>
                   </div>

                   <div className="flex-1 overflow-y-auto p-2 sm:p-4 bg-slate-50/30">
                      {(() => {
                        const filteredBatchLocations = locations.filter(loc => {
                          if (batchTypeFilter === 'maktab' && loc.type !== 'maktab') return false;
                          if (batchTypeFilter === 'bogcha' && loc.type !== 'bogcha' && loc.type !== 'dmtt') return false;
                          if (batchTypeFilter === 'boshqa' && (loc.type === 'maktab' || loc.type === 'bogcha' || loc.type === 'dmtt')) return false;
                          if (batchSearchQuery.trim()) {
                            const q = batchSearchQuery.trim().toLowerCase();
                            return (
                              loc.name.toLowerCase().includes(q) ||
                              (loc.landmark && loc.landmark.toLowerCase().includes(q)) ||
                              (loc.mahalla && loc.mahalla.toLowerCase().includes(q))
                            );
                          }
                          return true;
                        });

                        if (filteredBatchLocations.length === 0) {
                          return (
                            <div className="text-center py-12">
                              <div className="w-16 h-16 rounded-2xl bg-slate-100 flex items-center justify-center mx-auto mb-4 text-slate-400">
                                <Search className="w-8 h-8" />
                              </div>
                              <h3 className="text-sm font-bold text-slate-800 mb-1">Hech narsa topilmadi</h3>
                              <p className="text-xs text-slate-500">Qidiruv so'zini yoki filtrni o'zgartirib ko'ring</p>
                            </div>
                          );
                        }

                        return (
                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                            {filteredBatchLocations.map(loc => {
                              const isSelected = selectedLocations.some(s => s.id === loc.id);
                              return (
                                <div
                                  key={loc.id}
                                  onClick={() => {
                                    if (isSelected) {
                                      setSelectedLocations(selectedLocations.filter(s => s.id !== loc.id));
                                    } else {
                                      setSelectedLocations([...selectedLocations, loc]);
                                    }
                                  }}
                                  className={`p-3 rounded-xl border flex items-start space-x-3 cursor-pointer transition-all ${
                                    isSelected
                                      ? 'bg-indigo-50 border-indigo-300 shadow-sm'
                                      : 'bg-white border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                                  }`}
                                >
                                  <div className={`w-5 h-5 rounded border mt-0.5 flex items-center justify-center shrink-0 transition-colors ${
                                    isSelected ? 'bg-indigo-600 border-indigo-600' : 'bg-white border-slate-300'
                                  }`}>
                                    {isSelected && <Check className="w-3 h-3 text-white" />}
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <div className="font-bold text-sm text-slate-800 tracking-tight truncate" title={loc.name}>{loc.name}</div>
                                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1">
                                      <span className="text-[10px] font-bold text-slate-500 uppercase">
                                        {loc.type === 'dmtt' ? "Bog'cha" : loc.type === 'maktab' ? 'Maktab' : 'Boshqa'}
                                      </span>
                                      {loc.mahalla && (
                                        <span className="text-[9px] font-semibold text-blue-600 bg-blue-50 border border-blue-100 px-1 rounded">
                                          {loc.mahalla}
                                        </span>
                                      )}
                                      {loc.landmark && (
                                        <span className="text-[10px] text-slate-400 italic truncate max-w-[120px]" title={loc.landmark}>• {loc.landmark}</span>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        );
                      })()}
                   </div>
                </div>

             </div>
          </div>
        </div>
      )}

      {/* Cadastre Detail Modal (open.ngis.uz Card Replica) */}
      {isCadastreDetailModalOpen && selectedLocationForCadastreModal && (() => {
        const modalCadDetails = getCadastreDetails(selectedLocationForCadastreModal);
        const cadCode = selectedLocationForCadastreModal.cadastre && selectedLocationForCadastreModal.cadastre.trim() !== '' && selectedLocationForCadastreModal.cadastre !== 'Kiritilmagan'
          ? selectedLocationForCadastreModal.cadastre
          : modalCadDetails.cadastreCode;
        const landArea = selectedLocationForCadastreModal.totalLandArea || modalCadDetails.totalLandArea;
        const footprintArea = selectedLocationForCadastreModal.buildingFootprintArea || modalCadDetails.buildingFootprintArea;
        const docArea = selectedLocationForCadastreModal.docLandArea || modalCadDetails.docLandArea;

        return (
          <div 
            className="fixed inset-0 z-[1000] bg-slate-900/60 backdrop-blur-md flex items-center justify-center p-3 md:p-4 animate-in fade-in duration-200 print:hidden"
            onClick={(e) => {
              if (e.target === e.currentTarget) setIsCadastreDetailModalOpen(false);
            }}
          >
            <div className="bg-white rounded-[2rem] shadow-2xl border border-slate-100 max-w-xl w-full max-h-[90vh] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200">
              {/* Modal Header */}
              <div className="bg-gradient-to-r from-blue-900 via-indigo-900 to-slate-900 p-5 md:p-6 text-white flex justify-between items-start shrink-0 relative overflow-hidden">
                <div className="relative z-10">
                  <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-500/20 border border-blue-400/30 text-[10px] font-bold text-blue-200 mb-2">
                    <Sparkles className="w-3 h-3 text-blue-300" />
                    <span>Kadastr Agentligi • open.ngis.uz Geoportal</span>
                  </div>
                  <h2 className="text-lg md:text-xl font-extrabold tracking-tight leading-snug">
                    {selectedLocationForCadastreModal.name}
                  </h2>
                  <p className="text-xs text-blue-200 font-medium mt-0.5">
                    Obyekt bo'yicha ko'chmas mulk va kadastr ma'lumotlari
                  </p>
                </div>
                <button 
                  onClick={() => setIsCadastreDetailModalOpen(false)}
                  className="relative z-10 w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Modal Body */}
              <div className="p-5 md:p-6 space-y-4 overflow-y-auto font-sans">
                
                {/* Cadastre Code Banner */}
                <div className="p-4 bg-slate-900 text-white rounded-2xl flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 border border-slate-800">
                  <div>
                    <span className="text-[10px] uppercase font-bold tracking-widest text-slate-400 block mb-0.5">Kadastr Raqami</span>
                    <span className="text-base md:text-lg font-mono font-extrabold text-blue-400 select-all tracking-wider">
                      {cadCode}
                    </span>
                  </div>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(cadCode);
                      showToast("Kadastr raqami nusxalandi!", "success");
                    }}
                    className="px-3 py-1.5 text-xs font-bold bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl border border-slate-700 transition-colors flex items-center gap-1.5 cursor-pointer"
                  >
                    <Copy className="w-3.5 h-3.5" />
                    <span>Nusxalash</span>
                  </button>
                </div>

                {/* Data Table Grid */}
                <div className="bg-slate-50 rounded-2xl border border-slate-200/80 divide-y divide-slate-200/80 text-xs text-slate-800">
                  
                  <div className="p-3.5 flex justify-between items-start gap-4">
                    <span className="font-bold text-slate-500 shrink-0 w-36">Viloyat / Shahar:</span>
                    <span className="font-extrabold text-slate-900 text-right">
                      {selectedLocationForCadastreModal.cadastreRegion || "Samarqand viloyati"}
                    </span>
                  </div>

                  <div className="p-3.5 flex justify-between items-start gap-4">
                    <span className="font-bold text-slate-500 shrink-0 w-36">Tuman / Shahar:</span>
                    <span className="font-extrabold text-slate-900 text-right">
                      {selectedLocationForCadastreModal.cadastreDistrict || "Bulung'ur tumani"}
                    </span>
                  </div>

                  <div className="p-3.5 flex justify-between items-start gap-4">
                    <span className="font-bold text-slate-500 shrink-0 w-36">Manzil:</span>
                    <span className="font-bold text-slate-900 text-right">
                      {selectedLocationForCadastreModal.cadastreAddress || selectedLocationForCadastreModal.mahalla || `${selectedLocationForCadastreModal.name}, Bulung'ur tumani`}
                    </span>
                  </div>

                  <div className="p-3.5 flex justify-between items-start gap-4">
                    <span className="font-bold text-slate-500 shrink-0 w-36">Obyekt turi:</span>
                    <span className="font-bold text-indigo-700 text-right">
                      {selectedLocationForCadastreModal.cadastreType || "Noturar bino yoki inshoot"}
                    </span>
                  </div>

                  <div className="p-3.5 flex justify-between items-start gap-4">
                    <span className="font-bold text-slate-500 shrink-0 w-36">Obyekt tavsifi:</span>
                    <span className="font-bold text-slate-900 text-right">
                      {selectedLocationForCadastreModal.type === 'dmtt' || selectedLocationForCadastreModal.type === 'bogcha' ? "Noturar / DMTT (Davlat Maktabgacha Ta'lim Tashkiloti)" : "Noturar / Maktab"}
                    </span>
                  </div>

                  <div className="p-3.5 flex justify-between items-center gap-4 bg-blue-50/50">
                    <span className="font-bold text-slate-700 shrink-0 w-36">📐 Yer maydoni:</span>
                    <span className="font-extrabold text-blue-900 text-sm text-right">
                      {landArea} m² 
                      <span className="text-xs font-normal text-slate-500 ml-1">
                        ({(landArea / 10000).toFixed(2)} ga)
                      </span>
                    </span>
                  </div>

                  <div className="p-3.5 flex justify-between items-center gap-4">
                    <span className="font-bold text-slate-700 shrink-0 w-36">🏢 Bino osti maydoni:</span>
                    <span className="font-extrabold text-slate-900 text-sm text-right">
                      {footprintArea} m²
                    </span>
                  </div>

                  <div className="p-3.5 flex justify-between items-center gap-4">
                    <span className="font-bold text-slate-500 shrink-0 w-36">Hujjat bo'yicha maydon:</span>
                    <span className="font-bold text-slate-800 text-right">
                      {docArea} m²
                    </span>
                  </div>

                </div>

                {/* Action Toolbar */}
                <div className="flex flex-col sm:flex-row gap-2 pt-2">
                  <a
                    href={`https://open.ngis.uz/#/openmap?lat=${selectedLocationForCadastreModal.lat}&lng=${selectedLocationForCadastreModal.lng}`}
                    target="_blank"
                    rel="noreferrer"
                    className="flex-1 py-3 px-4 bg-blue-600 hover:bg-blue-700 text-white font-extrabold text-xs rounded-xl shadow-md transition-all text-center flex items-center justify-center gap-2"
                  >
                    <Globe className="w-4 h-4" />
                    <span>open.ngis.uz xaritasida ochish</span>
                  </a>

                  <button
                    disabled={isNgisFetching}
                    onClick={async () => {
                      const res = await handleFetchNgisCadastre(
                        selectedLocationForCadastreModal.lat,
                        selectedLocationForCadastreModal.lng,
                        selectedLocationForCadastreModal.name,
                        selectedLocationForCadastreModal.type,
                        selectedLocationForCadastreModal.cadastre
                      );
                      if (res && res.cadastre) {
                        setSelectedLocationForCadastreModal(prev => prev ? {
                          ...prev,
                          cadastre: res.cadastre,
                          totalLandArea: res.totalLandArea,
                          buildingFootprintArea: res.buildingFootprintArea,
                          cadastreAddress: res.cadastreAddress,
                          cadastreType: res.cadastreType
                        } : null);
                      }
                    }}
                    className="py-3 px-4 bg-slate-100 hover:bg-slate-200 text-slate-800 font-extrabold text-xs rounded-xl border border-slate-300 transition-all text-center flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                  >
                    <RefreshCw className={`w-4 h-4 ${isNgisFetching ? 'animate-spin' : ''}`} />
                    <span>NGIS portalidan yangilash</span>
                  </button>
                </div>

              </div>
            </div>
          </div>
        );
      })()}

      <MapContainer 
        key={mapSource}
        crs={mapSource === 'yandex' ? L.CRS.EPSG3395 : L.CRS.EPSG3857}
        center={center} 
        zoom={12} 
        className={`w-full h-screen z-0 print:hidden ${isMapLocked ? 'pointer-events-none select-none' : 'pointer-events-auto'}`}
        ref={mapRef}
        zoomControl={false}
        doubleClickZoom={false}
        dragging={!isMapLocked}
        touchZoom={!isMapLocked}
        scrollWheelZoom={!isMapLocked}
      >
        <ZoomControl position="bottomright" />
        {mapSource === 'osm' && (
          <TileLayer
            attribution='&copy; OpenStreetMap contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
        )}
        {mapSource === 'google' && (
          <TileLayer
            attribution="&copy; Google Maps"
            url="https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}"
          />
        )}
        {mapSource === 'google_sat' && (
          <TileLayer
            attribution="&copy; Google Maps Satellite"
            url="https://mt1.google.com/vt/lyrs=s,h&x={x}&y={y}&z={z}"
          />
        )}
         {mapSource === 'yandex' && (
          <TileLayer
            attribution="&copy; Yandex Maps"
            url="https://core-renderer-tiles.maps.yandex.net/tiles?l=map&x={x}&y={y}&z={z}&scale=1&lang=uz_UZ"
          />
        )}

        {/* Radius Circle */}
        {isRadiusMode && radiusCenter && (
           <Circle 
             center={radiusCenter} 
             radius={radiusKm * 1000} 
             pathOptions={{ color: '#4f46e5', fillColor: '#4f46e5', fillOpacity: 0.15, weight: 2, dashArray: '5, 5' }}
           />
        )}

        {userLocation && (
          <Marker 
            position={userLocation}
            icon={L.divIcon({
              className: 'pulsing-gps-marker bg-transparent border-0',
              html: `
                <div style="position: relative; width: 34px; height: 42px; pointer-events: none;">
                  <div class="animate-ping" style="position: absolute; top: 0; left: 0; width: 34px; height: 34px; background-color: #3b82f6; border-radius: 50%; opacity: 0.7;"></div>
                  <div style="background-color: #3b82f6; width: 34px; height: 34px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 16px; border: 3px solid white; box-shadow: 0 4px 6px rgba(0,0,0,0.3); position: relative; z-index: 10;">
                    🙋‍♂️
                    <div style="position: absolute; bottom: -6px; left: 50%; transform: translateX(-50%); width: 0; height: 0; border-left: 6px solid transparent; border-right: 6px solid transparent; border-top: 8px solid #3b82f6;"></div>
                  </div>
                </div>
              `,
              iconSize: [34, 42],
              iconAnchor: [17, 40]
            })}
          >
            <Tooltip direction="top" offset={[0, -20]} opacity={0.9} className="border-0 shadow-lg rounded-xl font-sans font-bold text-blue-700 bg-white/90 backdrop-blur-sm px-3 py-2 text-xs">
              📍 Siz shu yerdasiz
            </Tooltip>
          </Marker>
        )}
        
        {filteredLocations.map((loc) => (
          <Marker 
            key={loc.id} 
            position={[loc.lat, loc.lng]} 
            icon={createDivIcon(loc.type, loc.name)}
            eventHandlers={{ 
              click: (e) => { 
                handleMarkerClick(loc);
                setClickedMarkerState({ id: loc.id, timestamp: Date.now() });
                if (closeTimeoutRef.current) {
                  clearTimeout(closeTimeoutRef.current);
                  closeTimeoutRef.current = null;
                }
                e.target.openPopup();
              },
              mouseover: (e) => {
                if (closeTimeoutRef.current) {
                  clearTimeout(closeTimeoutRef.current);
                  closeTimeoutRef.current = null;
                }
                e.target.openPopup();
              },
              mouseout: (e) => {
                if (editingLandmarkId === loc.id) return;
                
                if (clickedMarkerState && clickedMarkerState.id === loc.id) {
                  return;
                }
                
                closeTimeoutRef.current = setTimeout(() => {
                  if (e.target && typeof e.target.closePopup === 'function') {
                     e.target.closePopup();
                  }
                }, 400);
              }
            }}
            ref={(el) => { markerRefs.current[loc.id] = el; }}
          >
            <Popup offset={[0, -20]}>
              <div 
                className="font-sans text-center mt-0.5 max-w-[190px]"
                onMouseEnter={() => {
                  if (closeTimeoutRef.current) {
                    clearTimeout(closeTimeoutRef.current);
                    closeTimeoutRef.current = null;
                  }
                }}
                onMouseLeave={() => {
                  if (clickedMarkerState && clickedMarkerState.id === loc.id) {
                    return;
                  }
                  closeTimeoutRef.current = setTimeout(() => {
                    if (markerRefs.current[loc.id]) {
                      markerRefs.current[loc.id]?.closePopup();
                    }
                  }, 400);
                }}
              >
                <h3 className="font-extrabold text-[13px] text-slate-900 leading-tight mb-1">{loc.name}</h3>
                {loc.mahalla && (
                  <div className="flex flex-wrap gap-1 justify-center mb-1.5">
                    <span className="text-[8px] font-bold text-blue-600 bg-blue-50 border border-blue-200 rounded px-1.5 py-0.5" title="Mahalla">
                      {loc.mahalla}
                    </span>
                  </div>
                )}
                
                <div className="text-[9px] text-slate-700 mb-1.5 px-1 text-left border-t border-b border-dashed border-slate-200 py-1 my-1">
                  <div className="flex justify-between items-center font-bold mb-0.5">
                    <span className="text-[8px] text-slate-500 uppercase tracking-wider font-bold">Mo'ljal:</span>
                    {editingLandmarkId !== loc.id && (
                      <button 
                        onClick={(e) => { 
                          e.stopPropagation();
                          startEditingLandmark(loc);
                        }}
                        className="text-[8px] text-blue-600 hover:text-blue-700 font-bold cursor-pointer underline decoration-dotted"
                      >
                        Tahrirlash
                      </button>
                    )}
                  </div>
                  {editingLandmarkId === loc.id ? (
                    <div className="mt-1 flex flex-col space-y-1" onClick={(e) => e.stopPropagation()}>
                      <textarea 
                        value={tempLandmark}
                        onChange={(e) => setTempLandmark(e.target.value)}
                        placeholder="Masalan: do'kon qarshisida..."
                        className="w-full p-1 text-[9px] bg-white border border-slate-200 text-slate-900 rounded outline-none focus:border-blue-500 font-medium resize-none h-[38px]"
                        disabled={isModerating}
                        maxLength={200}
                      />
                      <div className="flex justify-end gap-1">
                        <button 
                          disabled={isModerating}
                          onClick={(e) => { e.stopPropagation(); setEditingLandmarkId(null); }}
                          className="px-1 py-0.5 text-[8px] text-slate-500 font-bold border border-slate-200 rounded hover:bg-slate-50 cursor-pointer"
                        >
                          Ortga
                        </button>
                        <button 
                          disabled={isModerating}
                          onClick={(e) => { e.stopPropagation(); saveLandmark(loc); }}
                          className="px-1 py-0.5 text-[8px] bg-blue-500 hover:bg-blue-600 text-white font-bold rounded cursor-pointer disabled:opacity-50"
                        >
                          {isModerating ? "..." : "Saqlash"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="text-slate-700 italic bg-slate-100 rounded px-1.5 py-0.5 text-[9px] border border-slate-200/60 leading-normal font-medium max-h-[48px] overflow-y-auto">
                      {loc.landmark || "Kiritilmagan"}
                    </div>
                  )}
                </div>

                {/* NGIS Cadastre & Land Area Badge Card */}
                {(() => {
                  const cDetails = getCadastreDetails(loc);
                  const cadCode = loc.cadastre && loc.cadastre.trim() !== '' && loc.cadastre !== 'Kiritilmagan'
                    ? loc.cadastre
                    : cDetails.cadastreCode;
                  const landAreaVal = loc.totalLandArea || cDetails.totalLandArea;
                  const footprintAreaVal = loc.buildingFootprintArea || cDetails.buildingFootprintArea;

                  return (
                    <div className="mt-1.5 p-1.5 bg-gradient-to-br from-slate-50 to-blue-50/50 rounded-lg border border-blue-100 text-left">
                      <div className="flex justify-between items-center text-[8.5px] mb-1">
                        <span className="font-bold text-slate-500 uppercase tracking-tight">Kadastr (NGIS):</span>
                        <span className="font-mono font-bold text-blue-900 bg-white px-1 py-0.5 rounded border border-blue-200 select-all">
                          {cadCode}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-1 text-[8px] text-slate-700 bg-white/80 p-1 rounded border border-slate-200/60 mb-1">
                        <div>
                          <span className="text-slate-400 font-semibold block">Yer maydoni:</span>
                          <span className="font-bold text-slate-900">
                            {landAreaVal} m²
                          </span>
                        </div>
                        <div>
                          <span className="text-slate-400 font-semibold block">Bino osti:</span>
                          <span className="font-bold text-slate-900">
                            {footprintAreaVal} m²
                          </span>
                        </div>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedLocationForCadastreModal(loc);
                          setIsCadastreDetailModalOpen(true);
                        }}
                        className="w-full py-1 text-[8px] font-extrabold text-blue-700 bg-blue-100 hover:bg-blue-200 border border-blue-300 rounded transition-colors flex items-center justify-center gap-1 cursor-pointer"
                      >
                        <span>🏛️ NGIS Geoportal ma'lumotlari</span>
                      </button>
                    </div>
                  );
                })()}

                {/* 1-tap Yandex / Google quick launch from popup */}
                <div className="mt-1.5 grid grid-cols-2 gap-1">
                  <a
                    href={buildYandexMapsUrl([loc], userLocation, true)}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="py-1.5 px-2 bg-orange-500 hover:bg-orange-600 text-white font-extrabold text-[9.5px] rounded-lg no-underline text-center flex items-center justify-center"
                  >
                    Yandex Nav
                  </a>
                  <a
                    href={buildGoogleMapsUrl([loc], userLocation, true)}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="py-1.5 px-2 bg-blue-600 hover:bg-blue-700 text-white font-extrabold text-[9.5px] rounded-lg no-underline text-center flex items-center justify-center"
                  >
                    Google Maps
                  </a>
                </div>

                {currentUser && (
                  <button 
                    onClick={(e) => { e.stopPropagation(); openEditModal(loc); }}
                    className="print:hidden w-full mt-1.5 py-1 text-[8px] font-bold text-amber-700 bg-amber-100 hover:bg-amber-200 border border-amber-300 rounded-lg transition-all cursor-pointer flex items-center justify-center"
                    title={role === 'admin' ? "Tuzatish (Admin)" : "Xato haqida xabar berish"}
                  >
                    Joylashuv xatomi?
                  </button>
                )}
              </div>
            </Popup>
          </Marker>
        ))}

        {/* Custom Pinned Points and GPS points */}
        {selectedLocations.filter(loc => loc.id.startsWith('custom-') || loc.id.startsWith('gps-')).map((loc) => (
          <Marker 
            key={loc.id} 
            position={[loc.lat, loc.lng]} 
            icon={createDivIcon(loc.type, loc.name)}
            eventHandlers={{ 
              click: (e) => {
                setClickedMarkerState({ id: loc.id, timestamp: Date.now() });
                if (closeTimeoutRef.current) {
                  clearTimeout(closeTimeoutRef.current);
                  closeTimeoutRef.current = null;
                }
                e.target.openPopup();
              },
              mouseover: (e) => {
                if (closeTimeoutRef.current) {
                  clearTimeout(closeTimeoutRef.current);
                  closeTimeoutRef.current = null;
                }
                e.target.openPopup();
              },
              mouseout: (e) => {
                if (clickedMarkerState && clickedMarkerState.id === loc.id) {
                  return;
                }
                closeTimeoutRef.current = setTimeout(() => {
                  if (e.target && typeof e.target.closePopup === 'function') {
                     e.target.closePopup();
                  }
                }, 400);
              }
            }}
            ref={(el) => { markerRefs.current[loc.id] = el; }}
          >
            <Popup offset={[0, -20]}>
              <div 
                className="font-sans text-center mt-0.5 max-w-[190px]"
                onMouseEnter={() => {
                  if (closeTimeoutRef.current) {
                    clearTimeout(closeTimeoutRef.current);
                    closeTimeoutRef.current = null;
                  }
                }}
                onMouseLeave={() => {
                  if (clickedMarkerState && clickedMarkerState.id === loc.id) {
                    return;
                  }
                  closeTimeoutRef.current = setTimeout(() => {
                    if (markerRefs.current[loc.id]) {
                      markerRefs.current[loc.id]?.closePopup();
                    }
                  }, 400);
                }}
              >
                <h3 className="font-extrabold text-[12px] text-slate-900 leading-tight">{loc.name}</h3>
              </div>
            </Popup>
          </Marker>
        ))}
        {layers.district && districtBoundary && (
          <GeoJSON 
            data={districtBoundary} 
            style={{ color: '#1e40af', weight: 3, fillColor: '#1e40af', fillOpacity: 0.05 }} 
          />
        )}
        {mahallaBoundary && (
          <GeoJSON 
            key={JSON.stringify(mahallaBoundary)} // force remount when geometry changes
            data={mahallaBoundary} 
            style={{ color: '#ef4444', weight: 2, dashArray: '5, 5', fillColor: '#ef4444', fillOpacity: 0.1 }} 
          />
        )}
        {layers.neighborhoods && neighborhoodsData && (
          <GeoJSON 
            data={neighborhoodsData} 
            style={{ color: '#6366f1', weight: 2, dashArray: '4, 4', fillOpacity: 0 }}
            onEachFeature={(feature, layer) => {
               if (feature.properties?.name) {
                  layer.bindTooltip(feature.properties.name, { permanent: false, direction: 'center', className: 'text-[10px] font-bold bg-white/90 border-0 rounded shadow-sm px-1.5 py-0.5' });
               }
            }}
          />
        )}
        {layers.highways && highwaysData && (
          <GeoJSON 
            data={highwaysData} 
            style={{ color: '#f59e0b', weight: 4, opacity: 0.8 }} 
          />
        )}
        {routeGeometry && (
          <Polyline positions={routeGeometry} color="#1e61f0" weight={6} opacity={0.85} />
        )}
        {multiRouteGeometries && multiRouteGeometries.map((m, idx) => (
          <Polyline key={idx} positions={m.coords} color={m.color} weight={6} opacity={0.8} />
        ))}
        <LocationPicker />
      </MapContainer>
      
      {/* Floating Map Control Dock (Bottom-Left) */}
      <div className="print:hidden absolute bottom-[88px] md:bottom-6 left-4 md:left-6 z-[400] flex flex-col md:flex-row space-y-2.5 md:space-y-0 md:space-x-3 pointer-events-auto items-start md:items-center">
         {/* Settings Button */}
         <button 
           onClick={() => setIsSettingsOpen(true)} 
           className="bg-white/95 backdrop-blur-md w-11 h-11 md:w-auto md:px-5 md:py-3 rounded-full md:rounded-3xl shadow-xl md:shadow-2xl border border-slate-100 flex items-center justify-center md:space-x-2 transition-all hover:scale-105 active:scale-95 text-slate-800 shrink-0 cursor-pointer"
           title="Filtrlar va sozlamalar"
         >
           <Settings2 className="w-5 h-5 md:w-5 md:h-5 text-indigo-600 shrink-0" />
           <span className="font-extrabold text-xs md:text-sm tracking-tight text-slate-700 hidden md:inline">Filtrlar</span>
         </button>

         {/* GPS Location Button (mobile fallback) */}
         <button
            onClick={handleGetLocation}
            title="Mening joylashuvimni aniqlash"
            className="md:hidden bg-white/95 backdrop-blur-md w-11 h-11 rounded-full shadow-xl border border-slate-100 flex items-center justify-center transition-all hover:scale-105 active:scale-95 text-slate-800 shrink-0 cursor-pointer"
         >
            <LocateFixed className="w-5 h-5 text-blue-600 shrink-0" />
         </button>

         {/* Add Location Button (mobile fallback) */}
         {(!isPickingLocation && !isPickingRoutePoint && currentUser) && (
           <button
             onClick={() => setIsAddModalOpen(true)}
             className="md:hidden bg-white/95 backdrop-blur-md w-11 h-11 rounded-full shadow-xl border border-slate-100 flex items-center justify-center transition-all hover:scale-105 active:scale-95 text-slate-800 shrink-0 cursor-pointer"
             title="Yangi ob'ekt qo'shish"
           >
             <Plus className="w-5 h-5 text-green-600 shrink-0" />
           </button>
         )}

         {/* Lock/Unlock Map Dragging on Mobile */}
         <button
            onClick={() => {
              const nextVal = !isMapLocked;
              setIsMapLocked(nextVal);
              showToast(nextVal ? "Xarita muzlatildi! Sahifani bemalol orqaga surishingiz mumkin." : "Xarita faollashtirildi!", "info");
            }}
            className={`w-11 h-11 md:hidden rounded-full shadow-xl border flex items-center justify-center transition-all hover:scale-105 active:scale-95 shrink-0 cursor-pointer ${
              isMapLocked 
                ? 'bg-red-500 text-white border-red-400' 
                : 'bg-white/95 text-slate-800 border-slate-100'
            }`}
            title={isMapLocked ? "Xaritani faollashtirish" : "Xaritani muzlatish (Sahifani bemalol aylantirish)"}
         >
            <Shield className="w-5 h-5 shrink-0" />
         </button>
      </div>

      {/* Mobile Toggle Navbar Button */}
      <div className="print:hidden md:hidden absolute bottom-6 left-1/2 transform -translate-x-1/2 z-[400] pointer-events-auto w-[92%] max-w-sm">
          <button 
             onClick={() => setIsMobilePanelOpen(!isMobilePanelOpen)} 
             className="w-full bg-slate-900 hover:bg-slate-800 px-4 py-3 rounded-2xl shadow-2xl border border-slate-800 flex items-center justify-between transition-all active:scale-95 text-white"
          >
             <div className="flex items-center space-x-2">
               <Route className="w-5 h-5 text-indigo-400 shrink-0" />
               <span className="font-extrabold text-xs tracking-tight text-left truncate">
                 {routeStats ? "Marshrut tayyor" : "Marshrut paneli"}
               </span>
               {selectedLocations.length > 0 && (
                 <div className="ml-1 bg-indigo-500 text-white text-[10px] w-5 h-5 rounded-full flex items-center justify-center font-black shrink-0">
                   {selectedLocations.length}
                 </div>
               )}
             </div>
             
             {routeStats ? (
               <div className="flex items-center space-x-1.5 text-right bg-slate-800 border border-slate-700 px-2 py-0.5 rounded-lg shrink-0">
                 <span className="text-[11px] font-black text-emerald-400">
                   {(routeStats.distance / 1000).toFixed(1)} km
                 </span>
                 <span className="text-[11px] font-black text-orange-400">
                   {Math.round(routeStats.duration / 60)} daq
                 </span>
               </div>
             ) : (
               <span className="text-[9px] font-black tracking-widest text-indigo-300 uppercase shrink-0">Ochish</span>
             )}
          </button>
      </div>

      {/* Mobile Overlay */}
      {isMobilePanelOpen && (
        <div 
          className="md:hidden fixed inset-0 z-[440] bg-slate-900/40 backdrop-blur-sm transition-opacity pointer-events-auto"
          onClick={() => setIsMobilePanelOpen(false)}
        />
      )}

      {/* Sidebar: Marshrut va Logistika */}
      <div className={`fixed md:absolute bottom-0 md:bottom-6 md:top-6 md:right-6 md:left-auto left-0 right-0 w-full md:w-96 z-[450] flex flex-col gap-2 md:gap-4 pointer-events-none print:hidden transition-transform duration-300 md:translate-y-0 ${isMobilePanelOpen ? 'translate-y-0' : 'translate-y-[100%]'}`}>
        
        {/* Selected Locations Panel */}
        <div className="flex-1 pointer-events-auto bg-white/95 backdrop-blur-md p-4 md:p-6 rounded-t-3xl md:rounded-3xl shadow-2xl border border-slate-100 flex flex-col overflow-hidden max-h-[85vh] md:max-h-none h-full">
          
          {/* Mobile Handle & Close */}
          <div className="flex items-center justify-between mb-4 md:hidden shrink-0">
            <div className="w-10"></div>
            <div className="w-12 h-1.5 bg-slate-300 rounded-full cursor-pointer" onClick={() => setIsMobilePanelOpen(false)}></div>
            <button onClick={() => setIsMobilePanelOpen(false)} className="w-10 h-10 flex items-center justify-center text-slate-500 hover:text-slate-800 bg-slate-100 rounded-full">
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="flex items-center justify-between mb-4 shrink-0 hidden md:flex">
            <div className="flex items-center space-x-2">
              <h2 className="font-extrabold text-xl text-slate-900 tracking-tight">Marshrut</h2>
              <button 
                onClick={() => setIsBatchSelectModalOpen(true)}
                className="ml-2 px-2 py-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-[11px] font-bold rounded-lg transition-colors border border-indigo-200 shadow-sm flex items-center"
              >
                <Sparkles className="w-3 h-3 mr-1" />
                Tezkor tanlash
              </button>
            </div>
            <div className="flex space-x-2">
              {selectedLocations.length > 0 && (
                <button onClick={handleClearRoute} className="w-8 h-8 rounded-full bg-red-50 text-red-600 hover:bg-red-100 flex items-center justify-center transition-colors border border-red-200" title="Tozalash">
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
              <div className="w-8 h-8 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center">
                <Route className="w-4 h-4" />
              </div>
            </div>
          </div>
          
          <div className="flex items-center justify-between mb-4 shrink-0 md:hidden">
            <div className="flex flex-col space-y-1">
              <h2 className="font-extrabold text-xl text-slate-900 tracking-tight">Marshrut paneli</h2>
              <button 
                onClick={() => setIsBatchSelectModalOpen(true)}
                className="px-2 py-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-[11px] font-bold rounded-lg transition-colors border border-indigo-200 shadow-sm flex items-center w-fit"
              >
                <Sparkles className="w-3 h-3 mr-1" />
                Tezkor tanlash
              </button>
            </div>
            <div className="flex space-x-2">
              {selectedLocations.length > 0 && (
                <button onClick={handleClearRoute} className="w-8 h-8 rounded-full bg-red-50 text-red-600 hover:bg-red-100 flex items-center justify-center transition-colors border border-red-200" title="Tozalash">
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
              <div className="w-8 h-8 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center">
                <Route className="w-4 h-4" />
              </div>
            </div>
          </div>
          
          {/* Scrollable Body: All settings, checkboxes, lists reside here */}
          <div className="flex-1 overflow-y-auto pr-2 scrollbar-thin scrollbar-thumb-slate-200 space-y-4 pb-2">
            
            {/* Saved Routes Accordion/Collapsible */}
            <div className="shrink-0">
              <button 
                onClick={() => setShowSavedRoutesList(!showSavedRoutesList)}
                className="w-full flex items-center justify-between p-2.5 bg-slate-50 border border-slate-200 hover:bg-slate-100 rounded-xl transition-all font-bold text-xs group cursor-pointer"
              >
                <div className="flex items-center space-x-2">
                  <History className="w-4 h-4 text-slate-500 group-hover:text-indigo-600 transition-colors" />
                  <span className="text-slate-700 font-bold">Mening saqlangan marshrutlarim</span>
                  {savedRoutes.length > 0 && (
                    <span className="px-1.5 py-0.5 bg-indigo-100 font-extrabold text-indigo-700 rounded text-[9px]">
                      {savedRoutes.length}
                    </span>
                  )}
                </div>
                <span className="text-[10px] text-slate-400 font-bold">
                  {showSavedRoutesList ? "Yopish" : "Ko'rish"}
                </span>
              </button>
              {showSavedRoutesList && (
                <div className="mt-2 p-2 bg-slate-50/50 border border-slate-200 rounded-xl max-h-[180px] overflow-y-auto space-y-1.5 scrollbar-thin">
                  {isSavedRoutesLoading ? (
                    <div className="flex items-center justify-center py-6 text-xs text-slate-400 space-x-1.5">
                      <div className="w-3.5 h-3.5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
                      <span>Yuklanmoqda...</span>
                    </div>
                  ) : savedRoutes.length === 0 ? (
                    <div className="text-center py-6 text-xs text-slate-400 font-semibold font-sans">
                      Hozircha saqlangan marshrutlar yo'q
                    </div>
                  ) : (
                    savedRoutes.map((route) => (
                      <div 
                        key={route.id}
                        onClick={() => handleLoadRoute(route)}
                        className="group cursor-pointer p-2 bg-white hover:bg-indigo-50/40 border border-slate-100 hover:border-indigo-100 rounded-lg flex items-center justify-between transition-all"
                      >
                        <div className="flex flex-col space-y-0.5 overflow-hidden pr-2">
                          <span className="font-bold text-xs text-slate-800 truncate" title={route.name}>{route.name}</span>
                          <div className="flex items-center space-x-1.5 text-[9px] text-slate-500 font-semibold font-mono">
                            <span>📍 {route.locations?.length || 0} manzil</span>
                            {route.routeStats?.distance && (
                              <span>• {(route.routeStats.distance / 1000).toFixed(1)} km</span>
                            )}
                          </div>
                        </div>
                        {confirmDeleteRouteId === route.id ? (
                          <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              onClick={(e) => handleDeleteRoute(route.id, e)}
                              className="px-2 py-1 rounded-md bg-red-600 hover:bg-red-700 text-white text-[10px] font-bold cursor-pointer"
                            >
                              O'chirish
                            </button>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); setConfirmDeleteRouteId(null); }}
                              className="px-1.5 py-1 rounded-md bg-slate-100 hover:bg-slate-200 text-slate-600 text-[10px] font-bold cursor-pointer"
                            >
                              Yo'q
                            </button>
                          </div>
                        ) : (
                          <button 
                            type="button"
                            onClick={(e) => handleDeleteRoute(route.id, e)}
                            aria-label="Marshrutni o'chirish"
                            className="p-1 rounded-md bg-red-50 hover:bg-red-100 text-red-600 border border-red-100 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity flex items-center justify-center shrink-0 cursor-pointer"
                            title="O'chirish"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>

            {/* Recent Searches Accordion/Collapsible */}
            <div className="shrink-0">
              <button 
                onClick={() => setShowRecentSearches(!showRecentSearches)}
                className="w-full flex items-center justify-between p-2.5 bg-slate-50 border border-slate-200 hover:bg-slate-100 rounded-xl transition-all font-bold text-xs group cursor-pointer"
              >
                <div className="flex items-center space-x-2">
                  <Clock className="w-4 h-4 text-slate-500 group-hover:text-indigo-600 transition-colors" />
                  <span className="text-slate-700 font-bold">Yaqinda qidirilganlar</span>
                  {recentRouteSearches.length > 0 && (
                    <span className="px-1.5 py-0.5 bg-emerald-100 font-extrabold text-emerald-700 rounded text-[9px]">
                      {recentRouteSearches.length}
                    </span>
                  )}
                </div>
                <span className="text-[10px] text-slate-400 font-bold">
                  {showRecentSearches ? "Yopish" : "Ko'rish"}
                </span>
              </button>
              {showRecentSearches && (
                <div className="mt-2 p-2 bg-slate-50/50 border border-slate-200 rounded-xl max-h-[180px] overflow-y-auto space-y-1.5 scrollbar-thin">
                  {recentRouteSearches.length === 0 ? (
                    <div className="text-center py-6 text-xs text-slate-400 font-semibold font-sans">
                      Hozircha yaqinda qidirilgan marshrutlar yo'q
                    </div>
                  ) : (
                    recentRouteSearches.map((search) => (
                      <div 
                        key={search.id}
                        onClick={() => handleLoadRecentSearch(search)}
                        className="group cursor-pointer p-2 bg-white hover:bg-emerald-50/20 border border-slate-100 hover:border-emerald-100 rounded-lg flex items-center justify-between transition-all"
                      >
                        <div className="flex flex-col space-y-0.5 overflow-hidden pr-2">
                          <span className="font-bold text-xs text-slate-800 truncate" title={search.name}>{search.name}</span>
                          <div className="flex items-center space-x-1.5 text-[9px] text-slate-500 font-semibold font-mono">
                            <span>📍 {search.locations?.length || 0} manzil</span>
                            {search.isRoundtrip && <span className="text-amber-600 bg-amber-50 px-1 rounded-sm text-[8px] font-bold">Aylanma</span>}
                          </div>
                        </div>
                        <button 
                          onClick={(e) => handleDeleteRecentSearch(search.id, e)}
                          className="p-1 rounded-md bg-red-50 hover:bg-red-100 text-red-600 border border-red-100 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center shrink-0 cursor-pointer"
                          title="Tarixdan o'chirish"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>

            {/* List of active locations */}
            <div>
              <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider block mb-2 px-1">Tanlangan manzillar:</span>
              {selectedLocations.length === 0 ? (
                <div className="py-8 flex flex-col items-center justify-center text-center p-4 text-slate-400 bg-slate-50/40 border border-dashed border-slate-200 rounded-2xl">
                  <p className="text-xs font-semibold">Xaritadan manzillarni bosib tanlang</p>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {selectedLocations.map((loc, idx) => {
                    let bgColor = 'bg-slate-500';
                    if (loc.type === 'maktab') bgColor = 'bg-blue-600';
                    else if (loc.type === 'bogcha' || loc.type === 'dmtt') bgColor = 'bg-red-500';
                    else if (loc.type === 'boshqa' || loc.type === 'tashkilot') bgColor = 'bg-emerald-600';

                    const isStart = idx === 0;

                    return (
                      <div 
                        key={loc.id} 
                        className={`relative w-8 h-8 rounded-full text-white text-xs font-extrabold flex items-center justify-center shadow-md cursor-pointer group transition-all border-2 ${isStart ? 'border-yellow-400 scale-105 shadow-md z-20' : 'border-white'} ${bgColor}`} 
                        title={`${loc.name}${isStart ? ' (Boshlang\'ich nuqta)' : ''}`}
                      >
                        <span className="group-hover:hidden" onClick={() => {
                          if (idx !== 0) {
                            const newLocations = [...selectedLocations];
                            newLocations.splice(idx, 1);
                            newLocations.unshift(loc);
                            setSelectedLocations(newLocations);
                            showToast(`${loc.name} boshlang'ich nuqta etib belgilandi`, 'success');
                            setRouteGeometry(null);
                            setRouteStats(null);
                          }
                        }}>{getShortLabelString(loc.name)}</span>
                        <X className="w-4 h-4 hidden group-hover:block" onClick={(e) => removeLocation(e, loc.id)} />
                        {isStart && <div className="absolute -top-1 -right-1 w-3 h-3 bg-yellow-400 rounded-full border border-white pointer-events-none"></div>}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Configs, GPS addition, Checkboxes */}
            <div className="pt-2.5 border-t border-slate-100 space-y-2.5">
              {/* Auto-Origin GPS toggle for Yandex & Google */}
              <label className="flex items-start space-x-2.5 text-slate-700 cursor-pointer p-2 bg-sky-50/70 hover:bg-sky-50 border border-sky-200/80 rounded-xl transition-colors">
                <input
                  type="checkbox"
                  checked={startFromMyLocation}
                  onChange={(e) => setStartFromMyLocation(e.target.checked)}
                  className="rounded border-slate-300 text-sky-600 focus:ring-sky-500 w-4 h-4 mt-0.5 cursor-pointer shrink-0"
                />
                <div className="flex flex-col">
                  <span className="text-xs font-extrabold text-slate-900">Joylashuvimdan boshlash (Avto GPS)</span>
                  <span className="text-[10px] text-slate-500 leading-snug">
                    Yandex va Google boshlang'ich nuqtani qayta so'ramasdan joriy GPS dan yo'l chizadi
                  </span>
                </div>
              </label>

              {/* Nearest-first quick sort button */}
              {selectedLocations.length >= 2 && (
                <button
                  type="button"
                  onClick={handleSortNearestFirst}
                  className="w-full min-h-[42px] rounded-xl bg-amber-50 hover:bg-amber-100 text-amber-900 text-xs font-extrabold flex items-center justify-center space-x-1.5 transition-all active:scale-95 border border-amber-200 cursor-pointer"
                  title="Joriy GPS joylashuvingizdan eng yaqinini birinchi qo'yib tartiblash"
                >
                  <Zap className="w-4 h-4 shrink-0 text-amber-600" />
                  <span className="truncate">Eng yaqinidan tartibla (GPS)</span>
                </button>
              )}

              {/* Add GPS to Start button */}
              <button 
                onClick={handleAddGPSToStart}
                className="w-full min-h-[38px] rounded-xl bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-[11px] font-black flex items-center justify-center space-x-1.5 transition-all active:scale-95 border border-indigo-100 cursor-pointer"
                title="Mening hozirgi GPS joylashuvimni marshrut boshiga birinchi nuqta qilib qo'yish"
              >
                <LocateFixed className="w-4 h-4 shrink-0 text-indigo-600" />
                <span className="truncate">Marshrut boshiga GPS nuqtasini qo'shish</span>
              </button>

              {selectedLocations.length > 0 && (
                <div className="flex flex-col space-y-2">
                  <label className="flex items-center space-x-2 text-sm font-semibold text-slate-700 cursor-pointer p-1.5 hover:bg-slate-50 rounded-lg transition-colors">
                    <input 
                      type="checkbox" 
                      checked={hideUnselected}
                      onChange={(e) => setHideUnselected(e.target.checked)}
                      className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 w-4 h-4 cursor-pointer"
                    />
                    <span className="text-xs">Faqat tanlanganlarini xaritada ko'rsatish</span>
                  </label>

                  {selectedLocations.length >= 2 && (
                    <label className="flex items-center space-x-2 text-[11px] font-semibold text-slate-700 cursor-pointer px-1.5 py-1 hover:bg-slate-50 rounded-xl transition-colors">
                      <input 
                        type="checkbox" 
                        checked={isRoundtrip} 
                        onChange={(e) => {
                          setIsRoundtrip(e.target.checked);
                          setRouteGeometry(null);
                          setRouteStats(null);
                        }} 
                        className="rounded border-slate-300 text-blue-600 w-3.5 h-3.5 cursor-pointer" 
                      />
                      <span>Aylanma marshrut (Oxirida boshga qaytish)</span>
                    </label>
                  )}
                </div>
              )}
              
              {selectedLocations.length > 0 && (
                 <p className="text-[10px] text-slate-500 italic px-1 leading-normal">
                   * Ro'yxatdagi <strong className="text-slate-800">1-manzil</strong> mudom boshlang'ich nuqta hisoblanadi. (Boshqasiga bosing)
                 </p>
              )}

              {selectedLocations.length > 5 && (
                 <div className="flex flex-col space-y-2 bg-slate-50 border border-slate-200 px-3 py-2.5 rounded-xl">
                   <div className="flex items-center justify-between">
                      <span className="text-[11px] font-bold text-slate-600">Mashinalar / Vzvodlar soni:</span>
                      <div className="flex items-center shadow-sm rounded-lg overflow-hidden border border-slate-200 bg-white">
                        <button type="button" onClick={() => setVehiclesCount(Math.max(1, vehiclesCount - 1))} className="px-2.5 py-1 bg-white hover:bg-slate-50 text-slate-600 font-bold border-r border-slate-200 transition-colors">-</button>
                        <input type="number" value={vehiclesCount} readOnly className="w-8 text-center text-xs font-black py-1 text-slate-900 outline-none" />
                        <button type="button" onClick={() => setVehiclesCount(Math.min(10, vehiclesCount + 1))} className="px-2.5 py-1 bg-white hover:bg-slate-50 text-slate-600 font-bold border-l border-slate-200 transition-colors">+</button>
                      </div>
                   </div>
                   {vehiclesCount > 1 && (
                     <label className="flex items-center space-x-2 text-[11px] font-semibold text-slate-700 cursor-pointer pt-1 border-t border-slate-200">
                       <input type="checkbox" checked={sharedStartPoint} onChange={(e) => setSharedStartPoint(e.target.checked)} className="rounded border-slate-300 text-blue-600 w-3 h-3 cursor-pointer" />
                       <span>1-chi manzil hamma uchun boshlang'ich bo'lsin</span>
                     </label>
                   )}
                 </div>
              )}
            </div>
          </div>

          {/* Sticky Footer: Action buttons & navigation redirections */}
          <div className="print:hidden pt-3 border-t border-slate-100 shrink-0 space-y-3 bg-white/95">
            
            {/* Real-time route length & duration statistics inside main panel */}
            {routeStats && (
              <div className="grid grid-cols-2 gap-2.5">
                <div className="p-2.5 bg-slate-50 border border-slate-100 rounded-xl flex flex-col justify-center">
                  <div className="flex items-center space-x-1 text-blue-600">
                    <MapIcon className="w-3 h-3" />
                    <span className="text-[9px] font-black uppercase tracking-wider">Masofa</span>
                  </div>
                  <div className="text-base font-black text-slate-900 mt-0.5">
                    {(routeStats.distance / 1000).toFixed(1)} <span className="text-[10px] font-bold text-slate-500">km</span>
                  </div>
                </div>
                <div className="p-2.5 bg-slate-50 border border-slate-100 rounded-xl flex flex-col justify-center">
                  <div className="flex items-center space-x-1 text-orange-600">
                    <Clock className="w-3 h-3" />
                    <span className="text-[9px] font-black uppercase tracking-wider">Vaqt</span>
                  </div>
                  <div className="text-base font-black text-slate-900 mt-0.5">
                    {Math.round(routeStats.duration / 60)} <span className="text-[10px] font-bold text-slate-500">min</span>
                  </div>
                </div>
              </div>
            )}

            {/* Primary computation trigger */}
            <div className="w-full">
              <button 
                className={`w-full py-2.5 rounded-xl font-black text-xs md:text-sm flex items-center justify-center space-x-2 transition-all cursor-pointer ${
                  selectedLocations.length < 2 
                    ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                    : routeStats 
                      ? 'bg-slate-50 border border-slate-200 hover:bg-slate-100 text-slate-700 active:scale-95'
                      : 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-lg active:scale-95 shadow-indigo-600/10'
                }`}
                onClick={() => calculateOptimizedRoute()}
                disabled={selectedLocations.length < 2 || isCalculating}
                title="Marshrutni hisoblash"
              >
                 {isCalculating ? (
                    <span className="flex items-center">
                      <div className="w-3.5 h-3.5 border-2 border-slate-400 border-t-slate-800 rounded-full animate-spin mr-2"></div>
                      Hisoblanmoqda...
                    </span>
                 ) : (
                    <span className="flex items-center space-x-1.5">
                      <Navigation className={`w-3.5 h-3.5 ${routeStats ? 'text-slate-500' : 'text-indigo-200 animate-pulse'}`} />
                      <span>{routeStats ? "Marshrutni qayta hisoblash" : "Optimallashtirilgan marshrutni hisoblash"}</span>
                    </span>
                 )}
              </button>
            </div>

            {/* External Navigation Links */}
            {(selectedLocations.length >= 2 || (selectedLocations.length === 1 && startFromMyLocation)) && (
               <div className="pt-2.5 border-t border-slate-100 flex flex-col space-y-2">
                 <div className="flex justify-between items-center px-0.5">
                   <span className="text-[10px] font-extrabold text-indigo-700 uppercase tracking-widest leading-none">
                     Navigatsiya boshlash:
                   </span>
                   {!routeStats && (
                     <span className="text-[9px] font-extrabold bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded leading-normal" title="Optimallashtirilgan marshrut olish uchun avval 'Marshrutni hisoblash' tugmasini bosing">
                       {startFromMyLocation ? "GPS dan boshlanadi" : "ketma-ketlikda"}
                     </span>
                   )}
                 </div>

                 {/* Navigation buttons row */}
                 <div className="grid grid-cols-2 gap-2 px-0.5">
                   <a 
                     href={getGoogleMapsUrl(selectedLocations)}
                     target="_blank"
                     rel="noopener noreferrer"
                     className="min-h-[48px] py-2 px-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-black text-xs flex items-center justify-center space-x-1.5 transition-all active:scale-95 text-center no-underline cursor-pointer shadow-sm"
                     title="Google Maps da ochish"
                   >
                     <img src="https://upload.wikimedia.org/wikipedia/commons/a/a9/Google_Maps_icon_%282020%29.svg" className="w-4 h-4 shrink-0" alt="" />
                     <span>Google Maps</span>
                   </a>

                   <a 
                     href={getYandexMapsUrl(selectedLocations)}
                     target="_blank"
                     rel="noopener noreferrer"
                     className="min-h-[48px] py-2 px-2 rounded-xl bg-orange-500 hover:bg-orange-600 text-white font-black text-xs flex items-center justify-center space-x-1.5 transition-all active:scale-95 text-center no-underline cursor-pointer shadow-sm"
                     title="Yandex Navigatsiyada ochish"
                   >
                     <svg className="w-4 h-4 fill-current shrink-0 text-white" viewBox="0 0 24 24">
                       <path d="M12.5 2C6.701 2 2 6.701 2 12.5S6.701 23 12.5 23 23 18.299 23 12.5 18.299 2 12.5 2zm1.751 14.125h-1.59l-.49 1.487h-1.3l1.884-5.263h1.492l1.884 5.263h-1.39l-.49-1.487zm-1.325-1.026h1.06l-.53-1.614-.53 1.614z"/>
                     </svg>
                     <span>Yandex Nav</span>
                   </a>
                 </div>

                 {/* Telegram Share Button */}
                 <button
                   type="button"
                   onClick={() => setIsTelegramModalOpen(true)}
                   className="w-full min-h-[42px] py-2 px-2 rounded-xl bg-sky-500 hover:bg-sky-600 text-white font-black text-xs flex items-center justify-center space-x-1.5 shadow-sm active:scale-95 transition-all cursor-pointer"
                   title="Telegramga yuborish: Haydovchiga to'liq marshrut va navigator havolalarini ulashish"
                 >
                   <Send className="w-3.5 h-3.5 shrink-0" />
                   <span>Telegramga yuborish</span>
                 </button>
               </div>
            )}
          </div>
        </div>

        {/* Economist / Analytics Panel */}
        {routeStats && (
          isRouteStatsExpanded ? (
            <div className="pointer-events-auto bg-white/95 backdrop-blur-md p-4 md:p-6 mb-4 md:mb-0 mx-2 md:mx-0 rounded-3xl shadow-2xl border border-slate-100 shrink-0 w-auto md:w-[384px] animate-in slide-in-from-right-4 duration-300 print:hidden overflow-y-auto max-h-[55vh] md:max-h-[50vh] overscroll-contain block animate-fade-in">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center space-x-2">
                  <Route className="w-5 h-5 text-indigo-600 animate-pulse" />
                  <div>
                    <h3 className="font-extrabold text-[15px] text-slate-900 tracking-tight">Marshrut Ma'lumotlari</h3>
                    <p className="text-[9px] text-slate-500 font-medium leading-tight">Navigatsiya QR-kodi yuklandi</p>
                  </div>
                </div>
                {/* Collapse button */}
                <button
                  type="button"
                  onClick={() => setIsRouteStatsExpanded(false)}
                  className="p-1.5 rounded-xl hover:bg-slate-100 text-slate-500 hover:text-slate-800 transition-all cursor-pointer flex items-center justify-center border border-slate-100 bg-slate-50"
                  title="Yig'ish"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              
              <div className="grid grid-cols-2 gap-3 mb-4">
                <div className="p-3 bg-slate-50 border border-slate-100 rounded-2xl">
                  <div className="flex items-center space-x-1.5 mb-1 text-blue-600">
                    <MapIcon className="w-3.5 h-3.5" />
                    <span className="text-[9px] font-bold uppercase tracking-wider">Masofa</span>
                  </div>
                  <div className="text-xl font-black text-slate-900 leading-none mt-1">
                    {(routeStats.distance / 1000).toFixed(1)} <span className="text-sm font-semibold text-slate-500">km</span>
                  </div>
                </div>
                <div className="p-3 bg-slate-50 border border-slate-100 rounded-2xl">
                  <div className="flex items-center space-x-1.5 mb-1 text-orange-600">
                    <Clock className="w-3.5 h-3.5" />
                    <span className="text-[9px] font-bold uppercase tracking-wider">Vaqt</span>
                  </div>
                  <div className="text-xl font-black text-slate-900 leading-none mt-1">
                    {Math.round(routeStats.duration / 60)} <span className="text-sm font-semibold text-slate-500">min</span>
                  </div>
                </div>
              </div>

              {/* QR Code Segment for Navigator */}
              <div className="mt-4 border-t border-slate-100 pt-4 flex flex-col items-center">
                <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2 self-start">Smartfonda ochish (QR kod):</h4>
                
                {/* Multi-vehicle branch: Route selection dropdown if routes > 1 */}
                {routeStats.routes && routeStats.routes.length > 1 && (
                  <div className="w-full mb-3">
                    <label className="text-[9px] font-bold text-slate-500 uppercase tracking-wider mb-1 block">Moshina tanlash:</label>
                    <select 
                      value={selectedRouteQrIdx} 
                      onChange={(e) => setSelectedRouteQrIdx(Number(e.target.value))}
                      className="w-full text-xs font-bold bg-slate-50 border border-slate-200 p-2 rounded-xl text-slate-700 outline-none cursor-pointer hover:border-slate-300"
                    >
                      {routeStats.routes.map((_: any, rIdx: number) => (
                        <option key={rIdx} value={rIdx}>Moshina #{rIdx + 1} yo'nalishi</option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Navigator Engine Tabs */}
                <div className="flex w-full bg-slate-100 p-1 rounded-xl mb-4">
                  <button
                    type="button"
                    onClick={() => setQrMapSelected('google')}
                    className={`flex-1 py-1.5 font-bold text-xs rounded-lg transition-all ${
                      qrMapSelected === 'google' 
                        ? 'bg-blue-600 text-white shadow' 
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Google Maps
                  </button>
                  <button
                    type="button"
                    onClick={() => setQrMapSelected('yandex')}
                    className={`flex-1 py-1.5 font-bold text-xs rounded-lg transition-all ${
                      qrMapSelected === 'yandex' 
                        ? 'bg-orange-500 text-white shadow' 
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Yandex Maps
                  </button>
                </div>

                {/* QR Code Container */}
                <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100 shadow-inner flex flex-col items-center justify-center w-full min-h-[220px]">
                  {(() => {
                    const activeRouteObj = routeStats.routes && routeStats.routes[selectedRouteQrIdx] 
                      ? routeStats.routes[selectedRouteQrIdx] 
                      : { locations: selectedLocations };
                    const targetNavigationUrl = qrMapSelected === 'google' 
                      ? getGoogleMapsUrl(activeRouteObj.locations)
                      : getYandexMapsUrl(activeRouteObj.locations);
                    const qrCodeImageSource = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(targetNavigationUrl)}`;

                    return (
                      <>
                        <div className="bg-white p-2.5 rounded-2xl shadow-sm border border-slate-100 mb-3 hover:scale-[1.02] transition-transform duration-200">
                          <img 
                            src={qrCodeImageSource} 
                            alt="Marshrut QR kodi" 
                            referrerPolicy="no-referrer"
                            className="w-40 h-40 object-contain rounded-lg"
                          />
                        </div>
                        <p className="text-[10px] text-center text-slate-500 font-semibold px-2">
                          Telefoningiz kamerasini QR-kodga qarating va navigatsiyani bir zumda oching.
                        </p>
                        <div className="mt-3 flex flex-col space-y-2 w-full">
                          <div className="flex space-x-2 w-full">
                            <a 
                              href={targetNavigationUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex-1 py-2 bg-white hover:bg-slate-100 text-slate-700 font-bold text-[10px] rounded-xl flex items-center justify-center space-x-1.5 border border-slate-200 transition-colors cursor-pointer no-underline text-center shadow-sm"
                            >
                              <ExternalLink className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                              <span>Navigatorda ochish</span>
                            </a>
                          </div>
                          <button
                            type="button"
                            onClick={() => setIsTelegramModalOpen(true)}
                            className="w-full py-2.5 bg-sky-500 hover:bg-sky-600 text-white font-black text-[11px] rounded-xl flex items-center justify-center space-x-1.5 transition-all cursor-pointer shadow-sm"
                          >
                            <Send className="w-3.5 h-3.5 shrink-0" />
                            <span>Telegramga yuborish</span>
                          </button>
                        </div>
                      </>
                    );
                  })()}
                </div>
              </div>
            </div>
          ) : (
            /* Collapsed view (small elegant floating pill-button on map bottom-right) */
            <button
              type="button"
              onClick={() => setIsRouteStatsExpanded(true)}
              className="pointer-events-auto print:hidden bg-slate-900 text-white rounded-full px-5 py-3 shadow-2xl border border-slate-800 font-bold text-xs flex items-center space-x-2 hover:bg-slate-800 hover:scale-105 active:scale-95 transition-all cursor-pointer mr-2 md:mr-0 mb-4 md:mb-0"
              title="Marshrut ma'lumotlarini yuklash"
            >
              <div className="relative flex h-2 w-2 mr-0.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </div>
              <Route className="w-4 h-4 text-emerald-400" />
              <span>Ma'lumotlar ({Math.round(routeStats.duration / 60)} min / {(routeStats.distance / 1000).toFixed(1)} km)</span>
            </button>
          )
        )}

        {/* Legend Panel (Condensed version) */}
        {!routeStats && (
          <div className="pointer-events-auto bg-white/95 backdrop-blur-md p-4 md:p-5 mx-2 md:ml-0 md:mr-16 mb-6 md:mb-6 rounded-3xl shadow-xl border border-slate-100 shrink-0">
            <h4 className="text-[10px] text-slate-500 uppercase tracking-widest font-bold mb-3">Xarita belgilari</h4>
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <div className="w-3 h-3 rounded-full bg-blue-500 border border-white shadow-sm"></div>
                <span className="text-xs font-semibold text-slate-700">Maktab</span>
              </div>
              <div className="flex items-center space-x-2">
                <div className="w-3 h-3 rounded-full bg-red-500 border border-white shadow-sm"></div>
                <span className="text-xs font-semibold text-slate-700">Bog'cha</span>
              </div>
              <div className="flex items-center space-x-2">
                <div className="w-3 h-3 rounded-full bg-green-500 border border-white shadow-sm"></div>
                <span className="text-xs font-semibold text-slate-700">Boshqa</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Print Table Layout */}
      {routeStats && (
        <div className="hidden print:block mt-8 text-black border-t-2 border-dashed border-slate-300 pt-6 px-4">
          <div className="flex justify-between items-start mb-6 font-bold text-sm">
            <div>
              <p>Topshiriq sanasi: <span className="font-normal text-slate-700">{new Date().toLocaleDateString()}</span></p>
            </div>
            <div className="text-right">
              <p>Holati: <span className="font-normal text-slate-700">Tasdiqlandi</span></p>
            </div>
          </div>

          {routeStats.routes && routeStats.routes.map((route: any, routeIndex: number) => (
            <div key={routeIndex} className="mb-8 break-inside-avoid">
              <h3 className="font-extrabold text-lg mb-3 flex items-center space-x-2" style={{color: route.color}}>
                 <span className="w-4 h-4 rounded-full" style={{backgroundColor: route.color}}></span>
                 <span>Marshrut #{routeIndex + 1} - Uzunligi: {(route.distance / 1000).toFixed(1)} km, Vaqti: {Math.round(route.duration / 60)} daqiqa</span>
              </h3>
              <table className="w-full text-sm border-collapse border border-slate-800">
                <thead>
                  <tr className="bg-slate-100">
                    <th className="border border-slate-800 py-2 px-3 text-center w-12 font-bold uppercase text-[10px]">№</th>
                    <th className="border border-slate-800 py-2 px-3 text-left font-bold uppercase text-[10px]">Muassasa nomi</th>
                    <th className="border border-slate-800 py-2 px-3 text-left font-bold uppercase text-[10px]">Mahalla</th>
                    <th className="border border-slate-800 py-2 px-3 text-left font-bold uppercase text-[10px]">Kadastr</th>
                    <th className="border border-slate-800 py-2 px-3 text-left font-bold uppercase text-[10px]">Mo'ljal</th>
                    <th className="border border-slate-800 py-2 px-3 text-left font-bold uppercase text-[10px]">Turi</th>
                    <th className="border border-slate-800 py-2 px-3 text-left font-bold uppercase text-[10px]">Sig'imi</th>
                  </tr>
                </thead>
                <tbody>
                  {route.locations.map((loc: any, i: number) => (
                    <tr key={loc.id}>
                      <td className="border border-slate-800 py-1.5 px-3 text-center">{i + 1}</td>
                      <td className="border border-slate-800 py-1.5 px-3 font-medium">{loc.name}</td>
                      <td className="border border-slate-800 py-1.5 px-3 font-medium text-[10px] text-blue-700">{loc.mahalla || '-'}</td>
                      <td className="border border-slate-800 py-1.5 px-3 font-mono text-[9px] text-slate-700">{loc.cadastre || '-'}</td>
                      <td className="border border-slate-800 py-1.5 px-3 font-medium text-[10px] italic">{loc.landmark || '-'}</td>
                      <td className="border border-slate-800 py-1.5 px-3 uppercase text-[10px] text-slate-600">{loc.type}</td>
                      <td className="border border-slate-800 py-1.5 px-3 text-[10px] text-slate-600">{loc.capacity ? `${loc.capacity} o'rin` : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

          <div className="mb-16 border-2 border-slate-900 rounded-xl p-5 bg-slate-50 w-full max-w-2xl mx-auto">
            <h4 className="font-black border-b-2 border-slate-900 pb-2 mb-4 uppercase text-sm tracking-widest text-center">Tasdiqlangan Marshrut Ma'lumotlari</h4>
            
            <div className="flex justify-between items-center mb-3 text-base">
              <span className="font-bold">Jami marshrut uzunligi:</span>
              <span className="font-semibold">{(routeStats.distance / 1000).toFixed(1)} km</span>
            </div>
            <div className="flex justify-between items-center mb-3 text-base">
              <span className="font-bold">Taxminiy borish vaqti:</span>
              <span className="font-semibold">{Math.round(routeStats.duration / 60)} daqiqa</span>
            </div>
            <div className="flex justify-between items-center mt-6 pt-4 border-t-2 border-slate-900 font-black text-lg">
              <span>Tasdiqlandi:</span>
            </div>
          </div>

          <div className="flex justify-between px-12 mt-20">
            <div className="text-center font-bold">
              <div className="mb-12 text-left">Tasdiqlayman:<br/>MMTB Mudiri</div>
              <div className="border-t border-slate-900 w-64 mx-auto pt-2 text-sm text-slate-500 uppercase">(Imzo, F.I.O)</div>
            </div>
            <div className="text-center font-bold">
              <div className="mb-12 text-left">Tuzdi:<br/>Bosh Iqtisodchi</div>
              <div className="border-t border-slate-900 w-64 mx-auto pt-2 text-sm text-slate-500 uppercase">(Imzo, F.I.O)</div>
            </div>
          </div>
        </div>
      )}

      {/* Resizable Quick Widget Panel */}
      <QuickWidgetPanel
        isOpen={isWidgetOpen}
        onClose={() => setIsWidgetOpen(false)}
        locations={filteredLocations}
        selectedLocations={selectedLocations}
        userLocation={userLocation}
        fallbackCenter={center}
        onRequestGps={handleGetLocation}
        onToggleLocation={handleToggleWidgetLocation}
        onSetSelectedLocations={handleSetWidgetLocations}
        onClearSelected={handleClearRoute}
        onBuildRouteFromGps={handleWidgetBuildRouteFromGps}
        onQuickNearestRoute={(pool) => {
          setIsWidgetOpen(false);
          handleQuickNearestRoute(pool);
        }}
        showToast={showToast}
      />

      {/* Telegram Route Dispatch Modal */}
      <TelegramRouteModal
        isOpen={isTelegramModalOpen}
        onClose={() => setIsTelegramModalOpen(false)}
        locations={selectedLocations}
        routeStats={routeStats}
        userLocation={userLocation}
        startFromMyLocation={startFromMyLocation}
        isRoundtrip={isRoundtrip}
        showToast={showToast}
      />
    </div>
  );
}
