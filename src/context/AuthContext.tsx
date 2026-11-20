import React, { createContext, useContext, useEffect, useState } from 'react';
import { auth, db } from '../lib/firebase';
import { onAuthStateChanged, User } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';

interface AuthContextType {
  currentUser: User | null;
  role: 'admin' | 'user' | null;
  loading: boolean;
}

const AuthContext = createContext<AuthContextType>({} as AuthContextType);

const OWNER_ADMIN_EMAILS = ['abdulaziz5566658@gmail.com'];

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [role, setRole] = useState<'admin' | 'user' | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      setLoading(true);
      setCurrentUser(user);
      if (user) {
        const emailLower = (user.email || '').trim().toLowerCase();
        if (OWNER_ADMIN_EMAILS.includes(emailLower)) {
          setRole('admin');
          setLoading(false);
          return;
        }
        try {
          const docRef = doc(db, 'users', user.uid);
          const docSnap = await getDoc(docRef);
          if (docSnap.exists() && docSnap.data().role) {
            setRole(docSnap.data().role === 'admin' ? 'admin' : 'user');
          } else {
            // App has no public registration: accounts created directly in Firebase Auth Console
            // do not have a users/{uid} profile doc and act as root admins, whereas standard
            // users created via AdminDashboard always have an explicit role: 'user' document.
            setRole('admin');
          }
        } catch (error) {
          console.error('Error fetching user role:', error);
          setRole('admin');
        }
      } else {
        setRole(null);
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  return (
    <AuthContext.Provider value={{ currentUser, role, loading }}>
      {!loading && children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
