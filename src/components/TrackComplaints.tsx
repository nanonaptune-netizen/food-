import React, { useState, useEffect } from 'react';
import { 
  Phone, Clock, CheckCircle2, MessageSquare, Image, Volume2, 
  RefreshCw, AlertCircle, FileText, ChevronDown, ChevronUp, 
  ShieldAlert, Send, Sparkles, User, MessageCircle 
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { UserProfile, VoiceInteraction, Complaint } from '../types';
import { RenderedMarkdown } from './RenderedMarkdown';

interface TrackComplaintsProps {
  profile: UserProfile;
  onOpenProfile?: () => void;
}

export default function TrackComplaints({ profile, onOpenProfile }: TrackComplaintsProps) {
  const [complaints, setComplaints] = useState<Complaint[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string>('');

  const fetchComplaints = async () => {
    if (!profile.phone || !profile.phone.trim()) {
      setComplaints([]);
      return;
    }

    setIsLoading(true);
    setLoadError('');
    try {
      const url = `/api/complaints?phone=${encodeURIComponent(profile.phone.trim())}`;
      const res = await fetch(url);
      const data = await res.json();

      // The lookup requires the FULL phone number (it used to accept a partial
      // number, which leaked other citizens' complaints). Surface the reason
      // instead of silently showing "no complaints".
      if (!res.ok) {
        setLoadError(String(data?.error || 'Could not load your complaints.'));
        setComplaints([]);
        return;
      }

      if (Array.isArray(data)) {
        const formatted: Complaint[] = data.map((item: any) => {
          let parsedChat: VoiceInteraction[] = [];
          let parsedMedia: string[] = [];
          try {
            parsedChat = typeof item.chatHistory === 'string' ? JSON.parse(item.chatHistory || '[]') : item.chatHistory || [];
          } catch { parsedChat = []; }
          try {
            parsedMedia = typeof item.mediaUrls === 'string' ? JSON.parse(item.mediaUrls || '[]') : item.mediaUrls || [];
          } catch { parsedMedia = []; }

          return {
            ...item,
            chatHistory: parsedChat,
            mediaUrls: parsedMedia,
          };
        });
        setComplaints(formatted);
      } else {
        setComplaints([]);
      }
    } catch (err) {
      console.error('Failed to load user complaints:', err);
      setComplaints([]);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchComplaints();
  }, [profile.phone]);

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'resolved':
        return (
          <span className="px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest flex items-center gap-1.5 bg-emerald-50 text-emerald-700 border border-emerald-200">
            <CheckCircle2 size={12} className="text-emerald-600" /> Resolved
          </span>
        );
      case 'investigating':
      case 'under_review':
        return (
          <span className="px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest flex items-center gap-1.5 bg-blue-50 text-blue-700 border border-blue-200">
            <Clock size={12} className="text-blue-600" /> Under Review
          </span>
        );
      default:
        return (
          <span className="px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest flex items-center gap-1.5 bg-amber-50 text-amber-700 border border-amber-200">
            <Clock size={12} className="text-amber-600" /> Pending Action
          </span>
        );
    }
  };

  return (
    <motion.div 
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      className="px-6 max-w-2xl mx-auto space-y-6 pb-12"
    >
      {/* Header section */}
      <div className="text-center space-y-2">
        <h2 className="text-2xl font-bold text-white tracking-tight">Track Your Complaints</h2>
        <p className="text-sm text-white font-medium max-w-md mx-auto">
          Viewing all complaints and official resolutions registered under your phone number.
        </p>
      </div>

      {/* Complaints load error */}
      {loadError && (
        <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-2xl p-3 flex items-start gap-2 text-xs font-semibold">
          <AlertCircle size={15} className="text-amber-600 shrink-0 mt-0.5" />
          <span className="flex-1">{loadError}</span>
        </div>
      )}

      {/* Profile Phone Status Card */}
      {profile.phone ? (
        <div className="bg-white rounded-2xl p-4 border border-slate-100 shadow-sm flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center font-bold text-xs shrink-0">
              <Phone size={18} />
            </div>
            <div>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Registered Phone</p>
              <h4 className="text-sm font-bold text-slate-800">{profile.phone} {profile.name ? `(${profile.name})` : ''}</h4>
            </div>
          </div>

          <button
            onClick={fetchComplaints}
            disabled={isLoading}
            className="p-2.5 text-indigo-600 hover:bg-indigo-50 rounded-xl transition-colors active:scale-95 disabled:opacity-50 flex items-center gap-1 text-xs font-semibold"
            title="Refresh Complaints"
          >
            <RefreshCw className={isLoading ? "animate-spin" : ""} size={16} />
            <span className="hidden sm:inline">Refresh</span>
          </button>
        </div>
      ) : (
        <div className="bg-amber-50 border border-amber-200 rounded-3xl p-6 text-center space-y-3">
          <ShieldAlert className="w-10 h-10 text-amber-600 mx-auto" />
          <div>
            <h3 className="font-bold text-amber-900 text-sm">Phone Number Required</h3>
            <p className="text-xs text-amber-700 mt-1 max-w-sm mx-auto">
              Please provide your phone number in your profile so we can display your submitted complaints and official admin replies.
            </p>
          </div>
          {onOpenProfile && (
            <button
              onClick={onOpenProfile}
              className="px-5 py-2.5 bg-amber-600 hover:bg-amber-700 text-white rounded-xl text-xs font-bold uppercase tracking-wider shadow-sm transition-colors"
            >
              Set Phone in Profile
            </button>
          )}
        </div>
      )}

      {/* Complaints List */}
      <div className="space-y-4 pt-1">
        {isLoading ? (
          <div className="text-center py-16 bg-white rounded-3xl border border-slate-100 shadow-sm">
            <RefreshCw className="animate-spin text-indigo-600 mx-auto mb-3" size={28} />
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Loading your complaints...</p>
          </div>
        ) : complaints.length > 0 ? (
          complaints.map((item) => {
            const isExpanded = expandedId === item.id;
            const history = Array.isArray(item.chatHistory) ? item.chatHistory : [];
            const media = Array.isArray(item.mediaUrls) ? item.mediaUrls : [];

            return (
              <motion.div
                key={item.id}
                layout
                className="bg-white rounded-3xl border border-slate-100 shadow-sm p-6 space-y-4 hover:shadow-md transition-shadow"
              >
                {/* Top status & date header */}
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    {getStatusBadge(item.status)}
                    <span className="text-[10px] font-mono font-bold text-slate-400">
                      #{item.id.slice(-6)}
                    </span>
                  </div>

                  <span className="text-[10px] font-bold text-slate-400">
                    {new Date(item.createdAt).toLocaleDateString()} {new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>

                {/* Complaint Summary */}
                <div className="space-y-1">
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-wider">Reported Issue & Case Dossier</p>
                  {item.query && (item.query.includes('# ') || item.query.includes('### ') || item.query.includes('| Parameter |') || item.query.includes('|---')) ? (
                    <div className="p-4 bg-slate-50/80 rounded-2xl border border-slate-200">
                      <RenderedMarkdown content={item.query} />
                    </div>
                  ) : (
                    <p className="text-sm font-semibold text-slate-800 leading-relaxed bg-slate-50 p-4 rounded-2xl border border-slate-100">
                      "{item.query}"
                    </p>
                  )}
                </div>

                {/* Official Admin Reply Banner if present */}
                {item.adminReply && (
                  <div className="bg-gradient-to-r from-emerald-50 to-teal-50 border border-emerald-200/80 rounded-2xl p-4.5 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5 text-emerald-800 font-bold text-xs uppercase tracking-wider">
                        <MessageCircle size={15} className="text-emerald-600" />
                        <span>Official Support Response</span>
                      </div>
                      {item.adminReplyAt && (
                        <span className="text-[10px] text-emerald-700 font-semibold">
                          {new Date(item.adminReplyAt).toLocaleDateString()} {new Date(item.adminReplyAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-emerald-950 font-medium leading-relaxed whitespace-pre-wrap bg-white/80 p-3 rounded-xl border border-emerald-100">
                      {item.adminReply}
                    </p>
                  </div>
                )}

                {/* Audio Recording if available */}
                {item.audioUrl && (
                  <div className="space-y-1.5 bg-indigo-50/50 p-4 rounded-2xl border border-indigo-100">
                    <div className="flex items-center gap-2 text-indigo-700 text-xs font-bold uppercase tracking-wider">
                      <Volume2 size={14} /> Voice Recording Attached
                    </div>
                    <audio src={item.audioUrl} controls className="w-full h-9 rounded-lg" />
                  </div>
                )}

                {/* Uploaded Media Previews if any */}
                {media.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1">
                      <Image size={12} /> Attached Evidence ({media.length})
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {media.map((url, idx) => (
                        <a
                          key={idx}
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="group relative w-16 h-16 rounded-xl overflow-hidden border border-slate-200 shadow-sm bg-slate-100 flex items-center justify-center hover:ring-2 hover:ring-indigo-500 transition-all"
                        >
                          {url.endsWith('.pdf') ? (
                            <FileText className="text-rose-500" size={24} />
                          ) : (
                            <img src={url} alt="Attachment" className="w-full h-full object-cover group-hover:scale-105 transition-transform" />
                          )}
                        </a>
                      ))}
                    </div>
                  </div>
                )}

                {/* Accordion Toggle for Transcript */}
                {history.length > 0 && (
                  <div className="border-t border-slate-100 pt-3">
                    <button
                      onClick={() => setExpandedId(isExpanded ? null : item.id)}
                      className="w-full flex items-center justify-between text-xs font-bold text-indigo-600 hover:text-indigo-700 py-1"
                    >
                      <span className="flex items-center gap-1.5">
                        <MessageSquare size={14} /> 
                        {isExpanded ? 'Hide Conversation History' : `View Assistant Transcript (${history.length} messages)`}
                      </span>
                      {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                    </button>

                    <AnimatePresence>
                      {isExpanded && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          exit={{ opacity: 0, height: 0 }}
                          className="space-y-3 pt-3 overflow-hidden"
                        >
                          <div className="max-h-60 overflow-y-auto space-y-2.5 pr-2 custom-scrollbar bg-slate-50/80 p-3 rounded-2xl border border-slate-100">
                            {history.map((msg, i) => (
                              <div
                                key={i}
                                className={`flex flex-col ${msg.sender === 'user' ? 'items-end' : 'items-start'}`}
                              >
                                <div
                                  className={`p-3 rounded-2xl text-xs max-w-[85%] font-medium ${
                                    msg.sender === 'user'
                                      ? 'bg-indigo-600 text-white shadow-sm'
                                      : 'bg-white text-slate-800 border border-slate-200 shadow-sm'
                                  }`}
                                >
                                  {msg.text}
                                </div>
                                <span className="text-[9px] font-bold text-slate-400 mt-1 uppercase tracking-wider">
                                  {msg.sender === 'user' ? 'You' : 'Assistant'} • {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                </span>
                              </div>
                            ))}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )}
              </motion.div>
            );
          })
        ) : profile.phone ? (
          <div className="text-center py-16 bg-white rounded-3xl border border-slate-100 shadow-sm px-6">
            <AlertCircle size={36} className="mx-auto text-slate-300 mb-3" />
            <h3 className="text-base font-bold text-slate-700 mb-1">No Complaints on Record</h3>
            <p className="text-xs text-slate-400 max-w-sm mx-auto">
              You do not have any registered complaints under <span className="font-semibold text-slate-600">{profile.phone}</span>.
              Use the Talk tab if you ever need to voice an issue with food or service.
            </p>
          </div>
        ) : null}
      </div>
    </motion.div>
  );
}
