import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const DATA_FILE = join(DATA_DIR, 'guilds.json');

let store = {};

try {
    if (existsSync(DATA_FILE)) {
        store = JSON.parse(readFileSync(DATA_FILE, 'utf-8'));
    }
} catch (e) {
    console.error('Failed to load guild data:', e.message);
}

function persist() {
    try {
        mkdirSync(DATA_DIR, { recursive: true });
        writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
    } catch (e) {
        console.error('Failed to save guild data:', e.message);
    }
}

export function getGuild(guildId) {
    if (!store[guildId]) {
        store[guildId] = {
            logChannelId: null,
            modRoles: [],
            moderatedChannels: [],
            moderatedCategories: [],
            warnings: {},
        };
    }
    return store[guildId];
}

export function saveGuild(guildId, guildData) {
    store[guildId] = guildData;
    persist();
}

export function getWarnings(guildId, userId) {
    return getGuild(guildId).warnings[userId] || 0;
}

export function addWarning(guildId, userId) {
    const guild = getGuild(guildId);
    guild.warnings[userId] = (guild.warnings[userId] || 0) + 1;
    saveGuild(guildId, guild);
    return guild.warnings[userId];
}
