import {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    EmbedBuilder,
    PermissionsBitField,
    PermissionFlagsBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} from 'discord.js';
import keepAlive from './keep_alive.js';
import { getGuild, saveGuild, getWarnings, addWarning, setWarnings } from './storage.js';

console.log('Bot starting...');
keepAlive();

// ─── Crash protection ─────────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
    console.error('[Uncaught Exception]', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('[Unhandled Rejection]', reason);
});

// ─── Constants ────────────────────────────────────────────────────────────────
const PREFIX = 'nu!';
const OWNER_ID = '1396815034247806999';
const TARGET_USER_ID = '716390085896962058'; // Pokétwo bot

const botOfflineGuilds = new Set();

// Per-channel active lock data: channelId → { hunters, isHunterType, type, logMsg, lockMessage }
const activeLocks = new Map();

// ─── Client ───────────────────────────────────────────────────────────────────
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
    ],
});

// ─── Slash commands ───────────────────────────────────────────────────────────
const slashCommands = [
    new SlashCommandBuilder()
        .setName('setmod')
        .setDescription('Toggle a moderator role (adds if not present, removes if present)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addRoleOption(opt =>
            opt.setName('role').setDescription('Role to add or remove as mod role').setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('moderate')
        .setDescription('Toggle a channel or category for spawn monitoring')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addChannelOption(opt =>
            opt.setName('channel').setDescription('Channel to toggle').setRequired(false)
        )
        .addStringOption(opt =>
            opt.setName('category').setDescription('Category ID to toggle').setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName('timeout')
        .setDescription('Timeout a member')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addUserOption(opt =>
            opt.setName('member').setDescription('Member to timeout').setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName('time').setDescription('Duration e.g. 10m, 1h, 1d').setRequired(false)
        )
        .addStringOption(opt =>
            opt.setName('reason').setDescription('Reason for timeout').setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName('warn')
        .setDescription('Warn a member — 1st warn=10min, 2nd=1h, 3rd+=12h timeout')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addUserOption(opt =>
            opt.setName('member').setDescription('Member to warn').setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName('reason').setDescription('Reason for warning').setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName('settings')
        .setDescription('View current bot settings for this server'),
];

// ─── Utilities ────────────────────────────────────────────────────────────────
function parseTime(timeStr) {
    const match = timeStr?.match(/^(\d+)([smhd])$/);
    if (!match) return null;
    const value = parseInt(match[1]);
    const unit = match[2];
    const multiplier = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    return value * multiplier[unit];
}

function msToLabel(ms) {
    if (ms < 60000) return `${ms / 1000}s`;
    if (ms < 3600000) return `${ms / 60000}m`;
    if (ms < 86400000) return `${ms / 3600000}h`;
    return `${ms / 86400000}d`;
}

function warnToMs(count) {
    if (count === 1) return 10 * 60 * 1000;
    if (count === 2) return 60 * 60 * 1000;
    return 12 * 60 * 60 * 1000;
}

function warnToLabel(count) {
    if (count === 1) return '10 minutes';
    if (count === 2) return '1 hour';
    return '12 hours';
}

function reasonLabel(type) {
    const map = { shiny: 'Shiny Hunt', rare: 'Rare Spawn', regional: 'Regional Spawn' };
    return map[type] || 'Unknown';
}

function isOwner(userId) {
    return userId === OWNER_ID;
}

function hasModPermission(member, guildData) {
    if (!member) return false;
    if (isOwner(member.user.id)) return true;
    if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    if (member.permissions.has(PermissionFlagsBits.ModerateMembers)) return true;
    return guildData.modRoles.some(roleId => member.roles.cache.has(roleId));
}

function isChannelMonitored(channel, guildData) {
    if (guildData.moderatedChannels.length === 0 && guildData.moderatedCategories.length === 0) {
        return false;
    }
    if (guildData.moderatedChannels.includes(channel.id)) return true;
    if (channel.parentId && guildData.moderatedCategories.includes(channel.parentId)) return true;
    return false;
}

// Check if a specific lock type is enabled — channel setting overrides guild setting
function isLockEnabled(guildData, channelId, type) {
    const chSetting = guildData.channelLockTypes?.[channelId];
    if (chSetting && typeof chSetting[type] === 'boolean') return chSetting[type];
    const guildSetting = guildData.lockTypes?.[type];
    if (typeof guildSetting === 'boolean') return guildSetting;
    return true;
}

// Extract user IDs mentioned only on the line containing a keyword
// e.g. extractLineIds(content, 'Shiny hunt pings:') won't include IDs from the Collection line
function extractLineIds(content, keyword) {
    const lower = content.toLowerCase();
    const idx = lower.indexOf(keyword.toLowerCase());
    if (idx === -1) return [];
    const after = content.slice(idx + keyword.length);
    const lineEnd = after.indexOf('\n');
    const line = lineEnd === -1 ? after : after.slice(0, lineEnd);
    const matches = line.match(/<@!?(\d+)>/g) || [];
    return matches.map(m => m.replace(/<@!?/, '').replace('>', ''));
}

// ─── Logging ──────────────────────────────────────────────────────────────────
async function sendLog(guildId, embed) {
    const guildData = getGuild(guildId);
    if (!guildData.logChannelId) return null;
    try {
        const logChannel = await client.channels.fetch(guildData.logChannelId).catch(() => null);
        if (!logChannel) return null;
        return await logChannel.send({ embeds: [embed] });
    } catch (err) {
        console.error('Log send error:', err.message);
        return null;
    }
}

async function editLog(logMsg, embed) {
    try {
        await logMsg.edit({ embeds: [embed] });
    } catch (err) {
        console.error('Log edit error:', err.message);
    }
}

// ─── Settings embed ───────────────────────────────────────────────────────────
function buildSettingsEmbed(guildData, guild) {
    const modRoleStr = guildData.modRoles.length > 0
        ? guildData.modRoles.map(id => `<@&${id}>`).join(', ')
        : 'None set';

    const channelStr = guildData.moderatedChannels.length > 0
        ? guildData.moderatedChannels.map(id => `<#${id}>`).join(', ')
        : 'None configured';

    const categoryStr = guildData.moderatedCategories.length > 0
        ? guildData.moderatedCategories.map(id => `\`${id}\``).join(', ')
        : 'None';

    const logStr = guildData.logChannelId ? `<#${guildData.logChannelId}>` : 'Not set';

    const lt = guildData.lockTypes || { rare: true, shiny: true, regional: true };
    const lockStr = [
        `Shiny: ${lt.shiny ? '✅' : '❌'}`,
        `Rare: ${lt.rare ? '✅' : '❌'}`,
        `Regional: ${lt.regional ? '✅' : '❌'}`,
    ].join('  ');

    return new EmbedBuilder()
        .setTitle(`⚙️ Settings — ${guild.name}`)
        .addFields(
            { name: 'Mod Roles', value: modRoleStr },
            { name: 'Monitored Channels', value: channelStr },
            { name: 'Monitored Categories', value: categoryStr },
            { name: 'Log Channel', value: logStr },
            { name: 'Server Lock Types', value: lockStr },
            { name: 'Channel Overrides', value: 'Use `nu!channelsettings` in a channel to view/set per-channel overrides.' },
        )
        .setColor(0x00FFFF)
        .setTimestamp();
}

// ─── Timeout action ───────────────────────────────────────────────────────────
async function applyTimeout(member, ms, reason, moderatorId, { interaction, message } = {}) {
    try {
        await member.timeout(ms, reason);
        const duration = msToLabel(ms);

        const logEmbed = new EmbedBuilder()
            .setTitle('⏱️ Member Timed Out')
            .addFields(
                { name: 'User', value: `<@${member.id}> (${member.user.tag})`, inline: true },
                { name: 'Duration', value: duration, inline: true },
                { name: 'Reason', value: reason || 'No reason provided' },
                { name: 'Moderator', value: `<@${moderatorId}>` },
            )
            .setColor(0xFF8800)
            .setTimestamp();

        await sendLog(member.guild.id, logEmbed);

        const reply = `Timed out <@${member.id}> for **${duration}**. Reason: ${reason || 'No reason provided'}`;
        if (interaction) {
            await interaction.reply({ content: reply });
        } else if (message) {
            await message.reply({ content: reply, allowedMentions: { repliedUser: false } });
        }
    } catch (err) {
        const msg = err.code === 50013
            ? 'I don\'t have permission to timeout this member.'
            : `Failed to timeout: ${err.message}`;
        if (interaction) await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
        else if (message) await message.reply({ content: msg, allowedMentions: { repliedUser: false } }).catch(() => {});
    }
}

// ─── Spawn locking ────────────────────────────────────────────────────────────
async function lockChannel(channel, type, hunters = [], moderatorId = null) {
    try {
        if (!channel.isTextBased() || channel.isDMBased()) return;

        const current = channel.permissionOverwrites.cache.get(TARGET_USER_ID);
        if (current && current.deny.has(PermissionsBitField.Flags.SendMessages)) return;

        await channel.permissionOverwrites.edit(TARGET_USER_ID, { SendMessages: false });

        const hunterMentions = hunters.map(id => `<@${id}>`).join(' ');
        const isHunterType = type === 'shiny';

        let title, description;
        if (type === 'shiny') {
            title = '✨ Shiny Hunt Detected';
            description = hunters.length > 0
                ? `Only pinged hunters can unlock\n${hunterMentions}`
                : 'Only admins/mods can unlock';
        } else if (type === 'rare') {
            title = '⭐ Rare Spawn Detected';
            description = 'The one who unlocks gets to catch';
        } else {
            title = '🌍 Regional Spawn Detected';
            description = 'The one who unlocks gets to catch';
        }

        const embed = new EmbedBuilder()
            .setTitle(title)
            .setDescription(description)
            .setImage('https://media3.giphy.com/media/v1.Y2lkPTZjMDliOTUybHFjZnM2a3M2ODgwcDkzN3E5enE4OXJxOXA2MHYwZmIzY3VyZHE2MyZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/hadn3KRK7J20hMoC5u/giphy.gif')
            .setFooter({ text: 'click the 🔓 below to unlock' })
            .setColor(0x00FFFF);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`unlock_${channel.id}`)
                .setLabel('Unlock')
                .setEmoji('🔓')
                .setStyle(ButtonStyle.Primary),
        );

        const lockMessage = await channel.send({ embeds: [embed], components: [row] });

        const logEmbed = new EmbedBuilder()
            .setTitle('🔒 Channel Locked')
            .addFields(
                { name: 'Channel', value: `<#${channel.id}>`, inline: true },
                { name: 'Reason', value: reasonLabel(type), inline: true },
            )
            .setColor(0xFF4444)
            .setTimestamp();

        if (isHunterType && hunters.length > 0) {
            logEmbed.addFields({ name: 'Hunters', value: hunterMentions });
        }
        if (moderatorId) {
            logEmbed.addFields({ name: 'Triggered by', value: `<@${moderatorId}>` });
        }

        const logMsg = await sendLog(channel.guild.id, logEmbed);
        activeLocks.set(channel.id, { hunters, type, isHunterType, logMsg, lockMessage });

        // Auto-unlock after 12 hours
        setTimeout(async () => {
            try {
                const lock = activeLocks.get(channel.id);
                if (!lock) return;
                const fetched = await channel.messages.fetch(lock.lockMessage.id).catch(() => null);
                if (fetched && fetched.components[0]?.components[0]?.disabled === false) {
                    await channel.permissionOverwrites.edit(TARGET_USER_ID, { SendMessages: null });
                    const disabledRow = new ActionRowBuilder().addComponents(
                        ButtonBuilder.from(fetched.components[0].components[0]).setDisabled(true)
                    );
                    await fetched.edit({ components: [disabledRow] });
                    await channel.send('The spawn has been automatically unlocked after 12 hours.');
                    if (lock.logMsg) {
                        await editLog(lock.logMsg, EmbedBuilder.from(lock.logMsg.embeds[0])
                            .setTitle('🔓 Channel Unlocked (Auto)')
                            .setColor(0x44FF88)
                            .addFields({ name: 'Auto-unlocked', value: 'After 12 hours (no action taken)' })
                        );
                    }
                    activeLocks.delete(channel.id);
                }
            } catch (err) {
                console.error('Auto-unlock error:', err.message);
            }
        }, 12 * 3600000);

        // 11-hour reminder for shiny
        if (isHunterType && hunters.length > 0) {
            setTimeout(async () => {
                try {
                    const lock = activeLocks.get(channel.id);
                    if (!lock) return;
                    const fetched = await channel.messages.fetch(lock.lockMessage.id).catch(() => null);
                    if (fetched && fetched.components[0]?.components[0]?.disabled === false) {
                        await channel.send(`Reminder: ${hunters.map(id => `<@${id}>`).join(' ')}`);
                    }
                } catch (err) {
                    console.error('Reminder error:', err.message);
                }
            }, 11 * 3600000);
        }

    } catch (err) {
        console.error('Lock channel error:', err.message);
    }
}

// ─── Slash command handler ────────────────────────────────────────────────────
async function handleSlash(interaction) {
    const guildData = getGuild(interaction.guildId);

    if (interaction.commandName === 'setmod') {
        const role = interaction.options.getRole('role');
        if (guildData.modRoles.includes(role.id)) {
            guildData.modRoles = guildData.modRoles.filter(id => id !== role.id);
            saveGuild(interaction.guildId, guildData);
            return interaction.reply({ content: `Removed <@&${role.id}> from mod roles.` });
        }
        guildData.modRoles.push(role.id);
        saveGuild(interaction.guildId, guildData);
        return interaction.reply({ content: `Added <@&${role.id}> as a mod role.` });
    }

    if (interaction.commandName === 'moderate') {
        const ch = interaction.options.getChannel('channel');
        const catId = interaction.options.getString('category');
        if (!ch && !catId) return interaction.reply({ content: 'Provide a channel or a category ID.', ephemeral: true });

        const replies = [];
        if (ch) {
            if (guildData.moderatedChannels.includes(ch.id)) {
                guildData.moderatedChannels = guildData.moderatedChannels.filter(id => id !== ch.id);
                replies.push(`Removed <#${ch.id}> from monitored channels.`);
            } else {
                guildData.moderatedChannels.push(ch.id);
                replies.push(`Added <#${ch.id}> to monitored channels.`);
            }
        }
        if (catId) {
            if (guildData.moderatedCategories.includes(catId)) {
                guildData.moderatedCategories = guildData.moderatedCategories.filter(id => id !== catId);
                replies.push(`Removed category \`${catId}\` from monitored categories.`);
            } else {
                guildData.moderatedCategories.push(catId);
                replies.push(`Added category \`${catId}\` to monitored categories.`);
            }
        }
        saveGuild(interaction.guildId, guildData);
        return interaction.reply({ content: replies.join('\n') });
    }

    if (interaction.commandName === 'timeout') {
        const target = interaction.options.getMember('member');
        const timeStr = interaction.options.getString('time') || '10m';
        const reason = interaction.options.getString('reason') || 'No reason provided';
        if (!target) return interaction.reply({ content: 'Member not found in this server.', ephemeral: true });
        const ms = parseTime(timeStr);
        if (!ms) return interaction.reply({ content: 'Invalid time. Use formats like: 10m, 1h, 1d', ephemeral: true });
        return applyTimeout(target, ms, reason, interaction.user.id, { interaction });
    }

    if (interaction.commandName === 'warn') {
        const target = interaction.options.getMember('member');
        const reason = interaction.options.getString('reason') || 'No reason provided';
        if (!target) return interaction.reply({ content: 'Member not found in this server.', ephemeral: true });

        const count = addWarning(interaction.guildId, target.id);
        const ms = warnToMs(count);
        const timeLabel = warnToLabel(count);

        const warnEmbed = new EmbedBuilder()
            .setTitle('⚠️ Member Warned')
            .addFields(
                { name: 'User', value: `<@${target.id}> (${target.user.tag})`, inline: true },
                { name: 'Warning #', value: `${count}`, inline: true },
                { name: 'Timeout Applied', value: timeLabel, inline: true },
                { name: 'Reason', value: reason },
                { name: 'Moderator', value: `<@${interaction.user.id}>` },
            )
            .setColor(0xFFAA00)
            .setTimestamp();

        await sendLog(interaction.guildId, warnEmbed);
        return applyTimeout(target, ms, `Warning #${count}: ${reason}`, interaction.user.id, { interaction });
    }

    if (interaction.commandName === 'settings') {
        return interaction.reply({ embeds: [buildSettingsEmbed(guildData, interaction.guild)] });
    }
}

// ─── Prefix command handler ───────────────────────────────────────────────────
async function handlePrefix(message, commandBody) {
    const args = commandBody.trim().split(/\s+/);
    const command = args[0].toLowerCase();
    const guildData = getGuild(message.guild.id);

    const noPerms = () => message.reply({ content: 'You don\'t have permissions to run this command.', allowedMentions: { repliedUser: false } });

    // ── help ──
    if (command === 'help') {
        const embed = new EmbedBuilder()
            .setTitle('Nuoh Commands')
            .addFields(
                { name: '**🔒 Spawn Management**', value: '\u200b' },
                { name: `\`${PREFIX}lock channel | Rare ping\``, value: 'Manually trigger a Rare lock.' },
                { name: `\`${PREFIX}lock channel | Regional Spawn\``, value: 'Manually trigger a Regional lock.' },
                { name: `\`${PREFIX}lock channel | shinyhunt @users\``, value: 'Manually trigger a Shiny lock.' },
                { name: `\`${PREFIX}setbotoffline\` / \`${PREFIX}setbotonline\``, value: 'Pause or resume auto-locking (Owner only).' },
                { name: '**⚖️ Moderation**', value: '\u200b' },
                { name: `\`${PREFIX}timeout @user|ID [time] [reason]\``, value: 'Timeout a member. Also: `nu!to`' },
                { name: `\`${PREFIX}warn @user|ID [reason]\``, value: '1st warn = 10min, 2nd = 1h, 3rd+ = 12h timeout.' },
                { name: `\`${PREFIX}warns @user|ID\``, value: 'Check a member\'s current warning count.' },
                { name: `\`${PREFIX}clearwarn @user|ID [amount]\``, value: 'Clear warns. Omit amount to clear all.' },
                { name: '**⚙️ Config**', value: '\u200b' },
                { name: `\`${PREFIX}settings\``, value: 'View current bot settings.' },
                { name: `\`${PREFIX}settings <shiny|rare|regional> lock <true|false>\``, value: 'Toggle a lock type server-wide.' },
                { name: `\`${PREFIX}channelsettings <shiny|rare|regional> lock <true|false>\``, value: 'Toggle a lock type for the current channel only.' },
                { name: `\`${PREFIX}setlog #channel\``, value: 'Set the log channel (Admin/Owner only).' },
                { name: `\`${PREFIX}remind <time> <reason>\``, value: 'Set a reminder. Supports: 10s, 5m, 1h, 1d.' },
                { name: '**Slash Commands**', value: '`/setmod` `/moderate` `/timeout` `/warn` `/settings`' },
            )
            .setColor(0x00FFFF)
            .setFooter({ text: `Prefix: ${PREFIX} — or mention me!` });

        return message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
    }

    // ── settings ──
    if (command === 'settings') {
        // nu!settings shiny lock true/false
        const sub = args[1]?.toLowerCase();
        const lockWord = args[2]?.toLowerCase();
        const value = args[3]?.toLowerCase();

        const LOCK_TYPES = ['shiny', 'rare', 'regional'];
        if (LOCK_TYPES.includes(sub) && lockWord === 'lock' && (value === 'true' || value === 'false')) {
            if (!hasModPermission(message.member, guildData)) return noPerms();
            if (!guildData.lockTypes) guildData.lockTypes = { rare: true, shiny: true, regional: true };
            guildData.lockTypes[sub] = value === 'true';
            saveGuild(message.guild.id, guildData);
            return message.reply({
                content: `Server-wide **${sub}** lock is now **${value === 'true' ? 'enabled ✅' : 'disabled ❌'}**.`,
                allowedMentions: { repliedUser: false },
            });
        }

        return message.reply({ embeds: [buildSettingsEmbed(guildData, message.guild)], allowedMentions: { repliedUser: false } });
    }

    // ── channelsettings ──
    if (command === 'channelsettings') {
        const sub = args[1]?.toLowerCase();
        const lockWord = args[2]?.toLowerCase();
        const value = args[3]?.toLowerCase();

        const LOCK_TYPES = ['shiny', 'rare', 'regional'];
        if (!LOCK_TYPES.includes(sub) || lockWord !== 'lock' || (value !== 'true' && value !== 'false')) {
            return message.reply({
                content: `Usage: \`${PREFIX}channelsettings <shiny|rare|regional> lock <true|false>\`\nApplies to the current channel.`,
                allowedMentions: { repliedUser: false },
            });
        }

        if (!hasModPermission(message.member, guildData)) return noPerms();

        if (!guildData.channelLockTypes) guildData.channelLockTypes = {};
        if (!guildData.channelLockTypes[message.channel.id]) {
            guildData.channelLockTypes[message.channel.id] = {};
        }
        guildData.channelLockTypes[message.channel.id][sub] = value === 'true';
        saveGuild(message.guild.id, guildData);
        return message.reply({
            content: `**${sub}** lock for <#${message.channel.id}> is now **${value === 'true' ? 'enabled ✅' : 'disabled ❌'}**.`,
            allowedMentions: { repliedUser: false },
        });
    }

    // ── setlog / log redirect ──
    if (command === 'setlog' || (command === 'log' && args[1]?.toLowerCase() === 'redirect')) {
        if (!isOwner(message.author.id) && !message.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return noPerms();
        }
        const mentioned = message.mentions.channels.first();
        if (!mentioned) return message.reply({ content: `Usage: \`${PREFIX}setlog #channel\``, allowedMentions: { repliedUser: false } });
        guildData.logChannelId = mentioned.id;
        saveGuild(message.guild.id, guildData);
        return message.reply({ content: `Logs will now be sent to <#${mentioned.id}>`, allowedMentions: { repliedUser: false } });
    }

    // ── remind ──
    if (command === 'remind') {
        const timeStr = args[1];
        const reason = args.slice(2).join(' ');
        if (!timeStr || !reason) return message.reply({ content: `Usage: \`${PREFIX}remind <time> <reason>\``, allowedMentions: { repliedUser: false } });
        const ms = parseTime(timeStr);
        if (!ms) return message.reply({ content: 'Invalid time format. Use 10s, 5m, 1h, etc.', allowedMentions: { repliedUser: false } });
        message.reply({ content: `Got it! I'll remind you about "${reason}" in ${timeStr}.`, allowedMentions: { repliedUser: false } });
        setTimeout(() => {
            message.reply({ content: `<@${message.author.id}> reminder: ${reason}`, allowedMentions: { repliedUser: false } });
        }, ms);
        return;
    }

    // ── setbotoffline / setbotonline ──
    if (command === 'setbotoffline') {
        if (!isOwner(message.author.id)) return noPerms();
        botOfflineGuilds.add(message.guild.id);
        return message.reply({ content: 'Bot auto-locking is now **OFFLINE** for this server.', allowedMentions: { repliedUser: false } });
    }
    if (command === 'setbotonline') {
        if (!isOwner(message.author.id)) return noPerms();
        botOfflineGuilds.delete(message.guild.id);
        return message.reply({ content: 'Bot auto-locking is now **ONLINE** for this server.', allowedMentions: { repliedUser: false } });
    }

    // ── timeout / to ──
    if (command === 'timeout' || command === 'to') {
        if (!hasModPermission(message.member, guildData)) return noPerms();

        let target = message.mentions.members.first();
        if (!target && args[1] && /^\d+$/.test(args[1])) {
            target = await message.guild.members.fetch(args[1]).catch(() => null);
        }
        if (!target) return message.reply({ content: `Usage: \`${PREFIX}timeout @user [time] [reason]\``, allowedMentions: { repliedUser: false } });

        const argOffset = 2;
        const timeStr = args[argOffset] && /^\d+[smhd]$/.test(args[argOffset]) ? args[argOffset] : '10m';
        const reasonStart = args[argOffset] && /^\d+[smhd]$/.test(args[argOffset]) ? argOffset + 1 : argOffset;
        const reason = args.slice(reasonStart).join(' ') || 'No reason provided';
        const ms = parseTime(timeStr);
        if (!ms) return message.reply({ content: 'Invalid time format. Use 10s, 5m, 1h, 1d', allowedMentions: { repliedUser: false } });

        return applyTimeout(target, ms, reason, message.author.id, { message });
    }

    // ── warn ──
    if (command === 'warn') {
        if (!hasModPermission(message.member, guildData)) return noPerms();

        let target = message.mentions.members.first();
        if (!target && args[1] && /^\d+$/.test(args[1])) {
            target = await message.guild.members.fetch(args[1]).catch(() => null);
        }
        if (!target) return message.reply({ content: `Usage: \`${PREFIX}warn @user [reason]\``, allowedMentions: { repliedUser: false } });

        const reason = args.slice(2).join(' ') || 'No reason provided';
        const count = addWarning(message.guild.id, target.id);
        const ms = warnToMs(count);
        const timeLabel = warnToLabel(count);

        const warnEmbed = new EmbedBuilder()
            .setTitle('⚠️ Member Warned')
            .addFields(
                { name: 'User', value: `<@${target.id}> (${target.user.tag})`, inline: true },
                { name: 'Warning #', value: `${count}`, inline: true },
                { name: 'Timeout Applied', value: timeLabel, inline: true },
                { name: 'Reason', value: reason },
                { name: 'Moderator', value: `<@${message.author.id}>` },
            )
            .setColor(0xFFAA00)
            .setTimestamp();

        await sendLog(message.guild.id, warnEmbed);
        return applyTimeout(target, ms, `Warning #${count}: ${reason}`, message.author.id, { message });
    }

    // ── warns (check) ──
    if (command === 'warns') {
        let target = message.mentions.members.first();
        if (!target && args[1] && /^\d+$/.test(args[1])) {
            target = await message.guild.members.fetch(args[1]).catch(() => null);
        }
        if (!target) return message.reply({ content: `Usage: \`${PREFIX}warns @user\` or \`${PREFIX}warns userID\``, allowedMentions: { repliedUser: false } });

        const count = getWarnings(message.guild.id, target.id);
        const next = count === 0 ? '1st warn → 10 min timeout'
            : count === 1 ? '2nd warn → 1h timeout'
            : count === 2 ? '3rd warn → 12h timeout'
            : 'Next warn → 12h timeout';

        const embed = new EmbedBuilder()
            .setTitle('⚠️ Warning Record')
            .addFields(
                { name: 'User', value: `<@${target.id}> (${target.user.tag})` },
                { name: 'Warnings', value: `${count}`, inline: true },
                { name: 'Next Action', value: next, inline: true },
            )
            .setColor(count === 0 ? 0x44FF88 : count < 3 ? 0xFFAA00 : 0xFF4444)
            .setTimestamp();

        return message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
    }

    // ── clearwarn ──
    if (command === 'clearwarn') {
        if (!hasModPermission(message.member, guildData)) return noPerms();

        let target = message.mentions.members.first();
        if (!target && args[1] && /^\d+$/.test(args[1])) {
            target = await message.guild.members.fetch(args[1]).catch(() => null);
        }
        if (!target) return message.reply({ content: `Usage: \`${PREFIX}clearwarn @user [amount]\``, allowedMentions: { repliedUser: false } });

        const current = getWarnings(message.guild.id, target.id);
        const amountArg = message.mentions.users.size > 0 ? args[2] : args[2];
        const amount = amountArg && /^\d+$/.test(amountArg) ? parseInt(amountArg) : null;

        const newCount = amount !== null ? Math.max(0, current - amount) : 0;
        setWarnings(message.guild.id, target.id, newCount);

        const removed = current - newCount;
        return message.reply({
            content: `Cleared **${removed}** warning(s) for <@${target.id}>. They now have **${newCount}** warning(s).`,
            allowedMentions: { repliedUser: false },
        });
    }

    // ── lock channel (manual) ──
    if (commandBody.toLowerCase().startsWith('lock channel')) {
        if (!hasModPermission(message.member, guildData)) return noPerms();
        const parts = commandBody.split('|').map(p => p.trim());
        const typeStr = parts[1]?.toLowerCase() || '';
        const hunters = [...message.mentions.users.values()].map(u => u.id);

        if (typeStr.includes('shinyhunt')) {
            await lockChannel(message.channel, 'shiny', hunters, message.author.id);
        } else if (typeStr.includes('rare')) {
            await lockChannel(message.channel, 'rare', [], message.author.id);
        } else if (typeStr.includes('regional')) {
            await lockChannel(message.channel, 'regional', [], message.author.id);
        } else {
            await message.reply({ content: 'Unknown lock type. Use `Rare ping`, `Regional Spawn`, or `shinyhunt @user`', allowedMentions: { repliedUser: false } });
        }
        return;
    }
}

// ─── Events ───────────────────────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
    if (!message.guild) return;
    if (message.author.id === client.user?.id) return;

    const botMention = `<@${client.user?.id}>`;
    const botMentionNick = `<@!${client.user?.id}>`;

    let commandBody = null;
    if (message.content.startsWith(botMention)) {
        commandBody = message.content.slice(botMention.length).trim();
    } else if (message.content.startsWith(botMentionNick)) {
        commandBody = message.content.slice(botMentionNick.length).trim();
    } else if (message.content.toLowerCase().startsWith(PREFIX)) {
        commandBody = message.content.slice(PREFIX.length).trim();
    }

    if (commandBody !== null) {
        try {
            await handlePrefix(message, commandBody);
        } catch (err) {
            console.error('Prefix command error:', err.message);
        }
        return;
    }

    // Auto-lock detection — only from other bots, only in configured channels
    if (botOfflineGuilds.has(message.guild.id)) return;
    if (!message.author.bot) return;

    const guildData = getGuild(message.guild.id);
    if (!isChannelMonitored(message.channel, guildData)) return;

    const content = message.content;
    const channelId = message.channel.id;

    if (content.includes('Shiny hunt pings:') || content.includes('Shiny Hunt pings:')) {
        if (!isLockEnabled(guildData, channelId, 'shiny')) return;
        // Extract ONLY the users mentioned on the shiny hunt line — not collection line users
        const hunters = extractLineIds(content, 'hunt pings:');
        await lockChannel(message.channel, 'shiny', hunters);

    } else if (content.includes('Rare ping:') || content.includes('Rare Ping:')) {
        if (!isLockEnabled(guildData, channelId, 'rare')) return;
        await lockChannel(message.channel, 'rare', []);

    } else if (content.includes('Regional ping:') || content.includes('Regional Ping:')) {
        if (!isLockEnabled(guildData, channelId, 'regional')) return;
        await lockChannel(message.channel, 'regional', []);
    }
    // Collection pings are intentionally not locked
});

client.on('interactionCreate', async (interaction) => {
    if (interaction.isChatInputCommand()) {
        try {
            await handleSlash(interaction);
        } catch (err) {
            console.error('Slash command error:', err.message);
            const reply = { content: 'An error occurred.', ephemeral: true };
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp(reply).catch(() => {});
            } else {
                await interaction.reply(reply).catch(() => {});
            }
        }
        return;
    }

    if (!interaction.isButton()) return;

    // Unlock button
    if (interaction.customId.startsWith('unlock_')) {
        const channelId = interaction.customId.replace('unlock_', '');
        const lock = activeLocks.get(channelId);
        const guildData = getGuild(interaction.guildId);

        const isOwnerUser = isOwner(interaction.user.id);
        const isMod = hasModPermission(interaction.member, guildData);

        let canUnlock = isOwnerUser || isMod;
        if (!canUnlock && lock?.isHunterType && lock?.hunters.length > 0) {
            canUnlock = lock.hunters.includes(interaction.user.id);
        } else if (!canUnlock && (!lock?.isHunterType || lock?.hunters.length === 0)) {
            canUnlock = true;
        }

        if (!canUnlock) {
            return interaction.reply({ content: 'Only pinged hunters can unlock this spawn.', ephemeral: true });
        }

        try {
            const channel = interaction.channel;
            await channel.permissionOverwrites.edit(TARGET_USER_ID, { SendMessages: null });

            const disabledRow = new ActionRowBuilder().addComponents(
                ButtonBuilder.from(interaction.message.components[0].components[0]).setDisabled(true)
            );
            await interaction.update({ components: [disabledRow] });
            await channel.send(`The spawn has been unlocked by <@${interaction.user.id}>`);

            if (lock?.logMsg) {
                await editLog(lock.logMsg, EmbedBuilder.from(lock.logMsg.embeds[0])
                    .setTitle('🔓 Channel Unlocked')
                    .setColor(0x44FF88)
                    .addFields({ name: 'Unlocked by', value: `@${interaction.user.username}` })
                );
            }
            activeLocks.delete(channelId);
        } catch (err) {
            console.error('Unlock error:', err.message);
            await interaction.reply({ content: 'Failed to unlock the spawn.', ephemeral: true }).catch(() => {});
        }
    }
});

// ─── Ready ────────────────────────────────────────────────────────────────────
client.once('clientReady', async (readyClient) => {
    console.log(`Logged in as ${readyClient.user.tag}!`);

    const rest = new REST().setToken(process.env.TOKEN);
    try {
        await rest.put(
            Routes.applicationCommands(readyClient.user.id),
            { body: slashCommands.map(cmd => cmd.toJSON()) }
        );
        console.log('Slash commands registered globally.');
    } catch (err) {
        console.error('Failed to register slash commands:', err.message);
    }
});

// ─── Login ────────────────────────────────────────────────────────────────────
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
