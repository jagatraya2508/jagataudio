import React, { useState, useEffect, useRef, useCallback } from 'react';
import * as Tone from 'tone';
import { Upload, Play, Pause, Loader2, Volume2, VolumeX, Music, Settings2, Guitar, Mic2, Drum, Sparkles, RefreshCw, Download, FileText, User, Lock, LogOut, Shield, Trash2, Pencil, Plus, X, Mail, MonitorPlay, Search, ChevronUp, ChevronDown, RotateCcw, Mic, MicOff, KeyRound, Copy, CheckCircle, AlertTriangle, Clock } from 'lucide-react';
import './index.css';

const API_BASE_URL = "http://localhost:8000";

const INSTRUMENTS = [
  { id: 'vocals', label: 'Vokal', icon: Mic2, color: '#ff477e' },
  { id: 'drums', label: 'Drum', icon: Drum, color: '#ff9f1c' },
  { id: 'bass', label: 'Bass', icon: Music, color: '#2ec4b6' },
  { id: 'guitar', label: 'Gitar', icon: Guitar, color: '#3a86ff' },
  { id: 'piano', label: 'Piano', icon: Music, color: '#8338ec' },
  { id: 'other', label: 'Lainnya', icon: Settings2, color: '#9d4edd' }
];

function App() {
  // Tab navigation
  const [activeTab, setActiveTab] = useState('stems'); // 'stems' or 'karaoke'

  const [file, setFile] = useState(null);
  const [status, setStatus] = useState('idle'); // idle, selected, uploading, processing, ready, error
  const [progressText, setProgressText] = useState('');
  const [fileId, setFileId] = useState(null);
  
  // Audio state
  const [isPlaying, setIsPlaying] = useState(false);
  const [players, setPlayers] = useState({});
  const [volumes, setVolumes] = useState({});
  const [mutes, setMutes] = useState({});
  const [pitch, setPitch] = useState(0); // -12 to 12 semitones
  const [tempo, setTempo] = useState(1); // 0.5 to 2.0 playback rate
  const [stemCurrentTime, setStemCurrentTime] = useState(0);
  const [stemDuration, setStemDuration] = useState(0);
  
  // Original audio and progress states
  const [originalUrl, setOriginalUrl] = useState(null);
  const [originalPlaying, setOriginalPlaying] = useState(false);
  const [audioDuration, setAudioDuration] = useState(0);
  const [audioCurrentTime, setAudioCurrentTime] = useState(0);
  const [progress, setProgress] = useState(0);
  const [eta, setEta] = useState('');
  const [isExporting, setIsExporting] = useState(false);
  const [isGeneratingTab, setIsGeneratingTab] = useState(false);

  // Auth State
  const [token, setToken] = useState(localStorage.getItem('token') || null);
  const [username, setUsername] = useState(localStorage.getItem('username') || null);
  const [isAdmin, setIsAdmin] = useState(localStorage.getItem('isAdmin') === 'true');
  const [isLoginMode, setIsLoginMode] = useState(true);
  const [authForm, setAuthForm] = useState({ username: '', email: '', password: '' });
  const [authError, setAuthError] = useState('');
  const [isAuthLoading, setIsAuthLoading] = useState(false);

  // Admin Panel State
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const [userList, setUserList] = useState([]);
  const [editingUser, setEditingUser] = useState(null);
  const [editForm, setEditForm] = useState({ username: '', password: '', is_admin: false });
  const [addForm, setAddForm] = useState({ username: '', password: '', is_admin: false });
  const [showAddForm, setShowAddForm] = useState(false);
  const [adminMsg, setAdminMsg] = useState('');

  // YouTube to MP3 State
  const [yt2mp3Url, setYt2mp3Url] = useState('');
  const [yt2mp3SearchResults, setYt2mp3SearchResults] = useState([]);
  const [yt2mp3IsSearching, setYt2mp3IsSearching] = useState(false);
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const [yt2mp3Status, setYt2mp3Status] = useState('idle'); // idle, preparing, downloading, done, error
  const [yt2mp3Progress, setYt2mp3Progress] = useState(0);
  const [yt2mp3JobId, setYt2mp3JobId] = useState(null);
  const [yt2mp3Error, setYt2mp3Error] = useState('');
  const [yt2mp3Title, setYt2mp3Title] = useState('');

  const [ytUrl, setYtUrl] = useState('');
  const [ytVideoId, setYtVideoId] = useState(null); // internal ID from backend
  const [ytYoutubeId, setYtYoutubeId] = useState(null); // actual YouTube video ID
  const [ytStatus, setYtStatus] = useState('idle'); // idle, preparing, downloading, separating, ready, error
  const [ytTitle, setYtTitle] = useState('');
  const [ytThumbnail, setYtThumbnail] = useState('');
  const [ytDuration, setYtDuration] = useState(0);
  const [ytProgress, setYtProgress] = useState(0);
  const [ytPitch, setYtPitch] = useState(0); // -12 to 12 semitones
  const [ytIsPlaying, setYtIsPlaying] = useState(false);
  const [ytCurrentTime, setYtCurrentTime] = useState(0);
  const [ytAudioDuration, setYtAudioDuration] = useState(0);
  const [ytMode, setYtMode] = useState('quick'); // 'quick' or 'full'
  const [ytKaraokeReady, setYtKaraokeReady] = useState(false);
  const [ytUseKaraoke, setYtUseKaraoke] = useState(false);
  const [ytError, setYtError] = useState('');

  // License State
  const [licenseStatus, setLicenseStatus] = useState('checking'); // 'checking', 'valid', 'invalid'
  const [licenseInfo, setLicenseInfo] = useState(null);
  const [hardwareId, setHardwareId] = useState('');
  const [licenseMessage, setLicenseMessage] = useState('');
  const [licenseMessageType, setLicenseMessageType] = useState(''); // 'success', 'error', 'warning'
  const [isActivating, setIsActivating] = useState(false);
  const [hwidCopied, setHwidCopied] = useState(false);
  // YouTube Audio refs
  const ytAudioRef = useRef(null);
  const ytAudioContextRef = useRef(null);
  const ytSourceNodeRef = useRef(null);
  const ytPitchShifterRef = useRef(null);
  const ytPlayerRef = useRef(null); // YouTube iframe API player
  const ytIframeRef = useRef(null);

  const playersRef = useRef({});
  const volumeNodesRef = useRef({});
  const ytAnimFrameRef = useRef(null);
  const originalAudioRef = useRef(null);

  useEffect(() => {
    return () => {
      Object.values(playersRef.current).forEach(p => p.dispose());
      Object.values(volumeNodesRef.current).forEach(v => v.dispose());
    };
  }, []);

  // Check license on app load
  useEffect(() => {
    checkLicenseStatus();
  }, []);

  const checkLicenseStatus = async () => {
    setLicenseStatus('checking');
    try {
      const res = await fetch(`${API_BASE_URL}/license/status`);
      const data = await res.json();
      
      if (data.licensed) {
        setLicenseStatus('valid');
        setLicenseInfo(data.info);
      } else {
        setLicenseStatus('invalid');
        setLicenseMessage(data.message || 'Lisensi tidak valid');
      }
      
      if (data.hardware_id) {
        setHardwareId(data.hardware_id);
      }
    } catch (e) {
      console.error('License check failed:', e);
      // If backend is not running yet, try again in 2 seconds
      setTimeout(checkLicenseStatus, 2000);
    }
  };

  const handleLicenseActivate = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    if (!file.name.endsWith('.lic')) {
      setLicenseMessage('File harus berformat .lic');
      setLicenseMessageType('error');
      return;
    }
    
    setIsActivating(true);
    setLicenseMessage('');
    
    try {
      const formData = new FormData();
      formData.append('file', file);
      
      const res = await fetch(`${API_BASE_URL}/license/activate`, {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      
      if (res.ok && data.status === 'success') {
        setLicenseMessage(data.message);
        setLicenseMessageType('success');
        setLicenseInfo(data.info);
        // Re-check license after short delay
        setTimeout(() => {
          setLicenseStatus('valid');
        }, 1500);
      } else {
        setLicenseMessage(data.message || 'Aktivasi gagal');
        setLicenseMessageType('error');
      }
    } catch (err) {
      setLicenseMessage('Gagal mengaktifkan lisensi. Pastikan server berjalan.');
      setLicenseMessageType('error');
    } finally {
      setIsActivating(false);
      // Reset file input
      e.target.value = '';
    }
  };

  const copyHardwareId = () => {
    navigator.clipboard.writeText(hardwareId).then(() => {
      setHwidCopied(true);
      setTimeout(() => setHwidCopied(false), 2000);
    });
  };

  const formatLicenseType = (type) => {
    const map = { '3m': '3 Bulan', '6m': '6 Bulan', '1y': '1 Tahun', '3bulan': '3 Bulan', '6bulan': '6 Bulan', '1tahun': '1 Tahun' };
    return map[type] || type;
  };

  const formatDate = (isoDate) => {
    if (!isoDate) return '-';
    return new Date(isoDate).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
  };

  useEffect(() => {
    return () => {
      if (originalUrl) {
        URL.revokeObjectURL(originalUrl);
      }
    };
  }, [originalUrl]);

  useEffect(() => {
    let animationFrameId;
    const updateProgress = () => {
      if (Tone.Transport.state === 'started') {
        const currentTime = Tone.Transport.seconds;
        if (stemDuration > 0 && currentTime >= stemDuration) {
           Tone.Transport.stop();
           setIsPlaying(false);
           Tone.Transport.seconds = 0;
           setStemCurrentTime(0);
        } else {
           setStemCurrentTime(currentTime);
           animationFrameId = requestAnimationFrame(updateProgress);
        }
      }
    };
    if (isPlaying) {
      animationFrameId = requestAnimationFrame(updateProgress);
    }
    return () => cancelAnimationFrame(animationFrameId);
  }, [isPlaying, stemDuration]);

  useEffect(() => {
    let interval;
    if (status === 'processing' && fileId) {
      interval = setInterval(async () => {
        try {
          const res = await fetch(`${API_BASE_URL}/status/${fileId}`);
          const data = await res.json();
          if (data.progress !== undefined) {
            setProgress(data.progress);
          }
          if (data.eta !== undefined) {
            setEta(data.eta);
          }
          if (data.status === 'done') {
            setStatus('loading_audio');
            setProgressText('Memuat file audio ke browser...');
            clearInterval(interval);
            loadAudioStems(fileId);
          } else if (data.status === 'error') {
            setStatus('error');
            setProgressText('Terjadi kesalahan saat memisahkan audio.');
            clearInterval(interval);
          }
        } catch (e) {
          console.error(e);
        }
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [status, fileId]);


  // YouTube to MP3 polling
  useEffect(() => {
    let interval;
    if (yt2mp3Status === 'downloading' && yt2mp3JobId) {
      interval = setInterval(async () => {
        try {
          const res = await fetch(`${API_BASE_URL}/youtube-to-mp3/status/${yt2mp3JobId}`);
          const data = await res.json();
          if (data.progress !== undefined) setYt2mp3Progress(data.progress);
          if (data.title) setYt2mp3Title(data.title);
          
          if (data.status === 'done') {
            setYt2mp3Status('done');
            setYt2mp3Progress(100);
            clearInterval(interval);
          } else if (data.status === 'error') {
            setYt2mp3Status('error');
            setYt2mp3Error(data.error || 'Terjadi kesalahan');
            clearInterval(interval);
          }
        } catch (e) {
          console.error(e);
        }
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [yt2mp3Status, yt2mp3JobId]);
  const handleAuth = async (e) => {
    e.preventDefault();
    setAuthError('');
    setIsAuthLoading(true);
    
    try {
      if (isLoginMode) {
        const formData = new URLSearchParams();
        formData.append('username', authForm.username);
        formData.append('password', authForm.password);
        
        const res = await fetch(`${API_BASE_URL}/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: formData
        });
        const data = await res.json();
        
        if (res.ok) {
          setToken(data.access_token);
          setUsername(authForm.username);
          setIsAdmin(data.is_admin || false);
          localStorage.setItem('token', data.access_token);
          localStorage.setItem('username', authForm.username);
          localStorage.setItem('isAdmin', data.is_admin ? 'true' : 'false');
        } else {
          setAuthError(data.detail || 'Login failed');
        }
      } else {
        const res = await fetch(`${API_BASE_URL}/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(authForm)
        });
        const data = await res.json();
        
        if (res.ok) {
          setIsLoginMode(true);
          setAuthError('Registrasi sukses. Silakan login.');
        } else {
          setAuthError(data.detail || 'Registration failed');
        }
      }
    } catch (err) {
      setAuthError('Terjadi kesalahan jaringan.');
    } finally {
      setIsAuthLoading(false);
    }
  };

  const handleLogout = () => {
    setToken(null);
    setUsername(null);
    setIsAdmin(false);
    setShowAdminPanel(false);
    localStorage.removeItem('token');
    localStorage.removeItem('username');
    localStorage.removeItem('isAdmin');
    setFile(null);
    setStatus('idle');
    if (Tone.Transport.state === 'started') Tone.Transport.stop();
  };

  // Admin functions
  const fetchUsers = async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/admin/users`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setUserList(data);
      }
    } catch (e) { console.error(e); }
  };

  const handleAddUser = async (e) => {
    e.preventDefault();
    setAdminMsg('');
    try {
      const res = await fetch(`${API_BASE_URL}/admin/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(addForm)
      });
      const data = await res.json();
      if (res.ok) {
        setAdminMsg('User berhasil ditambahkan!');
        setAddForm({ username: '', password: '', is_admin: false });
        setShowAddForm(false);
        fetchUsers();
      } else {
        setAdminMsg(data.detail || 'Gagal menambahkan user');
      }
    } catch (e) { setAdminMsg('Kesalahan jaringan'); }
  };

  const handleEditUser = async (userId) => {
    setAdminMsg('');
    const payload = {};
    if (editForm.username) payload.username = editForm.username;
    if (editForm.password) payload.password = editForm.password;
    if (editForm.is_admin !== undefined) payload.is_admin = editForm.is_admin;
    try {
      const res = await fetch(`${API_BASE_URL}/admin/users/${userId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (res.ok) {
        setAdminMsg('User berhasil diperbarui!');
        setEditingUser(null);
        fetchUsers();
      } else {
        setAdminMsg(data.detail || 'Gagal memperbarui user');
      }
    } catch (e) { setAdminMsg('Kesalahan jaringan'); }
  };

  const handleDeleteUser = async (userId, uname) => {
    if (!confirm(`Yakin ingin menghapus user "${uname}"?`)) return;
    setAdminMsg('');
    try {
      const res = await fetch(`${API_BASE_URL}/admin/users/${userId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (res.ok) {
        setAdminMsg('User berhasil dihapus!');
        fetchUsers();
      } else {
        setAdminMsg(data.detail || 'Gagal menghapus user');
      }
    } catch (e) { setAdminMsg('Kesalahan jaringan'); }
  };

  const handleFileSelect = (e) => {
    const selectedFile = e.target.files[0];
    if (!selectedFile) return;
    
    setFile(selectedFile);
    const url = URL.createObjectURL(selectedFile);
    setOriginalUrl(url);
    setStatus('selected');
    setOriginalPlaying(false);
    setAudioCurrentTime(0);
    setAudioDuration(0);
  };

  const startSeparation = async () => {
    if (!file) return;
    
    if (originalAudioRef.current) {
      originalAudioRef.current.pause();
    }
    setOriginalPlaying(false);
    
    setStatus('uploading');
    setProgressText('Mengunggah file...');
    setProgress(0);
    setEta('Menghitung...');
    
    const formData = new FormData();
    formData.append('file', file);
    
    try {
      const uploadRes = await fetch(`${API_BASE_URL}/upload`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData
      });
      const uploadData = await uploadRes.json();
      
      setStatus('processing');
      setProgressText('AI sedang memisahkan instrumen...');
      setFileId(uploadData.file_id);
      
      await fetch(`${API_BASE_URL}/separate/${uploadData.file_id}`, { 
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
    } catch (err) {
      console.error(err);
      setStatus('error');
      setProgressText('Gagal mengunggah file.');
    }
  };

  const generateMasterTab = async () => {
    if (!file) return;
    
    if (originalAudioRef.current) {
      originalAudioRef.current.pause();
    }
    setOriginalPlaying(false);
    
    setStatus('generating_tab');
    setProgressText('AI sedang mendengarkan nada...');
    setProgress(0);
    setEta('Memproses...');
    
    const formData = new FormData();
    formData.append('file', file);
    
    try {
      const uploadRes = await fetch(`${API_BASE_URL}/upload`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData
      });
      const uploadData = await uploadRes.json();
      const currentFileId = uploadData.file_id;
      setFileId(currentFileId);
      
      await fetch(`${API_BASE_URL}/generate_tab_master/${currentFileId}`, { 
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      
      const pollInterval = setInterval(async () => {
        try {
          const res = await fetch(`${API_BASE_URL}/status_tab/${currentFileId}`);
          const data = await res.json();
          
          if (data.progress !== undefined) {
             setProgress(prev => {
                if (data.progress === 100) return 100;
                if (prev < data.progress) return data.progress;
                const next = prev + 1;
                return next > 95 ? 95 : next;
             });
          }
          
          if (data.status === 'done') {
            clearInterval(pollInterval);
            setProgress(100);
            setProgressText('Selesai! Mengunduh tabulatur...');
            
            setTimeout(() => {
                const a = document.createElement('a');
                a.href = `${API_BASE_URL}${data.download_url}`;
                a.download = `${file.name}_tab.txt`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                
                setStatus('selected');
            }, 1500);
          } else if (data.status === 'error') {
            clearInterval(pollInterval);
            setStatus('error');
            setProgressText('Terjadi kesalahan saat membuat tabulatur.');
          }
        } catch (e) {
          console.error(e);
        }
      }, 1000);
      
    } catch (err) {
      console.error(err);
      setStatus('error');
      setProgressText('Gagal membuat tabulatur.');
    }
  };

  const formatTime = (secs) => {
    if (isNaN(secs)) return '00:00';
    const minutes = Math.floor(secs / 60);
    const seconds = Math.floor(secs % 60);
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  };

  const loadAudioStems = async (id) => {
    await Tone.start();
    
    const newPlayers = {};
    const newVolumes = {};
    const initVols = {};
    const initMutes = {};
    
    try {
      // Create a player for each instrument
      const loadPromises = INSTRUMENTS.map(inst => {
        return new Promise((resolve, reject) => {
          const url = `${API_BASE_URL}/audio/${id}/${inst.id}.mp3`;
          
          const volNode = new Tone.Volume(0).toDestination();
          
          const player = new Tone.GrainPlayer({
            url: url,
            onload: () => resolve(),
            onerror: reject
          });
          
          player.connect(volNode);
          player.sync().start(0);
          
          newPlayers[inst.id] = player;
          newVolumes[inst.id] = volNode;
          initVols[inst.id] = 0; // 0 dB
          initMutes[inst.id] = false;
        });
      });
      
      await Promise.all(loadPromises);
      
      playersRef.current = newPlayers;
      volumeNodesRef.current = newVolumes;
      
      setPlayers(newPlayers);
      setVolumes(initVols);
      setMutes(initMutes);
      
      if (newPlayers[INSTRUMENTS[0].id]?.buffer) {
         setStemDuration(newPlayers[INSTRUMENTS[0].id].buffer.duration);
      }
      setStemCurrentTime(0);
      Tone.Transport.seconds = 0;
      
      setStatus('ready');
      setProgressText('');
    } catch (e) {
      console.error(e);
      setStatus('error');
      setProgressText('Gagal memuat audio.');
    }
  };

  const togglePlay = async () => {
    if (Tone.Transport.state !== 'started') {
      await Tone.start();
      Tone.Transport.start();
      setIsPlaying(true);
    } else {
      Tone.Transport.pause();
      setIsPlaying(false);
    }
  };

  const handleVolumeChange = (instId, value) => {
    setVolumes(prev => ({ ...prev, [instId]: value }));
    if (!mutes[instId] && volumeNodesRef.current[instId]) {
      volumeNodesRef.current[instId].volume.value = value;
    }
  };

  const toggleMute = (instId) => {
    setMutes(prev => {
      const isMuted = !prev[instId];
      if (volumeNodesRef.current[instId]) {
        volumeNodesRef.current[instId].mute = isMuted;
      }
      return { ...prev, [instId]: isMuted };
    });
  };

  const handlePitchChange = (e) => {
    const val = parseFloat(e.target.value);
    setPitch(val);
    Object.values(playersRef.current).forEach(p => {
      if (p && p.detune !== undefined) {
        p.detune = val * 100; // 1 semitone = 100 cents
      }
    });
  };

  const handleTempoChange = (e) => {
    const val = parseFloat(e.target.value);
    setTempo(val);
    Object.values(playersRef.current).forEach(p => {
      if (p && p.playbackRate !== undefined) {
        p.playbackRate = val;
      }
    });
  };

  const handleSeekStem = (e) => {
    const newTime = parseFloat(e.target.value);
    setStemCurrentTime(newTime);
    Tone.Transport.seconds = newTime;
  };

  const exportMix = async () => {
    if (!fileId) return;
    setIsExporting(true);
    
    try {
      const response = await fetch(`${API_BASE_URL}/export/${fileId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          volumes: volumes,
          mutes: mutes,
          pitch: pitch,
          tempo: tempo
        })
      });
      
      const data = await response.json();
      if (data.status === 'success' && data.download_url) {
        // Trigger download
        const a = document.createElement('a');
        a.href = `${API_BASE_URL}${data.download_url}`;
        a.download = 'jagat_audio_mix.mp3';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      } else {
        alert("Gagal mengekspor: " + (data.message || "Unknown error"));
      }
    } catch (e) {
      console.error(e);
      alert("Terjadi kesalahan saat mengekspor audio.");
    } finally {
      setIsExporting(false);
    }
  };

  // ============================================
  // YOUTUBE KARAOKE FUNCTIONS
  // ============================================

  const handleYtPrepare = async () => {
    if (!ytUrl.trim()) return;
    setYtStatus('preparing');
    setYtProgress(0);
    setYtError('');
    setYtTitle('');
    setYtThumbnail('');
    setYtKaraokeReady(false);
    setYtUseKaraoke(false);
    
    try {
      const res = await fetch(`${API_BASE_URL}/youtube/prepare`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ url: ytUrl, mode: ytMode })
      });
      const data = await res.json();
      
      if (res.ok) {
        setYtVideoId(data.video_id);
        setYtStatus('downloading');
        // Start polling
        pollYtStatus(data.video_id);
      } else {
        setYtStatus('error');
        setYtError(data.detail || 'Gagal memproses URL');
      }
    } catch (e) {
      setYtStatus('error');
      setYtError('Kesalahan jaringan');
    }
  };

  const pollYtStatus = (videoId) => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/youtube/status/${videoId}`);
        const data = await res.json();
        
        if (data.title) setYtTitle(data.title);
        if (data.thumbnail) setYtThumbnail(data.thumbnail);
        if (data.duration) setYtDuration(data.duration);
        if (data.youtube_id) setYtYoutubeId(data.youtube_id);
        if (data.progress !== undefined) setYtProgress(data.progress);
        
        if (data.status === 'separating') {
          setYtStatus('separating');
        } else if (data.status === 'downloading') {
          setYtStatus('downloading');
        }
        
        if (data.status === 'done') {
          clearInterval(interval);
          setYtStatus('ready');
          setYtProgress(100);
          if (data.karaoke_ready) {
            setYtKaraokeReady(true);
            setYtUseKaraoke(true);
          }
          // Setup audio with pitch shifting
          setupYtAudio(videoId, data.karaoke_ready);
        } else if (data.status === 'error') {
          clearInterval(interval);
          setYtStatus('error');
          setYtError(data.error || 'Terjadi kesalahan');
        }
      } catch (e) {
        console.error(e);
      }
    }, 1000);
  };

  const setupYtAudio = async (videoId, hasKaraoke) => {
    try {
      const audioUrl = `${API_BASE_URL}/youtube/audio/${videoId}${hasKaraoke ? '?karaoke=true' : ''}`;
      
      // Create audio element
      if (ytAudioRef.current) {
        ytAudioRef.current.pause();
        ytAudioRef.current = null;
      }
      
      const audio = new Audio();
      audio.crossOrigin = 'anonymous';
      audio.src = audioUrl;
      audio.preload = 'auto';
      
      // Setup Web Audio API for pitch shifting
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      
      audio.addEventListener('canplaythrough', () => {
        const source = audioContext.createMediaElementSource(audio);
        
        // Simple pitch shift using playback detune
        // We'll use the audio element's playbackRate combined with a compensation
        source.connect(audioContext.destination);
        
        ytAudioRef.current = audio;
        ytAudioContextRef.current = audioContext;
        ytSourceNodeRef.current = source;
        
        setYtAudioDuration(audio.duration || 0);
      }, { once: true });

      audio.addEventListener('loadedmetadata', () => {
        setYtAudioDuration(audio.duration || 0);
      });

      audio.addEventListener('ended', () => {
        setYtIsPlaying(false);
        setYtCurrentTime(0);
      });
      
      audio.load();
    } catch (e) {
      console.error('Error setting up YouTube audio:', e);
    }
  };

  const toggleYtPlay = () => {
    if (!ytAudioRef.current) return;
    
    if (ytAudioContextRef.current?.state === 'suspended') {
      ytAudioContextRef.current.resume();
    }
    
    if (ytIsPlaying) {
      ytAudioRef.current.pause();
      setYtIsPlaying(false);
    } else {
      ytAudioRef.current.play();
      setYtIsPlaying(true);
    }
  };

  // Update YouTube audio current time
  useEffect(() => {
    let animId;
    const update = () => {
      if (ytAudioRef.current && ytIsPlaying) {
        setYtCurrentTime(ytAudioRef.current.currentTime);
        animId = requestAnimationFrame(update);
      }
    };
    if (ytIsPlaying) {
      animId = requestAnimationFrame(update);
    }
    return () => cancelAnimationFrame(animId);
  }, [ytIsPlaying]);

  const handleYtSeek = (e) => {
    const newTime = parseFloat(e.target.value);
    setYtCurrentTime(newTime);
    if (ytAudioRef.current) {
      ytAudioRef.current.currentTime = newTime;
    }
  };

  const handleYtPitchChange = (newPitch) => {
    const clamped = Math.max(-12, Math.min(12, newPitch));
    setYtPitch(clamped);
    
    if (ytAudioRef.current) {
      // Use preservesPitch = false with playbackRate to shift pitch
      // Semitone to rate: rate = 2^(semitones/12)
      // But this also changes tempo. To compensate, we'd need a proper pitch shifter.
      // For simplicity, we use the Web Audio API approach:
      // We detune the audio context output.
      // Unfortunately MediaElementSource doesn't support detune directly.
      // Best approach: use playbackRate = 2^(pitch/12) which changes pitch but also tempo.
      // This is the most reliable cross-browser method.
      const rate = Math.pow(2, clamped / 12);
      ytAudioRef.current.preservesPitch = false;
      ytAudioRef.current.playbackRate = rate;
    }
  };

  const switchYtAudioSource = async (useKaraoke) => {
    if (!ytVideoId) return;
    const wasPlaying = ytIsPlaying;
    const currentTime = ytAudioRef.current?.currentTime || 0;
    
    if (ytAudioRef.current) {
      ytAudioRef.current.pause();
    }
    
    setYtUseKaraoke(useKaraoke);
    
    const audioUrl = `${API_BASE_URL}/youtube/audio/${ytVideoId}${useKaraoke ? '?karaoke=true' : ''}`;
    
    if (ytAudioRef.current) {
      ytAudioRef.current.src = audioUrl;
      ytAudioRef.current.load();
      ytAudioRef.current.addEventListener('canplaythrough', () => {
        ytAudioRef.current.currentTime = currentTime;
        // Reapply pitch
        const rate = Math.pow(2, ytPitch / 12);
        ytAudioRef.current.preservesPitch = false;
        ytAudioRef.current.playbackRate = rate;
        if (wasPlaying) {
          ytAudioRef.current.play();
          setYtIsPlaying(true);
        }
      }, { once: true });
    }
  };

  const resetYtKaraoke = () => {
    if (ytAudioRef.current) {
      ytAudioRef.current.pause();
      ytAudioRef.current = null;
    }
    if (ytAudioContextRef.current) {
      ytAudioContextRef.current.close();
      ytAudioContextRef.current = null;
    }
    setYtUrl('');
    setYtVideoId(null);
    setYtYoutubeId(null);
    setYtStatus('idle');
    setYtTitle('');
    setYtThumbnail('');
    setYtDuration(0);
    setYtProgress(0);
    setYtPitch(0);
    setYtIsPlaying(false);
    setYtCurrentTime(0);
    setYtAudioDuration(0);
    setYtKaraokeReady(false);
    setYtUseKaraoke(false);
    setYtError('');
  };

  // ============================================
  // RENDER: LICENSE GATE
  // ============================================

  if (licenseStatus === 'checking') {
    return (
      <div className="app-container">
        <div className="background-glow"></div>
        <header className="header">
          <div><h1>Jagat <span>Audio</span></h1><p>AI Stem Separation & Karaoke</p></div>
        </header>
      {token && !showAdminPanel && (
        <nav className="tab-navigation">
          <button
            className={`tab-btn ${activeTab === 'stems' ? 'active' : ''}`}
            onClick={() => setActiveTab('stems')}
          >
            <Music size={18} /> Stem Separator
          </button>
          <button
            className={`tab-btn ${activeTab === 'yt2mp3' ? 'active' : ''}`}
            onClick={() => setActiveTab('yt2mp3')}
          >
            <Download size={18} /> YouTube to MP3
          </button>
        </nav>
      )}

        <main className="main-content">
          <div className="license-loading">
            <Loader2 size={48} className="spinner" />
            <p>Memeriksa lisensi...</p>
          </div>
        </main>
      </div>
    );
  }

  if (licenseStatus === 'invalid') {
    return (
      <div className="app-container">
        <div className="background-glow"></div>
        <header className="header">
          <div><h1>Jagat <span>Audio</span></h1><p>AI Stem Separation & Karaoke</p></div>
        </header>
      {token && !showAdminPanel && (
        <nav className="tab-navigation">
          <button
            className={`tab-btn ${activeTab === 'stems' ? 'active' : ''}`}
            onClick={() => setActiveTab('stems')}
          >
            <Music size={18} /> Stem Separator
          </button>
          <button
            className={`tab-btn ${activeTab === 'yt2mp3' ? 'active' : ''}`}
            onClick={() => setActiveTab('yt2mp3')}
          >
            <Download size={18} /> YouTube to MP3
          </button>
        </nav>
      )}

        <main className="main-content">
          <div className="license-gate">
            <div className="license-card">
              <div className="license-shield-icon">
                <KeyRound size={36} color="#c4a7ff" />
              </div>
              <h2>Aktivasi Lisensi Diperlukan</h2>
              <p className="license-subtitle">
                Aplikasi ini memerlukan lisensi yang valid untuk digunakan. 
                Hubungi admin untuk mendapatkan file lisensi.
              </p>

              {/* Hardware ID */}
              <div className="hwid-section">
                <div className="hwid-label">
                  <Shield size={14} /> Hardware ID Anda
                </div>
                <div className="hwid-value" onClick={copyHardwareId} title="Klik untuk menyalin">
                  {hardwareId || 'Memuat...'}
                </div>
                <div className={`hwid-copy-hint ${hwidCopied ? 'hwid-copied' : ''}`}>
                  {hwidCopied ? '✓ Tersalin ke clipboard!' : '📋 Klik untuk menyalin Hardware ID'}
                </div>
              </div>

              {/* Upload License */}
              <div className="license-upload-section">
                {isActivating ? (
                  <div className="license-activating">
                    <Loader2 size={20} className="spinner" />
                    <span>Mengaktifkan lisensi...</span>
                  </div>
                ) : (
                  <div className="license-upload-area">
                    <Upload size={32} className="license-upload-icon" />
                    <h4>Upload File Lisensi (.lic)</h4>
                    <p>Seret file atau klik untuk memilih</p>
                    <input
                      type="file"
                      accept=".lic"
                      onChange={handleLicenseActivate}
                    />
                  </div>
                )}
              </div>

              {/* Status Message */}
              {licenseMessage && (
                <div className={`license-message ${licenseMessageType}`}>
                  {licenseMessageType === 'success' && <CheckCircle size={18} />}
                  {licenseMessageType === 'error' && <AlertTriangle size={18} />}
                  {licenseMessageType === 'warning' && <AlertTriangle size={18} />}
                  {licenseMessage}
                </div>
              )}
            </div>

            {/* Instructions */}
            <div className="license-steps">
              <h4>Cara Mendapatkan Lisensi</h4>
              <ol>
                <li>Salin <strong>Hardware ID</strong> di atas (klik untuk copy)</li>
                <li>Kirim Hardware ID ke admin/penjual JagatAudio</li>
                <li>Admin akan membuat file lisensi (<code>.lic</code>) untuk Anda</li>
                <li>Upload file lisensi di area upload di atas</li>
                <li>Aplikasi akan aktif secara otomatis!</li>
              </ol>
            </div>
          </div>
        </main>
      </div>
    );
  }

  // ============================================
  // RENDER: MAIN APP (Licensed)
  // ============================================

  return (
    <div className="app-container">
      <div className="background-glow"></div>
      
      <header className="header">
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem', width: '100%', maxWidth: '1000px' }}>
          {token && (
            <div className="user-profile" style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
              {isAdmin && (
                <button className="admin-btn" onClick={() => { setShowAdminPanel(!showAdminPanel); if (!showAdminPanel) fetchUsers(); }}>
                  <Shield size={16} /> Admin
                </button>
              )}
              <span className="welcome-text">Hai, {username}</span>
              <button className="logout-btn" onClick={handleLogout}>
                <LogOut size={16} /> Keluar
              </button>
            </div>
          )}
          <div>
            <h1>Jagat <span>Audio</span></h1>
            <p>AI Stem Separation & Karaoke</p>
          </div>
        </div>
      </header>

      {/* License Info Bar */}
      {licenseInfo && (
        <div className="license-info-card" style={{ maxWidth: '500px', width: '100%', marginBottom: '1rem', padding: '0.8rem 1.2rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
              <CheckCircle size={16} color="#2ec4b6" />
              <span className="license-active-badge">Lisensi Aktif</span>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                {formatLicenseType(licenseInfo.license_type)}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem' }}>
              <Clock size={14} color={licenseInfo.days_remaining <= 30 ? '#ff9f1c' : '#2ec4b6'} />
              <span style={{ color: licenseInfo.days_remaining <= 30 ? '#ff9f1c' : 'var(--text-secondary)' }}>
                Sisa {licenseInfo.days_remaining} hari • Exp: {formatDate(licenseInfo.expiry_date)}
              </span>
            </div>
          </div>
        </div>
      )}


      {token && !showAdminPanel && (
        <nav className="tab-navigation">
          <button
            className={`tab-btn ${activeTab === 'stems' ? 'active' : ''}`}
            onClick={() => setActiveTab('stems')}
          >
            <Music size={18} /> Stem Separator
          </button>
          <button
            className={`tab-btn ${activeTab === 'yt2mp3' ? 'active' : ''}`}
            onClick={() => setActiveTab('yt2mp3')}
          >
            <Download size={18} /> YouTube to MP3
          </button>
        </nav>
      )}

      <main className="main-content">
        {showAdminPanel && isAdmin ? (
          <div className="admin-panel glass-panel animate-fade-in">
            <div className="admin-panel-header">
              <h2><Shield size={24} /> Manajemen User</h2>
              <button className="close-admin-btn" onClick={() => setShowAdminPanel(false)}><X size={20} /></button>
            </div>
            
            {adminMsg && <div className={`auth-message ${adminMsg.includes('berhasil') ? 'success' : 'error'}`}>{adminMsg}</div>}
            
            <div className="admin-toolbar">
              <button className="add-user-btn" onClick={() => { setShowAddForm(!showAddForm); setAdminMsg(''); }}>
                <Plus size={16} /> Tambah User
              </button>
            </div>
            
            {showAddForm && (
              <form className="admin-add-form" onSubmit={handleAddUser}>
                <input type="text" placeholder="Username" value={addForm.username} onChange={e => setAddForm({...addForm, username: e.target.value})} required />
                <input type="password" placeholder="Password" value={addForm.password} onChange={e => setAddForm({...addForm, password: e.target.value})} required />
                <label className="admin-checkbox">
                  <input type="checkbox" checked={addForm.is_admin} onChange={e => setAddForm({...addForm, is_admin: e.target.checked})} />
                  Admin
                </label>
                <button type="submit" className="auth-submit-btn" style={{padding: '0.6rem'}}>Simpan</button>
              </form>
            )}
            
            <div className="user-table">
              <div className="user-table-header">
                <span>ID</span>
                <span>Username</span>
                <span>Role</span>
                <span>Aksi</span>
              </div>
              {userList.map(u => (
                <div className="user-table-row" key={u.id}>
                  {editingUser === u.id ? (
                    <>
                      <span>{u.id}</span>
                      <input type="text" defaultValue={u.username} onChange={e => setEditForm({...editForm, username: e.target.value})} className="edit-input" />
                      <label className="admin-checkbox">
                        <input type="checkbox" defaultChecked={!!u.is_admin} onChange={e => setEditForm({...editForm, is_admin: e.target.checked})} />
                        Admin
                      </label>
                      <div className="row-actions">
                        <button className="save-btn" onClick={() => handleEditUser(u.id)}>Simpan</button>
                        <button className="cancel-edit-btn" onClick={() => setEditingUser(null)}>Batal</button>
                      </div>
                    </>
                  ) : (
                    <>
                      <span>{u.id}</span>
                      <span>{u.username}</span>
                      <span className={u.is_admin ? 'role-admin' : 'role-user'}>{u.is_admin ? 'Admin' : 'User'}</span>
                      <div className="row-actions">
                        <button className="edit-btn" onClick={() => { setEditingUser(u.id); setEditForm({ username: u.username, password: '', is_admin: !!u.is_admin }); }}>
                          <Pencil size={14} />
                        </button>
                        <button className="delete-btn" onClick={() => handleDeleteUser(u.id, u.username)}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : !token ? (
          <div className="auth-card glass-panel animate-fade-in">
            <h2>{isLoginMode ? 'Masuk ke Akun Anda' : 'Daftar Akun Baru'}</h2>
            <p className="auth-subtitle">
              {isLoginMode ? 'Silakan login untuk mulai memisahkan audio.' : 'Buat akun untuk menggunakan fitur AI.'}
            </p>
            
            <form onSubmit={handleAuth} className="auth-form">
              <div className="input-group">
                <User className="input-icon" size={20} />
                <input 
                  type="text" 
                  placeholder="Username" 
                  value={authForm.username}
                  onChange={(e) => setAuthForm({...authForm, username: e.target.value})}
                  required
                />
              </div>
              {!isLoginMode && (
                <div className="input-group">
                  <Mail className="input-icon" size={20} />
                  <input 
                    type="email" 
                    placeholder="Email" 
                    value={authForm.email}
                    onChange={(e) => setAuthForm({...authForm, email: e.target.value})}
                    required
                  />
                </div>
              )}
              <div className="input-group">
                <Lock className="input-icon" size={20} />
                <input 
                  type="password" 
                  placeholder="Password" 
                  value={authForm.password}
                  onChange={(e) => setAuthForm({...authForm, password: e.target.value})}
                  required
                />
              </div>
              
              {authError && <div className={`auth-message ${authError.includes('sukses') ? 'success' : 'error'}`}>{authError}</div>}
              
              <button type="submit" className="auth-submit-btn" disabled={isAuthLoading}>
                {isAuthLoading ? <Loader2 size={20} className="spinner" /> : (isLoginMode ? 'Sign In' : 'Sign Up')}
              </button>
            </form>
            
            <p className="auth-toggle">
              {isLoginMode ? 'Belum punya akun? ' : 'Sudah punya akun? '}
              <button type="button" onClick={() => {setIsLoginMode(!isLoginMode); setAuthError('');}}>
                {isLoginMode ? 'Daftar Sekarang' : 'Login di Sini'}
              </button>
            </p>
          </div>
        ) : activeTab === 'stems' ? (
          <>
            {status === 'idle' && (
          <div className="upload-card">
            <div className="upload-area">
              <Upload size={48} className="upload-icon" />
              <h3>Unggah Lagu Anda</h3>
              <p>Format MP3 didukung. File akan diproses dengan AI Demucs.</p>
              <label className="upload-btn">
                Pilih File
                <input type="file" accept="audio/mp3,audio/wav" onChange={handleFileSelect} hidden />
              </label>
            </div>
          </div>
        )}

        {status === 'selected' && (
          <div className="preview-card glass-panel animate-fade-in">
            <div className="preview-header">
              <Music size={40} className="preview-icon" />
              <div className="file-info">
                <h3>{file?.name}</h3>
                <p>{(file?.size / (1024 * 1024)).toFixed(2)} MB</p>
              </div>
            </div>

            <div className="original-player">
              <audio
                ref={originalAudioRef}
                src={originalUrl}
                onTimeUpdate={() => setAudioCurrentTime(originalAudioRef.current?.currentTime || 0)}
                onLoadedMetadata={() => setAudioDuration(originalAudioRef.current?.duration || 0)}
                onEnded={() => setOriginalPlaying(false)}
              />
              
              <button 
                className="original-play-btn" 
                onClick={() => {
                  if (originalPlaying) {
                    originalAudioRef.current?.pause();
                    setOriginalPlaying(false);
                  } else {
                    originalAudioRef.current?.play();
                    setOriginalPlaying(true);
                  }
                }}
              >
                {originalPlaying ? <Pause size={20} /> : <Play size={20} />}
              </button>

              <div className="original-timeline">
                <span className="time-display">{formatTime(audioCurrentTime)}</span>
                <input 
                  type="range" 
                  min="0" 
                  max={audioDuration || 100} 
                  step="0.1"
                  value={audioCurrentTime} 
                  onChange={(e) => {
                    const newTime = parseFloat(e.target.value);
                    setAudioCurrentTime(newTime);
                    if (originalAudioRef.current) {
                      originalAudioRef.current.currentTime = newTime;
                    }
                  }} 
                  className="original-slider" 
                />
                <span className="time-display">{formatTime(audioDuration)}</span>
              </div>
            </div>

            <div className="preview-actions">
              <button className="cancel-btn" onClick={() => {
                if (originalAudioRef.current) {
                  originalAudioRef.current.pause();
                }
                setFile(null);
                setOriginalUrl(null);
                setStatus('idle');
              }}>
                <RefreshCw size={16} /> Pilih Ulang
              </button>
              
              <button className="process-btn" onClick={startSeparation}>
                <Sparkles size={18} /> Mulai Pemisahan AI
              </button>
              
              <button 
                className="process-btn" 
                style={{ backgroundColor: '#2ec4b6' }} 
                onClick={generateMasterTab}
                disabled={isGeneratingTab}
              >
                {isGeneratingTab ? <Loader2 size={18} className="spinner" /> : <FileText size={18} />}
                {isGeneratingTab ? ' Memproses...' : ' Buat Tabulatur Langsung'}
              </button>
            </div>
          </div>
        )}

        {(status === 'uploading' || status === 'processing' || status === 'loading_audio' || status === 'generating_tab') && (
          <div className="loading-card glass-panel">
            <Loader2 size={48} className="spinner" />
            
            {status === 'uploading' && (
              <>
                <h3>Mengunggah Lagu...</h3>
                <p className="progress-text">{progressText}</p>
              </>
            )}

            {status === 'processing' && (
              <>
                <h3>Memisahkan Audio dengan AI</h3>
                <p className="progress-text">Teknologi Demucs HT Demucs 6-Stems sedang berjalan.</p>
                
                <div className="progress-section">
                  <div className="progress-info">
                    <span className="progress-percent">{progress}% Selesai</span>
                    <span className="progress-eta">Sisa waktu: {eta}</span>
                  </div>
                  <div className="progress-bar-container">
                    <div 
                      className="progress-bar-fill" 
                      style={{ width: `${progress}%` }}
                    ></div>
                  </div>
                  {progress >= 100 && (
                    <div style={{ marginTop: '15px', color: '#ff9f1c', fontWeight: 'bold', textAlign: 'center', animation: 'pulse 1.5s infinite' }}>
                      Mohon Tunggu Sampai Proses Selesai...
                    </div>
                  )}
                </div>

                <div className="processing-steps">
                  <div className={`step ${progress >= 10 ? 'active' : ''}`}>1. Inisialisasi Model AI Demucs (6 Stems)</div>
                  <div className={`step ${progress >= 30 ? 'active' : ''}`}>2. Mengurai Frekuensi Audio</div>
                  <div className={`step ${progress >= 60 ? 'active' : ''}`}>3. Memisahkan Vokal, Drum, Bass & Gitar</div>
                  <div className={`step ${progress >= 90 ? 'active' : ''}`}>4. Mengekstrak Piano & Instrumen Lainnya</div>
                </div>
              </>
            )}
            
            {status === 'generating_tab' && (
              <>
                <h3>Membuat Tabulatur Gitar</h3>
                <p className="progress-text">{progressText}</p>
                
                <div className="progress-section">
                  <div className="progress-info">
                    <span className="progress-percent">{progress}% Selesai</span>
                    <span className="progress-eta">{eta}</span>
                  </div>
                  <div className="progress-bar-container">
                    <div 
                      className="progress-bar-fill" 
                      style={{ width: `${progress}%` }}
                    ></div>
                  </div>
                  {progress >= 100 && (
                    <div style={{ marginTop: '15px', color: '#ff9f1c', fontWeight: 'bold', textAlign: 'center', animation: 'pulse 1.5s infinite' }}>
                      Mohon Tunggu Sampai Proses Selesai...
                    </div>
                  )}
                </div>

                <div className="processing-steps">
                  <div className={`step ${progress >= 10 ? 'active' : ''}`}>1. Memuat File Audio</div>
                  <div className={`step ${progress >= 40 ? 'active' : ''}`}>2. Mendeteksi Nada dengan AI (Basic-Pitch)</div>
                  <div className={`step ${progress >= 95 ? 'active' : ''}`}>3. Menerjemahkan ke Tabulatur Teks</div>
                </div>
              </>
            )}

            {status === 'loading_audio' && (
              <>
                <h3>Memuat Hasil Pemisahan...</h3>
                <p className="progress-text">{progressText}</p>
              </>
            )}
          </div>
        )}

        {status === 'error' && (
          <div className="upload-card" style={{ borderColor: '#ff477e' }}>
            <h3 style={{ color: '#ff477e' }}>Gagal Memproses</h3>
            <p>{progressText}</p>
            <button className="upload-btn" onClick={() => { setStatus('idle'); setProgressText(''); }}>Coba Lagi</button>
          </div>
        )}

        {status === 'ready' && (
          <div className="studio-container">
            <div className="master-controls glass-panel">
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', width: '100%' }}>
                <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                    <button className={`play-btn ${isPlaying ? 'playing' : ''}`} onClick={togglePlay}>
                      {isPlaying ? <Pause size={32} /> : <Play size={32} />}
                    </button>
                    <button className="process-btn" onClick={exportMix} disabled={isExporting} style={{ padding: '0.8rem 1.5rem', borderRadius: '12px' }}>
                      {isExporting ? <Loader2 size={20} className="spinner" /> : <Download size={20} />}
                      <span style={{ marginLeft: '8px' }}>{isExporting ? 'Mengekspor...' : 'Export MP3'}</span>
                    </button>
                  </div>
                  <div className="global-sliders" style={{ margin: 0 }}>
                    <div className="slider-group">
                      <label>Pitch: {pitch > 0 ? '+' : ''}{pitch} Semitones</label>
                      <input type="range" min="-12" max="12" step="1" value={pitch} onChange={handlePitchChange} className="accent-slider" />
                    </div>
                    
                    <div className="slider-group">
                      <label>Tempo: {Math.round(tempo * 100)}%</label>
                      <input type="range" min="0.5" max="1.5" step="0.05" value={tempo} onChange={handleTempoChange} className="accent-slider" />
                    </div>
                  </div>
                </div>

                <div className="original-timeline" style={{ marginTop: '0.5rem' }}>
                  <span className="time-display">{formatTime(stemCurrentTime)}</span>
                  <input 
                    type="range" 
                    min="0" 
                    max={stemDuration || 100} 
                    step="0.1"
                    value={stemCurrentTime} 
                    onChange={handleSeekStem} 
                    className="original-slider" 
                  />
                  <span className="time-display">{formatTime(stemDuration)}</span>
                </div>
              </div>
            </div>

            <div className="mixer-grid">
              {INSTRUMENTS.map(inst => (
                <div className="mixer-channel glass-panel" key={inst.id} style={{ '--theme-color': inst.color }}>
                  <div className="channel-header">
                    <inst.icon size={24} color={inst.color} />
                    <h4>{inst.label}</h4>
                  </div>
                  
                  <div className="slider-container">
                    <input 
                      type="range" 
                      min="-60" 
                      max="12" 
                      step="1" 
                      value={volumes[inst.id]} 
                      onChange={(e) => handleVolumeChange(inst.id, parseFloat(e.target.value))}
                      className="vertical-slider"
                      orient="vertical"
                    />
                  </div>
                  
                  <div className="channel-controls">
                    <button 
                      className={`mute-btn ${mutes[inst.id] ? 'muted' : ''}`}
                      onClick={() => toggleMute(inst.id)}
                    >
                      {mutes[inst.id] ? <VolumeX size={20} /> : <Volume2 size={20} />}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
          </>
        ) : activeTab === 'yt2mp3' ? (
          <div className="yt2mp3-container animate-fade-in">
            {yt2mp3Status === 'idle' && (
              <div className="yt-input-card glass-panel">
                <div className="yt-input-header">
                  <Download size={48} className="yt-icon" />
                  <h3>YouTube to MP3 Converter</h3>
                  <p>Paste link YouTube untuk mengunduh audio dengan cepat.</p>
                </div>
                <div className="yt-url-input" style={{ display: 'flex', gap: '0.5rem', position: 'relative', width: '100%' }}>
                  <div style={{ position: 'relative', flex: 1, display: 'flex', alignItems: 'center' }}>
                    <input
                      type="text"
                      placeholder="Paste link ATAU ketik judul lagu... (contoh: Coldplay Yellow)"
                      value={yt2mp3Url}
                      onChange={(e) => setYt2mp3Url(e.target.value)}
                      style={{ flex: 1, paddingRight: '40px' }}
                    />
                    <button 
                      onClick={() => {
                        if (!('webkitSpeechRecognition' in window)) {
                          alert("Browser Anda tidak mendukung pencarian suara. Gunakan Google Chrome.");
                          return;
                        }
                        const recognition = new window.webkitSpeechRecognition();
                        recognition.lang = 'id-ID';
                        recognition.interimResults = true; // Aktifkan pengetikan real-time
                        
                        recognition.onstart = () => {
                          setIsVoiceActive(true);
                          setYt2mp3Url(""); // Kosongkan saat mulai bicara
                        };
                        
                        recognition.onresult = (event) => {
                          let interimTranscript = '';
                          for (let i = event.resultIndex; i < event.results.length; ++i) {
                            if (event.results[i].isFinal) {
                              setYt2mp3Url(event.results[i][0].transcript);
                            } else {
                              interimTranscript += event.results[i][0].transcript;
                              setYt2mp3Url(interimTranscript); // Tampilkan sementara
                            }
                          }
                        };
                        
                        recognition.onend = () => {
                          setIsVoiceActive(false);
                        };
                        
                        recognition.onerror = () => {
                          setIsVoiceActive(false);
                        };
                        
                        recognition.start();
                      }}
                      style={{ 
                        position: 'absolute', right: '10px', 
                        background: isVoiceActive ? 'rgba(255, 71, 126, 0.2)' : 'transparent', 
                        border: 'none', 
                        color: isVoiceActive ? '#fff' : '#ff477e', 
                        cursor: 'pointer', 
                        padding: '5px',
                        borderRadius: '50%',
                        transition: 'all 0.3s ease',
                        boxShadow: isVoiceActive ? '0 0 10px rgba(255, 71, 126, 0.5)' : 'none'
                      }}
                      title="Gunakan Suara"
                    >
                      <Mic size={20} />
                    </button>
                  </div>
                  <button className="yt-search-btn" style={{ flexShrink: 0 }} onClick={async () => {
                    if(!yt2mp3Url.trim()) return;
                    setYt2mp3IsSearching(true);
                    setYt2mp3SearchResults([]);
                    setYt2mp3Error('');
                    try {
                      const res = await fetch(`${API_BASE_URL}/youtube-to-mp3/search`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                        body: JSON.stringify({ query: yt2mp3Url })
                      });
                      const data = await res.json();
                      if(res.ok) {
                        setYt2mp3SearchResults(data.results || []);
                      } else {
                        setYt2mp3Error(data.detail || 'Gagal mencari');
                      }
                    } catch(e) { setYt2mp3Error('Kesalahan jaringan saat mencari'); }
                    setYt2mp3IsSearching(false);
                  }} disabled={!yt2mp3Url.trim() || yt2mp3IsSearching}>
                    {yt2mp3IsSearching ? <Loader2 size={20} className="spinner" /> : <Search size={20} />} Cari Lagu
                  </button>
                </div>
                {yt2mp3Error && <div className="auth-message error">{yt2mp3Error}</div>}
                
                {yt2mp3SearchResults.length > 0 && (
                  <div className="search-results-container" style={{ marginTop: '1.5rem', textAlign: 'left' }}>
                    <h4 style={{ marginBottom: '1rem', color: '#fff' }}>Hasil Pencarian:</h4>
                    <div className="search-results-list" style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
                      {yt2mp3SearchResults.map((result, idx) => (
                        <div key={idx} className="search-result-item" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(255,255,255,0.05)', padding: '1rem', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.1)' }}>
                          <div className="result-info" style={{ flex: 1, marginRight: '1rem', overflow: 'hidden' }}>
                            <div style={{ fontWeight: 'bold', color: '#fff', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{result.title}</div>
                            <div style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.6)', marginTop: '4px', display: 'flex', gap: '1rem' }}>
                              <span><Clock size={12} style={{ verticalAlign: 'middle', marginRight: '4px' }}/> {result.duration ? Math.floor(result.duration / 60) + ':' + (result.duration % 60).toString().padStart(2, '0') : '--:--'}</span>
                              <span style={{ color: result.source === 'SoundCloud' ? '#ff9f1c' : '#ff477e' }}>{result.source}</span>
                            </div>
                          </div>
                          <button className="process-btn" style={{ flexShrink: 0, width: 'auto', minWidth: '90px', padding: '0.5rem 1rem', fontSize: '0.9rem', display: 'flex', justifyContent: 'center', alignItems: 'center' }} onClick={async () => {
                            setYt2mp3Status('preparing');
                            setYt2mp3Error('');
                            setYt2mp3Progress(0);
                            try {
                              const res = await fetch(`${API_BASE_URL}/youtube-to-mp3/prepare`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                                body: JSON.stringify({ url: result.url })
                              });
                              const data = await res.json();
                              if(res.ok) {
                                setYt2mp3JobId(data.job_id);
                                setYt2mp3Status('downloading');
                              } else {
                                setYt2mp3Status('error'); setYt2mp3Error(data.detail || 'Gagal memproses');
                              }
                            } catch(e) { setYt2mp3Status('error'); setYt2mp3Error('Kesalahan jaringan'); }
                          }}>
                            <Download size={16} style={{ marginRight: '4px' }} /> Unduh
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
            {(yt2mp3Status === 'preparing' || yt2mp3Status === 'downloading') && (
              <div className="loading-card glass-panel">
                <Loader2 size={48} className="spinner" />
                <h3>{yt2mp3Status === 'preparing' ? 'Mempersiapkan...' : 'Mengunduh Audio...'}</h3>
                <div className="progress-section">
                  <div className="progress-info">
                    <span className="progress-percent">{yt2mp3Progress}%</span>
                    <span className="progress-eta">Mengunduh dari YouTube...</span>
                  </div>
                  <div className="progress-bar-container">
                    <div className="progress-bar-fill" style={{ width: `${yt2mp3Progress}%` }}></div>
                  </div>
                </div>
                <button className="cancel-btn" style={{ maxWidth: '200px', margin: '1rem auto 0' }} onClick={() => { setYt2mp3Status('idle'); setYt2mp3Url(''); }}>
                  <X size={16} /> Batal
                </button>
              </div>
            )}
            {yt2mp3Status === 'done' && (
              <div className="upload-card" style={{ borderColor: '#2ec4b6' }}>
                <CheckCircle size={48} color="#2ec4b6" style={{ marginBottom: '1rem' }} />
                <h3 style={{ color: '#2ec4b6' }}>Audio Siap Diunduh!</h3>
                <p>{yt2mp3Title}</p>
                <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center', marginTop: '1rem' }}>
                  <a href={`${API_BASE_URL}/youtube-to-mp3/download/${yt2mp3JobId}`} className="process-btn" style={{ textDecoration: 'none', padding: '0.8rem 1.5rem' }} download>
                    <Download size={18} /> Simpan MP3
                  </a>
                  <button className="cancel-btn" onClick={() => { setYt2mp3Status('idle'); setYt2mp3Url(''); }}>
                    <RefreshCw size={16} /> Unduh Lainnya
                  </button>
                </div>
              </div>
            )}
            {yt2mp3Status === 'error' && (
              <div className="upload-card" style={{ borderColor: '#ff477e' }}>
                <h3 style={{ color: '#ff477e' }}>Gagal Mengunduh</h3>
                <p>{yt2mp3Error}</p>
                <button className="upload-btn" onClick={() => setYt2mp3Status('idle')}>Coba Lagi</button>
              </div>
            )}
          </div>
        ) : null}
      </main>
    </div>
  );
}

export default App;
