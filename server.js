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
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

let isScraping = false;

io.on('connection', (socket) => {
    console.log('Client connected - ID:', socket.id);

    socket.on('startScraping', async (config) => {
        console.log('Scraping start requested by client:', socket.id, 'with config:', config);
        if (isScraping) {
            console.log('Scraping already in progress, rejecting request from:', socket.id);
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

            for (let i = 0; i < maxItems; i++) {
                if (!isScraping) {
                    log('Arrêt du scraping demandé par l\'utilisateur.', 'warn');
                    break;
                }

                try {
                    // Re-fetch items to avoid stale handles
                    await page.waitForSelector('#scrollContainer h3', { timeout: 10000 });
                    const items = await page.$$('#scrollContainer > div');

                    if (i >= items.length) {
                        log(`Fin des éléments visibles, défilement...`, 'info');
                        await page.evaluate(() => window.scrollBy(0, 2000));
                        await new Promise(r => setTimeout(r, 3000));
                        continue;
                    }

                    const item = items[i];

                    // Improved name extraction - try multiple selectors
                    const name = await item.evaluate(el => {
                        const h3 = el.querySelector('h3');
                        if (h3) return h3.innerText.trim();
                        const allText = el.innerText.split('\n')[0];
                        return allText || 'Inconnu';
                    });

                    log(`Analyse de l'élément ${i + 1}/${maxItems} : "${name}"`, 'info');
                    socket.emit('status', {
                        message: `Analyse de : ${name}`,
                        progress: Math.round(10 + (i / maxItems) * 85)
                    });

                    // Ensure item is in view and click
                    await item.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'smooth' }));
                    await new Promise(r => setTimeout(r, 1000));

                    // Click on the title or the whole item
                    const clickTarget = await item.$('h3') || item;
                    await clickTarget.click();

                    log(`Attente du chargement du panneau pour "${name}"...`, 'debug');
                    // Wait for the panel to appear - usually it contains a "Contact" section
                    await new Promise(r => setTimeout(r, 4000));

                    log(`Extraction des contacts pour "${name}"...`, 'debug');
                    const contactInfo = await page.evaluate(() => {
                        let email = null;
                        let phone = null;

                        // Strategy 1: Look for the specific DT/DD structure
                        const dts = Array.from(document.querySelectorAll('dt'));
                        const contactDt = dts.find(dt => dt.textContent.trim() === 'Contact');
                        if (contactDt) {
                            const dd = contactDt.nextElementSibling;
                            if (dd) {
                                const text = dd.innerText;
                                const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
                                if (emailMatch) email = emailMatch[0];

                                const phoneMatch = text.match(/(?:(?:\+|00)33|0)\s*[1-9](?:[\s.-]*\d{2}){4}/);
                                if (phoneMatch) phone = phoneMatch[0];
                            }
                        }

                        // Strategy 2: Look for mailto and tel links
                        if (!email) {
                            const mailto = document.querySelector('a[href^="mailto:"]');
                            if (mailto) email = mailto.href.replace('mailto:', '').split('?')[0];
                        }
                        if (!phone) {
                            const tel = document.querySelector('a[href^="tel:"]');
                            if (tel) phone = tel.href.replace('tel:', '').split('?')[0];
                        }

                        // Strategy 3: Scan all DIVs/leaf nodes for patterns
                        if (!email || !phone) {
                            const allDivs = Array.from(document.querySelectorAll('div, span, dd'));
                            for (const el of allDivs) {
                                if (el.children.length === 0) {
                                    const text = el.innerText;
                                    if (!email) {
                                        const eMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
                                        if (eMatch) email = eMatch[0];
                                    }
                                    if (!phone) {
                                        const pMatch = text.match(/(?:(?:\+|00)33|0)\s*[1-9](?:[\s.-]*\d{2}){4}/);
                                        if (pMatch) phone = pMatch[0];
                                    }
                                }
                            }
                        }

                        return { email, phone };
                    });

                    if (contactInfo.email || contactInfo.phone) {
                        const result = { name, email: contactInfo.email, phone: contactInfo.phone };
                        log(`${contactInfo.email ? 'E-mail' : ''}${contactInfo.email && contactInfo.phone ? ' & ' : ''}${contactInfo.phone ? 'Tel' : ''} trouvé pour "${name}"`, 'success');
                        results.push(result);
                        socket.emit('newEmail', result); // Renamed event to keep compatibility or should I rename it? Let's keep it for now but it sends the whole object
                    } else {
                        log(`Aucun contact trouvé pour "${name}".`, 'warn');
                    }

                    log(`Fermeture du panneau...`, 'debug');
                    const closeButton = await page.$('button[title*="Close"], button[aria-label*="Close"]');
                    if (closeButton) {
                        await closeButton.click();
                    } else {
                        await page.keyboard.press('Escape');
                    }
                    await new Promise(r => setTimeout(r, 1000));

                } catch (err) {
                    log(`Erreur sur l'élément ${i + 1} : ${err.message}`, 'error');
                    await page.keyboard.press('Escape').catch(() => { });
                    await new Promise(r => setTimeout(r, 1000));
                }
            }

            log('Sauvegarde des résultats...', 'info');
            const publicPath = path.join(__dirname, 'public');
            if (!fs.existsSync(publicPath)) fs.mkdirSync(publicPath);

            // Load existing contacts to merge
            let existingContacts = [];
            try {
                if (fs.existsSync(path.join(publicPath, 'contacts.json'))) {
                    existingContacts = JSON.parse(fs.readFileSync(path.join(publicPath, 'contacts.json'), 'utf8'));
                } else if (fs.existsSync(path.join(publicPath, 'emails.json'))) {
                    existingContacts = JSON.parse(fs.readFileSync(path.join(publicPath, 'emails.json'), 'utf8'));
                }
            } catch (e) { }

            // Merge results
            const mergedResults = [...existingContacts];
            results.forEach(newRes => {
                const idx = mergedResults.findIndex(r => r.name === newRes.name);
                if (idx === -1) {
                    mergedResults.push(newRes);
                } else {
                    mergedResults[idx] = { ...mergedResults[idx], ...newRes };
                }
            });

            // Save JSON
            fs.writeFileSync(path.join(publicPath, 'contacts.json'), JSON.stringify(mergedResults, null, 2));
            fs.writeFileSync(path.join(publicPath, 'emails.json'), JSON.stringify(mergedResults, null, 2)); // Keep for compatibility

            // Save CSV
            const csvHeader = 'Nom,Email,Telephone\n';
            const csvRows = mergedResults.map(r => `"${r.name}","${r.email || ''}","${r.phone || ''}"`).join('\n');
            fs.writeFileSync(path.join(publicPath, 'contacts.csv'), csvHeader + csvRows);

            log(`Scraping terminé ! ${results.length} nouveaux contacts récupérés. Fichier CSV généré.`, 'success');
            socket.emit('status', { message: 'Scraping terminé !', progress: 100 });
            socket.emit('finished', mergedResults);

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

const PORT = 3001;
httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Scraper server running on http://localhost:${PORT}`);
});
