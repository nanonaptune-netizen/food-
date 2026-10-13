import React, { useState, useEffect, useRef } from 'react';
import { 
  Upload, Trash2, Loader2, Database, Search, FileText, Image as ImageIcon, 
  Eye, Copy, Check, Plus, AlertCircle, Sparkles, X, BookOpen, RefreshCw,
  HelpCircle, CheckCircle2, ShieldAlert, ArrowRight, CornerDownRight, CheckSquare, Square
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { KBDocument } from '../types';
import { adminFetch } from '../lib/adminAuth';

interface AiEraseResult {
  matchingDocIds: string[];
  explanation: string;
  matchedDetails: {
    id: string;
    name: string;
    reason: string;
  }[];
}

export default function UploadData() {
  const [files, setFiles] = useState<KBDocument[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string>('');
  const [selectedDoc, setSelectedDoc] = useState<KBDocument | null>(null);
  const [copied, setCopied] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successToast, setSuccessToast] = useState<string | null>(null);
  const [isAddingManual, setIsAddingManual] = useState(false);
  const [manualTitle, setManualTitle] = useState('');
  const [manualContent, setManualContent] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [isLoadingDocs, setIsLoadingDocs] = useState(false);

  // AI Erase State
  const [isAiEraseOpen, setIsAiEraseOpen] = useState(false);
  const [aiErasePrompt, setAiErasePrompt] = useState('');
  const [isEvaluatingErase, setIsEvaluatingErase] = useState(false);
  const [eraseAnalysis, setEraseAnalysis] = useState<AiEraseResult | null>(null);
  const [selectedForErase, setSelectedForErase] = useState<string[]>([]);
  const [isDeletingBatch, setIsDeletingBatch] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchKnowledge = async () => {
    setIsLoadingDocs(true);
    try {
      const res = await adminFetch('/api/knowledge');
      const data = await res.json();
      if (Array.isArray(data)) {
        setFiles(data);
      }
    } catch (err: any) {
      console.error('Error fetching knowledge from Turso:', err);
    } finally {
      setIsLoadingDocs(false);
    }
  };

  useEffect(() => {
    fetchKnowledge();
  }, []);

  const processFile = async (file: File) => {
    setIsUploading(true);
    setErrorMessage(null);
    const isPdf = file.type.includes('pdf') || file.name.toLowerCase().endsWith('.pdf');
    const isImage = file.type.includes('image') || /\.(jpe?g|png|webp|gif|bmp|heic)$/i.test(file.name);

    if (isPdf) {
      setUploadStatus('Scanning PDF pages and extracting text...');
    } else if (isImage) {
      setUploadStatus('Running OCR text recognition on image...');
    } else {
      setUploadStatus('Processing document content...');
    }

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await adminFetch('/api/process-document', { method: 'POST', body: formData });
      const data = await res.json();
      
      if (!res.ok || data.error) {
        throw new Error(data.error || 'Failed to process document');
      }

      setUploadStatus('Saving recognized knowledge to Turso database...');

      const detectedType = isPdf ? 'pdf' : isImage ? 'image' : 'text';
      const docId = Date.now().toString();

      await adminFetch('/api/knowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: docId,
          name: data.sourceName || file.name,
          content: data.content,
          type: detectedType,
          createdAt: Date.now(),
        }),
      });

      await fetchKnowledge();

      setSuccessToast(`Successfully uploaded and recognized "${data.sourceName || file.name}"`);
      setTimeout(() => setSuccessToast(null), 3500);
      setUploadStatus('');
    } catch (error: any) {
      console.error('OCR Extraction error:', error);
      setErrorMessage(error?.message || 'Error recognizing content from file');
    } finally {
      setIsUploading(false);
      setUploadStatus('');
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) processFile(file);
  };

  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualTitle.trim() || !manualContent.trim()) return;

    try {
      const docId = Date.now().toString();
      await adminFetch('/api/knowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: docId,
          name: manualTitle.trim(),
          content: manualContent.trim(),
          type: 'text',
          createdAt: Date.now(),
        }),
      });

      await fetchKnowledge();
      setManualTitle('');
      setManualContent('');
      setIsAddingManual(false);
      setSuccessToast(`Added "${manualTitle.trim()}" to Turso knowledge base.`);
      setTimeout(() => setSuccessToast(null), 3500);
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to add manual knowledge');
    }
  };

  const deleteDocument = async (id: string) => {
    try {
      await adminFetch(`/api/knowledge/${id}`, { method: 'DELETE' });

      if (selectedDoc?.id === id) {
        setSelectedDoc(null);
      }
      setFiles(prev => prev.filter(f => f.id !== id));
      setSuccessToast('Document deleted successfully from Turso.');
      setTimeout(() => setSuccessToast(null), 3000);
    } catch (err) {
      console.error('Delete error', err);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // AI Erase Evaluation
  const handleEvaluateAiErase = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!aiErasePrompt.trim()) return;
    if (files.length === 0) {
      setErrorMessage('No documents exist in the database to erase.');
      return;
    }

    setIsEvaluatingErase(true);
    setErrorMessage(null);
    try {
      const res = await adminFetch('/api/admin/ai-eval-erase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: aiErasePrompt.trim(),
          documents: files.map(f => ({
            id: f.id,
            name: f.name,
            content: f.content,
            type: f.type,
            createdAt: f.createdAt,
          })),
        }),
      });

      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || 'Failed to evaluate AI erase');
      }

      setEraseAnalysis(data);
      setSelectedForErase(data.matchingDocIds || []);
    } catch (err: any) {
      console.error('AI Erase evaluation error:', err);
      setErrorMessage(err.message || 'Failed to analyze documents with AI.');
    } finally {
      setIsEvaluatingErase(false);
    }
  };

  // Confirm and Execute AI Erase
  const handleExecuteAiErase = async () => {
    if (selectedForErase.length === 0) return;
    setIsDeletingBatch(true);
    try {
      // Sync deletion to Turso
      await adminFetch('/api/knowledge/batch-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selectedForErase }),
      });

      setFiles(prev => prev.filter(f => !selectedForErase.includes(f.id)));
      setSuccessToast(`AI successfully removed ${selectedForErase.length} document(s) from database.`);
      setTimeout(() => setSuccessToast(null), 4000);
      setIsAiEraseOpen(false);
      setEraseAnalysis(null);
      setAiErasePrompt('');
      setSelectedForErase([]);
    } catch (err: any) {
      console.error('Error executing batch erase:', err);
      setErrorMessage(err.message || 'Error erasing selected documents.');
    } finally {
      setIsDeletingBatch(false);
    }
  };

  const toggleSelectForErase = (id: string) => {
    setSelectedForErase(prev => 
      prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]
    );
  };

  const toggleSelectAll = () => {
    if (!eraseAnalysis) return;
    if (selectedForErase.length === eraseAnalysis.matchingDocIds.length) {
      setSelectedForErase([]);
    } else {
      setSelectedForErase([...eraseAnalysis.matchingDocIds]);
    }
  };

  const promptSuggestions = [
    "Delete outdated hygiene directives",
    "Remove files uploaded more than 7 days ago",
    "Clear old inspection checklists",
    "Clear all regulatory knowledge base entries (Wipe database)"
  ];

  const filteredFiles = files.filter(f => 
    f.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
    (f.content && f.content.toLowerCase().includes(searchQuery.toLowerCase()))
  );

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

      {/* Header Banner */}
      <div className="bg-gradient-to-r from-indigo-950 via-indigo-900 to-slate-900 text-white rounded-3xl p-6 shadow-sm flex flex-col md:flex-row items-start md:items-center justify-between gap-4 border border-indigo-800/40">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Sparkles size={18} className="text-indigo-300" />
            <h2 className="text-lg font-bold">Multimodal Knowledge Base</h2>
          </div>
          <p className="text-xs text-indigo-200/90 leading-relaxed max-w-xl">
            Upload FSSAI directives, food safety guidelines, hygiene standards, or inspection circulars. OCR extracts regulations to train your Food Safety Assistant.
          </p>
        </div>

        <div className="flex items-center gap-2 w-full md:w-auto shrink-0">
          {/* AI Erase Trigger Button in Header */}
          <button
            onClick={() => {
              setIsAiEraseOpen(true);
              setEraseAnalysis(null);
            }}
            className="flex-1 md:flex-initial px-4 py-2.5 bg-rose-500/20 hover:bg-rose-500/30 border border-rose-400/40 text-rose-200 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-all shadow-sm active:scale-95 whitespace-nowrap"
            title="Erase Database with AI Prompt"
          >
            <Trash2 size={15} className="text-rose-300" />
            <span>AI Smart Erase</span>
          </button>

          <button
            onClick={() => setIsAddingManual(true)}
            className="flex-1 md:flex-initial px-4 py-2.5 bg-white/10 hover:bg-white/20 border border-white/20 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap"
          >
            <Plus size={15} /> Add Custom Text
          </button>
        </div>
      </div>

      {/* Error Alert */}
      {errorMessage && (
        <div className="p-4 bg-red-50 border border-red-200 text-red-700 rounded-2xl flex items-start justify-between gap-2 text-xs">
          <div className="flex items-center gap-2">
            <AlertCircle size={16} className="text-red-500 shrink-0" />
            <span>{errorMessage}</span>
          </div>
          <button onClick={() => setErrorMessage(null)} className="text-red-400 hover:text-red-600">
            <X size={14} />
          </button>
        </div>
      )}

      {/* Upload Drop Zone */}
      <div 
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        onClick={() => !isUploading && fileInputRef.current?.click()}
        className={`bg-white border-2 border-dashed rounded-3xl p-8 text-center transition-all cursor-pointer group shadow-sm ${
          isDragging 
            ? 'border-indigo-600 bg-indigo-50/50 scale-[1.01]' 
            : 'border-slate-200 hover:border-indigo-400 hover:bg-indigo-50/20'
        }`}
      >
        <input 
          type="file" 
          ref={fileInputRef} 
          className="hidden" 
          onChange={handleFileUpload} 
          accept=".pdf,.txt,.md,.csv,.json,image/*" 
        />

        <div className="w-14 h-14 bg-indigo-50 text-indigo-600 rounded-2xl flex items-center justify-center mx-auto mb-3 group-hover:scale-110 transition-transform">
          {isUploading ? (
            <Loader2 className="animate-spin w-6 h-6 text-indigo-600" />
          ) : (
            <Upload className="w-6 h-6" />
          )}
        </div>

        <h3 className="text-base font-bold text-slate-800 mb-1">
          {isUploading ? (uploadStatus || "Recognizing text with AI...") : "Upload Document or Image"}
        </h3>
        
        <p className="text-slate-400 text-xs font-medium">
          Drag & drop or click to upload PDF regulations, FSSAI circulars, hygiene guidelines, or inspection photos
        </p>

        <div className="mt-3 flex items-center justify-center gap-2">
          <span className="px-2.5 py-1 bg-slate-100 text-slate-600 rounded-lg text-[10px] font-semibold uppercase tracking-wider">
            PDF Documents
          </span>
          <span className="px-2.5 py-1 bg-slate-100 text-slate-600 rounded-lg text-[10px] font-semibold uppercase tracking-wider">
            Images (JPG/PNG/WEBP)
          </span>
          <span className="px-2.5 py-1 bg-slate-100 text-slate-600 rounded-lg text-[10px] font-semibold uppercase tracking-wider">
            Text / CSV
          </span>
        </div>
      </div>

      {/* Manual Document Modal */}
      <AnimatePresence>
        {isAddingManual && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          >
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white rounded-3xl shadow-xl w-full max-w-lg overflow-hidden border border-slate-100"
            >
              <div className="p-5 border-b border-slate-100 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <BookOpen size={18} className="text-indigo-600" />
                  <h3 className="font-bold text-slate-900 text-sm">Add Knowledge Entry</h3>
                </div>
                <button 
                  onClick={() => setIsAddingManual(false)}
                  className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
                >
                  <X size={18} />
                </button>
              </div>

              <form onSubmit={handleManualSubmit} className="p-6 space-y-4">
                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">Entry Title / Subject</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Weekend Specials, Return Policy, Allergy Notice"
                    value={manualTitle}
                    onChange={(e) => setManualTitle(e.target.value)}
                    className="w-full p-3 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 font-medium"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">Content & Details</label>
                  <textarea
                    required
                    rows={6}
                    placeholder="Paste food items, prices, opening hours, or support guidance here..."
                    value={manualContent}
                    onChange={(e) => setManualContent(e.target.value)}
                    className="w-full p-3 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 font-medium leading-relaxed"
                  />
                </div>

                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setIsAddingManual(false)}
                    className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-xl transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-5 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-xl shadow-sm transition-colors"
                  >
                    Save Entry
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* AI DATABASE ERASE POPUP SCREEN / MODAL */}
      <AnimatePresence>
        {isAiEraseOpen && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          >
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden border border-slate-100"
            >
              {/* Modal Header */}
              <div className="p-5 border-b border-slate-100 flex items-center justify-between bg-gradient-to-r from-rose-50 via-orange-50/50 to-white">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-2xl bg-rose-600 text-white flex items-center justify-center font-bold text-xs shadow-md shadow-rose-200">
                    <Trash2 size={20} />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-bold text-slate-900 text-sm">AI Database Smart Erase</h3>
                      <span className="text-[10px] font-bold text-rose-700 bg-rose-100/80 px-2 py-0.5 rounded-full flex items-center gap-1">
                        <Sparkles size={11} /> AI Engine
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-500 font-medium">
                      Type a natural language prompt to selectively or completely erase database records.
                    </p>
                  </div>
                </div>

                <button 
                  onClick={() => setIsAiEraseOpen(false)}
                  className="p-2 text-slate-400 hover:text-slate-600 rounded-xl"
                >
                  <X size={18} />
                </button>
              </div>

              {/* Modal Body */}
              <div className="p-6 overflow-y-auto flex-1 space-y-5 custom-scrollbar bg-white">
                {/* Information Card */}
                <div className="bg-amber-50/80 border border-amber-200/80 rounded-2xl p-4 flex items-start gap-3">
                  <ShieldAlert size={18} className="text-amber-600 shrink-0 mt-0.5" />
                  <div className="text-xs text-amber-900 space-y-1">
                    <p className="font-bold">How AI Database Cleanse Works:</p>
                    <p className="text-amber-800 text-[11px] leading-relaxed">
                      Describe the items, menu categories, or outdated data you want to remove. The AI scans the titles, contents, and timestamps of all {files.length} knowledge base records, shows you the matching items with clear reasons, and lets you confirm before permanent deletion.
                    </p>
                  </div>
                </div>

                {/* Prompt Suggestions */}
                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">
                    Quick Prompt Ideas
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {promptSuggestions.map((suggestion, idx) => (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => {
                          setAiErasePrompt(suggestion);
                          setEraseAnalysis(null);
                        }}
                        className="text-[11px] font-medium bg-slate-50 hover:bg-rose-50 hover:text-rose-700 hover:border-rose-200 text-slate-700 px-3 py-1.5 rounded-xl border border-slate-200 transition-colors"
                      >
                        + {suggestion}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Prompt Text Input Form */}
                <form onSubmit={handleEvaluateAiErase} className="space-y-3">
                  <div className="space-y-1">
                    <label className="text-xs font-bold text-slate-700 uppercase tracking-wider flex items-center justify-between">
                      <span>Enter Erase Instruction / Prompt</span>
                      <span className="text-[10px] text-slate-400 font-normal">{files.length} documents in database</span>
                    </label>
                    <textarea
                      required
                      rows={3}
                      value={aiErasePrompt}
                      onChange={(e) => {
                        setAiErasePrompt(e.target.value);
                        setEraseAnalysis(null);
                      }}
                      placeholder="e.g., 'Delete outdated circulars uploaded last week', 'Erase old inspection guidelines', or 'Remove draft directives'..."
                      className="w-full p-3.5 text-xs bg-slate-50 border border-slate-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-rose-500/20 focus:border-rose-500 font-medium leading-relaxed"
                    />
                  </div>

                  <div className="flex justify-end">
                    <button
                      type="submit"
                      disabled={isEvaluatingErase || !aiErasePrompt.trim() || files.length === 0}
                      className="px-5 py-2.5 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-xs font-bold uppercase tracking-wider shadow-md shadow-rose-100 transition-all flex items-center gap-1.5 active:scale-95 disabled:opacity-50"
                    >
                      {isEvaluatingErase ? (
                        <Loader2 className="animate-spin" size={14} />
                      ) : (
                        <Sparkles size={14} />
                      )}
                      <span>{isEvaluatingErase ? "Analyzing Database with AI..." : "Analyze with AI"}</span>
                    </button>
                  </div>
                </form>

                {/* AI Evaluation Results & Dry-Run Preview */}
                {eraseAnalysis && (
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="space-y-4 pt-3 border-t border-slate-100"
                  >
                    {/* AI Explanation Callout */}
                    <div className="p-4 bg-gradient-to-r from-rose-50 to-orange-50 border border-rose-200 rounded-2xl space-y-1.5">
                      <div className="flex items-center gap-1.5 text-rose-800 font-bold text-xs uppercase tracking-wider">
                        <Sparkles size={14} className="text-rose-600" />
                        <span>AI Analysis Summary</span>
                      </div>
                      <p className="text-xs text-rose-950 font-medium leading-relaxed">
                        {eraseAnalysis.explanation}
                      </p>
                    </div>

                    {/* Matched Documents List */}
                    {eraseAnalysis.matchingDocIds.length > 0 ? (
                      <div className="space-y-2.5">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                            Matched Documents to Erase ({eraseAnalysis.matchingDocIds.length})
                          </span>
                          <button
                            type="button"
                            onClick={toggleSelectAll}
                            className="text-[11px] font-bold text-rose-600 hover:text-rose-700"
                          >
                            {selectedForErase.length === eraseAnalysis.matchingDocIds.length ? "Deselect All" : "Select All"}
                          </button>
                        </div>

                        <div className="space-y-2 max-h-52 overflow-y-auto pr-1 custom-scrollbar">
                          {eraseAnalysis.matchingDocIds.map((docId) => {
                            const originalDoc = files.find(f => f.id === docId);
                            const matchDetail = eraseAnalysis.matchedDetails?.find(m => m.id === docId);
                            const isSelected = selectedForErase.includes(docId);

                            return (
                              <div
                                key={docId}
                                onClick={() => toggleSelectForErase(docId)}
                                className={`p-3.5 rounded-2xl border transition-all cursor-pointer flex items-start gap-3 ${
                                  isSelected 
                                    ? 'bg-rose-50/70 border-rose-300 shadow-sm' 
                                    : 'bg-white border-slate-200 opacity-60 hover:opacity-100'
                                }`}
                              >
                                <div className="mt-0.5 text-rose-600">
                                  {isSelected ? <CheckSquare size={17} /> : <Square size={17} className="text-slate-300" />}
                                </div>

                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center justify-between gap-2">
                                    <h4 className="font-bold text-slate-900 text-xs truncate">
                                      {originalDoc?.name || matchDetail?.name || 'Document'}
                                    </h4>
                                    <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 shrink-0">
                                      {originalDoc?.type || 'doc'}
                                    </span>
                                  </div>

                                  {matchDetail?.reason && (
                                    <p className="text-[11px] text-rose-800 font-medium mt-1 leading-snug">
                                      <span className="font-bold">Match Reason:</span> {matchDetail.reason}
                                    </p>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        {/* Confirmation Bar */}
                        <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-3 mt-4">
                          <div className="text-xs text-slate-600 font-medium text-center sm:text-left">
                            <span className="font-bold text-slate-900">{selectedForErase.length}</span> of <span className="font-bold text-slate-900">{eraseAnalysis.matchingDocIds.length}</span> items selected for permanent deletion.
                          </div>

                          <div className="flex items-center gap-2 w-full sm:w-auto">
                            <button
                              type="button"
                              onClick={() => {
                                setEraseAnalysis(null);
                                setAiErasePrompt('');
                              }}
                              className="flex-1 sm:flex-initial px-4 py-2 bg-white border border-slate-200 text-slate-600 hover:bg-slate-100 rounded-xl text-xs font-bold"
                            >
                              Reset
                            </button>
                            <button
                              type="button"
                              onClick={handleExecuteAiErase}
                              disabled={isDeletingBatch || selectedForErase.length === 0}
                              className="flex-1 sm:flex-initial px-5 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-xs font-bold uppercase tracking-wider shadow-md shadow-rose-100 flex items-center justify-center gap-1.5 active:scale-95 disabled:opacity-50"
                            >
                              {isDeletingBatch ? (
                                <Loader2 className="animate-spin" size={14} />
                              ) : (
                                <Trash2 size={14} />
                              )}
                              <span>{isDeletingBatch ? "Erasing Data..." : `Confirm & Erase (${selectedForErase.length})`}</span>
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="p-6 bg-slate-50 rounded-2xl border border-slate-200 text-center space-y-1">
                        <p className="font-bold text-slate-700 text-xs">No Matching Documents Found</p>
                        <p className="text-slate-400 text-[11px]">
                          Try adjusting your prompt keywords or criteria (e.g. mention specific dish names or file dates).
                        </p>
                      </div>
                    )}
                  </motion.div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Document Content View Modal */}
      <AnimatePresence>
        {selectedDoc && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          >
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white rounded-3xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden border border-slate-100"
            >
              <div className="p-5 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
                <div className="flex items-center gap-3">
                  <div className={`w-8 h-8 rounded-xl flex items-center justify-center font-bold text-[10px] uppercase ${
                    selectedDoc.type === 'pdf' ? 'bg-red-50 text-red-600' :
                    selectedDoc.type === 'image' ? 'bg-purple-50 text-purple-600' :
                    'bg-blue-50 text-blue-600'
                  }`}>
                    {selectedDoc.type === 'pdf' ? <FileText size={16} /> :
                     selectedDoc.type === 'image' ? <ImageIcon size={16} /> :
                     <FileText size={16} />}
                  </div>
                  <div>
                    <h3 className="font-bold text-slate-900 text-sm truncate max-w-sm">{selectedDoc.name}</h3>
                    <p className="text-[10px] text-slate-400">
                      Added on {new Date(selectedDoc.createdAt).toLocaleString()} · {selectedDoc.content?.length || 0} characters
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button 
                    onClick={() => copyToClipboard(selectedDoc.content || '')}
                    className="px-3 py-1.5 bg-white border border-slate-200 hover:bg-slate-50 rounded-xl text-xs font-semibold text-slate-700 flex items-center gap-1.5 transition-colors shadow-sm"
                  >
                    {copied ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} />}
                    {copied ? 'Copied' : 'Copy Text'}
                  </button>
                  <button 
                    onClick={() => setSelectedDoc(null)}
                    className="text-slate-400 hover:text-slate-600 p-1.5 rounded-lg"
                  >
                    <X size={18} />
                  </button>
                </div>
              </div>

              <div className="p-6 overflow-y-auto flex-1 bg-white">
                <div className="bg-slate-50 border border-slate-100 rounded-2xl p-5 text-slate-800 text-xs leading-relaxed whitespace-pre-wrap font-mono select-text">
                  {selectedDoc.content || "No text content found."}
                </div>
              </div>

              <div className="p-4 border-t border-slate-100 bg-slate-50 flex items-center justify-between text-xs text-slate-500">
                <span>Recognized by Multimodal OCR Engine</span>
                <button
                  onClick={() => deleteDocument(selectedDoc.id)}
                  className="text-red-600 hover:text-red-700 font-semibold flex items-center gap-1"
                >
                  <Trash2 size={14} /> Delete Entry
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Library Section */}
      <div className="space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Database size={16} className="text-indigo-600" />
            <h3 className="text-xs font-bold text-slate-600 uppercase tracking-widest">
              Active Knowledge Base ({files.length})
            </h3>
          </div>

          <div className="flex items-center gap-2">
            <div className="relative flex-1 sm:flex-initial">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                placeholder="Search recognized documents..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-8 pr-3 py-1.5 text-xs bg-white border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 w-full sm:w-60"
              />
            </div>

            {/* Quick Action AI Erase Trash Icon beside search */}
            <button
              onClick={() => {
                setIsAiEraseOpen(true);
                setEraseAnalysis(null);
              }}
              className="p-2 bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200 rounded-xl transition-all active:scale-95 shadow-sm flex items-center gap-1 text-xs font-bold shrink-0"
              title="AI Intelligent Erase by Prompt"
            >
              <Trash2 size={15} />
              <span className="hidden sm:inline">AI Erase</span>
            </button>
          </div>
        </div>

        {/* Files Grid */}
        <div className="grid grid-cols-1 gap-3">
          <AnimatePresence mode="popLayout">
            {filteredFiles.map((file) => (
              <motion.div
                key={file.id}
                layout
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                onClick={() => setSelectedDoc(file)}
                className="bg-white p-4 rounded-2xl border border-slate-100 flex items-center justify-between shadow-sm hover:shadow-md hover:border-indigo-100 transition-all cursor-pointer group"
              >
                <div className="flex items-center gap-3.5 min-w-0">
                  <div className={`w-11 h-11 rounded-2xl flex items-center justify-center font-bold text-xs shrink-0 ${
                    file.type === 'pdf' ? 'bg-red-50 text-red-600 border border-red-100' :
                    file.type === 'image' ? 'bg-purple-50 text-purple-600 border border-purple-100' :
                    'bg-indigo-50 text-indigo-600 border border-indigo-100'
                  }`}>
                    {file.type === 'pdf' ? <FileText size={18} /> :
                     file.type === 'image' ? <ImageIcon size={18} /> :
                     <FileText size={18} />}
                  </div>

                  <div className="min-w-0">
                    <h4 className="font-bold text-slate-800 text-sm truncate group-hover:text-indigo-600 transition-colors">
                      {file.name}
                    </h4>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[10px] text-slate-400 font-semibold">
                        {new Date(file.createdAt).toLocaleDateString()}
                      </span>
                      <span className="text-[10px] text-slate-300">•</span>
                      <span className="text-[10px] text-slate-500 font-medium">
                        {file.content?.length ? `${file.content.length} chars recognized` : 'Empty'}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <button 
                    onClick={(e) => { e.stopPropagation(); setSelectedDoc(file); }}
                    className="p-2 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-xl transition-colors"
                    title="View Recognized Text"
                  >
                    <Eye size={16} />
                  </button>
                  <button 
                    onClick={(e) => { e.stopPropagation(); deleteDocument(file.id); }}
                    className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-xl transition-colors"
                    title="Delete"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        {filteredFiles.length === 0 && files.length > 0 && (
          <div className="text-center py-12 bg-white rounded-3xl border border-slate-100">
            <p className="text-slate-400 text-xs font-semibold">No documents matching "{searchQuery}"</p>
          </div>
        )}

        {files.length === 0 && !isUploading && (
          <div className="text-center py-16 bg-white rounded-3xl border border-slate-100 border-dashed">
            <Database size={36} className="mx-auto text-slate-300 mb-3" />
            <p className="text-slate-500 font-bold text-xs uppercase tracking-wider mb-1">No Knowledge Sources Yet</p>
            <p className="text-slate-400 text-[11px] max-w-xs mx-auto">
              Upload FSSAI directives, hygiene rules, or inspection guidelines to train your Food Safety Assistant.
            </p>
          </div>
        )}
      </div>
    </motion.div>
  );
}
