const { 
  Client, 
  GatewayIntentBits, 
  EmbedBuilder, 
  PermissionsBitField, 
  SlashCommandBuilder, 
  ChannelType,
  AuditLogEvent
} = require('discord.js');

const fs = require('fs');
const path = require('path');

// Replace this with your bot token
const BOT_TOKEN = process.env.TOKEN;
const dbPath = path.join(__dirname, 'log_channels.json');
let dbData = {
  logChannels: {},
  stats: { deleted: 0, edited: 0, purged: 0 }
};

if (fs.existsSync(dbPath)) {
  try {
    const rawData = fs.readFileSync(dbPath, 'utf8');
    const parsed = JSON.parse(rawData);
    // Backward compatibility check
    if (parsed.logChannels) {
      dbData = parsed;
    } else {
      dbData.logChannels = parsed; // Legacy format handling
    }
    console.log('Loaded database and stats from storage.');
  } catch (error) {
    console.error('Error reading log_channels.json:', error);
  }
}

const saveData = () => {
  try {
    fs.writeFileSync(dbPath, JSON.stringify(dbData, null, 2), 'utf8');
  } catch (error) {
    console.error('Error saving to log_channels.json:', error);
  }
};
// ------------------------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMembers,      // Needed for Join/Leave & Account Age
    GatewayIntentBits.GuildVoiceStates,  // Needed for VC tracking
  ],
});

// Slash Commands
const setLogCommand = new SlashCommandBuilder()
  .setName('setlog')
  .setDescription('Set the channel where server logs will be sent')
  .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
  .addChannelOption(option =>
    option.setName('channel')
      .setDescription('The text channel to send logs to')
      .setRequired(true)
      .addChannelTypes(ChannelType.GuildText) 
  );

const unsetLogCommand = new SlashCommandBuilder()
  .setName('unsetlog')
  .setDescription('Disable message logging for this server')
  .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator);

const logStatsCommand = new SlashCommandBuilder()
  .setName('logstats')
  .setDescription('Display bot uptime, latency, system stats, and log counts');

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}!`);
  
  try {
    await client.application.commands.set([setLogCommand, unsetLogCommand, logStatsCommand]);
    console.log('Slash commands registered successfully!');
  } catch (error) {
    console.error('Failed to register slash commands:', error);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'setlog') {
    const channel = interaction.options.getChannel('channel');
    dbData.logChannels[interaction.guildId] = channel.id;
    saveData();
    await interaction.reply({ content: `Log channel set to ${channel}`, ephemeral: true });
  }

  if (interaction.commandName === 'unsetlog') {
    if (dbData.logChannels[interaction.guildId]) {
      delete dbData.logChannels[interaction.guildId];
      saveData();
      await interaction.reply({ content: 'Logging disabled.', ephemeral: true });
    } else {
      await interaction.reply({ content: 'Logging is not configured.', ephemeral: true });
    }
  }

  if (interaction.commandName === 'logstats') {
    const uptime = Math.floor(process.uptime());
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = uptime % 60;
    const memoryUsage = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);

    const statsEmbed = new EmbedBuilder()
      .setTitle('Logging Bot Diagnostics & Stats')
      .setColor(0x5865F2)
      .addFields(
        { name: 'Latency', value: `${client.ws.ping}ms`, inline: true },
        { name: 'Uptime', value: `${hours}h ${minutes}m ${seconds}s`, inline: true },
        { name: 'RAM Usage', value: `${memoryUsage} MB`, inline: true },
        { name: 'Total Deleted Logged', value: `${dbData.stats.deleted || 0}`, inline: true },
        { name: 'Total Edited Logged', value: `${dbData.stats.edited || 0}`, inline: true },
        { name: 'Mass Purges Logged', value: `${dbData.stats.purged || 0}`, inline: true }
      )
      .setFooter({ text: `Serving ${client.guilds.cache.size} servers` })
      .setTimestamp();

    await interaction.reply({ embeds: [statsEmbed] });
  }
});

// Helpers
const getAttachmentsString = (attachments) => attachments.size === 0 ? null : attachments.map(a => a.url).join('\n');
const truncate = (text, maxLength = 1000) => !text ? '*[No text]*' : (text.length > maxLength ? text.substring(0, maxLength) + '...' : text);

const getEmbedImageUrl = (embeds) => {
  for (const e of embeds) {
    if (e.image?.url) return e.image.url;
    if (e.thumbnail?.url) return e.thumbnail.url;
    if (e.video?.url) return e.video.url;
  }
  return null;
};

const getWebLinks = (text) => {
  if (!text) return null;
  const links = text.match(/https?:\/\/(?:tenor\.com|klipy\.co|giphy\.com)[^\s]+|https?:\/\/[^\s]+\.(?:gif|png|jpg|jpeg|webp)/gi);
  if (!links) return null;

  return links.map(link => (link.includes('tenor.com/view') && !link.endsWith('.gif')) ? `${link}.gif` : link);
};

// Event: Message Delete
client.on('messageDelete', async (message) => {
  if (message.author?.bot || !message.guild) return;

  const savedChannelId = dbData.logChannels[message.guild.id];
  if (!savedChannelId) return; 

  const logChannel = message.guild.channels.cache.get(savedChannelId);
  if (!logChannel) return;

  dbData.stats.deleted = (dbData.stats.deleted || 0) + 1;
  saveData();

  let deletedBy = 'Self / Unknown';
  try {
    const fetchedLogs = await message.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.MessageDelete });
    const deletionLog = fetchedLogs.entries.first();
    if (deletionLog && deletionLog.target.id === message.author.id && deletionLog.createdTimestamp > Date.now() - 5000) {
      deletedBy = `${deletionLog.executor.username} (Moderator)`;
    }
  } catch (err) {}

  let replyInfo = null;
  if (message.reference?.messageId) {
    try {
      const repliedMsg = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
      replyInfo = repliedMsg ? `@${repliedMsg.author.username}: "${truncate(repliedMsg.content, 150)}" ([Jump](${repliedMsg.url}))` : `*Message ID: ${message.reference.messageId} (Unavailable)*`;
    } catch (err) {}
  }

  let previousMsgInfo = null;
  try {
    const previousMessages = await message.channel.messages.fetch({ limit: 1, before: message.id });
    const previousMsg = previousMessages.first();
    if (previousMsg) previousMsgInfo = `@${previousMsg.author.username}: "${truncate(previousMsg.content, 150)}" ([Jump](${previousMsg.url}))`;
  } catch (err) {}

  const attachmentsString = getAttachmentsString(message.attachments);
  
  const embed = new EmbedBuilder()
    .setTitle('Message Deleted')
    .setColor(0xFF0000)
    .setThumbnail(message.author.displayAvatarURL({ dynamic: true }))
    .addFields(
      { name: 'Author', value: `${message.author.globalName || message.author.username} (${message.author.tag})`, inline: true },
      { name: 'Channel', value: `<#${message.channel.id}>`, inline: true },
      { name: 'Deleted By', value: deletedBy, inline: true },
      { name: 'Text Content', value: truncate(message.content) }
    )
    .setFooter({ text: `User ID: ${message.author.id} | Msg ID: ${message.id}` })
    .setTimestamp();

  if (replyInfo) embed.addFields({ name: 'Replied To', value: replyInfo });
  if (previousMsgInfo) embed.addFields({ name: 'Message Before Deleted', value: previousMsgInfo });
  if (attachmentsString) embed.addFields({ name: 'Attachments', value: attachmentsString });

  let previewImageUrl = null;
  let fallbackLinks = null;
  
  const imageAttachment = message.attachments.find(a => a.contentType && a.contentType.startsWith('image/'));
  if (imageAttachment) previewImageUrl = imageAttachment.url;
  else if (message.embeds.length > 0) previewImageUrl = getEmbedImageUrl(message.embeds);

  const extractedLinks = getWebLinks(message.content);
  if (!previewImageUrl && extractedLinks && extractedLinks.length > 0) previewImageUrl = extractedLinks[0];

  if (previewImageUrl) embed.setImage(previewImageUrl);
  else if (extractedLinks) fallbackLinks = extractedLinks.join('\n');

  logChannel.send({ embeds: [embed], allowedMentions: { parse: [] } }).then(() => {
    if (fallbackLinks) logChannel.send({ content: `*Deleted Media Link:* \n${fallbackLinks}`, allowedMentions: { parse: [] } });
  }).catch(console.error);
});

// Event: Message Bulk Delete (Purges)
client.on('messageDeleteBulk', async (messages) => {
  const firstMsg = messages.first();
  if (!firstMsg || !firstMsg.guild) return;

  const savedChannelId = dbData.logChannels[firstMsg.guild.id];
  if (!savedChannelId) return;

  const logChannel = firstMsg.guild.channels.cache.get(savedChannelId);
  if (!logChannel) return;

  dbData.stats.purged = (dbData.stats.purged || 0) + 1;
  saveData();

  const embed = new EmbedBuilder()
    .setTitle('Mass Message Purge')
    .setColor(0x9B59B6)
    .addFields(
      { name: 'Channel', value: `<#${firstMsg.channel.id}>`, inline: true },
      { name: 'Messages Cleared', value: `${messages.size}`, inline: true }
    )
    .setFooter({ text: `Channel ID: ${firstMsg.channel.id}` })
    .setTimestamp();

  logChannel.send({ embeds: [embed] }).catch(console.error);
});

// Event: Message Update (Edited)
client.on('messageUpdate', async (oldMessage, newMessage) => {
  if (oldMessage.author?.bot || !oldMessage.guild) return;
  if (oldMessage.content === newMessage.content && oldMessage.attachments.size === newMessage.attachments.size) return;

  const savedChannelId = dbData.logChannels[oldMessage.guild.id];
  if (!savedChannelId) return; 

  const logChannel = oldMessage.guild.channels.cache.get(savedChannelId);
  if (!logChannel) return;

  dbData.stats.edited = (dbData.stats.edited || 0) + 1;
  saveData();

  const embed = new EmbedBuilder()
    .setTitle('Message Edited')
    .setColor(0xFFA500)
    .setThumbnail(oldMessage.author.displayAvatarURL({ dynamic: true }))
    .addFields(
      { name: 'Author', value: `${oldMessage.author.username} (${oldMessage.author.id})`, inline: true },
      { name: 'Channel', value: `<#${oldMessage.channel.id}>`, inline: true },
      { name: 'Jump to Message', value: `[Click Here](${newMessage.url})`, inline: true },
      { name: 'Before Text', value: truncate(oldMessage.content) },
      { name: 'After Text', value: truncate(newMessage.content) }
    )
    .setFooter({ text: `User ID: ${oldMessage.author.id} | Msg ID: ${newMessage.id}` })
    .setTimestamp();

  const oldAttachments = getAttachmentsString(oldMessage.attachments);
  const newAttachments = getAttachmentsString(newMessage.attachments);

  if (oldAttachments || newAttachments) {
    embed.addFields({ name: 'Attachments Changed', value: `**Before:**\n${oldAttachments || '*None*'}\n**After:**\n${newAttachments || '*None*'}` });
  }

  let previewImageUrl = null;
  let fallbackLinks = null;

  const newImageAttachment = newMessage.attachments.find(a => a.contentType && a.contentType.startsWith('image/'));
  if (newImageAttachment) previewImageUrl = newImageAttachment.url;
  else if (newMessage.embeds.length > 0) previewImageUrl = getEmbedImageUrl(newMessage.embeds);

  const extractedLinks = getWebLinks(newMessage.content);
  if (!previewImageUrl && extractedLinks && extractedLinks.length > 0) previewImageUrl = extractedLinks[0];

  if (previewImageUrl) embed.setImage(previewImageUrl);
  else if (extractedLinks) fallbackLinks = extractedLinks.join('\n');

  logChannel.send({ embeds: [embed], allowedMentions: { parse: [] } }).then(() => {
    if (fallbackLinks) logChannel.send({ content: `*Edited Media Link:* \n${fallbackLinks}`, allowedMentions: { parse: [] } });
  }).catch(console.error);
});

// Event: Voice State Update (VC Joins/Leaves/Moves)
client.on('voiceStateUpdate', async (oldState, newState) => {
  const guild = newState.guild;
  const savedChannelId = dbData.logChannels[guild.id];
  if (!savedChannelId) return;

  const logChannel = guild.channels.cache.get(savedChannelId);
  if (!logChannel) return;

  const member = newState.member;
  if (member.user.bot) return;

  let title = '';
  let color = 0x3498DB;
  let description = '';

  if (!oldState.channelId && newState.channelId) {
    title = 'Joined Voice Channel';
    color = 0x2ECC71;
    description = `${member} joined <#${newState.channelId}>`;
  } else if (oldState.channelId && !newState.channelId) {
    title = 'Left Voice Channel';
    color = 0xE74C3C;
    description = `${member} left <#${oldState.channelId}>`;
  } else if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
    title = 'Moved Voice Channels';
    color = 0xF1C40F;
    description = `${member} moved from <#${oldState.channelId}> to <#${newState.channelId}>`;
  } else {
    return; // Ignore mutes/deafens to prevent spam
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .setDescription(description)
    .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
    .setFooter({ text: `User ID: ${member.id}` })
    .setTimestamp();

  logChannel.send({ embeds: [embed] }).catch(console.error);
});

// Event: Member Join (Includes Account Age Warning)
client.on('guildMemberAdd', async (member) => {
  const savedChannelId = dbData.logChannels[member.guild.id];
  if (!savedChannelId) return;

  const logChannel = member.guild.channels.cache.get(savedChannelId);
  if (!logChannel) return;

  const accountAgeDays = Math.floor((Date.now() - member.user.createdTimestamp) / (1000 * 60 * 60 * 24));
  const isNewAccount = accountAgeDays < 7;

  const embed = new EmbedBuilder()
    .setTitle('Member Joined')
    .setColor(isNewAccount ? 0xE67E22 : 0x2ECC71)
    .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
    .addFields(
      { name: 'User', value: `${member.user.username} (${member})`, inline: true },
      { name: 'Account Created', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
      { name: 'Account Age Warning', value: isNewAccount ? `**NEW ACCOUNT!** (${accountAgeDays} days old)` : 'Normal Account', inline: false }
    )
    .setFooter({ text: `User ID: ${member.id}` })
    .setTimestamp();

  logChannel.send({ embeds: [embed] }).catch(console.error);
});

// Event: Member Leave
client.on('guildMemberRemove', async (member) => {
  const savedChannelId = dbData.logChannels[member.guild.id];
  if (!savedChannelId) return;

  const logChannel = member.guild.channels.cache.get(savedChannelId);
  if (!logChannel) return;

  const embed = new EmbedBuilder()
    .setTitle('Member Left')
    .setColor(0xE74C3C)
    .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
    .addFields(
      { name: 'User', value: `${member.user.username} (${member.id})`, inline: true }
    )
    .setFooter({ text: `User ID: ${member.id}` })
    .setTimestamp();

  logChannel.send({ embeds: [embed] }).catch(console.error);
});

// Crash Guard
process.on('unhandledRejection', error => {
  console.error('Unhandled Promise Rejection:', error);
});

client.login(BOT_TOKEN);