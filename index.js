import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import OpenAI from 'openai';
import crypto from 'crypto';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Initialize Master Bot (For Admin Alerts)
const masterBot = new TelegramBot(process.env.MASTER_BOT_TOKEN, { polling: true });

app.use(bodyParser.json());
app.use(express.static('public'));

// In-Memory Storage (Note: Resets if server restarts)
const userRequests = {}; 
const activeBots = {};

// 1. LOGIN AUTHENTICATION (The Redirect Handler)
app.get('/auth', (req, res) => {
    const { hash, ...data } = req.query;
    if (!hash) return res.status(400).send('No data.');

    const secretKey = crypto.createHash('sha256').update(process.env.MASTER_BOT_TOKEN).digest();
    const checkString = Object.keys(data).sort().map(k => `${k}=${data[k]}`).join('\n');
    const hmac = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');

    if (hmac === hash) {
        // Valid! Redirect to dashboard
        const userJson = encodeURIComponent(JSON.stringify(data));
        res.redirect(`/dashboard.html?user=${userJson}`);
    } else {
        res.status(403).send('Verification failed.');
    }
});

// 2. REQUEST ACCESS
app.post('/request-access', async (req, res) => {
    const { telegramId, username } = req.body;
    if (userRequests[telegramId] === 'approved') return res.json({ status: 'approved' });

    userRequests[telegramId] = 'pending';

    // Notify Admin via Telegram
    try {
        await masterBot.sendMessage(process.env.ADMIN_CHAT_ID, 
            `⚠️ **Access Request**\nUser: @${username}\nID: ${telegramId}`, 
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[
                        { text: "✅ Confirm", callback_data: `confirm_${telegramId}` },
                        { text: "❌ Decline", callback_data: `decline_${telegramId}` }
                    ]]
                }
            }
        );
        res.json({ status: 'pending' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Failed to notify admin" });
    }
});

// 3. CHECK STATUS (Polling)
app.get('/check-status/:id', (req, res) => {
    res.json({ status: userRequests[req.params.id] || 'none' });
});

// 4. START USER BOT
app.post('/start-bot', async (req, res) => {
    const { telegramId, botToken, apiKey } = req.body;

    if (activeBots[telegramId]) {
        try { await activeBots[telegramId].stopPolling(); } catch(e){}
    }

    try {
        const deepseek = new OpenAI({ baseURL: 'https://api.deepseek.com', apiKey: apiKey });
        const newBot = new TelegramBot(botToken, { polling: true });

        newBot.on('message', async (msg) => {
            if (!msg.text) return;
            const chatId = msg.chat.id;
            
            // Show typing status
            newBot.sendChatAction(chatId, 'typing').catch(()=>{});

            try {
                const completion = await deepseek.chat.completions.create({
                    messages: [{ role: "user", content: msg.text }],
                    model: "deepseek-chat"
                });
                await newBot.sendMessage(chatId, completion.choices[0].message.content, { parse_mode: 'Markdown' });
            } catch (err) {
                await newBot.sendMessage(chatId, "⚠️ AI Error: Check your API Key.");
            }
        });

        activeBots[telegramId] = newBot;
        res.json({ message: "✅ Bot is active! Go test it." });

    } catch (error) {
        res.status(500).json({ message: "❌ Failed. Check your tokens." });
    }
});

// 5. ADMIN BUTTON HANDLER
masterBot.on('callback_query', async (query) => {
    const [action, userId] = query.data.split('_');
    const chatId = query.message.chat.id;
    const msgId = query.message.message_id;

    if (action === 'confirm') {
        userRequests[userId] = 'approved';
        await masterBot.editMessageText(`✅ User ${userId} Approved`, { chat_id: chatId, message_id: msgId });
    } else if (action === 'decline') {
        userRequests[userId] = 'declined';
        await masterBot.editMessageText(`❌ User ${userId} Declined`, { chat_id: chatId, message_id: msgId });
    }
});

app.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });