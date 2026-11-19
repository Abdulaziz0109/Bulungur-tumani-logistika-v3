export interface BotLocation {
  id: string;
  name: string;
  type: string;
  lat: number;
  lng: number;
  mahalla?: string;
  landmark?: string;
  capacity?: number;
  cadastre?: string;
  totalLandArea?: number;
  buildingFootprintArea?: number;
}

const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'x', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sh',
  ъ: '', ы: 'i', ь: '', э: 'e', ю: 'yu', я: 'ya', ў: 'o', қ: 'q', ғ: 'g', ҳ: 'h',
};

export function normalizeText(input: string): string {
  if (!input) return '';
  let out = '';
  for (const ch of input.toLowerCase()) {
    out += CYRILLIC_TO_LATIN[ch] !== undefined ? CYRILLIC_TO_LATIN[ch] : ch;
  }
  return out
    .replace(/['‘’`ʻʼ"]/g, '')
    .replace(/[-_.,/\\()?!:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function escapeHtml(text: string): string {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

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

export function formatDistanceLabel(km: number): string {
  if (km < 1) {
    return `${km.toFixed(2)} km (${Math.round(km * 1000)} m)`;
  }
  return `${km.toFixed(2)} km`;
}

export const STOP_WORDS = new Set([
  'masofa', 'masofasi', 'qancha', 'necha', 'km', 'kilometr', 'metr', 'orasi',
  'orasida', 'orasidagi', 'ortasida', 'tekis', 'togri', 'chiziq', 'havo',
  'olchaganda', 'olchash', 'mashina', 'avtomobil', 'yoli', 'yolda', 'yol',
  'qayerda', 'joylashuvi', 'joylashgan', 'manzil', 'manzili', 'kadastr',
  'haqida', 'malumot', 'kerak', 'menga', 'topib', 'ber', 'bering', 'korsat',
  'marshrut', 'yonalish', 'qilib', 'ketmoqchiman', 'bormoqchiman', 'va', 'bilan',
  'hamda', 'dan', 'ga', 'gacha', 'uchun', 'eng', 'yaqin', 'ayting', 'ayt', 'chi'
]);

export const KG_ALIASES = new Set(['bogcha', 'bog', 'dmtt', 'mtt', 'dmt', 'sadik', 'yasli']);
export const SCHOOL_ALIASES = new Set(['maktab', 'mkt', 'shkola', 'school']);

export function stripUzbekSuffix(token: string): string {
  if (!token) return '';
  if (/^\d+$/.test(token) || KG_ALIASES.has(token) || SCHOOL_ALIASES.has(token) || STOP_WORDS.has(token)) {
    return token;
  }
  const stripped = token
    .replace(/(gacha|ning|niki|dagi|dan|ga|ka|qa|da|ta|ni|si|i)$/i, '')
    .trim();
  return stripped.length >= 2 ? stripped : token;
}

export function scoreLocationAgainstSegment(loc: BotLocation, rawSegment: string): number {
  const segNorm = normalizeText(rawSegment);
  if (!segNorm) return 0;

  const rawTokens = segNorm
    .split(' ')
    .map(stripUzbekSuffix)
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t));

  if (rawTokens.length === 0) return 0;

  const nameNorm = normalizeText(loc.name);
  const mahallaNorm = normalizeText(loc.mahalla || '');
  const landmarkNorm = normalizeText(loc.landmark || '');
  const cadNorm = normalizeText(loc.cadastre || '');
  const isSchool = loc.type === 'maktab' || nameNorm.includes('maktab');
  const isKg =
    loc.type === 'dmtt' ||
    loc.type === 'bogcha' ||
    nameNorm.includes('dmtt') ||
    nameNorm.includes('bogcha');

  const typeAliases = isSchool ? 'maktab' : isKg ? 'bogcha dmtt mtt' : 'boshqa tashkilot';
  const textPool = `${nameNorm} ${typeAliases} ${mahallaNorm} ${landmarkNorm}`;
  const isCadastreQuery = rawTokens.length >= 3 && rawTokens.every((t) => /^\d+$/.test(t));
  const combined = isCadastreQuery ? `${textPool} ${cadNorm}` : textPool;

  const matchedAll = rawTokens.every((tok) => {
    if (KG_ALIASES.has(tok)) return isKg || textPool.includes(tok);
    if (SCHOOL_ALIASES.has(tok)) return isSchool || textPool.includes('maktab');
    return combined.includes(tok);
  });

  if (!matchedAll) return 0;

  let score = 10;
  const cleanedPhrase = rawTokens.join(' ');
  if (nameNorm === cleanedPhrase) score += 200;
  else if (nameNorm.startsWith(cleanedPhrase)) score += 120;
  else if (nameNorm.includes(cleanedPhrase)) score += 60;

  const nameWords = nameNorm.split(' ');
  for (const tok of rawTokens) {
    if (/^\d+$/.test(tok)) {
      if (nameWords.includes(tok)) score += 160;
      else if (nameNorm.startsWith(tok)) score += 90;
      else if (isCadastreQuery && cadNorm.includes(tok)) score += 50;
      else score -= 30;
    }
    if (KG_ALIASES.has(tok) && isKg) score += 80;
    if (SCHOOL_ALIASES.has(tok) && isSchool) score += 80;
  }

  return score;
}

export function searchSingleQuery(allLocations: BotLocation[], queryText: string): BotLocation[] {
  const scored = allLocations
    .map((loc) => ({ loc, score: scoreLocationAgainstSegment(loc, queryText) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.loc.name.localeCompare(b.loc.name));

  return scored.map((s) => s.loc);
}

export function extractMultipleLocations(userText: string, allLocations: BotLocation[]): BotLocation[] {
  if (!userText || !userText.trim()) return [];

  // Preserve comma/semicolon/plus/newline separators BEFORE normalizeText strips punctuation
  const preSegmented = userText
    .replace(/[;,+\n]+/g, ' | ')
    .split('|')
    .flatMap((chunk) => {
      const norm = normalizeText(chunk);
      if (!norm) return [];
      return norm
        .replace(/\b(bilan|hamda|va)\b/g, ' | ')
        .replace(/(\S+dan)\s+/g, '$1 | ')
        .split('|')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    });

  if (preSegmented.length < 2) return [];

  const lastSegNorm = normalizeText(preSegmented[preSegmented.length - 1]);
  const trailingIsKg = /\b(bogcha|bog|dmtt|mtt|dmt|sadik|yasli)\b/.test(lastSegNorm);
  const trailingIsSchool = /\b(maktab|mkt|shkola|school)\b/.test(lastSegNorm);

  const picked: BotLocation[] = [];
  const pickedIds = new Set<string>();

  for (const seg of preSegmented) {
    const cleanNumSeg = normalizeText(seg);
    let matches = searchSingleQuery(allLocations, seg);
    if (/^\d+$/.test(cleanNumSeg) && (trailingIsKg || trailingIsSchool)) {
      const hinted = searchSingleQuery(allLocations, `${cleanNumSeg} ${trailingIsKg ? 'bogcha' : 'maktab'}`);
      if (hinted.length > 0) {
        matches = hinted;
      }
    }
    if (matches.length > 0) {
      const candidate = matches.find((m) => !pickedIds.has(m.id));
      if (candidate) {
        picked.push(candidate);
        pickedIds.add(candidate.id);
      }
    }
  }

  return picked;
}

export function isDistanceIntent(text: string): boolean {
  const norm = normalizeText(text);
  return /\b(masofa|masofasi|orasi|orasida|orasidagi|ortasida|qancha|necha|km|tekis|togri|havo|mashina|avtomobil|yoli|yolda|olchaganda|gacha|uzoq)\b/.test(
    norm
  );
}

export function sanitizeCallbackData(prefix: string, id: string): string {
  const raw = `${prefix}${id}`;
  // Telegram callback_data limit is 64 UTF-8 bytes
  if (Buffer.byteLength(raw, 'utf8') <= 64) {
    return raw;
  }
  let truncated = raw;
  while (Buffer.byteLength(truncated, 'utf8') > 64 && truncated.length > 0) {
    truncated = truncated.slice(0, -1);
  }
  return truncated;
}

export function buildYandexNavUrl(locs: BotLocation[]): string {
  if (locs.length === 0) return '';
  if (locs.length === 1) {
    return `https://yandex.uz/maps/?rtext=~${locs[0].lat},${locs[0].lng}&rtt=auto`;
  }
  const coords = locs.map((l) => `${l.lat},${l.lng}`).join('~');
  return `https://yandex.uz/maps/?rtext=${coords}&rtt=auto`;
}

export function buildGoogleNavUrl(locs: BotLocation[]): string {
  if (locs.length === 0) return '';
  if (locs.length === 1) {
    return `https://www.google.com/maps/dir/?api=1&destination=${locs[0].lat},${locs[0].lng}&travelmode=driving&dir_action=navigate`;
  }
  const origin = `${locs[0].lat},${locs[0].lng}`;
  const destination = `${locs[locs.length - 1].lat},${locs[locs.length - 1].lng}`;
  const waypoints = locs.slice(1, -1).map((l) => `${l.lat},${l.lng}`).join('%7C');
  return `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}${waypoints ? `&waypoints=${waypoints}` : ''}&travelmode=driving&dir_action=navigate`;
}
