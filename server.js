const fetch = require('node-fetch');
const fs = require('fs');

// Sleep function
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Log results to file
function logToFile(message) {
    const timestamp = new Date().toLocaleString();
    const logMessage = `[${timestamp}] ${message}\n`;

    try {
        fs.appendFileSync('bb_analysis.log', logMessage);
    } catch (error) {
        console.error('Error writing to log file:', error);
    }
}


// Batch fetch 1-minute candles
async function batchFetch1MinuteCandles(symbols) {
    const results = new Map();
    const batchSize = 120;

    for (let i = 0; i < symbols.length; i += batchSize) {
        const batch = symbols.slice(i, i + batchSize);

        const promises = batch.map(symbol =>
            fetch(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=1&limit=1000`)
                .then(response => response.json())
                .then(data => {
                    if (data.retCode === 0) {
                        results.set(symbol, data.result.list.map(candle => ({
                            timestamp: new Date(parseInt(candle[0])).toLocaleDateString(),
                            timestampMs: parseInt(candle[0]),
                            open: parseFloat(candle[1]),
                            high: parseFloat(candle[2]),
                            low: parseFloat(candle[3]),
                            close: parseFloat(candle[4]),
                            volume: parseFloat(candle[5])
                        })).reverse()); // Reverse to get oldest first for proper BB calculation
                    } else {
                        results.set(symbol, []);
                    }
                })
                .catch(error => {
                    console.error(`Error fetching 1m candles for ${symbol}:`, error);
                    results.set(symbol, []);
                })
        );

        await Promise.all(promises);

        if (i + batchSize < symbols.length) {
            await sleep(100);
        }
    }

    return results;
}


// Calculate Bollinger Bands
function calculateBollingerBands(candles, period = 20, stdDev = 2) {
    if (!candles || candles.length < period) return null;

    const bands = [];

    for (let i = period - 1; i < candles.length; i++) {
        const slice = candles.slice(i - period + 1, i + 1);
        const closes = slice.map(c => c.close);

        const sma = closes.reduce((a, b) => a + b) / period;

        const squaredDiffs = closes.map(close => Math.pow(close - sma, 2));
        const variance = squaredDiffs.reduce((a, b) => a + b) / (period - 1);
        const standardDeviation = Math.sqrt(variance);

        bands.push({
            timestamp: candles[i].timestamp,
            timestampMs: candles[i].timestampMs,
            middle: sma,
            upper: sma + (standardDeviation * stdDev),
            lower: sma - (standardDeviation * stdDev),
            close: candles[i].close
        });
    }

    return bands;
}

// Telegram configuration - Replace with your bot token and chat ID
const TELEGRAM_BOT_TOKEN = '7817169168:AAF_zGQuYIQxDBiX6xiCAQZXq1r8fK90NVg';
const TELEGRAM_CHAT_ID = '-1002609143934';

// All-time records file
const ALL_TIME_RECORDS_FILE = 'all_time_records.json';

// Function to read all-time records from file
function readAllTimeRecords() {
    try {
        if (fs.existsSync(ALL_TIME_RECORDS_FILE)) {
            const data = fs.readFileSync(ALL_TIME_RECORDS_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error('Error reading all-time records:', error);
    }

    // Return default structure if file doesn't exist or error
    return {
        highestPositive: { symbol: null, distance: -Infinity, timestamp: null },
        highestNegative: { symbol: null, distance: Infinity, timestamp: null }
    };
}

// Function to write all-time records to file
function writeAllTimeRecords(records) {
    try {
        fs.writeFileSync(ALL_TIME_RECORDS_FILE, JSON.stringify(records, null, 2));
    } catch (error) {
        console.error('Error writing all-time records:', error);
    }
}

// Function to send Telegram message
async function sendTelegramMessage(message) {
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
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

// Main data fetching and analysis function
async function fetchAndAnalyzeData() {
    try {
        console.log('Fetching data at:', new Date().toLocaleString());

        const response = await fetch('https://api.bybit.com/v5/market/tickers?category=linear');
        const data = await response.json();

        if (data.retCode === 0) {
            const usdtPairs = data.result.list
                .filter(item => item.symbol.endsWith('USDT') && Number(item.turnover24h) > 10000000);

            const usdtSymbols = usdtPairs.map(pair => pair.symbol);

            // Fetch 1-minute candles
            const candles1mMap = await batchFetch1MinuteCandles(usdtSymbols);

            // Log start of analysis
            logToFile(`=== BB Analysis Started - ${usdtPairs.length} symbols ===`);

            // Track highest positive and negative distances for current analysis
            let currentHighestPositive = { symbol: null, distance: -Infinity, timestamp: null };
            let currentHighestNegative = { symbol: null, distance: Infinity, timestamp: null };

            // Process each symbol
            usdtPairs.forEach(item => {
                const candles1m = candles1mMap.get(item.symbol) || [];
                const bands1m = calculateBollingerBands(candles1m);

                if (bands1m && bands1m.length > 1) {
                    // Get the previous (completed) candle - second to last
                    const previousBand = bands1m[bands1m.length - 2];

                    // Calculate percentage distance from previous candle's close price to middle band
                    // Formula: ((close - basis) / close) * 100
                    // Positive = close above middle, Negative = close below middle
                    const percentToMiddle = ((previousBand.close - previousBand.middle) / previousBand.close) * 100;

                    // Track highest positive and negative distances for current analysis
                    if (percentToMiddle > currentHighestPositive.distance) {
                        currentHighestPositive = {
                            symbol: item.symbol,
                            distance: percentToMiddle,
                            timestamp: new Date(previousBand.timestampMs).toISOString()
                        };
                    }
                    if (percentToMiddle < currentHighestNegative.distance) {
                        currentHighestNegative = {
                            symbol: item.symbol,
                            distance: percentToMiddle,
                            timestamp: new Date(previousBand.timestampMs).toISOString()
                        };
                    }

                    // Log the Bollinger Band values for the previous completed candle with distance to middle
                    const candleTime = new Date(previousBand.timestampMs).toISOString();
                    logToFile(`${item.symbol}: Previous Candle: ${candleTime} | BB Upper: ${previousBand.upper.toFixed(6)} | BB Middle: ${previousBand.middle.toFixed(6)} | BB Lower: ${previousBand.lower.toFixed(6)} | Close: ${previousBand.close.toFixed(6)} | Distance to Middle: ${percentToMiddle.toFixed(2)}%`);
                } else {
                    logToFile(`${item.symbol}: No BB data available (need at least 2 candles)`);
                }
            });

            logToFile(`=== BB Analysis Completed - ${usdtPairs.length} symbols processed ===\n`);

            // Read all-time records
            const allTimeRecords = readAllTimeRecords();

            // Check if current values are new all-time highs
            let isNewAllTimePositive = currentHighestPositive.distance > allTimeRecords.highestPositive.distance;
            let isNewAllTimeNegative = currentHighestNegative.distance < allTimeRecords.highestNegative.distance;

            // Prepare Telegram message
            if (currentHighestPositive.symbol && currentHighestNegative.symbol) {
                let telegramMessage = `${currentHighestPositive.symbol} ${currentHighestPositive.distance.toFixed(2)}% above\n\n${currentHighestNegative.symbol} ${currentHighestNegative.distance.toFixed(2)}% below\n\n`;

                // Add all-time records to message
                if (allTimeRecords.highestPositive.symbol) {
                    telegramMessage += `All-time high above: ${allTimeRecords.highestPositive.symbol} ${allTimeRecords.highestPositive.distance.toFixed(2)}%`;
                    if (allTimeRecords.highestPositive.timestamp) {
                        telegramMessage += ` (${new Date(allTimeRecords.highestPositive.timestamp).toLocaleString()})`;
                    }
                    telegramMessage += '\n';
                }

                if (allTimeRecords.highestNegative.symbol) {
                    telegramMessage += `All-time high below: ${allTimeRecords.highestNegative.symbol} ${allTimeRecords.highestNegative.distance.toFixed(2)}%`;
                    if (allTimeRecords.highestNegative.timestamp) {
                        telegramMessage += ` (${new Date(allTimeRecords.highestNegative.timestamp).toLocaleString()})`;
                    }
                }

                // Update all-time records if new highs found
                if (isNewAllTimePositive || isNewAllTimeNegative) {
                    if (isNewAllTimePositive) {
                        allTimeRecords.highestPositive = currentHighestPositive;
                        logToFile(`NEW ALL-TIME HIGH POSITIVE: ${currentHighestPositive.symbol} ${currentHighestPositive.distance.toFixed(2)}% at ${currentHighestPositive.timestamp}`);
                    }
                    if (isNewAllTimeNegative) {
                        allTimeRecords.highestNegative = currentHighestNegative;
                        logToFile(`NEW ALL-TIME HIGH NEGATIVE: ${currentHighestNegative.symbol} ${currentHighestNegative.distance.toFixed(2)}% at ${currentHighestNegative.timestamp}`);
                    }

                    // Write updated records to file
                    writeAllTimeRecords(allTimeRecords);

                    // Add new record notification to message
                    telegramMessage += '\n\n🚨 NEW ALL-TIME RECORD! 🚨';
                }

                await sendTelegramMessage(telegramMessage);
                logToFile(`Telegram message sent: Current positive: ${currentHighestPositive.symbol} ${currentHighestPositive.distance.toFixed(2)}%, Current negative: ${currentHighestNegative.symbol} ${currentHighestNegative.distance.toFixed(2)}%`);
            }

            // Memory cleanup
            candles1mMap.clear();

            // Clear other variables to prevent memory buildup
            currentHighestPositive = null;
            currentHighestNegative = null;

            console.log(`Data updated successfully. ${usdtPairs.length} symbols processed.`);
        }
    } catch (error) {
        console.error('Error fetching data:', error);
        logToFile(`ERROR: ${error.message}`);
    }
}

// Start the scheduler to run at 3 seconds after every minute
function startMinuteScheduler() {
    let lastRunMinute = -1; // Track the last minute we ran to avoid duplicate runs

    setInterval(() => {
        const now = new Date();
        const currentMinute = now.getMinutes();
        const currentSecond = now.getSeconds();

        // Run if it's 3 seconds after the minute and we haven't run this minute yet
        if (currentSecond === 3 && currentMinute !== lastRunMinute) {
            lastRunMinute = currentMinute;
            fetchAndAnalyzeData();
        }
    }, 1000); // Check every second
}

// Start the application
console.log('Starting Bollinger Bands analyzer...');
console.log('Data will be fetched every minute at 3 seconds past the minute');
startMinuteScheduler();
