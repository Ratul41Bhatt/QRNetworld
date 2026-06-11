/***********************************************************************
 * server.js - MTB Soundbox Backend API & MQTT Gateway
 * 
 * Exposes a REST API webhook for the bank payment callback.
 * Queries Firebase Firestore (with local JSON fallback) to resolve 
 * Merchant ID (MID) -> Device Serial Number (SN) mapping.
 * Publishes speech command to the target device via MQTT broker.
 ***********************************************************************/
require('dotenv').config();
const express = require('express');
const mqtt = require('mqtt');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const MQTT_BROKER = process.env.MQTT_BROKER || 'mqtt://115.159.28.147:1883';
const MQTT_USERNAME = process.env.MQTT_USERNAME || '';
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || '';
const LOCAL_DB_PATH = path.join(__dirname, 'local_db.json');

/* ====================================================================
 * DATABASE LAYER (Firebase Firestore with Local JSON Fallback)
 * ==================================================================== */
let db;
let dbType = 'local';

const serviceAccountPath = path.join(__dirname, 'firebase-service-account.json');

if (fs.existsSync(serviceAccountPath)) {
    try {
        const serviceAccount = require(serviceAccountPath);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        db = admin.firestore();
        dbType = 'firebase';
        console.log('Successfully connected to Firebase Firestore.');
    } catch (err) {
        console.error('Failed to initialize Firebase with service account file:', err.message);
    }
} else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    try {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
            })
        });
        db = admin.firestore();
        dbType = 'firebase';
        console.log('Successfully connected to Firebase Firestore (using environment variables).');
    } catch (err) {
        console.error('Failed to initialize Firebase with environment variables:', err.message);
    }
}

const TRANSACTIONS_PATH = path.join(__dirname, 'transactions_db.json');

if (dbType === 'local') {
    console.warn('⚠️ WARNING: Firebase credentials not found.');
    console.warn('⚠️ Falling back to local JSON database (local_db.json) for development.');
    
    // Initialize local database file if not exists
    if (!fs.existsSync(LOCAL_DB_PATH)) {
        fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify({
            "20501603": {
                "tid": "20501603",
                "sn": "161P12345678",
                "merchant_name": "Demo Merchant Store",
                "updated_at": new Date().toISOString()
            }
        }, null, 2));
    }

    // Initialize transactions database file if not exists
    if (!fs.existsSync(TRANSACTIONS_PATH)) {
        fs.writeFileSync(TRANSACTIONS_PATH, JSON.stringify([], null, 2));
    }
}

function readTransactionsDb() {
    try {
        if (!fs.existsSync(TRANSACTIONS_PATH)) {
            return [];
        }
        const data = fs.readFileSync(TRANSACTIONS_PATH, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        return [];
    }
}

function writeTransactionsDb(data) {
    fs.writeFileSync(TRANSACTIONS_PATH, JSON.stringify(data, null, 2));
}

async function recordTransaction(tx) {
    if (dbType === 'firebase') {
        try {
            await db.collection('transactions').add(tx);
        } catch (err) {
            console.error('Failed to write transaction to Firebase:', err.message);
        }
    } else {
        const txs = readTransactionsDb();
        txs.unshift(tx);
        if (txs.length > 500) txs.pop();
        writeTransactionsDb(txs);
    }
}

async function getAllTransactions() {
    if (dbType === 'firebase') {
        try {
            const snapshot = await db.collection('transactions').orderBy('time', 'desc').limit(100).get();
            const list = [];
            snapshot.forEach(doc => {
                list.push(doc.data());
            });
            return list;
        } catch (err) {
            console.error('Failed to read transactions from Firebase:', err.message);
            return [];
        }
    } else {
        return readTransactionsDb();
    }
}

// Database Helpers
function readLocalDb() {
    try {
        const data = fs.readFileSync(LOCAL_DB_PATH, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        return {};
    }
}

function writeLocalDb(data) {
    fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify(data, null, 2));
}

async function getMappingByTID(tid) {
    if (dbType === 'firebase') {
        try {
            const doc = await db.collection('mappings').doc(tid).get();
            if (doc.exists) {
                return doc.data();
            }
        } catch (err) {
            console.error('Failed to get mapping from Firebase:', err.message);
        }
        return null;
    } else {
        const localDb = readLocalDb();
        return localDb[tid] ? localDb[tid] : null;
    }
}

async function getAllMappings() {
    if (dbType === 'firebase') {
        const snapshot = await db.collection('mappings').get();
        const list = [];
        snapshot.forEach(doc => {
            list.push(doc.data());
        });
        return list;
    } else {
        const localDb = readLocalDb();
        return Object.values(localDb);
    }
}

async function setMapping(tid, sn, merchant_name) {
    const data = {
        tid,
        sn,
        merchant_name: merchant_name || 'N/A',
        updated_at: new Date().toISOString()
    };

    if (dbType === 'firebase') {
        await db.collection('mappings').doc(tid).set(data);
    } else {
        const localDb = readLocalDb();
        localDb[tid] = data;
        writeLocalDb(localDb);
    }
    return data;
}

async function deleteMapping(tid) {
    if (dbType === 'firebase') {
        await db.collection('mappings').doc(tid).delete();
    } else {
        const localDb = readLocalDb();
        delete localDb[tid];
        writeLocalDb(localDb);
    }
}

/* ====================================================================
 * MQTT BROKER CONNECTION
 * ==================================================================== */
console.log(`Connecting to MQTT Broker: ${MQTT_BROKER}...`);
const mqttClient = mqtt.connect(MQTT_BROKER, {
    username: MQTT_USERNAME,
    password: MQTT_PASSWORD
});

mqttClient.on('connect', () => {
    console.log('Connected successfully to MQTT Broker.');
});

mqttClient.on('error', (err) => {
    console.error('MQTT Connection Error:', err.message);
});

/* ====================================================================
 * REST API ROUTES
 * ==================================================================== */

// Get database status
app.get('/api/status', (req, res) => {
    res.json({
        status: 'online',
        database: dbType,
        mqtt_broker: MQTT_BROKER,
        using_local_fallback: dbType === 'local'
    });
});

// Bank Payment Callback Webhook
app.post('/api/payment', async (req, res) => {
    const { amount, card_number, time, invoice, rrn, tid, mid } = req.body;
    const lookupKey = tid || mid;

    console.log('\n--- Received Payment Callback ---');
    console.log(`Payload:`, req.body);

    if (!lookupKey || !amount) {
        return res.status(400).json({ error: 'Missing required parameters: tid (or mid) and amount' });
    }

    try {
        // Step 1: Look up Device Serial Number (SN) mapped to the Terminal ID (TID)
        const mapping = await getMappingByTID(lookupKey);
        if (!mapping) {
            console.warn(`[API WARNING] No registered Q161Pro device found mapping to TID/MID: ${lookupKey}`);
            
            // Record failed transaction attempt
            const tx = {
                tid: lookupKey,
                merchant_name: 'Unknown Merchant',
                sn: 'N/A',
                amount: parseFloat(amount).toFixed(2),
                invoice: invoice || '000000',
                rrn: rrn || '000000000000',
                card_number: card_number || 'N/A',
                time: time || new Date().toISOString(),
                status: 'failed'
            };
            await recordTransaction(tx);
            
            return res.status(404).json({ error: `No registered device found for ID ${lookupKey}` });
        }

        const sn = mapping.sn;
        const merchant_name = mapping.merchant_name || 'N/A';
        console.log(`[API Lookup Success] ID ${lookupKey} maps to Device SN: ${sn}`);

        // Step 2: Publish notification payload via MQTT to topic_{sn}
        const topic = `topic_${sn}`;
        const payload = JSON.stringify({
            amount: parseFloat(amount).toFixed(2),
            invoice: invoice || '000000',
            rrn: rrn || '000000000000'
        });

        mqttClient.publish(topic, payload, { qos: 0 }, async (err) => {
            if (err) {
                console.error(`[MQTT Publish Error] Failed to publish message to ${topic}:`, err.message);
                return res.status(500).json({ error: 'Failed to publish message to MQTT broker' });
            }

            console.log(`[MQTT Publish Success] Sent payload to topic [${topic}]: ${payload}`);
            
            // Record successful transaction
            const tx = {
                tid: lookupKey,
                merchant_name,
                sn,
                amount: parseFloat(amount).toFixed(2),
                invoice: invoice || '000000',
                rrn: rrn || '000000000000',
                card_number: card_number || 'N/A',
                time: time || new Date().toISOString(),
                status: 'success'
            };
            await recordTransaction(tx);

            return res.json({
                success: true,
                message: 'Notification pushed successfully to soundbox device',
                target_device_sn: sn,
                topic: topic
            });
        });

    } catch (err) {
        console.error('Internal API error:', err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Transaction History API
app.get('/api/transactions', async (req, res) => {
    try {
        const list = await getAllTransactions();
        res.json(list);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Mappings Management API
app.get('/api/mappings', async (req, res) => {
    try {
        const list = await getAllMappings();
        res.json(list);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/mappings', async (req, res) => {
    const { tid, mid, sn, merchant_name } = req.body;
    const lookupKey = tid || mid;
    if (!lookupKey || !sn) {
        return res.status(400).json({ error: 'tid and sn are required fields' });
    }
    try {
        const mapping = await setMapping(lookupKey, sn, merchant_name);
        res.json({ success: true, mapping });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Batch Upload Mappings (from Excel/CSV)
app.post('/api/mappings/batch', async (req, res) => {
    const { mappings } = req.body;
    if (!mappings || !Array.isArray(mappings)) {
        return res.status(400).json({ error: 'mappings array is required' });
    }

    try {
        const list = [];
        for (const item of mappings) {
            const { tid, mid, sn, merchant_name } = item;
            const lookupKey = tid || mid;
            if (lookupKey && sn) {
                const mapping = await setMapping(lookupKey.toString().trim(), sn.toString().trim(), merchant_name ? merchant_name.toString().trim() : 'N/A');
                list.push(mapping);
            }
        }
        res.json({ success: true, count: list.length, mappings: list });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/mappings/:tid', async (req, res) => {
    const { tid } = req.params;
    try {
        await deleteMapping(tid);
        res.json({ success: true, message: `Mapping for TID ${tid} deleted.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Launch server
app.listen(PORT, () => {
    console.log(`==================================================`);
    console.log(` MTB Soundbox Gateway Server listening on port ${PORT}`);
    console.log(` Server mode: ${dbType.toUpperCase()}`);
    console.log(`==================================================`);
});

module.exports = app;

