import React, { useState, useEffect } from 'react';
import { 
  AlertCircle, CheckCircle2, Clock, Trash2, MessageSquare, 
  User, Phone, ShieldCheck, TrendingUp, Volume2, Image as ImageIcon, 
  FileText, Send, X, RefreshCw, Sparkles, Filter, Search, Check, 
  ArrowUpRight, CornerDownRight, MessageCircle, MapPin
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Complaint, VoiceInteraction } from '../types';
import { RenderedMarkdown } from './RenderedMarkdown';
import { adminFetch } from '../lib/adminAuth';

export default function Dashboard() {
  const [complaints, setComplaints] = useState<Complaint[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedComplaint, setSelectedComplaint] = useState<Complaint | null>(null);
  const [replyText, setReplyText] = useState('');
  const [replyStatus, setReplyStatus] = useState<'pending' | 'under_review' | 'resolved'>('resolved');
  const [isSubmittingReply, setIsSubmittingReply] = useState(false);
  const [filterStatus, setFilterStatus] = useState<'all' | 'pending' | 'under_review' | 'resolved'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [successToast, setSuccessToast] = useState<string | null>(null);

  const fetchComplaints = async () => {
    setIsLoading(true);
    try {
      const res = await adminFetch('/api/admin/complaints');
      const data = await res.json();
      if (Array.isArray(data)) {
        const formatted: Complaint[] = data.map((row: any) => {
          let chatHistory: VoiceInteraction[] = [];
          let mediaUrls: string[] = [];
          try {
            chatHistory = typeof row.chatHistory === 'string' ? JSON.parse(row.chatHistory || '[]') : row.chatHistory || [];
          } catch { chatHistory = []; }
          try {
            mediaUrls = typeof row.mediaUrls === 'string' ? JSON.parse(row.mediaUrls || '[]') : row.mediaUrls || [];
          } catch { mediaUrls = []; }

          return {
            ...row,
            chatHistory,
            mediaUrls,
            status: row.status || 'pending',
          };
        });
        setComplaints(formatted);
      }
    } catch (err) {
      console.error('Error fetching admin complaints:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchComplaints();
  }, []);

  const openComplaintModal = (complaint: Complaint) => {
    setSelectedComplaint(complaint);
    setReplyText(complaint.adminReply || '');
    setReplyStatus((complaint.status as any) || 'resolved');
  };

  const handleSendReply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedComplaint || !replyText.trim()) return;

    setIsSubmittingReply(true);
    try {
      const res = await adminFetch(`/api/admin/complaints/${selectedComplaint.id}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reply: replyText.trim(),
          status: replyStatus,
        }),
      });

      const data = await res.json();
      if (data.success) {
        // Update state locally
        const updatedComplaints = complaints.map(c => 
          c.id === selectedComplaint.id 
            ? { ...c, adminReply: replyText.trim(), adminReplyAt: data.adminReplyAt || Date.now(), status: replyStatus }
            : c
        );
        setComplaints(updatedComplaints);
        setSelectedComplaint(prev => prev ? {
          ...prev,
          adminReply: replyText.trim(),
          adminReplyAt: data.adminReplyAt || Date.now(),
          status: replyStatus
        } : null);

        setSuccessToast(`Reply sent to ${selectedComplaint.name || 'Customer'}! Status updated to ${replyStatus}.`);
        setTimeout(() => setSuccessToast(null), 3500);
      }
    } catch (err) {
      console.error('Error submitting reply:', err);
    } finally {
      setIsSubmittingReply(false);
    }
  };

  const updateComplaintStatusDirectly = async (id: string, newStatus: 'pending' | 'under_review' | 'resolved') => {
    try {
      await adminFetch(`/api/admin/complaints/${id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });

      setComplaints(prev => prev.map(c => c.id === id ? { ...c, status: newStatus } : c));
      if (selectedComplaint?.id === id) {
        setSelectedComplaint(prev => prev ? { ...prev, status: newStatus } : null);
      }
    } catch (err) {
      console.error('Failed to update status', err);
    }
  };

  const deleteComplaint = async (id: string) => {
    if (!window.confirm("Are you sure you want to delete this complaint record?")) return;
    try {
      await adminFetch(`/api/admin/complaints/${id}`, { method: 'DELETE' });
      setComplaints(prev => prev.filter(c => c.id !== id));
      if (selectedComplaint?.id === id) {
        setSelectedComplaint(null);
      }
    } catch (err) {
      console.error('Failed to delete complaint', err);
    }
  };

  const quickTemplates = [
    "We apologize for the inconvenience. A full refund has been credited to your account.",
    "Our kitchen manager has been notified and standard operating procedures have been reinforced.",
    "Thank you for notifying us. We have investigated the issue and taken corrective action immediately.",
    "We sincerely regret the delay. We have expedited your resolution with priority support."
  ];

  // Filtering
  const filteredComplaints = complaints.filter(c => {
    const matchesStatus = filterStatus === 'all' || c.status === filterStatus;
    const matchesSearch = 
      c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.phoneNumber.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.query.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (c.location && c.location.toLowerCase().includes(searchQuery.toLowerCase())) ||
      c.id.includes(searchQuery);
    return matchesStatus && matchesSearch;
  });

  const totalCount = complaints.length;
  const pendingCount = complaints.filter(c => c.status === 'pending').length;
  const underReviewCount = complaints.filter(c => c.status === 'under_review' || c.status === 'investigating').length;
  const resolvedCount = complaints.filter(c => c.status === 'resolved').length;

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="px-6 space-y-6 max-w-4xl mx-auto pb-16"
    >
      {/* Toast Alert */}
      <AnimatePresence>
        {successToast && (
          <motion.div 
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="fixed top-16 left-1/2 -translate-x-1/2 z-50 bg-emerald-600 text-white px-5 py-3 rounded-2xl shadow-xl flex items-center gap-2 text-xs font-bold"
          >
            <CheckCircle2 size={16} />
            <span>{successToast}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* KPI Cards Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div 
          onClick={() => setFilterStatus('all')}
          className={`p-4.5 rounded-3xl border transition-all cursor-pointer ${
            filterStatus === 'all' 
              ? 'bg-slate-900 text-white border-slate-900 shadow-md' 
              : 'bg-white text-slate-800 border-slate-100 shadow-sm hover:border-slate-300'
          }`}
        >
          <div className="flex items-center justify-between mb-2">
            <span className={`text-[10px] font-bold uppercase tracking-wider ${filterStatus === 'all' ? 'text-slate-300' : 'text-slate-400'}`}>
              Total
            </span>
            <TrendingUp size={15} className={filterStatus === 'all' ? 'text-indigo-400' : 'text-slate-400'} />
          </div>
          <p className="text-2xl font-bold">{totalCount}</p>
        </div>

        <div 
          onClick={() => setFilterStatus('pending')}
          className={`p-4.5 rounded-3xl border transition-all cursor-pointer ${
            filterStatus === 'pending' 
              ? 'bg-amber-600 text-white border-amber-600 shadow-md' 
              : 'bg-white text-slate-800 border-slate-100 shadow-sm hover:border-amber-200'
          }`}
        >
          <div className="flex items-center justify-between mb-2">
            <span className={`text-[10px] font-bold uppercase tracking-wider ${filterStatus === 'pending' ? 'text-amber-100' : 'text-amber-600'}`}>
              Pending
            </span>
            <Clock size={15} className={filterStatus === 'pending' ? 'text-amber-200' : 'text-amber-500'} />
          </div>
          <p className="text-2xl font-bold">{pendingCount}</p>
        </div>

        <div 
          onClick={() => setFilterStatus('under_review')}
          className={`p-4.5 rounded-3xl border transition-all cursor-pointer ${
            filterStatus === 'under_review' 
              ? 'bg-blue-600 text-white border-blue-600 shadow-md' 
              : 'bg-white text-slate-800 border-slate-100 shadow-sm hover:border-blue-200'
          }`}
        >
          <div className="flex items-center justify-between mb-2">
            <span className={`text-[10px] font-bold uppercase tracking-wider ${filterStatus === 'under_review' ? 'text-blue-100' : 'text-blue-600'}`}>
              In Review
            </span>
            <Sparkles size={15} className={filterStatus === 'under_review' ? 'text-blue-200' : 'text-blue-500'} />
          </div>
          <p className="text-2xl font-bold">{underReviewCount}</p>
        </div>

        <div 
          onClick={() => setFilterStatus('resolved')}
          className={`p-4.5 rounded-3xl border transition-all cursor-pointer ${
            filterStatus === 'resolved' 
              ? 'bg-emerald-600 text-white border-emerald-600 shadow-md' 
              : 'bg-white text-slate-800 border-slate-100 shadow-sm hover:border-emerald-200'
          }`}
        >
          <div className="flex items-center justify-between mb-2">
            <span className={`text-[10px] font-bold uppercase tracking-wider ${filterStatus === 'resolved' ? 'text-emerald-100' : 'text-emerald-600'}`}>
              Resolved
            </span>
            <CheckCircle2 size={15} className={filterStatus === 'resolved' ? 'text-emerald-200' : 'text-emerald-500'} />
          </div>
          <p className="text-2xl font-bold">{resolvedCount}</p>
        </div>
      </div>

      {/* Search & Filter Controls */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 bg-white p-3 rounded-2xl border border-slate-100 shadow-sm">
        <div className="relative flex-1">
          <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Search by customer, phone, issue, or ID..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-4 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 font-medium"
          />
        </div>

        <div className="flex items-center gap-1.5 self-end sm:self-auto">
          <button
            onClick={fetchComplaints}
            disabled={isLoading}
            className="p-2 text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-xl transition-colors active:scale-95 disabled:opacity-50"
            title="Refresh Complaints"
          >
            <RefreshCw className={isLoading ? "animate-spin" : ""} size={16} />
          </button>
        </div>
      </div>

      {/* Complaints List */}
      <div className="space-y-3">
        <div className="flex items-center justify-between px-1">
          <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest">
            Complaints Inbox ({filteredComplaints.length})
          </h3>
          <span className="text-[10px] text-slate-400 font-medium">
            Click any complaint to view full details & reply
          </span>
        </div>

        <AnimatePresence mode="popLayout">
          {filteredComplaints.map((c) => {
            const hasAudio = !!c.audioUrl;
            const hasMedia = Array.isArray(c.mediaUrls) && c.mediaUrls.length > 0;
            const hasReply = !!c.adminReply;

            return (
              <motion.div
                key={c.id}
                layout
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                onClick={() => openComplaintModal(c)}
                className={`bg-white p-5 rounded-3xl border border-slate-100 shadow-sm hover:shadow-md hover:border-indigo-200 transition-all cursor-pointer group flex flex-col gap-3.5 ${
                  c.status === 'resolved' ? 'border-l-4 border-l-emerald-500' : 
                  c.status === 'under_review' ? 'border-l-4 border-l-blue-500' : 'border-l-4 border-l-amber-500'
                }`}
              >
                {/* Header info */}
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-2xl flex items-center justify-center font-bold text-xs shrink-0 ${
                      c.status === 'resolved' ? 'bg-emerald-50 text-emerald-700' : 
                      c.status === 'under_review' ? 'bg-blue-50 text-blue-700' : 'bg-amber-50 text-amber-700'
                    }`}>
                      <User size={18} />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h4 className="font-bold text-slate-900 text-sm group-hover:text-indigo-600 transition-colors">
                          {c.name || "Customer"}
                        </h4>
                        <span className="text-[10px] font-mono text-slate-400">
                          #{c.id.slice(-6)}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-[11px] text-slate-400 font-medium">
                        <span className="flex items-center gap-1"><Phone size={11} /> {c.phoneNumber}</span>
                        {c.location && (
                          <>
                            <span>•</span>
                            <span className="flex items-center gap-1"><MapPin size={11} /> {c.location}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className={`px-2.5 py-1 rounded-full text-[9px] font-bold uppercase tracking-wider ${
                      c.status === 'resolved' 
                        ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' 
                        : c.status === 'under_review'
                        ? 'bg-blue-50 text-blue-700 border border-blue-200'
                        : 'bg-amber-50 text-amber-700 border border-amber-200'
                    }`}>
                      {c.status === 'resolved' ? 'Resolved' : c.status === 'under_review' ? 'Under Review' : 'Pending'}
                    </span>
                  </div>
                </div>

                {/* Complaint statement */}
                <div className="bg-slate-50/70 p-3.5 rounded-2xl border border-slate-100 text-xs text-slate-700 font-medium leading-relaxed">
                  "{c.query}"
                </div>

                {/* Footer metadata & quick indicators */}
                <div className="flex items-center justify-between text-[11px] text-slate-400 pt-1">
                  <div className="flex items-center gap-3">
                    {hasAudio && (
                      <span className="flex items-center gap-1 text-indigo-600 font-semibold bg-indigo-50 px-2 py-0.5 rounded-md text-[10px]">
                        <Volume2 size={12} /> Audio Recorded
                      </span>
                    )}
                    {hasMedia && (
                      <span className="flex items-center gap-1 text-slate-600 font-medium bg-slate-100 px-2 py-0.5 rounded-md text-[10px]">
                        <ImageIcon size={12} /> {(c.mediaUrls as string[]).length} Attachments
                      </span>
                    )}
                    {hasReply && (
                      <span className="flex items-center gap-1 text-emerald-700 font-semibold bg-emerald-50 px-2 py-0.5 rounded-md text-[10px]">
                        <Check size={12} /> Replied by Admin
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <span>
                      {new Date(c.createdAt).toLocaleDateString()} {new Date(c.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <ArrowUpRight size={14} className="text-slate-300 group-hover:text-indigo-600 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-all" />
                  </div>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>

        {filteredComplaints.length === 0 && (
          <div className="text-center py-16 bg-white rounded-3xl border border-slate-100 shadow-sm px-6">
            <AlertCircle size={36} className="mx-auto text-slate-300 mb-3" />
            <h3 className="text-sm font-bold text-slate-700 mb-1">No Complaints Found</h3>
            <p className="text-xs text-slate-400 max-w-sm mx-auto">
              {searchQuery ? `No complaints match "${searchQuery}".` : "No complaints recorded in this category."}
            </p>
          </div>
        )}
      </div>

      {/* FULL DETAIL & REPLY MODAL */}
      <AnimatePresence>
        {selectedComplaint && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          >
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden border border-slate-100"
            >
              {/* Modal Top Header */}
              <div className="p-5 border-b border-slate-100 flex items-center justify-between bg-slate-50/60">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-2xl bg-indigo-600 text-white flex items-center justify-center font-bold text-xs shadow-md shadow-indigo-100">
                    <User size={20} />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-bold text-slate-900 text-sm">{selectedComplaint.name || 'Customer'}</h3>
                      <span className="text-[10px] font-mono font-bold text-slate-400 bg-white px-2 py-0.5 rounded-lg border border-slate-200">
                        #{selectedComplaint.id.slice(-6)}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-500 font-medium">
                      Phone: <span className="font-semibold text-slate-700">{selectedComplaint.phoneNumber}</span>
                      {selectedComplaint.location ? ` • Location: ${selectedComplaint.location}` : ''}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button 
                    onClick={() => deleteComplaint(selectedComplaint.id)}
                    className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-xl transition-colors"
                    title="Delete Complaint"
                  >
                    <Trash2 size={16} />
                  </button>
                  <button 
                    onClick={() => setSelectedComplaint(null)}
                    className="p-2 text-slate-400 hover:text-slate-600 rounded-xl"
                  >
                    <X size={18} />
                  </button>
                </div>
              </div>

              {/* Modal Scrollable Body */}
              <div className="p-6 overflow-y-auto flex-1 space-y-5 custom-scrollbar bg-white">
                {/* Status selector bar */}
                <div className="flex items-center justify-between p-3.5 bg-slate-50 rounded-2xl border border-slate-100">
                  <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                    Complaint Status
                  </span>

                  <div className="flex gap-1.5">
                    {(['pending', 'under_review', 'resolved'] as const).map((st) => (
                      <button
                        key={st}
                        type="button"
                        onClick={() => {
                          setReplyStatus(st);
                          updateComplaintStatusDirectly(selectedComplaint.id, st);
                        }}
                        className={`px-3 py-1 rounded-xl text-[10px] font-bold uppercase tracking-wider transition-all ${
                          (selectedComplaint.status === st || replyStatus === st)
                            ? st === 'resolved' 
                              ? 'bg-emerald-600 text-white shadow-sm'
                              : st === 'under_review'
                              ? 'bg-blue-600 text-white shadow-sm'
                              : 'bg-amber-500 text-white shadow-sm'
                            : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-100'
                        }`}
                      >
                        {st === 'resolved' ? 'Resolved' : st === 'under_review' ? 'In Review' : 'Pending'}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Reported Issue Section */}
                <div className="space-y-1.5">
                  <h4 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">
                    Customer's Reported Issue & Grievance Dossier
                  </h4>
                  {selectedComplaint.query && (selectedComplaint.query.includes('# ') || selectedComplaint.query.includes('### ') || selectedComplaint.query.includes('| Parameter |') || selectedComplaint.query.includes('|---')) ? (
                    <div className="p-4 bg-slate-50/80 rounded-2xl border border-slate-200">
                      <RenderedMarkdown content={selectedComplaint.query} />
                    </div>
                  ) : (
                    <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100 text-slate-800 text-xs font-semibold leading-relaxed">
                      "{selectedComplaint.query}"
                    </div>
                  )}
                </div>

                {/* Voice Audio Recording */}
                {selectedComplaint.audioUrl && (
                  <div className="p-4 bg-indigo-50/60 rounded-2xl border border-indigo-100 space-y-2">
                    <div className="flex items-center gap-2 text-indigo-800 text-xs font-bold uppercase tracking-wider">
                      <Volume2 size={16} /> Attached Customer Voice Recording
                    </div>
                    <audio src={selectedComplaint.audioUrl} controls className="w-full h-9 rounded-lg" />
                  </div>
                )}

                {/* Evidence / Attachments */}
                {Array.isArray(selectedComplaint.mediaUrls) && selectedComplaint.mediaUrls.length > 0 && (
                  <div className="space-y-2">
                    <h4 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1">
                      <ImageIcon size={13} /> Attached Evidence Photos ({selectedComplaint.mediaUrls.length})
                    </h4>
                    <div className="flex flex-wrap gap-2.5">
                      {selectedComplaint.mediaUrls.map((url, i) => (
                        <a 
                          key={i}
                          href={url}
                          target="_blank"
                          rel="noreferrer"
                          className="w-20 h-20 rounded-2xl border border-slate-200 overflow-hidden group relative hover:ring-2 hover:ring-indigo-500 transition-all bg-slate-100"
                        >
                          <img src={url} alt="Attachment" className="w-full h-full object-cover group-hover:scale-105 transition-transform" />
                        </a>
                      ))}
                    </div>
                  </div>
                )}

                {/* Conversation Transcript */}
                {Array.isArray(selectedComplaint.chatHistory) && selectedComplaint.chatHistory.length > 0 && (
                  <div className="space-y-2">
                    <h4 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1">
                      <MessageSquare size={13} /> Full AI & Customer Interaction Transcript
                    </h4>
                    <div className="bg-slate-50 p-3.5 rounded-2xl border border-slate-100 space-y-2 max-h-48 overflow-y-auto custom-scrollbar">
                      {selectedComplaint.chatHistory.map((msg, i) => (
                        <div key={i} className={`flex flex-col ${msg.sender === 'user' ? 'items-end' : 'items-start'}`}>
                          <div className={`p-2.5 rounded-xl text-xs max-w-[85%] font-medium ${
                            msg.sender === 'user' 
                              ? 'bg-indigo-600 text-white shadow-sm' 
                              : 'bg-white text-slate-800 border border-slate-200'
                          }`}>
                            {msg.text}
                          </div>
                          <span className="text-[9px] font-bold text-slate-400 mt-0.5">
                            {msg.sender === 'user' ? selectedComplaint.name || 'User' : 'Assistant'} • {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Previous Admin Response if already replied */}
                {selectedComplaint.adminReply && (
                  <div className="p-4 bg-emerald-50/70 border border-emerald-200 rounded-2xl space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-bold text-emerald-800 uppercase tracking-wider flex items-center gap-1.5">
                        <CheckCircle2 size={14} className="text-emerald-600" /> Active Reply Shown to Customer
                      </span>
                      {selectedComplaint.adminReplyAt && (
                        <span className="text-[10px] text-emerald-700 font-semibold">
                          {new Date(selectedComplaint.adminReplyAt).toLocaleString()}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-emerald-950 font-medium leading-relaxed whitespace-pre-wrap bg-white/70 p-3 rounded-xl border border-emerald-100">
                      {selectedComplaint.adminReply}
                    </p>
                  </div>
                )}

                {/* REPLY COMPOSER FORM */}
                <form onSubmit={handleSendReply} className="space-y-3 pt-2 border-t border-slate-100">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-bold text-slate-700 uppercase tracking-wider flex items-center gap-1.5">
                      <MessageCircle size={14} className="text-indigo-600" />
                      {selectedComplaint.adminReply ? "Update Official Reply to Customer" : "Write Official Reply to Customer"}
                    </label>
                  </div>

                  {/* Quick preset chips */}
                  <div className="flex flex-wrap gap-1.5">
                    {quickTemplates.map((t, idx) => (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => setReplyText(t)}
                        className="text-[10px] bg-slate-100 hover:bg-indigo-50 hover:text-indigo-700 text-slate-600 px-2.5 py-1 rounded-lg border border-slate-200 transition-colors"
                      >
                        + {t.slice(0, 32)}...
                      </button>
                    ))}
                  </div>

                  <textarea
                    required
                    rows={4}
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    placeholder="Type official response, refund confirmation, or resolution details here. This message will be instantly visible to the customer on their 'Track Complaints' screen."
                    className="w-full p-3.5 text-xs bg-slate-50 border border-slate-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 font-medium leading-relaxed"
                  />

                  <div className="flex items-center justify-between pt-1">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-[11px] font-bold text-slate-400 uppercase">Set Status:</span>
                      <select
                        value={replyStatus}
                        onChange={(e: any) => setReplyStatus(e.target.value)}
                        className="bg-slate-100 border border-slate-200 text-xs font-semibold rounded-xl px-2.5 py-1 text-slate-700 focus:outline-none"
                      >
                        <option value="resolved">Resolved (Recommended)</option>
                        <option value="under_review">Under Review</option>
                        <option value="pending">Pending</option>
                      </select>
                    </div>

                    <button
                      type="submit"
                      disabled={isSubmittingReply || !replyText.trim()}
                      className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold uppercase tracking-wider shadow-md shadow-indigo-100 transition-all flex items-center gap-1.5 active:scale-95 disabled:opacity-50"
                    >
                      {isSubmittingReply ? (
                        <RefreshCw className="animate-spin" size={14} />
                      ) : (
                        <Send size={14} />
                      )}
                      <span>{isSubmittingReply ? "Sending..." : "Send Reply & Update"}</span>
                    </button>
                  </div>
                </form>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
