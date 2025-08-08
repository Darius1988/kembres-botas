import axios from 'axios';
import { DateTime } from 'luxon';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Get script directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env file from script directory
dotenv.config({ path: path.join(__dirname, '.env') });

if (!process.env.OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY is not set');
}

// CONFIG
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const FB_API_URL = 'https://graph.facebook.com/v19.0/me/messages';

// DB HELPER
async function getDB() {
  return open({
    filename: path.join(__dirname, 'data.db'),
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

// Patikrinti ar laikas tarp 8:00–21:00
function isAllowedTime() {
  const now = DateTime.now().setZone('Europe/Vilnius');
  return now.hour >= 8 && now.hour < 21;
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
async function getMessages(conversationId, accessToken) {
  const url = `https://graph.facebook.com/v19.0/${conversationId}/messages?fields=message,from,created_time&access_token=${accessToken}`;
  const res = await axios.get(url);
  return (res.data.data || []).reverse();
}

async function sendMessage(text, recipientId, accessToken) {
  await axios.post(FB_API_URL, {
    recipient: { id: recipientId },
    message: { text },
  }, {
    params: { access_token: accessToken },
  });
}

// OPENAI
async function generateGreeting(part) {
  const prompt = `Sukurk trumpą,atsitiktinę žinutę mamai, kurią sūnus galėtų parašyti per Messenger. Nenaudok mazybiniu zodziu, ar meiles issireiskimu. Naudok dienos laiką "${part}". Žinutė turi būti trumpa, draugiška ir viena iš galimų pavyzdžių galėtų būti:
- Labas rytas Mama, kaip tu šiandien laikaisi?
- Labas, kaip sekasi?
- Labas vakaras, kaip tu?

Grąžink tik vieną trumpą žinutę, tinkančią laikui "${part}".`;

  const res = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: "gpt-4",
    messages: [
      { role: "system", content: "Tu esi sūnus, rašantis mielą vienkartinę žinutę savo mamai per Messenger." },
      { role: "user", content: prompt }
    ],
    temperature: 0.8,
  }, {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }
  });

  return res.data.choices[0].message.content.trim();
}

// Generuoti atsakymą iš OpenAI
async function generateReply(messages, recipientId) {
  const prompt = messages.map(m => `${m.from.id === recipientId ? 'Mama' : 'Botas'}: ${m.message}`).join('\n') + '\nBotas:';
  const res = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: "gpt-4",
    messages: [
      {
        role: "system",
        content: (
          "Tu esi sūnus, rašantis šiltą trumpą žinutę savo mamai messenger platfotrmoje, "+
          "nereikia zinutes pabaigoje rasyti kad tai tu. Nereikia kreiptis zinuteje 'Mama', kreipkis \"tu/tavo\". "+
          "Naudok maziau familiarumu, bet kazkiek naudok. "+
          "Nereik sakyt: Myliu. Susirasinejimas vyksta daznai - maziau 'pasiilgau' ar 'pastoviai galvoju'."+
          "Pasistenk atsakyti kuo maloniau, bet trumpai."+
          "Jei zinuteje pries tai yra daug klausimu ir susirasinejime pries tai per paskutine savaite klausimu panasiu"+
          " - Gali paklausti kaip sekasi ar kazka panašaus."
        )
      },
      { role: "user", content: prompt }
    ],
    temperature: 0.7,
  }, {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }
  });

  return res.data.choices[0].message.content.trim();
}

// Handle auto-reply functionality
async function handleAutoReply(messages, recipientId, accessToken) {
  const now = DateTime.now().setZone('Europe/Vilnius');
  
  if (messages.length > 0) {
    const lastMessage = messages[messages.length - 1];
    const lastMessageTime = DateTime.fromISO(lastMessage.created_time).setZone('Europe/Vilnius');
    const isFromUser = lastMessage.from.id === recipientId;
    const minutesSince = now.diff(lastMessageTime, 'minutes').minutes;

    // If last message is from user and >4 minutes ago, reply
    if (isFromUser && minutesSince >= 4 && isAllowedTime()) {
      const reply = await generateReply(messages, recipientId);
      await sendMessage(reply, recipientId, accessToken);
      console.log(`Atsakyta: ${reply}`);
      return true; // Return true if reply was sent
    }

    if (!isFromUser) {
      console.log('Last message is not from user. Skipping auto-reply.');
    }
  }
  
  return false; // Return false if no reply was sent
}

// Pagrindinė funkcija
async function run(cfg) {
  const { accessToken, conversationId, recipientId } = cfg;

  await initDB();
  const now = DateTime.now().setZone('Europe/Vilnius');
  const today = now.toISODate();
  const weekday = now.weekday;

  // Check for auto-reply functionality first
  const messages = await getMessages(conversationId, accessToken);
  const replySent = await handleAutoReply(messages, recipientId, accessToken);
  
  if (replySent) {
    return; // Exit after replying
  }

  const weekKey = `greeting_weekdays_${recipientId}_${now.startOf('week').toISODate()}`;
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

  const sentKey = `greeting_sent_${today}_${recipientId}`;
  const timeKey = `greeting_time_${today}_${recipientId}`;
  const partKey = `greeting_part_${today}_${recipientId}`;

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

  if (greetingSent || now < greetingTime || !isAllowedTime()) {
    return;
  }

  // Re-get messages for greeting logic (avoid duplicate API call)
  const greetingMessages = messages || await getMessages(conversationId, accessToken);

  const userMessagesToday = greetingMessages.some(msg => {
    const msgTime = DateTime.fromISO(msg.created_time).setZone('Europe/Vilnius');
    return msgTime.toISODate() === today;
  });

  if (!userMessagesToday) {
    const greeting = await generateGreeting(greetingPart);
    await sendMessage(greeting, recipientId, accessToken);
    await setData(sentKey, true);
    console.log(`Greeting sent: "${greeting}"`);
  } else {
    await setData(sentKey, true);
    console.log('User already messaged today. Marking greeting as sent.');
  }
}


// Darius config
const cfgDarius = {
  accessToken: 'EAAkklPKFq8oBO9LjTZB0Y704HZCxRRZA1pjjnLJbhIlPqGyC0izVf05nye1POZBRMUfKYsQI8aEWXtinZBeZA2UT9tgPXDIZBzoTj5mvOGIt0xg5SRRmYLiQWuJoLeAAi7ACtRDPSncLPS4y3Lt6Hzi5eZBjvcry2Im1SI0kv6649rFv9GtXSVzcNXZBHOAZDZD',
  conversationId: 't_24557998333789832',
  recipientId: '29653243407655161'
}

// Run all configs
const runAll = async () => {
  console.log(' -- Darius cycle is starting');
  await run(cfgDarius);
  console.log(' -- Darius cycle is done');
}

runAll().catch(console.error);
