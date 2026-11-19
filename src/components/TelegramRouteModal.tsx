import React, { useState, useEffect } from 'react';
import {
  Send,
  Copy,
  Check,
  X,
  MessageSquare,
  Bot,
  Share2,
  AlertCircle
} from 'lucide-react';
import { Location } from '../types';
import { buildYandexMapsUrl, buildGoogleMapsUrl } from '../utils/navigationHelpers';

interface TelegramRouteModalProps {
  isOpen: boolean;
  onClose: () => void;
  locations: Location[];
  routeStats: any;
  userLocation?: [number, number] | null;
  startFromMyLocation?: boolean;
  isRoundtrip?: boolean;
  showToast: (message: string, type: 'success' | 'error' | 'info') => void;
}

export const TelegramRouteModal: React.FC<TelegramRouteModalProps> = ({
  isOpen,
  onClose,
  locations,
  routeStats,
  userLocation = null,
  startFromMyLocation = true,
  isRoundtrip = false,
  showToast
}) => {
  const [copied, setCopied] = useState(false);
  const [chatId, setChatId] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [botInfo, setBotInfo] = useState<{ configured: boolean; username: string | null; firstName?: string } | null>(null);

  useEffect(() => {
    if (isOpen) {
      fetch('/api/telegram/info')
        .then(res => res.json())
        .then(data => setBotInfo(data))
        .catch(() => setBotInfo({ configured: false, username: null }));
    }
  }, [isOpen]);

  if (!isOpen || locations.length === 0) return null;

  const yandexUrl = buildYandexMapsUrl(locations, userLocation, startFromMyLocation, isRoundtrip);
  const googleUrl = buildGoogleMapsUrl(locations, userLocation, startFromMyLocation, isRoundtrip);

  const todayStr = new Date().toLocaleDateString('uz-UZ', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const distanceKm = routeStats?.distance ? (routeStats.distance / 1000).toFixed(1) : null;
  const durationMin = routeStats?.duration ? Math.round(routeStats.duration / 60) : null;

  const buildFormattedText = () => {
    let msg = `🚚 *BULUNG'UR MMTB — MARSHRUT TOPSHIRIG'I*\n`;
    msg += `📅 *Sana:* ${todayStr}\n`;
    if (distanceKm && durationMin) {
      msg += `🛣 *Masofa:* ~${distanceKm} km | ⏱ *Vaqt:* ~${durationMin} daqiqa\n`;
    }
    msg += `🔢 *To'xtashlar soni:* ${locations.length} ta\n\n`;
    msg += `📋 *BORISH TARTIBI (KETMA-KETLIK):*\n`;

    locations.forEach((loc, idx) => {
      const typeLabel = loc.type === 'dmtt' || loc.type === 'bogcha' ? "Bog'cha (DMTT)" : loc.type === 'maktab' ? "Maktab" : "Muassasa";
      msg += `\n*${idx + 1}. ${loc.name}* (${typeLabel})\n`;
      if (loc.mahalla) msg += `   🏛 *MFY:* ${loc.mahalla}\n`;
      if (loc.landmark) msg += `   📍 *Mo'ljal:* ${loc.landmark}\n`;
      if (loc.cadastre) msg += `   🔢 *Kadastr:* \`${loc.cadastre}\`\n`;
      msg += `   🚗 [Yandex Navigatsiyada ochish](https://yandex.uz/maps/?rtext=~${loc.lat},${loc.lng}&rtt=auto)\n`;
    });

    msg += `\n━━━━━━━━━━━━━━━━━━\n`;
    msg += `🗺 *Butun marshrut bo'yicha navigatsiya:*\n`;
    msg += `• [Yandex Maps orqali yurish](${yandexUrl})\n`;
    msg += `• [Google Maps orqali yurish](${googleUrl})\n`;
    msg += `\n🧭 *Bulung'ur MMTB Logistika Tizimi*`;
    return msg;
  };

  const formattedText = buildFormattedText();
  const telegramShareUrl = `https://t.me/share/url?url=${encodeURIComponent(window.location.origin)}&text=${encodeURIComponent(formattedText)}`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(formattedText);
      setCopied(true);
      showToast("Marshrut ma'lumotlari nusxalandi!", "success");
      setTimeout(() => setCopied(false), 2500);
    } catch {
      showToast("Nusxalashda xatolik yuz berdi. Matnni qo'lda belgilab oling.", "error");
    }
  };

  const handleSendViaBot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatId.trim()) {
      showToast("Iltimos, haydovchi Telegram Chat ID sini kiriting", "error");
      return;
    }

    setIsSending(true);
    try {
      const res = await fetch('/api/telegram/send-route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: chatId.trim(),
          message: formattedText,
          yandexUrl,
          googleUrl,
          webAppUrl: window.location.origin
        })
      });

      const data = await res.json();
      if (data.success) {
        showToast("Marshrut Telegram orqali muvaffaqiyatli yuborildi!", "success");
        setChatId('');
      } else {
        showToast(data.error || "Yuborishda xatolik yuz berdi", "error");
      }
    } catch {
      showToast("Server bilan bog'lanishda xatolik yuz berdi", "error");
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[1050] bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 overflow-y-auto animate-in fade-in duration-200">
      <div className="bg-white rounded-3xl w-full max-w-2xl max-h-[92vh] flex flex-col shadow-2xl border border-slate-100 overflow-hidden">

        {/* Modal Header */}
        <div className="p-5 border-b border-slate-100 flex items-center justify-between shrink-0 bg-gradient-to-r from-sky-50 to-blue-50">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-2xl bg-sky-500 text-white flex items-center justify-center shadow-lg shadow-sky-500/30">
              <Send className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-extrabold text-base sm:text-lg text-slate-900 tracking-tight flex items-center gap-2">
                Telegramga Yuborish
                <span className="text-[10px] bg-sky-100 text-sky-700 font-bold px-2 py-0.5 rounded-full border border-sky-200">
                  Marshrut Ulashish
                </span>
              </h3>
              <p className="text-xs text-slate-500 font-medium">
                Haydovchiga to'g'ridan-to'g'ri topshiriq va navigatsiya havolalarini uzatish
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Modalni yopish"
            className="w-10 h-10 rounded-xl bg-white hover:bg-slate-100 text-slate-400 hover:text-slate-700 flex items-center justify-center transition-colors cursor-pointer border border-slate-200"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-5 sm:p-6 overflow-y-auto space-y-5 flex-1">

          {/* Action Choice Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* Direct Telegram Share Link */}
            <a
              href={telegramShareUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="p-4 rounded-2xl bg-sky-500 hover:bg-sky-600 text-white flex flex-col items-start text-left shadow-lg shadow-sky-500/25 transition-all active:scale-98 cursor-pointer group no-underline"
            >
              <div className="w-9 h-9 rounded-xl bg-white/20 flex items-center justify-center mb-2 group-hover:scale-110 transition-transform">
                <Share2 className="w-5 h-5 text-white" />
              </div>
              <span className="font-extrabold text-sm">1-chertishda Telegramda ulashish</span>
              <span className="text-[11px] text-sky-100 mt-0.5">
                Telegram ilovasini ochadi va haydovchi yoki guruhni tanlash imkonini beradi
              </span>
            </a>

            {/* Copy Formatted Text Button */}
            <button
              type="button"
              onClick={handleCopy}
              className="p-4 rounded-2xl bg-slate-900 hover:bg-slate-800 text-white flex flex-col items-start text-left shadow-lg transition-all active:scale-98 cursor-pointer group"
            >
              <div className="w-9 h-9 rounded-xl bg-white/10 flex items-center justify-center mb-2 group-hover:scale-110 transition-transform">
                {copied ? <Check className="w-5 h-5 text-emerald-400" /> : <Copy className="w-5 h-5 text-slate-300" />}
              </div>
              <span className="font-extrabold text-sm">
                {copied ? "Nusxalandi! ✅" : "Xabar matnini nusxalash"}
              </span>
              <span className="text-[11px] text-slate-300 mt-0.5">
                Formatlangan barcha to'xtashlar va Yandex havolalarini xotiraga oladi
              </span>
            </button>
          </div>

          {/* Bot Direct Dispatch Form */}
          <div className="p-4 sm:p-5 rounded-2xl bg-slate-50 border border-slate-200">
            <div className="flex items-center space-x-2 mb-2">
              <Bot className="w-4 h-4 text-sky-600" />
              <h4 className="font-extrabold text-xs sm:text-sm text-slate-800">
                Bot orqali to'g'ridan-to'g'ri jo'natish
              </h4>
              {botInfo?.username && (
                <span className="text-[10px] bg-sky-100 text-sky-800 font-bold px-2 py-0.5 rounded-full">
                  @{botInfo.username}
                </span>
              )}
            </div>

            {botInfo && !botInfo.configured && (
              <div className="mb-3 p-3 rounded-xl bg-amber-50 border border-amber-200 flex items-start gap-2 text-xs text-amber-900">
                <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                <div>
                  <p className="font-bold">Telegram Bot tokeni serverda ulanmagan</p>
                  <p className="text-[11px] text-amber-800 mt-0.5">
                    Server muhitiga <code>TELEGRAM_BOT_TOKEN</code> kiritilgandan so'ng bot avtomatik ishga tushadi. Hozircha yuqoridagi <b>"1-chertishda Telegramda ulashish"</b> tugmasidan foydalanishingiz mumkin.
                  </p>
                </div>
              </div>
            )}

            <p className="text-xs text-slate-500 mb-3 leading-relaxed">
              Haydovchining Telegram Chat ID raqamini kiriting. Bot haydovchiga tugmali xabar qilib topshiradi.
            </p>

            <form onSubmit={handleSendViaBot} className="flex flex-col sm:flex-row gap-2">
              <input
                type="text"
                placeholder="Masalan: 123456789 (Chat ID)"
                value={chatId}
                onChange={(e) => setChatId(e.target.value)}
                className="flex-1 min-h-[44px] px-3.5 py-2.5 rounded-xl bg-white border border-slate-300 text-slate-800 text-xs font-semibold outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20"
              />
              <button
                type="submit"
                disabled={isSending || (botInfo ? !botInfo.configured : false)}
                className="min-h-[44px] px-4 py-2.5 bg-sky-600 hover:bg-sky-700 disabled:opacity-50 text-white rounded-xl font-bold text-xs flex items-center justify-center space-x-1.5 transition-all cursor-pointer shrink-0"
              >
                {isSending ? (
                  <span>Yuborilmoqda...</span>
                ) : (
                  <>
                    <Send className="w-3.5 h-3.5" />
                    <span>Yuborish</span>
                  </>
                )}
              </button>
            </form>
          </div>

          {/* Message Preview Box */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs font-bold text-slate-500">
              <span className="flex items-center gap-1">
                <MessageSquare className="w-3.5 h-3.5" />
                Yuboriladigan xabar ko'rinishi
              </span>
              <button
                type="button"
                onClick={handleCopy}
                className="text-sky-600 hover:text-sky-700 hover:underline cursor-pointer"
              >
                {copied ? "Nusxalandi" : "Nusxa olish"}
              </button>
            </div>

            <div className="bg-slate-900 text-slate-200 p-4 rounded-2xl text-xs font-mono whitespace-pre-wrap max-h-56 overflow-y-auto border border-slate-800 shadow-inner select-all leading-relaxed">
              {formattedText}
            </div>
          </div>

        </div>

        {/* Modal Footer */}
        <div className="p-4 border-t border-slate-100 bg-slate-50 flex items-center justify-between text-xs text-slate-500">
          <div className="flex items-center space-x-2">
            <span className={`w-2 h-2 rounded-full ${botInfo?.configured ? 'bg-emerald-500' : 'bg-amber-500'}`}></span>
            <span>{botInfo?.configured ? "Telegram Bot faol" : "Telegram ulashish tayyor"}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[40px] px-4 py-2 rounded-xl bg-white hover:bg-slate-100 text-slate-700 font-bold border border-slate-200 transition-colors cursor-pointer"
          >
            Yopish
          </button>
        </div>

      </div>
    </div>
  );
};
