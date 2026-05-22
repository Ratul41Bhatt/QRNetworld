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
const MQTT_BROKER = process.env.MQTT_BROKER || 'mqtt://broker.emqx.io:1883';
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

if (dbType === 'local') {
    console.warn('⚠️ WARNING: Firebase credentials not found.');
    console.warn('⚠️ Falling back to local JSON database (local_db.json) for development.');
    
    // Initialize local database file if not exists
    if (!fs.existsSync(LOCAL_DB_PATH)) {
        fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify({
            "102000000000040": {
                "mid": "102000000000040",
                "sn": "161P12345678",
                "merchant_name": "Demo Merchant Store",
                "updated_at": new Date().toISOString()
            }
        }, null, 2));
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

async function getDeviceSNByMID(mid) {
    if (dbType === 'firebase') {
        const doc = await db.collection('mappings').doc(mid).get();
        if (doc.exists) {
            return doc.data().sn;
        }
        return null;
    } else {
        const localDb = readLocalDb();
        return localDb[mid] ? localDb[mid].sn : null;
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

async function setMapping(mid, sn, merchant_name) {
    const data = {
        mid,
        sn,
        merchant_name: merchant_name || 'N/A',
        updated_at: new Date().toISOString()
    };

    if (dbType === 'firebase') {
        await db.collection('mappings').doc(mid).set(data);
    } else {
        const localDb = readLocalDb();
        localDb[mid] = data;
        writeLocalDb(localDb);
    }
    return data;
}

async function deleteMapping(mid) {
    if (dbType === 'firebase') {
        await db.collection('mappings').doc(mid).delete();
    } else {
        const localDb = readLocalDb();
        delete localDb[mid];
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
    const { amount, card_number, time, invoice, rrn, mid } = req.body;

    console.log('\n--- Received Payment Callback ---');
    console.log(`Payload:`, req.body);

    if (!mid || !amount) {
        return res.status(400).json({ error: 'Missing required parameters: mid and amount' });
    }

    try {
        // Step 1: Look up Device Serial Number (SN) mapped to the Merchant ID (MID)
        const sn = await getDeviceSNByMID(mid);
        if (!sn) {
            console.warn(`[API WARNING] No registered Q161Pro device found mapping to MID: ${mid}`);
            return res.status(404).json({ error: `No registered device found for Merchant ID ${mid}` });
        }

        console.log(`[API Lookup Success] MID ${mid} maps to Device SN: ${sn}`);

        // Step 2: Publish notification payload via MQTT to topic_{sn}
        const topic = `topic_${sn}`;
        const payload = JSON.stringify({
            amount: parseFloat(amount).toFixed(2),
            invoice: invoice || '000000',
            rrn: rrn || '000000000000'
        });

        mqttClient.publish(topic, payload, { qos: 0 }, (err) => {
            if (err) {
                console.error(`[MQTT Publish Error] Failed to publish message to ${topic}:`, err.message);
                return res.status(500).json({ error: 'Failed to publish message to MQTT broker' });
            }

            console.log(`[MQTT Publish Success] Sent payload to topic [${topic}]: ${payload}`);
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
    const { mid, sn, merchant_name } = req.body;
    if (!mid || !sn) {
        return res.status(400).json({ error: 'mid and sn are required fields' });
    }
    try {
        const mapping = await setMapping(mid, sn, merchant_name);
        res.json({ success: true, mapping });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/mappings/:mid', async (req, res) => {
    const { mid } = req.params;
    try {
        await deleteMapping(mid);
        res.json({ success: true, message: `Mapping for MID ${mid} deleted.` });
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
