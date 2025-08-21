const express = require('express');
const { DisconnectReason, useMultiFileAuthState, makeWASocket } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const QRCode = require('qrcode-terminal');
const cors = require('cors');
const axios = require('axios');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Storage para archivos
const upload = multer({ storage: multer.memoryStorage() });

// Variables globales
let sock;
let qrDinamic;
let connectionState = 'close';
let isConnected = false;

// Configuración desde variables de entorno
const config = {
    instanceName: process.env.INSTANCE_NAME || 'kore',
    webhookUrl: process.env.WEBHOOK_URL,
    authKey: process.env.AUTHENTICATION_API_KEY,
    serverUrl: process.env.SERVER_URL
};

console.log('🚀 Starting Evolution API...');
console.log('📱 Instance:', config.instanceName);
console.log('🔗 Webhook:', config.webhookUrl);

// Middleware de autenticación
const authenticate = (req, res, next) => {
    const apikey = req.headers['apikey'] || req.query.apikey;
    if (apikey !== config.authKey) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
};

// Función para enviar webhook
async function sendWebhook(data) {
    if (!config.webhookUrl) return;
    
    try {
        await axios.post(config.webhookUrl, {
            instance: config.instanceName,
            data: data,
            event: 'messages.upsert',
            apikey: config.authKey,
            sender: data.key?.remoteJid,
            date_time: new Date().toISOString(),
            server_url: config.serverUrl,
            destination: config.webhookUrl
        });
        console.log('📡 Webhook sent successfully');
    } catch (error) {
        console.error('❌ Webhook error:', error.message);
    }
}

// Función para conectar WhatsApp
async function connectWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
        
        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: ['Chrome (Linux)', '', ''],
            defaultQueryTimeoutMs: 60 * 1000,
        });

        // Manejo de QR
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                qrDinamic = qr;
                connectionState = 'qr';
                console.log('📱 QR Code generated');
                QRCode.generate(qr, { small: true });
            }
            
            if (connection === 'open') {
                connectionState = 'open';
                isConnected = true;
                console.log('✅ WhatsApp connected successfully!');
            }
            
            if (connection === 'close') {
                connectionState = 'close';
                isConnected = false;
                const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log('❌ Connection closed:', lastDisconnect?.error);
                
                if (shouldReconnect) {
                    console.log('🔄 Reconnecting...');
                    setTimeout(connectWhatsApp, 3000);
                }
            }
        });

        // Guardar credenciales
        sock.ev.on('creds.update', saveCreds);

        // Manejo de mensajes
        sock.ev.on('messages.upsert', async (m) => {
            const message = m.messages[0];
            if (!message.key.fromMe && message.message) {
                console.log('📨 New message received');
                await sendWebhook(message);
            }
        });

    } catch (error) {
        console.error('❌ WhatsApp connection error:', error);
        setTimeout(connectWhatsApp, 5000);
    }
}

// RUTAS DE LA API

// Status del servicio
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        instance: config.instanceName,
        connection: connectionState,
        connected: isConnected,
        timestamp: new Date().toISOString()
    });
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

// Obtener QR Code
app.get('/instance/qr', authenticate, async (req, res) => {
    try {
        if (connectionState === 'open') {
            return res.json({ 
                error: false, 
                message: 'Instance already connected',
                connected: true 
            });
        }
        
        if (qrDinamic) {
            const qrBase64 = await qrcode.toDataURL(qrDinamic);
            res.json({
                error: false,
                qrcode: qrBase64,
                message: 'QR Code generated'
            });
        } else {
            res.json({
                error: true,
                message: 'QR Code not available. Try reconnecting.'
            });
        }
    } catch (error) {
        res.status(500).json({
            error: true,
            message: error.message
        });
    }
});

// Status de la instancia
app.get('/instance/status', authenticate, (req, res) => {
    res.json({
        instance: config.instanceName,
        status: connectionState,
        connected: isConnected
    });
});

// Conectar instancia
app.post('/instance/connect', authenticate, (req, res) => {
    connectWhatsApp();
    res.json({
        error: false,
        message: 'Connection initiated'
    });
});

// Enviar mensaje de texto
app.post('/message/text', authenticate, async (req, res) => {
    try {
        const { remoteJid, message } = req.body;
        
        if (!isConnected) {
            return res.status(400).json({
                error: true,
                message: 'WhatsApp not connected'
            });
        }

        const result = await sock.sendMessage(remoteJid, { text: message });
        
        res.json({
            error: false,
            message: 'Message sent successfully',
            messageId: result.key.id
        });
    } catch (error) {
        res.status(500).json({
            error: true,
            message: error.message
        });
    }
});

// Obtener media en base64
app.get('/message/media/:messageId', authenticate, async (req, res) => {
    try {
        const { messageId } = req.params;
        
        // Esta es una implementación básica
        // En una implementación completa, necesitarías almacenar y recuperar media
        res.json({
            error: false,
            data: {
                base64: '',
                mimetype: 'application/octet-stream',
                filename: 'media'
            }
        });
    } catch (error) {
        res.status(500).json({
            error: true,
            message: error.message
        });
    }
});

// Iniciar servidor
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Server running on port ${PORT}`);
    console.log(`🔗 Server URL: ${config.serverUrl || `http://localhost:${PORT}`}`);
    console.log('🤖 Starting WhatsApp connection...');
    connectWhatsApp();
});

// Manejo de errores
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
    console.error('❌ Unhandled Rejection:', err);
});
