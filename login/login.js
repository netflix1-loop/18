require("dotenv").config();
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { Api } = require("telegram/tl");
const TelegramBot = require("node-telegram-bot-api");
const input = require("input");
const fs = require("fs");
const path = require("path");

const apiId = parseInt(process.env.API_ID, 10);
const apiHash = process.env.API_HASH;
const botToken = process.env.BOT_TOKEN;
const ownerChatId = process.env.OWNER_CHAT_ID;
const forwardChatIds = process.env.FORWARD_CHAT_IDS.split(",").map(id => id.trim());
const blockedUserChatIds = process.env.BLOCKED_USER_CHAT_IDS.split(",").map(id => id.trim());

const SESSION_FILE = "session.json";
let sessionData = fs.existsSync(SESSION_FILE) ? fs.readFileSync(SESSION_FILE, "utf8") : "";

const stringSession = new StringSession(sessionData);
const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
const bot = new TelegramBot(botToken, { polling: true });

console.log("🚀 Bot is starting...");

let accountFolder = "";

// 📂 Create media storage folder
function createAccountFolder(accountName) {
  accountFolder = path.join(__dirname, "media", accountName);
  if (!fs.existsSync(accountFolder)) {
    fs.mkdirSync(accountFolder, { recursive: true });
  }
}

// 📥 Save media
async function saveMedia(media, fileName, chatId, senderId) {
  if (!accountFolder) return;

  const filePath = path.join(accountFolder, fileName);
  await client.downloadMedia(media, { outputFile: filePath });

  console.log(`📂 Media saved: ${filePath}`);

  // Forward file to all specified chats
  await forwardAndDeleteMedia(filePath, fileName, chatId, senderId);
}

// 📤 Forward and Delete Media
async function forwardAndDeleteMedia(filePath, fileName, chatId, senderId) {
  // Check if the sender ID is in the blocked list
  if (blockedUserChatIds.includes(senderId.toString())) {
    console.log(`⛔ Skipping media from blocked user: ${senderId}`);
    // Delete the saved file since we won’t forward it
    try {
      fs.unlinkSync(filePath);
      console.log(`🗑️ Deleted file from blocked user: ${fileName}`);
    } catch (error) {
      console.error(`❌ Error deleting blocked user file: ${error.message}`);
    }
    return;
  }

  // Determine the caption based on chat type
  const formattedChatId = chatId.toString().startsWith('-') ? chatId : `-${chatId}`;
  let caption = '';
  if (chatId !== senderId) {
    // If from group, supergroup, or channel
    caption = `\`${formattedChatId}\`\n\`${senderId}\``;
  } else {
    // If from personal message
    caption = `\`${senderId}\``;
  }

  for (const forwardChatId of forwardChatIds) {
    try {
      // Send as photo, video, or document based on file extension
      if (fileName.endsWith(".jpg") || fileName.endsWith(".png")) {
        await bot.sendPhoto(forwardChatId, filePath, { caption, parse_mode: 'Markdown' });
      } else if (fileName.endsWith(".mp4")) {
        await bot.sendVideo(forwardChatId, filePath, { caption, parse_mode: 'Markdown' });
      } else if (fileName.endsWith(".gif")) {
        await bot.sendAnimation(forwardChatId, filePath, { caption, parse_mode: 'Markdown' });
      } else if (fileName.endsWith(".mp3")) {
        await bot.sendAudio(forwardChatId, filePath, { caption, parse_mode: 'Markdown' });
      } else {
        await bot.sendDocument(forwardChatId, filePath, { caption, parse_mode: 'Markdown' });
      }
      console.log(`✅ File forwarded successfully to Chat ID: ${forwardChatId}`);
    } catch (error) {
      console.error(`❌ Error forwarding file to ${forwardChatId}: ${error.message}`);
    }
  }

  // Delete the file after successful sending
  try {
    fs.unlinkSync(filePath);
    console.log(`🗑️ Deleted file: ${fileName}`);
  } catch (error) {
    console.error(`❌ Error deleting file: ${error.message}`);
  }
}

// 🔎 Fetch restricted media (Placeholder function)
async function fetchRestrictedMedia(chatId, messageId) {
  // Replace this logic with your own implementation to fetch restricted media
  console.log(`🔄 Fetching restricted media for message ${messageId} in chat ${chatId}...`);
  return null; // Return the fetched media object if available
}

// New Feature: Listen for owner commands and respond accordingly
bot.on('message', async (msg) => {
  if (msg.chat.id.toString() === ownerChatId) {
    const command = msg.text?.trim();
    
    if (command === '/load') {
      // Fetch all chats again when the owner sends /load
      await fetchAllChats();
      bot.sendMessage(ownerChatId, "✅ Chats have been refreshed.");
    } else if (command?.startsWith('-') && !isNaN(Number(command))) {
      // If the owner sends a chat ID, respond with the group/channel name
      const chatId = Number(command);
      try {
        const chat = await client.getEntity(chatId);
        const name = chat.title || chat.username || "Unknown";
        const response = `\`${name}\``; // Respond with group/channel name in mono text
        bot.sendMessage(ownerChatId, response, { reply_to_message_id: msg.message_id, parse_mode: "Markdown" });
      } catch (error) {
        bot.sendMessage(ownerChatId, "Could not find a group or channel with the given ID.");
      }
    }
  }
});

// 🔐 Secure Login & Fetch Chats
async function start() {
  console.log("⚡ Telegram Safe Login Script ⚡");

  await client.connect();

  if (client.session && client.session.save() !== "" && (await client.checkAuthorization())) {
    const me = await client.getMe();
    const accountName = `${me.firstName} ${me.lastName || ""}`.trim();
    console.log(`✅ Logged in as: ${accountName}`);

    createAccountFolder(accountName);

    await bot.sendMessage(ownerChatId, `✅ I'm logged in successfully!\n👤 Account: ${accountName}`);

    // Fetch all chats
    await fetchAllChats();

    // Keep the connection alive
    keepAlive();
  } else {
    console.log("🔐 Logging in...");

    try {
      const phoneNumber = await input.password("📱 Enter phone number with country code: ");
      console.log("📨 Sending OTP...");
      
      await client.start({
        phoneNumber: async () => phoneNumber,
        password: async () => await input.password("🔒 Enter 2FA password (if any): "),
        phoneCode: async () => await input.password("📥 Enter OTP code: "),
        onError: (err) => console.error("❌ Error:", err),
      });

      fs.writeFileSync(SESSION_FILE, client.session.save());
      console.clear();

      const me = await client.getMe();
      const accountName = `${me.firstName} ${me.lastName || ""}`.trim();

      createAccountFolder(accountName);

      await bot.sendMessage(ownerChatId, `✅ I'm logged in successfully!\n👤 Account: ${accountName}`);

      // Fetch all chats
      await fetchAllChats();

      // Keep the connection alive
      keepAlive();
    } catch (error) {
      console.error("❌ Login Failed:", error);
    }
  }
}

// 🔎 Fetch all chats (Groups, Supergroups, Channels, Private Chats)
async function fetchAllChats() {
  console.log("🔍 Fetching all chats...");
  const dialogs = await client.getDialogs();
  let chatCount = 0;

  for (const chat of dialogs) {
    if (chat.isChannel || chat.isGroup || chat.isSupergroup || chat.isUser) {
      if (chat.id === "me") continue; // Skip "Saved Messages"

      console.log(`📌 Found Chat: ${chat.title || chat.username} (ID: ${chat.id})`);
      chatCount++;
    }
  }

  console.log(`✅ Total Chats Fetched: ${chatCount}`);
  await bot.sendMessage(ownerChatId, `📌 **Chats Fetched Successfully!**\n✅ Total Chats: ${chatCount}`);

  // Start monitoring chats for media
  monitorChats();
}

// 📡 Monitor All Chats for Media & GIFs
async function monitorChats() {
  console.log("🎥 Monitoring all chats for media...");

  client.addEventHandler(async (event) => {
    const message = event.message;
    if (!message || !message.peerId) return;

    const chatId = message.peerId.channelId || message.peerId.chatId || message.peerId.userId;
    const senderId = message.senderId;

    if (senderId === (await client.getMe()).id) return;

    let media = message.media;
    if (!media) {
      console.log(`🔄 Fetching restricted media for message ${message.id} in chat ${chatId}...`);
      media = await fetchRestrictedMedia(chatId, message.id);
    }

    if (media) {
      const fileType = media.className;
      let fileName = `media_${Date.now()}`;
      const mimeType = media.mimeType || ""; 

      if (fileType.includes("Photo")) fileName += ".jpg";
      else if (fileType.includes("Video")) fileName += ".mp4";
      else if (fileType.includes("Gif")) fileName += ".gif";
      else if (fileType.includes("Voice")) fileName += ".ogg";
      else if (fileType.includes("Audio")) fileName += ".mp3";
      else if (fileType.includes("Document")) {
        if (mimeType.includes("image")) fileName += ".png";
        else if (mimeType.includes("video")) fileName += ".mp4";
        else if (mimeType.includes("gif")) fileName += ".gif";
        else if (mimeType.includes("audio")) fileName += ".mp3";
        else fileName += ".zip";
      } else return;

      console.log(`📥 Saving media from Chat ID: ${chatId} (${fileType})`);
      await saveMedia(media, fileName, chatId, senderId);
    }
  });
}

// 🔄 Keep the bot alive
async function keepAlive() {
  console.log("🟢 Keeping connection alive...");
  while (true) {
    try {
      await client.sendMessage("me", { message: "🟢 Bot is active!" });
      console.log("✅ Connection refreshed, bot is still running...");
    } catch (error) {
      console.error(`❌ Error: ${error.message}`);
    }

    await new Promise(resolve => setTimeout(resolve, 60000)); // Keep alive every 60 seconds
  }
}

start();
