import { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import express from 'express';
import https from 'https';
import http from 'http';

console.log('Bot starting...');

const app = express();
const PORT = process.env.PORT || 5000;

let ignoredChannels = new Set();
let isBotOffline = false;
let logChannelId = null;

// Maps lockedChannelId -> log message in the log channel
const channelLockLogs = new Map();

app.get('/', (req, res) => {
    res.send('Nuoh is running');
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});

// Keep-alive: ping self every 14 minutes so Render never puts the service to sleep
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if (SELF_URL) {
    setInterval(() => {
        const lib = SELF_URL.startsWith('https') ? https : http;
        lib.get(SELF_URL, (res) => {
            console.log(`Keep-alive ping: ${res.statusCode}`);
        }).on('error', (err) => {
            console.error('Keep-alive ping failed:', err.message);
        });
    }, 14 * 60 * 1000);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

const TARGET_USER_ID = '716390085896962058';
const OWNER_ID = '1396815034247806999';
const ADMIN_ROLE_ID = '1458127515280343173';
const PREFIX = 'nu!';

function isAuthorized(message) {
    if (message.author.id === OWNER_ID) return true;
    if (message.member && message.member.roles.cache.has(ADMIN_ROLE_ID)) return true;
    return false;
}

function parseTime(timeStr) {
    const match = timeStr.match(/^(\d+)([smhd])$/);
    if (!match) return null;
    const value = parseInt(match[1]);
    const unit = match[2];
    const multiplier = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    return value * multiplier[unit];
}

function reasonLabel(type) {
    if (type === 'shiny') return 'Shiny Hunt';
    if (type === 'rare') return 'Rare Spawn';
    if (type === 'regional') return 'Regional Spawn';
    return 'Unknown';
}

async function sendLockLog(channel, type, pingedUserId = null) {
    if (!logChannelId) return null;
    try {
        const logChannel = client.channels.cache.get(logChannelId);
        if (!logChannel) return null;

        const embed = new EmbedBuilder()
            .setTitle('Channel Locked')
            .addFields(
                { name: 'Channel', value: `<#${channel.id}>` },
                { name: 'Reason', value: reasonLabel(type) }
            )
            .setColor(0xFF4444)
            .setTimestamp();

        if (type === 'shiny' && pingedUserId) {
            embed.addFields({ name: 'Hunter', value: `<@${pingedUserId}>` });
        }

        const logMsg = await logChannel.send({ embeds: [embed] });
        return logMsg;
    } catch (err) {
        console.error('Log send error:', err);
        return null;
    }
}

async function editLockLogUnlocked(channelId, unlockedByUsername, auto = false) {
    const logMsg = channelLockLogs.get(channelId);
    if (!logMsg) return;
    try {
        const existing = logMsg.embeds[0];
        const updated = EmbedBuilder.from(existing)
            .setTitle('Channel Unlocked')
            .setColor(0x44FF88)
            .addFields({
                name: auto ? 'Auto-unlocked' : 'Unlocked by',
                value: auto ? 'After 12 hours (no action taken)' : `@${unlockedByUsername}`
            });
        await logMsg.edit({ embeds: [updated] });
        channelLockLogs.delete(channelId);
    } catch (err) {
        console.error('Log edit error:', err);
    }
}

async function lockChannel(channel, type, pingedUserId = null) {
    try {
        if (!channel.isTextBased() || channel.isDMBased()) return;

        const currentPerms = channel.permissionOverwrites.cache.get(TARGET_USER_ID);
        if (currentPerms && currentPerms.deny.has(PermissionsBitField.Flags.SendMessages)) return;

        await channel.permissionOverwrites.edit(TARGET_USER_ID, { SendMessages: false });

        let title = 'Spawn Detected';
        let description = '';
        if (type === 'shiny') {
            title = 'Shiny Hunt Detected';
            description = `Only pinged hunters can unlock\n<@${pingedUserId}>`;
        } else if (type === 'rare') {
            title = 'Rare Spawn Detected';
            description = 'The one who unlocks gets to catch';
        } else if (type === 'regional') {
            title = 'Regional Spawn Detected';
            description = 'The one who unlocks gets to catch';
        }

        const embed = new EmbedBuilder()
            .setTitle(title)
            .setDescription(description)
            .setImage('https://media3.giphy.com/media/v1.Y2lkPTZjMDliOTUybHFjZnM2a3M2ODgwcDkzN3E5enE4OXJxOXA2MHYwZmIzY3VyZHE2MyZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/hadn3KRK7J20hMoC5u/giphy.gif')
            .setFooter({ text: 'click the 🔓 below to unlock' })
            .setColor(0x00FFFF);

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`unlock_spawn_${pingedUserId || 'any'}`)
                    .setLabel('Unlock')
                    .setEmoji('🔓')
                    .setStyle(ButtonStyle.Primary),
            );

        const lockMessage = await channel.send({ embeds: [embed], components: [row] });

        // Send log
        const logMsg = await sendLockLog(channel, type, pingedUserId);
        if (logMsg) channelLockLogs.set(channel.id, logMsg);

        // Auto-unlock after 12 hours
        setTimeout(async () => {
            try {
                const fetchedMsg = await channel.messages.fetch(lockMessage.id).catch(() => null);
                if (fetchedMsg && fetchedMsg.components.length > 0 && !fetchedMsg.components[0].components[0].disabled) {
                    await channel.permissionOverwrites.edit(TARGET_USER_ID, { SendMessages: null });
                    const disabledRow = new ActionRowBuilder()
                        .addComponents(ButtonBuilder.from(fetchedMsg.components[0].components[0]).setDisabled(true));
                    await fetchedMsg.edit({ components: [disabledRow] });
                    await channel.send('The spawn has been automatically unlocked after 12 hours.');
                    await editLockLogUnlocked(channel.id, null, true);
                }
            } catch (err) {
                console.error('Auto-unlock error:', err);
            }
        }, 12 * 3600000);

        // Shiny reminder at 11 hours
        if (type === 'shiny' && pingedUserId) {
            setTimeout(async () => {
                try {
                    const fetchedMsg = await channel.messages.fetch(lockMessage.id).catch(() => null);
                    if (fetchedMsg && fetchedMsg.components.length > 0 && !fetchedMsg.components[0].components[0].disabled) {
                        await channel.send(`reminder <@${pingedUserId}>`);
                    }
                } catch (err) {
                    console.error('Shiny reminder error:', err);
                }
            }, 11 * 3600000);
        }

    } catch (error) {
        console.error('Error locking channel:', error);
    }
}

client.on('messageCreate', async (message) => {
    if (message.author.id === client.user.id) return;

    const botMention = `<@${client.user.id}>`;
    const botMentionNick = `<@!${client.user.id}>`;

    let commandBody = '';
    if (message.content.startsWith(botMention)) {
        commandBody = message.content.slice(botMention.length).trim();
    } else if (message.content.startsWith(botMentionNick)) {
        commandBody = message.content.slice(botMentionNick.length).trim();
    } else if (message.content.toLowerCase().startsWith(PREFIX)) {
        commandBody = message.content.slice(PREFIX.length).trim();
    }

    if (commandBody) {
        const args = commandBody.split(/\s+/);
        const command = args[0].toLowerCase();

        if (command === 'help') {
            const page1 = new EmbedBuilder()
                .setTitle('Hi, I am Nuoh!')
                .setDescription(`I am WooperLand's spawn locking bot made by <@${OWNER_ID}>.\n\nI love locking spawns muheheh .\n\n**Prefix:** \`${PREFIX}\` or mention me!`)
                .setColor(0x00FFFF)
                .setFooter({ text: 'Page 1/2 • Click below for commands' });

            const page2 = new EmbedBuilder()
                .setTitle('Nuoh Commands')
                .addFields(
                    { name: 'monitor #channels', value: 'Start monitoring spawns in these channels.' },
                    { name: 'ignore #channels', value: 'Stop monitoring spawns in these channels.' },
                    { name: 'setbotoffline', value: 'Stop automatic locking (Owner only).' },
                    { name: 'setbotonline', value: 'Resume automatic locking (Owner only).' },
                    { name: 'lock channel | Rare ping', value: 'Manually trigger a Rare lock.' },
                    { name: 'lock channel | Regional Spawn', value: 'Manually trigger a Regional lock.' },
                    { name: 'lock channel | shinyhunt @user', value: 'Manually trigger a Shiny Hunt lock.' },
                    { name: 'remind <time> <reason>', value: 'Set a reminder (e.g., 10s, 5m, 1h).' },
                    { name: 'log redirect #channel', value: 'Set the log channel (Owner only).' },
                )
                .setColor(0x00FFFF)
                .setFooter({ text: 'Page 2/2' });

            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('help_page_1')
                        .setLabel('About Me')
                        .setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId('help_page_2')
                        .setLabel('Commands')
                        .setStyle(ButtonStyle.Primary)
                );

            return message.reply({ embeds: [page1], components: [row], allowedMentions: { repliedUser: false } });
        }

        if (command === 'log') {
            const sub = args[1]?.toLowerCase();
            if (sub === 'redirect') {
                if (message.author.id !== OWNER_ID) {
                    return message.reply({ content: 'You don\'t have permissions to run this command', allowedMentions: { repliedUser: false } });
                }
                const mentioned = message.mentions.channels.first();
                if (!mentioned) {
                    return message.reply({ content: `Usage: ${PREFIX}log redirect #channel`, allowedMentions: { repliedUser: false } });
                }
                logChannelId = mentioned.id;
                return message.reply({ content: `Logs will now be sent to <#${mentioned.id}>`, allowedMentions: { repliedUser: false } });
            }
        }

        if (command === 'remind') {
            const timeStr = args[1];
            const reason = args.slice(2).join(' ');
            if (!timeStr || !reason) return message.reply({ content: `Usage: ${PREFIX}remind <time> <reason> (e.g., 10s, 5m)`, allowedMentions: { repliedUser: false } });
            const ms = parseTime(timeStr);
            if (!ms) return message.reply({ content: 'Invalid time format. Use 10s, 5m, 1h, etc.', allowedMentions: { repliedUser: false } });

            message.reply({ content: `Got it! I will remind you about "${reason}" in ${timeStr}.`, allowedMentions: { repliedUser: false } });
            setTimeout(() => {
                message.reply({ content: `<@${message.author.id}> reminder from ${timeStr} ago reason: ${reason}`, allowedMentions: { repliedUser: false } });
            }, ms);
            return;
        }

        if (command === 'setbotoffline') {
            if (message.author.id !== OWNER_ID) return message.reply({ content: 'You don\'t have permissions to run this command', allowedMentions: { repliedUser: false } });
            isBotOffline = true;
            return message.reply({ content: 'Bot is now **OFFLINE**.', allowedMentions: { repliedUser: false } });
        }

        if (command === 'setbotonline') {
            if (message.author.id !== OWNER_ID) return message.reply({ content: 'You don\'t have permissions to run this command', allowedMentions: { repliedUser: false } });
            isBotOffline = false;
            return message.reply({ content: 'Bot is now **ONLINE**.', allowedMentions: { repliedUser: false } });
        }

        if (command === 'monitor') {
            if (!isAuthorized(message)) return message.reply({ content: 'You don\'t have permissions to run this command', allowedMentions: { repliedUser: false } });
            const mentions = message.mentions.channels;
            if (mentions.size === 0) return message.reply({ content: 'Please mention at least one channel.', allowedMentions: { repliedUser: false } });
            mentions.forEach(channel => ignoredChannels.delete(channel.id));
            return message.reply({ content: `Now monitoring: ${mentions.map(c => `<#${c.id}>`).join(', ')}`, allowedMentions: { repliedUser: false } });
        }

        if (command === 'ignore') {
            if (!isAuthorized(message)) return message.reply({ content: 'You don\'t have permissions to run this command', allowedMentions: { repliedUser: false } });
            const mentions = message.mentions.channels;
            if (mentions.size === 0) return message.reply({ content: 'Please mention at least one channel.', allowedMentions: { repliedUser: false } });
            mentions.forEach(channel => ignoredChannels.add(channel.id));
            return message.reply({ content: `Now ignoring: ${mentions.map(c => `<#${c.id}>`).join(', ')}`, allowedMentions: { repliedUser: false } });
        }

        if (commandBody.toLowerCase().startsWith('lock channel')) {
            if (!isAuthorized(message)) return message.reply({ content: 'You don\'t have permissions to run this command', allowedMentions: { repliedUser: false } });
            const parts = commandBody.split('|').map(p => p.trim());
            const typeStr = parts[1]?.toLowerCase() || '';
            if (typeStr.includes('rare')) {
                await lockChannel(message.channel, 'rare');
            } else if (typeStr.includes('regional')) {
                await lockChannel(message.channel, 'regional');
            } else if (typeStr.includes('shinyhunt')) {
                const mention = message.mentions.users.first();
                await lockChannel(message.channel, 'shiny', mention?.id);
            }
            return;
        }
    }

    // Auto-lock from other bots
    if (!isBotOffline && message.author.bot && !ignoredChannels.has(message.channel.id)) {
        if (message.content.includes('Shiny hunt pings:')) {
            const mention = message.mentions.users.first();
            await lockChannel(message.channel, 'shiny', mention?.id);
        } else if (message.content.includes('Rare ping:')) {
            await lockChannel(message.channel, 'rare');
        } else if (message.content.includes('Regional ping:')) {
            await lockChannel(message.channel, 'regional');
        }
    }
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    if (interaction.customId.startsWith('unlock_spawn_')) {
        const restrictedTo = interaction.customId.replace('unlock_spawn_', '');
        const isOwner = interaction.user.id === OWNER_ID;
        const isAdmin = interaction.member && interaction.member.roles.cache.has(ADMIN_ROLE_ID);
        const isTargetUser = restrictedTo === 'any' || interaction.user.id === restrictedTo;

        if (!isOwner && !isAdmin && !isTargetUser) {
            return interaction.reply({ content: 'Only pinged hunters can unlock', ephemeral: true });
        }

        try {
            const channel = interaction.channel;
            await channel.permissionOverwrites.edit(TARGET_USER_ID, { SendMessages: null });

            const disabledRow = new ActionRowBuilder()
                .addComponents(ButtonBuilder.from(interaction.message.components[0].components[0]).setDisabled(true));

            await interaction.update({ components: [disabledRow] });
            await channel.send(`The spawn has been unlocked by <@${interaction.user.id}>`);

            await editLockLogUnlocked(channel.id, interaction.user.username, false);
        } catch (error) {
            console.error('Error unlocking spawn:', error);
            await interaction.reply({ content: 'Failed to unlock the spawn.', ephemeral: true });
        }

    } else if (interaction.customId.startsWith('help_page_')) {
        const page1 = new EmbedBuilder()
            .setTitle('Hi, I am Nuoh!')
            .setDescription(`I am WooperLand's spawn locking bot made by <@${OWNER_ID}>.\n\nI help manage spawns by locking channels when rare or shiny Pokémon appear, ensuring the right people get a chance to catch them.\n\n**Prefix:** \`${PREFIX}\` or mention me!`)
            .setColor(0x00FFFF)
            .setFooter({ text: 'Page 1/2 • Click below for commands' });

        const page2 = new EmbedBuilder()
            .setTitle('Nuoh Commands')
            .addFields(
                { name: 'monitor #channels', value: 'Start monitoring spawns in these channels.' },
                { name: 'ignore #channels', value: 'Stop monitoring spawns in these channels.' },
                { name: 'setbotoffline', value: 'Stop automatic locking (Owner only).' },
                { name: 'setbotonline', value: 'Resume automatic locking (Owner only).' },
                { name: 'lock channel | Rare ping', value: 'Manually trigger a Rare lock.' },
                { name: 'lock channel | Regional Spawn', value: 'Manually trigger a Regional lock.' },
                { name: 'lock channel | shinyhunt @user', value: 'Manually trigger a Shiny Hunt lock.' },
                { name: 'remind <time> <reason>', value: 'Set a reminder (e.g., 10s, 5m, 1h).' },
                { name: 'log redirect #channel', value: 'Set the log channel (Owner only).' },
            )
            .setColor(0x00FFFF)
            .setFooter({ text: 'Page 2/2' });

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('help_page_1')
                    .setLabel('About Me')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('help_page_2')
                    .setLabel('Commands')
                    .setStyle(ButtonStyle.Primary)
            );

        if (interaction.customId === 'help_page_1') {
            await interaction.update({ embeds: [page1], components: [row] });
        } else {
            await interaction.update({ embeds: [page2], components: [row] });
        }
    }
});

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
});

if (process.env.TOKEN) {
    console.log('Logging into Discord...');
    client.login(process.env.TOKEN).catch((err) => {
        console.error('Failed to log in:', err.message);
        process.exit(1);
    });
} else {
    console.error('No TOKEN provided. Set the TOKEN environment variable.');
    process.exit(1);
}
