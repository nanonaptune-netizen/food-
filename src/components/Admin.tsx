import React, { useState } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation, Link } from 'react-router-dom';
import UploadData from './UploadData';
import Dashboard from './Dashboard';
import { Lock, Key, ArrowLeft, Database, BarChart3, LogOut } from 'lucide-react';
import { motion } from 'motion/react';
import { adminLogin, adminLogout, hasAdminSession } from '../lib/adminAuth';

function PINPad({ onVerify }: { onVerify: () => void }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);
  const [checking, setChecking] = useState(false);

  // The PIN is verified by the server, which issues the session token the
  // dashboard API requires. It is deliberately NOT compared in the browser:
  // a hard-coded constant here protected nothing, since the API was open.
  const handlePress = (num: string) => {
    if (checking || pin.length >= 4) return;
    const newPin = pin + num;
    setPin(newPin);
    if (newPin.length === 4) {
      setChecking(true);
      adminLogin(newPin)
        .then((ok) => {
          if (ok) {
            onVerify();
            return;
          }
          setError(true);
          setTimeout(() => {
            setPin('');
            setError(false);
          }, 1000);
        })
        .finally(() => setChecking(false));
    }
  };

  return (
    <div className="min-h-[80vh] flex flex-col items-center justify-center p-6">
      <div className="text-center mb-12">
        <div className="w-16 h-16 bg-slate-900 text-white rounded-3xl flex items-center justify-center mx-auto mb-4 shadow-xl">
          <Lock size={32} />
        </div>
        <h2 className="text-2xl font-bold">Admin Access</h2>
        <p className="text-slate-400">Enter secure PIN to continue</p>
      </div>

      <div className="w-full max-w-[280px]">
        <div className="flex justify-center gap-4 mb-12">
          {[0, 1, 2, 3].map((i) => (
            <div 
              key={i}
              className={`w-4 h-4 rounded-full border-2 transition-all duration-300 ${
                pin.length > i 
                ? 'bg-slate-900 border-slate-900 scale-125' 
                : 'border-slate-200'
              } ${error ? 'bg-red-500 border-red-500 animate-shake' : ''}`}
            />
          ))}
        </div>

        <div className="grid grid-cols-3 gap-6">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map((btn, i) => (
            <button
              key={i}
              onClick={() => {
                if (btn === '⌫') setPin(pin.slice(0, -1));
                else if (btn) handlePress(btn);
              }}
              className={`w-16 h-16 rounded-2xl flex items-center justify-center text-xl font-bold transition-all active:scale-90 ${
                !btn ? 'invisible' : 'bg-white border border-slate-100 shadow-sm text-slate-800 hover:bg-slate-50'
              }`}
            >
              {btn}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function Admin() {
  // Resume an existing server session (e.g. after a re-render or a page refresh
  // within the same tab) instead of forcing the PIN again.
  const [isAuthenticated, setIsAuthenticated] = useState(() => hasAdminSession());
  const navigate = useNavigate();
  const location = useLocation();

  if (!isAuthenticated) {
    return (
      <div className="space-y-4">
        <PINPad onVerify={() => setIsAuthenticated(true)} />
      </div>
    );
  }

  const isDataActive = location.pathname.includes('/admin/data');
  const isStatsActive = location.pathname.includes('/admin/stats') || location.pathname === '/admin' || location.pathname === '/admin/';

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div className="px-6 flex items-center justify-between">
        <button 
          onClick={() => {
            // Invalidate the server session as well, not just the local state.
            void adminLogout();
            setIsAuthenticated(false);
            navigate('/admin');
          }}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs transition-colors active:scale-95 shadow-sm"
          title="Logout from Admin Panel"
        >
          <LogOut size={14} /> Logout
        </button>

        <div className="flex gap-2 bg-slate-100 p-1 rounded-2xl border border-slate-200/60">
          <button 
            onClick={() => navigate('/admin/data')}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 ${
              isDataActive 
                ? 'bg-white text-indigo-600 shadow-sm' 
                : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            <Database size={14} /> Data
          </button>
          <button 
            onClick={() => navigate('/admin/stats')}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 ${
              isStatsActive 
                ? 'bg-white text-indigo-600 shadow-sm' 
                : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            <BarChart3 size={14} /> Stats
          </button>
        </div>
      </div>

      <Routes>
        <Route path="data" element={<UploadData />} />
        <Route path="stats" element={<Dashboard />} />
        <Route path="/" element={<Navigate to="stats" />} />
      </Routes>
    </div>
  );
}
