import React, { useState, useEffect, useMemo, useRef } from 'react';
import Papa from 'papaparse';
import {
    Search,
    ChevronUp,
    ChevronDown,
    Download,
    MapPin,
    Globe,
    Mail,
    ChevronLeft,
    ChevronRight,
    MoreHorizontal,
    Play,
    StopCircle,
    Database,
    RefreshCw,
    Sun,
    Moon
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { io } from 'socket.io-client';
import { Routes, Route, Link, useLocation, Navigate } from 'react-router-dom';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Fix for default marker icon in Leaflet
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
    iconRetinaUrl: 'https://unpkg.com/leaflet@1.7.1/dist/images/marker-icon-2x.png',
    iconUrl: 'https://unpkg.com/leaflet@1.7.1/dist/images/marker-icon.png',
    shadowUrl: 'https://unpkg.com/leaflet@1.7.1/dist/images/marker-shadow.png',
});

const ITEMS_PER_PAGE = 20;

function App() {
    const location = useLocation();
    const activeTab = location.pathname.substring(1) || 'scraping';
    
    const [data, setData] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [searchTerm, setSearchTerm] = useState('');
    const [filters, setFilters] = useState({
        Type: '',
        Region: '',
        Departement: ''
    });
    const [sortConfig, setSortConfig] = useState({ key: null, direction: 'asc' });
    const [currentPage, setCurrentPage] = useState(1);

    // Scraping state
    const [isScraping, setIsScraping] = useState(false);
    const [isConnected, setIsConnected] = useState(false);
    const [scrapingStatus, setScrapingStatus] = useState({ message: 'Prêt à scraper', progress: 0 });
    const [scrapedEmails, setScrapedEmails] = useState([]);
    const [savedContacts, setSavedContacts] = useState([]);
    const [serverHealth, setServerHealth] = useState({ status: 'unknown', details: null });
    const [logs, setLogs] = useState([]);
    const [maxItems, setMaxItems] = useState(20);
    const [startIndex, setStartIndex] = useState(() => {
        return parseInt(localStorage.getItem('lastScrapedIndex')) || 0;
    });
    const [lastPosition, setLastPosition] = useState(parseInt(localStorage.getItem('lastScrapedIndex')) || 0);
    const [scrapingUrl, setScrapingUrl] = useState('https://explore.datatourisme.fr/?type=%5B%22%2FLieu%22%5D');
    
    // Theme state
    const [theme, setTheme] = useState(() => {
        return localStorage.getItem('theme') || 'light';
    });

    const socketRef = useRef(null);
    const logEndRef = useRef(null);

    useEffect(() => {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('theme', theme);
    }, [theme]);

    const toggleTheme = () => {
        setTheme(prev => prev === 'light' ? 'dark' : 'light');
    };

    useEffect(() => {
        const isDev = window.location.port === '5173' || window.location.port === '5174' || window.location.port === '5175' || window.location.port === '3001';
        const socketUrl = isDev ? `http://${window.location.hostname}:3000` : window.location.origin;

        socketRef.current = io(socketUrl);

        socketRef.current.on('connect', () => {
            setIsConnected(true);
            console.log('Connected to scraper server');
        });

        socketRef.current.on('disconnect', () => {
            setIsConnected(false);
            console.log('Disconnected from scraper server');
        });

        socketRef.current.on('status', (status) => {
            setScrapingStatus(status);
            if (status.currentIndex) {
                setLastPosition(status.currentIndex);
                localStorage.setItem('lastScrapedIndex', status.currentIndex.toString());
            }
        });

        socketRef.current.on('log', (log) => {
            setLogs(prev => [...prev, log]);
        });

        socketRef.current.on('newEmail', (email) => {
            setScrapedEmails(prev => [email, ...prev]);
        });

        socketRef.current.on('finished', (results) => {
            setIsScraping(false);
            fetchData();
        });

        socketRef.current.on('error', (err) => {
            setError(err);
            setIsScraping(false);
        });

        return () => {
            if (socketRef.current) socketRef.current.disconnect();
        };
    }, []);

    useEffect(() => {
        if (logEndRef.current) {
            logEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [logs]);

    const fetchData = async () => {
        setLoading(true);
        try {
            const csvResponse = await fetch('/datatourisme.csv');
            const csvReader = csvResponse.body.getReader();
            const csvResult = await csvReader.read();
            const decoder = new TextDecoder('utf-8');
            const csv = decoder.decode(csvResult.value);

            let contacts = [];
            try {
                const contactResponse = await fetch('/contacts.json?t=' + Date.now());
                if (contactResponse.ok) {
                    contacts = await contactResponse.json();
                }
            } catch (e) {
                console.log("No contacts.json found");
            }

            if (contacts.length > 0) {
                setSavedContacts(contacts);
            }

            Papa.parse(csv, {
                header: true,
                skipEmptyLines: true,
                complete: (results) => {
                    let finalData = results.data;
                    if (contacts.length > 0) {
                        finalData = finalData.map(item => {
                            const match = contacts.find(c => c.name === item.Nom);
                            return match ? { ...item, EmailScraped: match.email, PhoneScraped: match.phone } : item;
                        });
                    }
                    setData(finalData);
                    setLoading(false);
                },
                error: (err) => {
                    setError(err.message);
                    setLoading(false);
                }
            });
        } catch (err) {
            setError("Impossible de charger les données.");
            setLoading(false);
        }
    };

    const checkHealth = async () => {
        try {
            // Use relative path to avoid origin issues
            const res = await fetch('/health');
            if (res.ok) {
                const healthData = await res.json();
                setServerHealth({ status: 'ok', details: healthData });
            } else {
                setServerHealth({ status: 'error', details: 'Statut HTTP ' + res.status });
            }
        } catch (err) {
            setServerHealth({ status: 'error', details: 'Serveur injoignable' });
        }
    };

    useEffect(() => {
        fetchData();
        checkHealth();
    }, []);

    const handleStartScraping = () => {
        setIsScraping(true);
        setScrapedEmails([]);
        setLogs([]);
        socketRef.current.emit('startScraping', { maxItems, url: scrapingUrl });
    };

    const handleStopScraping = () => {
        socketRef.current.emit('stopScraping');
        setIsScraping(false);
    };

    const handleSort = (key) => {
        let direction = 'asc';
        if (sortConfig.key === key && sortConfig.direction === 'asc') {
            direction = 'desc';
        }
        setSortConfig({ key, direction });
    };

    const filteredData = useMemo(() => {
        let result = [...data];
        if (searchTerm) {
            const lowerSearch = searchTerm.toLowerCase();
            result = result.filter(item =>
                Object.values(item).some(val => String(val).toLowerCase().includes(lowerSearch))
            );
        }
        if (filters.Type) result = result.filter(item => item.Type === filters.Type);
        if (filters.Region) result = result.filter(item => item.Région === filters.Region);
        if (sortConfig.key) {
            result.sort((a, b) => {
                const aVal = a[sortConfig.key] || '';
                const bVal = b[sortConfig.key] || '';
                if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1;
                if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1;
                return 0;
            });
        }
        return result;
    }, [data, searchTerm, filters, sortConfig]);

    const totalPages = Math.ceil(filteredData.length / ITEMS_PER_PAGE);
    const paginatedData = filteredData.slice(
        (currentPage - 1) * ITEMS_PER_PAGE,
        currentPage * ITEMS_PER_PAGE
    );

    const uniqueTypes = useMemo(() => [...new Set(data.map(item => item.Type).filter(Boolean))], [data]);
    const uniqueRegions = useMemo(() => [...new Set(data.map(item => item.Région).filter(Boolean))], [data]);

    return (
        <div className="container">
            <header style={{ marginBottom: '3rem', textAlign: 'center' }}>
                <motion.h1
                    initial={{ opacity: 0, y: -20 }}
                    animate={{ opacity: 1, y: 0 }}
                    style={{ fontSize: '3rem', marginBottom: '1.5rem', background: 'linear-gradient(to right, var(--primary), var(--accent))', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}
                >
                    DATAtourisme Explorer
                </motion.h1>

                <div style={{ position: 'fixed', top: '1.5rem', right: '1.5rem', zIndex: 100 }}>
                    <button 
                        onClick={toggleTheme}
                        className="btn glass"
                        style={{ padding: '0.6rem', borderRadius: '50%', width: '45px', height: '45px' }}
                        title={theme === 'light' ? 'Mode Sombre' : 'Mode Clair'}
                    >
                        {theme === 'light' ? <Moon size={20} /> : <Sun size={20} />}
                    </button>
                </div>

                <div className="glass" style={{ display: 'inline-flex', padding: '0.4rem', gap: '0.4rem', marginBottom: '1rem' }}>
                    <Link
                        to="/explorer"
                        className={`btn ${activeTab === 'explorer' ? 'btn-primary' : ''}`}
                        style={{
                            background: activeTab === 'explorer' ? 'var(--primary)' : 'transparent',
                            color: activeTab === 'explorer' ? 'white' : 'var(--text-muted)',
                            padding: '0.75rem 1.5rem',
                            borderRadius: '0.6rem',
                            border: activeTab === 'explorer' ? 'none' : '1px solid var(--border)',
                            textDecoration: 'none',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.5rem',
                            transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                            opacity: activeTab === 'explorer' ? 1 : 0.7
                        }}
                    >
                        <Database size={18} /> Explorateur
                    </Link>
                    <Link
                        to="/database"
                        className={`btn ${activeTab === 'database' ? 'btn-primary' : ''}`}
                        style={{
                            background: activeTab === 'database' ? 'var(--primary)' : 'transparent',
                            color: activeTab === 'database' ? 'white' : 'var(--text-muted)',
                            padding: '0.75rem 1.5rem',
                            borderRadius: '0.6rem',
                            border: activeTab === 'database' ? 'none' : '1px solid var(--border)',
                            textDecoration: 'none',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.5rem',
                            transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                            opacity: activeTab === 'database' ? 1 : 0.7
                        }}
                    >
                        <Database size={18} /> Base de données
                    </Link>
                    <Link
                        to="/scraping"
                        className={`btn ${activeTab === 'scraping' ? 'btn-primary' : ''}`}
                        style={{
                            background: activeTab === 'scraping' ? 'var(--primary)' : 'transparent',
                            color: activeTab === 'scraping' ? 'white' : 'var(--text-muted)',
                            padding: '0.75rem 1.5rem',
                            borderRadius: '0.6rem',
                            border: activeTab === 'scraping' ? 'none' : '1px solid var(--border)',
                            textDecoration: 'none',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.5rem',
                            transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                            opacity: activeTab === 'scraping' ? 1 : 0.7
                        }}
                    >
                        <RefreshCw size={18} className={isScraping ? 'spin' : ''} /> Scraping Contacts
                    </Link>
                </div>
            </header>

            <Routes>
                <Route path="/" element={<Navigate to="/scraping" replace />} />
                <Route path="/explorer" element={
                    <>
                        <div className="glass" style={{ padding: '1.5rem', marginBottom: '2rem' }}>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
                                <div style={{ position: 'relative' }}>
                                    <Search size={18} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
                                    <input
                                        type="text"
                                        className="input"
                                        placeholder="Rechercher..."
                                        style={{ paddingLeft: '2.5rem' }}
                                        value={searchTerm}
                                        onChange={(e) => { setSearchTerm(e.target.value); setCurrentPage(1); }}
                                    />
                                </div>
                                <select className="input" value={filters.Type} onChange={(e) => { setFilters({ ...filters, Type: e.target.value }); setCurrentPage(1); }}>
                                    <option value="">Tous les types</option>
                                    {uniqueTypes.map(t => <option key={t} value={t}>{t}</option>)}
                                </select>
                                <select className="input" value={filters.Region} onChange={(e) => { setFilters({ ...filters, Region: e.target.value }); setCurrentPage(1); }}>
                                    <option value="">Toutes les régions</option>
                                    {uniqueRegions.map(r => <option key={r} value={r}>{r}</option>)}
                                </select>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-muted)', fontSize: '0.875rem', justifyContent: 'flex-end' }}>
                                    <strong>{filteredData.length}</strong> résultats
                                </div>
                            </div>
                        </div>

                        <div className="table-container glass">
                            <table>
                                <thead>
                                    <tr>
                                        <th onClick={() => handleSort('Nom')}>Nom {sortConfig.key === 'Nom' && (sortConfig.direction === 'asc' ? <ChevronUp size={14} /> : <ChevronDown size={14} />)}</th>
                                        <th onClick={() => handleSort('Type')}>Type</th>
                                        <th onClick={() => handleSort('Commune')}>Localisation</th>
                                        <th>Contacts</th>
                                        <th>Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <AnimatePresence mode="wait">
                                        {paginatedData.map((item, idx) => (
                                            <motion.tr key={item.Identifiant || idx} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2, delay: idx * 0.01 }}>
                                                <td style={{ fontWeight: '500', maxWidth: '300px' }}>{item.Nom}</td>
                                                <td><span className="badge badge-type">{item.Type}</span></td>
                                                <td>
                                                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                                                        <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}><MapPin size={12} /> {item.Commune}</span>
                                                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{item.Région}</span>
                                                    </div>
                                                </td>
                                                <td>
                                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.85rem' }}>
                                                        {(item.EmailScraped || item['Site internet']?.includes('@')) && (
                                                            <span style={{ color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                                                <Mail size={12} /> {item.EmailScraped || item['Site internet']}
                                                            </span>
                                                        )}
                                                        {item.PhoneScraped && (
                                                            <span style={{ color: 'var(--primary)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                                                <Globe size={12} /> {item.PhoneScraped}
                                                            </span>
                                                        )}
                                                    </div>
                                                </td>
                                                <td>
                                                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                                                        {(item['Site internet']?.includes('@') || item.EmailScraped) ? (
                                                            <a href={`mailto:${(item.EmailScraped || item['Site internet']).replace('http://', '').replace('https://', '')}`} className="btn" title="Envoyer Email" style={{ padding: '0.4rem', background: 'rgba(16, 185, 129, 0.1)', color: 'var(--accent)' }}>
                                                                <Mail size={16} />
                                                            </a>
                                                        ) : (
                                                            item['Site internet'] && (
                                                                <a href={item['Site internet']} target="_blank" rel="noopener noreferrer" className="btn" title="Voir Site" style={{ padding: '0.4rem', background: 'rgba(99, 102, 241, 0.1)', color: 'var(--primary)' }}>
                                                                    <Globe size={16} />
                                                                </a>
                                                            )
                                                        )}
                                                    </div>
                                                </td>
                                            </motion.tr>
                                        ))}
                                    </AnimatePresence>
                                </tbody>
                            </table>
                        </div>

                        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '1rem', marginTop: '2rem' }}>
                            <button className="btn" disabled={currentPage === 1} onClick={() => setCurrentPage(p => Math.max(1, p - 1))} style={{ opacity: currentPage === 1 ? 0.5 : 1 }}><ChevronLeft size={20} /></button>
                            <span style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>Page <strong>{currentPage}</strong> sur {totalPages}</span>
                            <button className="btn" disabled={currentPage === totalPages} onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} style={{ opacity: currentPage === totalPages ? 0.5 : 1 }}><ChevronRight size={20} /></button>
                        </div>
                    </>
                } />

                <Route path="/database" element={
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
                        <div className="glass" style={{ padding: '2rem' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
                                <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                                    <Database size={24} /> Contacts Enregistrés
                                </h2>
                                <div style={{ display: 'flex', gap: '1rem' }}>
                                    <a href="/contacts.json" target="_blank" className="btn" style={{ background: 'rgba(99, 102, 241, 0.1)', color: 'var(--primary)' }}>
                                        Voir JSON
                                    </a>
                                    <a href="/contacts.csv" download className="btn btn-primary">
                                        <Download size={18} /> Télécharger CSV
                                    </a>
                                </div>
                            </div>

                            {/* Leaflet Map Preview */}
                            <div style={{ height: '400px', width: '100%', marginBottom: '2rem', borderRadius: '1rem', overflow: 'hidden', border: '1px solid var(--border)' }}>
                                <MapContainer center={[46.603354, 1.888334]} zoom={5} style={{ height: '100%', width: '100%' }}>
                                    <TileLayer
                                        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                                        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                                    />
                                    {savedContacts.filter(c => c.gps && c.gps.includes(',')).map((c, i) => {
                                        const [lat, lng] = c.gps.split(',').map(s => parseFloat(s.trim()));
                                        if (isNaN(lat) || isNaN(lng)) return null;
                                        return (
                                            <Marker key={i} position={[lat, lng]}>
                                                <Popup>
                                                    <div style={{ padding: '0.2rem' }}>
                                                        <strong style={{ display: 'block', marginBottom: '0.5rem' }}>{c.name}</strong>
                                                        {c.image && <img src={c.image} alt={c.name} style={{ width: '100%', height: '80px', objectFit: 'cover', borderRadius: '4px', marginBottom: '0.5rem' }} />}
                                                        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{c.address}</div>
                                                    </div>
                                                </Popup>
                                            </Marker>
                                        );
                                    })}
                                </MapContainer>
                            </div>

                            <div className="table-container">
                                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                    <thead>
                                        <tr>
                                            <th style={{ textAlign: 'left', padding: '1rem', borderBottom: '2px solid var(--border)', width: '50px' }}>#</th>
                                            <th style={{ textAlign: 'left', padding: '1rem', borderBottom: '2px solid var(--border)', width: '80px' }}>Image</th>
                                            <th style={{ textAlign: 'left', padding: '1rem', borderBottom: '2px solid var(--border)' }}>Nom</th>
                                            <th style={{ textAlign: 'left', padding: '1rem', borderBottom: '2px solid var(--border)' }}>Adresse & GPS</th>
                                            <th style={{ textAlign: 'left', padding: '1rem', borderBottom: '2px solid var(--border)' }}>Emails</th>
                                            <th style={{ textAlign: 'left', padding: '1rem', borderBottom: '2px solid var(--border)' }}>Téléphones</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {savedContacts.length === 0 ? (
                                            <tr>
                                                <td colSpan="6" style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>
                                                    Aucun contact enregistré pour le moment.
                                                </td>
                                            </tr>
                                        ) : (
                                            savedContacts.map((c, i) => (
                                                <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                                                    <td style={{ padding: '1rem', color: 'var(--text-muted)', fontSize: '0.85rem' }}>{i + 1}</td>
                                                    <td style={{ padding: '0.5rem 1rem' }}>
                                                        {c.image ? (
                                                            <a href={c.image} target="_blank" rel="noopener noreferrer">
                                                                <img src={c.image} alt={c.name} style={{ width: '60px', height: '40px', objectFit: 'cover', borderRadius: '4px', border: '1px solid var(--border)' }} />
                                                            </a>
                                                        ) : (
                                                            <div style={{ width: '60px', height: '40px', background: 'var(--border)', borderRadius: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', color: 'var(--text-muted)' }}>N/A</div>
                                                        )}
                                                    </td>
                                                    <td style={{ padding: '1rem', fontWeight: '500' }}>{c.name}</td>
                                                    <td style={{ padding: '1rem', fontSize: '0.85rem' }}>
                                                        <div style={{ color: 'var(--text-muted)', marginBottom: '0.25rem' }}>{c.address || '-'}</div>
                                                        {c.gps && (
                                                            <a href={`https://www.google.com/maps/search/?api=1&query=${c.gps}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--primary)', textDecoration: 'none', borderBottom: '1px dashed var(--primary)' }}>
                                                                <MapPin size={12} /> {c.gps}
                                                            </a>
                                                        )}
                                                    </td>
                                                    <td style={{ padding: '1rem', color: 'var(--accent)', fontSize: '0.9rem' }}>{c.email || '-'}</td>
                                                    <td style={{ padding: '1rem', color: 'var(--primary)', fontSize: '0.9rem' }}>{c.phone || '-'}</td>
                                                </tr>
                                            ))
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                } />

                <Route path="/scraping" element={
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
                        <div className="glass" style={{ padding: '2rem' }}>
                            <h2 style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem', justifyContent: 'space-between' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                                    <RefreshCw size={24} className={isScraping ? 'spin' : ''} />
                                    Configuration du Scraping
                                </div>
                                <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                                    <a href="/contacts.csv" download className="btn" style={{ fontSize: '0.85rem', padding: '0.5rem 1rem', background: 'var(--border)', color: 'var(--text)' }}>
                                        <Download size={16} /> Télécharger CSV
                                    </a>
                                    <div style={{
                                        fontSize: '0.75rem',
                                        padding: '0.25rem 0.75rem',
                                        borderRadius: '1rem',
                                        background: isConnected ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                                        color: isConnected ? 'var(--accent)' : 'var(--danger)',
                                        border: `1px solid ${isConnected ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)'}`,
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '0.4rem',
                                        cursor: isConnected ? 'default' : 'pointer'
                                    }}
                                        onClick={() => { if (!isConnected) socketRef.current.connect(); }}
                                    >
                                        <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: isConnected ? 'var(--accent)' : 'var(--danger)' }} />
                                        {isConnected ? 'Connecté' : 'Déconnecté'}
                                    </div>
                                    <div style={{
                                        fontSize: '0.75rem',
                                        padding: '0.25rem 0.75rem',
                                        borderRadius: '1rem',
                                        background: serverHealth.status === 'ok' ? 'rgba(99, 102, 241, 0.1)' : 'rgba(245, 158, 11, 0.1)',
                                        color: serverHealth.status === 'ok' ? 'var(--primary)' : 'var(--warning)',
                                        border: `1px solid ${serverHealth.status === 'ok' ? 'rgba(99, 102, 241, 0.2)' : 'rgba(245, 158, 11, 0.2)'}`,
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '0.4rem',
                                        cursor: 'pointer'
                                    }}
                                        onClick={checkHealth}
                                        title={serverHealth.details ? JSON.stringify(serverHealth.details) : 'Cliquer pour retester la santé du serveur'}
                                    >
                                        <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: serverHealth.status === 'ok' ? 'var(--primary)' : 'var(--warning)' }} />
                                        API: {serverHealth.status === 'ok' ? 'En ligne' : 'Inaccessible'}
                                    </div>
                                </div>
                            </h2>

                            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                                <div style={{ flex: '1' }}>
                                    <label style={{ display: 'block', marginBottom: '0.75rem', fontSize: '0.875rem', color: 'var(--text-muted)' }}>
                                        URL de départ (DATAtourisme Explorer)
                                    </label>
                                    <div style={{ position: 'relative' }}>
                                        <Globe size={18} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
                                        <input
                                            type="text"
                                            className="input"
                                            value={scrapingUrl}
                                            onChange={(e) => setScrapingUrl(e.target.value)}
                                            disabled={isScraping}
                                            placeholder="https://explore.datatourisme.fr/..."
                                            style={{ paddingLeft: '2.5rem', fontSize: '1rem' }}
                                        />
                                    </div>
                                </div>

                                <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                                    <div style={{ flex: '1', minWidth: '150px' }}>
                                        <label style={{ display: 'block', marginBottom: '0.75rem', fontSize: '0.875rem', color: 'var(--text-muted)' }}>
                                            Index de départ
                                        </label>
                                        <div style={{ position: 'relative' }}>
                                            <input
                                                type="number"
                                                className="input"
                                                value={startIndex}
                                                onChange={(e) => setStartIndex(parseInt(e.target.value) || 0)}
                                                disabled={isScraping}
                                                style={{ fontSize: '1.1rem', padding: '0.8rem 1.2rem' }}
                                            />
                                            {lastPosition > 0 && !isScraping && (
                                                <button 
                                                    onClick={() => setStartIndex(lastPosition)}
                                                    style={{ position: 'absolute', right: '-120px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--primary)', fontSize: '0.75rem', cursor: 'pointer', whiteSpace: 'nowrap' }}
                                                >
                                                    Continuer à {lastPosition}
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                    <div style={{ flex: '1', minWidth: '150px' }}>
                                        <label style={{ display: 'block', marginBottom: '0.75rem', fontSize: '0.875rem', color: 'var(--text-muted)' }}>
                                            Max items
                                        </label>
                                        <input
                                            type="number"
                                            className="input"
                                            value={maxItems}
                                            onChange={(e) => setMaxItems(parseInt(e.target.value) || 0)}
                                            disabled={isScraping}
                                            style={{ fontSize: '1.1rem', padding: '0.8rem 1.2rem' }}
                                        />
                                    </div>
                                    <div style={{ display: 'flex', gap: '1rem' }}>
                                        {!isScraping ? (
                                            <button className="btn btn-primary" onClick={handleStartScraping} style={{ height: '52px', padding: '0 2rem', fontSize: '1rem' }}>
                                                <Play size={20} /> Démarrer l'extraction
                                            </button>
                                        ) : (
                                            <button className="btn" onClick={handleStopScraping} style={{ height: '52px', padding: '0 2rem', background: 'var(--danger)', color: 'white', fontSize: '1rem' }}>
                                                <StopCircle size={20} /> Arrêter
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </div>
                            {isScraping && (
                                <div style={{ marginTop: '2rem' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.75rem', fontSize: '0.9rem' }}>
                                        <span style={{ color: 'var(--primary)', fontWeight: '500' }}>{scrapingStatus.message}</span>
                                        <span style={{ color: 'var(--text-muted)' }}>{scrapingStatus.progress}%</span>
                                    </div>
                                    <div style={{ height: '10px', background: 'var(--border)', borderRadius: '5px', overflow: 'hidden', border: '1px solid var(--border)' }}>
                                        <motion.div
                                            initial={{ width: 0 }}
                                            animate={{ width: `${scrapingStatus.progress}%` }}
                                            style={{ height: '100%', background: 'linear-gradient(90deg, var(--primary), var(--accent))' }}
                                        />
                                    </div>
                                </div>
                            )}
                        </div>

                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem' }}>
                            <div className="glass" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', height: '500px' }}>
                                <h3 style={{ fontSize: '1rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-muted)' }}>
                                    <MoreHorizontal size={18} /> Logs d'exécution
                                </h3>
                                <div style={{
                                    flex: 1,
                                    overflowY: 'auto',
                                    background: '#000',
                                    borderRadius: '0.75rem',
                                    padding: '1rem',
                                    fontFamily: 'monospace',
                                    fontSize: '0.8rem',
                                    border: '1px solid var(--border)'
                                }}>
                                    {logs.length === 0 && <div style={{ color: '#fff', opacity: 0.8 }}>Attente du lancement...</div>}
                                    {logs.map((log, i) => (
                                        <div key={i} style={{ marginBottom: '0.4rem', lineBreak: 'anywhere' }}>
                                            <span style={{ color: '#999', marginRight: '0.5rem' }}>[{log.timestamp}]</span>
                                            <span style={{
                                                color: log.type === 'error' ? '#ff3131' :
                                                    log.type === 'success' ? '#00ff9d' :
                                                        log.type === 'warn' ? '#ffcc00' :
                                                            log.type === 'debug' ? '#00d4ff' : '#00ff9d'
                                            }}>
                                                {log.message}
                                            </span>
                                        </div>
                                    ))}
                                    <div ref={logEndRef} />
                                </div>
                            </div>

                            <div className="glass" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', height: '500px' }}>
                                <h3 style={{ fontSize: '1rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-muted)' }}>
                                    <Mail size={18} /> Contacts extraits ({scrapedEmails.length})
                                </h3>
                                <div style={{
                                    flex: 1,
                                    overflowY: 'auto',
                                    background: 'rgba(255,255,255,0.02)',
                                    borderRadius: '0.75rem',
                                    padding: '0.5rem',
                                    border: '1px solid var(--border)'
                                }}>
                                    {scrapedEmails.length === 0 && <div style={{ padding: '1rem', color: 'var(--text-muted)', textAlign: 'center' }}>Aucun contact trouvé pour le moment.</div>}
                                    {scrapedEmails.map((se, i) => (
                                        <motion.div
                                            initial={{ opacity: 0, x: 20 }}
                                            animate={{ opacity: 1, x: 0 }}
                                            key={i}
                                            style={{
                                                display: 'flex',
                                                flexDirection: 'column',
                                                padding: '0.75rem 1rem',
                                                borderBottom: '1px solid var(--border)',
                                                background: 'rgba(255,255,255,0.01)',
                                                marginBottom: '0.5rem',
                                                borderRadius: '0.5rem'
                                            }}
                                        >
                                            <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
                                                {se.image ? (
                                                    <img src={se.image} alt="" style={{ width: '50px', height: '35px', objectFit: 'cover', borderRadius: '4px', border: '1px solid var(--border)' }} />
                                                ) : (
                                                    <div style={{ width: '50px', height: '35px', background: 'var(--border)', borderRadius: '4px' }} />
                                                )}
                                                <div style={{ flex: 1 }}>
                                                    <span style={{ fontWeight: '600', fontSize: '0.9rem', marginBottom: '0.25rem', display: 'block' }}>{se.name}</span>
                                                    <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                                                        {se.email && (
                                                            <span style={{ color: 'var(--accent)', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                                                <Mail size={12} /> {se.email}
                                                            </span>
                                                        )}
                                                        {se.phone && (
                                                            <span style={{ color: 'var(--primary)', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                                                <Globe size={12} /> {se.phone}
                                                            </span>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                        </motion.div>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </div>
                } />
            </Routes>

            <footer style={{ marginTop: '4rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.875rem', paddingBottom: '2rem' }}>
                <p>© 2025 DATAtourisme Explorer • Données ouvertes</p>
            </footer>
        </div>
    );
}

export default App;
