export interface Location {
  id: string;
  name: string;
  type: string;
  lat: number;
  lng: number;
  capacity?: number;
  area?: number;
  landmark?: string;
  mahalla?: string;
  cadastre?: string;

  // NGIS / Kadastr Agentligi Geoportal Details
  cadastreRegion?: string;       // Viloyat/Shahar (masalan: Samarqand viloyati)
  cadastreDistrict?: string;     // Tuman (masalan: Bulung'ur tumani)
  cadastreAddress?: string;      // Manzil (masalan: Guliston MFY, O'zbekiston ko'chasi, 11-uy)
  cadastreType?: string;         // Turi (masalan: Noturar bino yoki inshoot)
  cadastreDescription?: string;  // Obyekt tavsifi (masalan: Noturar / Bog'cha)
  totalLandArea?: number;        // Maydoni / Yer maydoni (kv.m.)
  buildingFootprintArea?: number;// Bino osti maydoni (kv.m.)
  docLandArea?: number;          // Yer maydoni hujjat bo'yicha (kv.m.)
  objectArea?: number;           // Obyekt maydoni (kv.m.)
  ngisSyncedAt?: string;         // ISO vaqt tamg'asi
}

export interface CadastreLookupResult {
  success: boolean;
  cadastre: string;
  cadastreRegion?: string;
  cadastreDistrict?: string;
  cadastreAddress?: string;
  cadastreType?: string;
  cadastreDescription?: string;
  totalLandArea?: number;
  buildingFootprintArea?: number;
  docLandArea?: number;
  objectArea?: number;
  ngisUrl?: string;
  source?: string;
}
