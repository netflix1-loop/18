require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const chokidar = require("chokidar");
const fs = require("fs-extra");
const path = require("path");

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const downloadDir = path.join(__dirname, "user", "downloads");
const chatIds = process.env.CHAT_IDS.split(",").map(id => id.trim());
const ownerChatId = process.env.OWNER_CHAT_ID;
const ONE_HOUR = 3600 * 1000; // 1 hour in milliseconds

// Helper: notify owner in case of errors
const notifyOwner = (message) => {
  if (ownerChatId) {
    bot.sendMessage(ownerChatId, message, { parse_mode: "MarkdownV2" })
      .catch(err => console.error(`❌ Failed to notify owner. Reason: ${err.message}`));
  }
};

// Helper: Escape MarkdownV2 characters for Telegram
const escapeMarkdownV2 = (text) => {
  return text.replace(/[_*[\]()~`>#\+\-=|{}.!]/g, "\\$&");
};

// Helper: Format file sizes into human-readable format
const formatBytes = (bytes, decimals = 2) => {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
};

// Helper: Format time difference in a human-readable "time ago" format
const formatTimeAgo = (milliseconds) => {
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min${minutes > 1 ? "s" : ""} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr${hours > 1 ? "s" : ""} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days > 1 ? "s" : ""} ago`;
};

// Helper: Wait until file is completely downloaded (max wait: 30 sec)
// Checks every 2 seconds. If the file size remains unchanged for 6 seconds (3 checks), it is assumed stable.
const waitForFileDownload = async (filePath) => {
  let lastSize = 0;
  let unchangedCount = 0;
  for (let i = 0; i < 15; i++) { // 15 * 2 sec = 30 sec max
    await new Promise(res => setTimeout(res, 2000));
    try {
      const stats = fs.statSync(filePath);
      if (stats.size > 0 && stats.size === lastSize) {
        unchangedCount++;
      } else {
        unchangedCount = 0;
      }
      lastSize = stats.size;
      if (unchangedCount >= 3) {
        return stats.size;
      }
    } catch (err) {
      return 0;
    }
  }
  return lastSize;
};

// Helper: Format caption for media (e.g., "7216548399_media_4750.mp4" becomes: `7216548399` `.mp4`)
const formatCaption = (fileName) => {
  const match = fileName.match(/([-]?\d+)_media_\d+\.(\w+)/);
  if (!match) {
    const ext = path.extname(fileName).slice(1);
    return `\`unknown\` \`.${escapeMarkdownV2(ext)}\``;
  }
  return `\`${escapeMarkdownV2(match[1])}\` \`.${escapeMarkdownV2(match[2])}\``;
};

// Function: Send media with error handling
const sendMedia = async (filePath) => {
  const fileName = path.basename(filePath);
  console.log(`📂 New media detected: ${fileName}`);

  // Wait until file is fully downloaded
  const fileSize = await waitForFileDownload(filePath);
  if (fileSize === 0) {
    const errMsg = `❌ ${fileName} is empty or failed to download. Deleting.`;
    console.log(errMsg);
    notifyOwner(escapeMarkdownV2(errMsg));
    return fs.remove(filePath);
  }

  const caption = formatCaption(fileName);
  const fileExt = path.extname(filePath).toLowerCase();
  let sendFunction;
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(fileExt)) {
    sendFunction = bot.sendPhoto;
  } else if ([".mp4", ".mov", ".avi", ".mkv"].includes(fileExt)) {
    sendFunction = bot.sendVideo;
  } else if ([".mp3", ".wav", ".ogg"].includes(fileExt)) {
    sendFunction = bot.sendAudio;
  } else {
    const errMsg = `❌ Unsupported file type: ${fileName}, deleting.`;
    console.log(errMsg);
    notifyOwner(escapeMarkdownV2(errMsg));
    return fs.remove(filePath);
  }

  try {
    console.log(`🚀 Sending ${fileName} (${formatBytes(fileSize)}) to all chats...`);
    await Promise.all(chatIds.map(async (chatId) => {
      try {
        await sendFunction.call(bot, chatId, filePath, {
          caption,
          parse_mode: "MarkdownV2",
        });
        console.log(`✅ Sent ${fileName} to ${chatId}`);
      } catch (err) {
        const errorMsg = `❌ Failed to send ${fileName} to ${chatId}. Reason: ${err.message}`;
        console.error(errorMsg);
        notifyOwner(escapeMarkdownV2(errorMsg));
      }
    }));
  } catch (error) {
    const errorMsg = `❌ Error while sending ${fileName}: ${error.message}`;
    console.error(errorMsg);
    notifyOwner(escapeMarkdownV2(errorMsg));
  }

  fs.remove(filePath)
    .then(() => console.log(`🗑️ Deleted ${fileName}`))
    .catch(err => {
      const errorMsg = `❌ Failed to delete ${fileName}. Reason: ${err.message}`;
      console.error(errorMsg);
      notifyOwner(escapeMarkdownV2(errorMsg));
    });
};

// Function: Clean the downloads folder on startup
const cleanDownloadsFolder = () => {
  console.log("🧹 Cleaning downloads folder...");
  fs.emptyDirSync(downloadDir);
  console.log("✅ Folder cleaned. Watching for new media...");
};

// Watcher: Monitor the directory for new files
const watcher = chokidar.watch(downloadDir, { persistent: true, ignoreInitial: true });
watcher.on("add", (filePath) => {
  sendMedia(filePath);
});

// Owner-only /list command: Lists files in the downloads folder with details
bot.onText(/^\/list$/, (msg) => {
  const chatId = msg.chat.id;
  if (chatId.toString() !== ownerChatId.toString()) {
    bot.sendMessage(chatId, "You are not authorized to use this command.");
    return;
  }
  fs.readdir(downloadDir, (err, files) => {
    if (err) {
      bot.sendMessage(chatId, `Error reading folder: ${err.message}`);
      return;
    }
    let total = files.length;
    let message = `Total: ${total}\n\n`;
    if (total === 0) {
      message += "No files left in the folder.";
      bot.sendMessage(chatId, message);
      return;
    }
    let fileDetailsPromises = files.map(file => {
      const filePath = path.join(downloadDir, file);
      return fs.stat(filePath).then(stats => {
        const now = Date.now();
        const diff = now - stats.birthtime.getTime();
        const timeAgo = formatTimeAgo(diff);
        const size = formatBytes(stats.size);
        return `Name: {${file}}\nTime: ${timeAgo}\nSize: ${size}\n`;
      });
    });
    Promise.all(fileDetailsPromises).then(details => {
      message += details.join("\n");
      bot.sendMessage(chatId, message);
    }).catch(err => {
      bot.sendMessage(chatId, `Error retrieving file details: ${err.message}`);
    });
  });
});

// Owner-only /deleteall command: Deletes all files in the downloads folder
bot.onText(/^\/deleteall$/, (msg) => {
  const chatId = msg.chat.id;
  if (chatId.toString() !== ownerChatId.toString()) {
    bot.sendMessage(chatId, "You are not authorized to use this command.");
    return;
  }
  fs.readdir(downloadDir, (err, files) => {
    if (err) {
      bot.sendMessage(chatId, `Error reading folder: ${err.message}`);
      return;
    }
    Promise.all(files.map(file => fs.remove(path.join(downloadDir, file))))
      .then(() => {
        bot.sendMessage(chatId, "Successfully deleted all files in the folder.");
      })
      .catch(err => {
        bot.sendMessage(chatId, `Error deleting files: ${err.message}`);
      });
  });
});

// Handle /start command for all users
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const chatType = msg.chat.type === "private" ? "User" : "Group";
  bot.sendMessage(chatId, `${chatType} Chat ID: \`${chatId}\``, { parse_mode: "MarkdownV2" });
});

// Start the bot
cleanDownloadsFolder();
console.log("🤖 Bot is running...");

// Optionally, run a periodic deletion of files older than 1 hour (every 5 minutes)
setInterval(() => {
  fs.readdir(downloadDir, (err, files) => {
    if (err) {
      console.error(`Error reading folder for old files: ${err.message}`);
      return;
    }
    const now = Date.now();
    files.forEach(file => {
      const filePath = path.join(downloadDir, file);
      fs.stat(filePath, (err, stats) => {
        if (err) {
          console.error(`Error getting stats for ${file}: ${err.message}`);
          return;
        }
        const age = now - stats.birthtime.getTime();
        if (age > ONE_HOUR) {
          fs.remove(filePath)
            .then(() => console.log(`Deleted old file: ${file}`))
            .catch(err => console.error(`Failed to delete old file ${file}: ${err.message}`));
        }
      });
    });
  });
}, 5 * 60 * 1000);
