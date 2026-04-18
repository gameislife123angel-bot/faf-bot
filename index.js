require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const { ChartJSNodeCanvas } = require("chartjs-node-canvas");
const express = require("express");
const config = require("./config.json");

const webPort = Number(process.env.PORT) || Number(config.webPort) || 3000;
const app = express();

app.get("/", (req, res) => {
  res.type("text/plain").send("Bot is alive!");
});

app.listen(webPort, () => {
  // eslint-disable-next-line no-console
  console.log(`Web server running on port ${webPort}`);
});

function coinsEmoji() {
  const id = config.emojiCoinsId;
  return id ? `<:Coins:${id}>` : "🪙";
}

function halfstarEmoji() {
  const id = config.emojiHalfstarId;
  return id ? `<:Halfstar:${id}>` : "½";
}

const ITEMS_PER_PAGE = 10;
const GRAPH_WIDTH = 1000;
const GRAPH_HEIGHT = 420;
const GARAGE_PAGE_SIZE = 10;
const GARAGE_DB_PATH = "./data/garages.json";

const chartCanvas = new ChartJSNodeCanvas({
  width: GRAPH_WIDTH,
  height: GRAPH_HEIGHT,
  backgroundColour: "#0f1118",
});

function ensureDatabaseFile() {
  const resolvedPath = path.resolve(config.databasePath);
  const dir = path.dirname(resolvedPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (!fs.existsSync(resolvedPath)) {
    fs.writeFileSync(resolvedPath, JSON.stringify({ items: [] }, null, 2), "utf8");
  }
}

function readDb() {
  ensureDatabaseFile();
  const raw = fs.readFileSync(path.resolve(config.databasePath), "utf8");
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed.items) ? parsed : { items: [] };
}

function writeDb(db) {
  fs.writeFileSync(path.resolve(config.databasePath), JSON.stringify(db, null, 2), "utf8");
}

function ensureGarageFile() {
  const resolvedPath = path.resolve(GARAGE_DB_PATH);
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(resolvedPath)) {
    fs.writeFileSync(resolvedPath, JSON.stringify({ requests: [], garages: {} }, null, 2), "utf8");
  }
}

function readGarageDb() {
  ensureGarageFile();
  const raw = fs.readFileSync(path.resolve(GARAGE_DB_PATH), "utf8");
  const parsed = JSON.parse(raw);
  return {
    requests: Array.isArray(parsed.requests) ? parsed.requests : [],
    garages: parsed.garages && typeof parsed.garages === "object" ? parsed.garages : {},
  };
}

function writeGarageDb(db) {
  fs.writeFileSync(path.resolve(GARAGE_DB_PATH), JSON.stringify(db, null, 2), "utf8");
}

function makeId() {
  return `item_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
}

function findItemByName(name) {
  if (!name) return null;
  const db = readDb();
  const lower = name.toLowerCase().trim();
  return db.items.find((item) => item.name.toLowerCase() === lower) || null;
}

function formatDate(dateValue) {
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleDateString("en-GB");
}

function formatNumber(num) {
  return Number(num).toLocaleString("en-US");
}

function parsePositiveNumber(input) {
  const cleaned = String(input).replace(/,/g, "").trim();
  const num = Number(cleaned);
  if (!Number.isFinite(num) || num < 0) return null;
  return num;
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

  if (pricingSort === "h") {
    sorted.sort((a, b) => getLatestValue(b) - getLatestValue(a));
  } else if (pricingSort === "l") {
    sorted.sort((a, b) => getLatestValue(a) - getLatestValue(b));
  }

  if (itemSort === "az") {
    sorted.sort((a, b) => a.name.localeCompare(b.name));
  } else if (itemSort === "za") {
    sorted.sort((a, b) => b.name.localeCompare(a.name));
  } else if (itemSort === "new") {
    sorted.sort((a, b) => getCreatedAtMs(b) - getCreatedAtMs(a));
  } else if (itemSort === "old") {
    sorted.sort((a, b) => getCreatedAtMs(a) - getCreatedAtMs(b));
  }

  return sorted;
}

function pricingLabel(mode) {
  if (mode === "h") return "High to Low";
  if (mode === "l") return "Low to High";
  return "None";
}

function itemLabel(mode) {
  if (mode === "az") return "A-Z";
  if (mode === "za") return "Z-A";
  if (mode === "new") return "Newest";
  if (mode === "old") return "Oldest";
  return "None";
}

function renderStarsFromNumber(rawValue) {
  const fullStar = "⭐";
  const halfStar = halfstarEmoji();
  const emptyStar = "☆";
  const total = 5;
  const value = Math.max(0, Math.min(5, Number(rawValue)));
  const fullCount = Math.floor(value);
  const hasHalf = value - fullCount >= 0.5;
  const emptyCount = total - fullCount - (hasHalf ? 1 : 0);

  return `${fullStar.repeat(fullCount)}${hasHalf ? halfStar : ""}${emptyStar.repeat(emptyCount)}`;
}

function renderDemand(rawDemand) {
  const numeric = Number(rawDemand);
  if (Number.isFinite(numeric)) {
    return renderStarsFromNumber(numeric);
  }
  return String(rawDemand || "N/A");
}

function renderRarity(rawRarity) {
  const numeric = Number(rawRarity);
  if (Number.isFinite(numeric)) {
    return renderStarsFromNumber(numeric);
  }
  return String(rawRarity || "N/A");
}

function ensureHistory(item) {
  if (!Array.isArray(item.valueHistory)) {
    const baseValue = Number(item.value ?? 0);
    item.valueHistory = [
      {
        value: baseValue,
        timestamp: new Date().toISOString(),
      },
    ];
  }
}

function computeTightYRange(values) {
  const nums = values.map((v) => Number(v) || 0);
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

async function buildValueGraphAttachment(item) {
  ensureHistory(item);
  const points = [...item.valueHistory]
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
    .slice(-3);

  const labels = points.map((point) => formatDate(point.timestamp));
  const values = points.map((point) => Number(point.value) || 0);
  const { min: yMin, max: yMax } = computeTightYRange(values);

  const image = await chartCanvas.renderToBuffer({
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Value",
          data: values,
          borderWidth: 2,
          borderColor: "#b8df79",
          backgroundColor: "rgba(184, 223, 121, 0.22)",
          fill: true,
          tension: 0.35,
          pointRadius: 5,
          pointHoverRadius: 6,
          pointBackgroundColor: "#b8df79",
          pointBorderColor: "#0f1118",
          pointBorderWidth: 2,
        },
      ],
    },
    options: {
      responsive: false,
      plugins: {
        legend: { display: false },
      },
      scales: {
        y: {
          min: yMin,
          max: yMax,
          beginAtZero: false,
          ticks: {
            color: "#b8df79",
            maxTicksLimit: 6,
            callback: (val) => `${Number(val).toLocaleString("en-US")}`,
          },
          grid: { color: "rgba(255,255,255,0.08)" },
        },
        x: {
          ticks: { color: "#d6d8df" },
          grid: { color: "rgba(255,255,255,0.04)" },
        },
      },
    },
  });

  return new AttachmentBuilder(image, { name: "value-graph.png" });
}

function buildValueEmbed(item) {
  ensureHistory(item);
  const latest = item.valueHistory[item.valueHistory.length - 1];

  return new EmbedBuilder()
    .setColor(config.embedColor || 0x25adff)
    .setAuthor({ name: "FaF Values™" })
    .setTitle(item.name)
    .setThumbnail(item.image || null)
    .addFields(
      { name: "Obtainable", value: item.obtainable || "N/A", inline: false },
      { name: "Value", value: `${coinsEmoji()} ${formatNumber(latest.value)}`, inline: true },
      { name: "Demand", value: renderDemand(item.demand), inline: true },
      { name: "Rarity", value: renderRarity(item.rarity), inline: true }
    )
    .setImage("attachment://value-graph.png")
    .setFooter({ text: `FaF Real Value • Latest value update: ${formatDate(latest.timestamp)}` })
    .setTimestamp();
}

function buildItemListEmbed(page, pricingSort = "n", itemSort = "n") {
  const db = readDb();
  const orderedItems = sortItems(db.items, pricingSort, itemSort);
  const totalItems = orderedItems.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / ITEMS_PER_PAGE));
  const safePage = Math.max(1, Math.min(page, totalPages));
  const start = (safePage - 1) * ITEMS_PER_PAGE;
  const selected = orderedItems.slice(start, start + ITEMS_PER_PAGE);

  const lines = selected.map((item, index) => {
    return `${start + index + 1}. ${item.name} - ${formatNumber(getLatestValue(item))}`;
  });

  const embed = new EmbedBuilder()
    .setColor(config.embedColor || 0x25adff)
    .setTitle("FaF Item List")
    .setDescription(lines.length ? lines.join("\n") : "No items in database yet.")
    .addFields(
      {
        name: "Pricing Filter",
        value: pricingLabel(pricingSort),
        inline: true,
      },
      {
        name: "Item Filter",
        value: itemLabel(itemSort),
        inline: true,
      }
    )
    .setFooter({ text: `FaF Real Value • Page ${safePage}/${totalPages}` })
    .setTimestamp();

  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`itemlist:nav:prev:${safePage}:${pricingSort}:${itemSort}`)
      .setLabel("Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage <= 1),
    new ButtonBuilder()
      .setCustomId(`itemlist:nav:next:${safePage}:${pricingSort}:${itemSort}`)
      .setLabel("Next")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(safePage >= totalPages),
    new ButtonBuilder()
      .setCustomId(`itemlist:clear:all:${safePage}:${pricingSort}:${itemSort}`)
      .setLabel("Clear Filter")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(pricingSort === "n" && itemSort === "n")
  );

  const pricingRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`itemlist:pricing:h:${safePage}:${pricingSort}:${itemSort}`)
      .setLabel("Price: High to Low")
      .setStyle(pricingSort === "h" ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(pricingSort === "h"),
    new ButtonBuilder()
      .setCustomId(`itemlist:pricing:l:${safePage}:${pricingSort}:${itemSort}`)
      .setLabel("Price: Low to High")
      .setStyle(pricingSort === "l" ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(pricingSort === "l")
  );

  const itemsRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`itemlist:items:az:${safePage}:${pricingSort}:${itemSort}`)
      .setLabel("A to Z")
      .setStyle(itemSort === "az" ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(itemSort === "az"),
    new ButtonBuilder()
      .setCustomId(`itemlist:items:za:${safePage}:${pricingSort}:${itemSort}`)
      .setLabel("Z to A")
      .setStyle(itemSort === "za" ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(itemSort === "za"),
    new ButtonBuilder()
      .setCustomId(`itemlist:items:new:${safePage}:${pricingSort}:${itemSort}`)
      .setLabel("Newest")
      .setStyle(itemSort === "new" ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(itemSort === "new"),
    new ButtonBuilder()
      .setCustomId(`itemlist:items:old:${safePage}:${pricingSort}:${itemSort}`)
      .setLabel("Oldest")
      .setStyle(itemSort === "old" ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(itemSort === "old")
  );

  return { embed, rows: [navRow, pricingRow, itemsRow], safePage, totalPages };
}

function userIsAdmin(member) {
  return member.roles?.cache?.has(config.adminRoleId);
}

function userCanReviewGarage(member) {
  return member.roles?.cache?.has(config.garageReviewerRoleId);
}

function parseLookupTarget(raw) {
  const match = String(raw || "").match(/\d{17,20}/);
  return match ? match[0] : null;
}

function parseQtyMap(rawText) {
  const map = {};
  const text = String(rawText || "").trim();
  if (!text) return map;
  const parts = text.split(",");
  for (const part of parts) {
    const [left, right] = part.split("=");
    if (!left || !right) continue;
    const name = left.trim().toLowerCase();
    const qty = Number(right.trim());
    if (!name || !Number.isFinite(qty) || qty <= 0) continue;
    map[name] = Math.floor(qty);
  }
  return map;
}

function buildRequestItemsFromSelection(selectedNames, qtyMap) {
  const db = readDb();
  const out = [];
  for (const name of selectedNames) {
    const item = db.items.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
    if (!item) continue;
    const qty = qtyMap[item.name.toLowerCase()] || 1;
    out.push({ itemId: item.id, itemName: item.name, qty: Math.max(1, Math.min(9999, qty)) });
  }
  return out;
}

function getGarageEntriesForUser(userId) {
  const garageDb = readGarageDb();
  const userEntries = Array.isArray(garageDb.garages[userId]) ? garageDb.garages[userId] : [];
  const itemDb = readDb();
  const rows = userEntries
    .map((entry) => {
      const item = itemDb.items.find((it) => it.id === entry.itemId || it.name === entry.itemName);
      if (!item) return null;
      const qty = Math.max(1, Number(entry.qty) || 1);
      const unitValue = getLatestValue(item);
      return {
        itemId: item.id,
        itemName: item.name,
        qty,
        unitValue,
        totalValue: unitValue * qty,
      };
    })
    .filter(Boolean);
  return rows;
}

function buildGarageLookupEmbed(targetUser, rows, page = 1) {
  const totalPages = Math.max(1, Math.ceil(rows.length / GARAGE_PAGE_SIZE));
  const safePage = Math.max(1, Math.min(page, totalPages));
  const start = (safePage - 1) * GARAGE_PAGE_SIZE;
  const selected = rows.slice(start, start + GARAGE_PAGE_SIZE);
  const totalValue = rows.reduce((sum, row) => sum + row.totalValue, 0);
  const totalQty = rows.reduce((sum, row) => sum + row.qty, 0);
  const description = selected.length
    ? selected
        .map((row, idx) => `${start + idx + 1}. ${row.qty} - ${row.itemName} - ${formatNumber(row.totalValue)}`)
        .join("\n")
    : "No garage items.";

  const embed = new EmbedBuilder()
    .setColor(config.embedColor || 0x25adff)
    .setAuthor({
      name: `${targetUser.username}'s Garage`,
      iconURL: targetUser.displayAvatarURL(),
    })
    .setDescription(description)
    .addFields(
      { name: "Total Qty", value: formatNumber(totalQty), inline: true },
      { name: "Total Value", value: `${coinsEmoji()} ${formatNumber(totalValue)}`, inline: true }
    )
    .setFooter({ text: `FaF Real Value • Page ${safePage}/${totalPages}` })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`garagelookup:prev:${targetUser.id}:${safePage}`)
      .setLabel("Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage <= 1),
    new ButtonBuilder()
      .setCustomId(`garagelookup:next:${targetUser.id}:${safePage}`)
      .setLabel("Next")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(safePage >= totalPages)
  );

  return { embed, row };
}

function upsertGarageItems(userId, requestItems) {
  const garageDb = readGarageDb();
  const current = Array.isArray(garageDb.garages[userId]) ? garageDb.garages[userId] : [];
  const byItemId = new Map(current.map((entry) => [entry.itemId || entry.itemName, { ...entry }]));

  for (const reqItem of requestItems) {
    const key = reqItem.itemId || reqItem.itemName;
    const existing = byItemId.get(key);
    if (existing) {
      existing.qty = (Number(existing.qty) || 0) + (Number(reqItem.qty) || 1);
      existing.itemName = reqItem.itemName;
      existing.itemId = reqItem.itemId;
      byItemId.set(key, existing);
    } else {
      byItemId.set(key, { itemId: reqItem.itemId, itemName: reqItem.itemName, qty: Number(reqItem.qty) || 1 });
    }
  }

  garageDb.garages[userId] = [...byItemId.values()];
  writeGarageDb(garageDb);
}

function buildGarageSelectRows(userId) {
  const db = readDb();
  const options = db.items.slice(0, 25).map((item) => ({
    label: item.name.slice(0, 100),
    value: item.name,
    description: `${formatNumber(getLatestValue(item))}`.slice(0, 100),
  }));
  if (!options.length) return null;
  const select = new StringSelectMenuBuilder()
    .setCustomId(`garageadd:itemselect:${userId}`)
    .setPlaceholder("Select up to 25 items")
    .setMinValues(1)
    .setMaxValues(options.length)
    .addOptions(options);
  return [new ActionRowBuilder().addComponents(select)];
}

const slashCommands = [
  new SlashCommandBuilder()
    .setName("additem")
    .setDescription("Add a new FaF item")
    .addAttachmentOption((opt) =>
      opt.setName("image").setDescription("Upload item image").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("edititem")
    .setDescription("Edit an existing item")
    .addStringOption((opt) =>
      opt.setName("old_item_name").setDescription("Existing item name").setRequired(true)
    )
    .addAttachmentOption((opt) =>
      opt.setName("image").setDescription("New image upload (optional)").setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("deleteitem")
    .setDescription("Delete an existing item")
    .addStringOption((opt) =>
      opt.setName("itemname").setDescription("Name of the item to delete").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("garageadd")
    .setDescription("Submit a garage add request")
    .addAttachmentOption((opt) =>
      opt.setName("evidence").setDescription("Upload valid evidence image").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("garagedelete")
    .setDescription("Delete a user's full garage")
    .addUserOption((opt) => opt.setName("user").setDescription("Target user").setRequired(true)),
  new SlashCommandBuilder()
    .setName("garageedituser")
    .setDescription("Edit user garage item quantity")
    .addUserOption((opt) => opt.setName("user").setDescription("Target user").setRequired(true))
    .addStringOption((opt) =>
      opt.setName("item_name").setDescription("Item name to edit").setRequired(true)
    )
    .addIntegerOption((opt) =>
      opt.setName("qty").setDescription("New qty (0 to remove)").setRequired(true).setMinValue(0)
    ),
].map((command) => command.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);
  await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), {
    body: slashCommands,
  });
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once(Events.ClientReady, async (readyClient) => {
  try {
    await registerCommands();
    // eslint-disable-next-line no-console
    console.log(`Ready as ${readyClient.user.tag}`);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("Failed to register slash commands:", error);
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.content.startsWith(config.prefix || "!")) return;

  const [command, ...rest] = message.content.slice((config.prefix || "!").length).trim().split(" ");
  const cmd = command?.toLowerCase();

  if (cmd === "value") {
    const query = rest.join(" ").trim();
    if (!query) {
      await message.reply("Use: `!value <item name>`");
      return;
    }

    const item = findItemByName(query);
    if (!item) {
      await message.reply(`Item not found: **${query}**`);
      return;
    }

    try {
      const graph = await buildValueGraphAttachment(item);
      const embed = buildValueEmbed(item);
      await message.reply({ embeds: [embed], files: [graph] });
    } catch (error) {
      await message.reply("Could not build value graph for this item.");
    }
  }

  if (cmd === "itemlist") {
    const { embed, rows } = buildItemListEmbed(1, "n", "n");
    await message.reply({ embeds: [embed], components: rows });
  }

  if (cmd === "garageadd") {
    const attachment = message.attachments.first();
    if (!attachment) {
      await message.reply("Attach an evidence image with `!garageadd`.");
      return;
    }
    const isImage =
      Boolean(attachment.contentType?.startsWith("image/")) ||
      /\.(png|jpe?g|gif|webp)$/i.test(attachment.name || "");
    if (!isImage) {
      await message.reply("Evidence must be an image file.");
      return;
    }
    const rows = buildGarageSelectRows(message.author.id);
    if (!rows) {
      await message.reply("No items available in item list yet.");
      return;
    }
    client.pendingGarageAddEvidence ??= new Map();
    client.pendingGarageAddEvidence.set(message.author.id, {
      evidenceUrl: attachment.url,
      evidenceName: attachment.name || "evidence",
      sourceMessageId: message.id,
    });
    client.pendingGarageSelections ??= new Map();
    client.pendingGarageSelections.set(message.author.id, {
      evidenceUrl: attachment.url,
      evidenceName: attachment.name || "evidence",
      selectedNames: [],
    });
    await message.reply({
      content: "Select items first. After selecting, you will be asked for qty.",
      components: rows,
    });
    return;
  }

  if (cmd === "lookup") {
    const targetRaw = rest.join(" ").trim();
    const targetId = parseLookupTarget(targetRaw);
    if (!targetId) {
      await message.reply("Use: `!lookup <@user|userId>`");
      return;
    }

    try {
      const targetUser = await client.users.fetch(targetId);
      const rows = getGarageEntriesForUser(targetId);
      const { embed, row } = buildGarageLookupEmbed(targetUser, rows, 1);
      await message.reply({ embeds: [embed], components: [row] });
    } catch (error) {
      await message.reply("Could not find that user.");
    }
    return;
  }

  if (cmd === "leaderboard") {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("garageleader:value:1")
        .setLabel("Value")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("garageleader:qty:1")
        .setLabel("Qty")
        .setStyle(ButtonStyle.Secondary)
    );
    await message.reply({
      content: "Choose leaderboard type:",
      components: [row],
    });
    return;
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) {
    const adminOnlyCommands = new Set([
      "additem",
      "edititem",
      "deleteitem",
      "garagedelete",
      "garageedituser",
    ]);
    if (adminOnlyCommands.has(interaction.commandName) && !userIsAdmin(interaction.member)) {
      await interaction.reply({
        content: "You do not have permission to use this command.",
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === "additem") {
      const attachment = interaction.options.getAttachment("image", true);
      const isImage =
        Boolean(attachment.contentType?.startsWith("image/")) ||
        /\.(png|jpe?g|gif|webp)$/i.test(attachment.name || "");
      if (!isImage) {
        await interaction.reply({
          content: "Please upload an image file (PNG, JPG, GIF, or WebP).",
          ephemeral: true,
        });
        return;
      }

      const modal = new ModalBuilder().setCustomId("addItemModal").setTitle("Add Item");
      const name = new TextInputBuilder()
        .setCustomId("name")
        .setLabel("Name")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      const obtainable = new TextInputBuilder()
        .setCustomId("obtainable")
        .setLabel("Obtainable")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      const value = new TextInputBuilder()
        .setCustomId("value")
        .setLabel("Value")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      const demand = new TextInputBuilder()
        .setCustomId("demand")
        .setLabel("Demand (0-5 or text)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      const rarity = new TextInputBuilder()
        .setCustomId("rarity")
        .setLabel("Rarity (0-5 or text)")
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

    if (interaction.commandName === "edititem") {
      const oldItemName = interaction.options.getString("old_item_name", true);
      const newImageAttachment = interaction.options.getAttachment("image");
      const db = readDb();
      const item = db.items.find((entry) => entry.name.toLowerCase() === oldItemName.toLowerCase());

      if (!item) {
        await interaction.reply({ content: `Item not found: **${oldItemName}**`, ephemeral: true });
        return;
      }

      ensureHistory(item);
      const latest = item.valueHistory[item.valueHistory.length - 1];
      const modal = new ModalBuilder().setCustomId(`editItemModal:${item.id}`).setTitle("Edit Item");
      const name = new TextInputBuilder()
        .setCustomId("name")
        .setLabel("Name")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(item.name.slice(0, 100));
      const obtainable = new TextInputBuilder()
        .setCustomId("obtainable")
        .setLabel("Obtainable")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue((item.obtainable || "").slice(0, 100));
      const value = new TextInputBuilder()
        .setCustomId("value")
        .setLabel("Value")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(String(latest.value));
      const demand = new TextInputBuilder()
        .setCustomId("demand")
        .setLabel("Demand (0-5 or text)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(String(item.demand ?? ""));
      const rarity = new TextInputBuilder()
        .setCustomId("rarity")
        .setLabel("Rarity (0-5 or text)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(String(item.rarity ?? ""));

      modal.addComponents(
        new ActionRowBuilder().addComponents(name),
        new ActionRowBuilder().addComponents(obtainable),
        new ActionRowBuilder().addComponents(value),
        new ActionRowBuilder().addComponents(demand),
        new ActionRowBuilder().addComponents(rarity)
      );

      await interaction.showModal(modal);
      client.pendingEditImageByUser ??= new Map();
      if (newImageAttachment) {
        const ok =
          Boolean(newImageAttachment.contentType?.startsWith("image/")) ||
          /\.(png|jpe?g|gif|webp)$/i.test(newImageAttachment.name || "");
        if (!ok) {
          await interaction.reply({
            content: "Optional image must be an image file (PNG, JPG, GIF, or WebP).",
            ephemeral: true,
          });
          return;
        }
        client.pendingEditImageByUser.set(interaction.user.id, { mode: "set", url: newImageAttachment.url });
      } else {
        client.pendingEditImageByUser.set(interaction.user.id, { mode: "keep" });
      }
      return;
    }

    if (interaction.commandName === "deleteitem") {
      const itemName = interaction.options.getString("itemname", true).trim();
      const db = readDb();
      const item = db.items.find((entry) => entry.name.toLowerCase() === itemName.toLowerCase());

      if (!item) {
        await interaction.reply({
          content: `Item not found: **${itemName}**`,
          ephemeral: true,
        });
        return;
      }

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`deleteitem:confirm:${item.id}:${interaction.user.id}`)
          .setLabel("Yes")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`deleteitem:cancel:${item.id}:${interaction.user.id}`)
          .setLabel("No")
          .setStyle(ButtonStyle.Secondary)
      );

      await interaction.reply({
        content: `Are you sure you want to delete **${item.name}**?`,
        components: [row],
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === "garageadd") {
      const evidence = interaction.options.getAttachment("evidence", true);
      const isImage =
        Boolean(evidence.contentType?.startsWith("image/")) ||
        /\.(png|jpe?g|gif|webp)$/i.test(evidence.name || "");
      if (!isImage) {
        await interaction.reply({
          content: "Evidence must be an image file.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const rows = buildGarageSelectRows(interaction.user.id);
      if (!rows) {
        await interaction.reply({
          content: "No items available in item list yet.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      client.pendingGarageAddEvidence ??= new Map();
      client.pendingGarageAddEvidence.set(interaction.user.id, {
        evidenceUrl: evidence.url,
        evidenceName: evidence.name || "evidence",
      });
      client.pendingGarageSelections ??= new Map();
      client.pendingGarageSelections.set(interaction.user.id, {
        evidenceUrl: evidence.url,
        evidenceName: evidence.name || "evidence",
        selectedNames: [],
      });
      await interaction.reply({
        content: "Select items first. After selecting, you will be asked for qty.",
        components: rows,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.commandName === "garagedelete") {
      const target = interaction.options.getUser("user", true);
      const garageDb = readGarageDb();
      delete garageDb.garages[target.id];
      writeGarageDb(garageDb);
      await interaction.reply({
        content: `Deleted full garage for <@${target.id}>.`,
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === "garageedituser") {
      const target = interaction.options.getUser("user", true);
      const itemName = interaction.options.getString("item_name", true).trim();
      const qty = interaction.options.getInteger("qty", true);
      const item = findItemByName(itemName);
      if (!item) {
        await interaction.reply({ content: `Item not found: **${itemName}**`, ephemeral: true });
        return;
      }

      const garageDb = readGarageDb();
      const entries = Array.isArray(garageDb.garages[target.id]) ? garageDb.garages[target.id] : [];
      const idx = entries.findIndex((entry) => entry.itemId === item.id || entry.itemName === item.name);

      if (qty === 0) {
        if (idx >= 0) entries.splice(idx, 1);
      } else if (idx >= 0) {
        entries[idx].qty = qty;
        entries[idx].itemName = item.name;
        entries[idx].itemId = item.id;
      } else {
        entries.push({ itemId: item.id, itemName: item.name, qty });
      }

      garageDb.garages[target.id] = entries;
      writeGarageDb(garageDb);
      await interaction.reply({
        content: `Garage updated for <@${target.id}>: **${item.name}** qty is now **${qty}**.`,
        ephemeral: true,
      });
      return;
    }
  }

  if (interaction.isStringSelectMenu()) {
    if (interaction.customId.startsWith("garageadd:itemselect:")) {
      const ownerId = interaction.customId.split(":")[2];
      if (interaction.user.id !== ownerId) {
        await interaction.reply({
          content: "This selection is not for you.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      client.pendingGarageSelections ??= new Map();
      const current = client.pendingGarageSelections.get(interaction.user.id) || {};
      current.selectedNames = interaction.values;
      client.pendingGarageSelections.set(interaction.user.id, current);
      const modal = new ModalBuilder()
        .setCustomId(`garageadd:qtymodal:${interaction.user.id}`)
        .setTitle("Set Item Qty");
      const qtyInput = new TextInputBuilder()
        .setCustomId("qty_map")
        .setLabel("Qty map (item=qty, item2=qty)")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setPlaceholder("Example: Hallowood=2, Test Item=5");
      modal.addComponents(new ActionRowBuilder().addComponents(qtyInput));
      await interaction.showModal(modal);
      return;
    }
  }

  if (interaction.isButton()) {
    if (interaction.customId.startsWith("garagereview:")) {
      const [, action, requestId] = interaction.customId.split(":");
      if (!userCanReviewGarage(interaction.member)) {
        await interaction.reply({ content: "You cannot review garage requests.", ephemeral: true });
        return;
      }
      const modal = new ModalBuilder().setCustomId(`garagereviewreason:${action}:${requestId}`).setTitle("Review Reason");
      const reason = new TextInputBuilder()
        .setCustomId("reason")
        .setLabel("Reason")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(reason));
      await interaction.showModal(modal);
      return;
    }

    if (interaction.customId.startsWith("garageleader:")) {
      const [, mode] = interaction.customId.split(":");
      const garageDb = readGarageDb();
      const scores = Object.entries(garageDb.garages).map(([userId, entries]) => {
        const rows = getGarageEntriesForUser(userId);
        return {
          userId,
          qty: rows.reduce((sum, r) => sum + r.qty, 0),
          value: rows.reduce((sum, r) => sum + r.totalValue, 0),
        };
      });
      scores.sort((a, b) => (mode === "qty" ? b.qty - a.qty : b.value - a.value));
      const top = scores.slice(0, 10);
      const desc = top.length
        ? top
            .map((row, idx) =>
              mode === "qty"
                ? `${idx + 1}. <@${row.userId}> - ${formatNumber(row.qty)}`
                : `${idx + 1}. <@${row.userId}> - ${coinsEmoji()} ${formatNumber(row.value)}`
            )
            .join("\n")
        : "No garage data yet.";
      const embed = new EmbedBuilder()
        .setColor(config.embedColor || 0x25adff)
        .setTitle(mode === "qty" ? "Garage Leaderboard (Qty)" : "Garage Leaderboard (Value)")
        .setDescription(desc)
        .setFooter({ text: "FaF Real Value" })
        .setTimestamp();
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("garageleader:value:1")
          .setLabel("Value")
          .setStyle(mode === "value" ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("garageleader:qty:1")
          .setLabel("Qty")
          .setStyle(mode === "qty" ? ButtonStyle.Success : ButtonStyle.Secondary)
      );
      await interaction.update({ embeds: [embed], components: [row], content: "" });
      return;
    }

    if (interaction.customId.startsWith("garagelookup:")) {
      const [, dir, targetId, pageRaw] = interaction.customId.split(":");
      const currentPage = Number(pageRaw) || 1;
      const nextPage = dir === "next" ? currentPage + 1 : currentPage - 1;
      const targetUser = await client.users.fetch(targetId).catch(() => null);
      if (!targetUser) {
        await interaction.reply({ content: "User not found.", ephemeral: true });
        return;
      }
      const rows = getGarageEntriesForUser(targetId);
      const { embed, row } = buildGarageLookupEmbed(targetUser, rows, nextPage);
      await interaction.update({ embeds: [embed], components: [row] });
      return;
    }

    if (interaction.customId.startsWith("deleteitem:")) {
      const [, action, itemId, ownerId] = interaction.customId.split(":");

      if (interaction.user.id !== ownerId) {
        await interaction.reply({
          content: "This confirmation is not for you.",
          ephemeral: true,
        });
        return;
      }

      if (action === "cancel") {
        await interaction.update({
          content: "Deletion cancelled. Item was kept.",
          components: [],
        });
        return;
      }

      if (action === "confirm") {
        const db = readDb();
        const idx = db.items.findIndex((entry) => entry.id === itemId);

        if (idx === -1) {
          await interaction.update({
            content: "Item was already deleted or no longer exists.",
            components: [],
          });
          return;
        }

        const deleted = db.items[idx];
        db.items.splice(idx, 1);
        writeDb(db);

        await interaction.update({
          content: `Deleted item: **${deleted.name}**`,
          components: [],
        });
        return;
      }

      return;
    }

    const [name, action, value, pageRaw, pricingRaw, itemRaw] = interaction.customId.split(":");
    if (name !== "itemlist") return;

    const currentPage = Number(pageRaw) || 1;
    let pricingSort = pricingRaw || "n";
    let itemSort = itemRaw || "n";
    let nextPage = currentPage;

    if (action === "nav") {
      nextPage = value === "next" ? currentPage + 1 : currentPage - 1;
    } else if (action === "pricing") {
      pricingSort = value;
      nextPage = 1;
    } else if (action === "items") {
      itemSort = value;
      nextPage = 1;
    } else if (action === "clear") {
      pricingSort = "n";
      itemSort = "n";
      nextPage = 1;
    } else {
      return;
    }

    const { embed, rows } = buildItemListEmbed(nextPage, pricingSort, itemSort);
    await interaction.update({ embeds: [embed], components: rows });
    return;
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId.startsWith("garageadd:qtymodal:")) {
      const ownerId = interaction.customId.split(":")[2];
      if (interaction.user.id !== ownerId) {
        await interaction.reply({
          content: "This qty form is not for you.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const pending = client.pendingGarageSelections?.get(interaction.user.id);
      if (!pending?.selectedNames?.length || !pending?.evidenceUrl) {
        await interaction.reply({
          content: "Selection or evidence missing. Start again with `!garageadd` or `/garageadd`.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const qtyMapRaw = interaction.fields.getTextInputValue("qty_map");
      const qtyMap = parseQtyMap(qtyMapRaw);
      const requestItems = buildRequestItemsFromSelection(pending.selectedNames, qtyMap);
      if (!requestItems.length) {
        await interaction.reply({
          content: "Selected items are no longer valid.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const reviewChannel = await client.channels.fetch(config.garageRequestChannelId).catch(() => null);
      if (!reviewChannel?.isTextBased()) {
        await interaction.reply({
          content: "Request channel is not available. Ask admin to check config channel ID.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const garageDb = readGarageDb();
      const requestId = makeId();
      const request = {
        id: requestId,
        userId: interaction.user.id,
        username: interaction.user.tag,
        evidenceUrl: pending.evidenceUrl,
        items: requestItems,
        createdAt: new Date().toISOString(),
        status: "pending",
      };
      garageDb.requests.push(request);
      writeGarageDb(garageDb);

      const reviewEmbed = new EmbedBuilder()
        .setColor(config.embedColor || 0x25adff)
        .setTitle("Garage Add Request")
        .addFields(
          { name: "User", value: `<@${interaction.user.id}> (${interaction.user.id})`, inline: false },
          {
            name: "Items",
            value: requestItems.map((it) => `- ${it.qty} x ${it.itemName}`).join("\n"),
            inline: false,
          },
          { name: "Evidence", value: pending.evidenceUrl, inline: false }
        )
        .setImage(pending.evidenceUrl)
        .setFooter({ text: "FaF Real Value" })
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`garagereview:approve:${requestId}`).setLabel("Approve").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`garagereview:decline:${requestId}`).setLabel("Decline").setStyle(ButtonStyle.Danger)
      );
      await reviewChannel.send({ embeds: [reviewEmbed], components: [row] });

      client.pendingGarageSelections?.delete(interaction.user.id);
      client.pendingGarageAddEvidence?.delete(interaction.user.id);
      await interaction.reply({
        content: "Request submitted for review.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.customId.startsWith("garagereviewreason:")) {
      const [, action, requestId] = interaction.customId.split(":");
      if (!userCanReviewGarage(interaction.member)) {
        await interaction.reply({ content: "You cannot review garage requests.", ephemeral: true });
        return;
      }

      const reason = interaction.fields.getTextInputValue("reason").trim();
      const garageDb = readGarageDb();
      const request = garageDb.requests.find((entry) => entry.id === requestId);
      if (!request || request.status !== "pending") {
        await interaction.reply({ content: "Request not found or already processed.", ephemeral: true });
        return;
      }

      request.status = action === "approve" ? "approved" : "declined";
      request.reviewedBy = interaction.user.id;
      request.reviewedAt = new Date().toISOString();
      request.reviewReason = reason;
      writeGarageDb(garageDb);

      if (action === "approve") {
        upsertGarageItems(request.userId, request.items);
      }

      const decisionLines = request.items.map((it) => `- ${it.qty} x ${it.itemName}`).join("\n");
      const targetUser = await client.users.fetch(request.userId).catch(() => null);
      if (targetUser) {
        if (action === "approve") {
          await targetUser.send(
            `Your request to add in garage was accepted for following:\n${decisionLines}\nApproved by: ${interaction.user.tag}\nTimestamp: ${new Date().toLocaleString()}`
          );
        } else {
          await targetUser.send(
            `Your request has been declined to upload following items:\n${decisionLines}\nDeclined by: ${interaction.user.tag}\nTimestamp: ${new Date().toLocaleString()}\nReason: ${reason}`
          );
        }
      }

      const statusText = action === "approve" ? "Approved" : "Declined";
      await interaction.reply({ content: `${statusText} request ${requestId}.`, ephemeral: true });
      await interaction.message.edit({ components: [] }).catch(() => null);
      return;
    }

    if (!userIsAdmin(interaction.member)) {
      await interaction.reply({
        content: "You do not have permission to submit this form.",
        ephemeral: true,
      });
      return;
    }

    if (interaction.customId === "addItemModal") {
      const name = interaction.fields.getTextInputValue("name").trim();
      const obtainable = interaction.fields.getTextInputValue("obtainable").trim();
      const demand = interaction.fields.getTextInputValue("demand").trim();
      const rarity = interaction.fields.getTextInputValue("rarity").trim();
      const valueInput = interaction.fields.getTextInputValue("value");
      const value = parsePositiveNumber(valueInput);

      if (!name || value === null) {
        await interaction.reply({
          content: "Invalid input. Name is required and Value must be a valid number.",
          ephemeral: true,
        });
        return;
      }

      const db = readDb();
      const existing = db.items.find((item) => item.name.toLowerCase() === name.toLowerCase());
      if (existing) {
        await interaction.reply({
          content: `Item already exists: **${name}**`,
          ephemeral: true,
        });
        return;
      }

      const image = client.pendingAddImageByUser?.get(interaction.user.id) || "";
      client.pendingAddImageByUser?.delete(interaction.user.id);

      db.items.push({
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

      await interaction.reply({
        content: `Item added successfully: **${name}**`,
        ephemeral: true,
      });
      return;
    }

    if (interaction.customId.startsWith("editItemModal:")) {
      const itemId = interaction.customId.split(":")[1];
      const db = readDb();
      const item = db.items.find((entry) => entry.id === itemId);

      if (!item) {
        await interaction.reply({ content: "Item not found anymore.", ephemeral: true });
        return;
      }

      const name = interaction.fields.getTextInputValue("name").trim();
      const obtainable = interaction.fields.getTextInputValue("obtainable").trim();
      const demand = interaction.fields.getTextInputValue("demand").trim();
      const rarity = interaction.fields.getTextInputValue("rarity").trim();
      const valueInput = interaction.fields.getTextInputValue("value");
      const value = parsePositiveNumber(valueInput);

      if (!name || value === null) {
        await interaction.reply({
          content: "Invalid input. Name is required and Value must be a valid number.",
          ephemeral: true,
        });
        return;
      }

      const duplicateByName = db.items.find(
        (entry) => entry.id !== itemId && entry.name.toLowerCase() === name.toLowerCase()
      );
      if (duplicateByName) {
        await interaction.reply({
          content: `Another item already uses this name: **${name}**`,
          ephemeral: true,
        });
        return;
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
      if (pendingImage?.mode === "set" && pendingImage.url) {
        item.image = pendingImage.url;
      }

      writeDb(db);

      await interaction.reply({
        content: `Item updated successfully: **${name}**`,
        ephemeral: true,
      });
    }
  }
});

if (!process.env.TOKEN) {
  // eslint-disable-next-line no-console
  console.error("Missing TOKEN. Create a .env file with TOKEN=your_bot_token");
  process.exit(1);
}

client.login(process.env.TOKEN);
