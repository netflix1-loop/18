require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const input = require('input');
const fs = require('fs');
const path = require('path');

// Load environment variables
const API_ID = Number(process.env.TELEGRAM_API_ID);
const API_HASH = process.env.TELEGRAM_API_HASH;
const SESSION_FILE = './session.json';
const MEDIA_FOLDER = './downloads';

// Load blocked chat IDs from .env (comma-separated)
const BLOCKED_CHAT_IDS = process.env.BLOCKED_CHAT_IDS
  ? process.env.BLOCKED_CHAT_IDS.split(',').map(id => id.trim())
  : [];

// Ensure MEDIA_FOLDER exists
if (!fs.existsSync(MEDIA_FOLDER)) {
  fs.mkdirSync(MEDIA_FOLDER, { recursive: true });
}

// Load session if exists
let stringSession = new StringSession('');
if (fs.existsSync(SESSION_FILE)) {
  stringSession = new StringSession(fs.readFileSync(SESSION_FILE, 'utf-8'));
}

(async () => {
  console.log("✅ Logging into Telegram...");

  const client = new TelegramClient(stringSession, API_ID, API_HASH, { connectionRetries: 5 });

  try {
    await client.start({
      phoneNumber: async () => await input.text('📲 Enter your phone number: '),
      password: async () => await input.password('🔑 Enter your 2FA password (if enabled): '),
      phoneCode: async () => await input.text('📩 Enter the OTP sent via Telegram: '),
      onError: (err) => console.error("❌ Login error:", err),
    });

    console.clear();
    console.log("✅ Logged in successfully!");
    fs.writeFileSync(SESSION_FILE, client.session.save(), 'utf-8');

    console.log("🎧 Listening for new messages...");

    // Event listener for new messages
    client.addEventHandler(async (event) => {
      const message = event.message;
      if (!message || !message.media) return;

      // Determine sender ID
      const senderId = message.senderId ? message.senderId.toString() : "unknown";

      // Check if sender is blocked
      if (BLOCKED_CHAT_IDS.includes(senderId)) {
        console.log(`🚫 Ignoring media from blocked user: ${senderId}`);
        return;
      }

      console.log(`Media detected from user ${senderId}.`);

      const fileName = `${senderId}_media_${message.id}`;
      const filePath = path.join(MEDIA_FOLDER, fileName);

      try {
        // Download media with a progress callback that receives downloaded and total bytes
        const mediaBuffer = await client.downloadMedia(message.media, {
          progressCallback: (downloaded, total) => {
            const percent = total ? ((downloaded / total) * 100).toFixed(2) : downloaded;
            process.stdout.write(`\rMedia downloading from user ${senderId}: ${percent}%`);
          }
        });
        console.log(); // New line after progress

        if (mediaBuffer && Buffer.isBuffer(mediaBuffer)) {
          let fileExtension = ".mp4"; // Default format if unknown

          // Determine the correct file extension based on media type
          if (message.media.className === "MessageMediaPhoto") {
            fileExtension = ".jpg"; // Photo
          } else if (message.media.className === "MessageMediaDocument") {
            if (message.media.document && message.media.document.mimeType) {
              const mimeType = message.media.document.mimeType;
              if (mimeType.includes("video")) {
                fileExtension = ".mp4"; // Video
              } else if (mimeType.includes("image")) {
                fileExtension = ".jpg"; // Image
              } else if (mimeType.includes("audio")) {
                fileExtension = ".mp3"; // Audio
              } else if (mimeType.includes("gif")) {
                fileExtension = ".gif"; // GIF
              } else if (mimeType.includes("webp")) {
                fileExtension = ".webp"; // Static Sticker or image
              } else if (mimeType.includes("webm")) {
                fileExtension = ".webm"; // Animated Sticker or video
              } else {
                fileExtension = ".mp4"; // Unknown file
              }
            }
          } else if (message.media.className === "MessageMediaSticker") {
            // Stickers: use .webm for animated, .webp for static (defaulting to animated)
            if (message.media.document && message.media.document.mimeType) {
              fileExtension = message.media.document.mimeType.includes("webm") ? ".webm" : ".webp";
            } else {
              fileExtension = ".webm";
            }
          }

          const finalPath = `${filePath}${fileExtension}`;
          fs.writeFileSync(finalPath, mediaBuffer);
          console.log(`Media downloaded successfully and saved successfully: ${finalPath}`);
        } else {
          console.log(`Media download failed for user ${senderId}: No buffer received.`);
        }
      } catch (error) {
        console.error(`Failed to download or save media from user ${senderId}. Reason: ${error.message}`);
      }
    });

  } catch (error) {
    console.error("❌ Error during login:", error);
  }
})();
