import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sqlite3 from 'sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONTACTS_JSON_PATH = path.join(__dirname, 'public', 'contacts.json');
const CONTACTS_CSV_PATH = path.join(__dirname, 'public', 'contacts.csv');
const EMAILS_JSON_PATH = path.join(__dirname, 'public', 'emails.json');

const db = new sqlite3.Database(path.join(__dirname, 'data', 'database.sqlite'));

// Ensure data directory exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

// Initialize DB schema
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        start_url TEXT,
        start_time DATETIME,
        end_time DATETIME,
        items_count INTEGER,
        csv_path TEXT,
        status TEXT
    )`);
});

// Initial Migration: Populate sessions with existing CSVs
const initialMigration = () => {
    const publicPath = path.join(__dirname, 'public');
    if (!fs.existsSync(publicPath)) return;

    const files = fs.readdirSync(publicPath).filter(f => f.endsWith('.csv') && !f.startsWith('._'));
    
    db.get("SELECT COUNT(*) as count FROM sessions", (err, row) => {
        if (!err && row.count === 0) {
            console.log('Running initial migration for existing CSVs...');
            files.forEach(file => {
                const filePath = path.join(publicPath, file);
                const content = fs.readFileSync(filePath, 'utf8');
                const lines = content.split('\n').filter(l => l.trim()).length - 1; // Subtract header
                
                db.run(
                    "INSERT INTO sessions (start_url, start_time, end_time, items_count, csv_path, status) VALUES (?, ?, ?, ?, ?, ?)",
                    ['Existing File Migration', new Date().toISOString(), new Date().toISOString(), lines, file, 'completed']
                );
            });
        }
    });
};
initialMigration();

const app = express();
app.use(cors());

// API to list CSV files
app.get('/csv-files', (req, res) => {
    const publicPath = path.join(__dirname, 'public');
    if (!fs.existsSync(publicPath)) return res.json([]);
    const files = fs.readdirSync(publicPath).filter(f => f.endsWith('.csv') && !f.startsWith('._'));
    res.json(files);
});

// API to get scraping history
app.get('/sessions', (req, res) => {
    db.all("SELECT * FROM sessions ORDER BY start_time DESC", (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Health check endpoint - First priority
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        node_version: process.version,
        env: process.env.NODE_ENV,
        port: process.env.PORT || 3000
    });
});

// Logging middleware for diagnostic
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    // Ne pas logger les requêtes de polling trop fréquentes pour garder les logs lisibles
    if (!req.url.includes('transport=polling')) {
        console.log(`${timestamp} - ${req.method} ${req.url}`);
    }
    next();
});

console.log('Environment:', {
    NODE_ENV: process.env.NODE_ENV,
    PORT: process.env.PORT
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

let isScraping = false;

// Helper to save results to JSON and CSV
const saveResults = (newResults, clear = false, filename = 'contacts.csv') => {
    const publicPath = path.join(__dirname, 'public');
    if (!fs.existsSync(publicPath)) fs.mkdirSync(publicPath);

    const jsonFilename = filename.replace('.csv', '.json');
    const jsonPath = path.join(publicPath, jsonFilename);

    let existing = [];
    if (!clear) {
        try {
            if (fs.existsSync(jsonPath)) {
                existing = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            }
        } catch (e) { }
    }

    const merged = [...existing];
    newResults.forEach(nr => {
        const idx = merged.findIndex(r => r.name === nr.name);
        if (idx === -1) merged.push(nr);
        else merged[idx] = { ...merged[idx], ...nr }; // Update existing
    });

    fs.writeFileSync(jsonPath, JSON.stringify(merged, null, 2));
    
    // Also update the main emails.json for backward compat if it's the default file
    if (filename === 'contacts.csv') {
        fs.writeFileSync(EMAILS_JSON_PATH, JSON.stringify(merged, null, 2));
    }

    const csvHeader = 'Nom,Email,Telephone,Adresse,GPS,ImageURL,SourceURL\n';
    const csvRows = merged.map(r => `"${r.name}","${r.email || ''}","${r.phone || ''}","${(r.address || '').replace(/"/g, '""')}","${r.gps || ''}","${r.image || ''}","${r.sourceUrl || ''}"`).join('\n');
    fs.writeFileSync(path.join(publicPath, filename), csvHeader + csvRows);
    return merged;
};

io.on('connection', (socket) => {
    console.log('Client connected - ID:', socket.id);

    socket.on('startScraping', async (config) => {
        console.log('Scraping start requested by client:', socket.id, 'with config:', config);
        if (isScraping) {
            socket.emit('error', 'Scraping already in progress');
            return;
        }

        isScraping = true;
        const maxItems = config.maxItems || 20;
        const startIndex = config.startIndex || 0;
        const startUrl = config.url || 'https://explore.datatourisme.fr/?type=%5B%22%2FLieu%22%5D';
        const mode = config.mode || 'append';
        const targetFilename = config.filename || 'contacts.csv';
        const results = [];
        let browser = null;

        if (mode === 'new') {
            const finalFilename = config.newFilename ? (config.newFilename.endsWith('.csv') ? config.newFilename : `${config.newFilename}.csv`) : targetFilename;
            console.log(`Mode "Nouveau fichier" détecté (${finalFilename}), réinitialisation...`);
            saveResults([], true, finalFilename); // Clear files
            config.filename = finalFilename; // Ensure we use this name for the rest of the session
        }

        let sessionId = null;
        const startTimeStr = new Date().toISOString();
        db.run(
            "INSERT INTO sessions (start_url, start_time, status, csv_path) VALUES (?, ?, ?, ?)",
            [startUrl, startTimeStr, 'running', config.filename || targetFilename],
            function(err) {
                if (!err) sessionId = this.lastID;
            }
        );

        const log = (msg, type = 'info') => {
            const timestamp = new Date().toLocaleTimeString();
            socket.emit('log', { timestamp, message: msg, type });
            console.log(`[${timestamp}] [${type.toUpperCase()}] ${msg}`);
        };

        try {
            log('Lancement du navigateur Puppeteer...', 'info');
            socket.emit('status', { message: 'Lancement du navigateur...', progress: 0 });

            browser = await puppeteer.launch({
                headless: "new",
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });

            const page = await browser.newPage();
            await page.setViewport({ width: 1280, height: 800 });

            log(`Navigation vers ${startUrl}...`, 'info');
            socket.emit('status', { message: `Navigation vers l'explorateur...`, progress: 5 });
            await page.goto(startUrl, { waitUntil: 'networkidle2', timeout: 60000 });

            log('Attente du chargement de la liste (#scrollContainer)...', 'info');
            await page.waitForSelector('#scrollContainer', { timeout: 30000 });
            socket.emit('status', { message: 'Extraction en cours...', progress: 10 });

            let i = startIndex;
            while (results.length < maxItems) {
                if (!isScraping) {
                    log('Arrêt du scraping demandé.', 'warn');
                    break;
                }

                try {
                    await page.waitForSelector('#scrollContainer h3', { timeout: 10000 });
                    
                    // Sélecteur robuste identifié via inspection
                    const items = await page.$$('#scrollContainer .infinite-scroll-component h3.font-bold');
                    
                    if (i >= items.length) {
                        log(`Besoin de plus d'éléments (actuel: ${items.length}, cible: ${i + 1}), défilement...`, 'info');
                        await page.evaluate(() => {
                            const container = document.querySelector('#scrollContainer');
                            if (container) {
                                container.scrollBy(0, 3000);
                            } else {
                                window.scrollBy(0, 3000);
                            }
                        });
                        await new Promise(r => setTimeout(r, 4000));
                        continue;
                    }

                    const item = items[i];
                    const name = await item.evaluate(el => el ? el.innerText.trim() : 'Inconnu');

                    log(`Analyse de l'élément ${i + 1} (Résultat: ${results.length + 1}/${maxItems}) : "${name}"`, 'info');
                    socket.emit('status', {
                        message: `Analyse de : ${name}`,
                        progress: Math.round(10 + (results.length / maxItems) * 85),
                        currentIndex: i + 1
                    });

                    // Scroll smooth jusqu'à l'élément
                    await item.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'smooth' }));
                    await new Promise(r => setTimeout(r, 1000));

                    // On clique sur le titre h3 pour ouvrir le panneau latéral
                    const h3 = await item.$('h3');
                    if (h3) {
                        await h3.click();
                    } else {
                        await item.click();
                    }

                    // Attendre que le panneau latéral s'affiche et se remplisse
                    log(`Attente des informations pour "${name}"...`, 'info');
                    
                    let contactInfo = { email: null, phone: null, image: null };
                    const startTime = Date.now();
                    const timeout = 8000; // 8s max wait pour le panneau

                    while (Date.now() - startTime < timeout) {
                        contactInfo = await page.evaluate(() => {
                            const bodyText = document.body.innerText;
                            
                            // Extract main image URL
                            let image = null;
                            const imgInPanel = document.querySelector('div[role="dialog"] img[src*=".webp"], aside img, .main-image img');
                            
                            // Ignorer l'image si c'est un placeholder (ex: SVG ou petite icône)
                            if (imgInPanel && !imgInPanel.src.includes('data:image/svg+xml')) {
                                image = imgInPanel.src;
                            }
                            
                            // Si pas d'image dans le panneau, on regarde si on l'a sur la carte
                            if (!image) {
                                const activeItemImg = document.querySelector('.infinite-scroll-component img[src*="http"]');
                                if (activeItemImg && !activeItemImg.src.includes('data:image/svg+xml')) {
                                    image = activeItemImg.src;
                                }
                            }

                            // Extract all emails
                            const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
                            const emails = bodyText.match(emailRegex) || [];
                            const uniqueEmails = [...new Set(emails.map(e => e.toLowerCase()))];
                            
                            // Extract all phones (French format)
                            const phoneRegex = /(?:(?:\+|00)33|0)\s*[1-9](?:[\s.-]*\d{2}){4}/g;
                            const phones = bodyText.match(phoneRegex) || [];
                            const uniquePhones = [...new Set(phones.map(p => p.replace(/\s+/g, '')))];

                            // Extract GPS from Google Maps links
                            let gps = null;
                            const mapLinks = Array.from(document.querySelectorAll('a[href*="google.com/maps"], a[href*="goo.gl/maps"]'));
                            for (const link of mapLinks) {
                                const href = link.href;
                                const match = href.match(/query=([0-9.-]+)%2C([0-9.-]+)/) || 
                                              href.match(/query=([0-9.-]+),([0-9.-]+)/) ||
                                              href.match(/destination=([0-9.-]+)%2C([0-9.-]+)/) ||
                                              href.match(/destination=([0-9.-]+),([0-9.-]+)/) ||
                                              href.match(/@([0-9.-]+),([0-9.-]+)/);
                                if (match) {
                                    gps = `${match[1]}, ${match[2]}`;
                                    break;
                                }
                            }

                            // Extract address - Look for address block or city/zip code patterns
                            let address = null;
                            const selectors = ['[class*="address"]', 'address', '.location', '.info-block', 'aside p'];
                            for (const selector of selectors) {
                                const el = document.querySelector(selector);
                                if (el && /[0-9]{5}/.test(el.innerText)) { // Must contain a zip code to be likely an address
                                    address = el.innerText.trim().split('\n')[0]; // Take first line
                                    break;
                                }
                            }
                            
                            return { 
                                email: uniqueEmails.join(', '), 
                                phone: uniquePhones.join(', '),
                                image: image,
                                gps: gps,
                                address: address
                            };
                        });

                        // Si on a des infos et une image, on peut potentiellement break plus tôt
                        if ((contactInfo.email || contactInfo.phone) && contactInfo.image) {
                            break;
                        }
                        
                        await new Promise(r => setTimeout(r, 800)); // Poll every 800ms
                    }

                    const sourceUrl = page.url();

                    if (contactInfo.email || contactInfo.phone || contactInfo.address) {
                        const result = { 
                            name, 
                            email: contactInfo.email, 
                            phone: contactInfo.phone, 
                            image: contactInfo.image,
                            address: contactInfo.address,
                            gps: contactInfo.gps,
                            sourceUrl: sourceUrl
                        };
                        log(`Contact trouvé pour "${name}"`, 'success');
                        results.push(result);
                        socket.emit('newEmail', result);
                        saveResults([result], false, config.filename || targetFilename);
                    } else {
                        log(`Aucun contact pour "${name}" (Image: ${contactInfo.image ? 'OK' : 'KO'}).`, 'warn');
                    }

                    // On ferme le panneau latéral impérativement avant de passer à la suite
                    const closeButton = await page.$('button[aria-label="Close menu"], button[title*="Close"], aside button');
                    if (closeButton) {
                        await closeButton.click();
                        await new Promise(r => setTimeout(r, 1000));
                    } else {
                        await page.keyboard.press('Escape');
                        await new Promise(r => setTimeout(r, 1000));
                    }

                } catch (err) {
                    log(`Erreur sur l'élément ${i + 1} : ${err.message}`, 'error');
                    await page.keyboard.press('Escape').catch(() => { });
                    await new Promise(r => setTimeout(r, 1000));
                }
                
                i++;
            }

            log('Scraping terminé !', 'success');
            socket.emit('status', { message: 'Scraping terminé !', progress: 100 });
            socket.emit('finished', results);

            if (sessionId) {
                db.run(
                    "UPDATE sessions SET end_time = ?, items_count = ?, status = ? WHERE id = ?",
                    [new Date().toISOString(), results.length, 'completed', sessionId]
                );
            }

        } catch (error) {
            log(`Erreur fatale : ${error.message}`, 'error');
            socket.emit('error', error.message);
            if (sessionId) {
                db.run(
                    "UPDATE sessions SET end_time = ?, items_count = ?, status = ? WHERE id = ?",
                    [new Date().toISOString(), results.length, 'error', sessionId]
                );
            }
        } finally {
            if (browser) await browser.close();
            isScraping = false;
        }
    });

    socket.on('stopScraping', () => {
        isScraping = false;
        console.log('Stop requested');
        // We don't have easy access to sessionId here unless we scope it outside
        // For now, let's keep it simple. The startScraping loop will break and final block will execute.
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected');
    });
});

// Explicitly handle socket.io requests at the app level to be sure they pass through
app.use('/socket.io', (req, res, next) => {
    // These should be intercepted by socket.io-server via httpServer
    // But we use this to log if it's reaching Express
    console.log(`[Socket.io Debug] Request: ${req.method} ${req.url}`);
    next();
});

// Middleware for static files
app.use(express.static(path.join(__dirname, 'dist'), { index: false })); // index: false to let catch-all handle /
app.use(express.static(path.join(__dirname, 'public')));

// Standard catch-all handler for SPA - Defined AFTER all other specific routes
app.use((req, res, next) => {
    // Only handle GET requests for SPA fallback
    if (req.method !== 'GET') return next();

    // If it's a file request that reached here, it's a 404
    if (req.path.includes('.') && !req.path.endsWith('.json') && !req.path.endsWith('.csv')) {
        return next();
    }
    
    // SPA Fallback
    const indexPath = path.join(__dirname, 'dist', 'index.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.status(404).send('Application non compilée. Veuillez lancer "npm run build".');
    }
});

const PORT = process.env.PORT || 8080;

httpServer.listen(PORT, '0.0.0.0', () => {
    console.log('========================================');
    console.log(` SERVER STARTED SUCCESSFULLY `);
    console.log(` URL: http://0.0.0.0:${PORT} `);
    console.log(` NODE_ENV: ${process.env.NODE_ENV} `);
    console.log('========================================');
});
