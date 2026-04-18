require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder, Events, GatewayIntentBits, ModalBuilder, REST, Routes, SlashCommandBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const express = require('express');
const config = require('./config.json');

const webPort = Number(process.env.PORT) || Number(config.webPort) || 3000;
const app = express();
app.get('/', (req, res) => res.type('text/plain').send('Bot is alive!'));
app.listen(webPort, () => { // eslint-disable-next-line no-console
  console.log(`Web server running on port ${webPort}`);
});

function coinsEmoji() {
  const id = config.emojiCoinsId;
  return id ? `<:${'Coins'.toLowerCase()}${id}>` : '';
}

function halfstarEmoji() {
  const id = config.emojiHalfstarId;
  return id ? `<:${'Halfstar'.toLowerCase()}${id}>` : '';
}

const ITEMSPERPAGE = 10;
const GRAPHWIDTH = 1000;
const GRAPHHEIGHT = 420;
const chartCanvas = new ChartJSNodeCanvas({ width: GRAPHWIDTH, height: GRAPHHEIGHT, backgroundColour: '#0f1118' });

function ensureDatabaseFile() {
  const resolvedPath = path.resolve(config.databasePath);
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(resolvedPath)) fs.writeFileSync(resolvedPath, JSON.stringify({ items: [] }, null, 2), 'utf8');
}

function readDb() {
  ensureDatabaseFile();
  const raw = fs.readFileSync(path.resolve(config.databasePath), 'utf8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed.items) ? parsed.items : [];
}

function writeDb(db) {
  fs.writeFileSync(path.resolve(config.databasePath), JSON.stringify({ items: db }, null, 2), 'utf8');
}

function makeId() {
  return `item${Date.now()}${Math.floor(Math.random() * 100000)}`;
}

function findItemByName(name) {
  if (!name) return null;
  const db = readDb();
  const lower = name.toLowerCase().trim();
  return db.find(item => item.name.toLowerCase() === lower) || null;
}

function formatDate(dateValue) {
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return date.toLocaleDateString('en-GB');
}

function formatNumber(num) {
  return Number(num).toLocaleString('en-US');
}

function parsePositiveNumber(input) {
  const cleaned = String(input).replace(/,/g, '.').trim();
  const num = Number(cleaned);
  if (!Number.isFinite(num) || num < 0) return null;
  return num;
}

function ensureHistory(item) {
  if (!Array.isArray(item.valueHistory)) {
    const baseValue = Number(item.value ?? 0);
    item.valueHistory = [{ value: baseValue, timestamp: new Date().toISOString() }];
  }
}

function getLatestValue(item) {
  ensureHistory(item);
  const latest = item.valueHistory[item.valueHistory.length - 1];
  return Number(latest?.value) || 0;
}

function getCreatedAtMs(item) {
  if (item.createdAt) {
    const created = new Date(item.createdAt).getTime();
    if (Number.isFinite(created)) return created;
  }
  ensureHistory(item);
  const fallback = new Date(item.valueHistory[0]?.timestamp).getTime();
  if (Number.isFinite(fallback)) return fallback;
  return 0;
}

function sortItems(items, pricingSort, itemSort) {
  const sorted = [...items];
  if (pricingSort === 'h') {
    sorted.sort((a, b) => getLatestValue(b) - getLatestValue(a));
  } else if (pricingSort === 'l') {
    sorted.sort((a, b) => getLatestValue(a) - getLatestValue(b));
  }
  if (itemSort === 'az') {
    sorted.sort((a, b) => a.name.localeCompare(b.name));
  } else if (itemSort === 'za') {
    sorted.sort((a, b) => b.name.localeCompare(a.name));
  } else if (itemSort === 'new') {
    sorted.sort((a, b) => getCreatedAtMs(b) - getCreatedAtMs(a));
  } else if (itemSort === 'old') {
    sorted.sort((a, b) => getCreatedAtMs(a) - getCreatedAtMs(b));
  }
  return sorted;
}

function pricingLabel(mode) {
  if (mode === 'h') return 'High to Low';
  if (mode === 'l') return 'Low to High';
  return 'None';
}

function itemLabel(mode) {
  if (mode === 'az') return 'A-Z';
  if (mode === 'za') return 'Z-A';
  if (mode === 'new') return 'Newest';
  if (mode === 'old') return 'Oldest';
  return 'None';
}

function renderStarsFromNumber(rawValue) {
  const fullStar = '⭐';
  const halfStar = halfstarEmoji() || '⭐';
  const emptyStar = '☆';
  const total = 5;
  const value = Math.max(0, Math.min(5, Number(rawValue)));
  const fullCount = Math.floor(value);
  const hasHalf = value - fullCount >= 0.5;
  const emptyCount = total - fullCount - (hasHalf ? 1 : 0);
  return fullStar.repeat(fullCount) + (hasHalf ? halfStar : '') + emptyStar.repeat(emptyCount);
}

function renderDemand(rawDemand) {
  const numeric = Number(rawDemand);
  if (Number.isFinite(numeric)) return renderStarsFromNumber(numeric);
  return String(rawDemand) || 'N/A';
}

function renderRarity(rawRarity) {
  const numeric = Number(rawRarity);
  if (Number.isFinite(numeric)) return renderStarsFromNumber(numeric);
  return String(rawRarity) || 'N/A';
}

async function buildValueGraphAttachment(item) {
  ensureHistory(item);
  const points = [...item.valueHistory]
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
    .slice(-30); // Increased to 30 for better graph
  const labels = points.map(point => formatDate(point.timestamp));
  const values = points.map(point => Number(point.value) || 0);
  const { min: yMin, max: yMax } = computeTightYRange(values);
  const image = await chartCanvas.renderToBuffer({
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Value',
        data: values,
        borderWidth: 2,
        borderColor: '#b8df79',
        backgroundColor: 'rgba(184, 223, 121, 0.22)',
        fill: true,
        tension: 0.35,
        pointRadius: 5,
        pointHoverRadius: 6,
        pointBackgroundColor: '#b8df79',
        pointBorderColor: '#0f1118',
        pointBorderWidth: 2,
      }],
    },
    options: {
      responsive: false,
      plugins: { legend: { display: false } },
      scales: {
        y: {
          min: yMin,
          max: yMax,
          beginAtZero: false,
          ticks: {
            color: '#b8df79',
            maxTicksLimit: 6,
            callback: (val) => Number(val).toLocaleString('en-US'),
          },
          grid: { color: 'rgba(255,255,255,0.08)' },
        },
        x: {
          ticks: { color: '#d6d8df' },
          grid: { color: 'rgba(255,255,255,0.04)' },
        },
      },
    },
  });
  return new AttachmentBuilder(image, { name: 'value-graph.png' });
}

function buildValueEmbed(item, attachment) {
  ensureHistory(item);
  const latest = item.valueHistory[item.valueHistory.length - 1];
  return new EmbedBuilder()
    .setColor(config.embedColor || 0x25adff)
    .setAuthor({ name: 'FaF Values' })
    .setTitle(item.name)
    .setThumbnail(item.image || null)
    .addFields(
      { name: 'Obtainable', value: item.obtainable || 'N/A', inline: false },
      { name: 'Value', value: `${coinsEmoji()}${formatNumber(latest.value)}`, inline: true },
      { name: 'Demand', value: renderDemand(item.demand), inline: true },
      { name: 'Rarity', value: renderRarity(item.rarity), inline: true }
    )
    .setImage('attachment://value-graph.png')
    .setFooter({ text: `FaF Real Value | Latest value update: ${formatDate(latest.timestamp)}` })
    .setTimestamp();
}

function computeTightYRange(values) {
  const nums = values.map(v => Number(v) || 0);
  let minVal = Math.min(...nums);
  let maxVal = Math.max(...nums);
  if (!Number.isFinite(minVal)) minVal = 0;
  if (!Number.isFinite(maxVal)) maxVal = 0;
  if (minVal === maxVal) {
    const pad = Math.max(Math.abs(maxVal) * 0.06, 1);
    return { min: Math.max(0, minVal - pad), max: maxVal + pad };
  }
  const span = maxVal - minVal;
  const padding = Math.max(span * 0.1, span * 0.02, 1);
  return {
    min: Math.max(0, minVal - padding * 0.35),
    max: maxVal + padding * 0.65,
  };
}

function buildItemListEmbed(page, pricingSort = 'n', itemSort = 'n') {
  const db = readDb();
  const orderedItems = sortItems(db, pricingSort, itemSort);
  const totalItems = orderedItems.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / ITEMSPERPAGE));
  const safePage = Math.max(1, Math.min(page, totalPages));
  const start = (safePage - 1) * ITEMSPERPAGE;
  const selected = orderedItems.slice(start, start + ITEMSPERPAGE);
  const lines = selected.map((item, index) => `${start + index + 1}. ${item.name} - ${formatNumber(getLatestValue(item))}`);
  const embed = new EmbedBuilder()
    .setColor(config.embedColor || 0x25adff)
    .setTitle('FaF Item List')
    .setDescription(lines.length ? lines.join('\n') : 'No items in database yet.')
    .addFields(
      { name: 'Pricing Filter', value: pricingLabel(pricingSort), inline: true },
      { name: 'Item Filter', value: itemLabel(itemSort), inline: true }
    )
    .setFooter({ text: `FaF Real Value | Page ${safePage}/${totalPages}` })
    .setTimestamp();

  const navRow = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`itemlistnavprev${safePage}${pricingSort}${itemSort}`)
        .setLabel('Previous')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage === 1),
      new ButtonBuilder()
        .setCustomId(`itemlistnavnext${safePage}${pricingSort}${itemSort}`)
        .setLabel('Next')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(safePage === totalPages),
      new ButtonBuilder()
        .setCustomId(`itemlistclearall${safePage}${pricingSort}${itemSort}`)
        .setLabel('Clear Filter')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(pricingSort === 'n' && itemSort === 'n')
    );

  const pricingRow = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`itemlistpricingh${safePage}${pricingSort}${itemSort}`)
        .setLabel('Price High to Low')
        .setStyle(pricingSort === 'h' ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(pricingSort === 'h'),
      new ButtonBuilder()
        .setCustomId(`itemlistpricingl${safePage}${pricingSort}${itemSort}`)
        .setLabel('Price Low to High')
        .setStyle(pricingSort === 'l' ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(pricingSort === 'l')
    );

  const itemsRow = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`itemlistitemsaz${safePage}${pricingSort}${itemSort}`)
        .setLabel('A to Z')
        .setStyle(itemSort === 'az' ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(itemSort === 'az'),
      new ButtonBuilder()
        .setCustomId(`itemlistitemsza${safePage}${pricingSort}${itemSort}`)
        .setLabel('Z to A')
        .setStyle(itemSort === 'za' ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(itemSort === 'za'),
      new ButtonBuilder()
        .setCustomId(`itemlistitemsnew${safePage}${pricingSort}${itemSort}`)
        .setLabel('Newest')
        .setStyle(itemSort === 'new' ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(itemSort === 'new'),
      new ButtonBuilder()
        .setCustomId(`itemlistitemsold${safePage}${pricingSort}${itemSort}`)
        .setLabel('Oldest')
        .setStyle(itemSort === 'old' ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(itemSort === 'old')
    );

  return [embed, [navRow, pricingRow, itemsRow], safePage, totalPages];
}

function userIsAdmin(member) {
  return member.roles?.cache?.has(config.adminRoleId);
}

const slashCommands = [
  new SlashCommandBuilder()
    .setName('additem')
    .setDescription('Add a new FaF item')
    .addAttachmentOption(opt =>
      opt.setName('image')
        .setDescription('Upload item image')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('edititem')
    .setDescription('Edit an existing item')
    .addStringOption(opt =>
      opt.setName('olditemname')
        .setDescription('Existing item name')
        .setRequired(true)
    )
    .addAttachmentOption(opt =>
      opt.setName('image')
        .setDescription('New image upload (optional)')
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('deleteitem')
    .setDescription('Delete an item from database')
    .addStringOption(opt =>
      opt.setName('itemname')
        .setDescription('Item name to delete')
        .setRequired(true)
    ),
].map(command => command.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(config.clientId, config.guildId),
    { body: slashCommands }
  );
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, async (readyClient) => {
  try {
    await registerCommands();
    // eslint-disable-next-line no-console
    console.log(`Ready as ${readyClient.user.tag}`);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to register slash commands:', error);
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.content.startsWith(config.prefix || '!')) return;
  const [command, ...rest] = message.content.slice((config.prefix || '!').length).trim().split(' ');
  const cmd = command?.toLowerCase();
  if (cmd === 'value') {
    const query = rest.join(' ').trim();
    if (!query) return await message.reply('Use !value <item name>');
    const item = findItemByName(query);
    if (!item) return await message.reply(`Item not found: ${query}`);
    try {
      const graph = await buildValueGraphAttachment(item);
      const embed = buildValueEmbed(item, graph);
      await message.reply({ embeds: [embed], files: [graph] });
    } catch (error) {
      await message.reply('Could not build value graph for this item.');
    }
  }
  if (cmd === 'itemlist') {
    const [embed, rows] = buildItemListEmbed(1, 'n', 'n');
    await message.reply({ embeds: [embed], components: rows });
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) {
    if (!userIsAdmin(interaction.member)) {
      return await interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
    }
    if (interaction.commandName === 'additem') {
      const attachment = interaction.options.getAttachment('image', true);
      const isImage = Boolean(attachment.contentType?.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(attachment.name));
      if (!isImage) {
        return await interaction.reply({ content: 'Please upload an image file (PNG, JPG, GIF, or WebP).', ephemeral: true });
      }
      const modal = new ModalBuilder()
        .setCustomId('addItemModal')
        .setTitle('Add Item');
      const name = new TextInputBuilder()
        .setCustomId('name')
        .setLabel('Name')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      const obtainable = new TextInputBuilder()
        .setCustomId('obtainable')
        .setLabel('Obtainable')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      const value = new TextInputBuilder()
        .setCustomId('value')
        .setLabel('Value')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      const demand = new TextInputBuilder()
        .setCustomId('demand')
        .setLabel('Demand (0-5 or text)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      const rarity = new TextInputBuilder()
        .setCustomId('rarity')
        .setLabel('Rarity (0-5 or text)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      modal.addComponents(
        new ActionRowBuilder().addComponents(name),
        new ActionRowBuilder().addComponents(obtainable),
        new ActionRowBuilder().addComponents(value),
        new ActionRowBuilder().addComponents(demand),
        new ActionRowBuilder().addComponents(rarity)
      );
      await interaction.showModal(modal);
      client.pendingAddImageByUser ??= new Map();
      client.pendingAddImageByUser.set(interaction.user.id, attachment.url);
      return;
    }
    if (interaction.commandName === 'deleteitem') {
      const itemName = interaction.options.getString('itemname', true);
      const db = readDb();
      const item = db.find(entry => entry.name.toLowerCase() === itemName.toLowerCase());
      if (!item) {
        return await interaction.reply({ content: `Item not found: ${itemName}`, ephemeral: true });
      }
      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(`deleteconfirm${item.id}`)
            .setLabel('Yes')
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId(`deletecancel${item.id}`)
            .setLabel('No')
            .setStyle(ButtonStyle.Secondary)
        );
      await interaction.reply({ content: `Are you sure you want to delete **${item.name}**?`, components: [row], ephemeral: true });
      return;
    }
    if (interaction.commandName === 'edititem') {
      const oldItemName = interaction.options.getString('olditemname', true);
      const newImageAttachment = interaction.options.getAttachment('image');
      const db = readDb();
      const item = db.find(entry => entry.name.toLowerCase() === oldItemName.toLowerCase());
      if (!item) {
        return await interaction.reply({ content: `Item not found: ${oldItemName}`, ephemeral: true });
      }
      ensureHistory(item);
      const latest = item.valueHistory[item.valueHistory.length - 1];
      const modal = new ModalBuilder()
        .setCustomId(`editItemModal${item.id}`)
        .setTitle('Edit Item');
      const name = new TextInputBuilder()
        .setCustomId('name')
        .setLabel('Name')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(item.name.slice(0, 100));
      const obtainable = new TextInputBuilder()
        .setCustomId('obtainable')
        .setLabel('Obtainable')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(item.obtainable?.slice(0, 100) || '');
      const valueIn = new TextInputBuilder()
        .setCustomId('value')
        .setLabel('Value')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(String(latest.value));
      const demand = new TextInputBuilder()
        .setCustomId('demand')
        .setLabel('Demand (0-5 or text)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(String(item.demand ?? ''));
      const rarity = new TextInputBuilder()
        .setCustomId('rarity')
        .setLabel('Rarity (0-5 or text)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(String(item.rarity ?? ''));
      modal.addComponents(
        new ActionRowBuilder().addComponents(name),
        new ActionRowBuilder().addComponents(obtainable),
        new ActionRowBuilder().addComponents(valueIn),
        new ActionRowBuilder().addComponents(demand),
        new ActionRowBuilder().addComponents(rarity)
      );
      await interaction.showModal(modal);
      client.pendingEditImageByUser ??= new Map();
      if (newImageAttachment) {
        const ok = Boolean(newImageAttachment.contentType?.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(newImageAttachment.name));
        if (!ok) {
          return await interaction.reply({ content: 'Optional image must be an image file (PNG, JPG, GIF, or WebP).', ephemeral: true });
        }
        client.pendingEditImageByUser.set(interaction.user.id, { mode: 'set', url: newImageAttachment.url });
      } else {
        client.pendingEditImageByUser.set(interaction.user.id, { mode: 'keep' });
      }
      return;
    }
  }

  if (interaction.isButton()) {
    // DELETE HANDLER FIRST
    if (interaction.customId.startsWith('delete')) {
      if (!userIsAdmin(interaction.member)) {
        return await interaction.reply({ content: 'You do not have permission.', ephemeral: true });
      }
      const [action, itemId] = interaction.customId.split('-');
      const db = readDb();
      const itemIndex = db.findIndex(i => i.id === itemId);
      if (itemIndex === -1) {
        return await interaction.update({ content: 'Item already deleted or not found.', components: [] });
      }
      const itemName = db[itemIndex].name;
      if (action === 'confirm') {
        db.splice(itemIndex, 1);
        writeDb(db);
        await interaction.update({ content: `Item deleted: ${itemName}`, components: [] });
      } else if (action === 'cancel') {
        await interaction.update({ content: `Deletion cancelled for ${itemName}.`, components: [] });
      }
      return;
    }

    // Item list navigation
    const [name, action, value, pageRaw, pricingRaw, itemRaw] = interaction.customId.split('-');
    if (name !== 'itemlist') return;

    const currentPage = Number(pageRaw) || 1;
    let pricingSort = pricingRaw || 'n';
    let itemSort = itemRaw || 'n';
    let nextPage = currentPage;
    if (action === 'nav') {
      nextPage = value === 'next' ? currentPage + 1 : currentPage - 1;
    } else if (action === 'pricing') {
      pricingSort = value;
      nextPage = 1;
    } else if (action === 'items') {
      itemSort = value;
      nextPage = 1;
    } else if (action === 'clear') {
      pricingSort = 'n';
      itemSort = 'n';
      nextPage = 1;
    } else {
      return;
    }
    const [embed, rows] = buildItemListEmbed(nextPage, pricingSort, itemSort);
    await interaction.update({ embeds: [embed], components: rows });
    return;
  }

  if (interaction.isModalSubmit()) {
    if (!userIsAdmin(interaction.member)) {
      return await interaction.reply({ content: 'You do not have permission to submit this form.', ephemeral: true });
    }
    if (interaction.customId === 'addItemModal') {
      const name = interaction.fields.getTextInputValue('name').trim();
      const obtainable = interaction.fields.getTextInputValue('obtainable').trim();
      const demand = interaction.fields.getTextInputValue('demand').trim();
      const rarity = interaction.fields.getTextInputValue('rarity').trim();
      const valueInput = interaction.fields.getTextInputValue('value');
      const value = parsePositiveNumber(valueInput);
      if (!name || value === null) {
        return await interaction.reply({ content: 'Invalid input. Name is required and Value must be a valid number.', ephemeral: true });
      }
      const db = readDb();
      const existing = db.find(item => item.name.toLowerCase() === name.toLowerCase());
      if (existing) {
        return await interaction.reply({ content: `Item already exists: ${name}`, ephemeral: true });
      }
      const image = client.pendingAddImageByUser?.get(interaction.user.id);
      client.pendingAddImageByUser?.delete(interaction.user.id);
      db.push({
        id: makeId(),
        name,
        obtainable,
        demand,
        rarity,
        image,
        createdAt: new Date().toISOString(),
        valueHistory: [{ value, timestamp: new Date().toISOString() }],
      });
      writeDb(db);
      await interaction.reply({ content: `Item added successfully: ${name}`, ephemeral: true });
      return;
    }
    if (interaction.customId.startsWith('editItemModal')) {
      const itemId = interaction.customId.split('-')[1];
      const db = readDb();
      const item = db.find(entry => entry.id === itemId);
      if (!item) {
        return await interaction.reply({ content: 'Item not found anymore.', ephemeral: true });
      }
      const name = interaction.fields.getTextInputValue('name').trim();
      const obtainable = interaction.fields.getTextInputValue('obtainable').trim();
      const demand = interaction.fields.getTextInputValue('demand').trim();
      const rarity = interaction.fields.getTextInputValue('rarity').trim();
      const valueInput = interaction.fields.getTextInputValue('value');
      const value = parsePositiveNumber(valueInput);
      if (!name || value === null) {
        return await interaction.reply({ content: 'Invalid input. Name is required and Value must be a valid number.', ephemeral: true });
      }
      const duplicateByName = db.find(entry => entry.id !== itemId && entry.name.toLowerCase() === name.toLowerCase());
      if (duplicateByName) {
        return await interaction.reply({ content: `Another item already uses this name: ${name}`, ephemeral: true });
      }
      ensureHistory(item);
      const latest = item.valueHistory[item.valueHistory.length - 1];
      if (Number(latest.value) !== value) {
        item.valueHistory.push({ value, timestamp: new Date().toISOString() });
      }
      item.name = name;
      item.obtainable = obtainable;
      item.demand = demand;
      item.rarity = rarity;
      const pendingImage = client.pendingEditImageByUser?.get(interaction.user.id);
      client.pendingEditImageByUser?.delete(interaction.user.id);
      if (pendingImage?.mode === 'set') {
        item.image = pendingImage.url;
      }
      writeDb(db);
      await interaction.reply({ content: `Item updated successfully: ${name}`, ephemeral: true });
      return;
    }
  }
});

if (!process.env.TOKEN) {
  console.error('Missing TOKEN in environment variables');
  process.exit(1);
}
client.login(process.env.TOKEN);
