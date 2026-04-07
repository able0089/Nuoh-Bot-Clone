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
import { getGuild, saveGuild, getWarnings, addWarning } from './storage.js';

console.log('Bot starting...');
keepAlive();

// ─── Constants ────────────────────────────────────────────────────────────────
const PREFIX = 'nu!';
const OWNER_ID = '1396815034247806999';
const TARGET_USER_ID = '716390085896962058'; // Pokétwo bot

// Per-guild: track whether auto-locking is paused
const botOfflineGuilds = new Set();

// Per-channel active lock data: channelId → { hunters, type, logMsg }
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
    const map = { shiny: 'Shiny Hunt', rare: 'Rare Spawn', regional: 'Regional Spawn', collection: 'Collection Ping' };
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
    // If nothing configured, monitor everywhere (backwards compatible)
    if (guildData.moderatedChannels.length === 0 && guildData.moderatedCategories.length === 0) {
        return true;
    }
    if (guildData.moderatedChannels.includes(channel.id)) return true;
    if (channel.parentId && guildData.moderatedCategories.includes(channel.parentId)) return true;
    return false;
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
        : 'All channels (none configured)';

    const categoryStr = guildData.moderatedCategories.length > 0
        ? guildData.moderatedCategories.map(id => `\`${id}\``).join(', ')
        : 'None';

    const logStr = guildData.logChannelId ? `<#${guildData.logChannelId}>` : 'Not set';

    return new EmbedBuilder()
        .setTitle(`⚙️ Settings — ${guild.name}`)
        .addFields(
            { name: 'Mod Roles', value: modRoleStr },
            { name: 'Monitored Channels', value: channelStr },
            { name: 'Monitored Categories', value: categoryStr },
            { name: 'Log Channel', value: logStr },
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

        // Skip if already locked
        const current = channel.permissionOverwrites.cache.get(TARGET_USER_ID);
        if (current && current.deny.has(PermissionsBitField.Flags.SendMessages)) return;

        await channel.permissionOverwrites.edit(TARGET_USER_ID, { SendMessages: false });

        const hunterMentions = hunters.map(id => `<@${id}>`).join(' ');
        const isHunterType = type === 'shiny' || type === 'collection';

        let title, description;
        if (type === 'shiny') {
            title = '✨ Shiny Hunt Detected';
            description = hunters.length > 0
                ? `Only pinged hunters can unlock\n${hunterMentions}`
                : 'Only admins/mods can unlock';
        } else if (type === 'collection') {
            title = '📦 Collection Ping Detected';
            description = hunters.length > 0
                ? `Only pinged collectors can unlock\n${hunterMentions}`
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

        // Use channel.id as key — no customId length issues
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`unlock_${channel.id}`)
                .setLabel('Unlock')
                .setEmoji('🔓')
                .setStyle(ButtonStyle.Primary),
        );

        const lockMessage = await channel.send({ embeds: [embed], components: [row] });

        // Log the lock
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

        // Store lock data
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

        // Reminder at 11 hours for hunter-type locks
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

    // /setmod
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

    // /moderate
    if (interaction.commandName === 'moderate') {
        const ch = interaction.options.getChannel('channel');
        const catId = interaction.options.getString('category');

        if (!ch && !catId) {
            return interaction.reply({ content: 'Provide a channel or a category ID.', ephemeral: true });
        }

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

    // /timeout
    if (interaction.commandName === 'timeout') {
        const target = interaction.options.getMember('member');
        const timeStr = interaction.options.getString('time') || '10m';
        const reason = interaction.options.getString('reason') || 'No reason provided';

        if (!target) return interaction.reply({ content: 'Member not found in this server.', ephemeral: true });

        const ms = parseTime(timeStr);
        if (!ms) return interaction.reply({ content: 'Invalid time. Use formats like: 10m, 1h, 1d', ephemeral: true });

        return applyTimeout(target, ms, reason, interaction.user.id, { interaction });
    }

    // /warn
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

    // /settings
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
                { name: '**⚙️ Config**', value: '\u200b' },
                { name: `\`${PREFIX}setlog #channel\``, value: 'Set the log channel (Admin/Owner only).' },
                { name: `\`${PREFIX}settings\``, value: 'View current bot settings for this server.' },
                { name: `\`${PREFIX}remind <time> <reason>\``, value: 'Set a reminder. Supports: 10s, 5m, 1h, 1d.' },
                { name: '**Slash Commands**', value: '`/setmod` `/moderate` `/timeout` `/warn` `/settings`' },
            )
            .setColor(0x00FFFF)
            .setFooter({ text: `Prefix: ${PREFIX} — or mention me!` });

        return message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
    }

    // ── settings ──
    if (command === 'settings') {
        return message.reply({ embeds: [buildSettingsEmbed(guildData, message.guild)], allowedMentions: { repliedUser: false } });
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

        // Resolve target from mention or raw ID
        let target = message.mentions.members.first();
        let argOffset = 2; // args after target + command
        if (!target) {
            if (args[1] && /^\d+$/.test(args[1])) {
                target = await message.guild.members.fetch(args[1]).catch(() => null);
            }
        }
        if (!target) return message.reply({ content: `Usage: \`${PREFIX}timeout @user [time] [reason]\``, allowedMentions: { repliedUser: false } });

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
        if (!target) return message.reply({ content: `Usage: \`${PREFIX}warn @user [reason]\` or \`${PREFIX}warn userID [reason]\``, allowedMentions: { repliedUser: false } });

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

    // Auto-lock detection from other bots
    if (botOfflineGuilds.has(message.guild.id)) return;
    if (!message.author.bot) return;

    const guildData = getGuild(message.guild.id);
    if (!isChannelMonitored(message.channel, guildData)) return;

    // Collect ALL mentioned user IDs
    const hunters = [...message.mentions.users.values()].map(u => u.id);
    const content = message.content;

    if (content.includes('Shiny hunt pings:') || content.includes('Shiny Hunt pings:')) {
        await lockChannel(message.channel, 'shiny', hunters);
    } else if (content.includes('Collection pings:') || content.includes('Collection Pings:')) {
        await lockChannel(message.channel, 'collection', hunters);
    } else if (content.includes('Rare ping:') || content.includes('Rare Ping:')) {
        await lockChannel(message.channel, 'rare', []);
    } else if (content.includes('Regional ping:') || content.includes('Regional Ping:')) {
        await lockChannel(message.channel, 'regional', []);
    }
});

client.on('interactionCreate', async (interaction) => {
    // Slash commands
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
            canUnlock = true; // anyone can unlock rare/regional
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
            await interaction.reply({ content: 'Failed to unlock the spawn.', ephemeral: true });
        }
        return;
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
