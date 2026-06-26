import React, { useState, useEffect, useRef } from 'react';
import * as Tone from 'tone';
import { Upload, Play, Pause, Loader2, Volume2, VolumeX, Music, Settings2, Guitar, Mic2, Drum, Sparkles, RefreshCw, Download, FileText, User, Lock, LogOut, Shield, Trash2, Pencil, Plus, X, Mail } from 'lucide-react';
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

  const playersRef = useRef({});
  const volumeNodesRef = useRef({});
  const originalAudioRef = useRef(null);

  useEffect(() => {
    return () => {
      Object.values(playersRef.current).forEach(p => p.dispose());
      Object.values(volumeNodesRef.current).forEach(v => v.dispose());
    };
  }, []);

  useEffect(() => {
    return () => {
      if (originalUrl) {
        URL.revokeObjectURL(originalUrl);
      }
    };
  }, [originalUrl]);

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

  return (
    <div className="app-container">
      <div className="background-glow"></div>
      
      <header className="header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', maxWidth: '900px' }}>
          <div>
            <h1>Jagat <span>Audio</span></h1>
            <p>AI Stem Separation & Pitch/Tempo Control</p>
          </div>
          {token && (
            <div className="user-profile">
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
        </div>
      </header>

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
        ) : (
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
              <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                <button className={`play-btn ${isPlaying ? 'playing' : ''}`} onClick={togglePlay}>
                  {isPlaying ? <Pause size={32} /> : <Play size={32} />}
                </button>
                <button className="process-btn" onClick={exportMix} disabled={isExporting} style={{ padding: '0.8rem 1.5rem', borderRadius: '12px' }}>
                  {isExporting ? <Loader2 size={20} className="spinner" /> : <Download size={20} />}
                  <span style={{ marginLeft: '8px' }}>{isExporting ? 'Mengekspor...' : 'Export MP3'}</span>
                </button>
              </div>
              
              <div className="global-sliders">
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
        )}
      </main>
    </div>
  );
}

export default App;
