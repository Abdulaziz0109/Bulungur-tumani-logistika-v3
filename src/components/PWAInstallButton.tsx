import React, { useState } from 'react';
import { Smartphone, X, Share, PlusSquare } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';
import { useOnlineStatus } from '../hooks/useOnlineStatus';

export const PWAInstallButton: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showGuide, setShowGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  const handleClick = async () => {
    if (isInstallable) {
      await install();
    } else {
      setShowGuide(true);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        aria-label="Telefon ekraniga ilova sifatida o'rnatish"
        className={`flex items-center justify-center gap-1.5 rounded-xl bg-sky-50 hover:bg-sky-100 border border-sky-200 text-sky-700 font-bold transition-colors cursor-pointer shrink-0 whitespace-nowrap ${
          compact ? 'min-h-[36px] min-w-[36px] px-2 2xl:px-2.5 text-[11px]' : 'min-h-[40px] px-3 text-xs'
        }`}
        title="Telefon ekraniga ilova (yorliq) sifatida chiqarish"
      >
        <Smartphone className="w-4 h-4 shrink-0" />
        <span className={compact ? 'hidden 2xl:inline' : ''}>Ekranga qo'shish</span>
      </button>

      {showGuide && (
        <div
          className="fixed inset-0 z-[1100] bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowGuide(false);
          }}
        >
          <div className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-2xl border border-slate-100">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-base font-extrabold text-slate-900">
                Telefon ekraniga chiqarish
              </h3>
              <button
                type="button"
                onClick={() => setShowGuide(false)}
                aria-label="Qo'llanmani yopish"
                className="w-9 h-9 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-500 flex items-center justify-center cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {isIOS ? (
              <div className="space-y-3 text-sm text-slate-600 leading-relaxed">
                <p>iPhone / iPad Safari brauzerida bosh ekranga yorliq qo'shish uchun:</p>
                <div className="p-3 rounded-2xl bg-slate-50 border border-slate-200 space-y-2 text-xs font-semibold text-slate-800">
                  <div className="flex items-center gap-2">
                    <Share className="w-4 h-4 text-sky-600 shrink-0" />
                    <span>1. Pastdagi <strong>Ulashish (Share)</strong> tugmasini bosing.</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <PlusSquare className="w-4 h-4 text-sky-600 shrink-0" />
                    <span>2. Pastga tushib <strong>"На экран Домой" (Add to Home Screen)</strong> ni tanlang.</span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-3 text-sm text-slate-600 leading-relaxed">
                <p>Android telefonda bir bosishda ochiladigan ilova qilish uchun:</p>
                <div className="p-3 rounded-2xl bg-slate-50 border border-slate-200 space-y-2 text-xs font-semibold text-slate-800">
                  <p>1. Brauzerning o'ng yuqori burchagidagi <strong>⋮ (Menyu)</strong> belgisini bosing.</p>
                  <p>2. <strong>"Ilovani o'rnatish"</strong> yoki <strong>"Bosh ekranga qo'shish"</strong> bandini tanlang.</p>
                  <p className="text-slate-500 font-normal pt-1">O'rnatilgandan so'ng ikonkani bosib turib <strong>"Tezkor Widget"</strong>ni to'g'ridan-to'g'ri bosh ekranga chiqarishingiz yoki ilovadagi <strong>Widget</strong> tugmasida eni/bo'yini o'zingizga moslab ishlatishingiz mumkin.</p>
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={() => setShowGuide(false)}
              className="mt-5 w-full min-h-[44px] rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold cursor-pointer transition-colors"
            >
              Tushunarli
            </button>
          </div>
        </div>
      )}
    </>
  );
};

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div className="fixed bottom-24 md:bottom-6 left-1/2 -translate-x-1/2 z-[900] flex items-center gap-2 rounded-xl bg-amber-600 px-3.5 py-2 text-xs font-bold text-white shadow-lg whitespace-nowrap">
      <span>Oflayn rejim — keshlangan manzillar ishlamoqda</span>
    </div>
  );
};
