import * as XLSX from 'xlsx';
import { Location } from '../types';
import { resolveCadastreDetails } from './cadastreHelpers';

// Helper to generate full NGIS Geoportal Cadastre and Area data if missing
export const getCadastreDetails = (loc: Location) => {
  return resolveCadastreDetails({
    name: loc.name,
    type: loc.type,
    lat: loc.lat,
    lng: loc.lng,
    cadastre: loc.cadastre,
    totalLandArea: loc.totalLandArea,
    buildingFootprintArea: loc.buildingFootprintArea,
    docLandArea: loc.docLandArea,
    area: loc.area,
    capacity: loc.capacity,
    cadastreAddress: loc.cadastreAddress,
    cadastreType: loc.cadastreType,
    cadastreRegion: loc.cadastreRegion,
    cadastreDistrict: loc.cadastreDistrict,
  });
};

export interface ExcelExportResult {
  exported: boolean;
  count: number;
  message?: string;
}

export const exportSchoolsAndKindergartensToExcel = (locations: Location[]): ExcelExportResult => {
  // Filter ONLY schools and kindergartens (DMTT) - strictly excluding fuel stations, stores, etc.
  const schoolAndKindergartens = locations.filter(loc => {
    const t = (loc.type || '').toLowerCase();
    const n = (loc.name || '').toLowerCase();
    return t === 'maktab' || t === 'dmtt' || t === 'bogcha' ||
           n.includes('maktab') || n.includes('dmtt') || n.includes("bog'cha") || n.includes('bogcha') || n.includes('dmt');
  });

  if (schoolAndKindergartens.length === 0) {
    return {
      exported: false,
      count: 0,
      message: "Maktab va bog'chalar bo'yicha ma'lumot topilmadi!",
    };
  }

  const formatRow = (loc: Location, idx: number) => {
    const isSchool = loc.type === 'maktab' || loc.name.toLowerCase().includes('maktab');
    const c = getCadastreDetails(loc);

    return {
      "№": idx + 1,
      "Tashkilot Nomi": loc.name,
      "Tashkilot Turi": isSchool ? "Davlat umumta'lim maktabi" : "Davlat maktabgacha ta'lim tashkiloti (DMTT)",
      "Kadastr Raqami (NGIS)": c.cadastreCode,
      "Jami Yer Maydoni (m²)": c.totalLandArea,
      "Yer Maydoni (Gektar)": c.hectares,
      "Bino Osti Maydoni (m²)": c.buildingFootprintArea,
      "Hujjat Bo'yicha Maydon (m²)": c.docLandArea,
      "Obyekt Turi (NGIS)": loc.cadastreType || c.cadastreType,
      "Viloyat": loc.cadastreRegion || c.cadastreRegion,
      "Tuman / Shahar": loc.cadastreDistrict || c.cadastreDistrict,
      "Mahalla / Manzil": loc.cadastreAddress || loc.mahalla || c.cadastreAddress,
      "Mo'ljal": loc.landmark || "—",
      "Sig'imi (o'quvchi/tarbiyalanuvchi)": c.capacity,
      "Kenglik (Latitude)": loc.lat,
      "Uzunlik (Longitude)": loc.lng,
      "open.ngis.uz Linki": `https://open.ngis.uz/#/openmap?lat=${loc.lat}&lng=${loc.lng}`
    };
  };

  const allData = schoolAndKindergartens.map((loc, idx) => formatRow(loc, idx));
  const schoolsOnly = schoolAndKindergartens.filter(loc => loc.type === 'maktab' || loc.name.toLowerCase().includes('maktab')).map((loc, idx) => formatRow(loc, idx));
  const kindergartensOnly = schoolAndKindergartens.filter(loc => loc.type !== 'maktab' && !loc.name.toLowerCase().includes('maktab')).map((loc, idx) => formatRow(loc, idx));

  const wb = XLSX.utils.book_new();

  const wsAll = XLSX.utils.json_to_sheet(allData);
  const wsSchools = XLSX.utils.json_to_sheet(schoolsOnly);
  const wsKindergartens = XLSX.utils.json_to_sheet(kindergartensOnly);

  const columnWidths = [
    { wch: 5 },  // №
    { wch: 34 }, // Nomi
    { wch: 38 }, // Turi
    { wch: 25 }, // Kadastr
    { wch: 22 }, // Yer m2
    { wch: 20 }, // Yer ga
    { wch: 22 }, // Bino m2
    { wch: 26 }, // Hujjat m2
    { wch: 28 }, // Obyekt turi
    { wch: 20 }, // Viloyat
    { wch: 20 }, // Tuman
    { wch: 36 }, // Manzil
    { wch: 25 }, // Mo'ljal
    { wch: 22 }, // Sig'imi
    { wch: 18 }, // Lat
    { wch: 18 }, // Lng
    { wch: 48 }, // NGIS URL
  ];

  wsAll['!cols'] = columnWidths;
  wsSchools['!cols'] = columnWidths;
  wsKindergartens['!cols'] = columnWidths;

  XLSX.utils.book_append_sheet(wb, wsAll, "Barcha Maktab va DMTTlar");
  XLSX.utils.book_append_sheet(wb, wsSchools, "Faqat Maktablar");
  XLSX.utils.book_append_sheet(wb, wsKindergartens, "Faqat DMTT Bog'chalar");

  const fileName = `Bulungur_Maktab_va_Bogchalar_Kadastr_Smetasi_${new Date().toISOString().split('T')[0]}.xlsx`;
  XLSX.writeFile(wb, fileName);

  return {
    exported: true,
    count: schoolAndKindergartens.length,
  };
};
