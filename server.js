const fetch = require('node-fetch');
const WebSocket = require('ws');
const http = require('http');

// Telegram configuration
const TELEGRAM_BOT_TOKEN = '7817169168:AAF_zGQuYIQxDBiX6xiCAQZXq1r8fK90NVg';
const TELEGRAM_CHAT_ID = '-1002609143934';

const TURNOVER_THRESHOLD = 5000000; // 5 Million USDT 24h turnover
const CANDLE_HISTORY_LIMIT = 20;     // Last 20 candles for BB calculation
const WS_URL = 'wss://stream.bybit.com/v5/public/linear';
const MAX_TOPICS_PER_WS = 10;        // Bybit allows max 10 args per sub/unsub request

// In-memory candle storage: symbol -> Array of candle objects
// Candle object: { timestampMs: number, open: number, high: number, low: number, close: number, volume: number, confirm: boolean }
const candleMap = new Map();

// Active symbols tracked
let activeSymbols = new Set();

// Stored history of minute results for live webpage display
// Each item: { id: string, timestampCET: string, highest: { symbol, distance }, lowest: { symbol, distance } }
let resultsHistory = [];

// WebSocket client reference & state for Bybit
let ws = null;
let pingInterval = null;
let isWsConnected = false;
let isReconnecting = false;
let isResetting = false;

// Web UI Clients Connected
const uiClients = new Set();

// Sleep utility
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Log utility with timestamp
function logToConsole(message) {
    const timestamp = new Date().toLocaleString('en-US', { timeZone: 'CET' });
    console.log(`[${timestamp} CET] ${message}`);
}

// Send Telegram message
async function sendTelegramMessage(message) {
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                text: message,
                parse_mode: 'HTML'
            })
        });

        if (!response.ok) {
            console.error('Failed to send Telegram message:', response.statusText);
        }
    } catch (error) {
        console.error('Error sending Telegram message:', error);
    }
}

// Broadcast message to all connected web UI clients
function broadcastToUi(data) {
    const payload = JSON.stringify(data);
    for (const client of uiClients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    }
}

// Fetch symbols with 24h turnover > 5M USDT
async function fetchSymbolsOver5Mil() {
    try {
        const response = await fetch('https://api.bybit.com/v5/market/tickers?category=linear');
        const data = await response.json();

        if (data.retCode === 0) {
            const qualifying = data.result.list
                .filter(item => item.symbol.endsWith('USDT') && Number(item.turnover24h) > TURNOVER_THRESHOLD)
                .map(item => item.symbol);
            return qualifying;
        } else {
            console.error('Failed to fetch tickers from Bybit:', data.retMsg);
            return [];
        }
    } catch (error) {
        console.error('Error fetching tickers:', error);
        return [];
    }
}

// Fetch last 20 1-minute candles for a specific symbol via REST API
async function fetchInitialCandlesForSymbol(symbol) {
    try {
        const response = await fetch(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=1&limit=${CANDLE_HISTORY_LIMIT}`);
        const data = await response.json();

        if (data.retCode === 0 && data.result.list) {
            // Bybit returns newest first, reverse so oldest is first
            const candles = data.result.list.map(c => ({
                timestampMs: parseInt(c[0]),
                open: parseFloat(c[1]),
                high: parseFloat(c[2]),
                low: parseFloat(c[3]),
                close: parseFloat(c[4]),
                volume: parseFloat(c[5]),
                confirm: true
            })).reverse();

            return candles;
        }
    } catch (error) {
        console.error(`Error fetching initial candles for ${symbol}:`, error.message);
    }
    return [];
}

// Batch fetch initial candles for multiple symbols
async function batchFetchInitialCandles(symbols) {
    const batchSize = 30;
    for (let i = 0; i < symbols.length; i += batchSize) {
        const batch = symbols.slice(i, i + batchSize);
        const promises = batch.map(async (sym) => {
            const candles = await fetchInitialCandlesForSymbol(sym);
            if (candles.length > 0) {
                candleMap.set(sym, candles);
            }
        });
        await Promise.all(promises);
        if (i + batchSize < symbols.length) {
            await sleep(100);
        }
    }
}

// Send subscribe / unsubscribe topics in chunks to respect Bybit limit (10 topics max per msg)
function sendWsMessageChunked(op, topics) {
    if (!ws || ws.readyState !== WebSocket.OPEN || topics.length === 0) return;
    for (let i = 0; i < topics.length; i += MAX_TOPICS_PER_WS) {
        const chunk = topics.slice(i, i + MAX_TOPICS_PER_WS);
        ws.send(JSON.stringify({
            op: op,
            args: chunk
        }));
    }
}

// Subscribe to 1m kline topics for symbols
function subscribeSymbols(symbols) {
    const topics = symbols.map(s => `kline.1.${s}`);
    sendWsMessageChunked('subscribe', topics);
    logToConsole(`Subscribed to ${symbols.length} symbols.`);
}

// Unsubscribe from 1m kline topics for symbols
function unsubscribeSymbols(symbols) {
    const topics = symbols.map(s => `kline.1.${s}`);
    sendWsMessageChunked('unsubscribe', topics);
    logToConsole(`Unsubscribed from ${symbols.length} symbols.`);
}

// Initialize and manage WebSocket connection to Bybit
function initWebSocket() {
    if (ws) {
        try {
            ws.removeAllListeners();
            ws.terminate();
        } catch (e) {}
    }

    logToConsole('Connecting to Bybit WebSocket...');
    ws = new WebSocket(WS_URL);

    ws.on('open', () => {
        logToConsole('WebSocket connected successfully.');
        isWsConnected = true;
        isReconnecting = false;

        // Setup ping/pong heartbeat every 20 seconds
        if (pingInterval) clearInterval(pingInterval);
        pingInterval = setInterval(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ op: 'ping' }));
            }
        }, 20000);

        // Subscribe to all currently active symbols
        if (activeSymbols.size > 0) {
            subscribeSymbols(Array.from(activeSymbols));
        }
    });

    ws.on('message', (raw) => {
        try {
            const data = JSON.parse(raw.toString());

            // Handle pong response
            if (data.op === 'pong' || data.ret_msg === 'pong') {
                return;
            }

            // Handle Kline stream data: topic format "kline.1.{symbol}"
            if (data.topic && data.topic.startsWith('kline.1.') && Array.isArray(data.data)) {
                for (const kline of data.data) {
                    const symbol = data.topic.replace('kline.1.', '');
                    handleIncomingCandle(symbol, kline);
                }
            }
        } catch (err) {
            console.error('Error handling WS message:', err.message);
        }
    });

    ws.on('error', (err) => {
        console.error('WebSocket error:', err.message);
    });

    ws.on('close', (code, reason) => {
        logToConsole(`WebSocket closed (Code: ${code}, Reason: ${reason}).`);
        isWsConnected = false;
        if (pingInterval) clearInterval(pingInterval);

        if (!isResetting && !isReconnecting) {
            isReconnecting = true;
            logToConsole('Attempting WebSocket reconnect in 3 seconds...');
            setTimeout(() => {
                initWebSocket();
            }, 3000);
        }
    });
}

// Handle an incoming real-time kline candle from WebSocket
function handleIncomingCandle(symbol, kline) {
    if (!activeSymbols.has(symbol)) return;

    let candles = candleMap.get(symbol);
    if (!candles) {
        candles = [];
        candleMap.set(symbol, candles);
    }

    const startMs = parseInt(kline.start);
    const candleObj = {
        timestampMs: startMs,
        open: parseFloat(kline.open),
        high: parseFloat(kline.high),
        low: parseFloat(kline.low),
        close: parseFloat(kline.close),
        volume: parseFloat(kline.volume),
        confirm: kline.confirm === true
    };

    if (candles.length === 0) {
        candles.push(candleObj);
    } else {
        const lastCandle = candles[candles.length - 1];
        if (lastCandle.timestampMs === startMs) {
            // Update current open candle in place
            candles[candles.length - 1] = candleObj;
        } else if (startMs > lastCandle.timestampMs) {
            // New candle started
            candles.push(candleObj);
            // Keep recent history (25 candles is sufficient for 20 BB)
            if (candles.length > 25) {
                candles.shift();
            }
        }
    }
}

// Calculate Bollinger Bands for the series
function calculateBollingerBands(candles, period = 20, stdDev = 2) {
    if (!candles || candles.length < period) return null;

    const bands = [];
    for (let i = period - 1; i < candles.length; i++) {
        const slice = candles.slice(i - period + 1, i + 1);
        const closes = slice.map(c => c.close);

        const sma = closes.reduce((a, b) => a + b, 0) / period;
        const squaredDiffs = closes.map(close => Math.pow(close - sma, 2));
        const variance = squaredDiffs.reduce((a, b) => a + b, 0) / (period - 1);
        const standardDeviation = Math.sqrt(variance);

        bands.push({
            timestampMs: candles[i].timestampMs,
            middle: sma,
            upper: sma + (standardDeviation * stdDev),
            lower: sma - (standardDeviation * stdDev),
            close: candles[i].close
        });
    }

    return bands;
}

// Minute analysis, Telegram broadcast, and Live Web UI update
async function analyzeBollingerBandsAndNotify() {
    try {
        if (activeSymbols.size === 0) {
            logToConsole('No active symbols to analyze.');
            return;
        }

        let highestPositive = { symbol: null, distance: -Infinity, timestamp: null };
        let highestNegative = { symbol: null, distance: Infinity, timestamp: null };

        let processedCount = 0;

        for (const symbol of activeSymbols) {
            const candles = candleMap.get(symbol);
            if (!candles || candles.length < 20) continue;

            // Analyze the completed candle
            const completedCandles = candles.filter(c => c.confirm !== false);
            const targetList = completedCandles.length >= 20 ? completedCandles : candles.slice(0, -1);

            const bands = calculateBollingerBands(targetList, 20, 2);
            if (bands && bands.length > 0) {
                const latestBand = bands[bands.length - 1];
                // Formula: ((close - middle) / close) * 100
                const percentToMiddle = ((latestBand.close - latestBand.middle) / latestBand.close) * 100;

                if (percentToMiddle > highestPositive.distance) {
                    highestPositive = {
                        symbol: symbol,
                        distance: percentToMiddle,
                        timestamp: new Date(latestBand.timestampMs).toISOString()
                    };
                }

                if (percentToMiddle < highestNegative.distance) {
                    highestNegative = {
                        symbol: symbol,
                        distance: percentToMiddle,
                        timestamp: new Date(latestBand.timestampMs).toISOString()
                    };
                }

                processedCount++;
            }
        }

        logToConsole(`BB Analysis Completed: ${processedCount}/${activeSymbols.size} symbols evaluated.`);

        if (highestPositive.symbol && highestNegative.symbol) {
            const posSign = highestPositive.distance >= 0 ? '+' : '';
            const negSign = highestNegative.distance >= 0 ? '+' : '';
            const telegramMessage = `${highestPositive.symbol} ${posSign}${highestPositive.distance.toFixed(2)}%\n${highestNegative.symbol} ${negSign}${highestNegative.distance.toFixed(2)}%`;

            logToConsole(`Sending Telegram:\n${telegramMessage}`);
            await sendTelegramMessage(telegramMessage);

            // Record entry for Web UI
            const timeCET = new Date().toLocaleTimeString('en-GB', {
                timeZone: 'CET',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });

            const entry = {
                id: Date.now().toString(),
                timestampCET: timeCET,
                highest: {
                    symbol: highestPositive.symbol,
                    distance: Number(highestPositive.distance.toFixed(2))
                },
                lowest: {
                    symbol: highestNegative.symbol,
                    distance: Number(highestNegative.distance.toFixed(2))
                },
                trackedCount: activeSymbols.size
            };

            // Prepend so most recent is at index 0 (top)
            resultsHistory.unshift(entry);

            // Broadcast new entry to web clients
            broadcastToUi({
                type: 'NEW_RECORD',
                data: entry
            });
        }
    } catch (error) {
        console.error('Error in analyzeBollingerBandsAndNotify:', error);
    }
}

// Periodic check for symbols > 5M turnover to dynamically add/remove
async function periodicSymbolCheck() {
    try {
        const currentSymbols = await fetchSymbolsOver5Mil();
        if (currentSymbols.length === 0) return;

        const currentSet = new Set(currentSymbols);

        // Find symbols to add
        const symbolsToAdd = currentSymbols.filter(s => !activeSymbols.has(s));
        // Find symbols to remove (active earlier but dropped below 5M turnover)
        const symbolsToRemove = Array.from(activeSymbols).filter(s => !currentSet.has(s));

        // Process removals
        if (symbolsToRemove.length > 0) {
            logToConsole(`Removing ${symbolsToRemove.length} symbols whose turnover dropped below 5M: ${symbolsToRemove.join(', ')}`);
            unsubscribeSymbols(symbolsToRemove);
            for (const sym of symbolsToRemove) {
                activeSymbols.delete(sym);
                candleMap.delete(sym);
            }
        }

        // Process additions
        if (symbolsToAdd.length > 0) {
            logToConsole(`Adding ${symbolsToAdd.length} new symbols exceeding 5M turnover: ${symbolsToAdd.join(', ')}`);
            await batchFetchInitialCandles(symbolsToAdd);
            for (const sym of symbolsToAdd) {
                activeSymbols.add(sym);
            }
            if (isWsConnected) {
                subscribeSymbols(symbolsToAdd);
            }
        }

        // Broadcast stats update
        broadcastToUi({
            type: 'STATS_UPDATE',
            data: { trackedCount: activeSymbols.size }
        });
    } catch (error) {
        console.error('Error in periodicSymbolCheck:', error);
    }
}

// Daily reset at 00:00 CET
async function performDailyReset() {
    isResetting = true;
    logToConsole('=== Performing daily reset at 00:00 CET ===');

    try {
        // Clear maps, set, and UI history
        candleMap.clear();
        activeSymbols.clear();
        resultsHistory = [];

        // Notify connected web clients of the reset
        broadcastToUi({
            type: 'RESET',
            data: { message: 'Cleared all records at 00:00 CET', history: [] }
        });

        // Re-fetch initial symbols
        const symbols = await fetchSymbolsOver5Mil();
        logToConsole(`Daily reset: Fetched ${symbols.length} symbols with >5M turnover.`);
        activeSymbols = new Set(symbols);

        // Fetch initial 20 candles
        await batchFetchInitialCandles(symbols);
        logToConsole(`Daily reset: Fetched initial candles for ${candleMap.size} symbols.`);

        // Reconnect WS cleanly
        initWebSocket();
    } catch (err) {
        console.error('Error during daily reset:', err);
    } finally {
        isResetting = false;
    }
}

// Main initial startup
async function startApp() {
    logToConsole('Starting Bollinger Bands analyzer service...');

    // 1. Initial fetch of symbols with >5M turnover
    const symbols = await fetchSymbolsOver5Mil();
    logToConsole(`Initial startup: Found ${symbols.length} symbols with 24h turnover > 5M USDT.`);
    activeSymbols = new Set(symbols);

    // 2. Fetch initial 20 candles for each symbol
    logToConsole('Fetching initial 20 1-minute candles for all active symbols...');
    await batchFetchInitialCandles(symbols);
    logToConsole(`Fetched initial candles for ${candleMap.size} symbols.`);

    // 3. Connect to WebSocket and monitor
    initWebSocket();
}

// Scheduler: Runs every second
function startScheduler() {
    let lastAnalysisMinute = -1;
    let lastTurnoverMinute = -1;
    let lastResetDateCET = '';

    setInterval(() => {
        const now = new Date();

        // Get CET date and time parts
        const cetDateParts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'CET',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        }).formatToParts(now);

        const cetObj = {};
        cetDateParts.forEach(p => cetObj[p.type] = p.value);

        const cetDate = `${cetObj.year}-${cetObj.month}-${cetObj.day}`;
        const cetHour = parseInt(cetObj.hour, 10);
        const cetMinute = parseInt(cetObj.minute, 10);
        const cetSecond = parseInt(cetObj.second, 10);

        // 1. Daily reset at 00:00:00 CET
        if (cetHour === 0 && cetMinute === 0 && cetSecond === 0 && lastResetDateCET !== cetDate) {
            lastResetDateCET = cetDate;
            performDailyReset();
            return;
        }

        // 2. Every minute at 3 seconds: BB analysis & telegram & broadcast
        if (now.getSeconds() === 3 && now.getMinutes() !== lastAnalysisMinute) {
            lastAnalysisMinute = now.getMinutes();
            analyzeBollingerBandsAndNotify();
        }

        // 3. Every minute at 15 seconds: Dynamic turnover check (>5M)
        if (now.getSeconds() === 15 && now.getMinutes() !== lastTurnoverMinute) {
            lastTurnoverMinute = now.getMinutes();
            periodicSymbolCheck();
        }
    }, 1000);
}

// HTML Dashboard Content
const HTML_CONTENT = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Bollinger Bands Distance Monitor</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg: #0b0e14;
            --card-bg: rgba(21, 26, 38, 0.85);
            --card-border: rgba(255, 255, 255, 0.08);
            --green: #00f2a1;
            --green-glow: rgba(0, 242, 161, 0.2);
            --green-bg: rgba(0, 242, 161, 0.08);
            --red: #ff4772;
            --red-glow: rgba(255, 71, 114, 0.2);
            --red-bg: rgba(255, 71, 114, 0.08);
            --text-main: #f0f4fc;
            --text-sub: #7e8b9b;
            --accent: #6366f1;
        }

        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }

        body {
            font-family: 'Outfit', sans-serif;
            background-color: var(--bg);
            color: var(--text-main);
            min-height: 100vh;
            padding: 24px 16px;
            display: flex;
            justify-content: center;
        }

        .container {
            width: 100%;
            max-width: 900px;
        }

        header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 24px;
            padding-bottom: 18px;
            border-bottom: 1px solid var(--card-border);
            flex-wrap: wrap;
            gap: 12px;
        }

        .title-box {
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .status-dot {
            width: 10px;
            height: 10px;
            border-radius: 50%;
            background: var(--green);
            box-shadow: 0 0 10px var(--green);
            display: inline-block;
            animation: pulse 2s infinite;
        }

        .status-dot.disconnected {
            background: var(--red);
            box-shadow: 0 0 10px var(--red);
            animation: none;
        }

        @keyframes pulse {
            0% { transform: scale(0.95); opacity: 0.8; }
            50% { transform: scale(1.15); opacity: 1; }
            100% { transform: scale(0.95); opacity: 0.8; }
        }

        h1 {
            font-size: 24px;
            font-weight: 700;
            letter-spacing: -0.5px;
        }

        .stats-badge {
            font-size: 13px;
            background: rgba(255, 255, 255, 0.05);
            padding: 6px 14px;
            border-radius: 20px;
            border: 1px solid var(--card-border);
            font-family: 'JetBrains Mono', monospace;
            color: var(--text-sub);
        }

        .stats-badge strong {
            color: var(--text-main);
        }

        .sub-banner {
            display: flex;
            justify-content: space-between;
            font-size: 13px;
            color: var(--text-sub);
            margin-bottom: 16px;
            padding: 0 4px;
        }

        .records-list {
            display: flex;
            flex-direction: column;
            gap: 12px;
        }

        .record-card {
            background: var(--card-bg);
            border: 1px solid var(--card-border);
            border-radius: 14px;
            padding: 16px 20px;
            display: grid;
            grid-template-columns: 100px 1fr 1fr;
            align-items: center;
            gap: 16px;
            backdrop-filter: blur(10px);
            transition: transform 0.2s ease, border-color 0.2s ease;
        }

        .record-card:first-child {
            border-color: rgba(99, 102, 241, 0.4);
            box-shadow: 0 4px 20px rgba(99, 102, 241, 0.12);
            position: relative;
        }

        .record-card:first-child::before {
            content: 'LATEST';
            position: absolute;
            top: -10px;
            right: 20px;
            background: var(--accent);
            color: #fff;
            font-size: 10px;
            font-weight: 800;
            padding: 2px 8px;
            border-radius: 6px;
            letter-spacing: 0.5px;
        }

        .record-time {
            font-family: 'JetBrains Mono', monospace;
            font-size: 14px;
            color: var(--text-sub);
            font-weight: 600;
        }

        .symbol-box {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 10px 16px;
            border-radius: 10px;
        }

        .symbol-box.positive {
            background: var(--green-bg);
            border: 1px solid rgba(0, 242, 161, 0.2);
        }

        .symbol-box.negative {
            background: var(--red-bg);
            border: 1px solid rgba(255, 71, 114, 0.2);
        }

        .symbol-name {
            font-weight: 700;
            font-size: 16px;
            letter-spacing: 0.2px;
        }

        .symbol-distance {
            font-family: 'JetBrains Mono', monospace;
            font-weight: 700;
            font-size: 17px;
        }

        .positive .symbol-name, .positive .symbol-distance {
            color: var(--green);
        }

        .negative .symbol-name, .negative .symbol-distance {
            color: var(--red);
        }

        .empty-state {
            text-align: center;
            padding: 60px 20px;
            background: var(--card-bg);
            border-radius: 14px;
            border: 1px dashed var(--card-border);
            color: var(--text-sub);
        }

        @media (max-width: 600px) {
            .record-card {
                grid-template-columns: 1fr;
                gap: 10px;
            }
            .record-time {
                text-align: center;
                border-bottom: 1px solid var(--card-border);
                padding-bottom: 6px;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <div class="title-box">
                <span id="statusDot" class="status-dot"></span>
                <h1>Bollinger Bands Distance Monitor</h1>
            </div>
            <div class="stats-badge">
                Tracked: <strong id="trackedCount">-</strong> | Reset: <strong>00:00 CET</strong>
            </div>
        </header>

        <div class="sub-banner">
            <span>Updates every 1 min (3s after minute)</span>
            <span id="lastUpdatedText">Waiting for live data...</span>
        </div>

        <div id="recordsList" class="records-list">
            <div class="empty-state">Waiting for first minute analysis cycle...</div>
        </div>
    </div>

    <script>
        const statusDot = document.getElementById('statusDot');
        const trackedCount = document.getElementById('trackedCount');
        const recordsList = document.getElementById('recordsList');
        const lastUpdatedText = document.getElementById('lastUpdatedText');

        let records = [];

        function renderRecord(r) {
            const posSign = r.highest.distance >= 0 ? '+' : '';
            const negSign = r.lowest.distance >= 0 ? '+' : '';

            return \`
                <div class="record-card" id="card-\${r.id}">
                    <div class="record-time">\${r.timestampCET} CET</div>
                    <div class="symbol-box positive">
                        <span class="symbol-name">\${r.highest.symbol}</span>
                        <span class="symbol-distance">\${posSign}\${r.highest.distance}%</span>
                    </div>
                    <div class="symbol-box negative">
                        <span class="symbol-name">\${r.lowest.symbol}</span>
                        <span class="symbol-distance">\${negSign}\${r.lowest.distance}%</span>
                    </div>
                </div>
            \`;
        }

        function renderList() {
            if (records.length === 0) {
                recordsList.innerHTML = '<div class="empty-state">Waiting for first minute analysis cycle...</div>';
                return;
            }
            recordsList.innerHTML = records.map(renderRecord).join('');
        }

        function connectWs() {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = \`\${protocol}//\${window.location.host}\`;
            const socket = new WebSocket(wsUrl);

            socket.onopen = () => {
                statusDot.classList.remove('disconnected');
            };

            socket.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    if (msg.type === 'INIT') {
                        records = msg.data.history || [];
                        trackedCount.textContent = msg.data.trackedCount || '-';
                        if (records.length > 0) {
                            lastUpdatedText.textContent = \`Last updated: \${records[0].timestampCET} CET\`;
                        }
                        renderList();
                    } else if (msg.type === 'NEW_RECORD') {
                        records.unshift(msg.data);
                        if (msg.data.trackedCount) {
                            trackedCount.textContent = msg.data.trackedCount;
                        }
                        lastUpdatedText.textContent = \`Last updated: \${msg.data.timestampCET} CET\`;
                        renderList();
                    } else if (msg.type === 'STATS_UPDATE') {
                        if (msg.data.trackedCount !== undefined) {
                            trackedCount.textContent = msg.data.trackedCount;
                        }
                    } else if (msg.type === 'RESET') {
                        records = [];
                        lastUpdatedText.textContent = 'Reset at 00:00 CET';
                        renderList();
                    }
                } catch (e) {
                    console.error('Error processing WS frame:', e);
                }
            };

            socket.onclose = () => {
                statusDot.classList.add('disconnected');
                setTimeout(connectWs, 3000);
            };

            socket.onerror = () => {
                socket.close();
            };
        }

        connectWs();
    </script>
</body>
</html>
`;

// HTTP Server & Health Check handler
const PORT = process.env.PORT || 8000;
const server = http.createServer((req, res) => {
    // Health check endpoint
    if (req.url === '/health' || req.url === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK\n');
        return;
    }

    // Serve Web UI Dashboard
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML_CONTENT);
});

// Setup WebSocket Server on top of HTTP Server for Web UI clients
const uiWss = new WebSocket.Server({ server });

uiWss.on('connection', (clientWs) => {
    uiClients.add(clientWs);

    // Send initial state to newly connected client
    clientWs.send(JSON.stringify({
        type: 'INIT',
        data: {
            history: resultsHistory,
            trackedCount: activeSymbols.size
        }
    }));

    clientWs.on('close', () => {
        uiClients.delete(clientWs);
    });

    clientWs.on('error', () => {
        uiClients.delete(clientWs);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    logToConsole(`Server listening on port ${PORT} (Web UI + Healthcheck + WebSocket)`);
});

// Run startup and start scheduler
startApp();
startScheduler();
