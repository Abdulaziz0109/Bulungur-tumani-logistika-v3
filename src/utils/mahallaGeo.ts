import { Location } from '../types';

export interface MahallaProperties {
  id: number;
  code: string;
  name_uz: string;
  name_ru: string;
  total_area_hectares: number;
}

export interface MahallaFeature {
  type: 'Feature';
  properties: MahallaProperties;
  geometry: {
    type: 'Polygon' | 'MultiPolygon';
    coordinates: any;
  };
}

export interface MahallaFeatureCollection {
  type: 'FeatureCollection';
  features: MahallaFeature[];
}

const MAHALLA_PALETTE = [
  '#2563eb', // Blue
  '#0d9488', // Teal
  '#7c3aed', // Violet
  '#d97706', // Amber
  '#059669', // Emerald
  '#db2777', // Pink
  '#4f46e5', // Indigo
  '#0284c7', // Sky
  '#ea580c', // Orange
  '#65a30d', // Lime
  '#9333ea', // Purple
  '#e11d48', // Rose
];

export function getMahallaColor(indexOrId: number): string {
  const idx = Math.abs(indexOrId) % MAHALLA_PALETTE.length;
  return MAHALLA_PALETTE[idx];
}

function pointInRing(lng: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-15) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygonRings(lng: number, lat: number, rings: number[][][]): boolean {
  if (!rings.length || !pointInRing(lng, lat, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(lng, lat, rings[i])) return false;
  }
  return true;
}

export function pointInMahallaFeature(
  lat: number,
  lng: number,
  feature: MahallaFeature
): boolean {
  const geom = feature.geometry;
  if (!geom || !geom.coordinates) return false;
  if (geom.type === 'Polygon') {
    return pointInPolygonRings(lng, lat, geom.coordinates);
  }
  if (geom.type === 'MultiPolygon') {
    for (let i = 0; i < geom.coordinates.length; i++) {
      if (pointInPolygonRings(lng, lat, geom.coordinates[i])) return true;
    }
  }
  return false;
}

export function getLocationsInsideMahalla(
  feature: MahallaFeature,
  locations: Location[]
): Location[] {
  return locations.filter(
    (loc) =>
      typeof loc.lat === 'number' &&
      typeof loc.lng === 'number' &&
      pointInMahallaFeature(loc.lat, loc.lng, feature)
  );
}

export function findMahallaForPoint(
  lat: number,
  lng: number,
  collection: MahallaFeatureCollection | null
): MahallaFeature | null {
  if (!collection?.features?.length) return null;
  for (const f of collection.features) {
    if (pointInMahallaFeature(lat, lng, f)) return f;
  }
  return null;
}

export function normalizeMahallaQuery(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’`ʻʼ‘]/g, '')
    .replace(/\bmfy\b/g, '')
    .replace(/\bmahalla(si)?\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function matchMahallasByQuery(
  query: string,
  collection: MahallaFeatureCollection | null
): MahallaFeature[] {
  if (!collection?.features?.length) return [];
  const q = normalizeMahallaQuery(query);
  if (!q) {
    return [...collection.features].sort((a, b) =>
      a.properties.name_uz.localeCompare(b.properties.name_uz)
    );
  }
  return collection.features
    .filter((f) => {
      const uz = normalizeMahallaQuery(f.properties.name_uz || '');
      const ru = normalizeMahallaQuery(f.properties.name_ru || '');
      const code = (f.properties.code || '').toLowerCase();
      return uz.includes(q) || ru.includes(q) || code.includes(q);
    })
    .sort((a, b) => {
      const aStarts = normalizeMahallaQuery(a.properties.name_uz).startsWith(q) ? 0 : 1;
      const bStarts = normalizeMahallaQuery(b.properties.name_uz).startsWith(q) ? 0 : 1;
      if (aStarts !== bStarts) return aStarts - bStarts;
      return a.properties.name_uz.localeCompare(b.properties.name_uz);
    });
}
