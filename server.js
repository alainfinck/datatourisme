import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());

// Health check endpoint - MUST be before SPA fallback
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        node_version: process.version,
        env: process.env.NODE_ENV,
        port: process.env.PORT
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
const saveResults = (newResults) => {
    const publicPath = path.join(__dirname, 'public');
    if (!fs.existsSync(publicPath)) fs.mkdirSync(publicPath);

    let existing = [];
    try {
        if (fs.existsSync(path.join(publicPath, 'contacts.json'))) {
            existing = JSON.parse(fs.readFileSync(path.join(publicPath, 'contacts.json'), 'utf8'));
        }
    } catch (e) { }

    const merged = [...existing];
    newResults.forEach(nr => {
        const idx = merged.findIndex(r => r.name === nr.name);
        if (idx === -1) merged.push(nr);
        else merged[idx] = { ...merged[idx], ...nr };
    });

    fs.writeFileSync(path.join(publicPath, 'contacts.json'), JSON.stringify(merged, null, 2));
    fs.writeFileSync(path.join(publicPath, 'emails.json'), JSON.stringify(merged, null, 2));

    const csvHeader = 'Nom,Email,Telephone,ImageURL\n';
    const csvRows = merged.map(r => `"${r.name}","${r.email || ''}","${r.phone || ''}","${r.image || ''}"`).join('\n');
    fs.writeFileSync(path.join(publicPath, 'contacts.csv'), csvHeader + csvRows);
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
        const startUrl = config.url || 'https://explore.datatourisme.fr/?type=%5B%22%2FLieu%22%5D';
        const results = [];
        let browser = null;

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

            let i = 0;
            while (i < maxItems) {
                if (!isScraping) {
                    log('Arrêt du scraping demandé.', 'warn');
                    break;
                }

                try {
                    await page.waitForSelector('#scrollContainer h3', { timeout: 10000 });
                    
                    // On récupère toutes les cartes de la liste
                    const items = await page.$$('#scrollContainer > div');
                    
                    if (i >= items.length) {
                        log(`Besoin de plus d'éléments (actuel: ${items.length}, cible: ${i + 1}), défilement...`, 'info');
                        await page.evaluate(() => window.scrollBy(0, 3000));
                        await new Promise(r => setTimeout(r, 4000)); // Plus de temps pour charger
                        continue;
                    }

                    const item = items[i];
                    const name = await item.evaluate(el => {
                        const h3 = el.querySelector('h3');
                        return h3 ? h3.innerText.trim() : 'Inconnu';
                    });

                    log(`Analyse de l'élément ${i + 1}/${maxItems} : "${name}"`, 'info');
                    socket.emit('status', {
                        message: `Analyse de : ${name}`,
                        progress: Math.round(10 + (i / maxItems) * 85)
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
                            
                            // Extract main image URL - on cherche spécifiquement une image dans le panneau latéral ou dans la carte
                            let image = null;
                            const imgInPanel = document.querySelector('aside img, .main-image img, .gallery img, [role="dialog"] img');
                            if (imgInPanel) image = imgInPanel.src;
                            
                            // Si pas d'image dans le panneau, on regarde si on l'a sur la carte
                            if (!image) {
                                const activeItemImg = document.querySelector('#scrollContainer img[src*="http"]');
                                if (activeItemImg) image = activeItemImg.src;
                            }

                            // Extract all emails
                            const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
                            const emails = bodyText.match(emailRegex) || [];
                            const uniqueEmails = [...new Set(emails.map(e => e.toLowerCase()))];
                            
                            // Extract all phones (French format)
                            const phoneRegex = /(?:(?:\+|00)33|0)\s*[1-9](?:[\s.-]*\d{2}){4}/g;
                            const phones = bodyText.match(phoneRegex) || [];
                            const uniquePhones = [...new Set(phones.map(p => p.replace(/\s+/g, '')))];
                            
                            return { 
                                email: uniqueEmails.join(', '), 
                                phone: uniquePhones.join(', '),
                                image: image
                            };
                        });

                        // Si on a des infos et une image, on peut potentiellement break plus tôt
                        if ((contactInfo.email || contactInfo.phone) && contactInfo.image) {
                            break;
                        }
                        
                        await new Promise(r => setTimeout(r, 800)); // Poll every 800ms
                    }

                    if (contactInfo.email || contactInfo.phone) {
                        const result = { name, email: contactInfo.email, phone: contactInfo.phone, image: contactInfo.image };
                        log(`Contact trouvé pour "${name}"`, 'success');
                        results.push(result);
                        socket.emit('newEmail', result);
                        saveResults([result]);
                    } else {
                        log(`Aucun contact pour "${name}" (Image: ${contactInfo.image ? 'OK' : 'KO'}).`, 'warn');
                    }

                    // On ferme le panneau latéral impérativement avant de passer à la suite
                    const closeButton = await page.$('button[title*="Close"], button[aria-label*="Close"], aside button');
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

        } catch (error) {
            log(`Erreur fatale : ${error.message}`, 'error');
            socket.emit('error', error.message);
        } finally {
            if (browser) await browser.close();
            isScraping = false;
        }
    });

    socket.on('stopScraping', () => {
        isScraping = false;
        console.log('Stop requested');
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

// Standard catch-all handler for SPA
app.get(/.*/, (req, res, next) => {
    // EXACT match for root or any path that doesn't look like a file/socket.io
    const isSocket = req.path.startsWith('/socket.io');
    const hasExtension = req.path.includes('.');
    
    if (isSocket) {
        console.log(`[PASSING] Socket.io request: ${req.url}`);
        return next();
    }
    
    if (hasExtension) {
        console.log(`[404] File not found: ${req.url}`);
        return next(); // Fall through to Express default 404
    }

    console.log(`[SPA Fallback] Serving index.html for: ${req.url}`);
    const indexPath = path.join(__dirname, 'dist', 'index.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        console.log(`[CRITICAL] index.html not found at: ${indexPath}`);
        res.status(404).send('Application non compilée. Veuillez lancer "npm run build".');
    }
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, '0.0.0.0', () => {
    console.log('========================================');
    console.log(` SERVER STARTED SUCCESSFULLY `);
    console.log(` URL: http://0.0.0.0:${PORT} `);
    console.log(` NODE_ENV: ${process.env.NODE_ENV} `);
    console.log('========================================');
});
