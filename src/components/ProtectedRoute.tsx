import React from 'react';
import { Navigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { auth } from '../lib/firebase';

interface ProtectedRouteProps {
  children: React.ReactNode;
  requireAdmin?: boolean;
}

export const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children, requireAdmin = false }) => {
  const { currentUser, role, loading } = useAuth();
  const location = useLocation();

  if (loading || (currentUser && role === null)) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="w-10 h-10 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin"></div>
      </div>
    );
  }

  if (!currentUser) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }

  if (requireAdmin && role !== 'admin') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
        <div className="max-w-md w-full bg-white rounded-3xl shadow-xl border border-slate-100 p-8 text-center">
          <h2 className="text-xl font-extrabold text-slate-900 mb-2">Admin ruxsati talab etiladi</h2>
          <p className="text-sm text-slate-600 mb-2">
            Siz hozir oddiy foydalanuvchi hisobi bilan kirgansiz:
          </p>
          <p className="text-xs font-bold text-slate-800 bg-slate-100 rounded-xl py-2 px-3 mb-6 break-all">
            {currentUser.email || currentUser.uid}
          </p>
          <div className="flex flex-col gap-2.5">
            <button
              type="button"
              onClick={() => auth.signOut()}
              className="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm rounded-xl transition-colors cursor-pointer"
            >
              Boshqa (Admin) hisob bilan kirish
            </button>
            <Link
              to="/"
              className="w-full py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-sm rounded-xl transition-colors"
            >
              Xaritaga qaytish
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
};
