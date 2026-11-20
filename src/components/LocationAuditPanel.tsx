import React, { useMemo, useState } from 'react';
import { doc, updateDoc, deleteDoc, addDoc, collection } from 'firebase/firestore';
import { db } from '../lib/firebase';
import {
  AlertTriangle,
  ArrowLeftRight,
  Check,
  Copy,
  Edit3,
  ExternalLink,
  MapPin,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';

interface LocationDoc {
  id: string;
  name: string;
  type: string;
  lat: number;
  lng: number;
  mahalla?: string;
  landmark?: string;
  cadastre?: string;
}

interface LocationAuditPanelProps {
  locations: LocationDoc[];
  onRefresh: () => Promise<void> | void;
  onSuccess: (msg: string) => void;
  onError: (msg: string) => void;
}

interface ShiftProposal {
  key: string;
  targetName: string;
  sourceLabel: string;
  lat: number;
  lng: number;
  note: string;
}

// Original seed coordinates that were overwritten/deleted during earlier manual edits
const RECOVERED_SEED_COORDS = {
  oldRow49: { lat: 39.667885, lng: 67.357414, label: 'Eski 49-qator (seed)' },
  oldRow62: { lat: 39.702037, lng: 67.390612, label: 'Eski 62-qator (seed)' },
  oldRow64: { lat: 39.786551, lng: 67.278228, label: "Eski 64-qator (Yangiariq MFY hududi)" },
};

function normalizeKey(str: string): string {
  return (str || '')
    .toLowerCase()
    .replace(/['’‘`ʻʼ\s-]+/g, '')
    .trim();
}

function normalizeMahalla(str: string): string {
  return normalizeKey(str).replace(/mfy$/i, '');
}

function extractSchoolNumber(name: string): number {
  const m = (name || '').match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 9999;
}

function distMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function yandexPointUrl(lat: number, lng: number): string {
  return `https://yandex.uz/maps/?pt=${lng.toFixed(6)},${lat.toFixed(6)}&z=16&l=sat,skl`;
}

export default function LocationAuditPanel({
  locations,
  onRefresh,
  onSuccess,
  onError,
}: LocationAuditPanelProps) {
  const [search, setSearch] = useState('');
  const [filterMode, setFilterMode] = useState<'all' | 'maktab' | 'dmtt' | 'suspect'>('maktab');
  const [busyAction, setBusyAction] = useState<string | null>(null);

  // Swap coordinates tool state
  const [swapAId, setSwapAId] = useState('');
  const [swapBId, setSwapBId] = useState('');

  // Inline edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editMahalla, setEditMahalla] = useState('');
  const [editLat, setEditLat] = useState('');
  const [editLng, setEditLng] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Checked shift proposals (defaults to all checked)
  const [uncheckedShifts, setUncheckedShifts] = useState<Record<string, boolean>>({});

  // 1. Duplicate name groups
  const duplicateGroups = useMemo(() => {
    const map = new Map<string, LocationDoc[]>();
    for (const loc of locations) {
      const k = `${loc.type || ''}::${normalizeKey(loc.name)}`;
      const list = map.get(k) || [];
      list.push(loc);
      map.set(k, list);
    }
    return [...map.values()].filter(g => g.length > 1);
  }, [locations]);

  const totalExtraDuplicates = useMemo(
    () => duplicateGroups.reduce((acc, g) => acc + (g.length - 1), 0),
    [duplicateGroups]
  );

  // Deduplicated schools sorted by number for analysis
  const schools = useMemo(() => {
    return locations
      .filter(l => l.type === 'maktab')
      .sort((a, b) => extractSchoolNumber(a.name) - extractSchoolNumber(b.name));
  }, [locations]);

  // 2. Overlapping school pairs (< 150 meters)
  const overlapPairs = useMemo(() => {
    const uniqueByName = new Map<string, LocationDoc>();
    for (const s of schools) {
      const k = normalizeKey(s.name);
      if (!uniqueByName.has(k)) uniqueByName.set(k, s);
    }
    const list = [...uniqueByName.values()];
    const pairs: Array<{ a: LocationDoc; b: LocationDoc; meters: number }> = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const m = distMeters(list[i].lat, list[i].lng, list[j].lat, list[j].lng);
        if (m < 150) {
          pairs.push({ a: list[i], b: list[j], meters: Math.round(m) });
        }
      }
    }
    return pairs.sort((x, y) => x.meters - y.meters);
  }, [schools]);

  // 3. MFY vs GPS anomaly detection (> 4 km from other facilities in same MFY)
  const suspectIds = useMemo(() => {
    const byMahalla = new Map<string, LocationDoc[]>();
    for (const loc of locations) {
      const mk = normalizeMahalla(loc.mahalla || '');
      if (!mk) continue;
      const arr = byMahalla.get(mk) || [];
      arr.push(loc);
      byMahalla.set(mk, arr);
    }
    const flagged = new Map<string, string>();
    for (const group of byMahalla.values()) {
      if (group.length < 2) continue;
      for (const item of group) {
        const others = group.filter(o => o.id !== item.id);
        const minDistKm = Math.min(
          ...others.map(o => distMeters(item.lat, item.lng, o.lat, o.lng) / 1000)
        );
        if (minDistKm > 4) {
          flagged.set(item.id, `Shu MFYdagi boshqa nuqtadan ${minDistKm.toFixed(1)} km uzoqda`);
        }
      }
    }
    // Also flag overlapping pairs
    for (const pair of overlapPairs) {
      if (!flagged.has(pair.a.id)) flagged.set(pair.a.id, `${pair.b.name} bilan ${pair.meters} m (ustma-ust)`);
      if (!flagged.has(pair.b.id)) flagged.set(pair.b.id, `${pair.a.name} bilan ${pair.meters} m (ustma-ust)`);
    }
    return flagged;
  }, [locations, overlapPairs]);

  // 4. Detected +1 (56..60) & +2 (65..72) shift proposals (automatically hidden once applied!)
  const shiftProposals = useMemo<ShiftProposal[]>(() => {
    const findSchool = (num: number) =>
      schools.find(s => extractSchoolNumber(s.name) === num);

    const list: ShiftProposal[] = [];

    const addIfNeeded = (
      key: string,
      targetName: string,
      sourceLabel: string,
      lat: number,
      lng: number,
      note: string
    ) => {
      const target = findSchool(extractSchoolNumber(targetName));
      if (target && distMeters(target.lat, target.lng, lat, lng) < 30) {
        return; // Already fixed!
      }
      list.push({ key, targetName, sourceLabel, lat, lng, note });
    };

    // +1 shift block (old 49 -> 50, 50 -> 51, 51 -> 52, 52 -> 53, 53 -> 54, 54 -> 55, 55 -> 56, 56 -> 57, 57 -> 58, 58 -> 59, 59 -> 60)
    const s50 = findSchool(50);
    const s51 = findSchool(51);
    const s52 = findSchool(52);
    const s53 = findSchool(53);
    const s54 = findSchool(54);
    const s55 = findSchool(55);
    const s56 = findSchool(56);
    const s57 = findSchool(57);
    const s58 = findSchool(58);
    const s59 = findSchool(59);

    if (s50 && distMeters(s50.lat, s50.lng, 39.713789, 67.387784) < 200) {
      addIfNeeded(
        'old49_to_50',
        '50-maktab',
        RECOVERED_SEED_COORDS.oldRow49.label,
        RECOVERED_SEED_COORDS.oldRow49.lat,
        RECOVERED_SEED_COORDS.oldRow49.lng,
        "Nebo'sa MFY hududi (eski 49-qator, +1 siljish)"
      );
      addIfNeeded(
        '50_to_51',
        '51-maktab',
        'Hozirgi 50-maktab koordinatasi',
        s50.lat,
        s50.lng,
        '+1 siljish (50 → 51)'
      );
    }
    if (s51 && distMeters(s51.lat, s51.lng, 39.694999, 67.315246) < 200) {
      addIfNeeded(
        '51_to_52',
        '52-maktab',
        'Hozirgi 51-maktab koordinatasi',
        s51.lat,
        s51.lng,
        '+1 siljish (51 → 52)'
      );
    }
    if (s52 && distMeters(s52.lat, s52.lng, 39.672770, 67.264766) < 200) {
      addIfNeeded(
        '52_to_53',
        '53-maktab',
        'Hozirgi 52-maktab koordinatasi',
        s52.lat,
        s52.lng,
        'Siz tasdiqlagansiz: 52 asli 53-maktab (+1 siljish)'
      );
    }
    if (s53 && distMeters(s53.lat, s53.lng, 39.692397, 67.240538) < 200) {
      addIfNeeded(
        '53_to_54',
        '54-maktab',
        'Hozirgi 53-maktab koordinatasi',
        s53.lat,
        s53.lng,
        'Siz tasdiqlagansiz: 53 asli 54-maktab (+1 siljish)'
      );
    }
    if (s54 && distMeters(s54.lat, s54.lng, 39.766777, 67.292149) < 200) {
      addIfNeeded(
        '54_to_55',
        '55-maktab',
        'Hozirgi 54-maktab koordinatasi',
        s54.lat,
        s54.lng,
        'Siz tasdiqlagansiz: 54 asli 55-maktab (56 ustidan ajratiladi)'
      );
    }

    if (s55 && distMeters(s55.lat, s55.lng, 39.636811, 67.233552) < 200) {
      addIfNeeded(
        '55_to_56',
        '56-maktab',
        'Hozirgi 55-maktab koordinatasi',
        s55.lat,
        s55.lng,
        'Qirqshodi MFY (48-maktabdan 1.6 km, +1 siljish)'
      );
    }
    if (s56 && distMeters(s56.lat, s56.lng, 39.696772, 67.329097) < 200) {
      addIfNeeded(
        '56_to_57',
        '57-maktab',
        'Hozirgi 56-maktab koordinatasi',
        s56.lat,
        s56.lng,
        "Siz tasdiqlagansiz: 56 asli 57-maktab (Isori O'roqli MFY)"
      );
    }
    if (s57 && distMeters(s57.lat, s57.lng, 39.576705, 67.333045) < 200) {
      addIfNeeded(
        '57_to_58',
        '58-maktab',
        'Hozirgi 57-maktab koordinatasi',
        s57.lat,
        s57.lng,
        'Esonturdi MFY (40-maktabdan 1.8 km, +1 siljish)'
      );
    }
    if (s58 && distMeters(s58.lat, s58.lng, 39.588229, 67.309715) < 200) {
      addIfNeeded(
        '58_to_59',
        '59-maktab',
        'Hozirgi 58-maktab koordinatasi',
        s58.lat,
        s58.lng,
        'Saxovat MFY (44-maktabdan 1.7 km, +1 siljish)'
      );
    }
    if (s59 && distMeters(s59.lat, s59.lng, 39.624176, 67.292457) < 200) {
      addIfNeeded(
        '59_to_60',
        '60-maktab',
        'Hozirgi 59-maktab koordinatasi',
        s59.lat,
        s59.lng,
        'Saxovat MFY (61 ustidan ajratiladi, +1 siljish)'
      );
    }

    // +2 shift block (63 -> 65, old 64 -> 66, 65 -> 67, 66 -> 68, 67 -> 69, 68 -> 70, 69 -> 71, 70 -> 72)
    const s63 = findSchool(63);
    const s65 = findSchool(65);
    const s66 = findSchool(66);
    const s67 = findSchool(67);
    const s68 = findSchool(68);
    const s69 = findSchool(69);
    const s70 = findSchool(70);

    if (s63 && distMeters(s63.lat, s63.lng, 39.626708, 67.352043) < 200) {
      addIfNeeded(
        'old62_to_63',
        '63-maktab',
        RECOVERED_SEED_COORDS.oldRow62.label,
        RECOVERED_SEED_COORDS.oldRow62.lat,
        RECOVERED_SEED_COORDS.oldRow62.lng,
        'Eski 62-qator (65-maktab ustidan ajratiladi)'
      );
      addIfNeeded(
        '63_to_65',
        '65-maktab',
        'Hozirgi 63-maktab koordinatasi',
        s63.lat,
        s63.lng,
        'Siz tasdiqlagansiz: 63 asli 65-maktab (+2 siljish)'
      );
    }
    if (s66 && distMeters(s66.lat, s66.lng, 39.632537, 67.371427) < 200) {
      addIfNeeded(
        'old64_to_66',
        '66-maktab',
        RECOVERED_SEED_COORDS.oldRow64.label,
        RECOVERED_SEED_COORDS.oldRow64.lat,
        RECOVERED_SEED_COORDS.oldRow64.lng,
        'Yangiariq MFY ichida (20 va 3-maktab yonida)'
      );
    }
    if (s65 && distMeters(s65.lat, s65.lng, 39.591267, 67.375509) < 200) {
      addIfNeeded(
        '65_to_67',
        '67-maktab',
        'Hozirgi 65-maktab koordinatasi',
        s65.lat,
        s65.lng,
        'Siz tasdiqlagansiz: 65 asli 67-maktab (+2 siljish)'
      );
    }
    if (s66 && distMeters(s66.lat, s66.lng, 39.632537, 67.371427) < 200) {
      addIfNeeded(
        '66_to_68',
        '68-maktab',
        'Hozirgi 66-maktab koordinatasi',
        s66.lat,
        s66.lng,
        'Kildon hududi (2-maktabdan 1.9 km, +2 siljish)'
      );
    }
    if (s67 && distMeters(s67.lat, s67.lng, 39.588644, 67.340018) < 200) {
      addIfNeeded(
        '67_to_69',
        '69-maktab',
        'Hozirgi 67-maktab koordinatasi',
        s67.lat,
        s67.lng,
        'Siz tasdiqlagansiz: 67 asli 69-maktab (Alisher Navoiy MFY)'
      );
    }
    if (s68 && distMeters(s68.lat, s68.lng, 39.696985, 67.376608) < 200) {
      addIfNeeded(
        '68_to_70',
        '70-maktab',
        'Hozirgi 68-maktab koordinatasi',
        s68.lat,
        s68.lng,
        'Changal MFY (6-maktabdan 1 km, +2 siljish)'
      );
    }
    if (s69 && distMeters(s69.lat, s69.lng, 39.758698, 67.386209) < 200) {
      addIfNeeded(
        '69_to_71',
        '71-maktab',
        'Hozirgi 69-maktab koordinatasi',
        s69.lat,
        s69.lng,
        '+2 siljish (69 → 71)'
      );
    }
    if (s70 && distMeters(s70.lat, s70.lng, 39.603177, 67.372232) < 200) {
      addIfNeeded(
        '70_to_72',
        '72-maktab',
        'Hozirgi 70-maktab koordinatasi',
        s70.lat,
        s70.lng,
        "Mo'g'ol / Cho'yantepa hududi (+2 siljish)"
      );
    }

    return list;
  }, [schools]);

  // Filtered table items
  const displayedLocations = useMemo(() => {
    const q = normalizeKey(search);
    return locations
      .filter(loc => {
        if (filterMode === 'maktab' && loc.type !== 'maktab') return false;
        if (filterMode === 'dmtt' && loc.type !== 'dmtt' && loc.type !== 'bogcha') return false;
        if (filterMode === 'suspect' && !suspectIds.has(loc.id)) return false;
        if (!q) return true;
        return (
          normalizeKey(loc.name).includes(q) ||
          normalizeKey(loc.mahalla || '').includes(q)
        );
      })
      .sort((a, b) => {
        if (a.type !== b.type) {
          const order: Record<string, number> = { maktab: 0, dmtt: 1, bogcha: 1, tashkilot: 2 };
          return (order[a.type] ?? 3) - (order[b.type] ?? 3);
        }
        return extractSchoolNumber(a.name) - extractSchoolNumber(b.name);
      });
  }, [locations, search, filterMode, suspectIds]);

  const handleCleanDuplicates = async () => {
    if (duplicateGroups.length === 0) return;
    setBusyAction('dedup');
    try {
      let deletedCount = 0;
      for (const group of duplicateGroups) {
        // Keep the richest/first entry (prefer one that has mahalla/cadastre filled)
        const sorted = [...group].sort((a, b) => {
          const scoreA = (a.mahalla ? 2 : 0) + (a.cadastre ? 2 : 0) + (a.landmark ? 1 : 0);
          const scoreB = (b.mahalla ? 2 : 0) + (b.cadastre ? 2 : 0) + (b.landmark ? 1 : 0);
          return scoreB - scoreA;
        });
        const toDelete = sorted.slice(1);
        for (const dup of toDelete) {
          await deleteDoc(doc(db, 'locations', dup.id));
          deletedCount++;
        }
      }
      onSuccess(`${deletedCount} ta ortiqcha dublikat muvaffaqiyatli o'chirildi!`);
      await onRefresh();
    } catch (err: any) {
      onError(err?.message || "Dublikatlarni o'chirishda xatolik yuz berdi");
    } finally {
      setBusyAction(null);
    }
  };

  const handleApplyShiftProposals = async () => {
    const selected = shiftProposals.filter(p => !uncheckedShifts[p.key]);
    if (selected.length === 0) {
      onError("Kamida bitta o'zgarishni belgilang");
      return;
    }
    setBusyAction('shift');
    try {
      let updatedCount = 0;
      for (const p of selected) {
        const targetNum = extractSchoolNumber(p.targetName);
        const existingDocs = schools.filter(s => extractSchoolNumber(s.name) === targetNum);
        if (existingDocs.length > 0) {
          // Update the first matching doc
          await updateDoc(doc(db, 'locations', existingDocs[0].id), {
            lat: p.lat,
            lng: p.lng,
          });
          updatedCount++;
        } else {
          await addDoc(collection(db, 'locations'), {
            name: p.targetName,
            type: 'maktab',
            lat: p.lat,
            lng: p.lng,
          });
          updatedCount++;
        }
      }
      onSuccess(`${updatedCount} ta maktab koordinatasi yangilandi!`);
      await onRefresh();
    } catch (err: any) {
      onError(err?.message || 'Koordinatalarni yangilashda xatolik yuz berdi');
    } finally {
      setBusyAction(null);
    }
  };

  const handleSwapCoords = async () => {
    if (!swapAId || !swapBId || swapAId === swapBId) {
      onError('Ikkita har xil obyektni tanlang');
      return;
    }
    const locA = locations.find(l => l.id === swapAId);
    const locB = locations.find(l => l.id === swapBId);
    if (!locA || !locB) return;

    setBusyAction('swap');
    try {
      await updateDoc(doc(db, 'locations', locA.id), { lat: locB.lat, lng: locB.lng });
      await updateDoc(doc(db, 'locations', locB.id), { lat: locA.lat, lng: locA.lng });
      onSuccess(`${locA.name} va ${locB.name} koordinatalari muvaffaqiyatli almashtirildi!`);
      setSwapAId('');
      setSwapBId('');
      await onRefresh();
    } catch (err: any) {
      onError(err?.message || 'Almashtirishda xatolik yuz berdi');
    } finally {
      setBusyAction(null);
    }
  };

  const startEdit = (loc: LocationDoc) => {
    setEditingId(loc.id);
    setEditName(loc.name);
    setEditMahalla(loc.mahalla || '');
    setEditLat(String(loc.lat));
    setEditLng(String(loc.lng));
    setConfirmDeleteId(null);
  };

  const handleLatPasteOrChange = (val: string) => {
    // Support pasting "39.694999, 67.315246" straight from Yandex/Google Maps
    const pair = val.match(/(-?\d+\.\d+)\s*[,\s]\s*(-?\d+\.\d+)/);
    if (pair) {
      setEditLat(pair[1]);
      setEditLng(pair[2]);
    } else {
      setEditLat(val);
    }
  };

  const handleSaveEdit = async (locId: string) => {
    const latNum = Number(editLat.trim());
    const lngNum = Number(editLng.trim());
    if (!editName.trim() || !Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
      onError("Nom va koordinatalarni to'g'ri kiriting");
      return;
    }
    setBusyAction(`edit_${locId}`);
    try {
      await updateDoc(doc(db, 'locations', locId), {
        name: editName.trim(),
        mahalla: editMahalla.trim(),
        lat: latNum,
        lng: lngNum,
      });
      setEditingId(null);
      onSuccess(`${editName.trim()} muvaffaqiyatli saqlandi!`);
      await onRefresh();
    } catch (err: any) {
      onError(err?.message || 'Saqlashda xatolik yuz berdi');
    } finally {
      setBusyAction(null);
    }
  };

  const handleDeleteLoc = async (loc: LocationDoc) => {
    if (confirmDeleteId !== loc.id) {
      setConfirmDeleteId(loc.id);
      return;
    }
    setBusyAction(`del_${loc.id}`);
    try {
      await deleteDoc(doc(db, 'locations', loc.id));
      setConfirmDeleteId(null);
      onSuccess(`${loc.name} o'chirildi.`);
      await onRefresh();
    } catch (err: any) {
      onError(err?.message || "O'chirishda xatolik yuz berdi");
    } finally {
      setBusyAction(null);
    }
  };

  const handleFixEverything = async () => {
    const selected = shiftProposals.filter(p => !uncheckedShifts[p.key]);
    if (duplicateGroups.length === 0 && selected.length === 0) return;

    setBusyAction('fix_all');
    try {
      let deletedCount = 0;
      const keptByGroup = new Map<string, string>();
      for (const group of duplicateGroups) {
        const sorted = [...group].sort((a, b) => {
          const scoreA = (a.mahalla ? 2 : 0) + (a.cadastre ? 2 : 0) + (a.landmark ? 1 : 0);
          const scoreB = (b.mahalla ? 2 : 0) + (b.cadastre ? 2 : 0) + (b.landmark ? 1 : 0);
          return scoreB - scoreA;
        });
        keptByGroup.set(normalizeKey(sorted[0].name), sorted[0].id);
        for (const dup of sorted.slice(1)) {
          await deleteDoc(doc(db, 'locations', dup.id));
          deletedCount++;
        }
      }

      let updatedCount = 0;
      for (const p of selected) {
        const targetNum = extractSchoolNumber(p.targetName);
        const keptId = keptByGroup.get(normalizeKey(p.targetName));
        const existingDoc =
          (keptId ? schools.find(s => s.id === keptId) : undefined) ||
          schools.find(s => extractSchoolNumber(s.name) === targetNum);
        if (existingDoc) {
          await updateDoc(doc(db, 'locations', existingDoc.id), {
            lat: p.lat,
            lng: p.lng,
          });
          updatedCount++;
        } else {
          await addDoc(collection(db, 'locations'), {
            name: p.targetName,
            type: 'maktab',
            lat: p.lat,
            lng: p.lng,
          });
          updatedCount++;
        }
      }

      const summaryParts: string[] = [];
      if (deletedCount > 0) summaryParts.push(`${deletedCount} ta ortiqcha dublikat o'chirildi`);
      if (updatedCount > 0) summaryParts.push(`${updatedCount} ta maktab joylashuvi to'g'rilandi`);
      onSuccess(`Hammasi bajarildi: ${summaryParts.join(' va ')}!`);
      await onRefresh();
    } catch (err: any) {
      onError(err?.message || "Tuzatishda xatolik yuz berdi");
    } finally {
      setBusyAction(null);
    }
  };

  const affectedSchoolNumsLabel = useMemo(() => {
    const nums = shiftProposals
      .map(p => extractSchoolNumber(p.targetName))
      .filter(n => n < 9999)
      .sort((a, b) => a - b);
    return nums.join(', ');
  }, [shiftProposals]);

  return (
    <div className="space-y-6">
      {/* 0. Single 1-Click Fix Everything Banner */}
      {(totalExtraDuplicates > 0 || shiftProposals.length > 0) && (
        <div className="bg-emerald-600 text-white rounded-3xl p-5 sm:p-6 shadow-lg shadow-emerald-600/20">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h3 className="font-extrabold text-lg">
                Barchasini 1 bosishda to'g'rilash tayyor!
              </h3>
              <p className="text-xs text-emerald-100 mt-1">
                {totalExtraDuplicates > 0
                  ? `${totalExtraDuplicates} ta ortiqcha dublikat o'chiriladi`
                  : ''}
                {totalExtraDuplicates > 0 && shiftProposals.length > 0 ? ' · ' : ''}
                {shiftProposals.length > 0
                  ? `${shiftProposals.filter(p => !uncheckedShifts[p.key]).length} ta siljigan maktab (${affectedSchoolNumsLabel}) haqiqiy joyiga qo'yiladi`
                  : ''}
              </p>
            </div>
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={handleFixEverything}
              className="px-5 py-3 bg-white hover:bg-emerald-50 text-emerald-700 disabled:opacity-60 font-extrabold text-sm rounded-2xl shadow-md transition-all active:scale-95 cursor-pointer flex items-center gap-2 shrink-0"
            >
              <Sparkles className="w-4 h-4" />
              <span>
                {busyAction === 'fix_all' ? 'Tuzatilmoqda...' : "Hammasini 1 bosishda to'g'rilash"}
              </span>
            </button>
          </div>
        </div>
      )}

      {/* 1. Duplicate Cleaner Card */}
      {duplicateGroups.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-3xl p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-2xl bg-red-100 text-red-600 flex items-center justify-center shrink-0">
                <Copy className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-extrabold text-red-900 text-base">
                  Dublikat obyektlar aniqlandi ({totalExtraDuplicates} ta ortiqcha)
                </h3>
                <p className="text-xs text-red-700 mt-1">
                  {duplicateGroups
                    .map(g => `${g[0].name} (${g.length} marta kiritilgan)`)
                    .join(', ')}
                </p>
              </div>
            </div>
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={handleCleanDuplicates}
              className="px-4 py-2.5 bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white font-bold text-xs rounded-xl shadow-sm transition-colors cursor-pointer flex items-center gap-2"
            >
              <Trash2 className="w-4 h-4" />
              <span>
                {busyAction === 'dedup'
                  ? 'Tozalanmoqda...'
                  : `Ortiqcha ${totalExtraDuplicates} ta nusxani o'chirish`}
              </span>
            </button>
          </div>
        </div>
      )}

      {/* 2. Detected +1 / +2 Shift Fixer Card (56–60 & 65–72) */}
      {shiftProposals.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-3xl p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-2xl bg-amber-100 text-amber-700 flex items-center justify-center shrink-0">
                <Sparkles className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-extrabold text-amber-950 text-base">
                  Aniqlangan raqam siljishlari ({affectedSchoolNumsLabel}-maktablar)
                </h3>
                <p className="text-xs text-amber-800 mt-1">
                  47 va 64-maktablar yo'qligi sababli koordinatalar +1 va +2 ga siljib qolgan. Quyidagi barcha qatorlar MFY va sizning tekshiruvingiz bo'yicha aniqlandi:
                </p>
              </div>
            </div>
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={handleApplyShiftProposals}
              className="px-4 py-2.5 bg-amber-600 hover:bg-amber-700 disabled:opacity-60 text-white font-bold text-xs rounded-xl shadow-sm transition-colors cursor-pointer flex items-center gap-2"
            >
              <Check className="w-4 h-4" />
              <span>
                {busyAction === 'shift' ? 'Saqlanmoqda...' : 'Tanlanganlarni bazada tuzatish'}
              </span>
            </button>
          </div>

          <div className="space-y-2">
            {shiftProposals.map(p => {
              const checked = !uncheckedShifts[p.key];
              return (
                <label
                  key={p.key}
                  className="flex flex-wrap items-center justify-between gap-3 bg-white/90 border border-amber-200/80 rounded-2xl px-4 py-3 cursor-pointer hover:bg-white transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setUncheckedShifts(prev => ({ ...prev, [p.key]: checked }))
                      }
                      className="w-4 h-4 accent-amber-600 rounded shrink-0"
                    />
                    <div className="min-w-0">
                      <div className="text-xs font-extrabold text-slate-900">
                        <span className="text-amber-700">{p.sourceLabel}</span> →{' '}
                        <span className="text-emerald-700">{p.targetName}</span>
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        {p.note} ·{' '}
                        <span className="font-mono">
                          {p.lat.toFixed(6)}, {p.lng.toFixed(6)}
                        </span>
                      </div>
                    </div>
                  </div>
                  <a
                    href={yandexPointUrl(p.lat, p.lng)}
                    target="_blank"
                    rel="noreferrer"
                    onClick={e => e.stopPropagation()}
                    className="inline-flex items-center gap-1 text-[11px] font-bold text-sky-700 bg-sky-50 hover:bg-sky-100 px-2.5 py-1.5 rounded-lg shrink-0"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    <span>Sun'iy yo'ldosh</span>
                  </a>
                </label>
              );
            })}
          </div>
        </div>
      )}

      {/* 3. Overlapping pins warning + Quick Swap Tool */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-3xl shadow-sm border border-slate-100 p-5">
          <div className="flex items-center gap-2 mb-3">
            <ArrowLeftRight className="w-4 h-4 text-indigo-600" />
            <h3 className="font-extrabold text-slate-900 text-sm">
              2 ta obyekt joylashuvini almashtirish (Swap)
            </h3>
          </div>
          <p className="text-xs text-slate-500 mb-4">
            Masalan, 56-maktab va 57-maktabning koordinatalari almashib qolgan bo'lsa, ikkalasini tanlab 1 bosishda joyini almashtiring (nomlari va MFY o'zgarmaydi).
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
            <select
              value={swapAId}
              onChange={e => setSwapAId(e.target.value)}
              className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-800 outline-none"
            >
              <option value="">1-obyektni tanlang...</option>
              {schools.map(s => (
                <option key={s.id} value={s.id}>
                  {s.name} {s.mahalla ? `(${s.mahalla})` : ''}
                </option>
              ))}
            </select>
            <select
              value={swapBId}
              onChange={e => setSwapBId(e.target.value)}
              className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-800 outline-none"
            >
              <option value="">2-obyektni tanlang...</option>
              {schools.map(s => (
                <option key={s.id} value={s.id}>
                  {s.name} {s.mahalla ? `(${s.mahalla})` : ''}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            disabled={busyAction !== null || !swapAId || !swapBId || swapAId === swapBId}
            onClick={handleSwapCoords}
            className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-bold text-xs rounded-xl transition-colors cursor-pointer flex items-center justify-center gap-2"
          >
            <ArrowLeftRight className="w-4 h-4" />
            <span>{busyAction === 'swap' ? 'Almashtirilmoqda...' : 'Koordinatalarni almashtirish'}</span>
          </button>
        </div>

        <div className="bg-white rounded-3xl shadow-sm border border-slate-100 p-5">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle className="w-4 h-4 text-amber-600" />
            <h3 className="font-extrabold text-slate-900 text-sm">
              Ustma-ust tushib qolgan maktablar ({overlapPairs.length})
            </h3>
          </div>
          {overlapPairs.length === 0 ? (
            <p className="text-xs text-emerald-700 font-semibold py-4">
              Ustma-ust tushib qolgan maktablar yo'q.
            </p>
          ) : (
            <div className="space-y-2 max-h-40 overflow-y-auto">
              {overlapPairs.map((pair, idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between gap-2 bg-amber-50/70 border border-amber-100 rounded-xl px-3 py-2 text-xs"
                >
                  <div>
                    <span className="font-extrabold text-slate-900">{pair.a.name}</span> ↔{' '}
                    <span className="font-extrabold text-slate-900">{pair.b.name}</span>
                    <span className="ml-2 text-amber-700 font-bold">({pair.meters} m)</span>
                  </div>
                  <a
                    href={yandexPointUrl(pair.a.lat, pair.a.lng)}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sky-700 font-bold hover:underline inline-flex items-center gap-1 shrink-0"
                  >
                    <MapPin className="w-3.5 h-3.5" />
                    Ko'rish
                  </a>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 4. Full Searchable / Editable Table */}
      <div className="bg-white rounded-3xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="p-4 sm:p-5 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Maktab raqami yoki MFY qidirish..."
              className="w-full pl-10 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-semibold outline-none focus:bg-white focus:border-indigo-400"
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(
              [
                ['maktab', `Maktablar (${schools.length})`],
                ['suspect', `Shubhalilar (${suspectIds.size})`],
                ['dmtt', "Bog'chalar"],
                ['all', `Barchasi (${locations.length})`],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilterMode(key)}
                className={`px-3 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer ${
                  filterMode === key
                    ? 'bg-indigo-600 text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-slate-600">
            <thead className="bg-slate-50 text-[10px] uppercase font-bold tracking-widest text-slate-500 border-b border-slate-100">
              <tr>
                <th className="px-4 py-3">Nomi</th>
                <th className="px-4 py-3">MFY</th>
                <th className="px-4 py-3">Koordinata (Lat, Lng)</th>
                <th className="px-4 py-3">Holat</th>
                <th className="px-4 py-3 text-right">Amallar</th>
              </tr>
            </thead>
            <tbody>
              {displayedLocations.map(loc => {
                const warning = suspectIds.get(loc.id);
                const isEditing = editingId === loc.id;

                return (
                  <tr
                    key={loc.id}
                    className={`border-b border-slate-50 ${
                      warning ? 'bg-amber-50/40' : 'hover:bg-slate-50/60'
                    }`}
                  >
                    <td className="px-4 py-3 font-extrabold text-slate-900 whitespace-nowrap">
                      {isEditing ? (
                        <input
                          type="text"
                          value={editName}
                          onChange={e => setEditName(e.target.value)}
                          className="w-32 px-2 py-1.5 border border-indigo-300 rounded-lg text-xs font-bold bg-white"
                        />
                      ) : (
                        loc.name
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {isEditing ? (
                        <input
                          type="text"
                          value={editMahalla}
                          onChange={e => setEditMahalla(e.target.value)}
                          placeholder="MFY nomi"
                          className="w-36 px-2 py-1.5 border border-indigo-300 rounded-lg text-xs bg-white"
                        />
                      ) : (
                        <span>{loc.mahalla || '—'}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono whitespace-nowrap">
                      {isEditing ? (
                        <div className="flex items-center gap-1.5">
                          <input
                            type="text"
                            value={editLat}
                            onChange={e => handleLatPasteOrChange(e.target.value)}
                            placeholder="Lat (yoki lat, lng)"
                            className="w-28 px-2 py-1.5 border border-indigo-300 rounded-lg text-[11px] bg-white"
                          />
                          <input
                            type="text"
                            value={editLng}
                            onChange={e => setEditLng(e.target.value)}
                            placeholder="Lng"
                            className="w-28 px-2 py-1.5 border border-indigo-300 rounded-lg text-[11px] bg-white"
                          />
                        </div>
                      ) : (
                        <span>
                          {Number(loc.lat).toFixed(6)}, {Number(loc.lng).toFixed(6)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {warning ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-amber-100 text-amber-800 font-bold text-[10px]">
                          <AlertTriangle className="w-3 h-3 shrink-0" />
                          <span>{warning}</span>
                        </span>
                      ) : (
                        <span className="text-[11px] text-emerald-600 font-bold">OK</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      {isEditing ? (
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            disabled={busyAction !== null}
                            onClick={() => handleSaveEdit(loc.id)}
                            className="px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg cursor-pointer inline-flex items-center gap-1"
                          >
                            <Check className="w-3.5 h-3.5" />
                            Saqlash
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingId(null)}
                            className="px-2 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-600 font-bold rounded-lg cursor-pointer"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <div className="inline-flex items-center gap-1.5">
                          <a
                            href={yandexPointUrl(Number(loc.lat), Number(loc.lng))}
                            target="_blank"
                            rel="noreferrer"
                            className="px-2 py-1.5 bg-sky-50 hover:bg-sky-100 text-sky-700 font-bold rounded-lg inline-flex items-center gap-1"
                            title="Sun'iy yo'ldosh xaritada ko'rish"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                          <button
                            type="button"
                            onClick={() => startEdit(loc)}
                            className="px-2 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-bold rounded-lg cursor-pointer inline-flex items-center gap-1"
                            title="Koordinata yoki nomni tahrirlash"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>
                          {confirmDeleteId === loc.id ? (
                            <button
                              type="button"
                              disabled={busyAction !== null}
                              onClick={() => handleDeleteLoc(loc)}
                              className="px-2.5 py-1.5 bg-red-600 hover:bg-red-700 text-white font-bold rounded-lg cursor-pointer"
                            >
                              Ha, o'chir
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => handleDeleteLoc(loc)}
                              className="px-2 py-1.5 bg-red-50 hover:bg-red-100 text-red-600 font-bold rounded-lg cursor-pointer"
                              title="O'chirish"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
