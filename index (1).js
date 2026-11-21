require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Events,
  ChannelType,
  PermissionFlagsBits,
  OverwriteType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  SlashCommandBuilder,
  InteractionContextType,
  MessageFlags,
} = require('discord.js');

// Kiểm tra biến môi trường bắt buộc, thiếu thì báo rõ rồi dừng
const missing = ['TOKEN', 'JOIN_CHANNEL_ID'].filter((k) => !process.env[k]?.trim());
if (missing.length) {
  console.error(`❌ Thiếu biến môi trường: ${missing.join(', ')}`);
  process.exit(1);
}

const { TOKEN, JOIN_CHANNEL_ID, GUILD_ID } = process.env;
const COLOR = 0x2b2d31; // nhìn như "trong suốt" ở dark mode
const P = PermissionFlagsBits;
const CREATE_COOLDOWN_MS = 5000;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const commands = [
  new SlashCommandBuilder()
    .setName('voice')
    .setDescription('Quản lý phòng voice tạm')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) => s.setName('panel').setDescription('Gửi lại bảng điều khiển phòng của bạn')),
].map((c) => c.toJSON());

// ---------- Ownership (không cần database) ----------
// Chủ phòng = thành viên có overwrite "Manage Channels" riêng trong phòng đó.
// Nhờ vậy bot restart (Render) vẫn biết ai là chủ.
function getOwnerId(ch) {
  return ch.permissionOverwrites.cache.find(
    (o) => o.type === OverwriteType.Member && o.allow.has(P.ManageChannels),
  )?.id;
}

function isTemp(ch) {
  const trigger = client.channels.cache.get(JOIN_CHANNEL_ID);
  return (
    ch?.type === ChannelType.GuildVoice &&
    ch.id !== JOIN_CHANNEL_ID &&
    !!trigger &&
    ch.parentId === trigger.parentId &&
    !!getOwnerId(ch)
  );
}

async function setOwner(ch, newOwnerId, oldOwnerId) {
  if (oldOwnerId && oldOwnerId !== newOwnerId) {
    await ch.permissionOverwrites.edit(oldOwnerId, { ManageChannels: null }).catch(() => {});
  }
  await ch.permissionOverwrites.edit(newOwnerId, {
    ViewChannel: true,
    Connect: true,
    ManageChannels: true,
  });
}

// ---------- Panel ----------
function panelPayload() {
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('Điều khiển phòng voice')
    .setDescription(
      'Chỉ **chủ phòng** dùng được các nút bên dưới.\n' +
        'Phòng sẽ tự xoá khi không còn ai trong đó.',
    );

  const btn = (id, label, emoji, style = ButtonStyle.Secondary) =>
    new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style);
  const select = (id, placeholder) =>
    new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder).setMinValues(1).setMaxValues(1),
    );

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        btn('vc_lock', 'Khoá / Mở', '🔒'),
        btn('vc_hide', 'Ẩn / Hiện', '👁️'),
        btn('vc_rename', 'Đổi tên', '✏️'),
        btn('vc_limit', 'Giới hạn', '👥'),
      ),
      new ActionRowBuilder().addComponents(
        btn('vc_claim', 'Nhận phòng', '👑'),
        btn('vc_delete', 'Xoá phòng', '🗑️', ButtonStyle.Danger),
      ),
      select('vc_permit', 'Cho phép thành viên vào phòng'),
      select('vc_kick', 'Kick và chặn thành viên'),
      select('vc_transfer', 'Chuyển quyền chủ phòng'),
    ],
  };
}

const inputModal = (id, title, label, placeholder, max) =>
  new ModalBuilder()
    .setCustomId(id)
    .setTitle(title)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('value')
          .setLabel(label)
          .setStyle(TextInputStyle.Short)
          .setPlaceholder(placeholder)
          .setMaxLength(max)
          .setRequired(true),
      ),
    );

// ---------- Tạo phòng ----------
const cooldown = new Map();

async function createRoom(member, trigger) {
  if (Date.now() - (cooldown.get(member.id) ?? 0) < CREATE_COOLDOWN_MS) return;
  cooldown.set(member.id, Date.now());

  const room = await member.guild.channels.create({
    name: `Phòng của ${member.displayName}`.slice(0, 100),
    type: ChannelType.GuildVoice,
    parent: trigger.parentId, // cùng category với kênh "Join to Create"
  });
  await setOwner(room, member.id);

  const moved = await member.voice.setChannel(room).then(() => true).catch(() => false);
  if (!moved) return room.delete().catch(() => {}); // người dùng đã thoát kịp

  await room.send(panelPayload()).catch((e) => console.error('Không gửi được panel:', e.message));
}

// ---------- Voice events ----------
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  try {
    if (newState.channelId === JOIN_CHANNEL_ID && newState.member && !newState.member.user.bot) {
      await createRoom(newState.member, newState.channel);
    }

    const old = oldState.channel;
    if (!old || old.id === newState.channelId || !isTemp(old)) return;

    if (old.members.size === 0) {
      await old.delete().catch(() => {});
    } else if (oldState.id === getOwnerId(old)) {
      // Chủ phòng rời đi mà còn người khác -> tự chuyển quyền
      const next = old.members.find((m) => !m.user.bot);
      if (next) await setOwner(old, next.id, oldState.id);
    }
  } catch (err) {
    console.error(err);
  }
});

// ---------- Điều khiển phòng ----------
async function control(i) {
  const say = (content) => i.reply({ content, flags: MessageFlags.Ephemeral });
  const ch = i.guild.channels.cache.get(i.channelId);

  if (!isTemp(ch)) return say('❌ Chỉ dùng được trong phòng voice tạm.');
  const ownerId = getOwnerId(ch);
  const id = i.customId;

  // Nhận phòng: chỉ khi chủ cũ không còn trong phòng
  if (id === 'vc_claim') {
    if (!ch.members.has(i.user.id)) return say('❌ Bạn phải đang ở trong phòng này.');
    if (ch.members.has(ownerId)) return say('❌ Chủ phòng vẫn đang ở trong phòng.');
    await setOwner(ch, i.user.id, ownerId);
    return say('👑 Bạn là chủ phòng mới.');
  }

  if (i.user.id !== ownerId) return say('❌ Chỉ chủ phòng mới dùng được.');

  switch (id) {
    case 'vc_lock': {
      const everyone = i.guild.roles.everyone.id;
      const locked = ch.permissionOverwrites.cache.get(everyone)?.deny.has(P.Connect);
      await ch.permissionOverwrites.edit(everyone, { Connect: locked ? null : false });
      return say(locked ? '🔓 Đã mở phòng.' : '🔒 Đã khoá phòng. Chỉ người được cho phép mới vào được.');
    }
    case 'vc_hide': {
      const everyone = i.guild.roles.everyone.id;
      const hidden = ch.permissionOverwrites.cache.get(everyone)?.deny.has(P.ViewChannel);
      await ch.permissionOverwrites.edit(everyone, { ViewChannel: hidden ? null : false });
      return say(hidden ? '👁️ Phòng đã hiện lại.' : '🙈 Đã ẩn phòng khỏi danh sách.');
    }
    case 'vc_rename':
      return i.showModal(inputModal('vc_rename_modal', 'Đổi tên phòng', 'Tên mới (có thể thêm emoji)', 'Phòng chill', 100));
    case 'vc_limit':
      return i.showModal(inputModal('vc_limit_modal', 'Giới hạn người', 'Số người (0 = không giới hạn)', '0 - 99', 2));
    case 'vc_delete':
      await say('🗑️ Đang xoá phòng...');
      return ch.delete().catch(() => {});

    case 'vc_permit': {
      const target = i.values[0];
      await ch.permissionOverwrites.edit(target, { ViewChannel: true, Connect: true });
      return say(`✅ Đã cho phép <@${target}> vào phòng.`);
    }
    case 'vc_kick': {
      const target = i.values[0];
      if (target === ownerId) return say('❌ Bạn không thể kick chính mình.');
      await ch.permissionOverwrites.edit(target, { Connect: false });
      await ch.members.get(target)?.voice.disconnect().catch(() => {});
      return say(`🚫 Đã kick và chặn <@${target}> vào lại phòng này.`);
    }
    case 'vc_transfer': {
      const target = i.values[0];
      if (target === ownerId) return say('❌ Bạn đang là chủ phòng rồi.');
      if (i.users.get(target)?.bot) return say('❌ Không thể chuyển quyền cho bot.');
      await setOwner(ch, target, ownerId);
      return say(`👑 Đã chuyển quyền chủ phòng cho <@${target}>.`);
    }
  }
}

async function modalSubmit(i) {
  const say = (content) => i.reply({ content, flags: MessageFlags.Ephemeral });
  const ch = i.guild.channels.cache.get(i.channelId);
  if (!isTemp(ch) || i.user.id !== getOwnerId(ch)) return say('❌ Chỉ chủ phòng mới dùng được.');

  const value = i.fields.getTextInputValue('value').trim();

  if (i.customId === 'vc_rename_modal') {
    try {
      await ch.setName(value.slice(0, 100));
      return say('✏️ Đã đổi tên phòng.');
    } catch {
      return say('❌ Không đổi được tên. Discord chỉ cho đổi tên kênh 2 lần mỗi 10 phút, thử lại sau nhé.');
    }
  }

  if (i.customId === 'vc_limit_modal') {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 99) return say('❌ Hãy nhập một số từ 0 đến 99.');
    await ch.setUserLimit(n);
    return say(n === 0 ? '👥 Đã bỏ giới hạn số người.' : `👥 Đã giới hạn tối đa ${n} người.`);
  }
}

async function slashPanel(i) {
  const vc = i.member.voice.channel;
  if (!isTemp(vc)) {
    return i.reply({ content: '❌ Bạn phải đang ở trong một phòng voice tạm.', flags: MessageFlags.Ephemeral });
  }
  if (getOwnerId(vc) !== i.user.id) {
    return i.reply({ content: '❌ Chỉ chủ phòng mới gửi được bảng điều khiển.', flags: MessageFlags.Ephemeral });
  }
  await vc.send(panelPayload());
  return i.reply({ content: '✅ Đã gửi bảng điều khiển vào phòng của bạn.', flags: MessageFlags.Ephemeral });
}

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isChatInputCommand()) {
      if (i.commandName === 'voice') return await slashPanel(i);
      return;
    }
    if (i.isModalSubmit() && i.customId.startsWith('vc_')) return await modalSubmit(i);
    if ((i.isButton() || i.isUserSelectMenu()) && i.customId.startsWith('vc_')) return await control(i);
  } catch (err) {
    console.error(err);
    const payload = { content: '❌ Có lỗi xảy ra, thử lại sau nhé.', flags: MessageFlags.Ephemeral };
    if (i.replied || i.deferred) await i.followUp(payload).catch(() => {});
    else await i.reply(payload).catch(() => {});
  }
});

// ---------- Ready ----------
client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Đăng nhập: ${c.user.tag}`);

  const trigger = c.channels.cache.get(JOIN_CHANNEL_ID);
  if (!trigger) {
    console.error('❌ Không tìm thấy kênh JOIN_CHANNEL_ID. Kiểm tra lại ID và bot đã vào đúng server chưa.');
  } else {
    // Dọn các phòng trống còn sót lại sau khi bot restart
    for (const ch of trigger.guild.channels.cache.values()) {
      if (isTemp(ch) && ch.members.size === 0) await ch.delete().catch(() => {});
    }
  }

  if (GUILD_ID) {
    const guild = await c.guilds.fetch(GUILD_ID).catch(() => null);
    if (guild) await guild.commands.set(commands);
    else console.error('❌ GUILD_ID sai hoặc bot chưa ở trong server đó.');
  } else {
    await c.application.commands.set(commands);
  }
  console.log('📌 Đã đăng ký lệnh');
});

// Server HTTP nhỏ cho Render (cần cổng mở) và để UptimeRobot ping giữ bot thức
require('http')
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is alive');
  })
  .listen(process.env.PORT || 3000, () => console.log('🌐 HTTP server đang chạy'));

client.login(TOKEN);
