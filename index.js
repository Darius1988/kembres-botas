import axios from 'axios';
import { DateTime } from 'luxon';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

// Load .env file
import dotenv from 'dotenv';
dotenv.config();

// CONFIG
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const CONVERSSATION_ID = process.env.CONVERSATION_ID;
const RECIPIENT_ID = process.env.RECIPIENT_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const FB_API_URL = 'https://graph.facebook.com/v19.0/me/messages';

// DB HELPER
async function getDB() {
  return open({
    filename: './data.db',
    driver: sqlite3.Database
  });
}

async function initDB() {
  const db = await getDB();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS data_store (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

// GET/SET
async function getData(key) {
  const db = await getDB();
  const row = await db.get('SELECT value FROM data_store WHERE key = ?', key);
  return row ? JSON.parse(row.value) : null;
}

async function setData(key, value) {
  const db = await getDB();
  await db.run('INSERT OR REPLACE INTO data_store (key, value) VALUES (?, ?)', key, JSON.stringify(value));
}

// UTILS
function pickRandomWeekdays(count) {
  const days = [1, 2, 3, 4, 5, 6, 7];
  for (let i = days.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [days[i], days[j]] = [days[j], days[i]];
  }
  return days.slice(0, count).sort();
}

function getRandomTimeInRange(part) {
  const ranges = {
    morning: [9, 10],
    day: [13, 14],
    evening: [17, 19],
  };
  const [start, end] = ranges[part];
  const hour = Math.floor(Math.random() * (end - start)) + start;
  const minute = Math.floor(Math.random() * 60);
  return { hour, minute };
}

// FACEBOOK
async function getMessages() {
  const url = `https://graph.facebook.com/v19.0/${CONVERSSATION_ID}/messages?fields=message,from,created_time&access_token=${ACCESS_TOKEN}`;
  const res = await axios.get(url);
  return (res.data.data || []).reverse();
}

async function sendMessage(text) {
  await axios.post(FB_API_URL, {
    recipient: { id: RECIPIENT_ID },
    message: { text },
  }, {
    params: { access_token: ACCESS_TOKEN },
  });
}

// OPENAI
async function generateGreeting(part) {
  const prompt = `Sukurk trumpą, atsitiktinę žinutę mamai... "${part}"`;

  const res = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: "gpt-4",
    messages: [
      { role: "system", content: "Tu esi sūnus, rašantis mielą žinutę mamai." },
      { role: "user", content: prompt }
    ],
    temperature: 0.8,
  }, {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }
  });

  return res.data.choices[0].message.content.trim();
}

// MAIN
(async () => {
  await initDB();
  const now = DateTime.now().setZone('Europe/Vilnius');
  const today = now.toISODate();
  const weekday = now.weekday;

  const weekKey = `greeting_weekdays_${RECIPIENT_ID}_${now.startOf('week').toISODate()}`;
  let scheduledDays = await getData(weekKey);

  if (!scheduledDays) {
    const timesPerWeek = Math.random() < 0.5 ? 2 : 3;
    scheduledDays = pickRandomWeekdays(timesPerWeek);
    await setData(weekKey, scheduledDays);
    console.log('New weekly schedule:', scheduledDays);
  }

  if (!scheduledDays.includes(weekday)) {
    console.log(`Today (${weekday}) is not in schedule.`);
    return;
  }

  const sentKey = `greeting_sent_${today}_${RECIPIENT_ID}`;
  const timeKey = `greeting_time_${today}_${RECIPIENT_ID}`;
  const partKey = `greeting_part_${today}_${RECIPIENT_ID}`;

  const greetingSent = await getData(sentKey);
  let greetingTimeISO = await getData(timeKey);
  let greetingPart = await getData(partKey);

  if (!greetingTimeISO || !greetingPart) {
    const parts = ['morning', 'day', 'evening'];
    greetingPart = parts[Math.floor(Math.random() * parts.length)];
    const { hour, minute } = getRandomTimeInRange(greetingPart);
    const greetingTime = now.set({ hour, minute, second: 0, millisecond: 0 });

    greetingTimeISO = greetingTime.toISO();
    await setData(timeKey, greetingTimeISO);
    await setData(partKey, greetingPart);
    console.log(`Greeting scheduled at ${greetingTime.toFormat("HH:mm")} (${greetingPart})`);
  }

  const greetingTime = DateTime.fromISO(greetingTimeISO).setZone('Europe/Vilnius');

  if (greetingSent || now < greetingTime) return;

  const messages = await getMessages();

  const userMessagesToday = messages.some(msg => {
    const msgTime = DateTime.fromISO(msg.created_time).setZone('Europe/Vilnius');
    return msgTime.toISODate() === today;
  });

  if (!userMessagesToday) {
    const greeting = await generateGreeting(greetingPart);
    await sendMessage(greeting);
    await setData(sentKey, true);
    console.log(`Greeting sent: "${greeting}"`);
  } else {
    await setData(sentKey, true);
    console.log('User already messaged today. Marking greeting as sent.');
  }
})();