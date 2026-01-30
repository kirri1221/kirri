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

app.use(bodyParser.json());
app.use(express.static('public'));

// Store active bots in memory
const activeBots = {};

// 1. LOGIN AUTHENTICATION (The Redirect Handler)
app.get('/auth', (req, res) => {
    const { hash, ...data } = req.query;
    
    if (!hash) {
        return res.status(400).send('No data received.');
    }

    // Security Check: Verify the data came from Telegram
    const secretKey = crypto.createHash('sha256')
        .update(process.env.MASTER_BOT_TOKEN)
        .digest();

    const checkString = Object.keys(data)
        .sort()
        .map(k => `${k}=${data[k]}`)
        .join('\n');

    const hmac = crypto.createHmac('sha256', secretKey)
        .update(checkString)
        .digest('hex');

    if (hmac === hash) {
        // Valid! Redirect straight to dashboard
        const userJson = encodeURIComponent(JSON.stringify(data));
        res.redirect(`/dashboard.html?user=${userJson}`);
    } else {
        res.status(403).send('Login verification failed.');
    }
});

// 2. START USER BOT (No approval check anymore)
app.post('/start-bot', async (req, res) => {
    const { telegramId, botToken, apiKey } = req.body;

    if (!botToken || !apiKey) {
        return res.json({ message: "❌ Please enter both keys." });
    }

    // Stop existing bot if running
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
                console.error(err);
                await newBot.sendMessage(chatId, "⚠️ AI Error: Check your API Key.");
            }
        });

        activeBots[telegramId] = newBot;
        console.log(`Bot started for user ${telegramId}`);
        res.json({ message: "✅ Bot is active! Go test it." });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "❌ Failed. Check your tokens." });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});