import { Actor } from "apify";
import { chromium } from "playwright";
import fs from "fs";
import os from "os";
import path from "path";
import fetch from "node-fetch"; // Used for Google Sheets fallback

// ============================================================================
// Google Sheets Utilities (Ported from googleSheets.js)
// ============================================================================

function extractSpreadsheetId(url) {
    const match = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
    if (!match) throw new Error("Invalid Google Sheets URL");
    return match[1];
}

async function fetchCSVFallback(spreadsheetId) {
    const csvUrl = "https://docs.google.com/spreadsheets/d//export?format=csv";
    const res = await fetch(csvUrl);
    if (!res.ok) {
        throw new Error("Failed to fetch CSV export. Status: ");
    }
    return await res.text();
}

function parseCSV(rawCSV) {
    return rawCSV.split("\n")
        .map(row => {
            const parts = [];
            let inQuote = false;
            let current = "";
            for (let i = 0; i < row.length; i++) {
                const ch = row[i];
                if (ch === '\"') {
                    inQuote = !inQuote;
                } else if (ch === "," && !inQuote) {
                    parts.push(current);
                    current = "";
                } else {
                    current += ch;
                }
            }
            parts.push(current);
            return parts.map(val => val.trim().replace(/^"|"$/g, ""));
        });
}

async function fetchViaAPI(spreadsheetId, apiKey) {
    const apiUrl = "https://sheets.googleapis.com/v4/spreadsheets//values/A:Z?key=";
    const res = await fetch(apiUrl);
    const data = await res.json();
    if (data.error) {
        throw new Error(data.error.message || "API error");
    }
    return data.values || [];
}

async function getSpreadsheetData(sheetUrl, apiKey) {
    const spreadsheetId = extractSpreadsheetId(sheetUrl);
    if (apiKey) {
        try {
            console.log("Attempting to fetch sheet data via API...");
            return await fetchViaAPI(spreadsheetId, apiKey);
        } catch (err) {
            console.warn("API fetch failed: . Falling back to CSV export.");
        }
    } else {
        console.log("No Google API Key configured. Using public CSV export fallback.");
    }
    
    const rawCSV = await fetchCSVFallback(spreadsheetId);
    return parseCSV(rawCSV);
}

// ============================================================================
// Core Messenger Utilities (Ported from autoMessenger.js)
// ============================================================================

function parseRawCookies(rawString) {
    if (!rawString || !rawString.trim()) return { cookies: [], origins: [] };
    const cookies = rawString.split(";")
        .map(c => c.trim()).filter(c => c.length > 0)
        .map(c => {
            const idx = c.indexOf("=");
            if (idx === -1) return null;
            return { name: c.substring(0, idx).trim(), value: c.substring(idx + 1).trim(), domain: ".x.com", path: "/", secure: true, sameSite: "Lax" };
        }).filter(c => c !== null);
    return { cookies, origins: [] };
}

function sanitizeUsername(input) {
    return input
        .replace(/https?:\/\/(www\.)?(x\.com|twitter\.com)\//i, "")
        .replace(/^@/, "")
        .split("/")[0]
        .trim()
        .toLowerCase();
}

function randomDelay(minMs, maxMs) {
    return new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs));
}

// Anti-bot stealth scripts
const stealthScripts = "
    // Overwrite the navigator.webdriver property
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    
    // Spoof plugins
    Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3] // Dummy array to simulate plugins
    });
    
    // Simulate window.chrome
    window.chrome = { runtime: {} };
    
    // Override permissions query
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = parameters => (
        parameters.name === 'notifications' ?
            Promise.resolve({ state: Notification.permission }) :
            originalQuery(parameters)
    );
";

async function humanType(page, selector, text) {
    const el = page.locator(selector).first();
    await el.waitFor({ state: "visible", timeout: 10000 });
    await el.click();
    await randomDelay(300, 600);

    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        const delay = char === " "
            ? Math.floor(Math.random() * 180 + 80)
            : Math.floor(Math.random() * 90 + 40);
        await page.keyboard.type(char, { delay });
        if (Math.random() < 0.03) await randomDelay(300, 700);
    }
}

async function safeGoto(page, url, timeout = 45000) {
    try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    } catch (e) {
        if (e.message && e.message.includes("Timeout")) {
            console.warn("Navigation timeout for  — continuing anyway.");
        } else {
            throw e;
        }
    }
}

async function handlePinIfRequired(page, pinCode) {
    try {
        let isPinScreen = false;
        for (let attempt = 0; attempt < 30; attempt++) {
            const currentUrl = page.url();
            const pinContainer = await page.[data-testid="pin-code-input-container"];
            if (currentUrl.includes("/i/chat/pin") || pinContainer) {
                isPinScreen = true;
                break;
            }
            await randomDelay(400, 500);
        }

        if (isPinScreen) {
            console.log("?? DM PIN Recovery screen detected. Attempting to enter PIN...");
            if (!pinCode) {
                console.warn("PIN screen detected but no PIN provided — skipping.");
                return;
            }
            
            await page.waitForSelector('[data-testid="pin-code-input-container"]', { timeout: 8000 });
            await randomDelay(800, 1500);

            const digits = pinCode.toString().split("");
            const inputs = await page.('[data-testid="pin-code-input-container"] input[type="text"]');
            for (let i = 0; i < inputs.length && i < digits.length; i++) {
                await inputs[i].click();
                await inputs[i].type(digits[i], { delay: 100 });
                await randomDelay(1500, 2500);
            }
            await randomDelay(1000, 2000);
            await page.keyboard.press("Enter");
            await randomDelay(3000, 4500);
        }
    } catch (e) {
        console.warn("PIN handler error (non-fatal):", e.message);
    }
}

function parsePairs(rows) {
    if (rows.length === 0) return [];
    const firstCell = (rows[0] && rows[0][0] || "").toLowerCase();
    const hasHeader = firstCell.includes("username") || firstCell.includes("profile") ||
                      firstCell.includes("url") || firstCell.includes("link") ||
                      firstCell.includes("@");
    const startIndex = hasHeader && !(firstCell.includes("x.com") || firstCell.includes("twitter.com") || firstCell.startsWith("@")) ? 1 : 0;
    return rows.slice(startIndex)
        .map(row => ({
            rawTarget: (row[0] || "").trim(),
            username: sanitizeUsername((row[0] || "").trim()),
            message: (row[1] || "").trim()
        }))
        .filter(r => r.username && r.message);
}

// Function to generate bezier curve points for mouse movement
function generateBezierCurve(start, end, control1, control2, steps) {
    const points = [];
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = Math.pow(1 - t, 3) * start.x + 3 * Math.pow(1 - t, 2) * t * control1.x + 3 * (1 - t) * Math.pow(t, 2) * control2.x + Math.pow(t, 3) * end.x;
        const y = Math.pow(1 - t, 3) * start.y + 3 * Math.pow(1 - t, 2) * t * control1.y + 3 * (1 - t) * Math.pow(t, 2) * control2.y + Math.pow(t, 3) * end.y;
        points.push({ x, y });
    }
    return points;
}

async function moveMouseSmoothly(page, targetX, targetY) {
    // Current rough estimate of mouse position (center screen if unknown)
    const startX = Math.random() * 800 + 100;
    const startY = Math.random() * 600 + 100;
    
    // Create somewhat random control points for realistic curve
    const control1 = { 
        x: startX + (targetX - startX) * 0.3 + (Math.random() - 0.5) * 100,
        y: startY + (targetY - startY) * 0.3 + (Math.random() - 0.5) * 100
    };
    const control2 = { 
        x: startX + (targetX - startX) * 0.7 + (Math.random() - 0.5) * 100,
        y: startY + (targetY - startY) * 0.7 + (Math.random() - 0.5) * 100
    };

    const steps = Math.floor(Math.random() * 10) + 10; // 10-20 steps
    const points = generateBezierCurve({x: startX, y: startY}, {x: targetX, y: targetY}, control1, control2, steps);
    
    for (const p of points) {
        await page.mouse.move(p.x, p.y);
        await randomDelay(10, 30); // Fast micro-delays between step
    }
}

async function sendDirectMessage(page, username, message, pinCode) {
    await safeGoto(page, "https://x.com/");
    
    // Add jitter simulating profile reading
    await randomDelay(2000, 4500);

    await handlePinIfRequired(page, pinCode);

    let msgBtn = null;
    try {
        await page.waitForSelector('[data-testid="sendDMFromProfile"]', { timeout: 12000 });
        msgBtn = page.locator('[data-testid="sendDMFromProfile"]').first();
    } catch (e) {
        throw new Error("Message button not found — account may have DMs disabled or restricted.");
    }

    const btnBox = await msgBtn.boundingBox();
    if (btnBox) {
        await moveMouseSmoothly(page, btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2);
    }
    await msgBtn.click();
    
    // Smart wait: Wait for either the composer or the PIN screen, up to 7 seconds
    try {
        await Promise.race([
            page.waitForSelector('[data-testid="pin-code-input-container"]', { state: "visible", timeout: 7000 }),
            page.waitForURL(url => url.href.includes("/i/chat/pin"), { timeout: 7000 })
        ]);
    } catch (e) {
        console.log("7s wait for PIN screen finished.");
    }

    let isPinScreen = false;
    const currentUrl = page.url();
    const pinContainer = await page.[data-testid="pin-code-input-container"];
    if (currentUrl.includes("/i/chat/pin") || pinContainer) {
        isPinScreen = true;
    }

    if (isPinScreen) {
        console.log("?? DM PIN Recovery screen detected. Attempting to enter PIN...");
        if (pinCode) {
            await page.waitForSelector('[data-testid="pin-code-input-container"]', { timeout: 8000 });
            await randomDelay(800, 1500);

            const digits = pinCode.toString().split("");
            const inputs = await page.('[data-testid="pin-code-input-container"] input[type="text"]');
            for (let i = 0; i < inputs.length && i < digits.length; i++) {
                await inputs[i].click();
                await inputs[i].type(digits[i], { delay: 100 });
                await randomDelay(1500, 2500);
            }
            await randomDelay(1000, 2000);
            await page.keyboard.press("Enter");
            await randomDelay(3000, 4500);
        } else {
            console.warn("PIN screen detected but no PIN provided — skipping.");
        }
    }

    await page.waitForSelector('[data-testid="dm-composer-textarea"]', { timeout: 15000 });
    await randomDelay(800, 1500);

    await humanType(page, '[data-testid="dm-composer-textarea"]', message);
    await randomDelay(1000, 2000);

    const sendBtn = page.locator('[data-testid="dm-composer-send-button"]').first();
    let sent = false;
    try {
        await sendBtn.waitFor({ state: "visible", timeout: 3000 });
        const isEnabled = await sendBtn.isEnabled();
        if (isEnabled) {
            const sendBox = await sendBtn.boundingBox();
            if (sendBox) {
                await moveMouseSmoothly(page, sendBox.x + sendBox.width / 2, sendBox.y + sendBox.height / 2);
            }
            await sendBtn.click();
            sent = true;
        }
    } catch (e) {
        console.warn("Send button not clickable or timeout, trying Enter fallback...", e.message);
    }

    if (!sent) {
        await page.keyboard.press("Enter");
        console.log("Pressed Enter to send.");
    }
    await randomDelay(2000, 3500);
}

// ============================================================================
// Main Execution
// ============================================================================

Actor.main(async () => {
    const input = await Actor.getInput();
    const { 
        sheetUrl, 
        cookieString, 
        auth_token, 
        ct0, 
        googleApiKey, 
        messagesPerRun = 20, 
        delaySeconds = 12, 
        pinCode 
    } = input;

    if (!sheetUrl) throw new Error("sheetUrl is required in input.");

    // Parse Cookies
    let storageState = { cookies: [], origins: [] };
    if (auth_token && ct0) {
        storageState.cookies.push({ name: "auth_token", value: auth_token, domain: ".x.com", path: "/", secure: true, sameSite: "None" });
        storageState.cookies.push({ name: "ct0", value: ct0, domain: ".x.com", path: "/", secure: true, sameSite: "Lax" });
    } else if (cookieString) {
        storageState = parseRawCookies(cookieString);
    }
    
    if (storageState.cookies.length === 0) {
        throw new Error("No authentication provided. Please provide auth_token and ct0, or a full cookieString.");
    }

    // Fetch and Parse Sheet Data
    console.log("Fetching data from sheet: ");
    const rows = await getSpreadsheetData(sheetUrl, googleApiKey);
    const allPairs = parsePairs(rows);
    
    const match = sheetUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
    const sheetId = match ? match[1] : sheetUrl;

    // Deduplication Logic using Apify KeyValueStore
    const kvStore = await Actor.openKeyValueStore();
    const historyKey = "MSG_HISTORY_";
    let messageHistory = await kvStore.getValue(historyKey) || [];
    const sentUsers = new Set(messageHistory.map(username => username.toLowerCase()));

    const pendingTargets = allPairs.filter(p => !sentUsers.has(p.username.toLowerCase()));
    const targets = pendingTargets.slice(0, messagesPerRun);

    if (targets.length === 0) {
        console.log("No new usernames left to message in the sheet.");
        return;
    }
    
    console.log("Found  total pending targets. Will process  in this run.");

    // Browser Initialization (Brave Shields via Persistent Context)
    const bravePath = "/usr/bin/brave-browser"; 
    
    // We must use a unique temp dir for the profile to avoid lockfile issues
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "playwright-messenger-"));
    
    // Write cookies into the temp profile
    const cookiesJsonPath = path.join(userDataDir, "cookies.json");
    fs.writeFileSync(cookiesJsonPath, JSON.stringify(storageState));

    console.log("Launching browser...");
    const browserContext = await chromium.launchPersistentContext(userDataDir, {
        executablePath: bravePath,
        headless: false, // User requested visible if possible
        viewport: { width: 1920, height: 1080 },
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        locale: "en-US",
        timezoneId: "America/New_York",
        args: [
            "--disable-blink-features=AutomationControlled",
            "--no-sandbox"
        ]
    });

    const page = browserContext.pages().length > 0 ? browserContext.pages()[0] : await browserContext.newPage();
    
    // Inject stealth scripts
    await page.addInitScript(stealthScripts);

    // Graceful abort handler setup
    Actor.on("aborting", async () => {
        console.log("Actor is aborting. Cleaning up resources...");
        try {
            await browserContext.close();
            fs.rmSync(userDataDir, { recursive: true, force: true });
        } catch(e){}
        await new Promise(resolve => setTimeout(resolve, 1000));
        await Actor.exit();
    });

    try {
        // Session Warm-up
        console.log("Navigating to home page for session warm-up...");
        await safeGoto(page, "https://x.com/home", 60000);
        await randomDelay(3000, 5000);

        // Process Targets
        for (let i = 0; i < targets.length; i++) {
            const { username, message } = targets[i];
            console.log("[/] Attempting to message @...");
            
            try {
                await sendDirectMessage(page, username, message, pinCode);
                
                // Track success
                messageHistory.push(username);
                await kvStore.setValue(historyKey, messageHistory);
                
                await Actor.pushData({
                    username,
                    message,
                    status: "sent",
                    timestamp: new Date().toISOString()
                });

                console.log("? Successfully sent to @");
            } catch (err) {
                console.error("? Failed to message @: ");
                await Actor.pushData({
                    username,
                    message,
                    status: "error",
                    error: err.message,
                    timestamp: new Date().toISOString()
                });
            }

            if (i < targets.length - 1) {
                const minDelay = Math.max(5000, (delaySeconds - 3) * 1000);
                const maxDelay = (delaySeconds + 5) * 1000;
                console.log("Waiting for next message...");
                await randomDelay(minDelay, maxDelay);
            }
        }
    } finally {
        console.log("Closing browser and cleaning up...");
        await browserContext.close();
        fs.rmSync(userDataDir, { recursive: true, force: true });
    }
});
