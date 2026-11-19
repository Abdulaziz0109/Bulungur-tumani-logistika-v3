import React, { useState, useEffect } from 'react';
import { collection, getDocs, setDoc, doc, deleteDoc, updateDoc } from 'firebase/firestore';
import { db, auth } from '../lib/firebase';
import { initializeApp, deleteApp, FirebaseApp } from 'firebase/app';
import { getAuth, createUserWithEmailAndPassword } from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';
import { useNavigate } from 'react-router-dom';
import {
  Users,
  LogOut,
  Plus,
  Shield,
  User,
  X,
  Map as MapIcon,
  ArrowLeft,
  MessageSquare,
  Check,
  XCircle,
  Camera,
  Clock,
  FileSpreadsheet,
  Download,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { exportSchoolsAndKindergartensToExcel } from '../utils/excelExporter';

type AdminTab = 'users' | 'requests' | 'reports';

export default function AdminDashboard() {
  const [users, setUsers] = useState<any[]>([]);
  const [requests, setRequests] = useState<any[]>([]);
  const [reports, setReports] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<AdminTab>('users');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  // New User Form State
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<'admin' | 'user'>('user');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Inline confirmation state (avoids window.confirm inside iframes)
  const [confirmRejectId, setConfirmRejectId] = useState<string | null>(null);
  const [confirmDeleteUserId, setConfirmDeleteUserId] = useState<string | null>(null);
  const [brokenReportImages, setBrokenReportImages] = useState<Record<string, boolean>>({});

  const navigate = useNavigate();
  const { currentUser } = useAuth();

  const [locations, setLocations] = useState<any[]>([]);
  const [isExporting, setIsExporting] = useState(false);

  useEffect(() => {
    fetchUsers();
    fetchRequests();
    fetchReports();
    fetchLocations();
  }, []);

  const fetchLocations = async () => {
    try {
      const snap = await getDocs(collection(db, 'locations'));
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setLocations(list);
    } catch (e) {
      console.error('Locations loading error:', e);
    }
  };

  const handleDownloadExcel = () => {
    setError('');
    setSuccess('');
    setIsExporting(true);
    try {
      const result = exportSchoolsAndKindergartensToExcel(locations);
      if (result.exported) {
        setSuccess(`Excel smeta yuklab olindi (${result.count} ta muassasa).`);
      } else {
        setError(result.message || "Maktab va bog'chalar bo'yicha ma'lumot topilmadi!");
      }
    } catch (e) {
      console.error(e);
      setError('Excel fayl yaratishda xatolik yuz berdi.');
    } finally {
      setIsExporting(false);
    }
  };

  const fetchReports = async () => {
    try {
      const snap = await getDocs(collection(db, 'reports'));
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      list.sort((a: any, b: any) => {
        const dateA = new Date(a.createdAt || 0).getTime();
        const dateB = new Date(b.createdAt || 0).getTime();
        return dateB - dateA;
      });
      setReports(list);
    } catch (e) {
      console.error('Failed to load reports:', e);
    }
  };

  const fetchRequests = async () => {
    try {
      const snap = await getDocs(collection(db, 'requests'));
      const list = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(r => (r as any).status === 'pending');
      setRequests(list);
    } catch (e) {
      console.error(e);
    }
  };

  const handleApprove = async (req: any) => {
    setError('');
    setSuccess('');
    try {
      if (req.actionType === 'add') {
        await setDoc(doc(collection(db, 'locations')), req.data);
      } else if (req.actionType === 'edit') {
        await updateDoc(doc(db, 'locations', req.originalId), req.data);
      }
      await updateDoc(doc(db, 'requests', req.id), { status: 'approved' });
      setSuccess("Taklif tasdiqlandi va xaritaga qo'shildi!");
      fetchRequests();
      fetchLocations();
    } catch (err: any) {
      setError(err.message || 'Xatolik yuz berdi');
    }
  };

  const handleReject = async (reqId: string) => {
    if (confirmRejectId !== reqId) {
      setConfirmRejectId(reqId);
      return;
    }
    setError('');
    setSuccess('');
    try {
      await updateDoc(doc(db, 'requests', reqId), { status: 'rejected' });
      setConfirmRejectId(null);
      setSuccess('Taklif rad etildi.');
      fetchRequests();
    } catch (err: any) {
      setError(err.message || 'Xatolik yuz berdi');
    }
  };

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const snap = await getDocs(collection(db, 'users'));
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setUsers(list);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setIsSubmitting(true);

    let secondaryApp: FirebaseApp | null = null;
    try {
      secondaryApp = initializeApp(firebaseConfig, `SecondaryApp_${Date.now()}`);
      const secondaryAuth = getAuth(secondaryApp);

      const userCredential = await createUserWithEmailAndPassword(secondaryAuth, newEmail, newPassword);
      const newUserId = userCredential.user.uid;

      await setDoc(doc(db, 'users', newUserId), {
        email: newEmail,
        role: newRole,
        createdAt: new Date().toISOString(),
      });

      await secondaryAuth.signOut();

      setSuccess("Foydalanuvchi muvaffaqiyatli qo'shildi!");
      setNewEmail('');
      setNewPassword('');
      setNewRole('user');
      setIsModalOpen(false);
      fetchUsers();
    } catch (err: any) {
      setError(err.message || 'Xatolik yuz berdi');
    } finally {
      if (secondaryApp) {
        await deleteApp(secondaryApp).catch(() => {});
      }
      setIsSubmitting(false);
    }
  };

  const handleLogout = async () => {
    await auth.signOut();
    navigate('/login');
  };

  const handleDeleteUser = async (userId: string) => {
    if (confirmDeleteUserId !== userId) {
      setConfirmDeleteUserId(userId);
      return;
    }
    setError('');
    setSuccess('');
    try {
      await deleteDoc(doc(db, 'users', userId));
      setConfirmDeleteUserId(null);
      setSuccess("Foydalanuvchi yozuvi o'chirildi.");
      fetchUsers();
    } catch (err: any) {
      setError(err.message || "O'chirishda xatolik yuz berdi");
    }
  };

  const tabTitle =
    activeTab === 'users'
      ? "Foydalanuvchilar ro'yxati"
      : activeTab === 'requests'
      ? "Xaritadagi o'zgarish takliflari"
      : 'Telegram Foto-hisobotlar';

  const tabDescription =
    activeTab === 'users'
      ? 'Tizimga kirish huquqiga ega barcha xodimlar'
      : activeTab === 'requests'
      ? "Foydalanuvchilar tomondan yuborilgan yangi joylashuv yoki tahrirlashlar"
      : "Haydovchi va mas'ullar Telegram bot orqali yuborgan joyidagi foto-hisobotlar";

  return (
    <div className="min-h-screen bg-slate-50 flex">
      {/* Sidebar */}
      <div className="w-64 bg-white border-r border-slate-100 flex-col hidden md:flex">
        <div className="p-6 border-b border-slate-100">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 bg-indigo-100 text-indigo-600 rounded-xl flex items-center justify-center">
              <Shield className="w-5 h-5" />
            </div>
            <h1 className="font-extrabold text-slate-900 tracking-tight text-lg">Iqtisodchi Paneli</h1>
          </div>
        </div>

        <div className="p-4 flex-1">
          <ul className="space-y-2">
            <li>
              <button
                type="button"
                onClick={() => setActiveTab('users')}
                className={`w-full flex items-center space-x-3 px-4 py-3 rounded-xl font-bold text-sm transition-colors cursor-pointer ${
                  activeTab === 'users'
                    ? 'bg-indigo-50 text-indigo-700'
                    : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                }`}
              >
                <Users className="w-5 h-5" />
                <span>Foydalanuvchilar</span>
              </button>
            </li>
            <li>
              <button
                type="button"
                onClick={() => setActiveTab('requests')}
                className={`w-full flex items-center justify-between px-4 py-3 rounded-xl font-bold text-sm transition-colors cursor-pointer ${
                  activeTab === 'requests'
                    ? 'bg-indigo-50 text-indigo-700'
                    : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                }`}
              >
                <div className="flex items-center space-x-3">
                  <MessageSquare className="w-5 h-5" />
                  <span>Takliflar</span>
                </div>
                {requests.length > 0 && (
                  <span className="bg-red-500 text-white min-w-[20px] h-[20px] flex items-center justify-center rounded-full text-[10px] px-1">
                    {requests.length}
                  </span>
                )}
              </button>
            </li>
            <li>
              <button
                type="button"
                onClick={() => setActiveTab('reports')}
                className={`w-full flex items-center justify-between px-4 py-3 rounded-xl font-bold text-sm transition-colors cursor-pointer ${
                  activeTab === 'reports'
                    ? 'bg-indigo-50 text-indigo-700'
                    : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                }`}
              >
                <div className="flex items-center space-x-3">
                  <Camera className="w-5 h-5" />
                  <span>Foto-hisobotlar</span>
                </div>
                {reports.length > 0 && (
                  <span className="bg-sky-600 text-white min-w-[20px] h-[20px] flex items-center justify-center rounded-full text-[10px] px-1">
                    {reports.length}
                  </span>
                )}
              </button>
            </li>
            <li>
              <button
                type="button"
                disabled={isExporting}
                onClick={handleDownloadExcel}
                className="w-full flex items-center space-x-3 px-4 py-3 rounded-xl font-extrabold text-sm text-emerald-700 bg-emerald-50 hover:bg-emerald-100 disabled:opacity-60 transition-colors border border-emerald-200 cursor-pointer shadow-sm"
              >
                <FileSpreadsheet className="w-5 h-5 text-emerald-600" />
                <span className="truncate">{isExporting ? 'Yuklanmoqda...' : 'Excel Smetani Yuklash'}</span>
              </button>
            </li>
            <li>
              <button
                type="button"
                onClick={() => navigate('/')}
                className="w-full flex items-center space-x-3 px-4 py-3 text-slate-600 hover:bg-slate-50 hover:text-slate-900 rounded-xl font-semibold text-sm transition-colors cursor-pointer"
              >
                <MapIcon className="w-5 h-5" />
                <span>Xaritaga qaytish</span>
              </button>
            </li>
          </ul>
        </div>

        <div className="p-4 border-t border-slate-100">
          <div className="flex items-center justify-between mb-4">
            <span className="text-xs font-bold text-slate-500 truncate px-2">{currentUser?.email}</span>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            className="w-full flex items-center justify-center space-x-2 px-4 py-3 text-red-600 bg-red-50 hover:bg-red-100 rounded-xl font-bold text-sm transition-colors cursor-pointer"
          >
            <LogOut className="w-4 h-4" />
            <span>Chiqish</span>
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col p-4 sm:p-8 overflow-y-auto">
        <div className="md:hidden flex items-center justify-between mb-5 gap-3">
          <div className="flex items-center space-x-3">
            <button
              type="button"
              onClick={() => navigate('/')}
              aria-label="Xaritaga qaytish"
              className="p-2 bg-white rounded-lg shadow-sm border border-slate-100 text-slate-600"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <h1 className="text-lg font-extrabold text-slate-900">Iqtisodchi Paneli</h1>
          </div>
          <button
            type="button"
            disabled={isExporting}
            onClick={handleDownloadExcel}
            aria-label="Excel smetani yuklash"
            className="p-2 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-lg"
          >
            <FileSpreadsheet className="w-5 h-5" />
          </button>
        </div>

        {/* Mobile-friendly horizontal tabs */}
        <div className="flex md:hidden bg-slate-100 p-1 rounded-xl mb-6 gap-1 shrink-0">
          <button
            type="button"
            onClick={() => setActiveTab('users')}
            className={`flex-1 text-center py-2 rounded-lg font-bold text-xs transition-all ${
              activeTab === 'users' ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-600'
            }`}
          >
            Xodimlar
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('requests')}
            className={`flex-1 text-center py-2 rounded-lg font-bold text-xs transition-all ${
              activeTab === 'requests' ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-600'
            }`}
          >
            Takliflar ({requests.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('reports')}
            className={`flex-1 text-center py-2 rounded-lg font-bold text-xs transition-all ${
              activeTab === 'reports' ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-600'
            }`}
          >
            Foto ({reports.length})
          </button>
        </div>

        <div className="flex flex-wrap justify-between items-center gap-4 mb-8">
          <div>
            <h2 className="text-2xl font-extrabold text-slate-900 tracking-tight">{tabTitle}</h2>
            <p className="text-slate-500 text-sm mt-1">{tabDescription}</p>
          </div>
          {activeTab === 'users' && (
            <button
              type="button"
              onClick={() => setIsModalOpen(true)}
              className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-3 rounded-xl font-bold text-sm flex items-center space-x-2 shadow-lg shadow-indigo-200 transition-all active:scale-95 cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>Yangi xodim</span>
            </button>
          )}
        </div>

        {error && (
          <div className="mb-6 p-4 bg-red-50 text-red-700 rounded-xl border border-red-100 text-sm font-bold flex items-center justify-between gap-2">
            <span>{error}</span>
            <button type="button" onClick={() => setError('')} aria-label="Xabarni yopish">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {success && (
          <div className="mb-6 p-4 bg-green-50 text-green-700 rounded-xl border border-green-100 text-sm font-bold flex items-center justify-between gap-2">
            <span>{success}</span>
            <button type="button" onClick={() => setSuccess('')} aria-label="Xabarni yopish">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {activeTab === 'users' ? (
          <div className="bg-white rounded-3xl shadow-sm border border-slate-100 overflow-x-auto">
            <table className="w-full text-left text-sm text-slate-600">
              <thead className="bg-slate-50 text-xs uppercase font-bold tracking-widest text-slate-500 border-b border-slate-100">
                <tr>
                  <th className="px-6 py-4">Foydalanuvchi (Email)</th>
                  <th className="px-6 py-4">Rol</th>
                  <th className="px-6 py-4">Holat</th>
                  <th className="px-6 py-4">Amal</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={4} className="text-center py-8">
                      Yuklanmoqda...
                    </td>
                  </tr>
                ) : (
                  users.map(user => (
                    <tr key={user.id} className="border-b border-slate-50 hover:bg-slate-50/50 transition-colors">
                      <td className="px-6 py-4 font-semibold text-slate-900 flex items-center space-x-3">
                        <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center text-slate-500 shrink-0">
                          <User className="w-4 h-4" />
                        </div>
                        <span>{user.email || 'Email kiritilmagan'}</span>
                      </td>
                      <td className="px-6 py-4">
                        <span
                          className={`px-3 py-1 rounded-full text-xs font-bold ${
                            user.role === 'admin'
                              ? 'bg-indigo-100 text-indigo-700'
                              : 'bg-emerald-100 text-emerald-700'
                          }`}
                        >
                          {user.role === 'admin' ? 'Iqtisodchi (Admin)' : 'Foydalanuvchi (User)'}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <span className="flex items-center text-xs font-bold text-slate-400">Faol</span>
                      </td>
                      <td className="px-6 py-4">
                        {confirmDeleteUserId === user.id ? (
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => handleDeleteUser(user.id)}
                              className="text-white bg-red-600 hover:bg-red-700 font-bold text-xs px-3 py-1 rounded-lg transition-colors cursor-pointer"
                            >
                              Tasdiqlash
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteUserId(null)}
                              className="text-slate-600 hover:text-slate-900 font-bold text-xs px-2 py-1 border border-slate-200 rounded-lg cursor-pointer"
                            >
                              Bekor
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleDeleteUser(user.id)}
                            className="text-red-500 hover:text-red-700 font-bold text-xs px-3 py-1 border border-red-100 hover:bg-red-50 rounded-lg transition-colors cursor-pointer"
                          >
                            O'chirish
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
                {users.length === 0 && !loading && (
                  <tr>
                    <td colSpan={4} className="text-center py-8 text-slate-500">
                      Hech kim topilmadi. Avval admin ro'yxatdan o'tkazing.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        ) : activeTab === 'requests' ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {requests.map(req => (
              <div
                key={req.id}
                className="bg-white rounded-3xl shadow-sm border border-slate-100 p-6 flex flex-col justify-between"
              >
                <div>
                  <div className="flex items-center justify-between mb-4">
                    <span
                      className={`px-2.5 py-1 text-[10px] uppercase tracking-widest font-extrabold rounded-md ${
                        req.actionType === 'add'
                          ? 'bg-emerald-100 text-emerald-700'
                          : 'bg-amber-100 text-amber-700'
                      }`}
                    >
                      {req.actionType === 'add' ? "Yangi qo'shish" : 'Tahrirlash'}
                    </span>
                    <span className="text-xs text-slate-400 font-medium">Taklif</span>
                  </div>
                  <div className="space-y-1 mb-6">
                    <h3 className="font-extrabold text-slate-900 border-b border-slate-50 pb-2 mb-2">
                      {req.data?.name}
                    </h3>
                    <p className="text-xs text-slate-500 capitalize">
                      <strong>Turi:</strong> {req.data?.type}
                    </p>
                    <p className="text-xs text-slate-500 font-mono mt-1">
                      {req.data?.lat}, {req.data?.lng}
                    </p>
                  </div>
                </div>
                <div className="flex space-x-3">
                  <button
                    type="button"
                    onClick={() => handleApprove(req)}
                    className="flex-1 bg-emerald-50 hover:bg-emerald-100 text-emerald-600 border border-emerald-100 font-bold py-2.5 rounded-xl text-xs transition-colors flex justify-center items-center space-x-1.5 cursor-pointer"
                  >
                    <Check className="w-4 h-4" /> <span>Tasdiqlash</span>
                  </button>
                  {confirmRejectId === req.id ? (
                    <div className="flex-1 flex gap-1">
                      <button
                        type="button"
                        onClick={() => handleReject(req.id)}
                        className="flex-1 bg-red-600 hover:bg-red-700 text-white font-bold py-2.5 rounded-xl text-xs transition-colors cursor-pointer"
                      >
                        Rad et
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmRejectId(null)}
                        className="px-2.5 bg-slate-100 hover:bg-slate-200 text-slate-600 font-bold py-2.5 rounded-xl text-xs cursor-pointer"
                      >
                        Yo'q
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleReject(req.id)}
                      className="flex-1 bg-slate-50 hover:bg-slate-100 text-slate-600 border border-slate-100 font-bold py-2.5 rounded-xl text-xs transition-colors flex justify-center items-center space-x-1.5 cursor-pointer"
                    >
                      <XCircle className="w-4 h-4" /> <span>Rad etish</span>
                    </button>
                  )}
                </div>
              </div>
            ))}
            {requests.length === 0 && (
              <div className="col-span-full py-12 text-center text-slate-500">
                Hozircha o'zgarishlar tasdiqlash uchun kutilmayapti.
              </div>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {reports.map(report => {
              const photoUrl = `/api/telegram-photo/${encodeURIComponent(report.photoFileId || '')}`;
              const formattedDate = report.createdAt
                ? new Date(report.createdAt).toLocaleString('uz-UZ', {
                    day: '2-digit',
                    month: '2-digit',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })
                : "Sana noma'lum";
              return (
                <div
                  key={report.id}
                  className="bg-white rounded-3xl shadow-sm border border-slate-100 overflow-hidden flex flex-col"
                >
                  <div className="relative h-52 bg-slate-100 flex items-center justify-center overflow-hidden">
                    {report.photoFileId && !brokenReportImages[report.id] ? (
                      <img
                        src={photoUrl}
                        alt={report.caption || 'Telegram foto-hisobot'}
                        className="w-full h-full object-cover"
                        loading="lazy"
                        onError={() =>
                          setBrokenReportImages(prev => ({ ...prev, [report.id]: true }))
                        }
                      />
                    ) : (
                      <div className="flex flex-col items-center justify-center text-slate-400 p-4 text-center">
                        <Camera className="w-8 h-8 mb-2 opacity-60" />
                        <span className="text-xs font-semibold">
                          Rasmni yuklab bo'lmadi (TELEGRAM_BOT_TOKEN sozlanganini tekshiring)
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="p-5 flex-1 flex flex-col justify-between space-y-3">
                    <div>
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="font-extrabold text-slate-900 text-sm truncate">
                          {report.userFullname || "Noma'lum xodim"}
                        </h3>
                        {report.username && (
                          <span className="text-[11px] font-bold text-sky-600 bg-sky-50 px-2 py-0.5 rounded-full">
                            @{report.username}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-slate-600 mt-2 leading-relaxed">
                        {report.caption || 'Izoh kiritilmagan'}
                      </p>
                    </div>
                    <div className="pt-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-400">
                      <span className="flex items-center gap-1 font-medium">
                        <Clock className="w-3.5 h-3.5" />
                        {formattedDate}
                      </span>
                      {report.photoFileId && !brokenReportImages[report.id] && (
                        <a
                          href={photoUrl}
                          download={`hisobot_${report.id}.jpg`}
                          className="inline-flex items-center gap-1 text-indigo-600 hover:text-indigo-700 font-bold"
                        >
                          <Download className="w-3.5 h-3.5" />
                          <span>Yuklash</span>
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
            {reports.length === 0 && (
              <div className="col-span-full py-12 text-center text-slate-500">
                Hozircha Telegram bot orqali foto-hisobotlar yuborilmagan.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Add User Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl max-w-md w-full overflow-hidden">
            <div className="p-6 border-b border-slate-100 flex justify-between items-center">
              <h3 className="font-extrabold text-slate-900">Yangi xodim qo'shish</h3>
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                aria-label="Modalni yopish"
                className="p-2 text-slate-400 hover:bg-slate-100 rounded-full transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleAddUser} className="p-6 space-y-4">
              {error && (
                <div className="p-3 bg-red-50 text-red-600 text-xs font-bold rounded-xl border border-red-100">
                  {error}
                </div>
              )}

              <div>
                <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">
                  Email
                </label>
                <input
                  type="email"
                  value={newEmail}
                  onChange={e => setNewEmail(e.target.value)}
                  required
                  className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:bg-white text-sm font-semibold outline-none"
                  placeholder="xodim@example.com"
                />
              </div>
              <div>
                <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">
                  Parol (min 6 belgi)
                </label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  required
                  minLength={6}
                  className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:bg-white text-sm font-semibold outline-none"
                  placeholder="••••••••"
                />
              </div>
              <div>
                <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">
                  Rol (Huquq)
                </label>
                <select
                  value={newRole}
                  onChange={e => setNewRole(e.target.value as 'admin' | 'user')}
                  className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:bg-white text-sm font-semibold outline-none cursor-pointer"
                >
                  <option value="user">Foydalanuvchi (User)</option>
                  <option value="admin">Iqtisodchi (Admin)</option>
                </select>
              </div>

              <div className="mt-6 pt-4 border-t border-slate-100">
                <button
                  disabled={isSubmitting}
                  type="submit"
                  className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white font-bold text-sm rounded-xl transition-colors flex justify-center items-center cursor-pointer"
                >
                  {isSubmitting ? 'Kuting...' : 'Saqlash'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
