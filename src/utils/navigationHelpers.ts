import { Location } from '../types';

export function haversineDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) *
      Math.cos(lat2 * (Math.PI / 180)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'x', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sh',
  ъ: '', ы: 'i', ь: '', э: 'e', ю: 'yu', я: 'ya', ў: 'o', қ: 'q', ғ: 'g', ҳ: 'h',
};

export function normalizeSearchText(input: string): string {
  if (!input) return '';
  const lower = input.toLowerCase();
  let latin = '';
  for (const ch of lower) {
    latin += CYRILLIC_TO_LATIN[ch] !== undefined ? CYRILLIC_TO_LATIN[ch] : ch;
  }
  return latin
    .replace(/['‘’`ʻʼ"]/g, '')
    .replace(/[-_.,/\\()]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function smartSearchLocations(
  locations: Location[],
  rawQuery: string,
  userLocation: [number, number] | null = null,
  limit = 10
): Array<Location & { distanceKm?: number }> {
  const normQuery = normalizeSearchText(rawQuery);
  if (!normQuery) return [];

  const KG_ALIASES = new Set(['bogcha', 'bog', 'dmtt', 'mtt', 'dmt', 'sadik', 'yasli']);
  const SCHOOL_ALIASES = new Set(['maktab', 'mkt', 'shkola', 'school']);

  const tokens = normQuery.split(' ').filter(Boolean);
  const queryHasKindergarten = tokens.some(t => KG_ALIASES.has(t));
  const queryHasSchool = tokens.some(t => SCHOOL_ALIASES.has(t));
  const queryNumbers = tokens.filter(t => /^\d+$/.test(t));
  const isCadastreQuery = rawQuery.includes(':') || (tokens.length >= 3 && tokens.every(t => /^\d+$/.test(t)));

  const scored = locations
    .map((loc) => {
      const nameNorm = normalizeSearchText(loc.name || '');
      const mahallaNorm = normalizeSearchText(loc.mahalla || '');
      const landmarkNorm = normalizeSearchText(loc.landmark || '');
      const cadNorm = normalizeSearchText(loc.cadastre || '');
      const isSchool = loc.type === 'maktab' || nameNorm.includes('maktab');
      const isKg = loc.type === 'dmtt' || loc.type === 'bogcha' || nameNorm.includes('dmtt') || nameNorm.includes('bogcha');

      const typeAliases = isSchool ? 'maktab' : isKg ? 'bogcha dmtt mtt' : 'boshqa tashkilot';
      const textPool = `${nameNorm} ${typeAliases} ${mahallaNorm} ${landmarkNorm}`;
      const combined = isCadastreQuery ? `${textPool} ${cadNorm}` : textPool;

      // Every token must match somewhere in combined
      const allTokensMatch = tokens.every((tok) => {
        if (KG_ALIASES.has(tok)) {
          return isKg || textPool.includes(tok);
        }
        if (SCHOOL_ALIASES.has(tok)) {
          return isSchool || textPool.includes('maktab');
        }
        return combined.includes(tok);
      });

      if (!allTokensMatch) return null;

      let score = 0;

      // Exact full string or prefix match
      if (nameNorm === normQuery) score += 200;
      else if (nameNorm.startsWith(normQuery)) score += 120;
      else if (nameNorm.includes(normQuery)) score += 60;

      // Number exact word match ("9" -> "9 dmtt" beats "19 dmtt" and "90")
      const nameWords = nameNorm.split(' ');
      for (const num of queryNumbers) {
        if (nameWords.includes(num)) {
          score += 150;
        } else if (nameNorm.startsWith(num)) {
          score += 90;
        } else if (isCadastreQuery && cadNorm.includes(num)) {
          score += 50;
        }
      }

      // Type bonus
      if (queryHasKindergarten && isKg) score += 80;
      if (queryHasSchool && isSchool) score += 80;

      // Mahalla / Landmark match
      if (mahallaNorm.includes(normQuery)) score += 40;
      if (landmarkNorm.includes(normQuery)) score += 25;

      let distanceKm: number | undefined;
      if (userLocation) {
        distanceKm = haversineDistanceKm(userLocation[0], userLocation[1], loc.lat, loc.lng);
      }

      return { loc, score, distanceKm };
    })
    .filter((item): item is { loc: Location; score: number; distanceKm: number | undefined } => item !== null);

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.distanceKm !== undefined && b.distanceKm !== undefined) {
      return a.distanceKm - b.distanceKm;
    }
    return a.loc.name.localeCompare(b.loc.name);
  });

  return scored.slice(0, limit).map((item) => ({
    ...item.loc,
    distanceKm: item.distanceKm,
  }));
}

/**
 * Builds Yandex Maps / Navigator driving URL.
 * - When startFromUserLocation is true and userLocation is known: starts directly from user's GPS coords.
 * - When startFromUserLocation is true and userLocation is unknown: prefixes rtext with `~` so Yandex uses phone GPS automatically!
 * - Always appends `rtt=auto` to jump straight into driving route mode.
 */
export function buildYandexMapsUrl(
  stops: Location[],
  userLocation: [number, number] | null = null,
  startFromUserLocation = true,
  isRoundtrip = false
): string {
  if (!stops || stops.length === 0) return '';

  // Remove any synthetic GPS marker if we will prepend live userLocation anyway
  const cleanStops = stops.filter((s) => !s.id.startsWith('gps-'));
  if (cleanStops.length === 0) return '';

  const pts: string[] = [];

  if (startFromUserLocation) {
    if (userLocation) {
      pts.push(`${userLocation[0]},${userLocation[1]}`);
    } else {
      // Leading empty coordinate before '~' instructs Yandex Maps/Navigator to use current GPS!
      pts.push('');
    }
  } else if (cleanStops.length === 1) {
    // Single destination without explicit origin needs leading '~' so Yandex treats it as destination
    pts.push('');
  }

  cleanStops.forEach((s) => {
    pts.push(`${s.lat},${s.lng}`);
  });

  if (isRoundtrip && cleanStops.length >= 2) {
    if (startFromUserLocation && userLocation) {
      pts.push(`${userLocation[0]},${userLocation[1]}`);
    } else {
      pts.push(`${cleanStops[0].lat},${cleanStops[0].lng}`);
    }
  }

  return `https://yandex.uz/maps/?rtext=${pts.join('~')}&rtt=auto`;
}

/**
 * Builds Google Maps driving URL.
 * - When startFromUserLocation is true and userLocation is known: sets origin=${lat},${lng}.
 * - When startFromUserLocation is true and userLocation is unknown: omits origin so Google Maps uses phone's live GPS ("Your location")!
 * - Appends travelmode=driving & dir_action=navigate for 1-tap navigation start.
 */
export function buildGoogleMapsUrl(
  stops: Location[],
  userLocation: [number, number] | null = null,
  startFromUserLocation = true,
  isRoundtrip = false
): string {
  if (!stops || stops.length === 0) return '';

  const cleanStops = stops.filter((s) => !s.id.startsWith('gps-'));
  if (cleanStops.length === 0) return '';

  if (cleanStops.length === 1) {
    const dest = `${cleanStops[0].lat},${cleanStops[0].lng}`;
    const originParam = startFromUserLocation && userLocation ? `&origin=${userLocation[0]},${userLocation[1]}` : '';
    return `https://www.google.com/maps/dir/?api=1${originParam}&destination=${dest}&travelmode=driving&dir_action=navigate`;
  }

  let originParam = '';
  let waypointsList: Location[] = [];
  let destination = '';

  if (startFromUserLocation) {
    if (userLocation) {
      originParam = `&origin=${userLocation[0]},${userLocation[1]}`;
    }
    if (isRoundtrip) {
      destination = userLocation ? `${userLocation[0]},${userLocation[1]}` : `${cleanStops[0].lat},${cleanStops[0].lng}`;
      waypointsList = cleanStops;
    } else {
      destination = `${cleanStops[cleanStops.length - 1].lat},${cleanStops[cleanStops.length - 1].lng}`;
      waypointsList = cleanStops.slice(0, -1);
    }
  } else {
    originParam = `&origin=${cleanStops[0].lat},${cleanStops[0].lng}`;
    if (isRoundtrip) {
      destination = `${cleanStops[0].lat},${cleanStops[0].lng}`;
      waypointsList = cleanStops.slice(1);
    } else {
      destination = `${cleanStops[cleanStops.length - 1].lat},${cleanStops[cleanStops.length - 1].lng}`;
      waypointsList = cleanStops.slice(1, -1);
    }
  }

  const waypointsStr = waypointsList.map((w) => `${w.lat},${w.lng}`).join('%7C');
  return `https://www.google.com/maps/dir/?api=1${originParam}&destination=${destination}${waypointsStr ? `&waypoints=${waypointsStr}` : ''}&travelmode=driving&dir_action=navigate`;
}

/**
 * Nearest-neighbor greedy ordering starting from (originLat, originLng)
 */
export function sortLocationsNearestFirst(
  stops: Location[],
  originLat: number,
  originLng: number
): Location[] {
  const remaining = stops.filter((s) => !s.id.startsWith('gps-'));
  const ordered: Location[] = [];
  let curLat = originLat;
  let curLng = originLng;

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversineDistanceKm(curLat, curLng, remaining[i].lat, remaining[i].lng);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    const [picked] = remaining.splice(bestIdx, 1);
    ordered.push(picked);
    curLat = picked.lat;
    curLng = picked.lng;
  }

  return ordered;
}

/**
 * Parses comma / connector separated query like "4 maktab, 9 bog'cha, 15"
 * into distinct matched Location items.
 */
export function parseMultiQueryLocations(
  locations: Location[],
  rawInput: string,
  userLocation: [number, number] | null = null
): Location[] {
  if (!rawInput || !rawInput.trim()) return [];

  const rawSegments = rawInput
    .replace(/([a-zA-Z0-9\u0400-\u04FF'‘’`ʻʼ-]+dan)\s+(?=[a-zA-Z0-9\u0400-\u04FF])/gi, '$1 | ')
    .split(/[,;+&\n|]+|\b(?:va|bilan|hamda)\b/i)
    .map((s) =>
      s
        .trim()
        .replace(/(gacha|dan|ga)$/i, '')
        .trim()
    )
    .filter((s) => s.length > 0);

  if (rawSegments.length < 2) return [];

  // Inherit trailing type hint (e.g. "4, 9 bog'cha" -> apply "bog'cha" if "4" is ambiguous)
  const lastSegNorm = normalizeSearchText(rawSegments[rawSegments.length - 1]);
  const trailingIsKg = /\b(bogcha|bog|dmtt|mtt|dmt|sadik|yasli)\b/.test(lastSegNorm);
  const trailingIsSchool = /\b(maktab|mkt|shkola|school)\b/.test(lastSegNorm);

  const picked: Location[] = [];
  const pickedIds = new Set<string>();

  for (const seg of rawSegments) {
    const normSeg = normalizeSearchText(seg);
    let matches = smartSearchLocations(locations, seg, userLocation, 5);

    if (/^\d+$/.test(normSeg) && (trailingIsKg || trailingIsSchool)) {
      const hinted = `${seg} ${trailingIsKg ? 'bogcha' : 'maktab'}`;
      const hintedMatches = smartSearchLocations(locations, hinted, userLocation, 3);
      if (hintedMatches.length > 0) {
        matches = hintedMatches;
      }
    }

    const firstUnused = matches.find((m) => !pickedIds.has(m.id));
    if (firstUnused) {
      picked.push(firstUnused);
      pickedIds.add(firstUnused.id);
    }
  }

  return picked;
}

