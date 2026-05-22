# MTB Soundbox Integration & Simulation Platform

This directory contains the Node.js API Gateway & MQTT Push Server designed to integrate Aisino Q161Pro Soundbox devices with bank payment callback APIs (like Mutual Trust Bank - MTB).

## Architecture Flow

```mermaid
sequenceDiagram
    autonumber
    actor Customer
    participant Merchant QR
    participant MTB Bank App
    participant Bank Webhook API
    participant Soundbox Backend
    participant Firebase Firestore
    participant MQTT Broker
    participant Q161Pro Soundbox

    Customer->>Merchant QR: Scan static QR sticker
    Customer->>MTB Bank App: Complete transaction payment (e.g. ৳250)
    MTB Bank App->>Bank Webhook API: Process payment
    Bank Webhook API->>Soundbox Backend: POST /api/payment { mid, amount, rrn, ... }
    Soundbox Backend->>Firebase Firestore: Query mapping for Serial Number (SN) using MID
    Firebase Firestore-->>Soundbox Backend: Return matched Device SN (e.g. 161P12345678)
    Soundbox Backend->>MQTT Broker: Publish { amount, invoice, rrn } to topic_161P12345678
    MQTT Broker->>Q161Pro Soundbox: Push MQTT payload (Instant notification)
    Q161Pro Soundbox->>Customer: Voice TIP: "Received 250.00 Taka" & Displays details
```

---

## 🛠️ Features

1. **Payment Webhook Gateway**: Exposes `POST /api/payment` for bank core integrations.
2. **Device Register & Synchronization**: Maps Merchant IDs (MID) to soundbox Serial Numbers (SN) in real-time.
3. **Double Database Layer**: Supports **Firebase Firestore** as primary database and falls back automatically to a local JSON database (`local_db.json`) for zero-configuration local development.
4. **MQTT Push Dispatcher**: Pushes structured payment notifications directly to target soundbox client topics.
5. **Interactive Web Dashboard**:
   - Live database synchronization and mapping console.
   - Interactive Q161Pro visual mock device with sound broadcast simulation using Web Speech Synthesis.
   - Presets and manual fields for simulating bank payment webhooks.
   - Live transaction logs.

---

## 🚀 Setup & Installation

### 1. Prerequisites
- **Node.js**: v16 or above installed on the server.
- **MQTT Broker**: Any MQTT broker (e.g., HiveMQ Cloud, EMQX, or public `broker.hivemq.com`).

### 2. Standard Local Setup
1. Open terminal in the `MTB_Soundbox_Backend` directory.
2. Install npm dependencies:
   ```bash
   npm install
   ```
3. Run the development server:
   ```bash
   npm run dev
   ```
   *(Or start directly: `node server.js`)*
4. Open your browser and navigate to `http://localhost:3000`. You will see the Admin Panel dashboard running.
5. By default, it will fall back to using the local database `local_db.json`. You can immediately map Mappings and test simulations using the Virtual Q161Pro mockup.

---

## ☁️ Production Databases Setup (Firebase Firestore)

To synchronize device Serial Numbers and Merchant IDs across multiple gateway instances, configure Google Firebase Firestore database:

1. Go to the [Firebase Console](https://console.firebase.google.com/).
2. Create a new project named **MTB-Soundbox** (or choice name).
3. Under **Build**, select **Firestore Database** and click **Create database** (Start in production or test mode).
4. Navigate to **Project Settings** (gear icon) > **Service Accounts**.
5. Select **Node.js** and click **Generate new private key**. Download the JSON file.
6. Rename this file to `firebase-service-account.json` and place it in the root of the `MTB_Soundbox_Backend` directory.
7. Restart the Node server. It will automatically detect the service credentials and connect.

Alternatively, in cloud hosting environments (like Render or Heroku), configure environment variables:
- `FIREBASE_PROJECT_ID` = your-firebase-project-id
- `FIREBASE_CLIENT_EMAIL` = your-firebase-client-email
- `FIREBASE_PRIVATE_KEY` = your-firebase-private-key (include the `-----BEGIN PRIVATE KEY-----` wrapper, escaping newlines as `\n` if needed)

---

## ☁️ MQTT Broker Customization

By default, the server links to `mqtt://broker.hivemq.com:1883` for zero-configuration testing. For custom brokers (e.g., secure HiveMQ Cloud or EMQX Cloud):
Configure the following environment variables in `.env` (or via Render settings):
- `MQTT_BROKER` = `mqtts://your-instance.hivemq.cloud:8883` (or `mqtt://ip-address:1883`)
- `MQTT_USERNAME` = `your_broker_username`
- `MQTT_PASSWORD` = `your_broker_password`

---

## 🌐 Deploying to Render (Free Hosting)

Render provides excellent free tier web service hosting that can run this Express API.

### Steps to Deploy:
1. Initialize git in this directory (or upload the backend folder to a GitHub repository):
   ```bash
   git init
   ```
2. Create a `.gitignore` to avoid uploading secrets:
   ```text
   node_modules
   .env
   local_db.json
   firebase-service-account.json
   ```
3. Commit and push your code to your GitHub account.
4. Go to [Render Dashboard](https://dashboard.render.com/) and click **New** > **Web Service**.
5. Connect your GitHub repository.
6. Configure the Web Service settings:
   - **Name**: `mtb-soundbox-api`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
7. Under **Environment**, add env variables if using Firebase (or upload your service account file as a Secret File).
8. Click **Deploy Web Service**. You will receive an API URL like `https://mtb-soundbox-api.onrender.com`.

---

## 🔌 API Documentation

### 1. Bank Webhook Callback (POST)
Received by the gateway from the acquiring bank to trigger a payment notification.

- **URL**: `/api/payment`
- **Method**: `POST`
- **Content-Type**: `application/json`
- **Payload Format**:
  ```json
  {
    "amount": "250.50",
    "card_number": "4321-xxxx-xxxx-8888",
    "time": "2026-05-22T12:00:00Z",
    "invoice": "482012",
    "rrn": "673291048293",
    "mid": "102000000000040"
  }
  ```
- **Responses**:
  - `200 OK`: If mapping is resolved and MQTT message was successfully sent to the broker.
    ```json
    {
      "success": true,
      "message": "Notification pushed successfully to soundbox device",
      "target_device_sn": "161P12345678",
      "topic": "topic_161P12345678"
    }
    ```
  - `400 Bad Request`: If mandatory fields (`mid` or `amount`) are missing.
  - `404 Not Found`: If the Merchant ID (MID) is not mapped to any device serial number.

### 2. Device Mappings REST API

- **Fetch Mappings**: `GET /api/mappings` -> Returns an array of registered device mappings.
- **Register / Update Mapping**: `POST /api/mappings` -> Takes `{ mid, sn, merchant_name }` to create or overwrite a device association.
- **Delete Mapping**: `DELETE /api/mappings/:mid` -> Removes mapping for specified MID.
